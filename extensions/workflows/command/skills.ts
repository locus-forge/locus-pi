/**
 * Install packaged workflow skills into external agent hosts.
 *
 * Package skill directories remain canonical. Host entries are managed
 * symlinks, so a package update changes the source without creating a second
 * copy that can drift. Every mutation is preflighted: real directories and
 * foreign symlinks are never overwritten or removed.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "../../_shared/host/pi-api.js";
import type { OperatorBlock } from "../../_shared/operator/operator-ui.js";
import { setOperatorWidget } from "../../_shared/operator/widget-render.js";
import { errorMessage, workflowWarningBlock } from "../operator/operator-ui.js";

export const WORKFLOW_SKILL_NAMES = ["locus-pi-workflow-create", "locus-pi-workflow-run", "external-locus-pi"] as const;

const LEGACY_WORKFLOW_SKILL_NAMES = [
  "locus-pi-workflows",
  "locus-pi-run-workflow",
  "locus-task-workflow",
  "locus-pi-workflow-implement-task",
] as const;
export const WORKFLOW_SKILL_STATE_FILE = ".locus-pi-workflow-skills.v1.json";
// Stable v1 provenance marker; existing installations retain it across npm package renames.
const WORKFLOW_SKILL_STATE_OWNER = "@kroffske/locus-pi";
const WORKFLOW_SKILL_STATE_SCHEMA = "locus-pi.workflow-skills.v1";

export type WorkflowSkillHost = "codex" | "claude";
export type WorkflowSkillHostSelector = WorkflowSkillHost | "all";
export type WorkflowSkillScope = "user" | "project";
export type WorkflowSkillHostAction = "sync" | "status" | "remove";
type WorkflowSkillLinkState = "absent" | "current" | "stale" | "conflict";

export interface WorkflowSkillHostCommand {
  action: WorkflowSkillHostAction;
  host: WorkflowSkillHostSelector;
  scope: WorkflowSkillScope;
}

export interface WorkflowSkillHostResultRow {
  host: WorkflowSkillHost;
  scope: WorkflowSkillScope;
  skill: string;
  path: string;
  state: WorkflowSkillLinkState;
  changed: "created" | "replaced" | "removed" | "none";
  legacy?: true;
}

export interface WorkflowSkillHostResult {
  action: WorkflowSkillHostAction;
  rows: WorkflowSkillHostResultRow[];
}

interface WorkflowSkillHostOperationOptions extends WorkflowSkillHostCommand {
  projectRoot: string;
  packageRoot?: string;
  userHome?: string;
  /** Deterministic failure injection for transaction tests. */
  _testAfterMutation?: (path: string) => void;
}

interface LinkCandidate {
  host: WorkflowSkillHost;
  scope: WorkflowSkillScope;
  skill: string;
  linkPath: string;
  sourceDir?: string;
  legacy: boolean;
  state: WorkflowSkillLinkState;
}

interface HostGroup {
  hostRoot: string;
  managedNames: Set<string>;
  stateText?: string;
  candidates: LinkCandidate[];
}

const DEFAULT_PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export function presentWorkflowSkillHostCommand(text: string, ctx: ExtensionCommandContext, projectRoot: string): void {
  const parsed = parseWorkflowSkillHostCommand(text);
  if (!parsed.ok) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        parsed.message,
        "Usage: /workflows skills <sync|status|remove> [--host codex|claude|all] [--scope user|project]",
      ),
    );
    return;
  }
  try {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowSkillHostResultBlock(operateWorkflowSkillHosts({ ...parsed.command, projectRoot })),
    );
  } catch (error) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        `Workflow skills command failed and its managed-link transaction was rolled back: ${errorMessage(error)}.`,
        "Inspect conflicts: /workflows skills status --host all --scope user",
      ),
    );
  }
}

