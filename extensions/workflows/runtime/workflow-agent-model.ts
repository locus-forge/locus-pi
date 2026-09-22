/**
 * workflow-agent-model.ts — Which model a workflow agent() call runs on.
 *
 * One owner for workflow model ROUTING: it reads the declared per-call `model` /
 * `modelRole` and the agent frontmatter, consults the roles table and the shared
 * registry resolver, and returns a decided tier. It is not a second model resolver:
 * every concrete selector still goes through the injected `WorkflowModelResolver`
 * (`_shared/model/workflow-model-resolve.ts`) and every role lookup through
 * `_shared/model/model-settings.ts`.
 *
 * Both the workflow agent preflight and the runner call `resolveWorkflowTier`, so a
 * composition refuses a bad leg before it can spend a member, and a single call
 * refuses before a child session exists. Transport capability (can this model host
 * session tools?) is decided by the bridge on the resolved tier, not here: it depends
 * on what the call asked the child to RETURN, which routing does not know.
 */

import type { ThinkingLevel } from "../../_shared/host/pi-api.js";
import type { ModelRoleResolution } from "../../_shared/model/model-settings.js";
import {
  DEFAULT_MODEL_ROLES,
  formatAssignment,
  resolveAgentModelPreference,
  malformedRoleAssignmentNote,
  resolveDeclaredModelRole,
  unassignedAgentTierNote,
  unassignedRoleNote,
  type ModelRolesState,
} from "../../_shared/model/model-settings.js";
import type { WorkflowModelResolver } from "../../_shared/model/workflow-model-resolve.js";
import type { WorkflowAgentRequest } from "./workflow-agent-contract.js";
import type { AgentDefinition } from "../../_shared/agent-runtime/agents.js";

/**
 * Which model this call runs on, decided before any child exists.
 *
 * Three outcomes, and the difference between them is the whole point of the tier
 * feature:
 *
 *  - `resolved` — a concrete model came out of the registry and reaches the child.
 *  - `inherit`  — nothing was declared, or a declared ROLE has no assignment in the
 *    global config. The child runs on the parent session model and, when a role was named,
 *    `fallback` records that in one sentence. Quiet fallback, loud record.
 *  - `refused`  — a CONCRETE `provider/id` selector did not resolve. A typo, a
 *    provider that is not configured, a model the host does not have. The call ends
 *    here with the selector quoted and zero child sessions.
 *
 * The asymmetry is deliberate and is the owner's decision (OD5): the package ships
 * no role assignments, so refusing an unassigned named profile role would fail on a
 * stock install; but a selector an author typed by hand is an instruction,
 * and silently running something else is exactly what this task exists to stop.
 */
export type WorkflowTier =
  | {
      kind: "resolved";
      /** Where the tier came from — used only to phrase diagnostics. */
      origin: "call-model" | "call-role" | "frontmatter";
      selector: string;
      model: unknown;
      thinking?: ThinkingLevel;
      roleResolution: ModelRoleResolution;
    }
  | { kind: "inherit"; roleResolution: ModelRoleResolution; fallback?: string }
  | { kind: "refused"; message: string };

