/** Opt-in `fusion` tool plus the `/fusion` operator command. */

import { Type } from "@sinclair/typebox";
import { registerCommandWithUiLifecycle } from "../../_shared/operator/command-ui.js";
import type {
  CommandArgumentCompletion,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolUpdate,
} from "../../_shared/host/pi-api.js";
import {
  errorResult,
  getCommandText,
  getProjectRoot,
  registerToolWithErrorResults,
  setTextWidget,
  textResult,
} from "../../_shared/host/pi-api.js";
import { validateParams } from "../../_shared/host/validation.js";
import { applyWorkflowJournalLineToAgentLiveStore } from "../runtime/workflow-live.js";
import { installWorkflowProgress } from "../operator/progress-widget.js";
import {
  FUSION_CONFIG_VERSION,
  FUSION_CONFIG_UPGRADED_MESSAGE,
  FUSION_TOOL_NAME,
  availableFusionModels,
  loadFusionConfig,
  loadFusionConfigForConfigure,
  parseFusionSetArgs,
  saveFusionConfig,
  validateFusionConfig,
  type AvailableFusionModel,
  type FusionConfig,
  type ValidatedFusionConfig,
} from "./config.js";
import { runDirectFusion, type DirectFusionRunOptions, type DirectFusionRunResult } from "./runner.js";

const FUSION_WIDGET_KEY = "fusion";
const FUSION_PROGRESS_WIDGET_KEY = "fusion-live";
const FUSION_DEFAULT_OUTPUT =
  "Answer the question directly. Return only the final answer, not a discussion of candidates.";

// Non-blank is the only length contract here. Each of these three fields is the CALLER'S
// input — the question it wants answered, the context it chose to forward, the format it
// wants back — and a tool that refused a long question would be applying a size policy to
// work nobody has done yet. `minLength: 1` stays because an empty question is not a short
// question, it is a missing one.
const FusionToolParams = Type.Object(
  {
    question: Type.String({
      description: "One complete standalone question. Ambient parent-session history is not forwarded.",
      minLength: 1,
    }),
    context: Type.Optional(
      Type.String({
        description: "Optional explicit context forwarded verbatim to every panel member. Do not include secrets.",
        minLength: 1,
      }),
    ),
    output: Type.Optional(
      Type.String({
        description: "Optional instruction defining the judge's final answer format.",
        minLength: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export interface FusionSurfaceDependencies {
  runFusion?: (options: DirectFusionRunOptions) => Promise<DirectFusionRunResult>;
}

export function registerFusionSurface(pi: ExtensionAPI, dependencies: FusionSurfaceDependencies = {}): void {
  const runFusion = dependencies.runFusion ?? runDirectFusion;
  registerToolWithErrorResults(pi, {
    name: FUSION_TOOL_NAME,
    description:
      "Ask the project-configured panel of independent LLMs one standalone question, then return the separately configured judge model's synthesized answer. Fusion does not inherit ambient chat history; pass only explicit relevant context. The tool is opt-in and is unavailable until `/fusion` configures and enables it.",
    parameters: FusionToolParams,
    approval: "exec",
    formatApprovalDetails: () => ["Surface: configured multi-model Fusion", "Context: standalone question only"],
    async execute(_toolCallId, params, signal, update, ctx) {
      const valid = validateParams(FusionToolParams, params);
      if (!valid.ok) return valid.result;
      try {
        const config = await enabledFusionConfig(ctx);
        const result = await executeFusion(pi, ctx, signal, update, valid.value, config, runFusion);
        if (!result.ok || result.result === undefined) {
          return errorResult(
            result.error ?? "Fusion failed without a final answer.",
            fusionResultDetails(result, config),
          );
        }
        return textResult(result.result, fusionResultDetails(result, config));
      } catch (error) {
        return errorResult(errorMessage(error), { owner: "fusion" });
      }
    },
  });

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "fusion",
      group: "fusion",
      surfaces: ["transient-widget", "persistent-state", "artifact-write", "no-ui"],
      transientWidgets: [FUSION_WIDGET_KEY, FUSION_PROGRESS_WIDGET_KEY],
    },
    {
      description:
        "Usage: /fusion [status|configure|set --mode tool-free|agent --members provider/id,provider/id --judge provider/id|enable|disable|run <question>]",
      getArgumentCompletions: fusionCommandCompletions,
      handler: (args, ctx) => handleFusionCommand(pi, ctx, getCommandText(args), runFusion),
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    try {
      const config = await loadFusionConfig(ctx);
      const available = await availableFusionModels(ctx);
      if (!config.enabled) {
        setFusionToolActive(pi, false);
        return;
      }
      validateFusionConfig(config, available);
      setFusionToolActive(pi, true);
    } catch (error) {
      setFusionToolActive(pi, false);
      ctx.ui.notify(`Fusion remains inactive: ${errorMessage(error)}`, "warning");
    }
  });
}

async function handleFusionCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  raw: string,
  runFusion: (options: DirectFusionRunOptions) => Promise<DirectFusionRunResult>,
): Promise<void> {
  const text = raw.trim();
  const [command = "", ...rest] = text.split(/\s+/u);

  try {
    const action = command === "" ? await selectFusionAction(ctx) : command.toLowerCase();
    if (action === undefined) return;
    switch (action) {
      case "status":
        await presentFusionStatus(pi, ctx);
        return;
      case "configure":
        await configureFusionInteractively(pi, ctx);
        return;
      case "set":
        await configureFusionFromArgs(pi, ctx, rest.join(" "));
        return;
      case "enable":
        await enableFusion(pi, ctx);
        return;
      case "disable":
        await disableFusion(pi, ctx);
        return;
      case "run":
        await runFusionCommand(pi, ctx, await fusionQuestion(ctx, rest.join(" ")), runFusion);
        return;
      default:
        throw new Error(
          "Usage: /fusion [status|configure|set --mode tool-free|agent --members provider/id,provider/id --judge provider/id|enable|disable|run <question>]",
        );
    }
  } catch (error) {
    presentFusionBlock(ctx, `Fusion error\n${errorMessage(error)}`);
  }
}

async function selectFusionAction(ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (ctx.mode !== "tui" || ctx.hasUI === false) return "status";
  const current = await loadFusionConfigForConfigure(ctx);
  const state = current.upgraded ? "configuration review required" : current.config.enabled ? "enabled" : "disabled";
  return selectValue(
    await ctx.ui.select(`Fusion · ${state}`, [
      { label: "Status", value: "status" },
      { label: "Configure models", value: "configure" },
      { label: "Enable tool", value: "enable" },
      { label: "Disable tool", value: "disable" },
      { label: "Run now", value: "run" },
    ]),
  );
}

async function configureFusionInteractively(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui" || ctx.hasUI === false) {
    throw new Error(
      "Interactive Fusion configuration requires TUI mode. Use /fusion set --mode tool-free|agent --members provider/id,provider/id --judge provider/id.",
    );
  }
  const available = await availableFusionModels(ctx);
  if (available.length < 3) throw new Error("Fusion needs at least three available models: two members and one judge.");
  const maximumMembers = Math.min(10, available.length - 1);
  const mode = selectValue(
    await ctx.ui.select("Fusion mode", [
      { label: "Tool-free", value: "tool-free" },
      { label: "Agent", value: "agent" },
    ]),
  );
  if (mode !== "tool-free" && mode !== "agent") return;
  const countValue = selectValue(
    await ctx.ui.select(
      "Fusion member count",
      Array.from({ length: maximumMembers - 1 }, (_, index) => String(index + 2)),
    ),
  );
  if (countValue === undefined) return;
  const count = Number(countValue);
  const selected: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const choice = await chooseModel(ctx, `Fusion member ${index + 1} of ${count}`, available, selected);
    if (choice === undefined) return;
    selected.push(choice);
  }
  const judge = await chooseModel(ctx, "Fusion judge", available, selected);
  if (judge === undefined) return;
  const current = await loadFusionConfigForConfigure(ctx);
  const next: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    enabled: current.upgraded ? false : current.config.enabled,
    mode,
    members: selected,
    judge,
  };
  validateFusionConfig(next, available);
  await saveFusionConfig(ctx, next);
  setFusionToolActive(pi, next.enabled);
  presentFusionBlock(
    ctx,
    `${fusionStatusText(next, next.enabled)}${current.upgraded ? `\n${FUSION_CONFIG_UPGRADED_MESSAGE}` : ""}`,
  );
}

