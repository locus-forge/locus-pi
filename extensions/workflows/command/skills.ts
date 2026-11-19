/** Manage the package's four canonical skill links in external host directories. */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../operator/operator-ui.js";
import {
  claudeOverride,
  resolveSkillDirectories,
  WORKFLOW_SKILL_HOSTS,
  workflowSkillDestination,
} from "./skill-doctor/skills-destinations.js";
import {
  readSkillEntry,
  sameIdentity,
  SkillTreeTransaction,
  type FileIdentity,
  type SkillEntry,
  type SkillMutationBoundary,
  type SkillUndoIssue,
} from "./skill-doctor/skills-fs.js";

export const WORKFLOW_SKILL_NAMES = [
  "locus-pi-workflow-create",
  "locus-pi-workflow-create-detailed",
  "locus-pi-workflow-run",
  "external-locus-pi",
] as const;

const RETIRED = [
  "locus-pi-workflows",
  "locus-pi-run-workflow",
  "locus-task-workflow",
  "locus-pi-workflow-implement-task",
] as const;
const KNOWN_NAMES = new Set<string>([...WORKFLOW_SKILL_NAMES, ...RETIRED]);

export const WORKFLOW_SKILL_STATE_FILE = ".locus-pi-workflow-skills.v1.json";
// Keep the filename and owner so a v1-only installer rejects the new schema.
const OWNER = "@kroffske/locus-pi";
const SCHEMA_V1 = "locus-pi.workflow-skills.v1";
const SCHEMA_V2 = "locus-pi.workflow-skills.v2";
const DEFAULT_PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export type WorkflowSkillHost = "codex" | "claude";
export type WorkflowSkillHostSelector = WorkflowSkillHost | "all";
export type WorkflowSkillScope = "user" | "project";
export type WorkflowSkillHostAction = "sync" | "status" | "remove";

export interface WorkflowSkillHostCommand {
  action: WorkflowSkillHostAction;
  host: WorkflowSkillHostSelector;
  scope: WorkflowSkillScope;
}

interface WorkflowSkillHostOptions extends WorkflowSkillHostCommand {
  projectRoot: string;
  packageRoot?: string;
  userHome?: string;
  /** Deterministic filesystem boundary probes. */
  _testAtBoundary?: (boundary: SkillMutationBoundary, file: string) => void;
  _testAfterMutation?: (file: string) => void;
}

export interface WorkflowSkillHostResultRow {
  host: WorkflowSkillHost;
  scope: WorkflowSkillScope;
  skill: string;
  path: string;
  state: "absent" | "current" | "stale" | "conflict" | "source-unavailable";
  changed: "created" | "replaced" | "removed" | "none";
  legacy?: true;
  reason?: string;
}

export interface WorkflowSkillHostResultGroup {
  host: WorkflowSkillHost;
  scope: WorkflowSkillScope;
  path: string;
  defaultClaudeFolder: boolean;
  rows: WorkflowSkillHostResultRow[];
  blocked?: string;
}

export interface WorkflowSkillHostResult {
  groups: WorkflowSkillHostResultGroup[];
  source: string;
}

type Proof = { target: string; identity: FileIdentity };
type Marker = {
  entry?: SkillEntry;
  proofs: Map<string, Proof>;
  legacyNames: Set<string>;
};

interface Candidate {
  row: WorkflowSkillHostResultRow;
  entry: SkillEntry | undefined;
  source: string | undefined;
  change: "write" | "remove" | undefined;
}

interface Work {
  group: WorkflowSkillHostResultGroup;
  tx: SkillTreeTransaction;
  markerPath: string;
  initialMarker: Marker;
  currentMarker: SkillEntry | undefined;
  candidates: Candidate[];
  written: Map<Candidate, SkillEntry | undefined>;
}

export class WorkflowSkillWriteError extends Error {
  constructor(
    cause: string,
    readonly outcome: "refused" | "rolled-back" | "incomplete",
    readonly groups: WorkflowSkillHostResultGroup[],
    readonly issues: SkillUndoIssue[] = [],
  ) {
    super(outcome === "incomplete" ? `Incomplete rollback: ${cause}` : cause);
  }
}

