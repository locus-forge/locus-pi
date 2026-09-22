/**
 * extensions/workflows/launch/launch-guard.ts — Preconditions a `/workflows run`
 * must clear before anything is started.
 *
 * Three decisions, no side effects: is the Pi session provably idle, does this
 * host mode dispose the session at the end of the turn, and does the requested
 * script ref resolve at all. Each returns a value; the caller owns what the
 * operator is told.
 */

import type { ExtensionCommandContext, ExtensionContext } from "../../_shared/host/pi-api.js";
import { isOneShotHostMode } from "../../_shared/host/pi-api.js";
import {
  resolveWorkflowTarget,
  WorkflowNameNotFoundError,
  WorkflowGroupOnlyError,
  type ResolvedWorkflowTarget,
} from "../runtime/workflow-discovery.js";
import { isWorkflowSavedName } from "../runtime/workflow-saved-name.js";

const WORKFLOW_BUSY_MESSAGE =
  "Workflow not started: Pi is busy streaming. Wait for the current response to finish, then retry /workflows run.";

/**
 * True for the one-shot output modes, whose session is disposed when the turn
 * ends. `tui` and `rpc` sessions outlive their turn, so a run launched there
 * stays detached; in `print`/`json` a detached run loses the ctx its child
 * sessions need, so the command has to hold the turn open instead.
 */
export function isOneShotCommandMode(ctx: ExtensionCommandContext): boolean {
  return isOneShotHostMode(ctx);
}

/** The reason a launch must not start, or `undefined` when the session is idle. */
export function workflowCommandIdleBlock(ctx: ExtensionContext): string | undefined {
  if (typeof ctx.isIdle !== "function") {
    return "Workflow not started: this Pi host cannot prove that the session is idle (ctx.isIdle is unavailable).";
  }
  try {
    return ctx.isIdle() ? undefined : WORKFLOW_BUSY_MESSAGE;
  } catch {
    return "Workflow not started: this Pi host could not read the session idle state.";
  }
}

export type WorkflowCommandTargetPreflight =
  | { status: "resolved"; target: ResolvedWorkflowTarget }
  | { status: "not-found" }
  | { status: "group-only"; workflowName: string }
  | { status: "runner-durable-failure"; targetKind: "name" | "scriptPath" };

export function preflightWorkflowCommandTarget(
  scriptRef: string,
  projectRoot: string,
  workingDirectory: string,
): WorkflowCommandTargetPreflight {
  try {
    return {
      status: "resolved",
      target: resolveWorkflowTarget(
        isWorkflowSavedName(scriptRef) ? { name: scriptRef } : { scriptPath: scriptRef },
        projectRoot,
        workingDirectory,
      ),
    };
  } catch (error) {
    if (error instanceof WorkflowNameNotFoundError) return { status: "not-found" };
    if (error instanceof WorkflowGroupOnlyError) return { status: "group-only", workflowName: error.workflowName };
    return {
      status: "runner-durable-failure",
      targetKind: isWorkflowSavedName(scriptRef) ? "name" : "scriptPath",
    };
  }
}
