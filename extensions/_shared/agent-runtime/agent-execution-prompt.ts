import { readFileSync } from "node:fs";
import type { AgentParentContext, AgentRunRequest } from "./agent-runner.js";
import { AGENT_BUDGET_UNBOUNDED } from "./agent-runner.js";
import type { ModelRoleResolutionRecord } from "../model/model-settings.js";
import { modelRoleResolutionRecord } from "../model/model-settings.js";
import { buildAgentSystemPrompt } from "./agent-system-prompt.js";
import { OUTPUT_DEFAULTS } from "../host/safe-output.js";

/**
 * The prompt capsule and text-result layer every live agent execution goes through.
 *
 * Prompt construction and text-result parsing are host-independent contracts used by
 * the live SDK executor. Keeping them separate prevents this layer from inheriting
 * child-session lifecycle, tool, or transport dependencies from `agent-sdk-host.ts`.
 * Superseded replacement-session implementations remain available in Git history
 * rather than as shipped production modules.
 */
export interface AgentExecutionPromptCapsule {
  version: "locus.agent.prompt.v2";
  executionMode: "bare" | "named";
  agentName?: string;
  capabilityMode?: "tool-free" | "agent";
  agentDefinitionPath?: string;
  task: string;
  projectRoot: string;
  workingDirectory: string;
  allowedTools: string[];
  /**
   * The declared assistant-turn budget, or the literal `"unbounded"` when the
   * caller declared none. A literal rather than an omitted key: the child reads
   * this capsule, and an absent field would be silence, not an honest answer.
   */
  maxTurns: number | typeof AGENT_BUDGET_UNBOUNDED;
  depth: number;
  maxDepth: number;
  modelRole?: ModelRoleResolutionRecord;
  agentSystemPrompt?: string;
  contextDiagnostics?: string[];
  parentContext?: string;
}

export function createAgentExecutionPromptCapsule(
  request: AgentRunRequest,
  diagnostics: string[] = [],
  promptEnv: NodeJS.ProcessEnv | undefined = process.env,
): AgentExecutionPromptCapsule {
  const effectivePromptEnv = promptEnv ?? process.env;
  const capsule: AgentExecutionPromptCapsule = {
    version: "locus.agent.prompt.v2",
    executionMode: request.executionMode,
    ...(request.executionMode === "named" ? { agentName: request.agent.name } : {}),
    ...(request.capabilityMode === undefined ? {} : { capabilityMode: request.capabilityMode }),
    task: request.task,
    projectRoot: request.projectRoot ?? "",
    workingDirectory: request.workingDirectory ?? request.projectRoot ?? "",
    allowedTools: [...request.allowedTools],
    maxTurns: request.maxTurns ?? AGENT_BUDGET_UNBOUNDED,
    depth: request.depth,
    maxDepth: request.maxDepth,
  };
  if (request.executionMode === "named" && request.agent.filePath !== undefined)
    capsule.agentDefinitionPath = request.agent.filePath;
  if (request.modelRoleResolution !== undefined)
    capsule.modelRole = modelRoleResolutionRecord(request.modelRoleResolution);
  const agentSystemPrompt = buildAgentSystemPrompt(request, {
    diagnostics,
    env: effectivePromptEnv,
    suppressContextExtras: request.capabilityMode === "tool-free",
  });
  if (agentSystemPrompt !== undefined) capsule.agentSystemPrompt = agentSystemPrompt;
  const parentContextText = assembleParentContext(request.parentContext);
  if (parentContextText !== undefined) {
    // The parent selected this context deliberately and it is the CHILD'S INPUT, not a
    // projection for a human reader: cutting it here would delete the half of the brief
    // the child never learns it was missing. So it travels whole, and a large one is
    // noted in the receipt instead — evidence the operator can act on (a context-window
    // overflow now reads as one), never a silent truncation.
    const bytes = Buffer.byteLength(parentContextText, "utf8");
    if (bytes > PARENT_CONTEXT_SIZE_NOTE_BYTES) {
      diagnostics.push(
        `Parent context is ${String(bytes)} bytes and was passed to the child whole (no truncation); ` +
          `it counts against the child model's context window.`,
      );
    }
  }
  if (diagnostics.length > 0) capsule.contextDiagnostics = [...diagnostics];
  if (parentContextText !== undefined) capsule.parentContext = parentContextText;
  return capsule;
}

/** Size at which a passed-whole parent context earns a receipt note. Not a limit. */
const PARENT_CONTEXT_SIZE_NOTE_BYTES = OUTPUT_DEFAULTS.subagentSummaryBytes;

export function assembleParentContext(
  parentContext: AgentParentContext | undefined,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | undefined {
  if (parentContext === undefined) return undefined;
  const parts: string[] = [];
  if (parentContext.inline !== undefined && parentContext.inline.length > 0) parts.push(parentContext.inline);
  if (parentContext.artifactPath !== undefined && parentContext.artifactPath.length > 0) {
    try {
      const artifactText = readFile(parentContext.artifactPath);
      if (artifactText.length > 0) parts.push(artifactText);
    } catch {
      // Explicit parent context is optional; a missing artifact should not block the child run.
    }
  }
  if (parts.length === 0) return undefined;
  // Joined and returned unchanged: see the receipt note in
  // `createAgentExecutionPromptCapsule` for why nothing is cut here.
  return parts.join("\n---\n");
}

export function formatAgentKickoffPrompt(capsule: AgentExecutionPromptCapsule): string {
  const lines = [
    "Run the requested sub-agent task in this child session.",
    "",
    "Prompt capsule:",
    JSON.stringify(capsule, null, 2),
  ];
  if (capsule.parentContext !== undefined) {
    lines.push("", "Parent-provided context (explicit, read-only):", capsule.parentContext);
  }
  lines.push(
    "",
    "Do the work, then reply to the parent runtime in plain text. Your exact final non-empty message is the result.",
    "Do not wrap the result in JSON and do not add a machine-readable result envelope.",
    "If the prompt capsule includes agentSystemPrompt, treat it as this child agent's operating instructions.",
  );
  return lines.join("\n");
}

export function parseAgentText(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (text.trim() === "") return { ok: false, reason: "Agent result text is empty." };
  return { ok: true, text };
}
