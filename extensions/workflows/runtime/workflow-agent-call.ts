/**
 * workflow-agent-call.ts — ONE logical `agent()` call.
 *
 * Everything that identifies a call rather than a child lives here, each as ONE piece of
 * state with one owner: the per-run logical ordinal, the `(phase,label)` occurrence map the
 * replay node name counts with, the live-row slot claim held exactly as long as the call,
 * the canonical request key, the replay envelope opened once and closed once, and the
 * transport-retry loop. A second ordinal or a second slot set anywhere else would let one
 * call be recorded twice, or one live row describe two branches.
 *
 * The PHYSICAL half — the invocation charge, the `callId`, the permit, the journal pair —
 * belongs to `workflow-agent-attempt.ts` and is reached only through the injected
 * `runPhysicalAgentAttempt` port, so a retry of one call can never be mistaken for two.
 *
 * Pure host-agnostic execution: no fs / process / network. Part of the DSL core's
 * `node:fs`-free value closure that rule 7 of `scripts/check-extension-layers.ts` proves.
 */

import {
  defaultWorkflowPermissionMode,
  defaultWorkflowWorkspaceMode,
  isTransportRetryableFailure,
  normalizeAgentAttempts,
  normalizeMaxToolCalls,
  normalizeMaxTurns,
  normalizeTimeoutMs,
  workflowAgentDisplayName,
  workflowAgentFailureCause,
  workflowExecutionIdentity,
  workflowSlotKey,
  WorkflowAgentExecutionError,
  WorkflowAgentSlotConflictError,
  WorkflowOutputCapabilityError,
  FUSION_CAPABILITY_MODE,
  FUSION_REPLAY_REQUIRED,
  WORKFLOW_RETURN_CONTRACT,
  WORKFLOW_RETURN_VALIDATE,
  type AgentAttemptOutcome,
  type AgentSchemaCheck,
  type PhysicalAgentAttempt,
  type PhysicalAgentAttemptInput,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowInternalAgentOptions,
} from "./workflow-agent-contract.js";
import { assertWorkflowDisplayTitle, type WorkflowGroupBranchView } from "./workflow-groups.js";
import type { WorkflowBudget } from "./workflow-budget.js";
import type { WorkflowJournalLine } from "./workflow-journal-format.js";
import type { WorkflowReplayController } from "./workflow-replay.js";

/** The narrow ports one logical call needs. Deliberately not a context bag: each entry is
 *  a named capability the composition root already owns. */
export interface WorkflowAgentCallDeps {
  readonly runId: string;
  readonly now: () => string;
  /** The runtime's one journal fan-out (mirror + sink + progress callback). */
  readonly emit: (line: WorkflowJournalLine) => void;
  /** Recorded-call store for `--resume`. Absent means neither record nor replay. */
  readonly replay?: WorkflowReplayController | undefined;
  /** Branch phase when a branch is running, the run phase otherwise. */
  readonly currentPhase: () => string | undefined;
  /** Read-only branch identity; a call reads it and never rewrites a sibling's. */
  readonly branchContext: () => WorkflowGroupBranchView | undefined;
  /** True while a script `validate` callback is running: a nested call there has no
   *  defined position in the journal or the replay sequence. */
  readonly insideValidate: () => boolean;
  /** Whether the embedder configured a workspace manager at all. */
  readonly workspaceManagerConfigured: () => boolean;
  /** Run-declared per-call axes, already normalized by the composition root. */
  readonly defaults: {
    readonly maxToolCalls: number | undefined;
    readonly timeoutMs: number | undefined;
    readonly maxTurns: number | undefined;
  };
  /** One runtime-source journal line per per-call axis raised above the run default. */
  readonly journalPerCallRaises: (
    axes: Partial<Record<keyof WorkflowBudget, { requested: number | undefined; applied: number | undefined }>>,
  ) => void;
  /** The physical executor. One logical call may drive it more than once. */
  readonly runPhysicalAgentAttempt: (input: PhysicalAgentAttemptInput) => Promise<PhysicalAgentAttempt>;
}

export interface WorkflowAgentCall {
  runAgentAttempt(
    prompt: string,
    opts: WorkflowInternalAgentOptions | undefined,
    checkSchema?: (text: string) => AgentSchemaCheck,
  ): Promise<AgentAttemptOutcome>;
}

