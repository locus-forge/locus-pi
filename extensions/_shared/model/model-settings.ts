import type { ThinkingLevel } from "../host/pi-api.js";
import {
  getModelRolesConfigPath,
  isThinkingLevel,
  loadModelRoleConfig,
  persistModelRole,
  validateRoleName,
  type ModelRoleAssignment,
  type ModelRoleValue,
  type ModelRolesConfig,
  type ModelRolePersistenceOutcome,
} from "./model-role-config.js";
export {
  getModelRolesConfigPath,
  type ModelRoleAssignment,
  type ModelRoleValue,
  type ModelRolesConfig,
  type ModelRolePersistenceOutcome,
} from "./model-role-config.js";

export const DEFAULT_MODEL_ROLES = [
  "default",
  "smol",
  "slow",
  "plan",
  "summary",
  "agent",
  "vision",
  "designer",
  "commit",
  "task",
  "tier-s",
  "tier-a",
  "tier-b",
  "tier-c",
] as const;
export const DEFAULT_MODEL_CYCLE_ORDER = ["smol", "default", "slow"] as const;

export const MODEL_ROLES_SESSION_ENTRY_TYPE = "model-roles";

export type ModelRoleSource = "user" | "project" | "agent" | "unset";
export type ModelRolePurpose = "prompt-planning" | "summary" | "agent" | "default";

export interface ModelRoleSessionEntry {
  version?: 1;
  role?: string;
  assignment?: ModelRoleValue;
  roles?: Record<string, ModelRoleValue>;
  modelApplied?: boolean;
  rolePersisted?: boolean;
}

/**
 * An assignment the operator DID write and this code could not parse.
 *
 * Distinct from "unset" on purpose. Collapsing the two is what let
 * `smol: "deepseek-v4-flash"` (a missing `provider/`) read as an unassigned role and
 * quietly run the parent's model under the name `smol`, while the degradation note
 * told the operator the role "is not assigned in the selected model-roles config" — a
 * false statement about their own config file, and the exact requested-vs-executed
 * conflation this task exists to remove. A typo is OD5's fail-closed case.
 */
export interface MalformedRoleAssignment {
  /** The raw text as written, quoted back so the operator can find it. */
  value: string;
}

export interface EffectiveRole {
  role: string;
  source: ModelRoleSource;
  configPath?: string;
  inherited: boolean;
  assignment?: ModelRoleAssignment;
  malformed?: MalformedRoleAssignment;
}

export interface ModelRolesState {
  path: string;
  source: "user" | "project";
  exists: boolean;
  config: ModelRolesConfig;
  effective: Map<string, EffectiveRole>;
  cycleOrder: string[];
}

export interface ModelRoleResolution {
  purpose: ModelRolePurpose;
  requestedRoles: string[];
  role: string;
  source: ModelRoleSource;
  configPath?: string;
  inherited: boolean;
  assignment?: ModelRoleAssignment;
  /** Set when the role's assignment exists but is not a parseable selector. */
  malformed?: MalformedRoleAssignment;
  fallback: boolean;
}

export interface ModelRoleResolutionRecord {
  purpose: ModelRolePurpose;
  requestedRoles: string[];
  role: string;
  source: ModelRoleSource;
  configPath?: string;
  inherited: boolean;
  fallback: boolean;
  model?: string;
  thinking?: ThinkingLevel;
}

export async function loadModelRolesState(projectRoot?: string): Promise<ModelRolesState> {
  const file = await loadModelRoleConfig(projectRoot);
  return buildModelRolesState(file.path, file.config, file.source, file.exists);
}

export function buildModelRolesState(
  path: string,
  config: ModelRolesConfig,
  source: "user" | "project" = "user",
  exists = true,
): ModelRolesState {
  const cycleOrder = config.cycleOrder ?? [...DEFAULT_MODEL_CYCLE_ORDER];
  const roles = new Set([...DEFAULT_MODEL_ROLES, ...Object.keys(config.roles ?? {}), ...cycleOrder]);
  const effective = new Map<string, EffectiveRole>();
  for (const role of roles) {
    const value = config.roles !== undefined && Object.hasOwn(config.roles, role) ? config.roles[role] : undefined;
    // A value the operator wrote but this code cannot parse is recorded as
    // `malformed`, never as plain "unset": the caller has to be able to tell a role
    // nobody assigned (degrade, per OD5) from a typo (fail closed, per OD5).
    const present = (configured: Exclude<ModelRoleValue, null>): EffectiveRole => {
      const assignment = normalizeAssignment(configured);
      if (assignment) return { role, source, configPath: path, inherited: false, assignment };
      return {
        role,
        source: "unset",
        inherited: false,
        malformed: { value: rawAssignmentText(configured) },
      };
    };
    effective.set(
      role,
      value === undefined || value === null ? { role, source: "unset", inherited: false } : present(value),
    );
  }
  return { path, source, exists, config, effective, cycleOrder };
}

