/**
 * extensions/agents/catalog/catalog.ts — the agent catalog.
 *
 * Owns the resolved agent catalog and its discovery refresh, the `TaskParams` schema whose
 * `agent` parameter description IS the published catalog (see writeAgentCatalogHint),
 * exact name resolution, and the flat catalog projections the
 * unknown-agent report reads.
 */
import { Type } from "@sinclair/typebox";
import { discoverAgentDefinitions, formatAgentCatalogHint } from "../../_shared/agent-runtime/agents.js";
import type { AgentDefinition } from "../../_shared/agent-runtime/agents.js";

/**
 * The resolved agent catalog this extension refreshes from disk, keyed by agent name.
 *
 * `refreshAgents` below is the only writer: it clears and repopulates the map on every
 * discovery pass, and `before_agent_start` runs one pass per turn. This module and
 * `command-router.ts` are the only readers, which is why the map sits inside this extension
 * rather than in a shared directory.
 *
 * It is a per-entrypoint projection of `.agents/agents/`, never a process-wide registry: this
 * binding does not survive Pi's cache-disabled entrypoint loading, so each loaded entrypoint
 * gets its own copy. Nothing may rely on a write made through one entrypoint being visible
 * from another.
 */
export const agentCatalog = new Map<string, AgentDefinition>();

const AGENT_PARAM_BASE_DESCRIPTION =
  "Optional project/user agent catalog name. Omit to run a clean child session without a role profile.";
const AGENT_PARAM_CATALOG_HEADING = "Available agents (name — description):";

// No character ceiling on either input field. `task` and `parentContext.inline` are the
// CALLER'S text — the instructions it wrote and the context it chose to hand over — and a
// cap here refuses a job before anyone looks at it, on a number this surface invented.
// `minLength: 1` stays on `task`: an empty instruction is missing, not short.
export const TaskParams = Type.Object({
  agent: Type.Optional(Type.String({ description: AGENT_PARAM_BASE_DESCRIPTION })),
  task: Type.String({ description: "Self-contained subagent instructions", minLength: 1 }),
  title: Type.Optional(
    Type.String({
      description: "Short work title shown in the live agent row; falls back to the first words of task",
      maxLength: 128,
    }),
  ),
  parentContext: Type.Optional(
    Type.Object({
      inline: Type.Optional(Type.String({ description: "Explicit parent-provided context text" })),
      artifactPath: Type.Optional(Type.String({ description: "Path to an explicit parent context artifact" })),
    }),
  ),
});

export interface AgentResolution {
  requestedAgent: string;
  resolvedAgent: string;
  agent: AgentDefinition;
}

export function refreshAgents(projectRoot: string) {
  const discovered = discoverAgentDefinitions(projectRoot);
  agentCatalog.clear();
  for (const agent of discovered.definitions) {
    agentCatalog.set(agent.name, agent);
  }
  writeAgentCatalogHint(discovered.definitions);
  return discovered;
}

/**
 * T-111: publish the resolved catalog on the `agent` parameter of
 * `spawn_agent`, which is where the calling model chooses the name. The
 * tools are registered with the same `TaskParams` object and Pi hands
 * `ToolDefinition.parameters` to the provider by reference on every request
 * (unlike `description`, which it snapshots when the tool is wrapped), so
 * rewriting the schema field here is what makes the catalog refreshable instead
 * of frozen at registration. Every `refreshAgents` caller therefore republishes
 * it, and `before_agent_start` runs one refresh per turn so an agent added to
 * `.agents/agents/` mid-session is selectable without a restart.
 */
function writeAgentCatalogHint(definitions: readonly AgentDefinition[]): void {
  const catalog = formatAgentCatalogHint(definitions);
  TaskParams.properties.agent.description =
    catalog === ""
      ? AGENT_PARAM_BASE_DESCRIPTION
      : `${AGENT_PARAM_BASE_DESCRIPTION}\n${AGENT_PARAM_CATALOG_HEADING}\n${catalog}`;
}

export function resolveAgentSelection(agentName: string): AgentResolution | undefined {
  const requestedAgent = normalizeRequestedAgentName(agentName);
  if (requestedAgent === undefined) return undefined;
  const exact = agentCatalog.get(requestedAgent);
  return exact === undefined ? undefined : { requestedAgent, resolvedAgent: exact.name, agent: exact };
}

export function normalizeRequestedAgentName(agentName: string | undefined): string | undefined {
  if (agentName === undefined) return undefined;
  const trimmed = agentName.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function listAvailableAgents(): Array<{ name: string; source: string; description: string }> {
  return [...agentCatalog.values()]
    .map((agent) => ({ name: agent.name, source: agent.source ?? "unknown", description: agent.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
