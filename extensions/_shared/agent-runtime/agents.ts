import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The agent-definition contract lives here because this module is where every instance is
 * minted: `parseAgentMarkdown` is the only thing in the package that turns a `.agents/agents/`
 * file into an `AgentDefinition`, and the normalizers below own each field's accepted values.
 * Its consumers — the agent envelope, the `agents` extension, and the workflows bridge — all
 * take it type-only, so nothing pays for this module's `node:fs` at runtime.
 */
export type AgentSource = "project" | "user" | "workflow";
export type PermissionMode = "inherit-parent" | "agent-defined" | "restricted";

/** Fields of `AgentEvidencePolicy`; not named anywhere else, so they stay module-private. */
type AgentEvidenceMode = "none" | "warn" | "require";
type AgentClaimsWithoutEvidence = "off" | "warn";

export interface AgentEvidencePolicy {
  mode: AgentEvidenceMode;
  requireAnyToolCall?: boolean;
  requireAnyOf?: string[];
  claimsWithoutEvidence?: AgentClaimsWithoutEvidence;
}

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  allowedTools: string[];
  tools?: string[];
  spawns?: string[] | "*";
  model?: string[];
  thinkingLevel?: string;
  output?: unknown;
  evidence?: AgentEvidencePolicy;
  blocking?: boolean;
  parentContextDefault?: boolean;
  risk: "low" | "medium" | "high";
  readOnly: boolean;
  permissionMode?: PermissionMode;
  source?: AgentSource;
  filePath?: string;
}

export interface AgentDiagnostic {
  filePath: string;
  message: string;
}

export interface AgentDiscoveryResult {
  definitions: AgentDefinition[];
  diagnostics: AgentDiagnostic[];
}

export interface AgentDiscoveryOptions {
  userHome?: string;
}

export interface AgentParseResult {
  definition?: AgentDefinition;
  diagnostics: AgentDiagnostic[];
}

export function discoverAgentDefinitions(
  projectRoot: string,
  options: AgentDiscoveryOptions = {},
): AgentDiscoveryResult {
  const agentMap = new Map<string, AgentDefinition>();
  const diagnostics: AgentDiagnostic[] = [];
  for (const { dir, source } of agentDiscoveryDirs(projectRoot, options)) {
    const loaded = loadAgentsFromDir(dir, source);
    diagnostics.push(...loaded.diagnostics);
    for (const agent of loaded.definitions) {
      if (!agentMap.has(agent.name)) agentMap.set(agent.name, agent);
    }
  }
  return {
    definitions: [...agentMap.values()],
    diagnostics,
  };
}

export function agentDiscoveryDirs(
  projectRoot: string,
  options: AgentDiscoveryOptions = {},
): Array<{ dir: string; source: AgentSource }> {
  const dirs: Array<{ dir: string; source: AgentSource }> = [];
  const projectDir = nearestProjectAgentDir(projectRoot, [".agents", "agents"]);
  if (projectDir) dirs.push({ dir: projectDir, source: "project" });
  const userHome = options.userHome ?? process.env.HOME;
  if (userHome) dirs.push({ dir: path.join(userHome, ".agents", "agents"), source: "user" });
  return dirs;
}

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentDiscoveryResult {
  if (!isDirectory(dir)) return { definitions: [], diagnostics: [] };
  const definitions: AgentDefinition[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = path.join(dir, entry.name);
    const parsed = parseAgentMarkdown(readFileSync(filePath, "utf8"), source, filePath);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.definition !== undefined) definitions.push(parsed.definition);
  }
  return { definitions, diagnostics };
}