async function configureFusionFromArgs(pi: ExtensionAPI, ctx: ExtensionCommandContext, raw: string): Promise<void> {
  const selection = parseFusionSetArgs(raw);
  const available = await availableFusionModels(ctx);
  const current = await loadFusionConfigForConfigure(ctx);
  const next: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    enabled: current.upgraded ? false : current.config.enabled,
    ...selection,
  };
  validateFusionConfig(next, available);
  await saveFusionConfig(ctx, next);
  setFusionToolActive(pi, next.enabled);
  presentFusionBlock(
    ctx,
    `${fusionStatusText(next, next.enabled)}${current.upgraded ? `\n${FUSION_CONFIG_UPGRADED_MESSAGE}` : ""}`,
  );
}

async function enableFusion(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const current = await loadFusionConfig(ctx);
  validateFusionConfig(current, await availableFusionModels(ctx));
  const next = { ...current, enabled: true };
  await saveFusionConfig(ctx, next);
  setFusionToolActive(pi, true);
  presentFusionBlock(ctx, fusionStatusText(next, true));
}

async function disableFusion(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const current = await loadFusionConfig(ctx);
  const next = { ...current, enabled: false };
  await saveFusionConfig(ctx, next);
  setFusionToolActive(pi, false);
  presentFusionBlock(ctx, fusionStatusText(next, false));
}

async function presentFusionStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const config = await loadFusionConfig(ctx);
  let valid = false;
  let problem: string | undefined;
  try {
    validateFusionConfig(config, await availableFusionModels(ctx));
    valid = true;
  } catch (error) {
    problem = errorMessage(error);
  }
  const active = pi.getActiveTools().includes(FUSION_TOOL_NAME);
  presentFusionBlock(ctx, `${fusionStatusText(config, active)}${valid ? "" : `\nProblem: ${problem}`}`);
}

