---
title: Agent catalog and model selection
type: guide
status: active
updated: "2026-09-13T00:12:23Z"
description: "Organize the installed workflow contract by reader task."
---

# Agent catalog and model selection

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## Agent catalog

Workflow stage prompts own their role. A catalog profile is optional:

```js
await agent("Inspect the repository and report evidence.");
await agent("Apply the bounded edit.", { agent: "my-project-worker" });
```

`opts.agent` is a project/user catalog name, not a model name or an inline role
definition. Bare `agent(prompt)` starts a clean child and performs no catalog
lookup. Explicit names resolve first-wins from the nearest project
`.agents/agents/`, then `~/.agents/agents/`. Unknown names return an explicit
`ok:false` result; they never fall back to another profile.
For workflow calls, each definition's frontmatter supplies the system prompt and
optional `model` preference; catalog capability metadata does not narrow the
inherited workflow-child surface. The package ships no agent profiles.

### Model selection: execution versus metadata

One precedence chain decides which model a child runs on, and it is the same
chain for a workflow stage and for `/agent run` / `spawn_agent`:

```
opts.model  →  opts.modelRole  →  the agent's frontmatter tier  →  ctx.model
```

Every term but the last is resolved through the host's model registry
(`ctx.modelRegistry.find`) BEFORE the child is created, and the resolved model is
what `createSession` receives. Two outcomes, and the difference between them is
the point:

- A **concrete** `provider/id` selector that does not resolve — a typo, a provider
  that is not configured, a model this host does not have — ends the call with a
  named failed result and zero child sessions. It never silently inherits.
- A **role** that the global model-roles config does not assign degrades to `ctx.model` and records
  `modelRoleFallback` on `agent_end`, in the `locus.agent.run-result.v2` body and
  in the run report. The package deliberately ships no role assignments, so this
  is what a user sees until they assign that named profile's role;
  an unassigned role must not fail closed merely because no tier is configured.
- A call with `requireModelRole: true` is the opt-in exception. It must also
  declare `modelRole`, may not declare `model`, and that role must have an
  assignment. Otherwise the call fails before a fresh child starts and names
  `/model-roles` as the repair surface. Replay remains the recorded-answer path
  described below and does not create a child to resolve.
- A role whose assignment EXISTS but does not parse as `provider/id[:level]` is a
  configuration error and fails the call by name, quoting the value as written and
  the global config holding it. It is deliberately not treated as unassigned: degrading a
  typo would run the session model under the requested tier's name and report the
  role as unassigned, which the operator's own config contradicts.

A frontmatter tier resolves its named role directly from the global user config
at `~/.pi/agent/model-roles/config.json`. A model-less child checks only the
`agent` role, then inherits the current session model when that role is unset.
A child that inherits the model also receives the parent session's current
reasoning effort; the host's unrelated default cannot silently replace it.
A per-call `modelRole` also resolves only the role it names.
`modelRoleResolution` continues to be recorded in the request capsule,
artifacts, and live display.

**The pre-tier `pi/<role>` namespace.** Before tiers were executed the shipped
agents wrote their tier as `pi/<role>`; `pi` was never a provider and nothing
read the value. An agent's **frontmatter** tier in that namespace is read as the
role it always named, so a catalog copied from an older release resolves through
the roles table instead of refusing every call as an unresolvable provider. The
degradation note for an unassigned one carries an extra sentence naming the
spelling to fix. This compatibility rule is bounded on both sides: `pi/<token>` where the token names no
role is an ordinary concrete selector and still fails by name, and a per-call
`model` / `modelRole` — code written today against the current grammar — still
refuses with the migration hint rather than being rewritten.

**Running a workflow on your own local model.** Bare children inherit the parent
session's model — whatever `/model` currently points at, local provider included.
A named project/user profile may instead declare a role or concrete model. To
make a role explicit, assign it to your own `provider/id` with `/model-roles`;
the resolved model is what `createSession` receives.

**Selector grammar.** A token containing `/` is a concrete `provider/id`; a
slash-free token is a role name looked up in the roles table. A trailing
`:off|minimal|low|medium|high|xhigh` is stripped before the registry lookup,
then passed to the child session as `thinkingLevel`. An explicit selector or role
effort outranks inherited parent effort. A concrete model or effort the installed Pi host cannot honor fails the
child creation boundary rather than silently changing either value.

**What executed, versus what was asked for.** `agent_start` is emitted before the
bridge resolves anything, so it carries `requestedModel` / `modelRole` — intent,
named as intent. `agent_end` carries `executedModel`, read back from the child
session after `createSession`. When the peer exposes no model the field records
`unavailable`; it is never back-filled from the request. A readback that
contradicts the resolved request fails the call with both values quoted, because
a host that ignored the selection is exactly the failure this evidence exists to
catch. Terminal `thinking` evidence likewise comes from the child session's
effective `thinkingLevel` after dispatch. When that readback is unavailable the
terminal field is absent; requested or parent effort is not substituted.

**Nothing is named as executed before the child is dispatched.** `executedModel`
— and with it the recorded tier degradation — appears only once the child's first
prompt has been accepted by the transport. A call that was refused at the tier, a
session built and then cancelled before kickoff, a readback mismatch, or a
`prompt()` the transport rejected (no credentials, no route) executed nothing and
reports nothing. **The live row follows the same rule**: on every one of those
paths it drops the requested selector instead of ending as a terminal row wearing
a model that never ran, which an operator cannot tell apart from one that ran and
failed. Absence is the honest answer there; the failure reason carries the
details.

**And nothing that did run is forgotten.** The same rule read the other way: a
call that fails _after_ the child answered — a script `validate` that threw, an
artifact writer that could not write — really did execute, so its `error` line
carries `executedModel` and the row keeps that label rather than being blanked as
if no child existed. A **replayed** completion is the opposite case and is treated
as such: a resumed run serves a recorded answer without creating a child, so its
`agent_end` has no readback and its row shows no model even though the status is
`completed`. Read `executedModel` as the single proof of execution on any terminal
line — its absence always means "no child ran", never "the record was lost".

**Replay identity, and one residual to know about.** `modelRole` and
`requireModelRole` are part of the canonical request, so two stages on two tiers
or with different fallback policy occupy different records. The key is built in
the runtime before the bridge consults the roles table, so it identifies the tier
a stage **declared**, not the model that produced the answer: remapping a role in
`~/.pi/agent/model-roles/config.json`, or editing an agent's frontmatter, reuses the
existing record. **A roles-table change invalidates recorded runs by hand.**

`meta.description` has no effect on any of these choices. `/workflows info`
reports the rules but never resolves them into a claimed future execution graph.
