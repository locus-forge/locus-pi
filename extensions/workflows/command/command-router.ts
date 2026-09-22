/**
 * extensions/workflows/command/command-router.ts — The `/workflows` command surface.
 *
 * Parses the command text, routes it to one operator surface (help, catalog,
 * info, dashboard, status, result, skills, stop, continue, run), and registers the
 * the emergency `/workflow-stop` alias into the same grammar. Everything
 * it needs from the session — the launcher, the handoff pump, the completion
 * context — arrives as injected dependencies, never as module state.
 */

import type { CommandArgs, ExtensionAPI, ExtensionCommandContext } from "../../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot, getWorkingDirectory } from "../../_shared/host/pi-api.js";
import { registerCommandWithUiLifecycle } from "../../_shared/operator/command-ui.js";
import {
  isStaleInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../../_shared/operator/operator-interaction.js";
import { setOperatorWidget } from "../../_shared/operator/widget-render.js";
import { listWorkflowRunIds, readWorkflowRunResultText, resolveWorkflowRunId } from "../runtime/workflow-journal.js";
import { WORKFLOW_RUN_GROUP_STORAGE_PATTERN } from "../runtime/workflow-run-layout.js";
import { WorkflowCatalogViewer, WorkflowInfoViewer } from "../catalog/catalog-viewer.js";
import { workflowArgumentCompletions, workflowFlatCommandCompletions } from "../launch/command-completions.js";
import {
  buildWorkflowRunCommand,
  formatWorkflowCommandToken,
  parseContinueCommand,
  parseWorkflowCommandToken,
} from "./command-parser.js";
import type { WorkflowHandoffPumpResult } from "../operator/operator-handoff-controller.js";
import { clearWorkflowWidget, presentWorkflowHandoffPumpResult } from "../operator/operator-surface.js";
import {
  ambiguousWorkflowRunBlock,
  assertNever,
  errorMessage,
  listExampleNames,
  workflowCopyBlock,
  workflowHelpBlock,
  workflowStopBlock,
  workflowUnknownCommandBlock,
  workflowWarningBlock,
} from "../operator/operator-ui.js";
import { copyWorkflowNamespace } from "../catalog/workflow-copy.js";
import { WORKFLOW_LIVE_WIDGET_KEY } from "../operator/progress-widget.js";
import { WorkflowResultViewer, WorkflowRunViewer } from "../run/run-viewer.js";
import {
  buildRunDetailBlock,
  buildRunsListBlock,
  RUNS_IN_STATUS_LIST,
  WORKFLOW_RPC_STATUS_ROWS,
} from "../run/run-evidence.js";
import {
  buildWorkflowActionPrompt,
  buildWorkflowCatalogBlockFromModel,
  buildWorkflowCatalogModel,
  buildWorkflowInfoBlock,
  type WorkflowBrowserIntent,
} from "../catalog/workflow-catalog.js";
import type { WorkflowCommandLauncher } from "../launch/workflow-command-launcher.js";
import { handleWorkflowRunCommand } from "./run.js";
import { presentWorkflowSkillHostCommand } from "./skills.js";

/** Canonical ordered root menu data for the `/workflows` command. */
const WORKFLOW_MENU_DESCRIPTIONS = {
  dashboard: "inspect persisted runs and evidence",
  list: "browse available workflows",
  info: "inspect one workflow's details",
  status: "view recent run progress",
  result: "read a finished run's output",
  run: "start a workflow",
  continue: "answer a pending handoff",
  stop: "stop an active run",
  skills: "install workflow skills for external agents",
} as const;

type WorkflowMenuCommand = keyof typeof WORKFLOW_MENU_DESCRIPTIONS;

const WORKFLOW_MENU_OPTIONS = (Object.keys(WORKFLOW_MENU_DESCRIPTIONS) as WorkflowMenuCommand[]).map((command) => ({
  command,
  label: `${command} — ${WORKFLOW_MENU_DESCRIPTIONS[command]}`,
}));

/** Bounded preview for hosts without custom UI; the file path carries the rest. */
const WORKFLOW_RESULT_WIDGET_LINES = 40;
const WORKFLOW_MENU_OPTION_LIMIT = 20;
/** Pi 0.83 throttles TUI renders to a 16 ms frame. Let a closed native selector restore the editor first. */
const NATIVE_SELECTOR_TEARDOWN_MS = 20;
/** Clearing an unused status is the host API's no-visible-change way to request the post-prefill render. */
const WORKFLOW_EDITOR_PREFILL_RENDER_STATUS_KEY = "workflows:editor-prefill-render";

type WorkflowMenuSelection =
  { status: "selected"; value: string } | { status: "dismissed" } | { status: "failed"; message: string };

const FLAT_WORKFLOW_COMMANDS = ["stop"] as const;

export type FlatWorkflowCommand = (typeof FLAT_WORKFLOW_COMMANDS)[number];

export interface WorkflowCommandRouterDependencies {
  commandLauncher: WorkflowCommandLauncher;
  /** Open, answer, or advance the oldest actionable handoff for this session. */
  pumpCurrentHandoffs: (
    ctx: ExtensionCommandContext,
    options?: { runId?: string; answer?: string },
  ) => Promise<WorkflowHandoffPumpResult>;
  /** Latch the roots a later completion callback has to answer from. */
  rememberCompletionContext: (ctx: ExtensionCommandContext) => void;
  completionContext: () => { projectRoot: string; workingDirectory: string };
  actionableRunIds: (projectRoot: string) => string[];
}

export function registerWorkflowCommands(pi: ExtensionAPI, deps: WorkflowCommandRouterDependencies): void {
  const { commandLauncher, pumpCurrentHandoffs, rememberCompletionContext } = deps;

  const handleWorkflowCommand = async (args: CommandArgs, ctx: ExtensionCommandContext): Promise<void> => {
    const rawText = getCommandText(args);
    const text = rawText.trim();
    const projectRoot = getProjectRoot(ctx);
    rememberCompletionContext(ctx);

    // Bare `/workflows` is the interactive command chooser. Noninteractive
    // hosts receive the same grammar as a read-only block instead of a prompt.
    if (text === "") {
      clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
      if (workflowMenuAvailable(ctx)) {
        await openWorkflowCommandMenu(
          ctx,
          projectRoot,
          getWorkingDirectory(ctx),
          commandLauncher,
          deps.actionableRunIds,
          (command) => handleWorkflowCommand(command, ctx),
        );
      } else {
        setOperatorWidget(ctx, "workflows", workflowHelpBlock());
      }
      return;
    }

    // `/workflows dashboard` — persisted run/stage/evidence browser. RPC and
    // hosts without custom UI retain the same bounded disk-backed list.
    if (text === "dashboard") {
      if (await openWorkflowRunViewer(ctx, projectRoot)) return;
      setOperatorWidget(
        ctx,
        "workflows",
        buildRunsListBlock(
          projectRoot,
          ctx.mode === "tui" ? RUNS_IN_STATUS_LIST : WORKFLOW_RPC_STATUS_ROWS,
          ctx.mode !== "tui",
        ),
      );
      return;
    }

    // `/workflows list [query]` — operator catalog over the existing sources.
    const listMatch = /^list(?:\s+([\s\S]+))?$/.exec(text);
    if (listMatch !== null) {
      const query = listMatch[1]?.trim();
      const workingDirectory = getWorkingDirectory(ctx);
      const catalog = buildWorkflowCatalogModel(projectRoot, workingDirectory, query === "" ? undefined : query);
      if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
        clearWorkflowWidget(ctx, "workflows");
        let intent: WorkflowBrowserIntent | undefined;
        try {
          intent = await requestInlineOperatorInteraction<WorkflowBrowserIntent | undefined>(
            ctx,
            (tui, theme, keybindings, done) =>
              new WorkflowCatalogViewer(tui, theme, keybindings, catalog, projectRoot, workingDirectory, done),
          );
        } catch (error) {
          setOperatorWidget(
            ctx,
            "workflows",
            workflowWarningBlock(
              `Workflow browser closed with an error: ${errorMessage(error)}.`,
              "No editor text was changed and no workflow was started.",
            ),
          );
          return;
        }
        if (intent === undefined) return;
        if (intent.action === "copy-project" || intent.action === "copy-personal") {
          try {
            const result = copyWorkflowNamespace(
              intent.row,
              intent.action === "copy-project" ? "project" : "personal",
              projectRoot,
              workingDirectory,
            );
            setOperatorWidget(ctx, "workflows", workflowCopyBlock(result));
          } catch (error) {
            setOperatorWidget(
              ctx,
              "workflows",
              workflowWarningBlock(
                `Workflow was not copied: ${errorMessage(error)}.`,
                "No existing workflow was changed; refresh /workflows list and retry after resolving the source problem.",
              ),
            );
          }
          return;
        }
        const prompt = buildWorkflowActionPrompt(intent);
        await waitForNativeSelectorTeardown();
        fillWorkflowEditor(ctx, prompt);
        return;
      }
      const passive = buildWorkflowCatalogBlockFromModel(catalog, { compact: ctx.mode !== "tui" });
      setOperatorWidget(
        ctx,
        "workflows",
        ctx.mode === "tui"
          ? {
              ...passive,
              hint: [
                ...(passive.hint ?? []),
                "Interactive catalog unavailable: this Pi host did not expose custom UI.",
              ],
              controls: [
                ...(passive.controls ?? []),
                "Read-only fallback shown; retry in an interactive Pi TUI with custom UI support.",
              ],
            }
          : passive,
      );
      return;
    }

    const infoMatch = /^info(?:\s+([\s\S]+))?$/.exec(text);
    if (infoMatch !== null) {
      const name = workflowInfoName(infoMatch[1]?.trim());
      const infoBlock = buildWorkflowInfoBlock(projectRoot, getWorkingDirectory(ctx), name === "" ? undefined : name);
      if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
        try {
          await requestInlineOperatorInteraction<void>(
            ctx,
            (tui, theme, keybindings, done) => new WorkflowInfoViewer(tui, theme, keybindings, infoBlock, done),
          );
        } catch (error) {
          setOperatorWidget(
            ctx,
            "workflows",
            workflowWarningBlock(
              `Workflow info viewer closed with an error: ${errorMessage(error)}.`,
              "No editor text was changed and no workflow was started.",
            ),
          );
        }
        return;
      }
      setOperatorWidget(
        ctx,
        "workflows",
        ctx.mode === "tui"
          ? {
              ...infoBlock,
              hint: [
                ...(infoBlock.hint ?? []),
                "Interactive workflow info unavailable: this Pi host did not expose custom UI.",
              ],
              controls: [
                ...(infoBlock.controls ?? []),
                "Read-only fallback shown; retry in an interactive Pi TUI with custom UI support.",
              ],
            }
          : infoBlock,
      );
      return;
    }

    // `/workflows status` — recent runs; `/workflows status <runId>` — one run's progress.
    if (text === "status") {
      if (await openWorkflowRunViewer(ctx, projectRoot)) return;
      const compact = ctx.mode !== "tui";
      setOperatorWidget(
        ctx,
        "workflows",
        buildRunsListBlock(projectRoot, compact ? WORKFLOW_RPC_STATUS_ROWS : RUNS_IN_STATUS_LIST, compact),
      );
      return;
    }
    const statusMatch = /^status\s+(\S+)$/.exec(text);
    if (statusMatch !== null) {
      const selector = statusMatch[1] ?? "";
      // The chat digest and the live panel head a run with its short suffix
      // (`run #98cc`), so that is what an operator has in front of them; the run
      // list and detail widgets print full ids. Both resolve here, and an id that
      // matches several runs is named as such rather than reported as missing.
      const resolved = resolveWorkflowRunId(projectRoot, selector);
      if (resolved.status === "ambiguous") {
        setOperatorWidget(ctx, "workflows", ambiguousWorkflowRunBlock(selector, resolved));
        return;
      }
      if (resolved.status === "legacy") {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            resolved.message,
            `New run groups are stored under ${WORKFLOW_RUN_GROUP_STORAGE_PATTERN}`,
          ),
        );
        return;
      }
      if (resolved.status === "not-found") {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(`Workflow run not found: ${selector}`, "Recovery: /workflows status"),
        );
        return;
      }
      const runId = resolved.runId;
      if (await openWorkflowRunViewer(ctx, projectRoot, runId)) return;
      setOperatorWidget(ctx, "workflows", buildRunDetailBlock(projectRoot, runId, ctx.mode !== "tui"));
      return;
    }

    // `/workflows result [runId|last]` — the whole terminal text of a finished run.
    const resultMatch = /^result(?:\s+(\S+))?$/.exec(text);
    if (resultMatch !== null) {
      await presentWorkflowRunResultText(ctx, projectRoot, resultMatch[1] ?? "last");
      return;
    }

    if (text === "skills" || text.startsWith("skills ")) return presentWorkflowSkillHostCommand(text, ctx, projectRoot);

    const stopMatch = /^stop(?:\s+(\S+))?$/.exec(text);
    if (stopMatch !== null) {
      const lease = commandLauncher.currentLease(ctx);
      if (lease === undefined) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "Workflow stop is unavailable because this extension session has already shut down.",
            "Recovery: wait for Pi to finish reloading, then retry /workflows stop last.",
          ),
        );
        return;
      }
      const selector = stopMatch[1] ?? "last";
      setOperatorWidget(ctx, "workflows", workflowStopBlock(selector, commandLauncher.stop(lease, selector)));
      return;
    }

    const parsedContinue = parseContinueCommand(text);
    if (parsedContinue !== null) {
      if (parsedContinue.runId === undefined) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "Workflow continuation requires a source run id.",
            "Retry: /workflows continue <runId> [--answer <text>]",
          ),
        );
        return;
      }
      if (parsedContinue.missingAnswer === true) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock("Missing text after --answer.", "Retry: /workflows continue <runId> --answer <text>"),
        );
        return;
      }
      const result = await pumpCurrentHandoffs(ctx, {
        runId: parsedContinue.runId,
        ...(parsedContinue.answer === undefined ? {} : { answer: parsedContinue.answer }),
      });
      if (result.status === "none") {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            `No actionable workflow handoff was found for ${parsedContinue.runId}.`,
            "Inspect durable evidence: /workflows status <runId>",
          ),
        );
        return;
      }
      presentWorkflowHandoffPumpResult(ctx, result);
      return;
    }

    if (await handleWorkflowRunCommand(rawText, ctx, pi, commandLauncher)) return;

    const available = text.startsWith("run") ? listExampleNames() : [];
    setOperatorWidget(ctx, "workflows", workflowUnknownCommandBlock(text, available));
  };

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "workflows",
      group: "workflows",
      surfaces: ["transient-widget", "status", "artifact-write", "no-ui"],
      transientWidgets: ["workflows", WORKFLOW_LIVE_WIDGET_KEY],
    },
    {
      // The palette shows this next to every other command, so it says what the
      // command is for. The full grammar stays one keystroke away, in the help
      // widget (operator-ui.ts) and in the unknown-subcommand recovery block.
      description: "Open the workflow command menu, or run, inspect, continue, and stop workflow runs.",
      getArgumentCompletions: (prefix) => {
        const context = deps.completionContext();
        const actionableRunIds = prefix.replace(/^\s+/u, "").startsWith("continue ")
          ? deps.actionableRunIds(context.projectRoot)
          : undefined;
        return workflowArgumentCompletions(prefix, context.projectRoot, context.workingDirectory, actionableRunIds);
      },
      handler: handleWorkflowCommand,
    },
  );

  registerWorkflowCommandAliases(pi, handleWorkflowCommand, deps.completionContext);
}

