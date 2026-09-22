import { readFileSync } from "node:fs";
import path from "node:path";
import {
  listWorkflowRuns,
  readWorkflowRunScriptSnapshot,
  type WorkflowRunResultEnvelope,
  type WorkflowRunScriptSnapshot,
} from "../runtime/workflow-journal.js";
import {
  listWorkflowDefinitions,
  safeWorkflowSourceLocator,
  workflowTargetComposition,
  listWorkflowCatalogTargets,
  type ResolvedWorkflowTarget,
} from "../runtime/workflow-discovery.js";
import { isWorkflowSavedName } from "../runtime/workflow-saved-name.js";
import { WORKFLOW_SAVED_SOURCE_RELATIVE_ROOT } from "../runtime/workflow-run-layout.js";
import type { OperatorBlock } from "../../_shared/operator/operator-ui.js";
import { buildWorkflowRunCommand, formatWorkflowCommandToken, workflowRunUsage } from "../command/command-parser.js";
import {
  readWorkflowMeta,
  staticWorkflowMeta,
  type WorkflowAuthoringProfile,
  type WorkflowMetaPhase,
} from "./workflow-meta.js";

const RECENT_WORKFLOW_LIMIT = 5;
const HISTORICAL_WORKFLOW_DESCRIPTION = "historical run snapshot";
export const WORKFLOW_SOURCE_LEGEND = "Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history";
export const WORKFLOW_DISPLAY_ORDER_LEGEND =
  "Display order: Project → User → Package (does not change first-wins resolution)";

export interface WorkflowCatalogRow {
  name: string;
  label: string;
  rootName: string;
  role: "root" | "child";
  /** Qualified refs owned by this root. Present only on root rows. */
  children: readonly string[];
  source: ResolvedWorkflowTarget["source"];
  sourceLabel: "Project" | "User" | "Package";
  originPath: string;
  sourceLocator: string;
  description: string;
  profile: WorkflowAuthoringProfile;
  phases: WorkflowMetaPhase[];
}

export interface WorkflowCatalogCurrentRow extends WorkflowCatalogRow {
  kind: "current";
  target: ResolvedWorkflowTarget;
}

/** A non-runnable namespace header with direct runnable children. */
export interface WorkflowCatalogGroup {
  name: string;
  rootName: string;
  children: readonly string[];
  source: ResolvedWorkflowTarget["source"];
  sourceLabel: "Project" | "User" | "Package";
  sourceLocator: string;
  description: string;
}

export interface WorkflowCatalogHistoryRow extends WorkflowCatalogRow {
  kind: "history";
  runId: string;
  target: NonNullable<WorkflowRunResultEnvelope["target"]>;
  snapshot: WorkflowRunScriptSnapshot;
}

export interface WorkflowCatalogModel {
  query: string | undefined;
  totalCurrent: number;
  totalRoots: number;
  totalChildren: number;
  current: WorkflowCatalogCurrentRow[];
  groups: WorkflowCatalogGroup[];
  history: WorkflowCatalogHistoryRow[];
}

export type WorkflowSourceReadState =
  | { kind: "ready"; row: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow; path: string; source: string }
  | {
      kind: "missing" | "shadowed" | "unreadable" | "legacy" | "invalid" | "tampered" | "stale";
      row: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow;
      message: string;
    };

export type WorkflowEditorAction = "start" | "edit" | "review";
export type WorkflowCopyAction = "copy-project" | "copy-personal";
export type WorkflowBrowserAction = WorkflowEditorAction | WorkflowCopyAction;

export type WorkflowBrowserIntent =
  | {
      action: WorkflowBrowserAction;
      row: WorkflowCatalogCurrentRow;
      sourceState: WorkflowSourceReadState;
    }
  | {
      action: "review";
      row: WorkflowCatalogHistoryRow;
      sourceState: WorkflowSourceReadState;
    };

interface WorkflowCatalogOptions {
  compact?: boolean;
}

