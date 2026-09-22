/** Admission integration needs installed dependencies and native source validation. No real provider calls. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "vitest";
import { createHarness } from "../../../test-harness.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { workflowLaunchBindingFile } from "../../../../extensions/workflows/runtime/workflow-launch-binding.js";
import { createWorkflowRuntime } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
} from "../../../../extensions/workflows/runtime/workflow-replay.js";
import { readWorkflowRunJournalState } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  workflowRecoveryInputHash,
  readInterruptedWorkflowResumeBinding,
} from "../../../../extensions/workflows/runtime/workflow-interrupted-recovery.js";
import { completed, tempRun, temporary } from "../../../fixtures/scripted-agent-runtime.js";
it("new ordinary roots preserve launch-binding projections for ordinary resume and opt-in interrupted recovery", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "locus-interrupted-admission-"));
  const previousRolesHome = process.env.PI_MODEL_ROLES_HOME;
  process.env.PI_MODEL_ROLES_HOME = path.join(root, ".pi-user");
  try {
    const h = createHarness(root);
    let calls = 0;
    mkdirSync(path.join(root, ".locus-pi/workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi/workflows/serial.workflow.mjs"),
      'export const meta = { name: "serial", profile: "standard" }; export default async function run(dsl, input) { return await dsl.agent(input, ' +
        '{ label: "worker" }); }\n',
    );
    const options = {
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      name: "serial",
      input: "fixed goal",
      createExecutor: () => ({
        async run() {
          calls += 1;
          return {
            status: "completed" as const,
            executionMode: "bare" as const,
            reason: "confirmed",
            text: "confirmed",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    };
    const initial = await runWorkflowScript(options);
    assert.equal(initial.ok, true, initial.error);
    assert.equal(calls, 1);
    const resultPath = workflowResultFile(initial.runDir);
    const terminal = JSON.parse(readFileSync(resultPath, "utf8"));
    const binding = JSON.parse(readFileSync(workflowLaunchBindingFile(initial.runDir), "utf8"));
    assert.equal(terminal.semanticInputSha256, binding.semanticInput.sha256);
    const resumed = await runWorkflowScript({ ...options, resumeFromRunId: initial.runId });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(calls, 1);
    // Missing terminal publication is simulated here; a separate subprocess contract exercises real SIGKILL.
    unlinkSync(resultPath);
    const recovered = await runWorkflowScript({ ...options, resumeFromRunId: initial.runId, recoverInterrupted: true });
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(calls, 1);
    assert.equal(recovered.replay?.replayedCalls, 1);
    const changed = await runWorkflowScript({
      ...options,
      input: "different goal",
      resumeFromRunId: initial.runId,
      recoverInterrupted: true,
    });
    assert.equal(changed.ok, false);
    assert.equal(calls, 1);
    assert.match(changed.error ?? "", /identical target, source, input/u);
    writeFileSync(resultPath, "{damaged");
    const damaged = await runWorkflowScript({ ...options, resumeFromRunId: initial.runId, recoverInterrupted: true });
    assert.equal(damaged.ok, false);
    assert.equal(calls, 1);
    // A corrupt terminal file is not an absent one: the ordinary resume preflight
    // refuses the unreadable source run before recovery admission is consulted.
    assert.match(damaged.error ?? "", /not found or unusable|absent result\.json/u);
  } finally {
    if (previousRolesHome === undefined) delete process.env.PI_MODEL_ROLES_HOME;
    else process.env.PI_MODEL_ROLES_HOME = previousRolesHome;
    rmSync(root, { recursive: true, force: true });
  }
});

it("interrupted recovery fingerprints exact inputs and refuses missing authority without creating a result", async () =>
  temporary(async (root) => {
    const a = workflowRecoveryInputHash({ input: "goal", items: ["a", "b"], budget: { totalAgents: 9 } });
    assert.notEqual(a, workflowRecoveryInputHash({ input: "goal", items: ["b", "a"], budget: { totalAgents: 9 } }));
    assert.notEqual(a, workflowRecoveryInputHash({ input: "goal ", items: ["a", "b"], budget: { totalAgents: 9 } }));
    const dir = tempRun(root, "interrupted");
    assert.throws(() =>
      readInterruptedWorkflowResumeBinding(root, "interrupted", {
        target: { kind: "path", ref: "example.workflow.mjs", source: "project" } as never,
        scriptSha256: "0".repeat(64),
        recoveryInputSha256: a,
      }),
    );
    assert.throws(() => readFileSync(path.join(dir, "result.json")), /ENOENT/u);
  }));

it("SIGKILL after a confirmed prefix leaves no terminal result and replay does not repeat its effect", async () =>
  temporary(async (root) => {
    const loader = process.env.LOCUS_TEST_TS_LOADER;
    const args = loader === undefined ? ["--import", "tsx"] : ["--loader", loader];
    const child = spawn(
      process.execPath,
      [...args, path.resolve(import.meta.dirname, "../../../fixtures/workflow-confirmed-prefix-child.mjs"), root],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = once(child, "close");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("CONFIRMED_PREFIX")) resolve();
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`child exited before checkpoint: ${code}; ${stderr}`)));
        timer = setTimeout(() => reject(new Error(`checkpoint timeout: ${stderr}`)), 10000);
      });
      child.kill("SIGKILL");
      const [code, signal] = await closed;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      const recorded = readWorkflowReplayLog(root, "killed-prefix");
      assert.equal(recorded.length, 1);
      const journal = readWorkflowRunJournalState(root, "killed-prefix");
      assert.deepEqual(journal.diagnostics, []);
      assert.equal(journal.lines.filter((line) => line.kind === "agent_end").length, 1);
      assert.throws(() => readFileSync(path.join(root, ".locus-pi/runs/killed-prefix/runtime/result.json")), /ENOENT/u);
      let repeated = 0;
      const resumed = createWorkflowRuntime({
        runId: "after-kill",
        replay: createWorkflowReplayController({
          runDir: tempRun(root, "after-kill"),
          recorded,
          requireRecordedPrefix: true,
        }),
        agentRunner: async (req) => {
          repeated += 1;
          return completed(req, "must not run");
        },
      });
      assert.equal(await resumed.dsl.agent("goal", { label: "worker" }), "confirmed");
      assert.equal(repeated, 0);
      assert.equal(readFileSync(path.join(root, "effect-count.txt"), "utf8"), "1");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }));
