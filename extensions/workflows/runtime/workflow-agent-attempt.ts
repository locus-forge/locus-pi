/**
 * workflow-agent-attempt.ts — ONE physical child execution inside a logical call.
 *
 * What a CHILD costs and leaves behind is owned here: the invocation charge, the `callId`
 * that names its transcript and result directories, the leaf-agent permit taken and
 * released around the runner, the deadline checks before and inside that permit, the
 * `agent_queued`/`agent_start`/`agent_end` trio, evidence adoption, and the three
 * terminal-by-throw records that stand in for an `agent_end` that never happens.
 *
 * No replay cursor and no ordinal. Which attempt this is, and whether another follows, is
 * the logical call's decision (`workflow-agent-call.ts`); this module is handed the position
 * it occupies and reports back a result rather than a retry.
 *
 * Pure host-agnostic execution: no fs / process / network. Part of the DSL core's
 * `node:fs`-free value closure that rule 7 of `scripts/check-extension-layers.ts` proves.
 */

import {
  defaultArtifactName,
  liveModelFromSelector,
  thrownAgentFailureCause,
  workflowAgentDisplayName,
  workflowAgentFailureCause,
  workflowExecutionIdentity,
  FUSION_INVOCATION_RESERVATION,
  WORKFLOW_SHAPED_TRANSPORT_REFUSAL,
  type AgentSchemaCheck,
  type PhysicalAgentAttempt,
  type PhysicalAgentAttemptInput,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowAgentRunner,
} from "./workflow-agent-contract.js";
import { formatWorkflowBudgetStop, type WorkflowBudget } from "./workflow-budget.js";
import type { WorkflowSharedExecutionState } from "./workflow-execution-state.js";
import type { WorkflowAgentFailureCause, WorkflowJournalLine } from "./workflow-journal-format.js";
import type { WorkflowArtifactPorts } from "./workflow-artifacts.js";

/** The narrow ports one physical attempt needs. Named capabilities, not a context bag. */
export interface WorkflowAgentAttemptDeps {
  readonly runId: string;
  readonly now: () => string;
  /** The runtime's one journal fan-out (mirror + sink + progress callback). */
  readonly emit: (line: WorkflowJournalLine) => void;
  /** The injected agent-execution callback. This module never imports the SDK. */
  readonly agentRunner: WorkflowAgentRunner;
  /** The run's ONE counter, leaf-agent gate and deadline. */
  readonly sharedExecution: WorkflowSharedExecutionState;
  /** Branch phase when a branch is running, the run phase otherwise. */
  readonly currentPhase: () => string | undefined;
  /** Group correlation fields for any journal line emitted inside a group. */
  readonly activeGroupFields: () => Pick<WorkflowJournalLine, "groupId" | "groupKind" | "groupLabel">;
  /** Runs one budget check and journals the axis that stopped the run before it throws. */
  readonly journalBudgetStop: <T>(check: () => T, phase: string | undefined) => T;
  readonly artifactPorts?: WorkflowArtifactPorts | undefined;
  readonly replaySourceRunId?: string | undefined;
}

/**
 * The execution evidence a post-child failure still owns.
 *
 * The two `error` lines that carry this are emitted after a result exists — either from
 * a fresh child or replay. Fresh results may hold real host readback; replayed results do
 * not. Project only facts the result actually carries, while the emitter persists the
 * separate request-owned capability declaration and replay origin.
 *
 * `modelRoleFallback` rides along because the bridge already gates it on the same
 * readback (`workflow-agent-bridge.ts`), so it is never a claim this line invents.
 */
function executedModelEvidence(
  result: Pick<WorkflowAgentResult, "model" | "executedModel" | "modelRoleFallback" | "thinking" | "activeToolNames">,
): Pick<WorkflowJournalLine, "model" | "executedModel" | "modelRoleFallback" | "thinking" | "activeToolNames"> {
  return {
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.executedModel !== undefined ? { executedModel: result.executedModel } : {}),
    ...(result.modelRoleFallback !== undefined ? { modelRoleFallback: result.modelRoleFallback } : {}),
    ...(result.thinking !== undefined ? { thinking: result.thinking } : {}),
    ...(result.activeToolNames !== undefined ? { activeToolNames: result.activeToolNames } : {}),
  };
}