export function resolveModelRoleForPurpose(
  state: ModelRolesState,
  purpose: ModelRolePurpose,
  preferredRoles: string[] = [],
): ModelRoleResolution {
  const requestedRoles = [...preferredRoles, ...defaultRolesForPurpose(purpose)];
  for (const role of requestedRoles) {
    const effective = state.effective.get(role);
    if (effective?.assignment) {
      return {
        purpose,
        requestedRoles,
        role,
        source: effective.source,
        configPath: state.path,
        inherited: effective.inherited,
        assignment: effective.assignment,
        fallback: role !== requestedRoles[0],
      };
    }
  }
  // Nothing in the chain resolved. If one of the roles we consulted carries a
  // malformed assignment, that is why, and saying "unassigned" here would hide an
  // operator typo behind a silent degrade on the no-tier-declared path too.
  const malformed = requestedRoles
    .map((name) => state.effective.get(name)?.malformed)
    .find((entry) => entry !== undefined);
  return {
    purpose,
    requestedRoles,
    role: requestedRoles[0] ?? "default",
    source: "unset",
    inherited: false,
    ...(malformed !== undefined ? { malformed } : {}),
    fallback: true,
  };
}

/**
 * Split a thinking-level suffix off a bare role token.
 *
 * `smol:high` names the role `smol` at the `high` level, exactly as
 * `provider/id:high` names a concrete model at that level in
 * `parseModelSelector`. The two grammars must agree: looking the whole token up
 * as a role name finds nothing, and a role that resolves to nothing degrades to
 * the parent model — so an author who spelled out a tier would silently get a
 * different model, which is the substitution the tier work exists to stop.
 *
 * The model half selects the registry entry; the level is preserved in the
 * assignment so workflow and agent execution owners can pass it to the child
 * session as real reasoning effort.
 *
 * The `:<level>` space is reserved by this grammar: a role literally named
 * `foo:high` can no longer be addressed by that literal name. Six words are
 * reserved; any other suffix stays part of the role name.
 */
export function splitRoleSelector(token: string): { role: string; thinking?: ThinkingLevel } {
  const trimmed = token.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) return { role: trimmed };
  const suffix = trimmed.slice(colon + 1);
  if (!isThinkingLevel(suffix)) return { role: trimmed };
  return { role: trimmed.slice(0, colon), thinking: suffix };
}

/**
 * Resolve ONE declared role, with no purpose fallback chain.
 *
 * Purpose resolution may choose a purpose-owned fallback, which is right for "give
 * me the configured model for this purpose" and wrong for an author who wrote
 * `modelRole: "smol"`: falling through to `agent` would answer a question nobody
 * asked and run a different tier under the requested tier's name. So a declared role
 * resolves to its own assignment or to none at all, and the caller decides what
 * "none" means (today: degrade to the parent model and record it).
 */
export function resolveDeclaredModelRole(state: ModelRolesState, role: string): ModelRoleResolution {
  const { role: declaredRole, thinking } = splitRoleSelector(role);
  const effective = state.effective.get(declaredRole);
  // A suffix the author wrote overrides the level the assignment carries, the same
  // way it does on a concrete selector. The model half is what the registry
  // resolves; the execution owner applies the preserved level.
  const assignment =
    effective?.assignment !== undefined && thinking !== undefined
      ? { ...effective.assignment, thinking }
      : effective?.assignment;
  return {
    purpose: "agent",
    requestedRoles: [role],
    role: declaredRole,
    source: effective?.source ?? "unset",
    configPath: state.path,
    inherited: effective?.inherited ?? false,
    ...(assignment !== undefined ? { assignment } : {}),
    ...(effective?.malformed !== undefined ? { malformed: effective.malformed } : {}),
    fallback: false,
  };
}

/** One explicit role request shared by workflow and standalone callers. */
export function selectDeclaredModelRole(state: ModelRolesState, token: string, required = false): ModelRoleResolution {
  if (token.includes("/"))
    throw new Error(
      `modelRole ${JSON.stringify(token)} is not a role name: use model: ${JSON.stringify(token)} for a concrete provider/id selector.`,
    );
  validateRoleName(splitRoleSelector(token).role);
  const selected = resolveDeclaredModelRole(state, token);
  if (selected.malformed !== undefined)
    throw new Error(malformedRoleAssignmentNote(token, "modelRole", selected.malformed, state.path));
  if (required && selected.assignment === undefined)
    throw new Error(
      `modelRole ${JSON.stringify(token)} is required, but is not assigned in ${state.path}. Assign it with /model-roles before running.`,
    );
  return selected;
}