/**
 * Why this call may NOT repeat a dropped child, or `undefined` when it may.
 *
 * Worktree-bound calls cannot repeat because a later attempt would inherit filesystem state
 * from the earlier attempt. Ordinary project calls may use the explicitly requested retry
 * budget. Workflow agents always have all tools; retries do not create a second tool policy.
 */
function transportRetryRefusal(req: WorkflowAgentRequest, replayable: boolean): string | undefined {
  if (!replayable) {
    return req.workspaceHandle !== undefined
      ? "agent attempts > 1 is refused for a call bound to a workspace handle: a repeated attempt could act on a tree the first attempt already changed"
      : `agent attempts > 1 is refused for a ${String(req.workspaceMode)} workspace call: a repeated attempt could act on a tree the first attempt already changed`;
  }
  return undefined;
}

/** Only terminal, classified failures with no uncertain child shutdown are observations. */
function isReportableAgentFailure(result: WorkflowAgentResult): boolean {
  return (
    (result.status === "failed" || result.status === "blocked") &&
    ["provider-error", "empty-answer"].includes(workflowAgentFailureCause(result))
  );
}

function renderAgentReport(req: WorkflowAgentRequest, value: string | WorkflowAgentResult): string {
  const header = [
    "Workflow agent execution report",
    `Label: ${req.label ?? "unnamed"}`,
    ...(req.title === undefined ? [] : [`Title: ${req.title}`]),
  ];
  if (typeof value === "string") {
    // Re-rendered from raw replay text: no volatile identity or live-only metadata here.
    return [
      ...header,
      "Execution: completed",
      "This records an answer, not verified task completion.",
      "",
      "Agent answer:",
      value,
    ].join("\n");
  }
  return [
    ...header,
    `Execution: ${value.status}`,
    `Cause: ${workflowAgentFailureCause(value)}`,
    `Summary: ${value.summary}`,
    "No accepted agent answer. This call did not complete successfully.",
    ...value.diagnostics.map((diagnostic) => `Diagnostic: ${diagnostic}`),
    ...(value.resultArtifact === undefined ? [] : [`Result artifact: ${value.resultArtifact}`]),
    ...(value.childTrace === undefined ? [] : [`Child trace: ${value.childTrace.path}`]),
  ].join("\n");
}

/**
 * Readable identity of one agent call for the replay record: `(phase, label,
 * occurrence)`, where `occurrence` counts the earlier calls sharing that slot in
 * THIS run. A slot is legitimately re-entered — a later round of a loop, or any
 * sequential second call on the same `(phase, label)` — and the counter is what
 * keeps those rounds of one node apart. Mapped group members keep distinct live
 * rows through a separate runtime-only descriptor; that descriptor deliberately
 * does not enter this base replay identity or its positional occurrence counter.
 *
 * A call without a label gets no name, and the replay controller fails closed on
 * it once the source bytes changed: naming a call is the author's job, and the
 * runtime has no second source of truth to fall back on.
 *
 * Called on the synchronous path that also claims the record's ordinal, so the
 * counter and the position are captured together; deriving the name after an
 * `await` would let another branch of a group take the ordinal in between.
 */
function workflowNodeName(
  input: { phase?: string | undefined; label?: string | undefined },
  occurrences: Map<string, number>,
): string | undefined {
  if (input.label === undefined) return undefined;
  const slot = workflowSlotKey(input);
  const occurrence = occurrences.get(slot) ?? 0;
  occurrences.set(slot, occurrence + 1);
  return JSON.stringify([input.phase ?? null, input.label, occurrence]);
}

/**
 * Canonical identity of one child request for the replay record (T-109).
 *
 * Built from the RESOLVED request rather than the author's `opts`, so a default
 * that later changes value cannot silently reuse a record made under the old
 * default. Every variable execution field is listed explicitly: a field added to
 * `WorkflowAgentRequest` without being added here would widen what counts as
 * "the same call", so the omission has to be a deliberate edit rather than an
 * accident of spreading the object. The invariant `tools: ["*"]` and
 * `permissionMode: "inherit-parent"` need no key fields because workflow source
 * cannot change them; legacy restriction inputs are ignored. A declared `schema`
 * needs no field of its own — it is already baked into `prompt` by
 * `withSchemaContract`.
 */
