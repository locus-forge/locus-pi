import type { WorkflowInputValue } from "../runtime/workflow-input.js";
/**
 * extensions/workflows/command/command-parser.ts — `/workflows` argument grammar.
 *
 * Pure text → intent. Each parser returns `null` when the text is not its
 * command at all, and a partial intent carrying an explicit `missing*` flag
 * when the command is recognised but incomplete. This module also owns the
 * shared run-grammar and value-preserving recovery presentation used by command
 * surfaces, so parsing and operator syntax cannot drift apart.
 */

import type { WorkflowTargetIdentity } from "../runtime/workflow-saved-name.js";

export interface ParsedRunCommand {
  scriptRef: string;
  input?: string;
  inputValue?: WorkflowInputValue;
  inputJSONError?: string;
  workspaceDir?: string;
  runName?: string;
  resumeFromRunId?: string;
  force?: true;
  noOperator?: boolean;
  obsoleteOutputDir?: true;
  missingWorkspaceDir?: boolean;
  missingRunName?: boolean;
  missingResumeId?: boolean;
}

export interface ParsedContinueCommand {
  runId?: string;
  answer?: string;
  missingAnswer?: boolean;
}

const WORKFLOW_RUN_OPTION_USAGE =
  "[--run-name <name> | --workspace-dir <path>] [--resume <runId>] [--force] [--no-operator|--operator] [--] [input] | --input-json <JSON tail>";

/** Reclaim only a leaked lease whose matching terminal envelope proves the prior run settled. */
export const WORKFLOW_RUN_FORCE_FLAG = "--force";

/** Value-less run flag: run-level no-operator mode (operator input fails closed). */
export const WORKFLOW_RUN_NO_OPERATOR_FLAG = "--no-operator";

/**
 * Value-less run flag: keep operator input available for this run. Only a
 * headless (`print`/`json`) launch needs it, where the mode is on by default;
 * it restores the designed `awaitOperator` split-run pause there.
 */
export const WORKFLOW_RUN_OPERATOR_FLAG = "--operator";

/** The value-less run flags and the `noOperator` value each one asserts. */
const WORKFLOW_RUN_MODE_FLAGS = [
  { name: WORKFLOW_RUN_NO_OPERATOR_FLAG, noOperator: true },
  { name: WORKFLOW_RUN_OPERATOR_FLAG, noOperator: false },
] as const;

export const WORKFLOW_RUN_OPTION_DESCRIPTORS = [
  { name: "--run-name", field: "runName" },
  { name: "--workspace-dir", field: "workspaceDir" },
  { name: "--resume", field: "resumeFromRunId" },
] as const;
export type WorkflowRunOptionDescriptor = (typeof WORKFLOW_RUN_OPTION_DESCRIPTORS)[number];

export function workflowRunOptionDescriptor(value: string): WorkflowRunOptionDescriptor | undefined {
  return WORKFLOW_RUN_OPTION_DESCRIPTORS.find((descriptor) => value === descriptor.name);
}

export function workflowRunOptionAtStart(
  value: string,
): { descriptor: WorkflowRunOptionDescriptor; after: string } | undefined {
  for (const descriptor of WORKFLOW_RUN_OPTION_DESCRIPTORS) {
    if (value === descriptor.name) return { descriptor, after: "" };
    const suffix = value.slice(descriptor.name.length);
    if (value.startsWith(descriptor.name) && /^\s/u.test(suffix)) {
      return { descriptor, after: suffix.trimStart() };
    }
  }
  return undefined;
}

export function scanWorkflowRunOptionTokens(rawTail: string): { tokens: string[]; endsWithSpace: boolean } | undefined {
  const tail = rawTail.trim();
  const tokens: string[] = [];
  let remaining = tail;
  while (remaining !== "") {
    const parsed = parseWorkflowCommandToken(remaining);
    if (parsed === undefined) return undefined;
    tokens.push(parsed.value);
    remaining = parsed.rest;
  }
  return { tokens, endsWithSpace: /\s$/u.test(rawTail) };
}

/** Canonical presentation of the run grammar for command, help, and recovery surfaces. */
export function workflowRunUsage(target = "<name|path>", command = "/workflows run"): string {
  return `${command} ${target} ${WORKFLOW_RUN_OPTION_USAGE}`;
}

