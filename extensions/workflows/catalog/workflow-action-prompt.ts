import { buildWorkflowRunCommand } from "../command/command-parser.js";
import { workflowSourceInputSchema } from "../source/workflow-source-structured.js";
import type { ResolvedWorkflowTarget } from "../runtime/workflow-discovery.js";
import type { WorkflowBrowserIntent } from "./workflow-catalog.js";

/** Exact source retained outside editable prompt text for a typed catalog Start. */
export function workflowCatalogLaunchSelection(
  intent: WorkflowBrowserIntent,
): { target: ResolvedWorkflowTarget; scriptSha256: string } | undefined {
  if (
    intent.action !== "start" ||
    intent.row.kind !== "current" ||
    intent.sourceState.kind !== "ready" ||
    workflowSourceInputSchema(intent.sourceState.source) === undefined
  ) {
    return undefined;
  }
  if (intent.sourceState.scriptSha256 === undefined) {
    throw new Error("Typed catalog Start is missing its selected entry-byte identity.");
  }
  return {
    target: { ...intent.row.target },
    scriptSha256: intent.sourceState.scriptSha256,
  };
}

/**
 * Deterministic editor handoff. Untyped Start restores the direct command.
 * Typed Start asks the agent to prepare typed input and call the native workflow
 * tool; the tool's interactive confirmation is the operator review boundary.
 * Edit and review continue through the packaged authoring skill.
 */
export function buildWorkflowActionPrompt(intent: WorkflowBrowserIntent, catalogSelectionId?: string): string {
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
    if (catalogSelectionId === undefined) throw new Error("Typed catalog Start requires a host-owned selection id.");
    return [
      `Start the exact current workflow ${JSON.stringify(row.name)} resolved from ${JSON.stringify(row.sourceLocator)}.`,
      "",
      `This is an explicit programmatic run request from the interactive Pi catalog. Inspect that exact source's static meta.inputSchema without importing the module. Build one explicit inputValue from the user's intent and repository evidence, show its canonical JSON, then call the native workflow tool with name ${JSON.stringify(row.name)}, catalogSelectionId ${JSON.stringify(catalogSelectionId)}, and that inputValue. The selection id is a one-use lookup key for the extension-owned target and entry digest; do not omit or alter it. The tool's interactive confirmation is the user's review step before trusted workflow execution. If the workflow tool is unavailable, report the missing prerequisite and stop. Do not invoke Pi, use a shell, emit or execute a /workflows command, or ask the user to run one. Never invent unresolved required values, defaults, coercions, or unknown properties; ask one focused question when a required value cannot be established.`,
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