export function parseWorkflowSkillHostCommand(
  text: string,
): { ok: true; command: WorkflowSkillHostCommand } | { ok: false; message: string } {
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  if (tokens[0] !== "skills") return { ok: false, message: "Expected the skills subcommand." };
  const action = tokens[1];
  if (action !== "sync" && action !== "status" && action !== "remove") {
    return { ok: false, message: "Expected skills sync, skills status, or skills remove." };
  }

  let host: WorkflowSkillHostSelector = "all";
  let scope: WorkflowSkillScope = "user";
  const seen = new Set<string>();
  for (let index = 2; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (value === undefined) return { ok: false, message: `Missing value for ${option}.` };
    if (option !== "--host" && option !== "--scope") {
      return { ok: false, message: `Unknown skills option: ${option}.` };
    }
    if (seen.has(option)) return { ok: false, message: `Duplicate skills option: ${option}.` };
    seen.add(option);
    if (option === "--host") {
      if (value !== "codex" && value !== "claude" && value !== "all") {
        return { ok: false, message: `Unsupported skills host: ${value}.` };
      }
      host = value;
    } else {
      if (value !== "user" && value !== "project") {
        return { ok: false, message: `Unsupported skills scope: ${value}.` };
      }
      scope = value;
    }
  }
  return { ok: true, command: { action, host, scope } };
}

