/**
 * The peer of `workflow-live-producer.ts`. See that file's header for what the pair
 * proves; this entrypoint opens the consumer-side writer and closes the producer's.
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

function slot(): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[WORKFLOW_LIVE_EXECUTIONS_KEY];
}

export default function workflowLiveConsumer(pi: ExtensionAPI): void {
  pi.registerCommand("test-workflow-consumer-open-writer", {
    handler: (_args, ctx) => {
      applyWorkflowJournalLineToAgentLiveStore(startLine(CONSUMER_RUN_ID));
      const rowId = workflowAgentLiveRowId(startLine(CONSUMER_RUN_ID));
      const row = agentLiveStore.rows.get(rowId);
      ctx.ui.setWidget("workflow-live-consumer-open", [
        `count=${workflowLiveExecutionCount()}`,
        `status=${row?.status ?? "missing"}`,
        `slotIsMap=${slot() instanceof Map}`,
      ]);
    },
  });

  // Closes the writer the PRODUCER opened; see the peer's note on why a duplicated
  // registry turns this into a silent no-op.
  pi.registerCommand("test-workflow-consumer-close-peer-writer", {
    handler: (_args, ctx) => {
      applyWorkflowJournalLineToAgentLiveStore(endLine(PRODUCER_RUN_ID));
      const rowId = workflowAgentLiveRowId(endLine(PRODUCER_RUN_ID));
      const row = agentLiveStore.rows.get(rowId);
      ctx.ui.setWidget("workflow-live-consumer-close", [
        `count=${workflowLiveExecutionCount()}`,
        `status=${row?.status ?? "missing"}`,
      ]);
    },
  });

  pi.registerCommand("test-workflow-consumer-observe", {
    handler: (_args, ctx) => {
      ctx.ui.setWidget("workflow-live-consumer-observe", [
        `count=${workflowLiveExecutionCount()}`,
        `slotIsMap=${slot() instanceof Map}`,
      ]);
    },
  });
}