async function runFusionCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  question: string,
  runFusion: (options: DirectFusionRunOptions) => Promise<DirectFusionRunResult>,
): Promise<void> {
  if (question.trim() === "") throw new Error("Usage: /fusion run <complete standalone question>");
  const config = await enabledFusionConfig(ctx);
  const controller = new AbortController();
  const result = await executeFusion(pi, ctx, controller.signal, () => {}, { question }, config, runFusion);
  if (!result.ok || result.result === undefined)
    throw new Error(result.error ?? "Fusion failed without a final answer.");
  await pi.sendMessage?.({
    customType: "fusion-result",
    content: result.result,
    display: true,
    details: fusionResultDetails(result, config),
  });
  presentFusionBlock(ctx, `Fusion completed\nrunId: ${result.runId}\nrunDir: ${result.runDir}`);
}

async function fusionQuestion(ctx: ExtensionCommandContext, raw: string): Promise<string> {
  if (raw.trim() !== "") return raw;
  if (ctx.mode !== "tui" || ctx.hasUI === false) return raw;
  const result = await ctx.ui.editor("Fusion question", "");
  return result.cancelled === true ? "" : result.value;
}

async function enabledFusionConfig(ctx: ExtensionContext): Promise<ValidatedFusionConfig> {
  const config = await loadFusionConfig(ctx);
  if (!config.enabled) throw new Error("Fusion is disabled. Configure it with /fusion, then run /fusion enable.");
  return validateFusionConfig(config, await availableFusionModels(ctx));
}

async function executeFusion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal: AbortSignal,
  update: ToolUpdate,
  input: { question: string; context?: string; output?: string },
  config: ValidatedFusionConfig,
  runFusion: (options: DirectFusionRunOptions) => Promise<DirectFusionRunResult>,
): Promise<DirectFusionRunResult> {
  const panel = installWorkflowProgress(ctx, FUSION_PROGRESS_WIDGET_KEY, "fusion", "starting", { scope: "workflow" });
  try {
    const result = await runFusion({
      pi,
      ctx,
      signal,
      question: input.question,
      mode: config.mode,
      members: config.members,
      judge: config.judge,
      ...(input.context === undefined ? {} : { context: { mode: "provided", text: input.context } }),
      output: input.output ?? FUSION_DEFAULT_OUTPUT,
      onEvent(line) {
        applyWorkflowJournalLineToAgentLiveStore(line, getProjectRoot(ctx));
        panel.push(line);
        update({ content: [{ type: "text", text: `Fusion running\nrunId: ${line.runId}` }] });
      },
    });
    panel.finish(result);
    return result;
  } catch (error) {
    panel.finish({ ok: false, error: errorMessage(error), result: undefined, disposition: { status: "failed" } });
    throw error;
  }
}

function setFusionToolActive(pi: ExtensionAPI, enabled: boolean): void {
  const withoutFusion = pi.getActiveTools().filter((name) => name !== FUSION_TOOL_NAME);
  pi.setActiveTools(enabled ? [...withoutFusion, FUSION_TOOL_NAME] : withoutFusion);
}

async function chooseModel(
  ctx: ExtensionCommandContext,
  title: string,
  available: readonly AvailableFusionModel[],
  excluded: readonly string[],
): Promise<string | undefined> {
  const excludedSet = new Set(excluded);
  const choices = available
    .filter((model) => !excludedSet.has(model.selector))
    .map((model) => ({ label: model.label, value: model.selector }));
  return selectValue(await ctx.ui.select(title, choices));
}

function selectValue(value: Awaited<ReturnType<ExtensionContext["ui"]["select"]>>): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value.cancelled === true) return undefined;
  return value.value || value.label;
}

function fusionCommandCompletions(prefix: string): CommandArgumentCompletion[] {
  const commands = ["status", "configure", "set", "enable", "disable", "run"];
  const normalized = prefix.trim().toLowerCase();
  return commands
    .filter((command) => command.startsWith(normalized))
    .map((command) => ({ value: command, label: command }));
}

function fusionStatusText(config: FusionConfig, active: boolean): string {
  return [
    `Fusion: ${config.enabled ? "enabled" : "disabled"}`,
    `Mode: ${config.mode}`,
    `Tool active: ${active ? "yes" : "no"}`,
    `Members (${config.members.length}): ${config.members.length === 0 ? "not configured" : config.members.join(", ")}`,
    `Judge: ${config.judge ?? "not configured"}`,
  ].join("\n");
}

function presentFusionBlock(ctx: ExtensionContext, text: string): void {
  setTextWidget(ctx, FUSION_WIDGET_KEY, text, { placement: "belowEditor" });
}

function fusionResultDetails(result: DirectFusionRunResult, config: ValidatedFusionConfig): Record<string, unknown> {
  return {
    owner: "fusion",
    mode: config.mode,
    runId: result.runId,
    runDir: result.runDir,
    members: config.members.map((member) => member.model),
    judge: config.judge.model,
    disposition: result.disposition,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
