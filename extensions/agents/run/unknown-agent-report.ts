/**
 * extensions/agents/run/unknown-agent-report.ts — what the agents surfaces say when a
 * requested name is not in the catalog: the durable JSON artifact, the tool-result
 * text, the structured details, and the operator block. One report shape serves
 * the `task`/`spawn_agent` tool, `/agent run`, and `/agent inspect`.
 */
import { relative } from "node:path";
import { appendProjectError } from "../../_shared/host/error-journal.js";
import { createRuntimeArtifactStore } from "../../_shared/runtime/artifacts.js";
import type { OperatorBlock } from "../../_shared/operator/operator-ui.js";
import type { ExtensionContext } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getSessionId } from "../../_shared/host/pi-api.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import { listAvailableAgents, normalizeRequestedAgentName } from "../catalog/catalog.js";
import { compactAgentCatalogLine } from "../operator/operator-ui.js";

export interface UnknownAgentReport {
  text: string;
  block: OperatorBlock;
  details: Record<string, unknown>;
  artifactPath?: string;
}

export function createUnknownAgentReport(
  ctx: ExtensionContext,
  requestedSurface: string,
  agentName: string | undefined,
): UnknownAgentReport {
  const requestedAgent = normalizeRequestedAgentName(agentName) ?? "(empty)";
  const availableAgents = listAvailableAgents();
  const artifact = writeUnknownAgentArtifact(ctx, requestedSurface, requestedAgent, availableAgents);
  const parentSessionId = getSessionId(ctx);
  const receipt = appendProjectError(getProjectRoot(ctx), {
    ts: new Date().toISOString(),
    source: "agent",
    event: "catalog_error",
    status: "blocked",
    agent: normalizeRequestedAgentName(agentName),
    label: requestedSurface,
    cause: "unknown-agent",
    message: `Unknown agent: ${requestedAgent}`,
    parentSessionId: parentSessionId === "unknown-session" ? undefined : parentSessionId,
    resultPath: artifact.ok ? artifact.path : undefined,
  });
  const details: Record<string, unknown> = {
    errorLogPath: receipt.path,
    errorLogWarning: receipt.warning,
    owner: "agents-catalog",
    requestedSurface,
    status: "blocked",
    errorCode: "unknown-agent",
    requestedAgent,
    availableAgents,
    hint: "/agent list",
  };
  if (artifact.ok) details.artifactPath = artifact.path;
  else details.artifactError = artifact.reason;
  const block = unknownAgentBlock(
    requestedAgent,
    availableAgents,
    artifact,
    getProjectRoot(ctx),
    ctx.mode === "tui" ? 5 : 2,
  );
  block.hint = [
    ...(block.hint ?? []),
    `errors: ${receipt.path}`,
    ...(receipt.warning === undefined ? [] : [receipt.warning]),
  ];
  return {
    text: `${formatUnknownAgentMessage(requestedAgent, availableAgents, artifact, getProjectRoot(ctx))}\nerrors: ${receipt.path}${receipt.warning === undefined ? "" : `\n${receipt.warning}`}`,

    block,
    details,
    ...(artifact.ok ? { artifactPath: artifact.path } : {}),
  };
}

function unknownAgentBlock(
  requestedAgent: string,
  availableAgents: Array<{ name: string; source: string; description: string }>,
  artifact: { ok: true; path: string } | { ok: false; reason: string },
  projectRoot: string,
  previewLimit: number,
): OperatorBlock {
  const sourceRank = (source: string): number => (source === "project" ? 0 : source === "user" ? 1 : 2);
  const preview = [...availableAgents]
    .sort((left, right) => sourceRank(left.source) - sourceRank(right.source) || left.name.localeCompare(right.name))
    .slice(0, previewLimit);
  const hidden = availableAgents.length - preview.length;
  return {
    type: "ERROR",
    subject: "Agent catalog",
    primary: compactAgentCatalogLine(`Unknown agent: "${requestedAgent}".`),
    body: [
      `Available agents (${availableAgents.length}):`,
      ...(preview.length === 0
        ? ["- (none)"]
        : preview.map((agent) => compactAgentCatalogLine(`- ${agent.name} [${agent.source}] - ${agent.description}`))),
      ...(hidden > 0 ? [`+${hidden} agent(s) not shown`] : []),
    ],
    metadata: ["Named agents come only from the project and user catalogs."],
    hint: [
      compactAgentCatalogLine(
        artifact.ok ? `Artifact: ${relative(projectRoot, artifact.path)}` : `Artifact write failed: ${artifact.reason}`,
      ),
      compactAgentCatalogLine("Evidence boundary: catalog failure only; not child-execution proof."),
    ],
    controls: ["Recovery: /agent list"],
  };
}

function formatUnknownAgentMessage(
  requestedAgent: string,
  availableAgents: Array<{ name: string; source: string; description: string }>,
  artifact: { ok: true; path: string } | { ok: false; reason: string },
  projectRoot: string,
): string {
  const availableLines =
    availableAgents.length === 0
      ? ["- (none)"]
      : availableAgents.map((agent) => `- ${agent.name} [${agent.source}] - ${agent.description}`);
  return [
    `Unknown agent: "${requestedAgent}".`,
    "",
    "Available agents:",
    ...availableLines,
    "",
    "Named agents come only from the project and user catalogs.",
    "",
    "Run /agent list to inspect the current catalog.",
    artifact.ok ? `Artifact: ${relative(projectRoot, artifact.path)}` : `Artifact write failed: ${artifact.reason}`,
  ].join("\n");
}

function writeUnknownAgentArtifact(
  ctx: ExtensionContext,
  requestedSurface: string,
  requestedAgent: string,
  availableAgents: Array<{ name: string; source: string; description: string }>,
): { ok: true; path: string } | { ok: false; reason: string } {
  const projectRoot = getProjectRoot(ctx);
  const body = {
    version: "locus.agent.unknown-agent.v2",
    status: "blocked",
    errorCode: "unknown-agent",
    requestedSurface,
    requestedAgent,
    availableAgents,
    hint: "/agent list",
  };
  try {
    const artifact = createRuntimeArtifactStore(projectRoot).writeArtifact({
      kind: "json",
      content: `${JSON.stringify(body, null, 2)}\n`,
      sessionId: getSessionId(ctx),
      title: `Unknown agent: ${requestedAgent}`,
      metadata: {
        source: "agents-catalog",
        requestedSurface,
        errorCode: "unknown-agent",
        requestedAgent,
      },
    });
    return { ok: true, path: artifact.path };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}
