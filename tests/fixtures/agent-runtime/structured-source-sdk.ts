/** Checked saved source through the real runner; only provider SSE bytes are synthetic. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarness } from "../../test-harness.js";
import { createStructuredSdkExecutor } from "./structured-sdk.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { runWorkflowScript } from "../../../extensions/workflows/runtime/workflow-runner.js";
import { readWorkflowReplayLog } from "../../../extensions/workflows/runtime/workflow-replay.js";

export async function withStructuredSourceSdk<T>(
  source: string,
  scripted: object[][],
  work: (fixture: {
    root: string;
    sourcePath: string;
    counters: Awaited<ReturnType<typeof createStructuredSdkExecutor>>["counters"];
    run(options?: {
      source?: string;
      input?: string;
      resumeFromRunId?: string;
    }): Promise<Awaited<ReturnType<typeof runWorkflowScript>> & { records: ReturnType<typeof readWorkflowReplayLog> }>;
  }) => Promise<T>,
): Promise<T> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "locus-structured-source-")));
  const sourcePath = path.join(root, ".locus-pi", "workflows", "structured-source.workflow.mjs");
  const previousRolesHome = process.env.PI_MODEL_ROLES_HOME;
  process.env.PI_MODEL_ROLES_HOME = path.join(root, ".pi-user");
  try {
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source);
    const { counters, createExecutor } = await createStructuredSdkExecutor(root, scripted);
    return await work({
      root,
      sourcePath,
      counters,
      async run(options = {}) {
        if (options.source !== undefined) writeFileSync(sourcePath, options.source);
        const harness = createHarness(root, { sessionId: "structured-source-host" });
        const result = await runWorkflowScript({
          pi: harness.pi,
          ctx: harness.ctx,
          name: "structured-source",
          signal: new AbortController().signal,
          createExecutor(options) {
            const executor = createExecutor(options);
            return {
              run(request, signal) {
                counters.physical++;
                return executor.run(request, signal);
              },
            };
          },
          ...(options.input === undefined ? {} : { input: options.input }),
          ...(options.resumeFromRunId === undefined ? {} : { resumeFromRunId: options.resumeFromRunId }),
        });
        return { ...result, records: readWorkflowReplayLog(root, result.runId) };
      },
    });
  } finally {
    if (previousRolesHome === undefined) delete process.env.PI_MODEL_ROLES_HOME;
    else process.env.PI_MODEL_ROLES_HOME = previousRolesHome;
    agentLiveStore.reset();
    rmSync(root, { recursive: true, force: true });
  }
}