export async function resolveWorkflowTier(input: {
  req: WorkflowAgentRequest;
  agent: AgentDefinition | undefined;
  modelRoles: ModelRolesState;
  resolveModelFn: WorkflowModelResolver;
}): Promise<WorkflowTier> {
  const { req, agent, modelRoles, resolveModelFn } = input;
  // Frontmatter preference is computed either way: it is what the request capsule,
  // the run-result artifact and the live row have always recorded, and dropping it
  // on the per-call paths would silently change three evidence surfaces.
  const frontmatterResolution = resolveAgentModelPreference(modelRoles, agent?.model ?? []);

  if (req.requireModelRole === true && req.modelRole === undefined) {
    return refusal("requireModelRole: true requires one explicit modelRole on the same agent call");
  }
  if (req.requireModelRole === true && req.model !== undefined) {
    return refusal(
      "requireModelRole: true cannot be combined with a concrete model; remove model or the strict role flag",
    );
  }

  if (req.model !== undefined) {
    const resolution = await resolveModelFn(req.model);
    if (!resolution.ok) {
      return refusal(`Per-call model ${JSON.stringify(req.model)} could not be used: ${resolution.message}`, req.model);
    }
    return {
      kind: "resolved",
      origin: "call-model",
      selector: resolution.selector,
      model: resolution.model,
      ...(resolution.thinking !== undefined ? { thinking: resolution.thinking } : {}),
      roleResolution: frontmatterResolution,
    };
  }

  if (req.modelRole !== undefined) {
    // `modelRole` is a NAME IN THE ROLES TABLE and never a provider selector (D4).
    // A slash means a concrete `provider/id` under the OD1 grammar, so a
    // slash-bearing `modelRole` is a category error, not an unassigned role — and
    // treating it as one would degrade it to the session model, i.e. silently run
    // something other than the model the author spelled out. That is the exact
    // fail-closed case OD5 keeps loud, so it refuses with the option to use instead.
    if (req.modelRole.includes("/")) {
      return refusal(
        `modelRole ${JSON.stringify(req.modelRole)} is not a role name: a "/" means a concrete ` +
          `provider/id selector, and modelRole only ever names a role in the model-roles table. ` +
          `Use \`model: ${JSON.stringify(req.modelRole)}\` to pin a concrete model, or name a bare ` +
          `role (one of: ${DEFAULT_MODEL_ROLES.join(", ")}).`,
        req.modelRole,
      );
    }
    // The DECLARED role only. Purpose resolution would answer a question the author
    // did not ask, and `modelRole: "smol"` would run whatever `agent` holds.
    const declared = resolveDeclaredModelRole(modelRoles, req.modelRole);
    if (declared.malformed !== undefined) {
      // Assigned but unparseable — a config typo, not an unassigned role. Degrading
      // it would run the parent's model under the requested tier's name and tell the
      // operator their role was "not assigned in the global config", which their own file
      // contradicts.
      return refusal(malformedRoleAssignmentNote(req.modelRole, "modelRole", declared.malformed), req.modelRole);
    }
    if (declared.assignment === undefined) {
      if (req.requireModelRole === true) {
        return refusal(
          `modelRole ${JSON.stringify(req.modelRole)} is required by this workflow stage, but the global ` +
            "model-roles config does not assign it. Assign the role with /model-roles before running this workflow.",
          req.modelRole,
        );
      }
      return {
        kind: "inherit",
        roleResolution: declared,
        fallback: unassignedRoleNote(req.modelRole, "modelRole", modelRoles),
      };
    }
    const selector = formatAssignment(declared.assignment);
    const resolution = await resolveModelFn(selector);
    if (!resolution.ok) {
      return refusal(
        `modelRole ${JSON.stringify(req.modelRole)} could not be used: it is assigned ` +
          `${JSON.stringify(selector)} by the ${declared.source} layer, but that ${resolution.message}`,
        selector,
      );
    }
    return {
      kind: "resolved",
      origin: "call-role",
      selector: resolution.selector,
      model: resolution.model,
      ...(resolution.thinking !== undefined ? { thinking: resolution.thinking } : {}),
      roleResolution: declared,
    };
  }

  if (agent === undefined) return { kind: "inherit", roleResolution: frontmatterResolution };

  const frontmatterSelector = agent.model?.[0];
  if (frontmatterResolution.malformed !== undefined) {
    // D3b softens an UNASSIGNED frontmatter role so a stock install still works. It
    // does not soften a broken roles file: no foreign operator has one, and the only
    // way to reach here is for this machine's config to name a selector it cannot parse.
    return refusal(
      malformedRoleAssignmentNote(
        frontmatterSelector ?? frontmatterResolution.role,
        `agent "${agent.name}" frontmatter model`,
        frontmatterResolution.malformed,
      ),
      frontmatterSelector,
    );
  }
  if (frontmatterResolution.assignment === undefined) {
    return {
      kind: "inherit",
      roleResolution: frontmatterResolution,
      ...(frontmatterSelector !== undefined
        ? { fallback: unassignedAgentTierNote(agent.name, frontmatterSelector, frontmatterResolution, modelRoles) }
        : {}),
    };
  }
  const selector = formatAssignment(frontmatterResolution.assignment);
  const resolution = await resolveModelFn(selector);
  if (!resolution.ok) {
    return refusal(
      `Agent "${agent.name}" frontmatter model ${JSON.stringify(frontmatterSelector ?? selector)} could not be used: ` +
        `it resolves to ${JSON.stringify(selector)} (${frontmatterResolution.source} layer), ` +
        `but that ${resolution.message}`,
      frontmatterSelector ?? selector,
    );
  }
  return {
    kind: "resolved",
    origin: "frontmatter",
    selector: resolution.selector,
    model: resolution.model,
    ...(resolution.thinking !== undefined ? { thinking: resolution.thinking } : {}),
    roleResolution: frontmatterResolution,
  };
}

function refusal(message: string, selector?: string): WorkflowTier {
  return { kind: "refused", message: `${message}${legacyRoleNamespaceHint(selector)}` };
}

/**
 * The one predictable way this refusal fires on an upgrade.
 *
 * Before tiers, the former bundled profiles wrote their tier as `pi/<role>`, and nothing read
 * it — `pi` was never a provider. An agent's FRONTMATTER in that namespace is now
 * repaired in `resolveAgentModelPreference`, because that spelling is the package's
 * own history and refusing it makes a stale catalog unusable. Everything else still
 * fails closed and reaches here: a per-call `model` / `modelRole` written today, a
 * roles-table entry the operator assigned by hand, or `pi/<not-a-role>`, where
 * "provider pi has no model X" alone tells them nothing about what to edit.
 */
function legacyRoleNamespaceHint(selector: string | undefined): string {
  if (selector === undefined || !selector.startsWith("pi/")) return "";
  const role = selector.slice("pi/".length);
  return (
    ` "pi/<role>" was the pre-tier role namespace and a slash now means a real provider: name the role ` +
    `where a role is accepted (\`modelRole: ${JSON.stringify(role)}\`, or an agent's frontmatter ` +
    `\`model: ${role}\`), or write a real provider/id here.`
  );
}
