/**
 * extensions/agents/command/command-parser.ts — pure text→intent for the `/agent` and
 * `/ps` grammars. No Pi handle, no ExtensionContext: the seam the router
 * dispatches on.
 */

export type CommandApprovalTier = "prompt" | "allow";

export interface ParsedAgentRunCommand {
  name: string;
  task: string;
  approvalTier: CommandApprovalTier;
  title?: string;
}

export interface ParsedAgentDrillCommand {
  target: string;
}

export interface ParsedAgentObserverCommand {
  target: "observe" | "summary";
}

export function parseAgentObserverCommand(text: string): ParsedAgentObserverCommand | undefined {
  if (text === "observe") return { target: "observe" };
  if (text === "summary") return { target: "summary" };
  return undefined;
}

export function parseAgentDrillCommand(text: string): ParsedAgentDrillCommand | undefined {
  const drillMatch = /^drill(?:\s+([\s\S]+))?$/.exec(text);
  if (drillMatch === null) return undefined;
  const rest = drillMatch[1]?.trim() ?? "";
  if (rest === "") return { target: "" };
  const tokens = rest.split(/\s+/);
  const flag = tokens.find((token) => token.startsWith("--"));
  if (flag !== undefined) return { target: flag };
  if (tokens.length !== 1) return { target: "" };
  return { target: tokens[0]! };
}

export function parseAgentPsCommand(text: string): string | undefined {
  if (text === "ps") return "";
  if (!text.startsWith("ps ")) return undefined;
  return parsePsTarget(text.slice(3));
}

export function parsePsTarget(value: string): string | undefined {
  const target = value.trim();
  if (target === "") return "";
  if (target.startsWith("--")) return undefined;
  return target;
}

export function parseAgentRunCommand(text: string): ParsedAgentRunCommand | undefined {
  const runMatch = /^run\s+([\s\S]+)$/.exec(text);
  if (runMatch === null) return undefined;
  let rest = runMatch[1]!.trim();
  let approvalTier: CommandApprovalTier = "prompt";
  const overrideMatch = /^(--yes|--approve)(?:\s+([\s\S]+))?$/.exec(rest);
  if (overrideMatch !== null) {
    approvalTier = "allow";
    rest = overrideMatch[2]?.trim() ?? "";
  }
  // Optional `--title <quoted phrase|token>` before `<name> <task>` (REQ-003).
  let title: string | undefined;
  if (/^--title(?:\s|$)/.test(rest)) {
    const parsed = extractTitleFlag(rest);
    if (parsed === undefined) return undefined;
    title = parsed.title;
    rest = parsed.rest;
  }
  if (/^--\S+(?:\s|$)/.test(rest)) return undefined;
  const argsMatch = /^(\S+)\s+([\s\S]+)$/.exec(rest);
  if (argsMatch === null) return undefined;
  return { name: argsMatch[1]!, task: argsMatch[2]!, approvalTier, ...(title !== undefined ? { title } : {}) };
}

/**
 * Split a leading `--title` flag off a `/agent run` argument string. The value is
 * either a quoted phrase (`--title "review auth"`) or a single token
 * (`--title smoke`); returns undefined (→ usage error) when malformed or when no
 * `<name> <task>` remainder follows.
 */
function extractTitleFlag(rest: string): { title: string; rest: string } | undefined {
  const flag = /^--title\s+([\s\S]+)$/.exec(rest);
  if (flag === null) return undefined;
  const after = flag[1]!;
  const quoted = /^(["'])([\s\S]*?)\1\s*([\s\S]*)$/.exec(after);
  if (quoted !== null) {
    const title = quoted[2]!.trim();
    const remainder = quoted[3]!.trim();
    if (title === "" || remainder === "") return undefined;
    return { title, rest: remainder };
  }
  const token = /^(\S+)\s+([\s\S]+)$/.exec(after);
  if (token === null) return undefined;
  return { title: token[1]!, rest: token[2]!.trim() };
}
