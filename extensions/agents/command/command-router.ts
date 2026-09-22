/**
 * extensions/agents/command/command-router.ts — the `/ps` and `/agent` grammars and their
 * dispatch. Both commands are registered with their transient-UI lifecycle here;
 * the fleet menu and the session authority arrive as injected dependencies so the
 * router owns no session state of its own.
 */
import { registerCommandWithUiLifecycle } from "../../_shared/operator/command-ui.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot } from "../../_shared/host/pi-api.js";
import { setOperatorWidget } from "../../_shared/operator/widget-render.js";
import { agentCatalog, refreshAgents } from "../catalog/catalog.js";
import {
  parseAgentDrillCommand,
  parseAgentObserverCommand,
  parseAgentPsCommand,
  parseAgentRunCommand,
  parsePsTarget,
} from "./command-parser.js";
import { executeAgentDrillCommand, type AgentSessionAuthority } from "../fleet/drill-command.js";
import {
  AGENTS_WIDGET_KEY,
  clearAgentsStatus,
  clearAgentsTransient,
  renderAgentBlockInteraction,
  setAgentsWidget,
} from "../operator/operator-surface.js";
import { AGENT_CATALOG_FALLBACK_ROWS, agentCatalogBlock, agentInspectBlock } from "../operator/operator-ui.js";
import { renderAgentObserverText } from "../operator/agent-observer.js";
import { executeAgentRunCommand } from "../run/run-launcher.js";
import { createUnknownAgentReport } from "../run/unknown-agent-report.js";

const AGENT_RUN_USAGE =
  "Usage: /agent list | /agent inspect <name> | /agent run [--yes|--approve] [--title <title>] <name> <task>";
const AGENT_OBSERVER_USAGE = "Usage: /agent observe | /agent summary";
const AGENT_COMMAND_USAGE =
  "Usage: /agent list | /agent inspect <name> | /agent run [--yes|--approve] <name> <task> | /agent drill <row-id|agent|last> | /agent observe | /agent summary";
const PS_USAGE = "Usage: /ps [row-id|agent|last]";

export interface AgentCommandDependencies {
  /** Open the interactive fleet for this session. */
  openFleetMenu(ctx: ExtensionContext): Promise<void>;
  agentSessionAuthority: AgentSessionAuthority;
}

export function registerAgentCommands(pi: ExtensionAPI, deps: AgentCommandDependencies): void {
  const { openFleetMenu, agentSessionAuthority } = deps;
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "ps",
      group: "agents",
      surfaces: ["transient-widget", "overlay-selector"],
      transientWidgets: [AGENTS_WIDGET_KEY],
      transientStatuses: [AGENTS_WIDGET_KEY],
    },
    {
      description: "Open the agent fleet or view one live/recent agent.",
      handler: async (args, ctx) => {
        clearAgentsTransient(ctx);
        const target = parsePsTarget(getCommandText(args));
        if (target === undefined) {
          setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
            type: "WARN",
            subject: "Agent processes",
            primary: "A single row id, agent, or last target is required.",
            controls: [PS_USAGE],
          });
          return;
        }
        if (target === "") await openFleetMenu(ctx);
        else await executeAgentDrillCommand(ctx as ExtensionCommandContext, { target }, agentSessionAuthority);
      },
    },
  );
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "agent",
      group: "agents",
      surfaces: ["transient-widget", "status", "overlay-selector", "artifact-write"],
      transientWidgets: [AGENTS_WIDGET_KEY],
      transientStatuses: [AGENTS_WIDGET_KEY],
    },
    {
      description: "List, inspect, run, observe, summary, or drill into agent definitions and live rows.",
      handler: async (args, ctx) => {
        const discovery = refreshAgents(getProjectRoot(ctx));
        clearAgentsStatus(ctx);
        const text = getCommandText(args).trim();
        if (text === "list" || text === "") {
          const catalog = [...agentCatalog.values()];
          const fullBlock = agentCatalogBlock(catalog, discovery.diagnostics);
          if (await renderAgentBlockInteraction(ctx as ExtensionCommandContext, fullBlock)) return;
          setOperatorWidget(
            ctx,
            AGENTS_WIDGET_KEY,
            agentCatalogBlock(catalog, discovery.diagnostics, AGENT_CATALOG_FALLBACK_ROWS),
          );
          return;
        }
        const inspectMatch = /^inspect\s+(\S+)/.exec(text);
        if (inspectMatch) {
          const agent = agentCatalog.get(inspectMatch[1]!);
          if (agent !== undefined) {
            const fullBlock = agentInspectBlock(agent);
            if (await renderAgentBlockInteraction(ctx as ExtensionCommandContext, fullBlock)) return;
            setOperatorWidget(ctx, AGENTS_WIDGET_KEY, ctx.mode === "tui" ? fullBlock : agentInspectBlock(agent, true));
          } else {
            const report = createUnknownAgentReport(ctx, "agent-inspect", inspectMatch[1]!);
            setOperatorWidget(ctx, AGENTS_WIDGET_KEY, report.block);
          }
          return;
        }
        const drillCommand = parseAgentDrillCommand(text);
        if (drillCommand !== undefined) {
          clearAgentsTransient(ctx);
          await executeAgentDrillCommand(ctx as ExtensionCommandContext, drillCommand, agentSessionAuthority);
          return;
        }
        const psTarget = parseAgentPsCommand(text);
        if (psTarget !== undefined) {
          clearAgentsTransient(ctx);
          if (psTarget === "") await openFleetMenu(ctx);
          else
            await executeAgentDrillCommand(ctx as ExtensionCommandContext, { target: psTarget }, agentSessionAuthority);
          return;
        }
        const observerCommand = parseAgentObserverCommand(text);
        if (observerCommand !== undefined) {
          const observerText = renderAgentObserverText();
          clearAgentsStatus(ctx);
          setAgentsWidget(ctx, observerText);
          return;
        }
        const runCommand = parseAgentRunCommand(text);
        if (runCommand === undefined) {
          const usage = text.startsWith("run")
            ? AGENT_RUN_USAGE
            : text.startsWith("observe") || text.startsWith("summary")
              ? AGENT_OBSERVER_USAGE
              : AGENT_COMMAND_USAGE;
          setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
            type: "WARN",
            subject: "Agent command",
            primary: text === "" ? "An agent action is required." : `Unknown or incomplete /agent action: ${text}`,
            metadata: ["No agent run, catalog mutation, or live control action was attempted."],
            controls: [usage],
          });
          return;
        }
        await executeAgentRunCommand(
          pi,
          ctx as ExtensionCommandContext,
          runCommand.name,
          runCommand.task,
          runCommand.approvalTier,
          runCommand.title,
        );
      },
    },
  );
}

export function warnOnPsCollision(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (typeof pi.getCommands !== "function") return;
  let commands: ReturnType<NonNullable<ExtensionAPI["getCommands"]>>;
  try {
    commands = pi.getCommands();
  } catch {
    return;
  }
  // Pi disambiguates duplicate extension commands as ps:1, ps:2, ... .
  const psCommands = commands.filter((command) => /^ps(?::\d+)?$/u.test(command.name));
  if (psCommands.length <= 1) return;
  ctx.ui.notify(
    `Multiple /ps commands are loaded (${psCommands.map((command) => command.name).join(", ")}). Use /agent ps as the stable Locus fallback.`,
    "warning",
  );
}