export function parseAgentMarkdown(content: string, source: AgentSource, filePath: string): AgentParseResult {
  const diagnostics: AgentDiagnostic[] = [];
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) return { diagnostics: [{ filePath, message: "missing frontmatter" }] };
  const metadata = parseFrontmatter(match[1] ?? "");
  const name = asScalar(metadata["name"]);
  const description = asScalar(metadata["description"]);
  if (!name) diagnostics.push({ filePath, message: "frontmatter.name is required" });
  if (!description) diagnostics.push({ filePath, message: "frontmatter.description is required" });
  if (!name || !description) return { diagnostics };

  const tools = normalizeTools(asStringList(metadata["allowedTools"] ?? metadata["tools"]));
  const spawns = asSpawns(metadata["spawns"] ?? (tools.includes("task") ? "*" : undefined));
  const model = asStringList(metadata["model"]);
  const permissionMode = asPermissionMode(metadata["permissionMode"], filePath, diagnostics);
  const agent: AgentDefinition = {
    name,
    description,
    systemPrompt: content.slice(match[0].length),
    allowedTools: tools.length ? tools : ["*"],
    risk: asRisk(asScalar(metadata["risk"])),
    readOnly: asBoolean(metadata["readOnly"], tools.length > 0 && !tools.some(isMutatingTool)),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    evidence: asEvidencePolicy(metadata["evidence"] as Record<string, unknown> | undefined, filePath, diagnostics),
    source,
    filePath,
  };
  if (tools.length) agent.tools = tools;
  if (spawns) agent.spawns = spawns;
  if (model.length) agent.model = model;
  const thinkingLevel = asScalar(metadata["thinking-level"] ?? metadata["thinkingLevel"]);
  if (thinkingLevel) agent.thinkingLevel = thinkingLevel;
  const output = metadata["output"];
  if (output !== undefined) agent.output = output;
  const blocking = asOptionalBoolean(metadata["blocking"]);
  if (blocking !== undefined) agent.blocking = blocking;
  const parentContextDefault = asOptionalBoolean(metadata["parentContextDefault"]);
  if (parentContextDefault !== undefined) agent.parentContextDefault = parentContextDefault;
  return { definition: agent, diagnostics };
}

/** Entries the caller-facing catalog advertises before it truncates (T-111). */
export const AGENT_CATALOG_HINT_MAX_ENTRIES = 12;
/** Per-entry description cap; same number the workflow catalog already uses. */
export const AGENT_CATALOG_HINT_MAX_DESCRIPTION_CHARS = 96;

export interface AgentCatalogHintOptions {
  maxEntries?: number;
  maxDescriptionChars?: number;
}

/**
 * One bounded `name — description` line per resolved agent, for injection where
 * the calling model picks an agent name (T-111). The input is expected to be the
 * already-resolved first-match-wins set from `discoverAgentDefinitions`, so a
 * project definition shadowing a user name contributes exactly one line.
 *
 * Bounded twice on purpose — the package's default surface stays narrow: at most
 * `maxEntries` lines, each description clamped to `maxDescriptionChars`. Overflow
 * is stated rather than hidden, so a caller that needs the rest knows the list is
 * partial; the unknown-agent error path remains the fail-closed check.
 */
export function formatAgentCatalogHint(
  definitions: readonly AgentDefinition[],
  options: AgentCatalogHintOptions = {},
): string {
  const maxEntries = Math.max(0, options.maxEntries ?? AGENT_CATALOG_HINT_MAX_ENTRIES);
  const maxDescriptionChars = Math.max(1, options.maxDescriptionChars ?? AGENT_CATALOG_HINT_MAX_DESCRIPTION_CHARS);
  // Project first, then user: a locally authored agent must never
  // be the entry that falls off the end of the cap.
  const ordered = [...definitions].sort(
    (left, right) => agentSourceRank(left) - agentSourceRank(right) || left.name.localeCompare(right.name),
  );
  const shown = ordered.slice(0, maxEntries);
  const lines = shown.map(
    (agent) => `${agent.name} — ${truncatePlain(flattenText(agent.description), maxDescriptionChars)}`,
  );
  const hidden = ordered.length - shown.length;
  if (hidden > 0) lines.push(`+${hidden} more — /agent list`);
  return lines.join("\n");
}

export function formatAgentListItem(agent: AgentDefinition): string {
  const parts = [
    `tools=${agent.allowedTools.join(", ")}`,
    agent.model?.length ? `model=${agent.model.join(", ")}` : undefined,
    agent.thinkingLevel ? `thinking=${agent.thinkingLevel}` : undefined,
    agent.spawns
      ? `spawns=requested:${agent.spawns === "*" ? "*" : agent.spawns.join(", ")} (blocked by host)`
      : undefined,
    agent.blocking ? "blocking=true" : undefined,
    agent.output === undefined ? undefined : "output=true",
    agent.source ? `source=${agent.source}` : undefined,
  ].filter(Boolean);
  return `${agent.name}: ${agent.description} [${parts.join("; ")}]`;
}

