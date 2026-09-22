/**
 * One of two separately registered Pi entrypoints used to prove that the process-global
 * `locus-pi.workflow-live-executions.v1` writer registry declared by
 * `extensions/workflows/runtime/workflow-live.ts` is ONE registry with ONE authority,
 * even though Pi loads each entrypoint with the module cache disabled and therefore gives
 * each one its own instance of that module.
 *
 * This entrypoint OPENS a journal writer (`agent_start`) and CLOSES the one the peer
 * opened (`agent_end`). The peer does the mirror image, so authority is proven in both
 * directions rather than only the direction the writer happened to be created in.
 */
import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  workflowAgentLiveRowId,
  workflowLiveExecutionCount,
} from "../../../extensions/workflows/runtime/workflow-live.js";
import type { WorkflowJournalLine } from "../../../extensions/workflows/runtime/workflow-runtime.js";

const WORKFLOW_LIVE_EXECUTIONS_KEY = Symbol.for("locus-pi.workflow-live-executions.v1");

/** The runs each entrypoint opens; the peer closes the other one. */
const PRODUCER_RUN_ID = "20260730-000001-producer";
const CONSUMER_RUN_ID = "20260730-000002-consumer";

function startLine(runId: string): WorkflowJournalLine {
  return { ts: "start", runId, kind: "agent_start", agent: "reviewer", label: "cross-entrypoint", callId: "call-0001" };
}

function endLine(runId: string): WorkflowJournalLine {
  return {
    ts: "end",
    runId,
    kind: "agent_end",
    agent: "reviewer",
    label: "cross-entrypoint",
    callId: "call-0001",
    status: "completed",
    executedModel: "test/fast",
  };
}

/** The identity of the registry slot as THIS entrypoint's module instance sees it. */
function slot(): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[WORKFLOW_LIVE_EXECUTIONS_KEY];
}

export default function workflowLiveProducer(pi: ExtensionAPI): void {
  pi.registerCommand("test-workflow-open-writer", {
    handler: (_args, ctx) => {
      applyWorkflowJournalLineToAgentLiveStore(startLine(PRODUCER_RUN_ID));
      const rowId = workflowAgentLiveRowId(startLine(PRODUCER_RUN_ID));
      const row = agentLiveStore.rows.get(rowId);
      ctx.ui.setWidget("workflow-live-producer-open", [
        `count=${workflowLiveExecutionCount()}`,
        `status=${row?.status ?? "missing"}`,
        `slotIsMap=${slot() instanceof Map}`,
      ]);
    },
  });

  // Closes the writer the PEER opened. A per-entrypoint copy of the registry would make
  // this a silent no-op: the journal returns early when it holds no execution for the key,
  // so the peer's row would stay `working` forever and its writer entry would never clear.
  pi.registerCommand("test-workflow-close-peer-writer", {
    handler: (_args, ctx) => {
      applyWorkflowJournalLineToAgentLiveStore(endLine(CONSUMER_RUN_ID));
      const rowId = workflowAgentLiveRowId(endLine(CONSUMER_RUN_ID));
      const row = agentLiveStore.rows.get(rowId);
      ctx.ui.setWidget("workflow-live-producer-close", [
        `count=${workflowLiveExecutionCount()}`,
        `status=${row?.status ?? "missing"}`,
      ]);
    },
  });

  pi.registerCommand("test-workflow-producer-observe", {
    handler: (_args, ctx) => {
      ctx.ui.setWidget("workflow-live-producer-observe", [
        `count=${workflowLiveExecutionCount()}`,
        `slotIsMap=${slot() instanceof Map}`,
      ]);
    },
  });
}