function canonicalAgentRequest(req: WorkflowAgentRequest): string {
  // `workflowSlot` is live-row identity only. Including its generated group id here would
  // make an unchanged mapped call miss replay whenever surrounding group numbering moved.
  return JSON.stringify({
    prompt: req.prompt,
    ...(req.returnContract === undefined ? {} : { returnContract: req.returnContract }),
    // Display title is not identity. Explicit business keys are: a reordered mapping must not reuse a different item's answer.
    ...(req.itemPath === undefined ? {} : { itemPath: req.itemPath }),
    executionMode: workflowExecutionIdentity(req).executionMode,
    agent: req.agent,
    maxToolCalls: req.maxToolCalls ?? null,
    model: req.model ?? null,
    // The tier a stage DECLARED. Two stages on two tiers are two different calls and
    // must not share one record. Known residual, tested in workflow-replay.test.ts:
    // the key is built here, before the bridge consults the roles table, so it
    // identifies the declared NAME and not the model that produced the answer —
    // remapping `smol` in a roles config, or editing an agent's frontmatter, reuses
    // the record. Recorded runs must be invalidated by hand after such a change.
    modelRole: req.modelRole ?? null,
    // Preserve the canonical bytes of every pre-feature ordinary call. The strict
    // flag changes execution only when true, so adding a null field would invalidate
    // all existing ordinary replay records without distinguishing any behavior.
    ...(req.requireModelRole === true ? { requireModelRole: true } : {}),
    // Same class as `maxToolCalls`: a fuse that shapes execution, so changing it
    // is a different call and must not reuse the earlier record.
    timeoutMs: req.timeoutMs ?? null,
    // Same class again: two turn budgets produce different child behaviour, so a
    // record made under one must not be served to the other.
    maxTurns: req.maxTurns ?? null,
    label: req.label ?? null,
    phase: req.phase ?? null,
    sandbox: req.sandbox ?? null,
    permissionMode: req.permissionMode ?? null,
    workspaceMode: req.workspaceMode ?? null,
    workspaceHandle: req.workspaceHandle ?? null,
    capabilityMode: req.capabilityMode ?? null,
    // A call that may block on a live human answer is a different execution from
    // one that may not: the child's toolset differs (`workflow_ask` injected) and
    // its answer can depend on operator input. A record made under one shape must
    // not be served to the other.
    operatorAsk: req.operatorAsk ?? null,
  });
}

