/**
 * extensions/workflows/operator/operator-surface.ts — The workflows extension's
 * context-bound operator surface.
 *
 * Every write to the `workflows` widget key and the `workflow.run` status lane
 * that is not a plain block render goes through here: the launch/activity
 * status line, the best-effort widget clear, and the one wording each handoff
 * pump outcome gets. Pure block construction stays in `operator-ui.ts`.
 */

import type { ExtensionContext } from "../../_shared/host/pi-api.js";
import { clearOperatorStatus, setOperatorStatus } from "../../_shared/operator/operator-status.js";
import type { WorkflowJournalLine } from "../runtime/workflow-runtime.js";
import { setOperatorWidget } from "../../_shared/operator/widget-render.js";
import type { WorkflowHandoffPumpResult } from "./operator-handoff-controller.js";
import { assertNever, workflowWarningBlock } from "./operator-ui.js";
import { renderMainWorkflowStatus } from "../transcript/workflow-transcript.js";

const WORKFLOW_STATUS_ID = "workflow.run";

export function clearWorkflowWidget(ctx: ExtensionContext, key: string): void {
  try {
    ctx.ui.setWidget(key, undefined);
  } catch {
    // Best-effort cleanup; the usage hint still goes through notify.
  }
}

export function clearWorkflowRunStatus(ctx: ExtensionContext): void {
  clearOperatorStatus(ctx, WORKFLOW_STATUS_ID);
}

export function setWorkflowLaunchStatus(ctx: ExtensionContext, kind: string, ref: string): void {
  setOperatorStatus(ctx, {
    id: WORKFLOW_STATUS_ID,
    lane: "activity",
    priority: 70,
    wide: `WF launch · operator command · ${kind}:${ref}`,
    compact: `WF launch · operator cmd · ${ref}`,
    narrow: "WF launch",
  });
}

export function setWorkflowEventStatus(ctx: ExtensionContext, line: WorkflowJournalLine): void {
  const status = renderMainWorkflowStatus(line);
  if (status === undefined) return;
  setOperatorStatus(ctx, {
    id: WORKFLOW_STATUS_ID,
    lane: "activity",
    priority: 70,
    wide: `WF ${status}`,
    compact: `WF ${status}`,
    narrow: line.kind === "error" ? "WF error" : line.kind === "phase" ? "WF phase" : "WF active",
  });
}

export function presentWorkflowHandoffPumpResult(ctx: ExtensionContext, result: WorkflowHandoffPumpResult): void {
  switch (result.status) {
    case "none":
    case "started":
      return;
    case "busy":
      setOperatorWidget(
        ctx,
        "workflows",
        workflowWarningBlock(
          "Workflow question is already opening or Pi is not idle.",
          "Recovery: wait for the current interaction to finish, then retry /workflows.",
        ),
      );
      return;
    case "unavailable":
      setOperatorWidget(
        ctx,
        "workflows",
        workflowWarningBlock(
          `Workflow ${result.runId} needs an answer, but this Pi mode cannot open an interactive question.`,
          `Use: /workflows continue ${result.runId} --answer <text>`,
        ),
      );
      return;
    case "stale":
      setOperatorWidget(
        ctx,
        "workflows",
        workflowWarningBlock(
          "Workflow question was dropped because the Pi session changed.",
          "Recovery: retry /workflows in the current session.",
        ),
      );
      return;
    case "deferred":
      // Not a warning: the pump deliberately opened nothing. The previous
      // continuation consumed an answer and failed, so re-asking is the
      // operator's call, and this line says where that call lives.
      setOperatorWidget(ctx, "workflows", {
        type: "VIEW",
        subject: "Workflow handoff",
        primary: `Run ${result.runId} still awaits an operator answer; its previous continuation failed.`,
        metadata: ["The question is not reopened automatically after a failed continuation."],
        controls: [`Reopen: /workflows continue ${result.runId} --answer <text>`],
      });
      return;
    case "invalid":
    case "failed":
      setOperatorWidget(
        ctx,
        "workflows",
        workflowWarningBlock(result.message, "Inspect durable evidence: /workflows status <runId>"),
      );
      return;
    default:
      assertNever(result);
  }
}