export function operateWorkflowSkillHosts(options: WorkflowSkillHostOperationOptions): WorkflowSkillHostResult {
  const packageRoot = path.resolve(options.packageRoot ?? DEFAULT_PACKAGE_ROOT);
  const userHome = path.resolve(options.userHome ?? homedir());
  const hosts: WorkflowSkillHost[] = options.host === "all" ? ["codex", "claude"] : [options.host];
  const groups = hosts.map((host): HostGroup => {
    const hostRoot = workflowSkillHostRoot(host, options.scope, options.projectRoot, userHome);
    const managedState = readManagedState(hostRoot);
    return {
      hostRoot,
      managedNames: managedState.names,
      ...(managedState.text === undefined ? {} : { stateText: managedState.text }),
      candidates: buildCandidates(host, options.scope, hostRoot, packageRoot, managedState.names),
    };
  });
  const candidates = groups.flatMap((group) => group.candidates);

  if (options.action === "status") {
    return { action: options.action, rows: candidates.map((candidate) => resultRow(candidate, "none")) };
  }

  const conflicts = candidates.filter((candidate) => candidate.state === "conflict");
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to change unmanaged skill path(s): ${conflicts.map((candidate) => candidate.linkPath).join(", ")}`,
    );
  }
  if (options.action === "sync") {
    const missingSources = candidates.filter(
      (candidate) =>
        !candidate.legacy &&
        (candidate.sourceDir === undefined ||
          lstatSync(candidate.sourceDir, { throwIfNoEntry: false })?.isDirectory() !== true),
    );
    if (missingSources.length > 0) {
      throw new Error(
        `Packaged workflow skill source(s) missing: ${missingSources
          .map((candidate) => candidate.sourceDir ?? candidate.skill)
          .join(", ")}`,
      );
    }
  }

  const rows: WorkflowSkillHostResultRow[] = [];
  const snapshots = candidates.map((candidate) => ({
    path: candidate.linkPath,
    target: candidate.state === "absent" ? undefined : readlinkSync(candidate.linkPath),
  }));
  const mutatedPaths = new Set<string>();
  const recordMutation = (mutatedPath: string): void => {
    mutatedPaths.add(mutatedPath);
    options._testAfterMutation?.(mutatedPath);
  };
  try {
    if (options.action === "sync") {
      for (const group of groups) {
        writeManagedNames(group.hostRoot, new Set([...group.managedNames, ...WORKFLOW_SKILL_NAMES]));
        recordMutation(path.join(group.hostRoot, WORKFLOW_SKILL_STATE_FILE));
      }
    }
    for (const candidate of candidates) {
      if (options.action === "sync") {
        if (candidate.legacy) {
          if (candidate.state === "stale") {
            unlinkSync(candidate.linkPath);
            recordMutation(candidate.linkPath);
            rows.push(resultRow(candidate, "removed"));
          } else {
            rows.push(resultRow(candidate, "none"));
          }
          continue;
        }
        if (candidate.state === "current") {
          rows.push(resultRow(candidate, "none"));
          continue;
        }
        const sourceDir = candidate.sourceDir;
        if (sourceDir === undefined) throw new Error(`Packaged workflow skill is missing: ${candidate.skill}`);
        mkdirSync(path.dirname(candidate.linkPath), { recursive: true });
        replaceWithSymlink(candidate.linkPath, sourceDir);
        recordMutation(candidate.linkPath);
        rows.push(resultRow(candidate, candidate.state === "stale" ? "replaced" : "created"));
        continue;
      }

      if (candidate.state === "current" || candidate.state === "stale") {
        unlinkSync(candidate.linkPath);
        recordMutation(candidate.linkPath);
        rows.push(resultRow(candidate, "removed"));
      } else {
        rows.push(resultRow(candidate, "none"));
      }
    }
    for (const group of groups) {
      const finalNames = new Set(group.managedNames);
      if (options.action === "sync") {
        for (const skill of LEGACY_WORKFLOW_SKILL_NAMES) finalNames.delete(skill);
        for (const skill of WORKFLOW_SKILL_NAMES) finalNames.add(skill);
      } else {
        for (const skill of [...WORKFLOW_SKILL_NAMES, ...LEGACY_WORKFLOW_SKILL_NAMES]) finalNames.delete(skill);
      }
      writeManagedNames(group.hostRoot, finalNames);
      recordMutation(path.join(group.hostRoot, WORKFLOW_SKILL_STATE_FILE));
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const snapshot of [...snapshots].reverse()) {
      if (!mutatedPaths.has(snapshot.path)) continue;
      try {
        restoreLink(snapshot.path, snapshot.target);
      } catch (rollbackError) {
        rollbackErrors.push(`${snapshot.path}: ${errorMessage(rollbackError)}`);
      }
    }
    for (const group of groups) {
      const statePath = path.join(group.hostRoot, WORKFLOW_SKILL_STATE_FILE);
      if (!mutatedPaths.has(statePath)) continue;
      try {
        restoreManagedState(group.hostRoot, group.stateText);
      } catch (rollbackError) {
        rollbackErrors.push(`${statePath}: ${errorMessage(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${errorMessage(error)}; rollback failed: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }
  return { action: options.action, rows };
}

export function workflowSkillHostResultBlock(result: WorkflowSkillHostResult): OperatorBlock {
  const changed = result.rows.filter((row) => row.changed !== "none");
  const active = result.rows.filter((row) => !row.legacy);
  const primary =
    result.action === "status"
      ? `Inspected ${active.length} workflow skill link(s).`
      : `${result.action === "sync" ? "Synchronized" : "Removed"} ${changed.length} workflow skill link(s).`;
  return {
    type: "VIEW",
    subject: "Workflow skills",
    primary,
    body: result.rows.map(
      (row) =>
        `${row.host}/${row.scope} ${row.skill}: ${row.changed === "none" ? row.state : row.changed}${row.legacy ? " (legacy)" : ""}`,
    ),
    metadata: [
      `Packaged skill directories remain canonical; managed host entries are symlinks recorded by ${WORKFLOW_SKILL_STATE_FILE}.`,
    ],
    controls: ["Inspect: /workflows skills status --host all --scope user"],
  };
}

function buildCandidates(
  host: WorkflowSkillHost,
  scope: WorkflowSkillScope,
  hostRoot: string,
  packageRoot: string,
  managedNames: Set<string>,
): LinkCandidate[] {
  const current = WORKFLOW_SKILL_NAMES.map((skill) => {
    const linkPath = path.join(hostRoot, skill);
    const sourceDir = path.join(packageRoot, "skills", skill);
    return {
      host,
      scope,
      skill,
      linkPath,
      sourceDir,
      legacy: false,
      state: inspectLink(linkPath, sourceDir, managedNames.has(skill)),
    } satisfies LinkCandidate;
  });
  const legacy = LEGACY_WORKFLOW_SKILL_NAMES.map((skill) => {
    const linkPath = path.join(hostRoot, skill);
    return {
      host,
      scope,
      skill,
      linkPath,
      legacy: true,
      state: inspectLegacyLink(linkPath, managedNames.has(skill)),
    } satisfies LinkCandidate;
  });
  return [...current, ...legacy];
}

function workflowSkillHostRoot(
  host: WorkflowSkillHost,
  scope: WorkflowSkillScope,
  projectRoot: string,
  userHome: string,
): string {
  const base = scope === "user" ? userHome : path.resolve(projectRoot);
  return path.join(base, host === "codex" ? ".agents" : ".claude", "skills");
}

function inspectLink(linkPath: string, sourceDir: string, managed: boolean): WorkflowSkillLinkState {
  const stat = lstatSync(linkPath, { throwIfNoEntry: false });
  if (stat === undefined) return "absent";
  if (!stat.isSymbolicLink() || !managed) return "conflict";
  return resolveLinkTarget(linkPath) === path.resolve(sourceDir) ? "current" : "stale";
}

function inspectLegacyLink(linkPath: string, managed: boolean): WorkflowSkillLinkState {
  const stat = lstatSync(linkPath, { throwIfNoEntry: false });
  if (stat === undefined) return "absent";
  return stat.isSymbolicLink() && managed ? "stale" : "conflict";
}

function resolveLinkTarget(linkPath: string): string {
  const rawTarget = readlinkSync(linkPath);
  return path.resolve(path.dirname(linkPath), rawTarget);
}

function readManagedState(hostRoot: string): { names: Set<string>; text?: string } {
  const statePath = path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE);
  const stat = lstatSync(statePath, { throwIfNoEntry: false });
  if (stat === undefined) return { names: new Set() };
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Managed skill state is not a regular file: ${statePath}`);
  const text = readFileSync(statePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Managed skill state is invalid JSON: ${statePath}: ${errorMessage(error)}`);
  }
  const record = value as { schema?: unknown; owner?: unknown; links?: unknown };
  const allowed = new Set<string>([...WORKFLOW_SKILL_NAMES, ...LEGACY_WORKFLOW_SKILL_NAMES]);
  if (
    record?.schema !== WORKFLOW_SKILL_STATE_SCHEMA ||
    record.owner !== WORKFLOW_SKILL_STATE_OWNER ||
    !Array.isArray(record.links) ||
    record.links.some((name) => typeof name !== "string" || !allowed.has(name))
  ) {
    throw new Error(`Managed skill state has an unsupported shape: ${statePath}`);
  }
  return { names: new Set(record.links), text };
}

