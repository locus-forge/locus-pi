// Disposable subprocess fixture: production runtime/replay, deterministic child, no real model.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createWorkflowRuntime } from "../../extensions/workflows/runtime/workflow-runtime.js";
import { createWorkflowReplayController } from "../../extensions/workflows/runtime/workflow-replay.js";
import { createWorkflowJournalSink } from "../../extensions/workflows/runtime/workflow-journal.js";
const root = process.argv[2];
if (!root) throw new Error("Missing disposable root");
const runId = "killed-prefix";
const runDir = path.join(root, ".locus-pi", "runs", runId);
mkdirSync(runDir, { recursive: true });
const runtime = createWorkflowRuntime({
  runId,
  journal: createWorkflowJournalSink(root, runId),
  replay: createWorkflowReplayController({ runDir }),
  agentRunner: async () => {
    writeFileSync(path.join(root, "effect-count.txt"), "1");
    return {
      ok: true,
      status: "completed",
      executionMode: "bare",
      summary: "confirmed",
      text: "confirmed",
      diagnostics: [],
    };
  },
});
await runtime.dsl.agent("goal", { label: "worker" });
// Both agent_end and replay completion have been persisted; there is no pending child.
console.log("CONFIRMED_PREFIX");
setInterval(() => {}, 1000);