function workflowMenuAvailable(ctx: ExtensionCommandContext): boolean {
  return ctx.mode === "tui" && ctx.hasUI !== false && typeof ctx.ui.select === "function";
}

async function openWorkflowCommandMenu(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  workingDirectory: string,
  commandLauncher: WorkflowCommandLauncher,
  actionableRunIds: (projectRoot: string) => string[],
  route: (command: string) => Promise<void>,
): Promise<void> {
  const root = await requestWorkflowMenuSelection(
    ctx,
    "[SELECT] Workflows",
    WORKFLOW_MENU_OPTIONS.map((option) => option.label),
  );
  if (!presentWorkflowMenuSelectionFailure(ctx, root, "Retry /workflows or use /workflows <subcommand>.")) return;

  const command = WORKFLOW_MENU_OPTIONS.find((option) => option.label === root.value)?.command;
  if (command === undefined) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        `Workflow menu returned an unsupported root selection: ${JSON.stringify(root.value)}.`,
        "Retry /workflows or use /workflows <subcommand>.",
      ),
    );
    return;
  }
  switch (command) {
    case "dashboard":
    case "list":
    case "status":
    case "skills":
      await route(command === "skills" ? "skills status" : command);
      return;
    case "info": {
      const selected = await selectWorkflowTarget(ctx, projectRoot, workingDirectory, "info");
      if (selected !== undefined) await route(`info ${formatWorkflowCommandToken(selected.name)}`);
      return;
    }
    case "result": {
      const runId = await selectWorkflowRun(ctx, projectRoot, "read result for");
      if (runId !== undefined) await route(`result ${runId}`);
      return;
    }
    case "run": {
      const selected = await selectWorkflowTarget(ctx, projectRoot, workingDirectory, "run");
      if (selected !== undefined) {
        await waitForNativeSelectorTeardown();
        fillWorkflowEditor(ctx, buildWorkflowRunCommand(selected.target));
      }
      return;
    }
    case "continue": {
      let runIds: string[];
      try {
        runIds = actionableRunIds(projectRoot).slice(0, WORKFLOW_MENU_OPTION_LIMIT);
      } catch (error) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            `Workflow handoffs could not be listed: ${errorMessage(error)}.`,
            "No handoff was opened; inspect durable evidence with /workflows status.",
          ),
        );
        return;
      }
      if (runIds.length === 0) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock("No workflow handoff currently needs an answer.", "Inspect runs: /workflows status"),
        );
        return;
      }
      const selected = await requestWorkflowMenuSelection(ctx, "[SELECT] Workflow handoff to continue", runIds);
      if (!presentWorkflowMenuSelectionFailure(ctx, selected, "Retry /workflows continue <runId>.")) return;
      await route(`continue ${selected.value}`);
      return;
    }
    case "stop": {
      const lease = commandLauncher.currentLease(ctx);
      if (lease === undefined) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "Workflow stop is unavailable because this extension session has already shut down.",
            "Wait for Pi to finish reloading, then retry /workflows.",
          ),
        );
        return;
      }
      const selectors = [...new Set(commandLauncher.unsettled(lease).map((run) => run.runId ?? run.launchId))];
      if (selectors.length === 0) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "No workflow run in the current session is available to stop.",
            "Start one: /workflows run",
          ),
        );
        return;
      }
      const selected = await requestWorkflowMenuSelection(ctx, "[SELECT] Workflow run to stop", ["last", ...selectors]);
      if (!presentWorkflowMenuSelectionFailure(ctx, selected, "Retry /workflows stop [runId|last].")) return;
      await waitForNativeSelectorTeardown();
      fillWorkflowEditor(ctx, `/workflows stop ${selected.value}`);
      return;
    }
    default:
      return assertNever(command);
  }
}