/** Build an operator catalog over the shared project/user discovery, curated Package registry, and run index. */
export function buildWorkflowCatalogBlock(
  projectRoot: string,
  workingDirectory: string,
  query?: string,
  options: WorkflowCatalogOptions = {},
): OperatorBlock {
  return buildWorkflowCatalogBlockFromModel(buildWorkflowCatalogModel(projectRoot, workingDirectory, query), options);
}

/** Build one current/history model for both passive and focused projections. */
export function buildWorkflowCatalogModel(
  projectRoot: string,
  workingDirectory: string,
  query?: string,
): WorkflowCatalogModel {
  const definitions = listWorkflowDefinitions(projectRoot, workingDirectory);
  const groups: WorkflowCatalogGroup[] = definitions
    .filter((definition) => definition.root === undefined)
    .map((definition) => {
      const source = definition.children[0]!.source;
      return {
        name: definition.rootRef,
        rootName: definition.rootRef,
        children: definition.children.map((child) => child.ref),
        source,
        sourceLabel: workflowSourceLabel(source),
        sourceLocator: `${source}:${definition.rootRef}`,
        description: "Group-only namespace; choose a child workflow.",
      };
    });
  const catalogRows: WorkflowCatalogCurrentRow[] = definitions.flatMap((definition) => {
    const rootChildren = definition.children.map((child) => child.ref);
    const targets = definition.root === undefined ? definition.children : [definition.root, ...definition.children];
    return targets.map((target) => {
      const meta = readWorkflowMeta(target.path);
      const isRoot = definition.root !== undefined && target === definition.root;
      const label = isRoot ? definition.rootRef : target.ref.slice(definition.rootRef.length + 1);
      return {
        kind: "current",
        target,
        name: target.ref,
        label,
        rootName: definition.rootRef,
        role: isRoot ? "root" : "child",
        children: isRoot ? rootChildren : [],
        source: target.source,
        sourceLabel: workflowSourceLabel(target.source),
        originPath: target.path,
        sourceLocator: safeWorkflowSourceLocator(target, projectRoot),
        description: meta.description,
        profile: meta.profile,
        phases: meta.phases,
      };
    });
  });
  const recentRows = recentWorkflowRows(projectRoot);
  const filteredCurrent = filterCurrentWorkflowRows(catalogRows, groups, query);
  const matches = (row: WorkflowCatalogRow): boolean => workflowCatalogRowMatches(row, query);
  return {
    query,
    totalCurrent: catalogRows.length,
    totalRoots: catalogRows.filter((row) => row.role === "root").length + groups.length,
    totalChildren: catalogRows.filter((row) => row.role === "child").length,
    current: filteredCurrent,
    groups: filterWorkflowGroups(groups, query),
    history: recentRows.filter(matches),
  };
}

