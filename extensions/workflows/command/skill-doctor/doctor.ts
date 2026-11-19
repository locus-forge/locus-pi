import { homedir } from "node:os";
import { getSessionId, type ExtensionAPI, type ExtensionCommandContext } from "../../../_shared/host/pi-api.js";
import { clearTransientUiKey } from "../../../_shared/operator/command-ui.js";
import { requestInlineOperatorInteraction } from "../../../_shared/operator/operator-interaction.js";
import { renderOperatorBlockPlain, type OperatorBlock } from "../../../_shared/operator/operator-ui.js";
import { HOST_STRING_ARRAY_WIDGET_LINES, setOperatorWidget } from "../../../_shared/operator/widget-render.js";
import { errorMessage } from "../../operator/operator-ui.js";
import { WorkflowResultViewer } from "../../run/run-viewer.js";
import { claudeOverride, workflowSkillDestination } from "./skills-destinations.js";
import {
  operateWorkflowSkillHosts,
  WorkflowSkillWriteError,
  type WorkflowSkillHostAction,
  type WorkflowSkillHostCommand,
  type WorkflowSkillHostResult,
  type WorkflowSkillHostResultGroup,
} from "../skills.js";

const RECOVERY = "/workflows doctor recovery";
const USAGE = "/workflows doctor [check|install|remove] [--host codex|claude|all] [--scope user|project]";
const WIDGET = "workflows";
const PUBLIC_ACTIONS = { status: "check", sync: "install", remove: "remove" } as const;

function warning(primary: string, next: string, body: string[] = []): OperatorBlock {
  return { type: "WARN", subject: "Workflow doctor", primary, body, controls: [next] };
}

function parseDoctor(text: string, legacy: boolean): WorkflowSkillHostCommand | string {
  const [, first, ...tail] = text.trim().split(/\s+/u);
  const actions = legacy
    ? { status: "status", sync: "sync", remove: "remove" }
    : {
        check: "status",
        install: "sync",
        remove: "remove",
      };
  const defaultCheck = !legacy && first?.startsWith("--");
  const verb = first === undefined || defaultCheck ? (legacy ? "status" : "check") : first;
  const action = Object.hasOwn(actions, verb)
    ? (actions[verb as keyof typeof actions] as WorkflowSkillHostAction)
    : undefined;
  if (!action) return "Expected check, install, or remove.";

  const opts = defaultCheck ? [first!, ...tail] : tail;
  let host: WorkflowSkillHostCommand["host"] = "all";
  let scope: WorkflowSkillHostCommand["scope"] = "user";
  const seen = new Set<string>();
  for (let index = 0; index < opts.length; index += 2) {
    const option = opts[index]!;
    const value = opts[index + 1];
    if (seen.has(option)) return `Duplicate option: ${option}.`;
    seen.add(option);
    if (option === "--host" && (value === "codex" || value === "claude" || value === "all")) host = value;
    else if (option === "--scope" && (value === "user" || value === "project")) scope = value;
    else return `Invalid option or value: ${option}${value === undefined ? "" : ` ${value}`}.`;
  }
  if (!legacy && action !== "status" && !seen.has("--host")) {
    return "Choose --host codex, --host claude, or --host all for a write.";
  }
  return { action, host, scope };
}

function command(
  action: "check" | "install" | "remove",
  choice: Pick<WorkflowSkillHostCommand, "host" | "scope">,
): string {
  return `/workflows doctor ${action} --host ${choice.host} --scope ${choice.scope}`;
}

function defaultFolderNote(): string {
  return "Skill discovery with CLAUDE_CONFIG_DIR is unverified.";
}

function claudeUserWriteNote(choice: WorkflowSkillHostCommand): string | undefined {
  if (choice.host === "codex" || choice.scope !== "user" || choice.action === "status") return undefined;
  const home = homedir();
  if (!claudeOverride(home)) return undefined;
  const verb = choice.action === "sync" ? "Install to" : "Remove from";
  return `${verb} Claude Code default folder (Logical HOME path) ${workflowSkillDestination("claude", home)}. ${defaultFolderNote()}`;
}

