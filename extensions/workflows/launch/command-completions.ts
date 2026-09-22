/**
 * extensions/workflows/launch/command-completions.ts — Argument completions for
 * `/workflows` and the retained flat `/workflow-stop` alias.
 *
 * The `/workflows` grammar is the source of truth: the flat aliases delegate
 * here and strip their own verb back off, so a token can never be completed
 * one way on one command and another way on the other.
 */

import type { CommandArgumentCompletion } from "../../_shared/host/pi-api.js";
import { listWorkflowRootRunIds, listWorkflowRunIds } from "../runtime/workflow-journal.js";
import {
  formatWorkflowCommandToken,
  parseWorkflowCommandToken,
  scanWorkflowRunOptionTokens,
  workflowRunOptionDescriptor,
  WORKFLOW_RUN_OPTION_DESCRIPTORS,
} from "../command/command-parser.js";
import { WORKFLOW_WORKSPACES_STORAGE_PREFIX } from "../runtime/workflow-run-layout.js";
import { listExampleNames } from "../operator/operator-ui.js";
import { listWorkflowCatalogTargets } from "../runtime/workflow-discovery.js";

export function workflowArgumentCompletions(
  rawPrefix: string,
  projectRoot: string,
  workingDirectory = projectRoot,
  actionableRunIds?: readonly string[],
): CommandArgumentCompletion[] | null {
  const prefix = rawPrefix.replace(/^\s+/u, "");
  const rootCommands: CommandArgumentCompletion[] = [
    { value: "dashboard", label: "dashboard", description: "Open persisted run dashboard" },
    { value: "list ", label: "list", description: "Browse workflow catalog" },
    { value: "info ", label: "info", description: "Show one workflow" },
    { value: "status ", label: "status", description: "Inspect persisted run status" },
    { value: "result ", label: "result", description: "Read a finished run result" },
    { value: "run ", label: "run", description: "Start a workflow" },
    { value: "continue ", label: "continue", description: "Answer a workflow handoff" },
    { value: "stop ", label: "stop", description: "Stop a workflow explicitly" },
    { value: "skills ", label: "skills", description: "Manage workflow skills for external agents" },
  ];
  if (!prefix.includes(" ")) return matchingCompletions(rootCommands, prefix);
  if (prefix.startsWith("list ")) return null;
  if (prefix.startsWith("skills ")) return workflowSkillCompletions(prefix);

  const runIds = (): string[] => listWorkflowRunIds(projectRoot).slice(0, 20);
  const rootRunIds = (): string[] => listWorkflowRootRunIds(projectRoot).slice(0, 20);
  const continuationRunIds = (): readonly string[] => actionableRunIds?.slice(0, 20) ?? runIds();
  const workflowNames = (): string[] => {
    try {
      return listWorkflowCatalogTargets(projectRoot, workingDirectory).map((target) => target.ref);
    } catch {
      return listExampleNames();
    }
  };
  if (prefix.startsWith("info ")) {
    return workflowNameCompletions("info", prefix.slice("info ".length), workflowNames());
  }
  if (prefix.startsWith("status ")) {
    return matchingCompletions(
      runIds().map((runId) => ({ value: `status ${runId}`, label: runId })),
      prefix,
    );
  }
  if (prefix.startsWith("result ")) {
    return matchingCompletions(
      [
        { value: "result last", label: "last", description: "Most recently started run" },
        ...runIds().map((runId) => ({ value: `result ${runId}`, label: runId })),
      ],
      prefix,
    );
  }
  if (prefix.startsWith("continue ")) {
    const completions = workflowContinueArgumentCompletions(prefix.slice("continue ".length), continuationRunIds());
    return (
      completions?.map((completion) => ({
        ...completion,
        value: `continue ${completion.value}`,
      })) ?? null
    );
  }
  if (prefix.startsWith("stop ")) {
    return matchingCompletions(
      [
        { value: "stop last", label: "last", description: "Most recently started run" },
        ...rootRunIds().map((runId) => ({ value: `stop ${runId}`, label: runId })),
      ],
      prefix,
    );
  }
  if (!prefix.startsWith("run ")) return null;

  const runTail = prefix.slice("run ".length);
  const parsedTarget = parseWorkflowCommandToken(runTail);
  if (parsedTarget === undefined) {
    return runTail === "" || runTail.startsWith('"') ? workflowNameCompletions("run", runTail, workflowNames()) : null;
  }
  if (parsedTarget.value.includes("/") && !workflowNames().includes(parsedTarget.value)) return null;
  const targetToken = formatWorkflowCommandToken(parsedTarget.value);
  const targetIsComplete = parsedTarget.rest !== "" || /\s$/u.test(runTail);
  if (!targetIsComplete) {
    return workflowNameCompletions("run", parsedTarget.value, workflowNames());
  }

  return workflowRunOptionCompletions(targetToken, parsedTarget.rest === "" ? " " : ` ${parsedTarget.rest}`, runIds());
}