/** Render a catalog model without reading resolver sources again. */
export function buildWorkflowCatalogBlockFromModel(
  model: WorkflowCatalogModel,
  options: WorkflowCatalogOptions = {},
): OperatorBlock {
  const {
    query,
    totalRoots,
    totalChildren,
    current: filteredCatalog,
    groups: filteredGroups,
    history: filteredRecent,
  } = model;
  const totalSummary = `${totalRoots} top-level workflow(s) · ${totalChildren} child workflow(s)`;

  if (
    query !== undefined &&
    filteredCatalog.length === 0 &&
    filteredGroups.length === 0 &&
    filteredRecent.length === 0
  ) {
    return {
      type: "VIEW",
      subject: "Workflow catalog",
      primary: `No workflows match ${JSON.stringify(query)}.`,
      body: [`Catalog contains ${totalSummary}; search checks name and description.`],
      metadata: [WORKFLOW_SOURCE_LEGEND],
      controls: ["Try: /workflows list <query>"],
    };
  }

  if (options.compact === true) {
    const compactBody = compactWorkflowCatalogBody(filteredRecent, filteredCatalog, query);
    const groupLines = filteredGroups.map(
      (group) => `${group.name} · ${workflowSourceBadge(group.source)} · group-only (not runnable)`,
    );
    const compactTotals = `${totalSummary} · ${filteredRecent.length} history row(s); details may be omitted by host line budget`;
    return {
      type: "VIEW",
      subject: "Workflow catalog",
      primary: query === undefined ? `${totalSummary}.` : `Matches for ${JSON.stringify(query)}.`,
      body: [...groupLines, ...compactBody.lines],
      metadata: [compactTotals, WORKFLOW_DISPLAY_ORDER_LEGEND, WORKFLOW_SOURCE_LEGEND],
      controls: [`Run: ${workflowRunUsage()} · Filter: /workflows list <query>`],
    };
  }

  const body: string[] = [];
  appendWorkflowCatalogGroup(
    body,
    "[R] Run history",
    filteredRecent,
    query === undefined ? "none yet" : "no recent matches",
  );
  appendWorkflowCatalogGroup(
    body,
    "[P] Project",
    rowsForSource(filteredCatalog, "project"),
    query === undefined ? "none found" : "no matches",
    filteredGroups.filter((group) => group.source === "project"),
  );
  appendWorkflowCatalogGroup(
    body,
    "[U] User",
    rowsForSource(filteredCatalog, "personal"),
    query === undefined ? "none found" : "no matches",
    filteredGroups.filter((group) => group.source === "personal"),
  );
  appendWorkflowCatalogGroup(
    body,
    "[PKG] Package",
    rowsForSource(filteredCatalog, "package"),
    query === undefined ? "none installed" : "no matches",
    filteredGroups.filter((group) => group.source === "package"),
  );

  return {
    type: "VIEW",
    subject: "Workflow catalog",
    primary: query === undefined ? `${totalSummary}.` : `Matches for ${JSON.stringify(query)}.`,
    body: [WORKFLOW_DISPLAY_ORDER_LEGEND, ...body],
    metadata: [WORKFLOW_SOURCE_LEGEND],
    controls: [`Run: ${workflowRunUsage()}`, "Filter: /workflows list <query>", "Status: /workflows status"],
  };
}

/** Revalidate the exact selected first-wins target, then read it as inert UTF-8 text. */
export function readSelectedWorkflowSource(
  selected: WorkflowCatalogCurrentRow,
  projectRoot: string,
  workingDirectory: string,
): WorkflowSourceReadState {
  const current = listWorkflowCatalogTargets(projectRoot, workingDirectory).find(
    (target) => target.ref === selected.target.ref,
  );
  if (current === undefined) {
    return {
      kind: "missing",
      row: selected,
      message: `Selected workflow ${JSON.stringify(selected.name)} is no longer in the current catalog. Return and refresh /workflows list.`,
    };
  }
  if (!sameResolvedTarget(current, selected.target)) {
    return {
      kind: "shadowed",
      row: selected,
      message: `Selected workflow changed precedence from ${selected.sourceLocator} to ${safeWorkflowSourceLocator(current, projectRoot)}. Nothing was opened; return and refresh /workflows list.`,
    };
  }
  try {
    return { kind: "ready", row: selected, path: current.path, source: readFileSync(current.path, "utf8") };
  } catch (error) {
    return {
      kind: "unreadable",
      row: selected,
      message: `Selected workflow could not be read: ${errorMessage(error)}. Fix access or return to the catalog.`,
    };
  }
}

/**
 * Deterministic editor handoff. Start uses the direct slash-command runtime
 * path; edit/review point at the packaged workflow-authoring skill because
 * they require source work. The pointer must stay something an installed
 * package actually provides.
 * The returned text is editable but never submitted here.
 */
