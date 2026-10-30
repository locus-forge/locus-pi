import { redactSecrets } from "../host/redaction.js";
import { EventEmitter } from "node:events";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { agentLiveStore, type AgentLiveExecutionHandle, type AgentLiveRow } from "./agent-live-store.js";
import type { AgentSessionDisplay } from "./session/state.js";

export interface WorkflowActivity {
  runId: string;
  projectRoot: string;
  sourcePath: string;
  parentRunId?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "awaiting_operator";
}
export interface AgentActivity {
  key: string;
  execution: AgentLiveExecutionHandle;
  row: AgentLiveRow;
  display: AgentSessionDisplay;
  conversation: readonly unknown[];
  current: boolean;
  active: boolean;
}
/** Display evidence only. No cancellation, resume or agent ownership authority. */
export class ActivityStore {
  readonly emitter = new EventEmitter();
  readonly workflows = new Map<string, WorkflowActivity>();
  readonly agents = new Map<string, AgentActivity>();
  readonly #keys = new WeakMap<AgentLiveExecutionHandle, string>();
  #next = 0;
  maxItems = 4;
  constructor() {
    agentLiveStore.emitter.on("change", () => this.capture());
  }
  capture(): void {
    for (const entry of this.agents.values()) {
      entry.current = false;
      entry.active = false;
    }
    for (const row of agentLiveStore.rows.values()) {
      // Journal mirrors describe the same SDK execution, not another session.
      if (row.groupKind !== undefined || row.id.startsWith("workflow:")) continue;
      const execution = agentLiveStore.captureExecutionAuthority(row.id);
      if (execution === undefined) continue;
      let key = this.#keys.get(execution);
      if (key === undefined) {
        key = `session-${++this.#next}`;
        this.#keys.set(execution, key);
      }
      const previous = this.agents.get(key);
      this.agents.set(key, {
        key,
        execution,
        row: { ...row },
        display: { ...agentLiveStore.sessionDisplay(execution) },
        conversation: [...(agentLiveStore.conversation(execution) ?? previous?.conversation ?? [])],
        current: true,
        active:
          row.status === "queued" || row.status === "working" || agentLiveStore.canSendInputForExecution(execution),
      });
    }
    const inactive = [...this.agents.values()].filter((entry) => !entry.active);
    for (const entry of inactive.slice(0, Math.max(0, inactive.length - 200))) this.agents.delete(entry.key);
    this.emitter.emit("change");
  }
  workflow(value: WorkflowActivity): void {
    this.workflows.set(value.runId, { ...value });
    const inactive = [...this.workflows.values()].filter((run) => run.status !== "running");
    for (const run of inactive.slice(0, Math.max(0, inactive.length - 100))) this.workflows.delete(run.runId);
    this.emitter.emit("change");
  }
  settleWorkflow(runId: string, status: WorkflowActivity["status"]): void {
    const run = this.workflows.get(runId);
    if (run !== undefined) this.workflow({ ...run, status });
  }
  setMaxItems(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value > 20)
      throw new Error("activityStrip.maxItems must be an integer from 1 to 20");
    this.maxItems = value;
    this.emitter.emit("change");
  }
}
const KEY = Symbol.for("locus-pi.activity-store.v1");
const globalStore = globalThis as unknown as Record<symbol, ActivityStore | undefined>;
export const activityStore = globalStore[KEY] ?? (globalStore[KEY] = new ActivityStore());

/** Logical work: a workflow represents its descendants once, not one extra row per agent. */
export function activityStripItems(store: ActivityStore = activityStore): { key: string; label: string }[] {
  const workflows = [...store.workflows.values()].filter(
    (run) => run.status === "running" || run.status === "awaiting_operator",
  );
  const visibleRuns = new Set(workflows.map((run) => run.runId));
  const roots: WorkflowActivity[] = [];
  const covered = new Set<string>();
  const cover = (run: WorkflowActivity): void => {
    if (covered.has(run.runId)) return;
    covered.add(run.runId);
    for (const child of workflows.filter((candidate) => candidate.parentRunId === run.runId)) cover(child);
  };
  for (const run of workflows.filter(
    (candidate) => candidate.parentRunId === undefined || !visibleRuns.has(candidate.parentRunId),
  )) {
    roots.push(run);
    cover(run);
  }
  for (const run of workflows)
    if (!covered.has(run.runId)) {
      roots.push(run);
      cover(run);
    }
  return [
    ...roots.map((run) => ({
      key: `workflow:${run.runId}`,
      rank: run.status === "awaiting_operator" ? 0 : 1,
      label: `${run.sourcePath.startsWith(`${run.projectRoot}/`) ? run.sourcePath.slice(run.projectRoot.length + 1) : run.sourcePath} · ${run.status === "awaiting_operator" ? "needs input" : run.status}`,
    })),
    ...[...store.agents.values()]
      .filter(
        (agent) => agent.active && (agent.row.workflowRunId === undefined || !visibleRuns.has(agent.row.workflowRunId)),
      )
      .map((agent) => ({
        key: agent.key,
        rank: agent.row.status === "done" ? 2 : 1,
        label: `${agent.row.displayName ?? agent.row.agentName ?? "agent"} · ${agent.row.status === "done" ? "idle" : agent.row.status}`,
      })),
  ].sort((a, b) => a.rank - b.rank);
}
export function renderActivityStrip(width: number, store: ActivityStore = activityStore): string[] {
  const items = activityStripItems(store);
  if (items.length === 0) return [];
  const lines = items.slice(0, store.maxItems).map((item) => {
    let label = redactSecrets(item.label)
      .text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x1f\x7f]/g, " ");
    if (item.key.startsWith("workflow:")) {
      const separator = label.lastIndexOf(" · ");
      const suffix = separator < 0 ? "" : label.slice(separator);
      const path = separator < 0 ? label : label.slice(0, separator);
      const budget = Math.max(1, width - 4 - visibleWidth(suffix));
      if (visibleWidth(path) > budget) {
        const chars = [...path];
        while (chars.length && visibleWidth(chars.join("")) > budget - 1) chars.shift();
        label = `…${chars.join("")}${suffix}`;
      }
    }
    return truncateToWidth(`  ● ${label}`, width);
  });
  if (items.length > store.maxItems)
    lines.push(truncateToWidth(`  +${items.length - store.maxItems} more · ← Agents Command Center`, width));
  return lines;
}
