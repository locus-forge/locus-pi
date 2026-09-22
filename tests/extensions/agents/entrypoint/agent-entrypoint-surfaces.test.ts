/**
 * Characterization tests for the `extensions/agents` entrypoint zones that had no
 * coverage before T-126 W2 split them into submodules: the spawn-tool approval
 * details, the fleet-menu close notification,
 * the bounded observer widget, and the loop-round submenu config the drill builds
 * from a run journal. Written and seen green against the unmodified entrypoint.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  ensureWorkflowRunDir,
  workflowJournalFile,
  workflowRunDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import type { ExtensionCommandContext } from "../../../../extensions/_shared/host/pi-api.js";
import { createHarness, emit, runTool } from "../../../test-harness.js";

const tempRoots: string[] = [];

afterEach(() => {
  agentLiveStore.reset();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("spawn tool approval details", () => {
  it("names the requested agent and the single-task bound on the canonical spawn surface", () => {
    const h = createHarness();
    agents(h.pi);

    const format = h.tools.get("spawn_agent")?.formatApprovalDetails;
    expect(format).toBeTypeOf("function");
    expect(format!({ agent: "reviewer", task: "Review" })).toEqual(["Agent: reviewer", "Tasks: 1"]);
    expect(format!({ task: "Review" })).toEqual(["Agent: bare", "Tasks: 1"]);
    expect(format!(undefined)).toEqual(["Agent: bare", "Tasks: 1"]);
    expect(h.tools.has("task")).toBe(false);
    expect(h.tools.has("locus_workload_proof")).toBe(false);
  });
});

describe("fleet menu close", () => {
  it("says how many agents keep running when the operator closes the menu", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    agentLiveStore.begin({ id: "fleet-working", agentName: "reviewer", label: "Review one" });
    agentLiveStore.patch("fleet-working", { status: "working" });
    agentLiveStore.begin({ id: "fleet-queued", agentName: "reviewer", label: "Review two" });
    h.customInputQueue.push("escape");

    await h.commands.get("ps")!.handler("", h.ctx as ExtensionCommandContext);

    expect(h.notifications).toContain("Agent menu closed. 2 agents continue running.");
  });

  it("stays silent about continuing work when every row is terminal", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    agentLiveStore.begin({ id: "fleet-done", agentName: "reviewer", label: "Review done" });
    agentLiveStore.patch("fleet-done", { status: "done" });
    h.customInputQueue.push("escape");

    await h.commands.get("ps")!.handler("", h.ctx as ExtensionCommandContext);

    expect(h.notifications.some((line) => line.startsWith("Agent menu closed."))).toBe(false);
  });
});

describe("bounded agents text widget", () => {
  it("renders the whole observer digest and clips each line to the fallback width", async () => {
    const h = createHarness(undefined, { mode: "rpc" });
    for (let index = 0; index < 12; index += 1) {
      agentLiveStore.begin({ id: `bounded-${index}`, agentName: `agent${index}`, label: "L".repeat(200) });
      agentLiveStore.patch(`bounded-${index}`, { status: "working", startedAt: 1000, elapsedMs: 10 });
    }
    agents(h.pi);

    await h.commands.get("agent")!.handler("observe", h.ctx as ExtensionCommandContext);

    const lines = (h.widgets.get("agents") ?? "").split("\n");
    // The observer digest is already bounded to two rows (six lines) plus a
    // header, a counts line, and the hidden-row remainder — nine lines, which is
    // under the widget's own ten-line budget, so nothing is dropped here.
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toBe("more: 10 row(s) not shown");
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.some((line) => line.endsWith("..."))).toBe(true);
    expect(h.widgetOptions.get("agents")).toEqual({ placement: "belowEditor" });
  });
});

describe("drill rounds submenu", () => {
  function writeRoundsJournal(root: string, runId: string, slotKey: string): void {
    const runDir = ensureWorkflowRunDir(root, runId);
    const lines = [
      { ts: "1", runId, kind: "agent_start", agent: "reviewer", label: "verify fix", phase: "verify", slotKey },
      {
        ts: "2",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "verify fix",
        phase: "verify",
        slotKey,
        round: 1,
        status: "completed",
        durationMs: 1200,
      },
      {
        ts: "3",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "verify fix",
        phase: "verify",
        slotKey,
        round: 2,
        status: "completed",
        durationMs: 900,
      },
    ];
    writeFileSync(workflowJournalFile(runDir), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  }

  it("offers the journal rounds for a slotted workflow row", async () => {
    const root = tempRoot("locus-agents-drill-rounds-");
    const runId = "20260726-000000-abcd";
    const slotKey = "verifyverify fix";
    writeRoundsJournal(root, runId, slotKey);
    const rowId = `workflow-agent:${runId}:reviewer:verify fix:verify`;
    agentLiveStore.begin({ id: rowId, agentName: "reviewer", label: "verify fix", slotKey, round: 2 });
    agentLiveStore.patch(rowId, { status: "working" });
    const h = createHarness(root);
    h.ctx.hasUI = true;
    h.customInputQueue.push("escape");
    agents(h.pi);

    await h.commands.get("ps")!.handler(rowId, h.ctx as ExtensionCommandContext);

    const header = h.customRenderFrames[0]?.[0] ?? "";
    expect(header).toContain("rounds: 1 [2]");
  });

  it("hides the switcher when the row is not slotted", async () => {
    const root = tempRoot("locus-agents-drill-no-rounds-");
    agentLiveStore.begin({ id: "plain-row", agentName: "reviewer", label: "plain work" });
    agentLiveStore.patch("plain-row", { status: "working" });
    const h = createHarness(root);
    h.ctx.hasUI = true;
    h.customInputQueue.push("escape");
    agents(h.pi);

    await h.commands.get("ps")!.handler("plain-row", h.ctx as ExtensionCommandContext);

    const header = h.customRenderFrames[0]?.[0] ?? "";
    expect(header).not.toContain("rounds:");
  });
});