async function selectWorkflowTarget(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  workingDirectory: string,
  action: "info" | "run",
): Promise<
  | { name: string; ref: string; target: ReturnType<typeof buildWorkflowCatalogModel>["current"][number]["target"] }
  | undefined
> {
  let rows: ReturnType<typeof buildWorkflowCatalogModel>["current"];
  try {
    rows = buildWorkflowCatalogModel(projectRoot, workingDirectory).current.slice(0, WORKFLOW_MENU_OPTION_LIMIT);
  } catch (error) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        `Workflow catalog could not be opened: ${errorMessage(error)}.`,
        "No editor text was changed and no workflow was started.",
      ),
    );
    return undefined;
  }
  if (rows.length === 0) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock("No current workflow is available.", "Browse: /workflows list"),
    );
    return undefined;
  }
  const choices = workflowTargetMenuChoices(rows);
  const selected = await requestWorkflowMenuSelection(
    ctx,
    `[SELECT] Workflow to ${action}`,
    choices.map((choice) => choice.label),
  );
  if (!presentWorkflowMenuSelectionFailure(ctx, selected, `Retry /workflows ${action} <name>.`)) return undefined;
  const choice = choices.find((candidate) => candidate.label === selected.value);
  if (choice !== undefined) return { name: choice.name, ref: choice.ref, target: choice.target };
  setOperatorWidget(
    ctx,
    "workflows",
    workflowWarningBlock("Workflow selection no longer matches the current catalog.", "Nothing was opened or started."),
  );
  return undefined;
}

