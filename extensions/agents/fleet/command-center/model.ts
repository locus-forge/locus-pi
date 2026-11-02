import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  activityStore,
  agentActivityLabel,
  type ActivityStore,
  type AgentActivity,
  type WorkflowActivity,
} from "../../../_shared/agent-runtime/activity-store.js";
import { redactSecrets } from "../../../_shared/host/redaction.js";

export interface CenterRow {
  key: string;
  kind: "project" | "workflow" | "agent" | "gap";
  text: string;
  agent?: AgentActivity;
  workflow?: WorkflowActivity;
  projectPath?: string;
  repositoryRoot?: string;
  launchRoots?: string[];
  counts?: string;
  depth?: number;
  branch?: string;
}
/** Presentation only: identity/selection always use canonical run/session keys. */
export function compactWorkflowPath(value: string, project: string, width: number): string {
  const rel = path.isAbsolute(value) ? path.relative(project, value) : value;
  const external = path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`);
  const raw = clean(external ? value : rel || path.basename(value)).replace(/\s*\n\s*/g, " ");
  const prefix = external ? "external: " : "";
  const budget = Math.max(1, width - visibleWidth(prefix));
  const parts = raw.split(path.sep).filter(Boolean);
  const suffix = parts.slice(-2).join(path.sep);
  let shown = raw;
  if (visibleWidth(shown) > budget) {
    if (visibleWidth(suffix) + 2 <= budget) {
      const first = parts[0] ?? "";
      const lead = truncateToWidth(first, Math.max(0, budget - visibleWidth(suffix) - 2), "");
      shown = `${lead}…/${suffix}`;
    } else {
      const basename = parts.at(-1) ?? raw;
      if (visibleWidth(basename) + 4 <= budget && parts.length > 1) {
        const folder = parts.at(-2)!;
        shown = `${truncateToWidth(folder, budget - visibleWidth(basename) - 1)}/${basename}`;
      } else if (visibleWidth(basename) + 2 <= budget) shown = `…/${basename}`;
      else {
        const tail = tailPath(basename, Math.max(1, Math.floor(budget * 0.6)));
        const head = truncateToWidth(basename, Math.max(0, budget - visibleWidth(tail)), "");
        shown = head + tail;
      }
    }
  }
  return truncateToWidth(prefix + shown, Math.max(1, width));
}
function tailPath(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  const characters = [...value];
  while (characters.length && visibleWidth(characters.join("")) > width - 1) characters.shift();
  return `…${characters.join("")}`;
}
export const clean = (text: string) =>
  redactSecrets(text)
    .text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export function workflowActivityLabel(run: WorkflowActivity): string {
  if (run.status !== "awaiting_operator") return run.status;
  return run.handoffState === "resolved" ? "answered" : run.handoffState === "running" ? "continuing" : "needs input";
}
/** Counts retained evidence, not all-time history or attempts that never created an SDK session. */
export function commandCenterCounts(agents: readonly AgentActivity[]) {
  const sessions = new Map<string, boolean>();
  for (const agent of agents) {
    const id = agent.row.childSessionId;
    if (id === undefined || id.trim() === "") continue;
    const key = JSON.stringify([agent.row.projectRoot ?? "Project unknown", id]);
    sessions.set(key, (sessions.get(key) ?? false) || (agent.current && agent.active));
  }
  const active = [...sessions.values()].filter(Boolean).length;
  return {
    sessions: sessions.size,
    active,
    inactive: sessions.size - active,
    executions: agents.length,
    running: agents.filter((agent) => agent.current && agent.row.status === "working").length,
  };
}

/** Repository hints are scoped to one open center; runtime launch identities stay unchanged. */
export type ProjectContexts = Map<string, string | undefined>;
export function repositoryRoot(launchRoot: string, contexts: ProjectContexts): string | undefined {
  if (contexts.has(launchRoot)) return contexts.get(launchRoot);
  let directory = launchRoot;
  let repository: string | undefined;
  while (path.isAbsolute(directory)) {
    let markerExists = false;
    try {
      const marker = path.join(directory, ".git");
      const info = statSync(marker);
      markerExists = true;
      if (info.isDirectory()) repository = directory;
      else if (info.isFile()) {
        const target = /^gitdir: (.+)$/.exec(readFileSync(marker, "utf8").split(/\r?\n/, 1)[0] ?? "");
        if (target && statSync(path.resolve(directory, target[1]!)).isDirectory()) repository = directory;
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // An unreadable or broken marker cannot establish an enclosing repository either.
      if (markerExists || (code !== "ENOENT" && code !== "ENOTDIR")) break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  contexts.set(launchRoot, repository);
  return repository;
}

/** Compact context paths retain the repository anchor and distinguish external working directories. */
export function contextPath(value: string, launchRoot: string, width: number, contexts: ProjectContexts): string {
  const repository = repositoryRoot(launchRoot, contexts);
  if (!repository)
    return compactWorkflowPath(value === launchRoot ? path.basename(launchRoot) : value, launchRoot, width);
  const relative = path.relative(repository, value);
  const inside = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return compactWorkflowPath(inside ? path.join(path.basename(repository), relative) : value, repository, width);
}

/** Repository grouping is display-only; session counts retain each original launch identity. */
export function commandCenterRows(
  store: ActivityStore = activityStore,
  contexts: ProjectContexts = new Map(),
): CenterRow[] {
  const agents = [...store.agents.values()];
  const workflows = [...store.workflows.values()];
  const launchRoots = new Set([
    ...agents.map((a) => a.row.projectRoot ?? "Project unknown"),
    ...workflows.map((w) => w.projectRoot),
  ]);
  const projects = new Map<string, string[]>();
  for (const root of launchRoots) {
    const project = repositoryRoot(root, contexts) ?? root;
    projects.set(project, [...(projects.get(project) ?? []), root]);
  }
  const rows: CenterRow[] = [];
  for (const [project, roots] of projects) {
    if (rows.length) rows.push({ key: `gap:${project}`, kind: "gap", text: "" });
    const members = agents.filter((a) => roots.includes(a.row.projectRoot ?? "Project unknown"));
    const counts = commandCenterCounts(members);
    const repository = repositoryRoot(roots[0]!, contexts);
    rows.push({
      key: `project:${project}`,
      kind: "project",
      projectPath: project,
      ...(repository === undefined ? {} : { repositoryRoot: repository }),
      launchRoots: roots,
      counts: `${counts.sessions} sessions · ${counts.active} open · ${counts.inactive} closed`,
      text: `${project}  ${counts.sessions} sessions · ${counts.active} open · ${counts.inactive} closed`,
    });
    const runs = workflows.filter((w) => roots.includes(w.projectRoot));
    const emitted = new Set<string>();
    const leaf = (agent: AgentActivity, depth: number) =>
      rows.push({
        key: agent.key,
        kind: "agent",
        agent,
        depth,
        text: `${"  ".repeat(depth)}${agent.active ? "●" : "○"} ${agent.row.displayName ?? agent.row.agentName ?? "agent"} · ${agent.row.title ?? agent.row.request ?? agent.row.label}  [${agentActivityLabel(agent)}]`,
      });
    const visit = (run: WorkflowActivity, depth: number) => {
      if (emitted.has(run.runId)) return;
      emitted.add(run.runId);
      rows.push({
        key: `workflow:${run.runId}`,
        kind: "workflow",
        workflow: run,
        depth,
        text: `${"  ".repeat(depth)}◇ ${run.sourcePath}  [${run.status}]`,
      });
      for (const agent of members.filter((a) => a.row.workflowRunId === run.runId)) leaf(agent, depth + 1);
      for (const child of runs.filter((w) => w.parentRunId === run.runId)) visit(child, depth + 1);
    };
    for (const agent of members.filter(
      (a) => a.row.workflowRunId === undefined || !runs.some((w) => w.runId === a.row.workflowRunId),
    ))
      leaf(agent, 1);
    for (const run of runs.filter((w) => w.parentRunId === undefined || !runs.some((p) => p.runId === w.parentRunId)))
      visit(run, 1);
    // Corrupt or missing lineage never hides evidence or recurses forever.
    for (const run of runs) if (!emitted.has(run.runId)) visit(run, 1);
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.depth === undefined) continue;
    const hasNext = (depth: number) => {
      for (let j = i + 1; j < rows.length; j++) {
        const next = rows[j]!;
        if (next.depth === undefined || next.depth < depth) return false;
        if (next.depth === depth) return true;
      }
      return false;
    };
    row.branch =
      Array.from({ length: row.depth - 1 }, (_, d) => (hasNext(d + 1) ? "│ " : "  ")).join("") +
      (hasNext(row.depth) ? "├─" : "└─");
  }
  return rows;
}
