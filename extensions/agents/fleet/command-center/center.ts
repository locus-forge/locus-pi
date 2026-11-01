import path from "node:path";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  activityStore,
  type ActivityStore,
  type AgentActivity,
} from "../../../_shared/agent-runtime/activity-store.js";
import type { ThemeLike } from "../../../_shared/host/render-profile.js";
import {
  clean,
  compactWorkflowPath,
  contextPath,
  repositoryRoot,
  agentActivityLabel,
  workflowActivityLabel,
  commandCenterCounts,
  commandCenterRows,
  type CenterRow,
  type ProjectContexts,
} from "./model.js";
export { compactWorkflowPath, agentActivityLabel, commandCenterCounts, commandCenterRows } from "./model.js";
export type { CenterRow } from "./model.js";

const quiet = (text: string) => `\x1b[38;5;147m${text}\x1b[39m`;
const violet = (text: string) => `\x1b[38;5;141m${text}\x1b[39m`;
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
function statusColor(text: string): string {
  const color = /failed|error/.test(text)
    ? 203
    : /waiting|queued|needs input/.test(text)
      ? 221
      : /running/.test(text)
        ? 84
        : 147;
  return `\x1b[38;5;${color}m${text}\x1b[39m`;
}

/** Keyboard ownership and layout for one center; it never changes execution authority. */
export class AgentsCommandCenter implements Component {
  #selected: string | undefined;
  #offset = 0;
  #detailOffset = 0;
  #detailPageSize = 16;
  #notice = "";
  #focus: "tree" | "details" = "tree";
  #fullPaths = false;
  readonly #projects: ProjectContexts = new Map();
  constructor(
    private readonly height: () => number,
    private readonly choose: (agent: AgentActivity) => void,
    private readonly dismiss: () => void,
    private readonly repaint: () => void,
    private readonly store: ActivityStore = activityStore,
    selected?: string,
    private readonly theme?: ThemeLike,
  ) {
    this.#selected = selected;
  }
  invalidate(): void {}
  get selectedKey(): string | undefined {
    return this.#selected;
  }
  scrollDetailsBy(lines: number): void {
    if (lines === 0) return;
    // Pi has no primary ScrollView for this split layout and can report a one-line page delta.
    const step = Math.sign(lines) * (Math.abs(lines) === 1 ? this.#detailPageSize : Math.abs(lines));
    this.#detailOffset = Math.max(0, this.#detailOffset + step);
    this.#focus = "details";
    this.repaint();
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
      this.dismiss();
      return;
    }
    if (matchesKey(data, "left")) {
      if (this.#focus === "details") this.#focus = "tree";
      else {
        this.dismiss();
        return;
      }
    } else if (matchesKey(data, "tab")) this.#focus = this.#focus === "tree" ? "details" : "tree";
    else if (matchesKey(data, "right")) this.#focus = "details";
    else if (matchesKey(data, "p") || matchesKey(data, "shift+p") || data === "P" || data === "з" || data === "З") {
      this.#fullPaths = !this.#fullPaths;
      this.#detailOffset = 0;
    } else if (matchesKey(data, "pageDown")) this.scrollDetailsBy(this.#detailPageSize);
    else if (matchesKey(data, "pageUp")) this.scrollDetailsBy(-this.#detailPageSize);
    else if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const delta = matchesKey(data, "up") ? -1 : 1;
      if (this.#focus === "details") this.#detailOffset = Math.max(0, this.#detailOffset + delta);
      else {
        const rows = commandCenterRows(this.store, this.#projects).filter((row) => row.kind !== "gap");
        const index = rows.findIndex((row) => row.key === this.#selected);
        this.#selected = rows[(index + delta + rows.length) % rows.length]?.key;
        this.#detailOffset = 0;
      }
      this.#notice = "";
    } else if (matchesKey(data, "enter")) {
      const row = commandCenterRows(this.store, this.#projects).find((candidate) => candidate.key === this.#selected);
      if (row?.agent) this.choose(row.agent);
      else if (row) this.#focus = "details";
      else this.#notice = "Selection no longer available. Choose another row.";
    }
    this.repaint();
  }
  render(width: number): string[] {
    const safeWidth = Math.max(1, width),
      height = Math.max(5, this.height());
    const rows = commandCenterRows(this.store, this.#projects);
    if (this.#selected === undefined)
      this.#selected = rows.find((r) => r.kind === "workflow" || r.kind === "agent")?.key ?? rows[0]?.key;
    const selected = rows.find((row) => row.key === this.#selected);
    const contentHeight = Math.max(1, height - 8);
    this.#detailPageSize = contentHeight;
    const selectedIndex = rows.findIndex((row) => row.key === this.#selected);
    if (selectedIndex >= 0) {
      if (selectedIndex < this.#offset) this.#offset = selectedIndex;
      if (selectedIndex >= this.#offset + contentHeight) this.#offset = selectedIndex - contentHeight + 1;
    }
    this.#offset = Math.min(this.#offset, Math.max(0, rows.length - contentHeight));
    // Both panes need a useful 56 columns; otherwise Tab selects the full-width pane.
    const split = safeWidth >= 2 * 56 + 3;
    const leftWidth = split ? Math.floor((safeWidth - 3) / 2) : safeWidth;
    const rightWidth = split ? Math.max(1, safeWidth - leftWidth - 3) : safeWidth;
    const statusWidth = leftWidth >= 35 ? 11 : 0;
    const nameWidth = leftWidth - statusWidth - (statusWidth ? 1 : 0);
    const details = this.details(selected, rightWidth).flatMap((line) => wrapTextWithAnsi(line, rightWidth));
    this.#detailOffset = Math.min(this.#detailOffset, Math.max(0, details.length - contentHeight));
    const counts = commandCenterCounts([...this.store.agents.values()]);
    const detailTitle = selected?.projectPath
      ? "Project Details"
      : selected?.workflow
        ? "Workflow Details"
        : "Agent Details";
    const treeHeading = (this.#focus === "tree" ? "› " : "  ") + "Agents / Workflows";
    const detailHeading = (this.#focus === "details" ? "› " : "  ") + detailTitle;
    const treeTitle =
      pad(violet(truncateToWidth(treeHeading, nameWidth)), nameWidth) +
      (statusWidth ? quiet(pad("Status", statusWidth + 1)) : "");
    const output = [
      truncateToWidth(violet("Agents Command Center"), safeWidth),
      truncateToWidth(
        quiet(`Known sessions ${counts.sessions} · Open ${counts.active} · Closed ${counts.inactive}`),
        safeWidth,
      ),
      truncateToWidth(quiet(`Executions ${counts.executions} · Running ${counts.running}`), safeWidth),
      violet("─".repeat(safeWidth)),
      split
        ? treeTitle + violet(" │ ") + violet(truncateToWidth(detailHeading, rightWidth))
        : this.#focus === "details"
          ? violet(truncateToWidth(detailHeading, safeWidth))
          : treeTitle,
    ];
    for (let i = 0; i < contentHeight; i++) {
      const row = rows[this.#offset + i];
      let left = "";
      if (row && row.kind !== "gap") {
        const selectedRow = row.key === this.#selected;
        const prefix = (row.branch ?? "") + (selectedRow ? "▸ " : "  ");
        const available = Math.max(1, nameWidth - visibleWidth(prefix));
        const label = row.projectPath
          ? `Project: ${path.basename(row.projectPath) || row.projectPath}`
          : row.agent
            ? `${row.agent.row.displayName ?? row.agent.row.agentName ?? "agent"} — ${row.agent.row.title ?? row.agent.row.request ?? row.agent.row.label}`
            : compactWorkflowPath(row.workflow!.sourcePath, row.workflow!.projectRoot, available);
        const name = truncateToWidth(clean(label).replace(/\s*\n\s*/g, " "), available);
        const state = row.agent
          ? agentActivityLabel(row.agent).replace("inactive · history", "inactive")
          : row.workflow
            ? workflowActivityLabel(row.workflow)
            : "";
        left =
          pad(quiet(prefix) + (row.projectPath || row.workflow ? quiet(name) : name), nameWidth) +
          (statusWidth ? " " + statusColor(truncateToWidth(state, statusWidth)) : "");
        left = pad(truncateToWidth(left, leftWidth), leftWidth);
        if (selectedRow) left = this.theme?.bg?.("userMessageBg", left) ?? `\x1b[48;2;38;34;48m${left}\x1b[49m`;
      } else if (!rows.length && i === 0) left = quiet("No agent sessions or workflows yet.");
      left = pad(truncateToWidth(left, leftWidth), leftWidth);
      const right = details[this.#detailOffset + i] ?? "";
      output.push(split ? `${left}${violet(" │ ")}${right}` : this.#focus === "details" ? right : left);
    }
    output.push(violet("─".repeat(safeWidth)));
    const enter = !selected
      ? "No selection"
      : selected.agent
        ? `Enter ${selected.agent.current ? "session" : "history"}`
        : "Enter details";
    const arrows = this.#focus === "tree" ? "select" : "scroll";
    const controls =
      [
        `Tab panel · ↑↓ ${arrows} · ${enter} · P/З paths · PgUp/PgDn scroll · Esc back`,
        `Tab · ↑↓ ${arrows} · ${enter} · P/З paths · Esc back`,
        `Tab · ↑↓ · ${enter} · P/З paths · Esc back`,
        `Tab · ${enter} · P/З paths · Esc`,
      ].find((line) => visibleWidth(line) <= safeWidth) ??
      (selected ? "Tab · Enter · P/З paths · Esc" : "No selection · Esc");
    output.push(truncateToWidth(quiet(this.#notice || controls), safeWidth));
    const end = Math.min(details.length, this.#detailOffset + contentHeight);
    output.push(
      truncateToWidth(
        quiet(
          `Focus: ${this.#focus} · Paths: ${this.#fullPaths ? "full" : "short"} · Details ${details.length ? this.#detailOffset + 1 : 0}–${end}/${details.length}`,
        ),
        safeWidth,
      ),
    );
    return output;
  }
  private details(row: CenterRow | undefined, width: number): string[] {
    const field = (name: string, value: string) => quiet(name + ": ") + clean(value);
    const showPath = (value: string, launchRoot: string) =>
      clean(this.#fullPaths ? value : contextPath(value, launchRoot, Math.max(8, width - 18), this.#projects));
    const context = (launchRoot: string, cwd?: string) => {
      const repository = repositoryRoot(launchRoot, this.#projects);
      return [
        field(repository ? "Repository" : "Project directory", showPath(repository ?? launchRoot, launchRoot)),
        field("Launch directory", showPath(launchRoot, launchRoot)),
        ...(cwd === undefined
          ? []
          : [
              field(
                "Working directory",
                !this.#fullPaths && cwd === launchRoot ? "same as launch" : showPath(cwd, launchRoot),
              ),
            ]),
      ];
    };
    if (row?.projectPath)
      return [
        `Project: ${clean(path.basename(row.projectPath) || row.projectPath)}`,
        "",
        field(
          row.repositoryRoot ? "Repository" : "Project directory",
          showPath(row.projectPath, row.launchRoots?.[0] ?? row.projectPath),
        ),
        field("Known sessions", row.counts ?? "unavailable"),
        "",
        quiet(`Launch directories (${row.launchRoots?.length ?? 0})`),
        ...(row.launchRoots ?? []).map((root) => showPath(root, root)),
      ];
    if (row?.agent) {
      const a = row.agent,
        launchRoot = a.row.projectRoot ?? "Project unknown";
      const workflow = a.row.workflowRunId ? this.store.workflows.get(a.row.workflowRunId) : undefined;
      const cwd = a.display.cwd ?? a.row.currentPath ?? "unknown";
      const last = clean(a.row.latestMessage ?? a.row.finalAnswer ?? "No message yet");
      return [
        clean(`${a.row.displayName ?? a.row.agentName ?? "Agent"} — ${a.row.title ?? a.row.label}`),
        "",
        quiet("Activity: ") + statusColor(agentActivityLabel(a)),
        field("Model", a.display.model ?? (a.row.modelConfirmed ? a.row.model : undefined) ?? "unknown"),
        field("Reasoning", a.display.thinking ?? (a.row.modelConfirmed ? a.row.thinking : undefined) ?? "unknown"),
        "",
        ...context(launchRoot, cwd),
        ...(workflow
          ? [
              field(
                "Source",
                this.#fullPaths
                  ? path.resolve(workflow.projectRoot, workflow.sourcePath)
                  : compactWorkflowPath(workflow.sourcePath, workflow.projectRoot, Math.max(8, width - 8)),
              ),
              field("Run ID", workflow.runId),
            ]
          : []),
        ...(a.row.errors.length ? ["", quiet("Diagnostics"), ...a.row.errors.map(clean)] : []),
        ...(a.row.resultArtifact ? [field("Result artifact", showPath(a.row.resultArtifact, launchRoot))] : []),
        ...(a.row.errorLogPath ? [field("Error index", showPath(a.row.errorLogPath, launchRoot))] : []),
        ...(a.current ? [] : ["", quiet("Historical snapshot · read-only · no implicit resume")]),
        "",
        quiet("Last message"),
        last,
        "",
        quiet("Launch prompt"),
        clean(a.row.request ?? a.display.task ?? "Unavailable"),
      ];
    }
    if (row?.workflow)
      return [
        compactWorkflowPath(row.workflow.sourcePath, row.workflow.projectRoot, width),
        "",
        quiet("Activity: ") + statusColor(workflowActivityLabel(row.workflow)),
        ...(row.workflow.phase
          ? [field(row.workflow.status === "running" ? "Phase" : "Last phase", row.workflow.phase)]
          : []),
        ...(row.workflow.status === "awaiting_operator" ? [field("Run outcome", "awaiting operator")] : []),
        ...context(row.workflow.projectRoot),
        field(
          "Source",
          this.#fullPaths
            ? path.resolve(row.workflow.projectRoot, row.workflow.sourcePath)
            : compactWorkflowPath(row.workflow.sourcePath, row.workflow.projectRoot, Math.max(8, width - 8)),
        ),
        field("Run ID", row.workflow.runId),
        "",
        quiet("Select an agent in the tree to open its session."),
      ];
    return [quiet("Select a project, workflow or agent.")];
  }
}
