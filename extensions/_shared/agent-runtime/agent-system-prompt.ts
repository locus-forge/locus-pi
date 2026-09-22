import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { buildAgentContextExtrasText, type AgentContextExtrasOptions } from "./agent-context-extras.js";
import type { AgentRunRequest } from "./agent-runner.js";

export interface AgentSystemPromptOptions extends Pick<AgentContextExtrasOptions, "env" | "readFile" | "exists"> {
  diagnostics?: string[];
  /** Fusion-only profile: preserve package identity/persona, suppress package context extras. */
  suppressContextExtras?: boolean;
}

export function buildAgentSystemPrompt(
  request: AgentRunRequest,
  options: AgentSystemPromptOptions = {},
): string | undefined {
  if (request.executionMode === "bare") return undefined;
  const instructions = request.agent.systemPrompt?.trim();
  const cwd = request.workingDirectory ?? request.projectRoot ?? process.cwd();
  const extras =
    options.suppressContextExtras === true
      ? { enabled: false, diagnostics: [], text: undefined }
      : buildAgentContextExtrasText({
          cwd,
          ...(request.projectRoot === undefined ? {} : { projectRoot: request.projectRoot }),
          env: options.env ?? process.env,
          ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
          ...(options.exists === undefined ? {} : { exists: options.exists }),
        });
  if (options.diagnostics !== undefined && extras.diagnostics.length > 0)
    options.diagnostics.push(...extras.diagnostics);

  if (
    (instructions === undefined || instructions === "") &&
    extras.text === undefined &&
    !extras.enabled &&
    options.suppressContextExtras !== true
  )
    return undefined;

  const lines = [
    `<active_agent name="${escapeAttribute(request.agent.name)}"/>`,
    "",
    "You are a pi coding agent sub-agent.",
    "You have been invoked to handle a specific task autonomously.",
    "",
    "# Environment",
    `Working directory: ${cwd}`,
    gitBranchLine(cwd),
    `Platform: ${platform()}`,
  ];
  if (instructions !== undefined && instructions !== "") {
    lines.push("", "<agent_instructions>", instructions, "</agent_instructions>");
  }
  if (extras.text !== undefined) {
    lines.push("", extras.text);
  }
  return lines.join("\n");
}

function gitBranchLine(cwd: string): string {
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch !== "") return `Git repository: yes\nBranch: ${branch}`;
  } catch {
    // Fall through to the non-git line below.
  }
  return "Not a git repository";
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