/**
 * The pre-tier role namespace, `pi/<role>`.
 *
 * Before tiers were executed, the former package profiles wrote their tier as `pi/<role>` and
 * nothing read it — `pi` was never a provider. Now that a slash means a real
 * provider, that spelling parses as a concrete selector no registry can resolve, so
 * an install still carrying a copy of the old catalog (a user-level
 * `~/.agents/agents/*.md`, a project catalog cloned from an older release, a
 * `.agents/` directory vendored into someone's own repository) fails EVERY workflow
 * step closed before a child is created.
 *
 * That is the one case the fail-closed rule gets wrong, and it gets it wrong against
 * the package's own promise: the operator did not write `pi/task`, this package did,
 * and "a copied legacy profile must not fail closed just because nobody has configured
 * a tier yet" is exactly what D3b already guarantees for an unassigned role. So a tier in
 * this namespace is read as the role it always meant, and the degradation note says
 * where to fix the spelling.
 *
 * Scoped to a KNOWN role on purpose: `pi/task` is package history, `pi/gpt-5` is an
 * operator naming a provider that does not exist, and only the first is safe to
 * reinterpret. Scoped to agent FRONTMATTER on purpose too: a per-call `model:` or
 * `modelRole:` in a workflow script is code being authored today against the current
 * grammar, so it keeps refusing with the migration hint rather than being repaired.
 */
const LEGACY_ROLE_NAMESPACE_PREFIX = "pi/";

/**
 * The role token behind a pre-tier selector, or `undefined` when the selector is not
 * one. The token keeps any `:<level>` suffix, because the level is the author's and
 * survives the namespace: `pi/smol:high` means the role `smol` at `high`.
 */
export function legacyNamespacedRoleToken(state: ModelRolesState, selector: string): string | undefined {
  const trimmed = selector.trim();
  if (!trimmed.startsWith(LEGACY_ROLE_NAMESPACE_PREFIX)) return undefined;
  const token = trimmed.slice(LEGACY_ROLE_NAMESPACE_PREFIX.length).trim();
  // A second slash is a real two-segment id, not a role that happens to sit under
  // the old prefix; leave it to the registry so it fails by its own name.
  if (token === "" || token.includes("/")) return undefined;
  const { role } = splitRoleSelector(token);
  return state.effective.has(role) ? token : undefined;
}

/** The migration sentence appended wherever a pre-tier tier was read as a role. */
export function legacyRoleNamespaceNote(declared: string, role: string): string {
  return (
    ` ${JSON.stringify(declared)} is the pre-tier role namespace and was read as the role ` +
    `${JSON.stringify(role)}; write the tier bare (\`model: ${role}\`), because a slash now means a ` +
    `real provider.`
  );
}

/**
 * The note for an agent whose FRONTMATTER tier resolved to nothing.
 *
 * One owner, because the workflow bridge, `/agent run` and `spawn_agent` must degrade
 * with the same recorded sentence (OD2) — including the extra sentence a pre-tier
 * spelling earns, which is the only place an operator learns their catalog is stale
 * now that the spelling no longer fails the run.
 */
export function unassignedAgentTierNote(
  agentName: string,
  declared: string,
  resolution: ModelRoleResolution,
  state: ModelRolesState,
): string {
  const note = unassignedRoleNote(declared, `agent "${agentName}" frontmatter model`, state);
  const role = legacyNamespacedRoleToken(state, declared) === undefined ? undefined : resolution.role;
  return role === undefined ? note : `${note}${legacyRoleNamespaceNote(declared, role)}`;
}

/**
 * One sentence an operator can act on: what was named, what was read, what happened
 * instead.
 *
 * Shared by the workflow bridge and the interactive launcher so that `/agent run
 * reviewer` and a workflow stage naming `reviewer` degrade with the SAME recorded
 * sentence (OD2). The past tense is deliberate and load-bearing: callers may only
 * emit this once the child has actually been prompted — a built-but-never-prompted
 * session is not an execution, and this is a claim about one. `executedModel` is
 * the gate every caller uses, because it is set only after child kickoff.
 */
export function unassignedRoleNote(role: string, origin: string, state: ModelRolesState): string {
  return (
    `${origin} ${JSON.stringify(role)} is not assigned in the selected model-roles config ` +
    `(${state.path}); the child inherited the parent session model.`
  );
}

/**
 * The refusal text for a malformed assignment, shared by every caller so the
 * workflow bridge and the interactive launcher name the same file and the same fix.
 *
 * Present tense and no claim about a child: this refusal is issued BEFORE anything
 * is created, which is the point — a typo must never reach `createSession`.
 */
