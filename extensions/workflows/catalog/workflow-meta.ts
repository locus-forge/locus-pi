/**
 * catalog/workflow-meta.ts — the bounded static metadata scanner.
 *
 * It owns everything that reads a workflow's declared `meta` without importing
 * or executing the module: the bounded prefix read, the tolerant literal parse,
 * and the description/profile/phases interpretation behind catalog rows,
 * generated public catalogs and repository source checks. Its only workflows
 * import is the shared lexical layer in `source/workflow-source-literals.ts`,
 * so a script that only needs a description does not pull in the catalog's
 * presentation, the run journal or the runtime.
 *
 * It is deliberately NOT the strict authoring grammar. What a standard
 * published workflow source may contain is decided by
 * `tool/workflow-source-shape.ts`; this module stays tolerant and answers with
 * "unclassified" and empty phases instead of failing.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { Lang, parse } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import { exportedMetaObject, staticObjectKey, staticStringValue } from "../source/workflow-source-literals.js";

const WORKFLOW_METADATA_SCAN_BYTES = 64 * 1024;
const DESCRIPTION_MAX_CHARS = 96;

/** One statically declared stage from a workflow's exported `meta.phases`. */
export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
}

/** Everything the bounded static scan accepts from one literal exported `meta`. */
export interface WorkflowStaticMeta {
  description: string;
  profile: WorkflowAuthoringProfile;
  /** Empty when nothing was declared, or when a declaration was not fully literal. */
  phases: WorkflowMetaPhase[];
}

export type WorkflowAuthoringProfile = "standard" | "legacy" | "integration" | "unclassified";

/**
 * Read only a bounded prefix and accept metadata from the top-level literal
 * `export const meta = { description: <static string>, phases?: [...] }`. One
 * read and one parse serve every field, because the catalog rebuilds this per
 * row on each list/info call. No module is imported or executed: this function
 * only ever holds the file's bytes as a string.
 */
export function readWorkflowMeta(file: string): WorkflowStaticMeta {
  let source: string;
  try {
    source = readBoundedSource(file);
  } catch {
    return { description: "description unavailable", profile: "unclassified", phases: [] };
  }
  const meta = staticWorkflowMeta(source);
  return {
    description: meta.description ?? "no description",
    profile: meta.profile,
    phases: meta.phases,
  };
}

/** Description-only projection of {@link readWorkflowMeta}. */
export function readWorkflowMetaDescription(file: string): string {
  return readWorkflowMeta(file).description;
}

/**
 * Parse one bounded source prefix and project every accepted literal `meta`
 * field. Both fields come from the same parse; a source with no literal `meta`
 * yields an undefined description and no phases.
 */
export function staticWorkflowMeta(source: string): {
  description: string | undefined;
  profile: WorkflowAuthoringProfile;
  phases: WorkflowMetaPhase[];
} {
  let description: string | undefined;
  let profile: WorkflowAuthoringProfile = "unclassified";
  let phases: WorkflowMetaPhase[] = [];
  try {
    const root = parse(Lang.JavaScript, source).root();
    for (const statement of root.findAll("export const meta = $META")) {
      const value = exportedMetaObject(statement);
      if (value === undefined) continue;
      const pairs = value.children().filter((child) => child.kind() === "pair");
      if (description === undefined) {
        const literal = staticStringValue(
          pairs.find((pair) => staticObjectKey(pair.field("key")) === "description")?.field("value"),
        );
        if (literal !== undefined && literal.trim() !== "") {
          description = compactCatalogText(literal.replace(/\s+/gu, " ").trim());
        }
      }
      const declaredProfile = staticStringValue(
        pairs.find((pair) => staticObjectKey(pair.field("key")) === "profile")?.field("value"),
      );
      if (declaredProfile === "standard" || declaredProfile === "legacy" || declaredProfile === "integration") {
        profile = declaredProfile;
      }
      if (phases.length === 0) {
        phases = staticMetaPhases(
          pairs.find((pair) => staticObjectKey(pair.field("key")) === "phases")?.field("value"),
        );
      }
    }
  } catch {
    return { description: undefined, profile: "unclassified", phases: [] };
  }
  return { description, profile, phases };
}