export function buildWorkflowActionPrompt(intent: WorkflowBrowserIntent): string {
  if (intent.action === "copy-project" || intent.action === "copy-personal") {
    throw new Error(`Workflow copy action ${JSON.stringify(intent.action)} does not produce an editor prompt.`);
  }
  if (intent.row.kind === "history" && intent.action !== "review") {
    throw new Error(`Historical workflow actions are review-only; received ${JSON.stringify(intent.action)}.`);
  }
  const row = intent.row;
  if (row.kind === "current" && intent.action === "start") {
    if (intent.sourceState.kind !== "ready") {
      throw new Error(
        `Current workflow start requires a ready source; received ${JSON.stringify(intent.sourceState.kind)}.`,
      );
    }
    return buildWorkflowRunCommand(row.target);
  }
  let request: string;
  if (row.kind === "current") {
    const action = intent.action[0]!.toUpperCase() + intent.action.slice(1);
    request = `${action} the exact current workflow at ${JSON.stringify(row.target.path)}.`;
  } else {
    const identity = [
      `run ${JSON.stringify(row.runId)}`,
      `target ${JSON.stringify(`${row.target.kind}:${row.target.ref}`)}`,
    ];
    if (intent.sourceState.kind === "ready") {
      identity.push(`at ${JSON.stringify(row.originPath)}`);
      if (row.snapshot.sha256 !== undefined) identity.push(`SHA-256 ${JSON.stringify(row.snapshot.sha256)}`);
      request = `Review the immutable workflow snapshot for ${identity.join(", ")}.`;
    } else {
      identity.push(`with snapshot state ${JSON.stringify(intent.sourceState.kind)}`);
      if (row.snapshot.path !== undefined) identity.push(`path ${JSON.stringify(row.snapshot.path)}`);
      if (row.snapshot.sha256 !== undefined) identity.push(`SHA-256 ${JSON.stringify(row.snapshot.sha256)}`);
      request = `Review the recorded workflow identity for ${identity.join(", ")}; diagnose why the immutable snapshot is unavailable.`;
    }
  }
  return [`Request: ${request}`, "Skill: locus-pi-workflow-create", "", "Additional instructions:", ""].join("\n");
}

/** Passive source-backed explanation. It reads static metadata but never imports workflow code. */
export function buildWorkflowInfoBlock(projectRoot: string, workingDirectory: string, name?: string): OperatorBlock {
  const requested = name;
  if (requested !== undefined && !isWorkflowSavedName(requested)) {
    return {
      type: "WARN",
      subject: "Workflow info",
      primary: `Invalid saved workflow name: ${JSON.stringify(requested)}.`,
      body: [
        "Saved workflow names are exact; whitespace and other invalid characters are never trimmed or reinterpreted.",
      ],
      controls: ["Use /workflows list to inspect current names."],
    };
  }
  const model = buildWorkflowCatalogModel(projectRoot, workingDirectory);
  if (requested !== undefined) {
    const row = model.current.find((candidate) => candidate.name === requested);
    if (row === undefined) {
      const group = model.groups.find((candidate) => candidate.name === requested);
      if (group !== undefined) {
        return {
          type: "WARN",
          subject: "Workflow info",
          primary: `Workflow namespace ${JSON.stringify(group.name)} is group-only; it has no runnable root.`,
          body: [`children: ${group.children.join(", ")}`, "Choose a child workflow by its qualified name."],
          metadata: ["No workflow JavaScript was imported or evaluated."],
          controls: ["Run or inspect a child: /workflows <run|info> <group>/<child>"],
        };
      }
      return {
        type: "WARN",
        subject: "Workflow info",
        primary: `Unknown current workflow: ${JSON.stringify(requested)}.`,
        body: ["Names resolve by exact first-wins catalog identity; history and partial matches are not substituted."],
        controls: ["Use /workflows list to inspect current names and run-specific history."],
      };
    }
    return {
      type: "VIEW",
      subject: `Workflow info: ${row.name}`,
      primary: `${row.description}`,
      body: [
        `source: ${row.sourceLabel} (${row.source})`,
        `target: ${row.target.kind}:${row.target.ref}`,
        `authoring profile: ${authoringProfileExplanation(row.profile)}`,
        "metadata: static meta.description/profile/phases; profile classifies source shape, not runtime behavior; module not evaluated",
        ...workflowCompositionDetailLines(row),
        ...declaredPhaseLines(row.phases),
        ...workflowContractLines(),
        `source locator: ${row.sourceLocator}`,
      ],
      metadata: [workflowCompositionCompactLine(row), WORKFLOW_SOURCE_LEGEND],
      controls: [
        "Inspect: /workflows list",
        `Run deliberately: ${workflowRunUsage(formatWorkflowCommandToken(row.name))}`,
      ],
    };
  }
  return {
    type: "VIEW",
    subject: "Workflow info",
    primary: "Passive workflow resolver, DSL, agent, and model contract.",
    body: workflowContractLines(),
    metadata: [WORKFLOW_SOURCE_LEGEND, "No workflow JavaScript was imported or evaluated."],
    controls: [
      "Browse: /workflows list [query]",
      "Inspect one: /workflows info <exact-name>",
      `Run: ${workflowRunUsage()}`,
      "History: /workflows status [runId]",
    ],
  };
}

