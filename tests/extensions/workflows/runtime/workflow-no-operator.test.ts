import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkflowOperatorHandoff } from "../../../../extensions/workflows/runtime/workflow-handoff.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  WORKFLOW_NO_OPERATOR_HEADLESS_PRELUDE,
  WORKFLOW_NO_OPERATOR_PRELUDE,
  workflowOperatorInputForbiddenError,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";

/**
 * T-165 — run-level no-operator mode, runner level.
 *
 * The mode is one guarantee about one run: no request for operator input can
 * park it. `awaitOperator` under the mode fails the run closed at the call
 * site with a named reason and NO pause envelope; the same fixture without the
 * mode still parks exactly as before; a saved child inherits the mode through
 * run coordination and cannot drop it; and artifacts published before the
 * refusal survive it — the workspace outlives the failed run.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-no-operator-"));
  roots.push(root);
  const workflows = path.join(root, ".locus-pi", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    path.join(workflows, "asking.workflow.mjs"),
    `export default async function run(dsl) {
  dsl.publishArtifact("intent.md", "published before the operator gate");
  dsl.awaitOperator({ reason: "review clarification required" });
  return { mode: "prepared" };
}
`,
    "utf8",
  );
  writeFileSync(
    path.join(workflows, "asking-parent.workflow.mjs"),
    `export default (dsl) => dsl.invokeWorkflow({
  name: "asking",
  key: "child-ask",
  keys: ["child-ask"],
  outputDir: dsl.outputDir(),
});
`,
    "utf8",
  );
  return root;
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) return path.join(entry.parentPath, entry.name);
  }
  return undefined;
}

describe("workflow run-level no-operator mode", () => {
  it("fails the run closed with a named reason, no pause envelope, and live artifacts", async () => {
    const root = project();
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "asking",
      noOperator: true,
    });
    expect(result.ok).toBe(false);
    expect(result.disposition).toEqual({ status: "failed" });
    const named = workflowOperatorInputForbiddenError("review clarification required");
    expect(result.error).toContain(named);
    // No pause envelope of any kind: not on the result, not in the projection.
    expect(result).not.toHaveProperty("operatorHandoff");
    expect(readWorkflowOperatorHandoff(result)).toEqual({ status: "absent" });
    // The mode is durable run evidence: prelude line plus the refusal itself.
    const journalMessages = result.journal.filter((line) => line.kind === "log").map((line) => line.message ?? "");
    expect(journalMessages).toContain(WORKFLOW_NO_OPERATOR_PRELUDE);
    expect(journalMessages.some((message) => message.includes(named))).toBe(true);
    // The artifact published before the refusal survives the failed run.
    const artifact = findFile(root, "intent.md");
    expect(artifact).toBeDefined();
    expect(readFileSync(artifact!, "utf8")).toContain("published before the operator gate");
  });

  it("keeps the pause behavior byte-identical when the mode is off", async () => {
    const root = project();
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "asking",
    });
    expect(result.ok).toBe(true);
    expect(result.disposition).toEqual({ status: "awaiting_operator", detail: "review clarification required" });
    expect(result.journal.map((line) => line.message)).not.toContain(WORKFLOW_NO_OPERATOR_PRELUDE);
  });

  it("propagates the mode into a saved child, which fails closed with the same named reason", async () => {
    const root = project();
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "asking-parent",
      outputDir: "outputs/no-operator-child",
      noOperator: true,
    });
    // The child's refusal fails the parent too: invokeWorkflow has no
    // completed-result shape for a failed child, and the mode gives the child
    // no way back to the operator.
    expect(result.ok).toBe(false);
    expect(result.childRuns).toEqual([expect.objectContaining({ status: "failed", key: "child-ask" })]);
    const childRunDir = result.childRuns![0]!.runDir!;
    const childResult = JSON.parse(readFileSync(path.join(childRunDir, "runtime", "result.json"), "utf8")) as {
      error?: string;
      operatorHandoff?: unknown;
    };
    const named = workflowOperatorInputForbiddenError("review clarification required");
    expect(childResult.error).toContain(named);
    expect(childResult.operatorHandoff).toBeUndefined();
    // Inheritance is visible in the child's own durable journal: the prelude
    // line is there even though the child was never launched with the option.
    const childJournal = readFileSync(path.join(childRunDir, "runtime", "journal.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: string });
    expect(childJournal.some((line) => line.message === WORKFLOW_NO_OPERATOR_PRELUDE)).toBe(true);
    expect(existsSync(childRunDir)).toBe(true);
  });

  // T-168 — the headless default is resolved by the launch surfaces, so the
  // runner keeps two obligations of its own: explain the mode to a reader who
  // typed no flag, and never assume it.
  it("names the headless launch in the journal so a refusal without a flag is explicable", async () => {
    const root = project();
    const harness = createHarness(root, { mode: "print" });
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "asking",
      noOperator: true,
    });
    expect(result.ok).toBe(false);
    const journalMessages = result.journal.filter((line) => line.kind === "log").map((line) => line.message ?? "");
    expect(journalMessages).toContain(WORKFLOW_NO_OPERATOR_HEADLESS_PRELUDE);
    expect(WORKFLOW_NO_OPERATOR_HEADLESS_PRELUDE).toContain("headless launch");
  });

  it("does not infer the mode from a headless host: an embedder opts in itself", async () => {
    const root = project();
    const harness = createHarness(root, { mode: "print" });
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "asking",
    });
    expect(result.ok).toBe(true);
    expect(result.disposition).toEqual({ status: "awaiting_operator", detail: "review clarification required" });
    expect(result.journal.map((line) => line.message)).not.toContain(WORKFLOW_NO_OPERATOR_HEADLESS_PRELUDE);
  });
});
