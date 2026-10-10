import type { ExtensionCommandContext } from "../../_shared/host/pi-api.js";
import { setOperatorWidget } from "../../_shared/operator/widget-render.js";
import {
  buildWorkflowActionPrompt,
  readWorkflowCatalogSource,
  type WorkflowBrowserIntent,
  type WorkflowCatalogCurrentRow,
} from "../catalog/workflow-catalog.js";
import { errorMessage, workflowWarningBlock } from "../operator/operator-ui.js";

export function workflowEditorHandoff(
  ctx: ExtensionCommandContext,
  intent: Exclude<WorkflowBrowserIntent, { action: "copy-project" | "copy-personal" }>,
): string | undefined {
  try {
    return buildWorkflowActionPrompt(intent);
  } catch (error) {
    return reportWorkflowEditorHandoffFailure(ctx, error);
  }
}

export function workflowStartEditorHandoff(
  ctx: ExtensionCommandContext,
  row: WorkflowCatalogCurrentRow,
  projectRoot: string,
  workingDirectory: string,
): string | undefined {
  try {
    return workflowEditorHandoff(ctx, {
      action: "start",
      row,
      sourceState: readWorkflowCatalogSource(row, projectRoot, workingDirectory),
    });
  } catch (error) {
    return reportWorkflowEditorHandoffFailure(ctx, error);
  }
}

function reportWorkflowEditorHandoffFailure(ctx: ExtensionCommandContext, error: unknown): undefined {
  setOperatorWidget(
    ctx,
    "workflows",
    workflowWarningBlock(
      `Workflow action could not be prepared: ${errorMessage(error)}.`,
      "No editor text was changed and no workflow was started.",
    ),
  );
}