/**
 * Project a declared pipeline for `/workflows info <name>`. Nothing is emitted
 * when a workflow declares no phases, so the block that an existing workflow
 * produces is unchanged — `phases` is optional and must stay free.
 */
function declaredPhaseLines(phases: readonly WorkflowMetaPhase[]): string[] {
  if (phases.length === 0) return [];
  return [
    `phases: ${phases.length} declared before the run starts (declaration, not enforcement)`,
    ...phases.map(
      (phase, index) => `  ${index + 1}. ${phase.title}${phase.detail === undefined ? "" : ` — ${phase.detail}`}`,
    ),
  ];
}

function workflowContractLines(): string[] {
  return [
    "agent models: explicit model, then role, agent tier, then session model",
    "trust: reviewed workflow JavaScript runs with full Pi host access; info and catalog do not evaluate modules",
    "history: uses only the validated retained snapshot; no current-source fallback and no browser launch",
    "model routing: the child session is created with opts.model, else opts.modelRole, else the agent frontmatter tier, else the session model; an unresolvable provider/id fails the call, an unassigned role normally degrades and is recorded, requireModelRole refuses that fallback, and agent_end reports the read-back executedModel",
    'agents: agent() is the single model-calling primitive and returns exact non-empty child text; opts.agent selects a discovered catalog prompt/model role, omitted agent uses role "default", and every workflow child always receives tools ["*"] with write/edit/bash available; legacy capability fields are ignored; opts.schema opts into a validated shaped answer instead of text',
    "resources: promptFile() loads one source-relative .prompt.md containing stable stage instructions plus dynamic handoffs; local prompt bytes are copied once into the run directory with SHA-256 evidence",
    "workspaces: workspace() allocates one retained linked worktree and returns an opaque handle reusable by multiple agent() calls",
    "DSL: agent(), parallel(), pipeline(), phase(), log(), workflow(), outputDir(), invokeWorkflow(), publishPrimaryFile(), promptFile(), workspace()",
    "durability: outputDir() selects a confined stable project namespace distinct from run evidence; invokeWorkflow() runs one saved child level with source-bound item checkpoints and shared cancellation/concurrency/physical-call budget; publishPrimaryFile() exposes a verified non-empty file reference",
    `resolver: the nearest Project ${WORKFLOW_SAVED_SOURCE_RELATIVE_ROOT} namespace wins at each level; then User ~/${WORKFLOW_SAVED_SOURCE_RELATIVE_ROOT}; then Package`,
    "registration: a canonical folder owns an optional <workflow>.workflow.mjs plus direct child entries; without the root it is a non-runnable group-only namespace; existing flat Project/User entries remain standalone workflows",
  ];
}

