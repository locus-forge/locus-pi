import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { workflowJournalFile } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-startup-"));
  roots.push(root);
  const workflows = path.join(root, ".agents", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    path.join(workflows, "startup.workflow.mjs"),
    'export default async function runWorkflow() { return "started"; }\n',
    "utf8",
  );
  return root;
}

describe("workflow startup persistence", () => {
  it("creates the canonical run directory and first journal line before announcing the run", async () => {
    const root = temporaryProject();
    const harness = createHarness(root, { sessionId: "workflow-startup" });
    let announcedRunDir: string | undefined;
    let journalExistedAtAnnouncement = false;
    let journalAtAnnouncement = "";

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      scriptPath: ".agents/workflows/startup.workflow.mjs",
      onRunStart: ({ runDir }) => {
        announcedRunDir = runDir;
        const journalPath = workflowJournalFile(runDir);
        journalExistedAtAnnouncement = existsSync(journalPath);
        journalAtAnnouncement = journalExistedAtAnnouncement ? readFileSync(journalPath, "utf8") : "";
      },
    });

    expect(result.ok).toBe(true);
    expect(announcedRunDir).toBe(result.runDir);
    expect(result.runDir).toBe(path.join(root, ".locus-pi", "runs", result.runId));
    expect(journalExistedAtAnnouncement).toBe(true);
    expect(journalAtAnnouncement).toContain("[workflow:budget]");
  });

  it("does not announce or start a child when the canonical run path is unsafe", async () => {
    const root = temporaryProject();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-startup-outside-"));
    roots.push(outside);
    symlinkSync(outside, path.join(root, ".locus-pi"), "dir");
    const harness = createHarness(root, { sessionId: "workflow-startup-unsafe" });
    let announced = false;
    let childCalls = 0;

    await expect(
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: ".agents/workflows/startup.workflow.mjs",
        onRunStart: () => {
          announced = true;
        },
        createExecutor: () => ({
          async run() {
            childCalls += 1;
            throw new Error("child must not start");
          },
        }),
      }),
    ).rejects.toThrow(/unsafe|symlink/iu);

    expect(announced).toBe(false);
    expect(childCalls).toBe(0);
  });
});
