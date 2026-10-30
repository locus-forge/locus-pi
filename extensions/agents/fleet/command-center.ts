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
}
const quiet = (text: string) => `\x1b[38;5;103m${text}\x1b[0m`;
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
        text: `${"  ".repeat(depth)}${agent.active ? "●" : "○"} ${agent.row.displayName ?? agent.row.agentName ?? "agent"} · ${agent.row.title ?? agent.row.request ?? agent.row.label}  [${agentActivityLabel(agent)}]`,
      });
    const visit = (run: WorkflowActivity, depth: number) => {
      if (emitted.has(run.runId)) return;
      emitted.add(run.runId);
      rows.push({
        key: `workflow:${run.runId}`,
        kind: "workflow",
        workflow: run,
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
  return rows;
}

export class AgentsCommandCenter implements Component {
  #selected: string | undefined;
  #offset = 0;
  #detailOffset = 0;
  #notice = "";
  #showDetails = false;
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
    const contentHeight = Math.max(1, height - 4);
    const selectedIndex = rows.findIndex((row) => row.key === this.#selected);
    if (selectedIndex >= 0) {
      if (selectedIndex < this.#offset) this.#offset = selectedIndex;
      if (selectedIndex >= this.#offset + contentHeight) this.#offset = selectedIndex - contentHeight + 1;
    }
    this.#offset = Math.min(this.#offset, Math.max(0, rows.length - contentHeight));
    const split = safeWidth >= 70;
    const leftWidth = split ? Math.floor(safeWidth * 0.59) : safeWidth;
    const rightWidth = split ? Math.max(1, safeWidth - leftWidth - 3) : safeWidth;
    const details = this.details(selected).flatMap((line) => wrapTextWithAnsi(clean(line), rightWidth));
    this.#detailOffset = Math.min(this.#detailOffset, Math.max(0, details.length - contentHeight));
    const output = [quiet(truncateToWidth("Agents Command Center", safeWidth)), quiet("─".repeat(safeWidth))];
    for (let i = 0; i < contentHeight; i++) {
      const row = rows[this.#offset + i];
      const text =
        row?.projectPath !== undefined
          ? `${tailPath(clean(row.projectPath), Math.max(5, leftWidth - 7 - (row.counts?.length ?? 0)))} [${row.counts}]`
          : row?.workflow !== undefined
            ? `${row.text.match(/^ */)?.[0] ?? ""}◇ ${tailPath(clean(row.workflow.sourcePath), Math.max(8, leftWidth - 20))} [${row.workflow.status}]`
            : row?.text;
      let left = truncateToWidth(
        clean(text ?? (i === 0 && rows.length === 0 ? "No agent sessions or workflows yet." : "")).replace(
          /\s*\n\s*/g,
          " ",
        ),
        Math.max(1, leftWidth - 2),
      );
      left = `${row !== undefined && row.key === this.#selected ? "▧ " : "  "}${left}`;
      left += " ".repeat(Math.max(0, leftWidth - visibleWidth(left)));
      if (row !== undefined && row.key === this.#selected) left = quiet(left); // deliberately no saturated background
      const right = details[this.#detailOffset + i] ?? "";
      output.push(split ? `${left}${quiet(" │ ")}${right}` : this.#showDetails ? right : left);
    }
    output.push(
      quiet(
        truncateToWidth(
          this.#notice || "↑↓ select · Enter open agent · Esc/Backspace back · Tab details · PgUp/PgDn scroll",
          safeWidth,
        ),
      ),
    );
    output.push(
      quiet(truncateToWidth("Recent process history · workflows always expanded · agents are leaves", safeWidth)),
    );
    return output;
  }
  private details(row: CenterRow | undefined): string[] {
    if (row?.agent !== undefined) {
      const a = row.agent;
      return [
        "Agent Details",
        "",
        a.row.title ?? a.row.label,
        `Agent: ${a.row.displayName ?? a.row.agentName ?? a.key}`,
        `Activity: ${agentActivityLabel(a)}`,
        `Model: ${a.display.model ?? (a.row.modelConfirmed ? a.row.model : undefined) ?? "unknown"}`,
        `Reasoning: ${a.display.thinking ?? (a.row.modelConfirmed ? a.row.thinking : undefined) ?? "unknown"}`,
        `Path: ${a.display.cwd ?? a.row.currentPath ?? "unknown"}`,
        `Session: ${a.row.childSessionId ?? a.key}`,
        "",
        "Last message",
        a.row.latestMessage ?? a.row.finalAnswer ?? "No message yet",
        "",
        "Launch prompt",
        a.row.request ?? a.display.task ?? "Unavailable",
        ...(a.current ? [] : ["", "Historical snapshot · read-only · no implicit resume"]),
      ];
    }
    if (row?.workflow !== undefined)
      return [
        "Workflow Details",
        "",
        row.workflow.sourcePath,
        `Activity: ${row.workflow.status}`,
        `Run: ${row.workflow.runId}`,
        `Project: ${row.workflow.projectRoot}`,
        "",
        "Always expanded. Select an agent to inspect its session.",
      ];
    return ["Agent Details", "", "Select an agent."];
  }
}

function tailPath(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  const characters = [...value];
  while (characters.length && visibleWidth(characters.join("")) > width - 1) characters.shift();
  return `…${characters.join("")}`;
}
