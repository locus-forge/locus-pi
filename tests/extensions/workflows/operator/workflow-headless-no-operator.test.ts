import { describe, expect, it, vi } from "vitest";
import workflows from "../../../../extensions/workflows/index.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";

/**
 * T-168 — headless launches default to the no-operator mode.
 *
 * A `print`/`json` host has no operator to reach: a request for human input
 * there can only park the run until the turn is disposed. Both launch
 * surfaces therefore turn the T-165 mode on by default in those modes, and
 * both keep an explicit opt-out (`--operator`, `noOperator: false`) so the
 * designed `awaitOperator` split-run pause stays reachable. Interactive hosts
 * are untouched: there, the mode is still opt-in.
 *
 * The resolution is asserted where it is made — on the request the launch
 * surface hands to the runner — so no test depends on a fixture workflow
 * choosing to ask.
 */

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await Promise.resolve();
}

function completedRun(runId: string): runner.RunWorkflowScriptResult {
  return {
    runId,
    runDir: `/tmp/${runId}`,
    ok: true,
    result: null,
    journal: [],
    resultPersistence: { ok: true, path: `/tmp/${runId}/result.json` },
  };
}

/** Run one `/workflows run` line and return the request the runner received. */
async function runCommand(
  mode: "tui" | "rpc" | "json" | "print",
  line: string,
): Promise<Parameters<typeof runner.runWorkflowScript>[0] | undefined> {
  const harness = createHarness(`/tmp/workflow-headless-${mode}-${Date.now()}`, { mode });
  workflows(harness.pi);
  let request: Parameters<typeof runner.runWorkflowScript>[0] | undefined;
  const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (candidate) => {
    request = candidate;
    candidate.onRunStart?.({ runId: "headless-run", runDir: "/tmp/headless-run" });
    return completedRun("headless-run");
  });
  try {
    await harness.commands.get("workflows")!.handler(line, harness.ctx);
    await waitFor(() => request !== undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    return request;
  } finally {
    spy.mockRestore();
  }
}

/** Execute the `workflow` tool once and return the request the runner received. */
async function runTool(
  mode: "tui" | "rpc" | "json" | "print",
  args: Record<string, unknown>,
): Promise<Parameters<typeof runner.runWorkflowScript>[0] | undefined> {
  const harness = createHarness(`/tmp/workflow-headless-tool-${mode}-${Date.now()}`, { mode });
  workflows(harness.pi);
  let request: Parameters<typeof runner.runWorkflowScript>[0] | undefined;
  const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (candidate) => {
    request = candidate;
    candidate.onRunStart?.({ runId: "headless-tool-run", runDir: "/tmp/headless-tool-run" });
    return completedRun("headless-tool-run");
  });
  try {
    await harness.tools
      .get("workflow")!
      .execute("tool-call", args, new AbortController().signal, () => void 0, harness.ctx);
    await waitFor(() => request !== undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    return request;
  } finally {
    spy.mockRestore();
  }
}

describe("headless launches default to the no-operator mode", () => {
  it("turns the mode on for a bare /workflows run in print and json", async () => {
    expect((await runCommand("print", "run live-smoke"))?.noOperator).toBe(true);
    expect((await runCommand("json", "run live-smoke"))?.noOperator).toBe(true);
  });

  it("keeps the operator gate reachable in headless through --operator", async () => {
    // The opt-out is what keeps the designed split-run pause available to a
    // headless caller that continues the run later.
    expect((await runCommand("print", "run live-smoke --operator"))?.noOperator).toBeUndefined();
    expect((await runCommand("json", "run live-smoke --operator"))?.noOperator).toBeUndefined();
  });

  it("leaves interactive hosts opt-in, in both directions", async () => {
    expect((await runCommand("tui", "run live-smoke"))?.noOperator).toBeUndefined();
    expect((await runCommand("rpc", "run live-smoke"))?.noOperator).toBeUndefined();
    expect((await runCommand("tui", "run live-smoke --no-operator"))?.noOperator).toBe(true);
  });

  it("applies the same default and opt-out to the programmatic workflow tool", async () => {
    expect((await runTool("print", { name: "live-smoke" }))?.noOperator).toBe(true);
    expect((await runTool("print", { name: "live-smoke", noOperator: false }))?.noOperator).toBeUndefined();
    expect((await runTool("tui", { name: "live-smoke" }))?.noOperator).toBeUndefined();
    expect((await runTool("tui", { name: "live-smoke", noOperator: true }))?.noOperator).toBe(true);
  });
});