export function malformedRoleAssignmentNote(
  role: string,
  origin: string,
  malformed: MalformedRoleAssignment,
  path?: string,
): string {
  return (
    `${origin} ${JSON.stringify(role)} is assigned ${JSON.stringify(malformed.value)} by the ` +
    `model-roles config${path === undefined ? "" : ` (${path})`}, but that is not a "provider/id" selector ` +
    `(an optional ":off|minimal|low|medium|high|xhigh" reasoning-effort suffix is allowed). ` +
    `Fix or remove that assignment — a malformed assignment is a configuration error, not an ` +
    `unassigned role, so it is NOT degraded to the session model.`
  );
}

export function resolvePromptPlanningModelRole(state: ModelRolesState): ModelRoleResolution {
  return resolveModelRoleForPurpose(state, "prompt-planning");
}

export function resolveSummaryModelRole(state: ModelRolesState): ModelRoleResolution {
  return resolveModelRoleForPurpose(state, "summary");
}

export function resolveAgentModelPreference(state: ModelRolesState, agentModels: string[] = []): ModelRoleResolution {
  const first = agentModels[0];
  if (first) {
    // `pi/<role>` is this package's own pre-tier spelling, not a provider. Read it as
    // the role BEFORE the slash rule turns it into a concrete selector no registry
    // can resolve — otherwise a stale catalog refuses every call. `requestedRoles`
    // keeps the text as written so the evidence still points at the file to edit.
    const legacyToken = legacyNamespacedRoleToken(state, first);
    if (legacyToken !== undefined) {
      return { ...resolveDeclaredModelRole(state, legacyToken), requestedRoles: [first] };
    }
    const direct = parseModelSelector(first);
    if (direct) {
      return {
        purpose: "agent",
        requestedRoles: [first],
        role: "agent",
        source: "agent",
        inherited: false,
        assignment: direct,
        fallback: false,
      };
    }
    // A DECLARED role resolves to its own assignment or to none — never through
    // purpose resolution.
    // An agent whose frontmatter says `model: smol` must not run the `task` tier
    // because `smol` happens to be unassigned and `task` happens not to be: that is
    // a different model under the requested tier's name, which is the silent
    // substitution D3a exists to stop. It reads the same as the per-call
    // `modelRole` rule in the bridge, and all three production callers
    // (workflow bridge, `/agent run`, `spawn_agent`) inherit it from here, which is
    // the parity OD2 asked for.
    return resolveDeclaredModelRole(state, first);
  }
  // No frontmatter tier at all — "no tier declared". AGENT is the one configurable
  // default for a child. If it is unset, execution inherits the live parent session
  // model; TASK and DEFAULT must not silently replace CURRENT.
  return resolveModelRoleForPurpose(state, "agent");
}

export function modelRoleResolutionRecord(resolution: ModelRoleResolution): ModelRoleResolutionRecord {
  const record: ModelRoleResolutionRecord = {
    purpose: resolution.purpose,
    requestedRoles: [...resolution.requestedRoles],
    role: resolution.role,
    source: resolution.source,
    ...(resolution.configPath === undefined ? {} : { configPath: resolution.configPath }),
    inherited: resolution.inherited,
    fallback: resolution.fallback,
  };
  if (resolution.assignment !== undefined) {
    record.model = resolution.assignment.model;
    if (resolution.assignment.thinking !== undefined) record.thinking = resolution.assignment.thinking;
  }
  return record;
}

export async function setModelRoleSetting(
  role: string,
  assignment: ModelRoleAssignment,
  path = getModelRolesConfigPath(),
): Promise<ModelRolePersistenceOutcome> {
  return persistModelRole(path, role, formatAssignment(assignment));
}

/** The assignment as the operator wrote it, for quoting back in a refusal. */
export function rawAssignmentText(value: Exclude<ModelRoleValue, null>): string {
  return typeof value === "string" ? value : formatAssignment(value);
}

export function normalizeAssignment(value: ModelRoleValue): ModelRoleAssignment | undefined {
  if (value === null) return undefined;
  if (typeof value === "string") return parseModelSelector(value);
  return parseModelSelector(formatAssignment(value));
}

export function parseModelSelector(selector: string): ModelRoleAssignment | undefined {
  const trimmed = selector.trim();
  if (!trimmed.includes("/")) return undefined;
  const colon = trimmed.lastIndexOf(":");
  const suffix = colon > -1 ? trimmed.slice(colon + 1) : "";
  if (suffix && isThinkingLevel(suffix)) return { model: trimmed.slice(0, colon), thinking: suffix };
  return { model: trimmed };
}

export function formatAssignment(assignment: ModelRoleAssignment): string {
  return assignment.thinking ? `${assignment.model}:${assignment.thinking}` : assignment.model;
}

function defaultRolesForPurpose(purpose: ModelRolePurpose): string[] {
  switch (purpose) {
    case "prompt-planning":
      return ["plan", "default"];
    case "summary":
      return ["summary", "smol", "default"];
    case "agent":
      return ["agent"];
    case "default":
      return ["default"];
  }
}