function workflowSkillCompletions(prefix: string): CommandArgumentCompletion[] | null {
  const actions = ["sync", "status", "remove"] as const;
  const tokens = prefix.trimEnd().split(/\s+/u);
  const endsWithSpace = /\s$/u.test(prefix);
  if (tokens.length === 2 && !endsWithSpace) {
    return matchingCompletions(
      actions.map((action) => ({ value: `skills ${action} `, label: action })),
      prefix,
    );
  }
  if (tokens.length === 1) {
    return actions.map((action) => ({ value: `skills ${action} `, label: action }));
  }
  const action = tokens[1];
  if (!actions.includes(action as (typeof actions)[number])) return null;
  if (tokens.at(-1) === "--host") {
    return ["codex", "claude", "all"].map((host) => ({
      value: `${prefix}${host} `,
      label: host,
    }));
  }
  if (tokens.at(-1) === "--scope") {
    return ["user", "project"].map((scope) => ({
      value: `${prefix}${scope} `,
      label: scope,
    }));
  }
  if (!endsWithSpace) return null;
  const usedHost = tokens.includes("--host");
  const usedScope = tokens.includes("--scope");
  return [
    ...(usedHost ? [] : [{ value: `${prefix}--host `, label: "--host" }]),
    ...(usedScope ? [] : [{ value: `${prefix}--scope `, label: "--scope" }]),
  ];
}

function workflowRunOptionCompletions(
  target: string,
  rawTail: string,
  runIds: readonly string[],
): CommandArgumentCompletion[] | null {
  const endsWithSpace = /\s$/u.test(rawTail);
  const scanned = scanWorkflowRunOptionTokens(rawTail);
  if (scanned === undefined) return null;
  const tokens = scanned.tokens;
  const completed: string[] = [];
  const commandPrefix = `run ${target}`;

  const optionCompletions = (partial = ""): CommandArgumentCompletion[] => {
    const stem = `${commandPrefix}${completed.length === 0 ? "" : ` ${completed.join(" ")}`} `;
    const hasOutputDir = completed.includes("--output-dir");
    const hasRunName = completed.includes("--run-name");
    return [
      ...WORKFLOW_RUN_OPTION_DESCRIPTORS.filter(
        (descriptor) =>
          !(descriptor.field === "runName" && hasOutputDir) && !(descriptor.field === "outputDir" && hasRunName),
      ).map((descriptor) => ({
        value: `${stem}${descriptor.name} `,
        label: descriptor.name,
        description:
          descriptor.field === "outputDir"
            ? "Select a workflow workspace path"
            : descriptor.field === "runName"
              ? `Use ${WORKFLOW_WORKSPACES_STORAGE_PREFIX}<name> for this workflow`
              : "Resume from a prior run",
      })),
      {
        value: `${stem}-- `,
        label: "--",
        description: "Pass the remaining text unchanged as semantic input",
      },
    ].filter((completion) => completion.label.startsWith(partial));
  };

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      // End-of-options switches the rest to opaque semantic input. Never offer
      // option completions once that boundary has been crossed.
      return null;
    }
    const descriptor = workflowRunOptionDescriptor(token);
    if (descriptor === undefined) {
      return index === tokens.length - 1 && !endsWithSpace && token.startsWith("-") ? optionCompletions(token) : null;
    }
    const value = tokens[index + 1];
    if (value === undefined) {
      if (descriptor?.field === "outputDir" || descriptor?.field === "runName") return null;
      const resumePrefix = `${commandPrefix}${completed.length === 0 ? "" : ` ${completed.join(" ")}`} --resume `;
      return matchingCompletions(
        runIds.map((runId) => ({ value: `${resumePrefix}${runId}`, label: runId })),
        resumePrefix,
      );
    }
    if (value.startsWith("--")) return null;
    if (descriptor.field === "resumeFromRunId" && index + 1 === tokens.length - 1 && !endsWithSpace) {
      const resumePrefix = `${commandPrefix}${completed.length === 0 ? "" : ` ${completed.join(" ")}`} --resume `;
      return matchingCompletions(
        runIds.map((runId) => ({ value: `${resumePrefix}${runId}`, label: runId })),
        `${resumePrefix}${value}`,
      );
    }

    completed.push(token, formatWorkflowCommandToken(value));
    index += 2;
  }

  return endsWithSpace ? optionCompletions() : null;
}