/** Read the selected current file or exact run snapshot without importing JavaScript. */
export function readWorkflowCatalogSource(
  selected: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow,
  projectRoot: string,
  workingDirectory: string,
): WorkflowSourceReadState {
  if (selected.kind === "current") return readSelectedWorkflowSource(selected, projectRoot, workingDirectory);
  const snapshot = readWorkflowRunScriptSnapshot(projectRoot, selected.runId);
  if (!sameRunSnapshotIdentity(selected.snapshot, snapshot)) {
    return {
      kind: "stale",
      row: selected,
      message: `Run ${selected.runId} snapshot identity changed after catalog selection. Nothing was opened; return and refresh /workflows list.`,
    };
  }
  if (snapshot.kind === "ready") {
    return { kind: "ready", row: selected, path: snapshot.path, source: snapshot.source };
  }
  return { kind: snapshot.kind, row: selected, message: snapshot.message };
}

function compactWorkflowCatalogBody(
  recentRows: readonly WorkflowCatalogHistoryRow[],
  catalogRows: readonly WorkflowCatalogCurrentRow[],
  query: string | undefined,
): { lines: string[] } {
  const groups: Array<{
    label: string;
    rows: readonly (WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow)[];
    empty: string;
  }> = [
    { label: "[R]", rows: recentRows, empty: query === undefined ? "none yet" : "no recent matches" },
    {
      label: "[P]",
      rows: rowsForSource([...catalogRows], "project"),
      empty: query === undefined ? "none found" : "no matches",
    },
    {
      label: "[U]",
      rows: rowsForSource([...catalogRows], "personal"),
      empty: query === undefined ? "none found" : "no matches",
    },
    {
      label: "[PKG]",
      rows: rowsForSource([...catalogRows], "package"),
      empty: query === undefined ? "none installed" : "no matches",
    },
  ];
  let hidden = 0;
  const populated = groups.filter((group) => group.rows.length > 0);
  const lines = (populated.length > 0 ? populated : groups.slice(0, 1)).map((group) => {
    const row = group.rows[0];
    hidden += Math.max(0, group.rows.length - 1);
    if (row === undefined) return `${group.label} (${group.empty})`;
    return compactWorkflowCatalogLine(passiveCatalogRowLine(row));
  });
  if (hidden > 0)
    lines.push(`+${hidden} hidden workflow row(s); use /workflows list <query> or /workflows info <exact-name>`);
  return { lines };
}

/** Privacy projection for persisted path targets; never returns an absolute path. */
export function safeRecentWorkflowLabel(
  target: { kind: "name" | "scriptPath"; ref: string },
  projectRoot: string,
): string {
  const raw = target.ref.trim();
  if (raw === "") return "unknown";
  if (target.kind === "name" && !raw.includes("/") && !raw.includes("\\")) return raw;
  if (path.isAbsolute(raw)) {
    const relative = path.relative(path.resolve(projectRoot), path.resolve(raw));
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
    return path.basename(raw);
  }
  if (path.win32.isAbsolute(raw)) return path.win32.basename(raw);
  const normalized = path.normalize(raw).replace(/^\.([/\\])/u, "");
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return path.basename(normalized);
  return normalized;
}

function recentWorkflowRows(projectRoot: string): WorkflowCatalogHistoryRow[] {
  const recent: WorkflowCatalogHistoryRow[] = [];
  for (const run of listWorkflowRuns(projectRoot)) {
    if (run.kind === "child") continue;
    const { runId, runDir } = run;
    const snapshot = readWorkflowRunScriptSnapshot(projectRoot, runId, runDir);
    const target = snapshot.target;
    if (target === undefined) continue;
    const safeName = safeRecentWorkflowLabel(target, projectRoot);
    const composition =
      target.kind === "name" && isWorkflowSavedName(target.ref)
        ? workflowTargetComposition({ ref: target.ref })
        : { rootRef: safeName, role: "root" as const, label: safeName };
    const meta = snapshot.kind === "ready" ? staticWorkflowMeta(snapshot.source) : undefined;
    recent.push({
      kind: "history",
      runId,
      target,
      snapshot,
      name: safeName,
      label: composition.label,
      rootName: composition.rootRef,
      role: composition.role,
      children: [],
      source: target.source,
      sourceLabel: workflowSourceLabel(target.source),
      originPath: snapshot.path ?? `(snapshot unavailable for run ${runId})`,
      sourceLocator: safeSnapshotLocator(snapshot.path, projectRoot, runId),
      description: meta?.description ?? HISTORICAL_WORKFLOW_DESCRIPTION,
      profile: meta?.profile ?? "unclassified",
      phases: meta?.phases ?? [],
    });
    if (recent.length >= RECENT_WORKFLOW_LIMIT) break;
  }
  return recent;
}