/** Declared phases from one bounded source prefix; empty when nothing literal was declared. */
export function staticWorkflowMetaPhases(source: string): WorkflowMetaPhase[] {
  return staticWorkflowMeta(source).phases;
}

/** One declared-or-observed phase group for a finished or in-flight run. */
export interface WorkflowPhaseGroup {
  title: string;
  detail?: string;
  /** The workflow's `meta.phases` named this stage before the run started. */
  declared: boolean;
  /** The run actually emitted a `phase()` line with this exact title. */
  reached: boolean;
}

/**
 * Match a static declaration against the titles a run actually emitted.
 * Declared order is kept; an observed title with no declaration is appended in
 * first-seen order as its own undeclared group. Nothing fails on a mismatch —
 * a `phase()` inside a branch may legitimately never run, and a drifted
 * declaration is evidence a reader should see, not a rule to enforce.
 */
export function matchWorkflowPhaseGroups(
  declared: readonly WorkflowMetaPhase[],
  observedTitles: readonly string[],
): WorkflowPhaseGroup[] {
  const observed = new Set(observedTitles);
  const declaredTitles = new Set(declared.map((phase) => phase.title));
  const groups: WorkflowPhaseGroup[] = declared.map((phase) => ({
    title: phase.title,
    ...(phase.detail !== undefined ? { detail: phase.detail } : {}),
    declared: true,
    reached: observed.has(phase.title),
  }));
  const appended = new Set<string>();
  for (const title of observedTitles) {
    if (declaredTitles.has(title) || appended.has(title)) continue;
    appended.add(title);
    groups.push({ title, declared: false, reached: true });
  }
  return groups;
}

/**
 * Accept `phases: [{ title: <static string>, detail?: <static string> }, ...]`
 * and nothing else. One non-literal entry discards the whole array: a partially
 * read pipeline would describe a shape the workflow does not have, with no
 * marker telling the reader so.
 */
function staticMetaPhases(node: SgNode | null | undefined): WorkflowMetaPhase[] {
  if (node == null || node.kind() !== "array") return [];
  const declared: WorkflowMetaPhase[] = [];
  for (const element of node.children()) {
    if (isStructuralLiteralNode(element)) continue;
    if (element.kind() !== "object") return [];
    // A spread, shorthand, or method member means the element is not fully
    // literal, so the declaration cannot be trusted as a whole.
    if (element.children().some((child) => !isStructuralLiteralNode(child) && child.kind() !== "pair")) return [];
    const pairs = element.children().filter((child) => child.kind() === "pair");
    const title = staticStringValue(
      pairs.find((pair) => staticObjectKey(pair.field("key")) === "title")?.field("value"),
    );
    if (title === undefined || title.trim() === "") return [];
    const detailPair = pairs.find((pair) => staticObjectKey(pair.field("key")) === "detail");
    if (detailPair !== undefined) {
      const detail = staticStringValue(detailPair.field("value"));
      if (detail === undefined) return [];
      const compacted = detail.replace(/\s+/gu, " ").trim();
      declared.push(
        compacted === "" ? { title: title.trim() } : { title: title.trim(), detail: compactCatalogText(compacted) },
      );
      continue;
    }
    declared.push({ title: title.trim() });
  }
  return declared;
}

/** Punctuation and comments carry no declaration; everything else must be literal. */
function isStructuralLiteralNode(node: SgNode): boolean {
  const kind = node.kind();
  return kind === "{" || kind === "}" || kind === "[" || kind === "]" || kind === "," || kind === "comment";
}

function readBoundedSource(file: string): string {
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(WORKFLOW_METADATA_SCAN_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function compactCatalogText(value: string): string {
  if (value.length <= DESCRIPTION_MAX_CHARS) return value;
  const candidate = value.slice(0, DESCRIPTION_MAX_CHARS - 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${(boundary > DESCRIPTION_MAX_CHARS / 2 ? candidate.slice(0, boundary) : candidate).trimEnd()}…`;
}
