import { describe, expect, it, vi } from "vitest";
import runPlanWorkflow from "../../../../../examples/workflows/task/plan.workflow.mjs";

type Call = { label: string; prompt: string };

function capacityRun(repaired: boolean, narrative = false) {
  const calls: Call[] = [];
  const publishPrimaryFile = vi.fn(() => ({ relativePath: "workflow.mjs" }));
  const early = ["context", "implementation", "review", "choice"];
  const lateProposal = ["review route", "single correction", "recheck route"];
  const lateRepair = narrative
    ? ["Reconciled five items in the workspace queue report"]
    : repaired
      ? ["review route + single correction", "recheck route"]
      : lateProposal;
  const queues: Record<string, unknown[]> = {
    "workflow-design": ["Design ledger"],
    "workflow-design-review": ["Reviewed design ledger"],
    "workflow-source-seed": ["Seed report"],
    "workflow-source-seed-check": ["Seed passed"],
    "workflow-source-seed-route": ["passed"],
    "workflow-source-cut": [...early.map((name) => [name]), lateProposal, ...(repaired ? [["recheck route"], []] : [])],
    "workflow-source-queue-assessment": [
      ...early.map(() => "Queue valid"),
      "Three identities exceed two remaining slots; group adjacent routes",
      ...(repaired ? ["Queue valid", "Whole graph complete"] : []),
    ],
    "workflow-source-queue-route": [
      ...early.map(() => "work"),
      "queue_conflict",
      ...(repaired ? ["work", "complete"] : []),
    ],
    "workflow-source-queue-repair": [
      ...early.map((name) => [name]),
      lateRepair,
      ...(repaired ? [["recheck route"], []] : []),
    ],
    "workflow-source-queue-recheck": [
      ...early.map(() => "Queue valid"),
      narrative
        ? "Returned member is only a narrative summary"
        : repaired
          ? "All identities retained in two edits"
          : "Capacity conflict remains",
      ...(repaired ? ["Queue valid", "Whole graph complete"] : []),
    ],
    "workflow-source-queue-recheck-route": [
      ...early.map(() => "work"),
      repaired ? "work" : "queue_conflict",
      ...(repaired ? ["work", "complete"] : []),
    ],
    "workflow-source-slice": Array(6).fill("Source edit complete"),
    "workflow-source-check": Array(6).fill("Mechanical check passed"),
    "workflow-source-check-route": Array(6).fill("passed"),
    "workflow-source-review": Array(6).fill("Slice design accepted"),
    "workflow-source-review-route": Array(6).fill("accept"),
    "workflow-source-final-check": ["Final mechanical check passed"],
    "workflow-source-final-check-route": ["passed"],
    "workflow-source-final-review": ["Whole graph conforms"],
    "workflow-source-final-route": ["publish"],
  };
  const dsl = {
    phase: () => undefined,
    publishPrimaryFile,
    agent: async (prompt: string, options: { label: string }) => {
      calls.push({ label: options.label, prompt });
      const queue = queues[options.label];
      if (!queue?.length) throw new Error(`No answer for ${options.label}`);
      return queue.shift();
    },
  };
  return {
    calls,
    publishPrimaryFile,
    run: () => runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], "Accepted draft"),
  };
}

describe("task/plan late source-queue capacity", () => {
  it("carries exact remaining slots to each queue gate and groups adjacent identities", async () => {
    const fixture = capacityRun(true);
    await expect(fixture.run()).resolves.toMatchObject({ relativePath: "workflow.mjs" });
    for (const label of [
      "workflow-source-queue-assessment",
      "workflow-source-queue-repair",
      "workflow-source-queue-recheck",
    ]) {
      expect(fixture.calls.filter((call) => call.label === label)[4]?.prompt).toContain(
        "Accepted source slices: 4; remaining source-slice slots: 2 of 6",
      );
    }
    const groupedSlice = fixture.calls.filter((call) => call.label === "workflow-source-slice")[4]?.prompt;
    expect(groupedSlice).toContain("review route + single correction");
    expect(groupedSlice).toContain("Implement only the graph identities and connecting edges explicitly named");
    expect(groupedSlice).toContain('choice: ["passed", "failed"]');
    expect(groupedSlice).toContain("dsl.publishArtifact");
    expect(groupedSlice).toContain("dsl.publishText is unsupported");
    for (const identity of ["review route", "single correction"]) expect(groupedSlice).toContain(identity);
    expect(fixture.calls.filter((call) => call.label === "workflow-source-slice")).toHaveLength(6);
    expect(fixture.publishPrimaryFile).toHaveBeenCalledOnce();
  });

  it("fails closed with all unmet identities when the capacity conflict survives recheck", async () => {
    const fixture = capacityRun(false);
    await expect(fixture.run()).resolves.toMatchObject({
      ok: false,
      reason: "queue_conflict",
      remaining: ["review route", "single correction", "recheck route"],
    });
    expect(fixture.calls.filter((call) => call.label === "workflow-source-slice")).toHaveLength(4);
    expect(fixture.publishPrimaryFile).not.toHaveBeenCalled();
  });

  it("rejects a narrative queue member that refers to unseen workspace items", async () => {
    const fixture = capacityRun(false, true);
    await expect(fixture.run()).resolves.toMatchObject({
      ok: false,
      reason: "queue_conflict",
      remaining: ["Reconciled five items in the workspace queue report"],
    });
    const recheck = fixture.calls.filter((call) => call.label === "workflow-source-queue-recheck")[4]?.prompt;
    expect(recheck).toContain("Inspect each exact reconciled list member supplied below");
    expect(recheck).toContain("Reject a report, path, or one narrative summary");
    expect(fixture.publishPrimaryFile).not.toHaveBeenCalled();
  });
});