function safeSnapshotLocator(snapshotPath: string | undefined, projectRoot: string, runId: string): string {
  if (snapshotPath === undefined) return `run:${runId}`;
  const relative = path.relative(path.resolve(projectRoot), path.resolve(snapshotPath)).split(path.sep).join("/");
  return relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)
    ? relative
    : `run:${runId}`;
}

function sameRunSnapshotIdentity(left: WorkflowRunScriptSnapshot, right: WorkflowRunScriptSnapshot): boolean {
  return (
    left.runId === right.runId &&
    samePersistedTarget(left.target, right.target) &&
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.identityCoverage === right.identityCoverage
  );
}

function samePersistedTarget(
  left: WorkflowRunResultEnvelope["target"],
  right: WorkflowRunResultEnvelope["target"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === right.kind && left.ref === right.ref && left.source === right.source;
}

function rowsForSource<Row extends WorkflowCatalogRow>(rows: Row[], source: WorkflowCatalogRow["source"]): Row[] {
  return rows.filter((row) => row.source === source).sort(compareCatalogRows);
}

function workflowCatalogRowMatches(row: WorkflowCatalogRow, query: string | undefined): boolean {
  if (query === undefined) return true;
  const needle = query.toLocaleLowerCase();
  return row.name.toLocaleLowerCase().includes(needle) || row.description.toLocaleLowerCase().includes(needle);
}

function filterCurrentWorkflowRows(
  rows: readonly WorkflowCatalogCurrentRow[],
  groups: readonly WorkflowCatalogGroup[],
  query: string | undefined,
): WorkflowCatalogCurrentRow[] {
  if (query === undefined) return [...rows];
  const filtered: WorkflowCatalogCurrentRow[] = [];
  for (const root of rows.filter((row) => row.role === "root")) {
    const children = rows.filter((row) => row.role === "child" && row.rootName === root.name);
    if (workflowCatalogRowMatches(root, query)) {
      filtered.push(root, ...children);
      continue;
    }
    const matchingChildren = children.filter((row) => workflowCatalogRowMatches(row, query));
    if (matchingChildren.length > 0) filtered.push(root, ...matchingChildren);
  }
  for (const group of groups) {
    const children = rows.filter((row) => row.role === "child" && row.rootName === group.name);
    if (workflowCatalogGroupMatches(group, query, false)) {
      filtered.push(...children);
      continue;
    }
    filtered.push(...children.filter((row) => workflowCatalogRowMatches(row, query)));
  }
  return filtered;
}

function filterWorkflowGroups(
  groups: readonly WorkflowCatalogGroup[],
  query: string | undefined,
): WorkflowCatalogGroup[] {
  if (query === undefined) return [...groups];
  return groups.filter((group) => workflowCatalogGroupMatches(group, query, true));
}

function workflowCatalogGroupMatches(group: WorkflowCatalogGroup, query: string, includeChildren: boolean): boolean {
  const needle = query.toLocaleLowerCase();
  return (
    group.name.toLocaleLowerCase().includes(needle) ||
    group.description.toLocaleLowerCase().includes(needle) ||
    (includeChildren && group.children.some((child) => child.toLocaleLowerCase().includes(needle)))
  );
}

function appendWorkflowCatalogGroup(
  out: string[],
  title: string,
  rows: readonly (WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow)[],
  empty: string,
  groups: readonly WorkflowCatalogGroup[] = [],
): void {
  out.push("", `${title}:`);
  if (rows.length === 0 && groups.length === 0) {
    out.push(`  (${empty})`);
    return;
  }
  const groupByName = new Map(groups.map((group) => [group.name, group]));
  const emittedGroups = new Set<string>();
  for (const row of rows) {
    if (row.kind === "current" && row.role === "child") {
      const group = groupByName.get(row.rootName);
      if (group !== undefined && !emittedGroups.has(group.name)) {
        appendWorkflowGroupOnlyHeader(out, group);
        emittedGroups.add(group.name);
      }
    }
    const prefix = row.kind === "current" && row.role === "child" ? "    ├ " : "  ";
    out.push(`${prefix}${passiveCatalogRowLine(row)}`);
  }
  for (const group of groups) {
    if (!emittedGroups.has(group.name)) appendWorkflowGroupOnlyHeader(out, group);
  }
}

function appendWorkflowGroupOnlyHeader(out: string[], group: WorkflowCatalogGroup): void {
  out.push(`  ${group.name} · ${workflowSourceBadge(group.source)} · group-only (not runnable)`);
}

function workflowCompositionDetailLines(row: WorkflowCatalogRow): string[] {
  if (row.role === "child") return [`composition: child of ${row.rootName}`];
  return [
    `composition: root (${row.children.length} child workflow(s))`,
    ...row.children.map((child, index) => `  child ${index + 1}: ${child}`),
  ];
}

function workflowCompositionCompactLine(row: WorkflowCatalogRow): string {
  return row.role === "root"
    ? `Composition: root · ${row.children.length} child workflow(s)`
    : `Composition: child of ${row.rootName}`;
}

function passiveCatalogRowLine(row: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow): string {
  const run = row.kind === "history" ? ` · run ${row.runId}` : "";
  const name = row.kind === "current" && row.role === "child" ? row.label : row.name;
  const composition =
    row.kind !== "current" || row.role === "child" || row.children.length === 0
      ? ""
      : ` · ${row.children.length} children`;
  // Stage count only: the full declaration belongs to /workflows info, and a
  // catalog row that grows with the pipeline stops being scannable.
  const phases = row.phases.length > 0 ? ` · phases=${row.phases.length}` : "";
  return `${name}${run} · ${workflowSourceBadge(row.source)}${composition} · ${row.description}${phases} · /workflows info ${row.name}`;
}

function authoringProfileExplanation(profile: WorkflowAuthoringProfile): string {
  if (profile === "standard") return "standard (compact public source shape; not a runtime mode)";
  if (profile === "integration") return "integration (integration-test source shape; not a runtime mode)";
  if (profile === "legacy") return "legacy (compatibility source shape; not a runtime mode)";
  return "unclassified (no recognized source-shape contract)";
}

export function workflowSourceBadge(source: WorkflowCatalogRow["source"]): "[P]" | "[U]" | "[PKG]" {
  if (source === "project") return "[P]";
  if (source === "personal") return "[U]";
  return "[PKG]";
}

export function workflowSourceLabel(source: WorkflowCatalogRow["source"]): "Project" | "User" | "Package" {
  if (source === "project") return "Project";
  if (source === "personal") return "User";
  return "Package";
}

function compareCatalogRows(a: WorkflowCatalogRow, b: WorkflowCatalogRow): number {
  const root = a.rootName.localeCompare(b.rootName);
  if (root !== 0) return root;
  if (a.role !== b.role) return a.role === "root" ? -1 : 1;
  return a.label.localeCompare(b.label);
}

function compactWorkflowCatalogLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function sameResolvedTarget(left: ResolvedWorkflowTarget, right: ResolvedWorkflowTarget): boolean {
  return (
    left.kind === right.kind &&
    left.ref === right.ref &&
    left.source === right.source &&
    path.resolve(left.path) === path.resolve(right.path)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