function workflowInfoName(raw: string | undefined): string | undefined {
  if (raw === undefined || !raw.startsWith('"')) return raw;
  const parsed = parseWorkflowCommandToken(raw);
  return parsed?.rest === "" ? parsed.value : raw;
}

function workflowTargetMenuChoices(
  rows: ReturnType<typeof buildWorkflowCatalogModel>["current"],
): Array<{ label: string; name: string; ref: string; target: (typeof rows)[number]["target"] }> {
  const used = new Set<string>();
  return rows.map((row) => {
    const base = workflowTargetMenuLabel(row.name);
    let label = base;
    let suffix = 2;
    while (used.has(label)) label = `${base} [${suffix++}]`;
    used.add(label);
    return { label, name: row.name, ref: row.target.ref, target: row.target };
  });
}

function workflowTargetMenuLabel(name: string): string {
  if (/^[^\s"\\\u0000-\u001f\u007f-\u009f]+$/u.test(name)) return name;
  return JSON.stringify(name).replace(
    /[\u007f-\u009f\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function selectWorkflowRun(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  action: string,
): Promise<string | undefined> {
  const runIds = listWorkflowRunIds(projectRoot).slice(0, WORKFLOW_MENU_OPTION_LIMIT);
  if (runIds.length === 0) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock("No workflow run is available.", "Start one: /workflows run"),
    );
    return undefined;
  }
  const selected = await requestWorkflowMenuSelection(ctx, `[SELECT] Workflow run to ${action}`, runIds);
  return presentWorkflowMenuSelectionFailure(ctx, selected, "Inspect runs: /workflows status")
    ? selected.value
    : undefined;
}

async function requestWorkflowMenuSelection(
  ctx: ExtensionCommandContext,
  title: string,
  choices: string[],
): Promise<WorkflowMenuSelection> {
  try {
    const result = await ctx.ui.select(title, choices);
    if (result === undefined) return { status: "dismissed" };
    if (typeof result !== "string") {
      return { status: "failed", message: "Workflow menu returned an unsupported selection result." };
    }
    if (result === "") return { status: "failed", message: "Workflow menu returned an empty selection." };
    const allowed = choices.includes(result);
    return allowed
      ? { status: "selected", value: result }
      : { status: "failed", message: `Workflow menu returned an unsupported selection: ${JSON.stringify(result)}.` };
  } catch (error) {
    return { status: "failed", message: `Workflow menu closed with an error: ${errorMessage(error)}.` };
  }
}

function presentWorkflowMenuSelectionFailure(
  ctx: ExtensionCommandContext,
  selection: WorkflowMenuSelection,
  recovery: string,
): selection is Extract<WorkflowMenuSelection, { status: "selected" }> {
  if (selection.status === "selected") return true;
  if (selection.status === "failed") {
    setOperatorWidget(ctx, "workflows", workflowWarningBlock(selection.message, recovery));
  }
  return false;
}

async function waitForNativeSelectorTeardown(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, NATIVE_SELECTOR_TEARDOWN_MS));
}

function fillWorkflowEditor(ctx: ExtensionCommandContext, command: string): void {
  if (ctx.ui.setEditorText === undefined) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        "Workflow action could not fill the editor because this Pi host does not expose setEditorText().",
        "Nothing was started or stopped; use the matching /workflows subcommand directly.",
      ),
    );
    return;
  }
  try {
    ctx.ui.setEditorText(command);
    ctx.ui.setStatus(WORKFLOW_EDITOR_PREFILL_RENDER_STATUS_KEY, undefined);
  } catch (error) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        `Workflow action could not fill the editor: ${errorMessage(error)}.`,
        "Nothing was started or stopped.",
      ),
    );
  }
}

