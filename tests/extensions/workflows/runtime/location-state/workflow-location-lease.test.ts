import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireWorkflowRootLease,
  releaseWorkflowRootLease,
  WORKFLOW_LEASE_RECLAIM_GUARD_FILE,
  WORKFLOW_WORKSPACE_LEASE_FILE,
  workflowOutputStateDir,
} from "../../../../../extensions/workflows/runtime/location-state/workflow-location-lease.js";
import { ensureWorkflowRunDir } from "../../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../../extensions/workflows/runtime/workflow-result.js";
import { runWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { resolveWorkflowOutputDirectory } from "../../../../../extensions/workflows/runtime/workflow-workspace.js";
import { createHarness } from "../../../../test-harness.js";
import { project, writeWorkflow } from "../../../../fixtures/workflow-durable-project.js";

function terminalEnvelope(runId: string, resultPath: string): Record<string, unknown> {
  return {
    runId,
    ok: true,
    disposition: { status: "completed" },
    result: null,
    resultPersistence: { ok: true, path: resultPath },
  };
}

describe("workflow location lease recovery", () => {
  it("uses force only for a complete matching terminal envelope", async () => {
    const root = project();
    const relativePath = "outputs/force-terminal";
    writeWorkflow(root, "force-terminal", 'export default async () => "done";\n');
    const harness = createHarness(root);
    const settled = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "force-terminal",
      workspaceDir: relativePath,
    });
    expect(settled.ok).toBe(true);

    const output = resolveWorkflowOutputDirectory(root, relativePath, "unused", root);
    const leaked = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: settled.runId });
    expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "plain-retry" })).toThrow(
      /Retry the same launch with --force/u,
    );
    const replacement = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "forced-retry", force: true });
    expect(() => releaseWorkflowRootLease(leaked)).toThrow("fencing token is stale");
    releaseWorkflowRootLease(replacement);

    const invalidCases: Array<[string, (runId: string, resultPath: string) => unknown]> = [
      ["partial", (runId) => ({ runId })],
      ["missing-run-id", (_runId, resultPath) => ({ ...terminalEnvelope("unused", resultPath), runId: undefined })],
      ["mismatched-run-id", (_runId, resultPath) => terminalEnvelope("different-run", resultPath)],
      ["missing-ok", (runId, resultPath) => ({ ...terminalEnvelope(runId, resultPath), ok: undefined })],
      ["invalid-ok", (runId, resultPath) => ({ ...terminalEnvelope(runId, resultPath), ok: "yes" })],
      [
        "missing-disposition",
        (runId, resultPath) => ({ ...terminalEnvelope(runId, resultPath), disposition: undefined }),
      ],
      [
        "inconsistent-disposition",
        (runId, resultPath) => ({ ...terminalEnvelope(runId, resultPath), disposition: { status: "failed" } }),
      ],
      [
        "missing-persistence",
        (runId, resultPath) => ({ ...terminalEnvelope(runId, resultPath), resultPersistence: undefined }),
      ],
      [
        "failed-persistence",
        (runId, resultPath) => ({
          ...terminalEnvelope(runId, resultPath),
          ok: false,
          disposition: { status: "failed" },
          resultPersistence: {
            ok: false,
            path: resultPath,
            code: "WORKFLOW_RESULT_WRITE_FAILED",
            message: "write failed",
          },
        }),
      ],
      [
        "foreign-persistence",
        (runId, resultPath) => ({
          ...terminalEnvelope(runId, resultPath),
          resultPersistence: { ok: true, path: "/tmp/foreign-result.json" },
        }),
      ],
    ];
    for (const [name, envelope] of invalidCases) {
      const runId = `${name}-terminal-evidence`;
      const runDir = ensureWorkflowRunDir(root, runId);
      const resultPath = workflowResultFile(runDir);
      writeFileSync(resultPath, `${JSON.stringify(envelope(runId, resultPath))}\n`, "utf8");
      const partial = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: runId });
      expect(
        () => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: `${name}-force`, force: true }),
        name,
      ).toThrow(`owned by live run ${runId}`);
      releaseWorkflowRootLease(partial);
    }

    const invalidJsonRunId = "invalid-json-terminal-evidence";
    const invalidJsonRunDir = ensureWorkflowRunDir(root, invalidJsonRunId);
    writeFileSync(workflowResultFile(invalidJsonRunDir), "not json\n", "utf8");
    const invalidJson = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: invalidJsonRunId });
    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "invalid-json-force", force: true }),
    ).toThrow("--force refused: the terminal result is missing or unreadable");
    releaseWorkflowRootLease(invalidJson);

    const missingRunId = "missing-terminal-run";
    const missing = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: missingRunId });
    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "missing-run-force", force: true }),
    ).toThrow(`--force refused: no run directory exists for ${missingRunId}`);
    releaseWorkflowRootLease(missing);

    const ambiguousRunId = "ambiguous-terminal-run";
    const runDirs = [
      ensureWorkflowRunDir(root, ambiguousRunId),
      ensureWorkflowRunDir(root, ambiguousRunId, { storageRootRunId: "ambiguous-storage-root", kind: "attempt" }),
    ];
    for (const runDir of runDirs) {
      const resultPath = workflowResultFile(runDir);
      writeFileSync(resultPath, `${JSON.stringify(terminalEnvelope(ambiguousRunId, resultPath))}\n`, "utf8");
    }
    const ambiguous = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: ambiguousRunId });
    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "ambiguous-force", force: true }),
    ).toThrow(`--force refused: run evidence is ambiguous for ${ambiguousRunId}`);
    releaseWorkflowRootLease(ambiguous);

    const unverifiable = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "unverifiable-owner" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    try {
      expect(() =>
        acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "unverifiable-force", force: true }),
      ).toThrow("unverifiable owner pid");
    } finally {
      kill.mockRestore();
      releaseWorkflowRootLease(unverifiable);
    }
  });

  it("never removes persistent or unreadable reclaim guards automatically", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/guarded-reclaim", "unused", root);
    const stateDir = workflowOutputStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    const guardFile = path.join(stateDir, WORKFLOW_LEASE_RECLAIM_GUARD_FILE);
    const record = {
      schema: "locus-pi.workflow-location-lease.v2",
      kind: "workspace",
      rootRunId: "dead-owner",
      relativePath: output.relativePath,
      identity: output.identity,
      pid: 2_147_483_647,
      fencingToken: "dead-token",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(lockFile, `${JSON.stringify(record)}\n`, "utf8");
    for (const [label, pid] of [
      ["dead", 2_147_483_647],
      ["live", process.pid],
      ["unverifiable", 0],
    ] as const) {
      writeFileSync(
        guardFile,
        `${JSON.stringify({ ...record, rootRunId: `${label}-guard`, pid, fencingToken: `${label}-token` })}\n`,
        "utf8",
      );
      expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: `${label}-blocked` })).toThrow(
        /Guard: \.locus-pi\/workflow-state\/v1\/.+\/reclaim\.json/u,
      );
      expect(existsSync(guardFile)).toBe(true);
      unlinkSync(guardFile);
    }

    writeFileSync(guardFile, "{\n", "utf8");
    expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "unreadable-blocked" })).toThrow(
      /reclaim guard owner is unreadable at \.locus-pi\/workflow-state\/v1\/.+\/reclaim\.json/u,
    );
    expect(readFileSync(guardFile, "utf8")).toBe("{\n");
    unlinkSync(guardFile);
    const recovered = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "recovered" });
    releaseWorkflowRootLease(recovered);
  });

  it("does not mistake a reused current PID for a run registered in this process", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/reused-pid", "unused", root);
    const stateDir = workflowOutputStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE),
      `${JSON.stringify({
        schema: "locus-pi.workflow-location-lease.v2",
        kind: "workspace",
        rootRunId: "prior-process-run",
        relativePath: output.relativePath,
        identity: output.identity,
        pid: process.pid,
        fencingToken: "prior-process-token",
        acquiredAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    let message = "";
    try {
      acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "new-process-run" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("from the project root remove only the named lease");
    expect(message).not.toContain("/workflows stop prior-process-run");
  });

  it.skipIf(process.platform === "win32")("resumes a stopped owner so SIGTERM can release its lease", async () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/stopped-owner", "unused", root);
    const stateDir = workflowOutputStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const lockFile = path.join(stateDir, WORKFLOW_WORKSPACE_LEASE_FILE);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
const lockFile = ${JSON.stringify(lockFile)};
fs.writeFileSync(lockFile, JSON.stringify({ schema: "locus-pi.workflow-location-lease.v2", kind: "workspace", rootRunId: "stopped-owner", relativePath: ${JSON.stringify(output.relativePath)}, identity: ${JSON.stringify(output.identity)}, pid: process.pid, fencingToken: "stopped-token", acquiredAt: new Date().toISOString() }) + "\\n", { flag: "wx" });
process.on("SIGTERM", () => { fs.unlinkSync(lockFile); process.exit(0); });
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout!, "data");
    if (child.pid === undefined) throw new Error("stopped-owner child has no pid");
    expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "contender" })).toThrow(
      "owned by live run stopped-owner",
    );
    process.kill(child.pid, "SIGSTOP");
    process.kill(child.pid, "SIGTERM");
    process.kill(-child.pid, "SIGCONT");
    await once(child, "exit");
    const replacement = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "replacement" });
    releaseWorkflowRootLease(replacement);
  });

  it("fails release when the owned lease file disappeared", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/missing-release", "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "missing-release" });
    unlinkSync(lease.lockFile);
    expect(() => releaseWorkflowRootLease(lease)).toThrow(
      /workflow lease is missing at \.locus-pi\/workflow-state\/v1\/.+\/lease\.json/u,
    );
  });
});