function summary(group: WorkflowSkillHostResultGroup): string {
  if (!group.rows.length) return "Blocked.";
  const active = group.rows.filter((row) => !row.legacy);
  const installed = active.filter((row) => row.installedOnDisk).length;
  const missing = active.filter((row) => row.state === "absent").length;
  const repair = active.filter((row) => row.state === "stale").length;
  const removed = group.rows.filter((row) => row.changed === "removed").length;
  const changed = group.rows.filter((row) => row.changed === "replaced" || row.changed === "created").length;
  const stats = [`${installed}/${active.length} links installed on disk`];
  if (missing) stats.push(`${missing} missing`);
  if (repair) stats.push(`${repair} need repair`);
  const retiring = group.rows.filter((row) => row.legacy && row.state === "stale").length;
  if (retiring) stats.push(`${retiring} pending removal`);
  if (group.blocked) stats.push("writes blocked");
  if (changed) stats.push(`${changed} written`);
  if (removed) stats.push(`${removed} removed`);
  return stats.join(" · ");
}

function resultBlock(result: WorkflowSkillHostResult, choice: WorkflowSkillHostCommand): OperatorBlock {
  const detail = choice.host !== "all";
  const body = result.groups.flatMap((group) => {
    const host = group.host === "codex" ? "Codex" : "Claude Code";
    const install =
      choice.action === "status" &&
      !group.blocked &&
      group.rows.some((row) => row.state === "stale" || (!row.legacy && row.state === "absent"));
    const next = command(install ? "install" : "check", group);
    const label = install ? "Install or repair" : "Check";
    const target = group.defaultClaudeFolder ? " default folder" : "";
    const blocked = group.blocked
      ? detail
        ? group.blocked.split("\n")
        : [group.blocked.split("\n")[0]!.split(". Marker:")[0]!]
      : [];
    return [
      `${host}${target} (${group.scope}) — ${group.path}`,
      `${summary(group)}${group.defaultClaudeFolder ? ` Default folder. ${defaultFolderNote()}` : ""}`,
      `${label}${target}: ${next}`,
      ...blocked,
      ...(detail
        ? [
            `Package source: ${result.source}`,
            ...group.rows
              .filter((row) => !row.legacy || row.state !== "absent" || row.changed !== "none")
              .map(
                (row) =>
                  `${row.skill}: ${row.legacy && row.state === "stale" ? "pending removal" : row.changed === "none" ? row.state : row.changed}`,
              ),
          ]
        : []),
    ];
  });
  const controls = detail ? [] : ["For details, run doctor check with the host and scope above."];
  if (choice.host === "all") controls.unshift(command("check", choice));
  return {
    type: "VIEW",
    subject: "Workflow doctor",
    primary: detail ? "Skill links" : "External hosts",
    body,
    controls,
  };
}

function destinationNotes(groups: WorkflowSkillHostResultGroup[]): string[] {
  return groups.flatMap((group) =>
    group.defaultClaudeFolder
      ? [
          `Claude Code default folder ${group.path}. ${defaultFolderNote()}`,
          `Check default folder: ${command("check", group)}`,
        ]
      : [`Destination: ${group.path}`],
  );
}

async function showFullText(
  ctx: ExtensionCommandContext,
  title: string,
  text: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (ctx.hasUI === false || !isCurrent()) return;
  if (ctx.mode === "tui" && ctx.ui.custom) {
    try {
      await requestInlineOperatorInteraction<void>(
        ctx,
        (tui, theme, keybindings, done) => new WorkflowResultViewer(tui, theme, keybindings, title, text, done),
        { isCurrent },
      );
      return;
    } catch {
      // The operation result is already known. A viewer error only changes how we present it.
    }
  }
  if (isCurrent()) ctx.ui.notify(text, "info");
}