/**
 * The per-call failure causes that mean "an explicit budget stopped this", mapped
 * to the axis an operator would recognise.
 *
 * Deliberately a closed table rather than a prefix match on the cause name: every
 * other cause here is a real failure — the provider broke, the host could not spawn,
 * the answer did not satisfy its contract — and calling one of those a budget stop
 * would hide it behind a reassuring word.
 */
const PER_CALL_BUDGET_STOPS: Readonly<Partial<Record<WorkflowAgentFailureCause, keyof WorkflowBudget>>> = Object.freeze(
  {
    "call-timeout": "timeoutMs",
    "host-turn-timeout": "timeoutMs",
    "tool-call-budget": "toolCalls",
    "assistant-turn-budget": "turns",
  },
);

export function createWorkflowAgentAttempt(
  deps: WorkflowAgentAttemptDeps,
): (input: PhysicalAgentAttemptInput) => Promise<PhysicalAgentAttempt> {
  const { runId, emit, agentRunner, sharedExecution } = deps;
  const nowFn = deps.now;
  const currentPhase = deps.currentPhase;
  const activeGroupFields = deps.activeGroupFields;
  const journalBudgetStop = deps.journalBudgetStop;
  const artifactPorts = deps.artifactPorts;
  const replaySourceRunId = deps.replaySourceRunId;

  /**
   * ONE physical child execution inside a logical call: its own invocation-cap charge, its
   * own `callId` and therefore its own transcript and result directories, its own
   * `agent_start`/`agent_end` pair, and the fail-closed status mapping.
   *
   * A discarded transport attempt is a real agent call and pays for all of it. A cap that
   * ignores retries is the same defect class as a cost counter hardcoded to zero: a gate
   * that does not count what it gates. The discarded attempt's transcript is also the only
   * evidence an operator has that the stage was paid for twice.
   */
  async function runPhysicalAgentAttempt(input: PhysicalAgentAttemptInput): Promise<PhysicalAgentAttempt> {
    const { permissionMode, workspaceMode, opts, checkSchema, replayedText, attempt, attempts } = input;
    // Emitted only when a retry budget was actually declared, so every journal written
    // before `attempts` existed stays byte-identical and absence still means "one attempt".
    // The three travel together: an ordinal with no logical call to belong to cannot be
    // grouped, and a reader falling back to (agent, label, phase, group) would mis-attribute
    // two `parallel()` calls that agree on all four.
    const attemptFields = attempts > 1 ? { attempt, attempts, logicalCallId: input.logicalCallId } : {};
    // Global per-run cap across all agent() calls (including those nested in
    // parallel()/pipeline()). Count BEFORE doing any work so the attempt that breaches
    // the cap is itself counted, and throw a typed error that bubbles past grouped
    // contexts to exit the run. Cyclic workflows are allowed up to the cap.
    const reservation = opts?.[FUSION_INVOCATION_RESERVATION];
    if (reservation !== undefined) {
      sharedExecution.consumeReservation(reservation);
    }
    // A replayed attempt calls no model. Charging it against `totalAgents` would let a
    // `--resume` of a completed run die on a cap the original run satisfied, which is
    // why the two are counted apart and only the fresh one is charged. Both still take
    // a sequence number, because that number is the attempt's identity.
    const physicalInvocation = journalBudgetStop(
      () => sharedExecution.spendInvocation(replayedText === undefined ? "fresh" : "replayed"),
      currentPhase(),
    );
    // Refuse an already-expired attempt before it occupies a concurrency slot or
    // inflates the gate-owned peak. Fresh work checks again after any queue wait,
    // immediately before execution; a replay has no gate and this is its only check.
    journalBudgetStop(() => {
      sharedExecution.assertDeadline();
    }, currentPhase());
    const callId = `call-${String(physicalInvocation).padStart(4, "0")}`;
    // `callId` is deliberately absent from `canonicalAgentRequest`, so giving each physical
    // attempt its own identity leaves the logical call's replay key untouched.
    const req: WorkflowAgentRequest = { ...input.req, callId };
    const replayed = replayedText !== undefined;
    const requestedLiveModel = liveModelFromSelector(req.model);
    const emitAdmission = (kind: "agent_queued" | "agent_start"): void =>
      emit({
        ts: nowFn(),
        runId,
        kind,
        ...workflowExecutionIdentity(req),
        ...(replayed ? { replayed: true } : {}),
        ...(req.capabilityMode !== undefined ? { capabilityMode: req.capabilityMode } : {}),
        permissionMode,
        workspaceMode,
        ...(req.workspaceHandle !== undefined ? { workspaceHandle: req.workspaceHandle } : {}),
        ...activeGroupFields(),
        // Both facts, neither fabricated: `model` keeps its documented live-row display
        // meaning for existing readers, `requestedModel` says out loud that at this point
        // in the run the value is a request and nothing has executed yet.
        ...(requestedLiveModel?.model !== undefined ? { model: requestedLiveModel.model } : {}),
        ...(requestedLiveModel?.model !== undefined ? { requestedModel: requestedLiveModel.model } : {}),
        ...(req.modelRole !== undefined ? { modelRole: req.modelRole } : {}),
        ...(req.requireModelRole === true ? { requireModelRole: true } : {}),
        ...(requestedLiveModel?.thinking !== undefined ? { thinking: requestedLiveModel.thinking } : {}),
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(req.title !== undefined ? { title: req.title } : {}),
        ...(req.itemPath !== undefined ? { itemPath: req.itemPath } : {}),
        callId,
        ...attemptFields,
        ...(req.phase !== undefined ? { phase: req.phase } : {}),
        // Slot descriptor for round correlation (REQ-009); only labelled agents anchor a slot.
        ...(req.workflowSlot !== undefined ? { slotKey: req.workflowSlot.key } : {}),
      });
    emitAdmission(replayed ? "agent_start" : "agent_queued");
    let executionStartedAtMs = Date.now();
    let finalResult: WorkflowAgentResult;
    if (replayedText !== undefined) {
      // No child runs. The recorded answer is projected into the same result
      // shape a fresh child would produce, minus `usage` — a replayed call cost
      // nothing, and claiming otherwise would inflate the run budget.
      finalResult = {
        ok: true,
        status: "completed",
        summary: "Replayed from a recorded run.",
        text: replayedText,
        diagnostics: [],
        ...workflowExecutionIdentity(req),
        permissionMode,
        workspaceMode,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(req.title !== undefined ? { title: req.title } : {}),
        ...(req.itemPath !== undefined ? { itemPath: req.itemPath } : {}),
      };
    } else {
      try {
        // The leaf-agent permit, taken directly: this is ONE child, so there was never a
        // group of thunks to schedule. The width the deleted single-thunk scheduler call
        // declared was a formality — `sharedExecution` is the gate that actually bounds
        // simultaneous leaf agents, and it is acquired and released right here.
        await sharedExecution.acquireAgent();
        try {
          executionStartedAtMs = Date.now();
          // The run deadline can pass WHILE this call waits for a concurrency slot,
          // so this second check is the one that most often fires — and it fired
          // silently, ending the run with a bare error and no line saying which axis
          // stopped it or that the answers already received were kept.
          journalBudgetStop(() => {
            sharedExecution.assertDeadline();
          }, currentPhase());
          emitAdmission("agent_start");
          finalResult = await agentRunner(req);
        } finally {
          // Released on every exit — answer, refusal, throw, cancellation and the deadline
          // that fired while this call was queued alike.
          sharedExecution.releaseAgent();
        }
      } catch (err) {
        const durationMs = Date.now() - executionStartedAtMs;
        // A thrown transport failure never reaches an `agent_end`, so this IS the terminal
        // journal record of the call. Carrying the declared cause here is what makes
        // `sdk-unavailable` readable end to end without matching on the message.
        //
        // The attempt trio travels with it for the same reason: a call that timed out, was
        // re-run and then THREW leaves exactly one agent_end behind, so a reader that only
        // consumed agent_end would render a stage that ran twice as if it never retried.
        const thrownCause = thrownAgentFailureCause(err);
        emit({
          ts: nowFn(),
          runId,
          kind: "error",
          ...workflowExecutionIdentity(req),
          callId,
          replayed: false,
          ...(req.capabilityMode !== undefined ? { capabilityMode: req.capabilityMode } : {}),
          ...attemptFields,
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.itemPath !== undefined ? { itemPath: req.itemPath } : {}),
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
          ...(thrownCause !== undefined ? { failureCause: thrownCause } : {}),
          message: err instanceof Error ? err.message : String(err),
          durationMs,
        });
        throw err;
      }
    }
    // CAPABILITY, not content. A transport that cannot register `workflow_return` and read
    // back the child's active tools cannot carry a shaped result at all — and since the text
    // transport is deleted, there is nothing to quietly fall back to. Naming it here keeps
    // the refusal a capability statement instead of "the agent answered wrongly".
    if (
      !replayed &&
      req.returnContract !== undefined &&
      finalResult.ok &&
      finalResult.status === "completed" &&
      finalResult.outputAcceptance?.source !== "tool"
    ) {
      finalResult = {
        ...finalResult,
        ok: false,
        status: "failed",
        failureCause: "output-contract-unavailable",
        summary: WORKFLOW_SHAPED_TRANSPORT_REFUSAL,
      };
    }
    if (opts?.sandbox !== undefined) {
      finalResult.diagnostics = finalResult.diagnostics ?? [];
      finalResult.diagnostics.push(
        "`sandbox` is deprecated; it remains a compatible alias — file isolation only, not a security boundary",
      );
    }
    if (
      finalResult.ok &&
      finalResult.status === "completed" &&
      (finalResult.text === undefined || finalResult.text.trim() === "")
    ) {
      finalResult = {
        ...finalResult,
        ok: false,
        status: "failed",
        // An empty answer is the clearest signal a stage is under-decomposed. Naming the
        // cause keeps it OUT of the transport class rather than leaving it unclassified.
        failureCause: "empty-answer",
        summary: "Agent result text is empty.",
        diagnostics: [...finalResult.diagnostics, "Agent result text is empty."],
      };
    }
    // NO answer-size gate. A complete answer the child already paid for is never refused
    // for its length: the runtime owns no output budget, and the consumer's own contract
    // (schema, output.maxLength, membership) is checked below where a violation is
    // correctable in-session instead of fatal after the fact.
    // Shape check runs before agent_end so the run journal carries the verdict for THIS attempt.
    // A child that failed or returned no text has nothing to validate; that stays a run failure.
    let schemaCheck: AgentSchemaCheck | undefined;
    if (checkSchema !== undefined && finalResult.ok && finalResult.status === "completed") {
      try {
        schemaCheck = checkSchema(finalResult.text ?? "");
      } catch (err) {
        // A script validator that throws — or hands back something that is not an error
        // list — ends the run unchanged and spends no retry. Without this terminal line
        // the journal holds an agent_start with no record of why the run stopped. The
        // explicit replay flag says whether its answer came from a child or a record;
        // host readback is projected only when a fresh result actually carries it.
        emit({
          ts: nowFn(),
          runId,
          kind: "error",
          source: "script",
          ...workflowExecutionIdentity(req),
          callId,
          ...attemptFields,
          replayed,
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.itemPath !== undefined ? { itemPath: req.itemPath } : {}),
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
          ...(req.capabilityMode !== undefined ? { capabilityMode: req.capabilityMode } : {}),
          ...executedModelEvidence(finalResult),
          message: err instanceof Error ? err.message : String(err),
          ...(finalResult.usage !== undefined ? { usage: finalResult.usage } : {}),
          durationMs: Date.now() - executionStartedAtMs,
        });
        throw err;
      }
    }
    // A replayed answer the CURRENT validator rejects fails the run closed, exactly as an
    // over-long replayed answer does above. Re-asking would form an attempt-2 prompt whose
    // key misses at that ordinal, trip the one-way divergence latch and silently turn the
    // operator's resume into a full live run. A SCHEMA mismatch on a replayed answer keeps
    // re-asking as before — that path predates this rule and is unchanged.
    if (replayed && schemaCheck?.validation.status === "mismatch" && schemaCheck.validation.source === "script") {
      const message = `Replayed agent answer was rejected by the workflow script: ${schemaCheck.validation.errors.join("; ")}`;
      finalResult = {
        ...finalResult,
        ok: false,
        status: "failed",
        failureCause: "script-rejected",
        summary: message,
        diagnostics: [...finalResult.diagnostics, message],
      };
    }
    const durationMs = Date.now() - executionStartedAtMs;
    let artifactEvidence;
    try {
      artifactEvidence = artifactPorts?.recordAgentEvidence({
        callId,
        name: opts?.artifact ?? defaultArtifactName(req.label ?? workflowAgentDisplayName(req), callId),
        ...(req.phase !== undefined ? { stage: req.phase } : {}),
        ...(finalResult.text !== undefined ? { text: finalResult.text } : {}),
        replayed,
        ...(replayed && replaySourceRunId !== undefined ? { replaySourceRunId } : {}),
        ...(finalResult.childSessionId !== undefined ? { childSessionId: finalResult.childSessionId } : {}),
        ...(finalResult.childTrace?.path !== undefined ? { childTracePath: finalResult.childTrace.path } : {}),
        ...(finalResult.resultArtifact !== undefined ? { resultArtifactPath: finalResult.resultArtifact } : {}),
      });
    } catch (err) {
      // The other terminal-by-throw record of an attempt: evidence writing failed, so no
      // agent_end follows. It carries the attempt trio plus explicit replay origin. The
      // failure belongs to the store after an answer was available; host readback rides
      // along only when that answer came from a fresh result that carries it.
      emit({
        ts: nowFn(),
        runId,
        kind: "error",
        source: "runtime",
        ...workflowExecutionIdentity(req),
        callId,
        ...attemptFields,
        replayed,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(req.title !== undefined ? { title: req.title } : {}),
        ...(req.itemPath !== undefined ? { itemPath: req.itemPath } : {}),
        ...(req.phase !== undefined ? { phase: req.phase } : {}),
        ...(req.capabilityMode !== undefined ? { capabilityMode: req.capabilityMode } : {}),
        // The call already HAD a classification when adoption failed — this record is the
        // only terminal line it gets, so dropping the cause here would turn a classified
        // timeout into an unclassified store error and leave the operator matching prose.
        ...(finalResult.status !== "completed" ? { failureCause: workflowAgentFailureCause(finalResult) } : {}),
        ...executedModelEvidence(finalResult),
        ...(finalResult.usage !== undefined ? { usage: finalResult.usage } : {}),
        message: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      throw err;
    }
    // One line, one wording, for every axis that actually stopped something. The
    // `agent_end` below already carries the machine-readable cause; this says in the
    // operator's words that a limit they set was reached, not that the child answered
    // badly — and that whatever the child had already produced is still stored.
    const stoppedAxis = PER_CALL_BUDGET_STOPS[workflowAgentFailureCause(finalResult)];
    if (finalResult.status !== "completed" && stoppedAxis !== undefined) {
      emit({
        ts: nowFn(),
        runId,
        kind: "log",
        source: "runtime",
        message: formatWorkflowBudgetStop(stoppedAxis, finalResult.summary),
        ...(req.phase !== undefined ? { phase: req.phase } : {}),
      });
    }
    emit({
      ts: nowFn(),
      runId,
      kind: "agent_end",
      ...workflowExecutionIdentity(req),
      callId,
      ...attemptFields,
      replayed,
      ...(finalResult.readOnly !== undefined ? { readOnly: finalResult.readOnly } : {}),
      ...(finalResult.displayName !== undefined ? { displayName: finalResult.displayName } : {}),
      ...(req.capabilityMode !== undefined ? { capabilityMode: req.capabilityMode } : {}),
      ...(finalResult.activeToolNames !== undefined ? { activeToolNames: finalResult.activeToolNames } : {}),
      status: finalResult.status,
      ...(finalResult.status !== "completed" ? { message: finalResult.summary } : {}),
      // Machine-readable cause on every non-completed call, so a reader never has to
      // match on `summary` prose to tell a timeout from a cancellation.
      ...(finalResult.status !== "completed" ? { failureCause: workflowAgentFailureCause(finalResult) } : {}),
      // Shape verdict for THIS attempt; absent on every call that declared no schema.
      ...(schemaCheck !== undefined ? { schemaValidation: schemaCheck.validation } : {}),
      ...(finalResult.outputAcceptance === undefined ? {} : { outputAcceptance: finalResult.outputAcceptance }),
      permissionMode: finalResult.permissionMode ?? permissionMode,
      workspaceMode: finalResult.workspaceMode ?? workspaceMode,
      ...activeGroupFields(),
      ...(finalResult.model !== undefined ? { model: finalResult.model } : {}),
      // The two model facts this line can honestly carry: what the host said the child
      // ran on, and — when a declared tier had nothing assigned — that it degraded.
      ...(finalResult.executedModel !== undefined ? { executedModel: finalResult.executedModel } : {}),
      ...(finalResult.modelRoleFallback !== undefined ? { modelRoleFallback: finalResult.modelRoleFallback } : {}),
      ...(finalResult.thinking !== undefined ? { thinking: finalResult.thinking } : {}),
      ...(finalResult.evidence !== undefined ? { evidence: finalResult.evidence } : {}),
      ...(finalResult.evidence?.warnings !== undefined && finalResult.evidence.warnings.length > 0
        ? { evidenceWarnings: finalResult.evidence.warnings }
        : {}),
      ...(finalResult.childSessionId !== undefined ? { childSessionId: finalResult.childSessionId } : {}),
      ...(finalResult.childTrace !== undefined ? { childTrace: finalResult.childTrace } : {}),
      ...(finalResult.resultArtifact !== undefined ? { resultArtifact: finalResult.resultArtifact } : {}),
      ...(artifactEvidence?.answer !== undefined ? { answerArtifact: artifactEvidence.answer } : {}),
      ...(artifactEvidence?.transcript !== undefined ? { transcriptArtifact: artifactEvidence.transcript } : {}),
      ...(artifactEvidence?.result !== undefined ? { resultEnvelopeArtifact: artifactEvidence.result } : {}),
      ...(req.workspaceHandle !== undefined ? { workspaceHandle: req.workspaceHandle } : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.itemPath !== undefined ? { itemPath: req.itemPath } : {}),
      ...(req.phase !== undefined ? { phase: req.phase } : {}),
      // Round record for the drill submenu (REQ-009): (slotKey,round,usage) from the bridge.
      // Absent on old journals ⇒ read side treats the run as no-rounds (submenu hidden).
      ...(finalResult.slotKey !== undefined ? { slotKey: finalResult.slotKey } : {}),
      ...(finalResult.round !== undefined ? { round: finalResult.round } : {}),
      ...(finalResult.usage !== undefined ? { usage: finalResult.usage } : {}),
      ...(finalResult.worktreePath !== undefined ? { worktreePath: finalResult.worktreePath } : {}),
      durationMs,
    });
    if (!finalResult.ok || finalResult.status !== "completed" || finalResult.text === undefined) {
      return { ok: false, result: finalResult, callId, replayed };
    }
    return {
      ok: true,
      text: finalResult.text,
      outcome: {
        text: finalResult.text,
        callId,
        replayed,
        ...(finalResult.outputAcceptance === undefined ? {} : { outputAcceptance: finalResult.outputAcceptance }),
        ...(schemaCheck !== undefined ? { schemaCheck } : {}),
      },
    };
  }

  return runPhysicalAgentAttempt;
}