export function operateWorkflowSkillHosts(options: WorkflowSkillHostOptions): WorkflowSkillHostResult {
  const source = path.join(path.resolve(options.packageRoot ?? DEFAULT_PACKAGE_ROOT), "skills");
  const scope = options.scope;
  const home = options.userHome ?? homedir();
  const project = options.projectRoot;
  const hosts = options.host === "all" ? WORKFLOW_SKILL_HOSTS : [options.host];
  const groups: WorkflowSkillHostResultGroup[] = [];
  const prepared: Work[] = [];
  for (const host of hosts) {
    const group: WorkflowSkillHostResultGroup = {
      host,
      scope,
      path: workflowSkillDestination(host, scope === "user" ? home : project),
      defaultClaudeFolder: host === "claude" && scope === "user" && claudeOverride(home) !== undefined,
      rows: [],
    };
    groups.push(group);
    try {
      const { directories, peerBlock } = resolveSkillDirectories(host, scope, home, project);
      group.path = [...directories.keys()].at(-1)!;
      const markerPath = path.join(group.path, WORKFLOW_SKILL_STATE_FILE);
      const initialMarker = readMarker(markerPath);
      const candidates = [...KNOWN_NAMES].map((name) =>
        inspectCandidate(group, source, name, initialMarker, options.action),
      );
      group.rows = candidates.map(({ row }) => row);
      const conflicts = group.rows.filter((row) => row.state === "conflict").map((row) => row.reason);
      const unavailable = group.rows.filter((row) => row.state === "source-unavailable").map((row) => row.reason);
      const blockers = options.action === "remove" ? conflicts : [...conflicts, ...unavailable];
      if (peerBlock) blockers.unshift(peerBlock);
      if (blockers.length) group.blocked = blockers.join("\n");
      prepared.push({
        group,
        tx: new SkillTreeTransaction(directories, options),
        markerPath,
        initialMarker,
        currentMarker: initialMarker.entry,
        candidates,
        written: new Map(),
      });
    } catch (error) {
      group.blocked = errorMessage(error);
    }
  }

  if (options.action !== "status") {
    const blockers = groups.flatMap((group) => (group.blocked ? [group.blocked] : []));
    if (blockers.length) throw new WorkflowSkillWriteError(blockers.join("\n"), "refused", groups);
    const started: Work[] = [];
    try {
      for (const work of prepared) {
        const { initialMarker, candidates, tx } = work;
        const effects = candidates.some((candidate) => candidate.change);
        const retained = candidates.filter((candidate) => candidate.entry?.kind === "link" && !candidate.change).length;
        const claimed = initialMarker.proofs.size;
        // An unchanged marker is part of idempotence, including its inode.
        const oldClaim = initialMarker.legacyNames.size > 0 || (initialMarker.entry && !claimed);
        if (!effects && !oldClaim && retained === claimed) continue;
        started.push(work);
        tx.prepare();
        applySkillWrite(work, options.action);
      }
    } catch (error) {
      const changed = started.some(
        (work) => work.tx.createdDirectory || work.written.size > 0 || work.currentMarker !== work.initialMarker.entry,
      );
      for (const work of started.reverse()) rollback(work);
      const issues = started.flatMap((work) => work.tx.issues);
      throw new WorkflowSkillWriteError(
        errorMessage(error),
        issues.length ? "incomplete" : changed ? "rolled-back" : "refused",
        groups,
        issues,
      );
    }
  }
  return { groups, source };
}