export function createWorkflowAgentCall(deps: WorkflowAgentCallDeps): WorkflowAgentCall {
  const { runId, emit } = deps;
  const nowFn = deps.now;
  const replay = deps.replay;
  const currentPhase = deps.currentPhase;
  const branchContext = deps.branchContext;
  const journalPerCallRaises = deps.journalPerCallRaises;
  const runPhysicalAgentAttempt = deps.runPhysicalAgentAttempt;
  const { maxToolCalls: defaultMaxToolCalls, timeoutMs: defaultTimeoutMs, maxTurns: defaultMaxTurns } = deps.defaults;

  /**
   * Logical `agent()` calls, so every physical attempt of one call can name the call it
   * belongs to.
   *
   * `callId` cannot do that job: it is per-attempt by design (D5 — a discarded attempt is a
   * real agent call with its own transcript). And (agent, label, phase, group) cannot either:
   * `parallel()` may run two calls that agree on all four, and a reader grouping by those
   * fields would attribute one call's discarded attempt to the other.
   */
  let totalLogicalAgentCalls = 0;
  /** Per-run `(phase,label)` -> how many calls that slot has already opened. */
  const agentNodeOccurrences = new Map<string, number>();
  /** Effective live-row slots this run is executing RIGHT NOW. */
  const activeAgentSlots = new Set<string>();

  /**
   * ONE logical `agent()` call: the resolved request, the transport-retry bound, and the
   * replay envelope — opened once and closed once, whatever the physical executor below had
   * to do to get an answer.
   *
   * The replay record is POSITIONAL (`workflow-replay.ts` advances a read cursor per
   * `beginAgentAttempt` and latches divergence on any miss), and a transport retry
   * re-sends the identical prompt. So a discarded attempt recorded at its own ordinal would
   * write two entries with the same key at consecutive positions; on resume the first
   * re-executes, succeeds, and every later call reads an ordinal off by one — a key
   * mismatch, the one-way divergence latch, and the recorded suffix discarded and re-run
   * live. One script-level call, one ordinal, is the invariant the record already assumes.
   *
   * `checkSchema` is supplied only by the shaped path; it runs on the final child text
   * BEFORE agent_end is emitted so the journal records whether the answer was shape-checked.
   */
  async function runAgentAttempt(
    prompt: string,
    opts: WorkflowInternalAgentOptions | undefined,
    checkSchema?: (text: string) => AgentSchemaCheck,
  ): Promise<AgentAttemptOutcome> {
    if (deps.insideValidate()) throw new Error("agent() must not be called from inside a validate callback");
    if (prompt.trim() === "") throw new Error("agent prompt must be non-empty");
    if (opts?.workspaceHandle !== undefined && !deps.workspaceManagerConfigured()) {
      throw new Error("workflow workspace manager is not configured");
    }
    const effectivePhase = opts?.phase ?? currentPhase();
    if (opts?.title !== undefined) assertWorkflowDisplayTitle(opts.title, "agent title");
    const groupScope = branchContext();
    const itemPath = groupScope?.hasBusinessKeys === true ? [...groupScope.memberPath] : undefined;
    const maxToolCalls =
      opts?.maxToolCalls !== undefined
        ? normalizeMaxToolCalls(opts.maxToolCalls, "agent maxToolCalls")
        : defaultMaxToolCalls;
    const timeoutMs = opts?.timeoutMs !== undefined ? normalizeTimeoutMs(opts.timeoutMs) : defaultTimeoutMs;
    // Refused here — before the invocation is spent on a child — so an out-of-clamp
    // value is an authoring error the operator reads immediately, not a host
    // request-validation failure discovered after the run started spending.
    const maxTurns = opts?.maxTurns !== undefined ? normalizeMaxTurns(opts.maxTurns) : defaultMaxTurns;
    // A stage that asks for MORE than the run's applied default gets it — a down-only
    // rule would make a legitimately long stage unauthorable and the operator would
    // answer by raising the package default for everyone. What it does not get is
    // silence: the raise is journalled where the rest of the run's evidence lives.
    journalPerCallRaises({
      toolCalls: { requested: opts?.maxToolCalls, applied: defaultMaxToolCalls },
      timeoutMs: { requested: opts?.timeoutMs, applied: defaultTimeoutMs },
      turns: { requested: opts?.maxTurns, applied: defaultMaxTurns },
    });
    const agentName = opts?.agent?.trim();
    if (opts?.agent !== undefined && agentName === "") {
      throw new Error("agent must be a non-empty project/user catalog name when provided");
    }
    const permissionMode = defaultWorkflowPermissionMode();
    const workspaceMode = opts?.workspaceHandle !== undefined ? "worktree" : defaultWorkflowWorkspaceMode(opts);
    const baseSlotKey =
      opts?.label === undefined ? undefined : workflowSlotKey({ phase: effectivePhase, label: opts.label });
    const groupMember = branchContext()?.member;
    const workflowSlot =
      baseSlotKey === undefined
        ? undefined
        : groupMember === undefined
          ? { key: baseSlotKey }
          : {
              key: `${baseSlotKey}\u001e${groupMember.groupId}\u001f${groupMember.memberIndex}`,
              rowOccurrence: groupMember,
            };
    const req: WorkflowAgentRequest = {
      prompt,
      ...(opts?.title === undefined ? {} : { title: opts.title }),
      ...(itemPath === undefined ? {} : { itemPath }),
      ...(opts?.[WORKFLOW_RETURN_CONTRACT] === undefined ? {} : { returnContract: opts[WORKFLOW_RETURN_CONTRACT] }),
      ...(opts?.[WORKFLOW_RETURN_VALIDATE] === undefined ? {} : { returnValidate: opts[WORKFLOW_RETURN_VALIDATE] }),
      executionMode: agentName === undefined ? "bare" : "named",
      ...(agentName === undefined ? {} : { agent: agentName }),
      tools: ["*"],
      ...(opts?.ask === true ? { operatorAsk: true as const } : {}),
      permissionMode,
      workspaceMode,
      ...(opts?.workspaceHandle !== undefined ? { workspaceHandle: opts.workspaceHandle } : {}),
      ...(opts?.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(effectivePhase !== undefined ? { phase: effectivePhase } : {}),
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.modelRole !== undefined ? { modelRole: opts.modelRole } : {}),
      ...(opts?.requireModelRole === true ? { requireModelRole: true as const } : {}),
      // The declared fuse is the AUTHORITY over this child's wall clock (D4). It is
      // resolved here — default included — so the request the bridge receives always
      // carries the number the SDK turn budget is then derived from, and the two
      // deadlines can never expire at the same instant.
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
      ...(opts?.[FUSION_CAPABILITY_MODE] === undefined ? {} : { capabilityMode: opts[FUSION_CAPABILITY_MODE] }),
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
      ...(workflowSlot === undefined ? {} : { workflowSlot }),
    };
    // T-192 W6 — one slot, one RUNNING call. A `(phase, label)` slot names one live row and
    // one journal correlation key, so two calls occupying it at the same time would collapse
    // two branches into a single row: the second branch's rounds would overwrite the first's
    // and the operator would watch one line describe two agents. Sequential re-entry of the
    // slot — the loop round that `r<N>` counts — is exactly what the slot is FOR and stays
    // allowed, because the claim below lives only as long as the call.
    //
    // Claimed around the LOGICAL call and before anything is spent on it: before the replay
    // ordinal, before the invocation charge, before `agent_start`. A refusal after the
    // journal line would leave behind the colliding live row it exists to prevent, and a
    // claim around each physical attempt instead would make a transport retry of one call
    // look concurrent with itself. Only a labelled call anchors a slot, so an unlabelled one
    // falls outside the guard rather than being exempted from it.
    const activeSlot = workflowSlot === undefined ? undefined : { key: workflowSlot.key, label: req.label! };
    if (activeSlot !== undefined) {
      if (activeAgentSlots.has(activeSlot.key)) {
        throw new WorkflowAgentSlotConflictError(req.phase, activeSlot.label);
      }
      activeAgentSlots.add(activeSlot.key);
    }
    try {
      // Replay eligibility is decided from the RESOLVED request, so defaults and
      // aliases cannot make two different executions share a key. A worktree call
      // is never served from a record: its recorded text would claim a filesystem
      // mutation this run did not perform.
      const replayable = req.workspaceMode === "project" && req.workspaceHandle === undefined;
      // Bounded and gated BEFORE the replay envelope opens and before any child exists, so a
      // refused declaration costs neither an ordinal nor an invocation. Never clamped: a
      // script that declares `attempts: 50` must hear "no", not silently receive 3.
      const attempts = normalizeAgentAttempts(opts?.attempts);
      if (attempts > 1) {
        const refusal = transportRetryRefusal(req, replayable);
        if (refusal !== undefined) throw new Error(refusal);
      }
      const canonicalRequest = canonicalAgentRequest(req);
      // Allocated once per logical call, and only where one ordinal is opened: it is the name
      // the physical attempts below share, and the only field a report can group them by.
      totalLogicalAgentCalls += 1;
      const logicalCallId = `logical-${String(totalLogicalAgentCalls).padStart(4, "0")}`;
      // Claimed on the same synchronous stretch that opens the record's ordinal
      // below, so the occurrence counter and the position always describe the same
      // call. One object serves the lookup and all three record sites, so the name
      // written can never drift from the name compared.
      const node = workflowNodeName(req, agentNodeOccurrences);
      const replayCall = {
        ...(node === undefined ? {} : { node }),
        canonicalRequest,
        // Carried so a miss against a record written under return-contract v1 is named as
        // the contract boundary rather than reported as a changed script.
        ...(req.returnContract === undefined ? {} : { returnContractVersion: req.returnContract.version }),
      };
      const lookup = replay?.beginAgentAttempt({ ...replayCall, replayable });
      // The replay boundary an operator has to be told about by name. A shaped call
      // recorded under return-contract v1 cannot match a v2 request key, and saying
      // "key-mismatch" here would send them looking for a script edit that never happened.
      if (lookup?.replayed === false && lookup.reason === "return-contract-changed") {
        emit({
          ts: nowFn(),
          runId,
          kind: "log",
          source: "runtime",
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
          message:
            `[workflow:replay] ${req.label ?? workflowAgentDisplayName(req)}: the shaped return contract changed in this ` +
            "release (v1 -> v2: no default answer ceiling, no derived JSON allowance, no bounded clarification budget). " +
            "The recorded answer stays readable, but it answered a different contract, so replay stops here and this call runs fresh.",
        });
      }
      if (opts?.[FUSION_REPLAY_REQUIRED] === true && lookup?.replayed !== true) {
        replay?.recordAgentAttempt(replayCall, { ok: false });
        throw new Error(
          `fusion resume cannot mix recorded and fresh agent calls; replay missed with ${lookup?.reason ?? "no replay controller"}`,
        );
      }
      const replayedText = lookup?.replayed === true ? lookup.text : undefined;

      let lastFailure: Extract<PhysicalAgentAttempt, { ok: false }> | undefined;
      for (let attempt = 1; ; attempt++) {
        let physical: PhysicalAgentAttempt;
        try {
          physical = await runPhysicalAgentAttempt({
            req,
            permissionMode,
            workspaceMode,
            opts,
            attempt,
            attempts,
            logicalCallId,
            ...(checkSchema !== undefined ? { checkSchema } : {}),
            ...(replayedText !== undefined ? { replayedText } : {}),
          });
        } catch (err) {
          // A THROWN failure carries no classified cause, so it is never retried. Record it so
          // the recorded sequence keeps the same ordinals as the live one: a later resume then
          // replays the prefix and re-runs the call that failed, which is the point of resuming.
          replay?.recordAgentAttempt(replayCall, { ok: false });
          throw err;
        }
        if (physical.ok) {
          // This run writes its OWN complete record, replayed entries included, so a
          // resume of a resume still has an unbroken prefix to work from.
          replay?.recordAgentAttempt(replayCall, { ok: true, text: physical.text });
          return opts?.result === "report"
            ? { ...physical.outcome, text: renderAgentReport(req, physical.text) }
            : physical.outcome;
        }
        lastFailure = physical;
        if (attempt >= attempts || !isTransportRetryableFailure(physical.result)) break;
        // `log` carries no agent identity of its own (`workflow-journal.ts` rejects one), so the
        // agent is named in the message; the attempt's own agent_end already holds the rest.
        emit({
          ts: nowFn(),
          runId,
          kind: "log",
          source: "runtime",
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
          message: `[workflow:retry] ${workflowAgentDisplayName(req)}${req.label === undefined ? "" : ` (${req.label})`}: transport attempt ${attempt} of ${attempts} failed with ${workflowAgentFailureCause(physical.result)}; re-running the identical request`,
        });
      }
      replay?.recordAgentAttempt(replayCall, { ok: false });
      const failed = lastFailure!;
      if (opts?.result === "report" && !failed.replayed && isReportableAgentFailure(failed.result)) {
        emit({
          ts: nowFn(),
          runId,
          kind: "log",
          source: "runtime",
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
          message: `[workflow:report] ${req.label ?? workflowAgentDisplayName(req)}: captured ${workflowAgentFailureCause(failed.result)}; child remains ${failed.result.status}`,
        });
        return { text: renderAgentReport(req, failed.result), callId: failed.callId, replayed: false };
      }
      throw workflowAgentFailureCause(failed.result) === "output-contract-unavailable"
        ? new WorkflowOutputCapabilityError(failed.result)
        : new WorkflowAgentExecutionError(failed.result);
    } finally {
      // Released on every exit — answer, transport exhaustion, thrown host failure, abort and
      // run deadline alike. A claim that outlived its call would refuse the next round of the
      // loop that owns the slot, which is the opposite of what this guard protects.
      if (activeSlot !== undefined) activeAgentSlots.delete(activeSlot.key);
    }
  }

  return { runAgentAttempt };
}