function nearestProjectAgentDir(projectRoot: string, segments: string[]): string | null {
  let current = path.resolve(projectRoot);
  while (true) {
    const candidate = path.join(current, ...segments);
    if (isDirectory(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

type FrontmatterContainer = Record<string, unknown> | unknown[];

function parseFrontmatter(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: FrontmatterContainer; parent?: Record<string, unknown>; key?: string }> =
    [{ indent: -1, value: root }];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const listMatch = /^-\s+(.+)$/.exec(line.trim());
    if (listMatch) {
      const current = stack[stack.length - 1]!;
      if (!Array.isArray(current.value) && current.parent && current.key) {
        current.value = [];
        current.parent[current.key] = current.value;
      }
      if (Array.isArray(current.value)) current.value.push(parseScalar(listMatch[1]!.trim()));
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line.trim());
    if (!match) continue;
    const parent = stack[stack.length - 1]!.value;
    if (Array.isArray(parent)) continue;
    const key = match[1]!;
    const rawValue = match[2] ?? "";
    if (!rawValue.trim()) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child, parent, key });
    } else {
      parent[key] = parseScalar(rawValue.trim());
    }
  }
  return root;
}

function parseScalar(value: string): unknown {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item.trim()));
  }
  return value;
}

function asScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asScalar).filter((item): item is string => Boolean(item));
  const scalar = asScalar(value);
  if (!scalar) return [];
  const withoutBrackets = scalar.replace(/^\[/, "").replace(/\]$/, "");
  return withoutBrackets
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  const parsed = asOptionalBoolean(value);
  return parsed ?? fallback;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const scalar = asScalar(value)?.toLowerCase();
  if (scalar === "true") return true;
  if (scalar === "false") return false;
  return undefined;
}

function asEvidencePolicy(
  value: Record<string, unknown> | undefined,
  filePath: string,
  diagnostics: AgentDiagnostic[],
): AgentEvidencePolicy {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value))
    return { mode: "none" };

  const allowedKeys = new Set(["mode", "requireAnyToolCall", "requireAnyOf", "claimsWithoutEvidence"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key))
      diagnostics.push({ filePath, message: `frontmatter.evidence has unknown field: ${key}` });
  }

  const policy: AgentEvidencePolicy = { mode: "none" };
  const mode = asScalar(value["mode"]);
  if (mode === "none" || mode === "warn" || mode === "require") {
    policy.mode = mode;
  } else if (mode !== undefined) {
    diagnostics.push({ filePath, message: `frontmatter.evidence.mode must be one of: none, warn, require` });
  }

  const requireAnyToolCall = asOptionalBoolean(value["requireAnyToolCall"]);
  if (requireAnyToolCall !== undefined) policy.requireAnyToolCall = requireAnyToolCall;

  const requireAnyOf = asStringList(value["requireAnyOf"]);
  if (requireAnyOf.length) policy.requireAnyOf = requireAnyOf;

  const claimsWithoutEvidence = asScalar(value["claimsWithoutEvidence"]);
  if (claimsWithoutEvidence === "off" || claimsWithoutEvidence === "warn") {
    policy.claimsWithoutEvidence = claimsWithoutEvidence;
  } else if (claimsWithoutEvidence !== undefined) {
    diagnostics.push({ filePath, message: `frontmatter.evidence.claimsWithoutEvidence must be one of: off, warn` });
    policy.claimsWithoutEvidence = "off";
  }

  return policy;
}

function asRisk(value: string | undefined): AgentDefinition["risk"] {
  return value === "medium" || value === "high" ? value : "low";
}

function asPermissionMode(
  value: unknown,
  filePath: string,
  diagnostics: AgentDiagnostic[],
): PermissionMode | undefined {
  const scalar = asScalar(value);
  if (scalar === "inherit-parent" || scalar === "agent-defined" || scalar === "restricted") return scalar;
  if (scalar !== undefined) {
    diagnostics.push({
      filePath,
      message: "frontmatter.permissionMode must be one of: inherit-parent, agent-defined, restricted",
    });
  }
  return undefined;
}

function normalizeTools(tools: string[]): string[] {
  if (!tools.length || tools.includes("yield")) return tools;
  return [...tools, "yield"];
}

function asSpawns(value: unknown): AgentDefinition["spawns"] {
  const scalar = asScalar(value);
  if (scalar === "*") return "*";
  const spawns = asStringList(value);
  return spawns.length ? spawns : undefined;
}

function agentSourceRank(agent: AgentDefinition): number {
  return agent.source === "project" ? 0 : 1;
}

/** Collapses a multi-line frontmatter description into one catalog line. */
function flattenText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncatePlain(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 0) return "";
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function isMutatingTool(tool: string): boolean {
  return ["bash", "edit", "write", "ast_edit", "resolve"].includes(tool);
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