function writeManagedNames(hostRoot: string, names: Set<string>): void {
  const statePath = path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE);
  if (names.size === 0) {
    if (lstatSync(statePath, { throwIfNoEntry: false }) !== undefined) unlinkSync(statePath);
    return;
  }
  mkdirSync(hostRoot, { recursive: true });
  const text = `${JSON.stringify(
    { schema: WORKFLOW_SKILL_STATE_SCHEMA, owner: WORKFLOW_SKILL_STATE_OWNER, links: [...names].sort() },
    null,
    2,
  )}\n`;
  writeManagedStateText(hostRoot, text);
}

function restoreLink(linkPath: string, target: string | undefined): void {
  const stat = lstatSync(linkPath, { throwIfNoEntry: false });
  if (target === undefined) {
    if (stat === undefined) return;
    if (!stat.isSymbolicLink()) throw new Error("refusing to remove a concurrently replaced non-symlink");
    unlinkSync(linkPath);
    return;
  }
  if (stat !== undefined && !stat.isSymbolicLink()) {
    throw new Error("refusing to replace a concurrently created non-symlink");
  }
  mkdirSync(path.dirname(linkPath), { recursive: true });
  replaceWithSymlink(linkPath, target);
}

function restoreManagedState(hostRoot: string, text: string | undefined): void {
  const statePath = path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE);
  if (text !== undefined) {
    writeManagedStateText(hostRoot, text);
    return;
  }
  const stat = lstatSync(statePath, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("refusing to remove changed provenance state");
  unlinkSync(statePath);
}

function writeManagedStateText(hostRoot: string, text: string): void {
  const statePath = path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE);
  mkdirSync(hostRoot, { recursive: true });
  const temporary = `${statePath}.${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, statePath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary state file may not have been created.
    }
    throw error;
  }
}

function replaceWithSymlink(linkPath: string, sourceDir: string): void {
  const temporary = `${linkPath}.locus-pi-${process.pid}-${Date.now()}`;
  try {
    symlinkSync(sourceDir, temporary, "dir");
    renameSync(temporary, linkPath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary link may not have been created.
    }
    throw error;
  }
}

function resultRow(
  candidate: LinkCandidate,
  changed: WorkflowSkillHostResultRow["changed"],
): WorkflowSkillHostResultRow {
  return {
    host: candidate.host,
    scope: candidate.scope,
    skill: candidate.skill,
    path: candidate.linkPath,
    state: candidate.state,
    changed,
    ...(candidate.legacy ? { legacy: true as const } : {}),
  };
}
