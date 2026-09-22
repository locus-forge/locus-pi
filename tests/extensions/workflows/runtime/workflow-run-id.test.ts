import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimNewWorkflowRun, workflowJournalFile } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  ensureWorkflowRunDir,
  listWorkflowRunDirectories,
  resolveWorkflowRunDir,
  workflowRunDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";

/**
 * A run id is a second-resolution timestamp plus a 16-bit random suffix, so two
 * runs starting in the same second can mint the same id. The exclusive journal
 * create is the claim; a lost claim must retry with a FRESH id, never crash.
 */

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-run-id-"));
  roots.push(root);
  return root;
}

const sameSecond = () => new Date("2026-08-23T00:02:30.453Z");

function prelude(runId: string): WorkflowJournalLine {
  return { ts: sameSecond().toISOString(), runId, kind: "log", source: "runtime", message: "prelude" };
}

describe("claimNewWorkflowRun", () => {
  it("creates only mandatory runtime state until optional run containers are used", () => {
    const root = temporaryProject();
    const rootRunDir = ensureWorkflowRunDir(root, "lazy-group");

    expect(existsSync(path.join(rootRunDir, "runtime"))).toBe(true);
    expect(existsSync(path.join(rootRunDir, "outputs"))).toBe(false);
    expect(existsSync(path.join(rootRunDir, "children"))).toBe(false);
    expect(existsSync(path.join(rootRunDir, "attempts"))).toBe(false);

    const childRunDir = ensureWorkflowRunDir(root, "lazy-child", {
      storageRootRunId: "lazy-group",
      kind: "child",
    });
    expect(existsSync(path.join(rootRunDir, "children"))).toBe(true);
    expect(existsSync(path.join(rootRunDir, "attempts"))).toBe(false);
    expect(existsSync(path.join(childRunDir, "runtime"))).toBe(true);
    expect(existsSync(path.join(childRunDir, "outputs"))).toBe(false);
  });

  it("preserves global uniqueness across root, child, attempt and group boundaries", () => {
    const root = temporaryProject();
    ensureWorkflowRunDir(root, "group-a");
    ensureWorkflowRunDir(root, "group-b");
    const random = vi.spyOn(Math, "random");
    random.mockReturnValueOnce(0x4560 / 0x10000);
    const first = claimNewWorkflowRun(root, prelude, sameSecond, { storageRootRunId: "group-a", kind: "child" });
    random.mockReturnValueOnce(0x4560 / 0x10000).mockReturnValueOnce(0x4561 / 0x10000);
    const second = claimNewWorkflowRun(root, prelude, sameSecond, { storageRootRunId: "group-b", kind: "attempt" });
    random
      .mockReturnValueOnce(0x4560 / 0x10000)
      .mockReturnValueOnce(0x4561 / 0x10000)
      .mockReturnValueOnce(0x4562 / 0x10000);
    const third = claimNewWorkflowRun(root, prelude, sameSecond);
    expect(new Set([first.runId, second.runId, third.runId]).size).toBe(3);
    for (const run of [first, second, third]) expect(resolveWorkflowRunDir(root, run.runId)).toBe(run.runDir);
    expect(listWorkflowRunDirectories(root)).toHaveLength(5);
  });

  it("serializes competing processes that force the same ID in different locations", async () => {
    const root = temporaryProject();
    ensureWorkflowRunDir(root, "group-a");
    ensureWorkflowRunDir(root, "group-b");
    const moduleUrl = new URL("../../../../extensions/workflows/runtime/workflow-journal.ts", import.meta.url).href;
    const locations = [
      undefined,
      { storageRootRunId: "group-a", kind: "child" },
      { storageRootRunId: "group-a", kind: "attempt" },
      { storageRootRunId: "group-b", kind: "child" },
    ];
    const runs = await Promise.all(
      locations.map(
        (location, index) =>
          new Promise<{ runId: string; runDir: string }>((resolve, reject) => {
            const source = `import { claimNewWorkflowRun } from ${JSON.stringify(moduleUrl)};
        let calls = 0;
        Math.random = () => (++calls === 1 ? 100 : 101 + ${index}) / 65536;
        const claimed = claimNewWorkflowRun(${JSON.stringify(root)}, runId => ({ ts: "2026-09-03T00:00:00Z", runId, kind: "log", source: "runtime", message: "claimed" }), () => new Date("2026-09-03T00:00:00Z"), ${JSON.stringify(location)});
        console.log(JSON.stringify({runId: claimed.runId, runDir: claimed.runDir}));`;
            const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
              stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            let error = "";
            child.stdout.on("data", (bytes) => {
              output += bytes;
            });
            child.stderr.on("data", (bytes) => {
              error += bytes;
            });
            child.on("error", reject);
            child.on("close", (code) => {
              if (code !== 0) return reject(new Error(error));
              try {
                resolve(JSON.parse(output));
              } catch (failure) {
                reject(failure);
              }
            });
          }),
      ),
    );
    expect(new Set(runs.map((run) => run.runId)).size).toBe(4);
    for (const run of runs) {
      expect(resolveWorkflowRunDir(root, run.runId)).toBe(run.runDir);
      expect(readFileSync(workflowJournalFile(run.runDir), "utf8")).toContain(run.runId);
    }
    expect(existsSync(path.join(root, ".locus-pi", "runs", ".run-claim.lock"))).toBe(false);
  });

  it("leaves an interrupted claim lock intact and gives an actionable refusal", () => {
    const root = temporaryProject();
    ensureWorkflowRunDir(root, "retained");
    const lock = path.join(root, ".locus-pi", "runs", ".run-claim.lock");
    writeFileSync(lock, '{"pid":99999999}\n');
    expect(() => claimNewWorkflowRun(root, prelude, sameSecond)).toThrow(/verify the owner has stopped/u);
    expect(readFileSync(lock, "utf8")).toBe('{"pid":99999999}\n');
    expect(listWorkflowRunDirectories(root)).toHaveLength(1);
  });

  it("retries with a fresh id when the minted id is already claimed", () => {
    const root = temporaryProject();
    const random = vi.spyOn(Math, "random");
    random.mockReturnValueOnce(0x4560 / 0x10000);
    const first = claimNewWorkflowRun(root, prelude, sameSecond);
    expect(first.runId).toBe("20260823-000230-4560");

    // The second claim draws the same suffix in the same second, then a fresh one.
    random.mockReturnValueOnce(0x4560 / 0x10000).mockReturnValueOnce(0x9c1d / 0x10000);
    const second = claimNewWorkflowRun(root, prelude, sameSecond);
    expect(second.runId).toBe("20260823-000230-9c1d");

    for (const claimed of [first, second]) {
      expect(claimed.firstLine.runId).toBe(claimed.runId);
      expect(existsSync(workflowJournalFile(workflowRunDir(root, claimed.runId)))).toBe(true);
    }
  });

  it("gives up with a clear diagnostic when every minted id is already claimed", () => {
    const root = temporaryProject();
    vi.spyOn(Math, "random").mockReturnValue(0x4560 / 0x10000);
    claimNewWorkflowRun(root, prelude, sameSecond);
    expect(() => claimNewWorkflowRun(root, prelude, sameSecond)).toThrow(/unique workflow run id after 5 attempts/u);
  });
});
