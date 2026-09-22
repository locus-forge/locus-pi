import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerWorkflowTool } from "../../../../extensions/workflows/tool/workflow-tool.js";
import type { WorkflowCommandLauncher } from "../../../../extensions/workflows/launch/workflow-command-launcher.js";
import { createHarness, runTool, type Harness } from "../../../test-harness.js";

/**
 * What the `workflow` tool's own schema still declares, and what it no longer does.
 *
 * Two claims, both about the tool surface rather than the runtime: a removed budget
 * option is answered by NAME, and a continuation carries as many complete artifact
 * refs as its origin run produced.
 *
 * A removed budget option, answered by NAME at the tool surface.
 *
 * The runtime has one sentence per removed key saying what replaced it. The tool
 * schema is a second door into the same object and its key set is closed, so
 * `budget: { answerChars: 4000 }` used to come back as "unexpected property
 * answerChars" — true, and useless to the caller, who is left believing the option
 * exists but was mistyped. Both doors now give the same sentence.
 */

/** The refusal returns before anything is launched, so the launcher is never used. */
const IDLE_LAUNCHER = {
  currentLease: () => ({}) as never,
  attach: () => {
    throw new Error("no run should be launched by a refused call");
  },
} as unknown as WorkflowCommandLauncher;

function toolHarness(): Harness {
  const h = createHarness(mkdtempSync(path.join(tmpdir(), "workflow-tool-removed-budget-")));
  registerWorkflowTool(h.pi, {
    commandLauncher: IDLE_LAUNCHER,
    onRunStarted: () => {},
    onRunCompleted: () => {},
  });
  return h;
}

describe("workflow tool: removed budget options", () => {
  it("shows only declared budget overrides before the host policy is resolved", () => {
    const h = toolHarness();
    const details =
      h.tools.get("workflow")!.formatApprovalDetails?.({ name: "live-smoke", budget: { turns: 7 } }) ?? [];
    expect(details).toContain("Budget overrides: turns=7; other axes use launch defaults");
    expect(String(details)).not.toContain("totalAgents=unbounded");
  });

  it("names answerChars and the contract to declare instead", async () => {
    const result = await runTool(toolHarness(), "workflow", {
      name: "any",
      budget: { answerChars: 4_000 },
    });

    const text = result.content?.map((part) => (part as { text?: string }).text ?? "").join("\n") ?? "";
    expect(result.isError).toBe(true);
    expect(text).toContain("answerChars was removed");
    expect(text).toContain("no longer bounds the SIZE of an answer");
    expect(text).toContain("output.maxLength");
    // Not the schema's generic complaint.
    expect(text).not.toMatch(/unexpected|additional propert/iu);
  });

  it("names a renamed option with its replacement axis", async () => {
    const result = await runTool(toolHarness(), "workflow", {
      name: "any",
      budget: { maxTotalAgentInvocations: 10 },
    });

    const text = result.content?.map((part) => (part as { text?: string }).text ?? "").join("\n") ?? "";
    expect(result.isError).toBe(true);
    expect(text).toContain("maxTotalAgentInvocations was removed");
    expect(text).toContain("budget.totalAgents");
  });

  it("leaves a live axis alone, so the check is about removed keys and nothing else", async () => {
    // Two targets is the NEXT refusal on this path. Reaching it proves the budget
    // check passed a declared axis through instead of swallowing the call.
    const result = await runTool(toolHarness(), "workflow", {
      name: "any",
      scriptPath: "also/here.workflow.mjs",
      budget: { totalAgents: 10 },
    });

    const text = result.content?.map((part) => (part as { text?: string }).text ?? "").join("\n") ?? "";
    expect(text).toContain("exactly one of name, scriptPath, or script");
  });
});

describe("workflow tool: continuation artifact refs", () => {
  it("accepts more than the eight refs the schema used to cap, and still demands one", async () => {
    const refs = Array.from({ length: 13 }, (_, index) => ({
      runId: "20260912-090000-origin",
      artifactId: `artifact-${String(index + 1).padStart(2, "0")}`,
      name: `note-${index + 1}.md`,
      sha256: String(index + 1)
        .repeat(64)
        .slice(0, 64),
    }));

    // Two targets is the NEXT refusal on this path. Reaching it proves all thirteen
    // refs passed the schema: a `maxItems` would have refused before it.
    const accepted = await runTool(toolHarness(), "workflow", {
      name: "any",
      scriptPath: "also/here.workflow.mjs",
      continuation: { originRunId: "20260912-090000-origin", artifactRefs: refs },
    });
    const acceptedText = accepted.content?.map((part) => (part as { text?: string }).text ?? "").join("\n") ?? "";
    expect(acceptedText).toContain("exactly one of name, scriptPath, or script");

    // The lower bound is a real contract and stays: a continuation with no reference
    // continues nothing.
    const empty = await runTool(toolHarness(), "workflow", {
      name: "any",
      continuation: { originRunId: "20260912-090000-origin", artifactRefs: [] },
    });
    expect(empty.isError).toBe(true);
  });
});
