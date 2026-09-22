/**
 * session-tool-transport.ts — one answer to "can this model's transport host
 * session tools?", asked before anything is spent on a call that needs them.
 *
 * A shaped result (`agent({ schema })`, `fusion({ schema })`) is carried by
 * registering a return tool ON THE CHILD SESSION and reading the host's active
 * tool set back. A transport that never hosts Pi tools cannot do either, so a
 * shaped call on it is not a bad answer waiting to happen — it is a capability
 * the route does not have, and the honest moment to say so is before the child
 * starts, not after it has been paid for.
 *
 * WHY AN API ID AND NOT A FLAG. pi-ai's `Model` record (`@earendil-works/pi-ai`,
 * `types.d.ts`) declares id/name/api/provider/baseUrl/reasoning/input/cost/
 * contextWindow/maxTokens and nothing about tool hosting, so there is no flag to
 * read today. The api id is the closest thing the record has to a transport
 * name — one api id is one wire protocol, while a provider id is only a vendor
 * label and several providers can share a capable api — so the ledger below is
 * keyed on api ids. `SESSION_TOOL_HOSTING_FIELD` is still honoured first, so a
 * record that ever grows an explicit declaration overrides the ledger without
 * another edit here.
 *
 * Fail OPEN on an unknown transport. A route absent from the ledger is assumed
 * capable and the host's own pre-prompt refusal (`agent-sdk-host.ts`: no
 * `setActiveToolsByName`, no tool readback) remains the second line of defence.
 * The ledger exists to move a KNOWN refusal earlier, never to invent one.
 */

/**
 * The optional model-record field that overrides the ledger. Read as a tri-state:
 * `false` means the transport says it cannot host session tools, `true` means it
 * says it can, anything else means it did not say.
 */
export const SESSION_TOOL_HOSTING_FIELD = "hostsSessionTools";

/**
 * Api ids whose transport provably never forwards Pi's tool set to the child.
 *
 * `claude-code-cli` is the Claude Code CLI adapter
 * (`locus-pi-claude-code-adapter`, `CLAUDE_CODE_API_ID`). It shells out to the
 * `claude` binary, which runs with its own tools; the adapter states this in
 * every run receipt as `piToolAllowlistForwarded: false`.
 */
const TRANSPORTS_WITHOUT_SESSION_TOOLS: ReadonlySet<string> = new Set(["claude-code-cli"]);

/** The api id a resolved model record names, when it names one at all. */
function transportApiId(model: unknown): string | undefined {
  if (typeof model !== "object" || model === null) return undefined;
  const api = (model as { api?: unknown }).api;
  return typeof api === "string" && api !== "" ? api : undefined;
}

/**
 * True unless this model's transport is known not to host session tools.
 *
 * `undefined` and unrecognised records answer true: absence of evidence is not
 * evidence of incapability, and refusing on it would break every route this
 * module has never heard of.
 */
export function transportHostsSessionTools(model: unknown): boolean {
  if (typeof model === "object" && model !== null) {
    const declared = (model as Record<string, unknown>)[SESSION_TOOL_HOSTING_FIELD];
    if (typeof declared === "boolean") return declared;
  }
  const api = transportApiId(model);
  return api === undefined || !TRANSPORTS_WITHOUT_SESSION_TOOLS.has(api);
}