function inspectCandidate(
  group: WorkflowSkillHostResultGroup,
  sourceRoot: string,
  skill: string,
  marker: Marker,
  action: WorkflowSkillHostAction,
): Candidate {
  const legacy = !(WORKFLOW_SKILL_NAMES as readonly string[]).includes(skill);
  const destination = path.join(group.path, skill);
  const source = legacy ? undefined : path.join(sourceRoot, skill);
  const entry = readSkillEntry(destination, false);
  const current = entry?.kind === "link" && source !== undefined && sameManifest(destination, source);
  const proof = marker.proofs.get(skill);
  const owned =
    entry?.kind === "link" &&
    proof !== undefined &&
    sameIdentity(entry.identity, proof.identity) &&
    entry.value === proof.target;
  const row: WorkflowSkillHostResultRow = {
    host: group.host,
    scope: group.scope,
    skill,
    path: destination,
    state: entry ? (current ? "current" : "stale") : "absent",
    changed: "none",
    ...(legacy ? { legacy: true } : {}),
  };
  if (entry && !owned) {
    row.state = "conflict";
    const legacyLink = entry.kind === "link" && marker.legacyNames.has(skill);
    const diagnosis = legacyLink
      ? `v1 ownership unverified at ${destination} (${current ? "points to current package" : "other target"}).`
      : `Ownership conflict at ${destination}.`;
    const manual =
      entry.kind === "link" && (legacyLink || proof)
        ? " Inspect and move only disputed links you choose to clear to a backup outside this skills folder, then check again."
        : "";
    row.reason = `${diagnosis} Marker: ${path.join(group.path, WORKFLOW_SKILL_STATE_FILE)}.${manual}`;
  } else if (action !== "remove" && source && !readableSkill(source)) {
    row.state = "source-unavailable";
    row.reason = `Package skill source unavailable: ${path.join(source, "SKILL.md")}. Restore the package and check again.`;
  }
  const blocked = row.state === "conflict" || row.state === "source-unavailable";
  const change =
    !blocked &&
    (action === "sync"
      ? legacy
        ? owned
          ? "remove"
          : undefined
        : !current
          ? "write"
          : undefined
      : action === "remove" && owned
        ? "remove"
        : undefined);
  return { row, entry, source, change: change || undefined };
}

function sameManifest(link: string, source: string): boolean {
  try {
    return realpathSync.native(path.join(link, "SKILL.md")) === realpathSync.native(path.join(source, "SKILL.md"));
  } catch {
    return false;
  }
}