/** Preserve accepted run options while showing the one missing value. */
export function workflowRunRecoveryUsage(parsed: ParsedRunCommand): string {
  const parts = ["/workflows run", formatWorkflowCommandToken(parsed.scriptRef)];
  if (parsed.missingRunName === true) {
    if (parsed.workspaceDir !== undefined)
      parts.push("--workspace-dir", formatWorkflowCommandToken(parsed.workspaceDir));
    if (parsed.runName !== undefined) parts.push("--run-name", formatWorkflowCommandToken(parsed.runName));
    parts.push("--run-name", "<name>");
  } else if (parsed.missingWorkspaceDir === true) {
    if (parsed.runName !== undefined) parts.push("--run-name", formatWorkflowCommandToken(parsed.runName));
    if (parsed.workspaceDir !== undefined)
      parts.push("--workspace-dir", formatWorkflowCommandToken(parsed.workspaceDir));
    parts.push("--workspace-dir", "<path>");
  } else {
    if (parsed.runName !== undefined) parts.push("--run-name", formatWorkflowCommandToken(parsed.runName));
    else if (parsed.workspaceDir !== undefined)
      parts.push("--workspace-dir", formatWorkflowCommandToken(parsed.workspaceDir));
    else parts.push("[--run-name <name> | --workspace-dir <path>]");
  }
  if (parsed.missingResumeId === true) {
    if (parsed.resumeFromRunId !== undefined)
      parts.push("--resume", formatWorkflowCommandToken(parsed.resumeFromRunId));
    parts.push("--resume", "<runId>");
  } else if (parsed.resumeFromRunId === undefined) {
    parts.push("[--resume <runId>]");
  } else {
    parts.push("--resume", formatWorkflowCommandToken(parsed.resumeFromRunId));
  }
  if (parsed.noOperator === true) parts.push(WORKFLOW_RUN_NO_OPERATOR_FLAG);
  else if (parsed.noOperator === false) parts.push(WORKFLOW_RUN_OPERATOR_FLAG);
  if (parsed.force === true) parts.push(WORKFLOW_RUN_FORCE_FLAG);
  parts.push("[--]", "[input]");
  return parts.join(" ");
}

/**
 * Encode one workflow target as one command token. Ordinary names and paths
 * stay readable; whitespace, controls, quotes, and backslashes use a JSON
 * string so editor-prefilled commands parse back to the exact same ref.
 */