function registerWorkflowCommandAliases(
  pi: ExtensionAPI,
  handler: (args: CommandArgs, ctx: ExtensionCommandContext) => Promise<void>,
  completionContext: () => { projectRoot: string; workingDirectory: string },
): void {
  for (const command of FLAT_WORKFLOW_COMMANDS) {
    const commandName = `workflow-${command}`;
    registerCommandWithUiLifecycle(
      pi,
      {
        command: commandName,
        group: "workflows",
        surfaces: ["transient-widget", "status", "artifact-write", "no-ui"],
        transientWidgets: ["workflows", WORKFLOW_LIVE_WIDGET_KEY],
      },
      {
        description: flatWorkflowCommandDescription(command),
        getArgumentCompletions: (prefix) => {
          const context = completionContext();
          return workflowFlatCommandCompletions(command, prefix, context.projectRoot, context.workingDirectory);
        },
        handler: (args, ctx) => {
          const tail = getCommandText(args).trim();
          return handler(tail === "" ? command : `${command} ${tail}`, ctx);
        },
      },
    );
  }
}

function flatWorkflowCommandDescription(_command: FlatWorkflowCommand): string {
  return "Compatibility alias for /workflows stop [runId|last]: /workflow-stop";
}

/**
 * Show the full text a run finished with. Interactive hosts get a scrollable
 * screen; every other host gets the text bounded by the widget plus the exact
 * file path, because the file is the copy that is never truncated.
 */
