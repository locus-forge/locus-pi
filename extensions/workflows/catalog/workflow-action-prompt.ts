import { buildWorkflowRunCommand } from "../command/command-parser.js";
import { workflowSourceInputSchema } from "../source/workflow-source-structured.js";
import type { WorkflowBrowserIntent } from "./workflow-catalog.js";

/**
 * Deterministic editor handoff. Untyped Start restores the direct command.
 * Typed Start prepares a separate, reviewable command without launching it.
 * Edit and review continue through the packaged authoring skill.
 */
export function buildWorkflowActionPrompt(intent: WorkflowBrowserIntent): string {
  if (intent.action === "copy-project" || intent.action === "copy-personal") {
    throw new Error(`Workflow copy action ${JSON.stringify(intent.action)} does not produce an editor prompt.`);
  }
  if (intent.row.kind === "history" && intent.action !== "review") {
    throw new Error(`Historical workflow actions are review-only; received ${JSON.stringify(intent.action)}.`);
  }
  const row = intent.row;
  if (row.kind === "current" && intent.action === "start") {
    if (intent.sourceState.kind !== "ready") {
      throw new Error(
        `Current workflow start requires a ready source; received ${JSON.stringify(intent.sourceState.kind)}.`,
      );
    }
    const command = buildWorkflowRunCommand(row.target);
    if (workflowSourceInputSchema(intent.sourceState.source) === undefined) return command;
    return [
      `Request: Prepare typed input for the exact current workflow ${JSON.stringify(row.name)} resolved from ${JSON.stringify(row.sourceLocator)}. Do not start it.`,
      "Skill: locus-pi-workflow-run",
      "",
      `Preparation-only mode: Inspect that exact source's static meta.inputSchema without importing the module. Build one explicit inputValue from the user's intent and repository evidence. Return its canonical JSON and one editable launch command beginning ${JSON.stringify(`${command} --input-json `)}. Do not call the workflow tool, submit the command, or start the workflow; the user reviews the JSON and launches in a separate action. Never invent unresolved required values, defaults, coercions, or unknown properties.`,
      "",
      "Additional launch instructions:",
      "",
    ].join("\n");
  }
  let request: string;
  if (row.kind === "current") {
    const action = intent.action[0]!.toUpperCase() + intent.action.slice(1);
    request = `${action} the exact current workflow at ${JSON.stringify(row.target.path)}.`;
  } else {
    const identity = [
      `run ${JSON.stringify(row.runId)}`,
      `target ${JSON.stringify(`${row.target.kind}:${row.target.ref}`)}`,
    ];
    if (intent.sourceState.kind === "ready") {
      identity.push(`at ${JSON.stringify(row.originPath)}`);
      if (row.snapshot.sha256 !== undefined) identity.push(`SHA-256 ${JSON.stringify(row.snapshot.sha256)}`);
      request = `Review the immutable workflow snapshot for ${identity.join(", ")}.`;
    } else {
      identity.push(`with snapshot state ${JSON.stringify(intent.sourceState.kind)}`);
      if (row.snapshot.path !== undefined) identity.push(`path ${JSON.stringify(row.snapshot.path)}`);
      if (row.snapshot.sha256 !== undefined) identity.push(`SHA-256 ${JSON.stringify(row.snapshot.sha256)}`);
      request = `Review the recorded workflow identity for ${identity.join(", ")}; diagnose why the immutable snapshot is unavailable.`;
    }
  }
  return [`Request: ${request}`, "Skill: locus-pi-workflow-create", "", "Additional instructions:", ""].join("\n");
}