export function formatWorkflowCommandToken(value: string): string {
  return /^[^\s"\\\u0000-\u001f\u007f-\u009f]+$/u.test(value) ? value : JSON.stringify(value);
}

/** Build the canonical editable run command for a resolved workflow target. */
export function buildWorkflowRunCommand(target: WorkflowTargetIdentity): string {
  return `/workflows run ${formatWorkflowCommandToken(target.ref)}`;
}

export function parseRunCommand(text: string): ParsedRunCommand | null {
  const prefix = /^run\s+/u.exec(text);
  if (prefix === null) return null;
  const target = parseWorkflowCommandToken(text.slice(prefix[0].length));
  if (target === undefined || target.value === "") return null;
  const scriptRef = target.value;
  // Keep one leading separator out of the first token, but retain the raw tail
  // until we know whether `--` switches the rest into semantic-input mode.
  let rest = target.rest.trimStart();
  let workspaceDir: string | undefined;
  let runName: string | undefined;
  let resumeFromRunId: string | undefined;
  let force = false;
  let noOperator: boolean | undefined;
  const missing = (option: WorkflowRunOptionDescriptor): ParsedRunCommand => ({
    scriptRef,
    ...(workspaceDir === undefined ? {} : { workspaceDir }),
    ...(runName === undefined ? {} : { runName }),
    ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    ...(force ? { force: true as const } : {}),
    ...(noOperator === undefined ? {} : { noOperator }),
    ...(option.field === "workspaceDir"
      ? { missingWorkspaceDir: true }
      : option.field === "runName"
        ? { missingRunName: true }
        : { missingResumeId: true }),
  });
  // Match the existing command-option convention: when an option is repeated
  // before semantic input, its last supplied value wins.
  while (true) {
    if (
      rest === "--output-dir" ||
      (rest.startsWith("--output-dir") && /^\s/u.test(rest.slice("--output-dir".length)))
    ) {
      return { scriptRef, obsoleteOutputDir: true };
    }
    if (
      rest === WORKFLOW_RUN_FORCE_FLAG ||
      (rest.startsWith(WORKFLOW_RUN_FORCE_FLAG) && /^\s/u.test(rest.slice(WORKFLOW_RUN_FORCE_FLAG.length)))
    ) {
      force = true;
      rest = rest === WORKFLOW_RUN_FORCE_FLAG ? "" : rest.slice(WORKFLOW_RUN_FORCE_FLAG.length).trimStart();
      continue;
    }
    const mode = WORKFLOW_RUN_MODE_FLAGS.find(
      (flag) => rest === flag.name || (rest.startsWith(flag.name) && /^\s/u.test(rest.slice(flag.name.length))),
    );
    if (mode !== undefined) {
      noOperator = mode.noOperator;
      rest = rest === mode.name ? "" : rest.slice(mode.name.length).trimStart();
      continue;
    }
    const matched = workflowRunOptionAtStart(rest);
    if (matched === undefined) break;
    const option = matched.descriptor;
    const after = matched.after;
    if (after === "") {
      return missing(option);
    }
    const value = parseWorkflowCommandToken(after);
    if (
      value === undefined ||
      value.value === "" ||
      value.value === "--" ||
      value.value === "--input-json" ||
      WORKFLOW_RUN_OPTION_DESCRIPTORS.some((descriptor) => value.value === descriptor.name) ||
      value.value === WORKFLOW_RUN_FORCE_FLAG ||
      WORKFLOW_RUN_MODE_FLAGS.some((flag) => value.value === flag.name)
    ) {
      return missing(option);
    }
    if (option.field === "workspaceDir") workspaceDir = value.value;
    else if (option.field === "runName") runName = value.value;
    else resumeFromRunId = value.value;
    rest = value.rest.trimStart();
  }
  const jsonOption = rest === "--input-json" || /^--input-json\s/u.test(rest);
  if (jsonOption) {
    const fields = {
      scriptRef,
      ...(workspaceDir === undefined ? {} : { workspaceDir }),
      ...(runName === undefined ? {} : { runName }),
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
      ...(force ? { force: true as const } : {}),
      ...(noOperator === undefined ? {} : { noOperator }),
    };
    try {
      return { ...fields, inputValue: JSON.parse(rest.slice("--input-json".length).trimStart()) as WorkflowInputValue };
    } catch {
      return {
        ...fields,
        inputJSONError: "--input-json requires one complete JSON value as the entire remaining tail",
      };
    }
  }
  if (!/^--(?:\s|$)/u.test(rest) && /(?:^|\s)--input-json(?:\s|$)/u.test(rest))
    return { scriptRef, inputJSONError: "--input-json cannot be mixed with legacy text input" };
  if (rest === "--") {
    return {
      scriptRef,
      ...(workspaceDir === undefined ? {} : { workspaceDir }),
      ...(runName === undefined ? {} : { runName }),
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
      ...(force ? { force: true as const } : {}),
      ...(noOperator === undefined ? {} : { noOperator }),
    };
  }
  if (/^--\s/u.test(rest)) {
    const input = rest.slice(3);
    return {
      scriptRef,
      ...(workspaceDir === undefined ? {} : { workspaceDir }),
      ...(runName === undefined ? {} : { runName }),
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
      ...(force ? { force: true as const } : {}),
      ...(noOperator === undefined ? {} : { noOperator }),
      ...(input === "" ? {} : { input }),
    };
  }
  const input = rest.trim();
  return {
    scriptRef,
    ...(workspaceDir === undefined ? {} : { workspaceDir }),
    ...(runName === undefined ? {} : { runName }),
    ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    ...(force ? { force: true as const } : {}),
    ...(noOperator === undefined ? {} : { noOperator }),
    ...(input === "" ? {} : { input }),
  };
}

export function parseWorkflowCommandToken(text: string): { value: string; rest: string } | undefined {
  if (text.startsWith('"')) {
    const match = /^"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001f])*"/u.exec(text);
    if (match === null) return undefined;
    const token = match[0];
    const rest = text.slice(token.length);
    if (rest !== "" && !/^\s/u.test(rest)) return undefined;
    try {
      const value: unknown = JSON.parse(token);
      return typeof value === "string" ? { value, rest: rest.trimStart() } : undefined;
    } catch {
      return undefined;
    }
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
  return match === null ? undefined : { value: match[1] ?? "", rest: match[2] ?? "" };
}

export function parseContinueCommand(text: string): ParsedContinueCommand | null {
  if (text === "continue") return {};
  const match = /^continue\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  const runId = match[1];
  const tail = (match[2] ?? "").trim();
  if (runId === undefined || runId === "") return {};
  if (tail === "") return { runId };
  if (tail === "--answer") return { runId, missingAnswer: true };
  if (!tail.startsWith("--answer ")) return { runId, missingAnswer: true };
  const answer = tail.slice("--answer ".length).trim();
  return answer === "" ? { runId, missingAnswer: true } : { runId, answer };
}