async function presentWorkflowRunResultText(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  selector: string,
): Promise<void> {
  const resolved = resolveWorkflowRunId(projectRoot, selector);
  if (resolved.status === "ambiguous") {
    setOperatorWidget(ctx, "workflows", ambiguousWorkflowRunBlock(selector, resolved));
    return;
  }
  if (resolved.status === "legacy") {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(resolved.message, `New run groups are stored under ${WORKFLOW_RUN_GROUP_STORAGE_PATTERN}`),
    );
    return;
  }
  if (resolved.status === "not-found") {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        selector === "last" || selector === ""
          ? "No workflow run with persisted evidence was found."
          : `No workflow run matches ${selector}.`,
        "List runs: /workflows status",
      ),
    );
    return;
  }
  const read = readWorkflowRunResultText(projectRoot, resolved.runId);
  if (read.status === "none" || read.status === "invalid") {
    setOperatorWidget(ctx, "workflows", workflowWarningBlock(read.message, "Inspect evidence: /workflows status"));
    return;
  }
  const title = `workflow result · run ${read.runId}`;
  if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
    clearWorkflowWidget(ctx, "workflows");
    try {
      await requestInlineOperatorInteraction<void>(
        ctx,
        (tui, theme, keybindings, done) => new WorkflowResultViewer(tui, theme, keybindings, title, read.text, done),
      );
      return;
    } catch (error) {
      if (!isStaleInlineOperatorInteractionError(error)) throw error;
      // Another prompt owns the screen. Say so and leave the path behind, so the
      // command never ends with nothing on screen — best-effort, because a
      // replaced session may no longer accept a notification at all.
      try {
        ctx.ui.notify("Workflow result closed: another prompt took the screen. Retry /workflows result.", "info");
      } catch {
        // The bounded widget below is still written.
      }
    }
  }
  // The widget re-bounds this body itself and marks what it drops, so the only
  // honest thing to add is the size of the whole result and where all of it is.
  // Claiming a second, different line count here would contradict that marker.
  const allLines = read.text.replace(/\n$/u, "").split(/\r?\n/u);
  setOperatorWidget(ctx, "workflows", {
    type: "VIEW",
    subject: "Workflow result",
    primary: title,
    body: allLines.slice(0, WORKFLOW_RESULT_WIDGET_LINES),
    metadata: [`full text: ${allLines.length} line(s) at ${read.path}`],
    controls: ["Read it all in an interactive Pi TUI, or open the file above"],
  });
}

async function openWorkflowRunViewer(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  runId?: string,
): Promise<boolean> {
  if (ctx.mode !== "tui" || ctx.hasUI === false || ctx.ui.custom === undefined) return false;
  clearWorkflowWidget(ctx, "workflows");
  try {
    await requestInlineOperatorInteraction<void>(
      ctx,
      (tui, theme, keybindings, done) => new WorkflowRunViewer(tui, theme, keybindings, projectRoot, done, runId),
    );
  } catch (error) {
    const fallback =
      runId === undefined
        ? buildRunsListBlock(projectRoot, RUNS_IN_STATUS_LIST)
        : buildRunDetailBlock(projectRoot, runId);
    setOperatorWidget(ctx, "workflows", {
      ...fallback,
      metadata: [
        `Interactive evidence viewer failed: ${errorMessage(error)}. Bounded static evidence is shown instead.`,
        ...(fallback.metadata ?? []),
      ],
    });
  }
  return true;
}