export function workflowFlatCommandCompletions(
  command: WorkflowCompletionCommand,
  rawPrefix: string,
  projectRoot: string,
  workingDirectory = projectRoot,
  actionableRunIds?: readonly string[],
): CommandArgumentCompletion[] | null {
  if (command === "list") return null;
  if (command === "continue") {
    return workflowContinueArgumentCompletions(rawPrefix, actionableRunIds ?? listWorkflowRunIds(projectRoot));
  }

  const prefix = rawPrefix.replace(/^\s+/u, "");
  const delegated = workflowArgumentCompletions(
    prefix === "" ? `${command} ` : `${command} ${prefix}`,
    projectRoot,
    workingDirectory,
  );
  if (delegated === null) return null;
  const verbPrefix = `${command} `;
  return delegated.map((completion) => ({
    ...completion,
    value: completion.value.startsWith(verbPrefix) ? completion.value.slice(verbPrefix.length) : completion.value,
  }));
}

type WorkflowCompletionCommand = "run" | "stop" | "list" | "info" | "status" | "result" | "continue";

function workflowContinueArgumentCompletions(
  rawPrefix: string,
  actionableRunIds: readonly string[],
): CommandArgumentCompletion[] | null {
  const prefix = rawPrefix.replace(/^\s+/u, "");
  const firstSpace = prefix.search(/\s/u);
  const runIdPrefix = firstSpace < 0 ? prefix : prefix.slice(0, firstSpace);
  const runIds = actionableRunIds.slice(0, 20);
  if (firstSpace < 0) {
    return matchingCompletions(
      runIds.map((runId) => ({ value: runId, label: runId })),
      runIdPrefix,
    );
  }
  if (!runIds.includes(runIdPrefix)) return [];
  const tail = prefix.slice(firstSpace);
  if (" --answer ".startsWith(tail)) {
    return [
      {
        value: `${runIdPrefix} --answer `,
        label: "--answer",
        description: "Supply one explicit noninteractive answer",
      },
    ];
  }
  return null;
}

function matchingCompletions(completions: CommandArgumentCompletion[], prefix: string): CommandArgumentCompletion[] {
  const normalizedPrefix = prefix.toLowerCase();
  return completions.filter((item) => item.value.toLowerCase().startsWith(normalizedPrefix));
}

function workflowNameCompletions(
  command: "info" | "run",
  rawNamePrefix: string,
  names: readonly string[],
): CommandArgumentCompletion[] {
  const parsedPrefix = parseWorkflowCommandToken(rawNamePrefix);
  const labelPrefix =
    parsedPrefix !== undefined && parsedPrefix.rest === ""
      ? parsedPrefix.value
      : rawNamePrefix.startsWith('"')
        ? rawNamePrefix.slice(1)
        : rawNamePrefix;
  const normalizedPrefix = labelPrefix.toLowerCase();
  return names
    .filter((name) => name.toLowerCase().startsWith(normalizedPrefix))
    .map((name) => ({ value: `${command} ${formatWorkflowCommandToken(name)}`, label: name }));
}
