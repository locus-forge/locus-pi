import path from "node:path";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  activityStore,
  type ActivityStore,
  type AgentActivity,
  type WorkflowActivity,
} from "../../_shared/agent-runtime/activity-store.js";
import { redactSecrets } from "../../_shared/host/redaction.js";

export interface CenterRow {
  key: string;
  kind: "project" | "workflow" | "agent" | "gap";
  text: string;
  agent?: AgentActivity;
  workflow?: WorkflowActivity;
  projectPath?: string;
  counts?: string;
  depth?: number;
  branch?: string;
}
const quiet = (text: string) => `\x1b[38;5;147m${text}\x1b[0m`;
const violet = (text: string) => `\x1b[38;5;141m${text}\x1b[0m`;
const heading = (text: string) => violet(`\x1b[1m${text}\x1b[22m`);
function statusColor(text: string): string {
  const color = /failed|error/.test(text)
    ? 203
    : /waiting|queued|awaiting|needs input/.test(text)
      ? 221
      : /running|working/.test(text)
        ? 84
        : 147;
  return `\x1b[38;5;${color}m${text}\x1b[0m`;
}
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
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
const clean = (text: string) =>
  redactSecrets(text)
    .text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export function agentActivityLabel(agent: AgentActivity): string {
  return !agent.current
    ? "inactive · history"
    : agent.active && agent.row.status === "done"
      ? "idle"
      : agent.row.status;
}
function workflowActivityLabel(run: WorkflowActivity): string {
  if (run.status !== "awaiting_operator") return run.status;
  return run.handoffState === "resolved" ? "answered" : run.handoffState === "running" ? "continuing" : "needs input";
}
/** Flat agent ownership; only authoritative workflow provenance creates visual indentation. */
export function commandCenterRows(store: ActivityStore = activityStore): CenterRow[] {
  const agents = [...store.agents.values()];
  const workflows = [...store.workflows.values()];
  const projects = new Set([
    ...agents.map((a) => a.row.projectRoot ?? "Project unknown"),
    ...workflows.map((w) => w.projectRoot),
  ]);
  const rows: CenterRow[] = [];
  for (const project of projects) {
    if (rows.length) rows.push({ key: `gap:${project}`, kind: "gap", text: "" });
    const members = agents.filter((a) => (a.row.projectRoot ?? "Project unknown") === project);
    const active = members.filter((a) => a.active).length;
    rows.push({
      key: `project:${project}`,
      kind: "project",
      projectPath: project,
      counts: `${members.length} · ${active} active · ${members.length - active} inactive`,
      text: `${project}  ${members.length} sessions · ${active} active · ${members.length - active} inactive`,
    });
    const runs = workflows.filter((w) => w.projectRoot === project);
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

export class AgentsCommandCenter implements Component {
  #selected: string | undefined;
  #offset = 0;
  #detailOffset = 0;
  #notice = "";
  #showDetails = false;
  #fullPaths = false;
  constructor(
    private readonly height: () => number,
    private readonly choose: (agent: AgentActivity) => void,
    private readonly dismiss: () => void,
    private readonly repaint: () => void,
    private readonly store: ActivityStore = activityStore,
    selected?: string,
  ) {
    this.#selected = selected;
  }
  invalidate(): void {}
  get selectedKey(): string | undefined {
    return this.#selected;
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "backspace") || matchesKey(data, "left")) {
      this.dismiss();
      return;
    }
    const rows = commandCenterRows(this.store).filter((row) => row.kind === "agent" || row.kind === "workflow");
    let index = rows.findIndex((row) => row.key === this.#selected);
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      index = (index + (matchesKey(data, "up") ? -1 : 1) + rows.length) % rows.length;
      this.#selected = rows[index]?.key;
      this.#detailOffset = 0;
      this.#notice = "";
    } else if (data === "p" || data === "P") {
      this.#fullPaths = !this.#fullPaths;
      this.#detailOffset = 0;
    } else if (matchesKey(data, "tab")) this.#showDetails = !this.#showDetails;
    else if (matchesKey(data, "pageDown")) this.#detailOffset += 5;
    else if (matchesKey(data, "pageUp")) this.#detailOffset = Math.max(0, this.#detailOffset - 5);
    else if (matchesKey(data, "enter")) {
      const row = rows.find((candidate) => candidate.key === this.#selected);
      if (row?.agent !== undefined) this.choose(row.agent);
      else
        this.#notice = row?.workflow
          ? "Workflow expanded below; select an agent to open its session."
          : "Selection is no longer available. Choose another agent.";
    }
    this.repaint();
  }
  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const height = Math.max(5, this.height());
    const rows = commandCenterRows(this.store);
    if (this.#selected === undefined)
      this.#selected = rows.find((r) => r.kind === "agent" || r.kind === "workflow")?.key;
    const selected = rows.find((row) => row.key === this.#selected);
    const contentHeight = Math.max(1, height - 7);
    const selectedIndex = rows.findIndex((row) => row.key === this.#selected);
    if (selectedIndex >= 0) {
      if (selectedIndex < this.#offset) this.#offset = selectedIndex;
      if (selectedIndex >= this.#offset + contentHeight) this.#offset = selectedIndex - contentHeight + 1;
    }
    this.#offset = Math.min(this.#offset, Math.max(0, rows.length - contentHeight));
    const split = safeWidth >= 70;
    const leftWidth = split ? Math.floor(safeWidth * 0.59) : safeWidth;
    const rightWidth = split ? Math.max(1, safeWidth - leftWidth - 3) : safeWidth;
    const statusWidth = leftWidth >= 35 ? 11 : 0;
    const nameWidth = leftWidth - statusWidth - (statusWidth ? 1 : 0);
    const details = this.details(selected, rightWidth).flatMap((line) => wrapTextWithAnsi(line, rightWidth));
    this.#detailOffset = Math.min(this.#detailOffset, Math.max(0, details.length - contentHeight));
    const agents = [...this.store.agents.values()];
    const active = agents.filter((a) => a.active).length;
    const output = [
      truncateToWidth(heading("Agents Command Center") + quiet("  Group: Project"), safeWidth),
      truncateToWidth(quiet(`All ${agents.length} · Active ${active} · Inactive ${agents.length - active}`), safeWidth),
      violet("─".repeat(safeWidth)),
      split
        ? pad(quiet("Agents / Workflows"), nameWidth) +
          (statusWidth ? quiet(pad("Status", statusWidth + 1)) : "") +
          violet(" │ ") +
          heading(selected?.workflow ? "Workflow Details" : "Agent Details")
        : heading(
            this.#showDetails ? (selected?.workflow ? "Workflow Details" : "Agent Details") : "Agents / Workflows",
          ),
    ];
    for (let i = 0; i < contentHeight; i++) {
      const row = rows[this.#offset + i];
      let left = "";
      if (row?.projectPath !== undefined) {
        const counts = leftWidth >= 65 ? `${row.counts?.replace(" ·", " sessions ·")}` : `${row.counts}`;
        const projectWidth = Math.max(4, leftWidth - visibleWidth(counts) - 3);
        left = heading(tailPath(clean(row.projectPath), projectWidth)) + quiet(` [${counts}]`);
      } else if (row?.agent || row?.workflow) {
        const label = row.agent
          ? `${row.agent.row.displayName ?? row.agent.row.agentName ?? "agent"} — ${row.agent.row.title ?? row.agent.row.request ?? row.agent.row.label}`
          : compactWorkflowPath(
              row.workflow!.sourcePath,
              row.workflow!.projectRoot,
              Math.max(1, nameWidth - visibleWidth(row.branch ?? "") - 2),
            );
        const state = row.agent
          ? agentActivityLabel(row.agent).replace("inactive · history", "inactive")
          : workflowActivityLabel(row.workflow!);
        const selectedRow = row.key === this.#selected;
        const prefix = quiet(row.branch ?? "") + (selectedRow ? violet("▧ ") : "  ");
        const available = Math.max(1, nameWidth - visibleWidth(prefix));
        const name = truncateToWidth(clean(label).replace(/\s*\n\s*/g, " "), available);
        let cell = pad(prefix + (row.workflow ? quiet(name) : name), nameWidth);
        // Stipple marker + low-contrast foreground across the row, never a saturated background.
        if (selectedRow) cell = violet(pad((row.branch ?? "") + "▧ " + name, nameWidth));
        left = cell + (statusWidth ? " " + statusColor(truncateToWidth(state, statusWidth)) : "");
      } else if (!rows.length && i === 0) left = quiet("No agent sessions or workflows yet.");
      left = pad(truncateToWidth(left, leftWidth), leftWidth);
      const right = details[this.#detailOffset + i] ?? "";
      output.push(split ? `${left}${violet(" │ ")}${right}` : this.#showDetails ? right : left);
    }
    output.push(violet("─".repeat(safeWidth)));
    output.push(
      truncateToWidth(
        this.#notice
          ? quiet(this.#notice)
          : violet("↑↓") +
              quiet(" move · ") +
              violet("Enter") +
              quiet(" open · ") +
              violet("Esc/Backspace") +
              quiet(" back · ") +
              violet("Tab") +
              quiet(" details · ") +
              violet("P") +
              quiet(" paths · PgUp/PgDn scroll"),
        safeWidth,
      ),
    );
    output.push(quiet(truncateToWidth("← from empty input opens this center", safeWidth)));
    return output;
  }
  private details(row: CenterRow | undefined, width: number): string[] {
    const field = (name: string, value: string) => quiet(name + ": ") + clean(value);
    if (row?.agent !== undefined) {
      const a = row.agent;
      const workflow = a.row.workflowRunId ? this.store.workflows.get(a.row.workflowRunId) : undefined;
      const cwd = a.display.cwd ?? a.row.currentPath ?? "unknown";
      const last = clean(a.row.latestMessage ?? a.row.finalAnswer ?? "No message yet");
      const lastLines = wrapTextWithAnsi(last, width);
      const preview =
        lastLines.length > 3
          ? [...lastLines.slice(0, 2), truncateToWidth(lastLines[2]!, Math.max(1, width - 1)) + "…"]
          : lastLines;
      return [
        clean(`${a.row.displayName ?? a.row.agentName ?? "Agent"} — ${a.row.title ?? a.row.label}`),
        "",
        quiet("Activity: ") + statusColor(agentActivityLabel(a)),
        ...(workflow
          ? [field("Workflow", compactWorkflowPath(workflow.sourcePath, workflow.projectRoot, Math.max(1, width - 10)))]
          : []),
        field("Model", a.display.model ?? (a.row.modelConfirmed ? a.row.model : undefined) ?? "unknown"),
        field("Reasoning", a.display.thinking ?? (a.row.modelConfirmed ? a.row.thinking : undefined) ?? "unknown"),
        "",
        field("Working path", tailPath(clean(cwd), Math.max(8, width - 14))),
        "",
        quiet("Last message"),
        ...preview,
        "",
        quiet("Launch prompt"),
        clean(a.row.request ?? a.display.task ?? "Unavailable"),
        "",
        ...(this.#fullPaths ? [field("Full working path", cwd)] : []),
        ...(lastLines.length > 3 ? ["", quiet("Full last message"), last] : []),
        ...(a.current ? [] : ["", quiet("Historical snapshot · read-only · no implicit resume")]),
      ];
    }
    if (row?.workflow !== undefined)
      return [
        compactWorkflowPath(row.workflow.sourcePath, row.workflow.projectRoot, width),
        "",
        quiet("Activity: ") + statusColor(workflowActivityLabel(row.workflow)),
        ...(row.workflow.status === "awaiting_operator" ? [field("Run outcome", "awaiting operator")] : []),
        ...(this.#fullPaths
          ? [field("Full source path", row.workflow.sourcePath), field("Full project path", row.workflow.projectRoot)]
          : [
              field(
                "Source",
                compactWorkflowPath(row.workflow.sourcePath, row.workflow.projectRoot, Math.max(1, width - 8)),
              ),
              field("Project", tailPath(clean(row.workflow.projectRoot), Math.max(1, width - 9))),
            ]),
        field("Run", row.workflow.runId),
        "",
        quiet("Always expanded. Select an agent to inspect its session."),
      ];
    return [quiet("Select an agent.")];
  }
}

function tailPath(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  const characters = [...value];
  while (characters.length && visibleWidth(characters.join("")) > width - 1) characters.shift();
  return `…${characters.join("")}`;
}