function readableSkill(source: string): boolean {
  const manifest = path.join(source, "SKILL.md");
  try {
    if (!statSync(manifest).isFile()) return false;
    accessSync(manifest, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readMarker(file: string): Marker {
  const invalid = () => new Error(`Invalid or foreign workflow skill marker: ${file}`);
  let entry: SkillEntry | undefined;
  try {
    entry = readSkillEntry(file);
  } catch (error) {
    throw new Error(`Cannot read workflow skill marker ${file}: ${errorMessage(error)}`);
  }
  if (!entry) return { proofs: new Map(), legacyNames: new Set() };
  if (entry.kind !== "file") throw invalid();

  let record: { owner?: unknown; schema?: unknown; links?: unknown };
  try {
    record = JSON.parse(entry.value);
  } catch {
    throw invalid();
  }
  if (record?.owner !== OWNER || !Array.isArray(record.links)) throw invalid();
  if (record.schema === SCHEMA_V1 && record.links.every((name) => typeof name === "string" && KNOWN_NAMES.has(name))) {
    return { entry, proofs: new Map(), legacyNames: new Set(record.links as string[]) };
  }
  if (record.schema !== SCHEMA_V2) throw invalid();
  const proofs = new Map<string, Proof>();
  for (const link of record.links) {
    if (
      !link ||
      typeof link.name !== "string" ||
      !KNOWN_NAMES.has(link.name) ||
      proofs.has(link.name) ||
      typeof link.target !== "string" ||
      link.target.length === 0 ||
      link.target.includes("\0") ||
      !validIdentity(link.identity)
    ) {
      throw invalid();
    }
    proofs.set(link.name, { target: link.target, identity: link.identity });
  }
  return { entry, proofs, legacyNames: new Set() };
}

function validIdentity(value: unknown): value is FileIdentity {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    ["device", "inode", "born", "changed"].every(
      (key) => typeof entry[key] === "string" && /^(?:0|-?[1-9]\d*)$/u.test(entry[key]),
    ) &&
    typeof entry.inode === "string" &&
    /^[1-9]\d*$/u.test(entry.inode)
  );
}

function markerContents(proofs: Map<string, Proof>): string | undefined {
  if (!proofs.size) return undefined;
  const links = [...proofs].map(([name, proof]) => ({ name, ...proof }));
  return `${JSON.stringify({ schema: SCHEMA_V2, owner: OWNER, links }, null, 2)}\n`;
}

function applySkillWrite(work: Work, action: "sync" | "remove"): void {
  const { tx, candidates, markerPath } = work;
  const requireMarker = () => tx.requireEntry(markerPath, work.currentMarker);
  for (const candidate of candidates) {
    const { change, row, entry, source } = candidate;
    if (!change) continue;
    if (change === "write") {
      work.written.set(candidate, tx.write(row.path, entry, "link", source!, requireMarker));
      row.changed = entry ? "replaced" : "created";
      row.state = "current";
    } else {
      tx.remove(row.path, entry!, requireMarker);
      work.written.set(candidate, undefined);
      row.changed = "removed";
      row.state = "absent";
    }
    tx.afterMutation(row.path);
    if (tx.issues.length) throw new Error(`Could not clean staging entries for ${row.path}`);
  }

  const proofs = new Map<string, Proof>();
  for (const candidate of candidates) {
    const current = work.written.has(candidate) ? work.written.get(candidate) : candidate.entry;
    if (action === "sync" && current?.kind === "link") {
      proofs.set(candidate.row.skill, { identity: current.identity, target: current.value });
    }
  }
  const authorize = () => {
    for (const [candidate, written] of work.written) tx.requireEntry(candidate.row.path, written);
    for (const candidate of candidates) {
      if (!work.written.has(candidate)) tx.requireEntry(candidate.row.path, candidate.entry);
    }
  };
  const contents = markerContents(proofs);
  if (
    work.initialMarker.legacyNames.size ||
    !isDeepStrictEqual(work.initialMarker.proofs, proofs) ||
    (!contents && work.currentMarker)
  ) {
    if (contents) work.currentMarker = tx.write(markerPath, work.currentMarker, "file", contents, authorize);
    else if (work.currentMarker) {
      tx.remove(markerPath, work.currentMarker, authorize);
      work.currentMarker = undefined;
    }
    tx.afterMutation(markerPath);
    if (tx.issues.length) throw new Error(`Could not clean staging entries for ${markerPath}`);
  }
}

function rollback(work: Work): void {
  const { tx, markerPath, initialMarker } = work;
  const proofs = new Map(initialMarker.proofs);
  let refreshedProofs = false;
  const noAdditionalGuard = () => undefined;
  for (const [candidate, written] of [...work.written].reverse()) {
    const { row, entry } = candidate;
    tx.attempt(row.path, () => {
      if (entry?.kind === "link") {
        const restored = tx.write(row.path, written, "link", entry.value, noAdditionalGuard, true);
        if (proofs.has(row.skill)) {
          proofs.set(row.skill, { identity: restored.identity, target: entry.value });
          refreshedProofs = true;
        }
      } else if (written) tx.remove(row.path, written, noAdditionalGuard, true);
    });
  }

  if (work.currentMarker !== initialMarker.entry || refreshedProofs) {
    tx.attempt(markerPath, () => {
      const initial = initialMarker.entry;
      const text = refreshedProofs ? markerContents(proofs) : initial?.kind === "file" ? initial.value : undefined;
      if (text !== undefined) tx.write(markerPath, work.currentMarker, "file", text, noAdditionalGuard, true);
      else if (work.currentMarker) tx.remove(markerPath, work.currentMarker, noAdditionalGuard, true);
    });
  }
  tx.cleanupDirectories();
}
