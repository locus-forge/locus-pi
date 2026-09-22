/**
 * workflow-model-resolve.ts — one owner for "which concrete model does this
 * selector name", for every workflow child call.
 *
 * Two rules, and they are the whole grammar:
 *
 *  - A selector containing `/` is a concrete `provider/id` and is looked up in the
 *    host's model registry (`ctx.modelRegistry.find`). A slash-free token is a
 *    ROLE name and is never seen by this module — the bridge resolves roles
 *    against the roles table first and hands this module the assignment it found.
 *  - An optional trailing `:<thinking level>` (`off|minimal|low|medium|high|xhigh`)
 *    is stripped before the registry lookup and preserved for the workflow
 *    bridge, which passes it to the child session as `thinkingLevel`.
 *
 * The grammar owner is `model-settings.parseModelSelector` — this module delegates
 * to it rather than keeping a second, subtly different parser. The two used to
 * disagree (this module stripped only the literal string `":thinking"`, the roles
 * table accepted real levels), which was invisible only because resolution was
 * broken end to end.
 *
 * Fail-closed by contract: every outcome is either a resolved model or a NAMED
 * refusal. There is no `undefined` return that a caller can quietly read as
 * "use the parent's model" — that silent fall-through is the defect this module
 * was rewritten to remove.
 */

import type { ExtensionContext, ModelLike, ThinkingLevel } from "../host/pi-api.js";
import { parseModelSelector as parseModelRoleAssignment } from "./model-settings.js";

/** Levels accepted as a child reasoning-effort suffix, quoted verbatim in refusal text. */
const THINKING_LEVEL_LIST = "off|minimal|low|medium|high|xhigh";

export interface ParsedModelSelector {
  provider: string;
  id: string;
  /** Requested child reasoning effort. */
  thinking?: ThinkingLevel;
}

/** Why a selector produced no model. Every value is operator-facing. */
export type WorkflowModelRefusalReason = "unparseable-selector" | "no-model-registry" | "unknown-model";

export type WorkflowModelResolution =
  | {
      ok: true;
      selector: string;
      provider: string;
      id: string;
      /** The registry's own model object — this is what reaches `createSession`. */
      model: ModelLike;
      thinking?: ThinkingLevel;
    }
  | { ok: false; selector: string; reason: WorkflowModelRefusalReason; message: string };

export type WorkflowModelResolver = (selector: string) => WorkflowModelResolution | Promise<WorkflowModelResolution>;

/** The registry slice this module needs; `ctx` satisfies it. */
export type WorkflowModelRegistrySource = Pick<ExtensionContext, "modelRegistry">;

/**
 * Split a concrete `provider/id[:level]` selector.
 *
 * Returns `undefined` for anything that is not one — including a bare role name,
 * which is the roles table's business, not this module's.
 */
export function parseModelSelector(selector: string): ParsedModelSelector | undefined {
  const assignment = parseModelRoleAssignment(selector);
  if (assignment === undefined) return undefined;
  const slash = assignment.model.indexOf("/");
  if (slash <= 0 || slash === assignment.model.length - 1) return undefined;
  const provider = assignment.model.slice(0, slash).trim();
  const id = assignment.model.slice(slash + 1).trim();
  if (provider === "" || id === "") return undefined;
  return {
    provider,
    id,
    ...(assignment.thinking !== undefined ? { thinking: assignment.thinking } : {}),
  };
}

/**
 * Resolve one concrete selector through the host's registry.
 *
 * The registry is the right door because it holds the providers the OPERATOR
 * configured and authenticated, rather than a static catalog compiled into the
 * package. A model absent from it is a model this host cannot run.
 */
export async function resolveWorkflowModel(
  selector: string,
  source: WorkflowModelRegistrySource | undefined,
): Promise<WorkflowModelResolution> {
  const parsed = parseModelSelector(selector);
  if (parsed === undefined) {
    return {
      ok: false,
      selector,
      reason: "unparseable-selector",
      message:
        `model selector ${JSON.stringify(selector)} is not a "provider/id" selector ` +
        `(an optional ":${THINKING_LEVEL_LIST}" child reasoning-effort suffix is allowed).`,
    };
  }
  const registry = source?.modelRegistry;
  if (registry === undefined || typeof registry.find !== "function") {
    return {
      ok: false,
      selector,
      reason: "no-model-registry",
      message:
        `model selector ${JSON.stringify(selector)} could not be resolved: this host exposes no ` +
        "model registry (ctx.modelRegistry.find), so no selector can be checked against real models.",
    };
  }
  let found: ModelLike | undefined;
  try {
    found = await registry.find(parsed.provider, parsed.id);
  } catch (error) {
    return {
      ok: false,
      selector,
      reason: "unknown-model",
      message:
        `model selector ${JSON.stringify(selector)} could not be resolved: the model registry threw ` +
        `while looking up provider ${JSON.stringify(parsed.provider)} id ${JSON.stringify(parsed.id)} — ` +
        errorMessage(error),
    };
  }
  if (found === undefined || found === null) {
    return {
      ok: false,
      selector,
      reason: "unknown-model",
      message:
        `model selector ${JSON.stringify(selector)} did not resolve: provider ` +
        `${JSON.stringify(parsed.provider)} has no model ${JSON.stringify(parsed.id)} in this host's registry.`,
    };
  }
  return {
    ok: true,
    selector,
    provider: parsed.provider,
    id: parsed.id,
    model: found,
    ...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
  };
}

/** Bind a resolver to one extension context; the bridge holds `ctx` already. */
export function createWorkflowModelResolver(source: WorkflowModelRegistrySource | undefined): WorkflowModelResolver {
  return (selector: string) => resolveWorkflowModel(selector, source);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