function showResult(ctx: ExtensionCommandContext, block: OperatorBlock, isCurrent: () => boolean): void {
  const full = renderOperatorBlockPlain(block, 10_000).join("\n");
  const onOverflow = async () => {
    if (!isCurrent()) return;
    // Pi lays out the passive widget and the inline viewer in the same pane.
    clearTransientUiKey(ctx, WIDGET);
    try {
      await showFullText(ctx, block.subject, full, isCurrent);
      if (isCurrent()) setOperatorWidget(ctx, WIDGET, block);
    } catch {
      if (isCurrent()) ctx.ui.notify(full, "info");
    }
  };
  try {
    setOperatorWidget(ctx, WIDGET, block, { onOverflow });
  } catch {
    if (isCurrent()) ctx.ui.notify(full, "info");
    return;
  }
  if (
    ctx.mode !== "tui" &&
    renderOperatorBlockPlain(block, 80).length > HOST_STRING_ARRAY_WIDGET_LINES &&
    ctx.hasUI !== false
  ) {
    ctx.ui.notify(full, "info");
  }
}

interface Recovery {
  session: string;
  project: string;
  report: string;
}

export function createWorkflowDoctor(pi: ExtensionAPI) {
  let recovery: Recovery | undefined;
  let presentation = 0;
  pi.on("session_start", () => {
    recovery = undefined;
    presentation++;
  });
  pi.on("session_shutdown", () => {
    recovery = undefined;
    presentation++;
  });

  return async (text: string, ctx: ExtensionCommandContext, projectRoot: string): Promise<void> => {
    const base = projectRoot;
    const session = getSessionId(ctx);
    const sequence = ++presentation;
    const isCurrent = () => sequence === presentation && getSessionId(ctx) === session;
    const present = (block: OperatorBlock) => showResult(ctx, block, isCurrent);
    if (recovery && (recovery.session !== session || recovery.project !== base)) recovery = undefined;
    if (/^doctor\s+recovery$/u.test(text)) {
      if (recovery) await showFullText(ctx, "Incomplete rollback", recovery.report, isCurrent);
      else
        setOperatorWidget(
          ctx,
          WIDGET,
          warning("No incomplete rollback in this session and project.", "Check: /workflows doctor"),
        );
      return;
    }

    const legacy = /^skills(?:\s|$)/u.test(text);
    const parsed = parseDoctor(text, legacy);
    if (legacy) {
      const next = typeof parsed === "string" ? "/workflows doctor" : command(PUBLIC_ACTIONS[parsed.action], parsed);
      const note = typeof parsed === "string" ? USAGE : claudeUserWriteNote(parsed);
      present(warning("This workflow skills command has moved. Run the replacement below.", next, note ? [note] : []));
      return;
    }
    if (typeof parsed === "string") {
      present(warning(parsed, USAGE));
      return;
    }

    const check = command("check", parsed);
    try {
      present(resultBlock(operateWorkflowSkillHosts({ ...parsed, projectRoot: base }), parsed));
    } catch (error) {
      if (!(error instanceof WorkflowSkillWriteError)) throw error;
      const notes = destinationNotes(error.groups);
      if (error.outcome === "incomplete") {
        recovery = {
          session,
          project: base,
          report: [
            "Incomplete rollback",
            command(PUBLIC_ACTIONS[parsed.action], parsed),
            ...notes,
            error.message,
            ...error.issues.map((issue) => `Skipped or failed: ${issue.path}\n${issue.reason}`),
            `Check current state: ${check}`,
          ].join("\n"),
        };
        present(warning("Incomplete rollback.", RECOVERY));
      } else {
        const outcome = error.outcome === "refused" ? "Write refused" : "Write failed and changes were rolled back";
        present(warning(`${outcome}: ${errorMessage(error)}`, `Check: ${check}`, notes));
      }
    }
  };
}
