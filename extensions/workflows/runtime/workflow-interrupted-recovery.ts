import path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { ownedStandardDslCall } from "../source/workflow-source-bindings.js";
import type { WorkflowScriptIdentity } from "./workflow-script-identity.js";
import { workflowTypedInputProjection, type WorkflowTypedInput } from "./workflow-input.js";
/** Explicit, conservative recovery admission. This never manufactures or writes a terminal result. */
import { createHash } from "node:crypto";
import {
  readWorkflowLaunchBinding,
  workflowExecutionMigrationMessage,
  type WorkflowLaunchBinding,
} from "./workflow-launch-binding.js";
import { readWorkflowRunJournalState, type WorkflowRunResultEnvelope } from "./workflow-journal.js";
import { readWorkflowReplayLog, workflowReplayFile, type WorkflowReplayEntry } from "./workflow-replay.js";
import {
  listWorkflowRunDirectories,
  readWorkflowRunTextFile,
  resolveWorkflowRunDir,
  workflowRunFileExists,
} from "./workflow-run-layout.js";
import { workflowResultFile } from "./workflow-result.js";
import { orchestrationOnlyWorkflowSourceShapeDiagnostics } from "../tool/workflow-source-shape.js";

export interface InterruptedRecoveryExpectation {
  target: WorkflowLaunchBinding["target"];
  scriptSha256: string;
  recoveryInputSha256: string;
}

/** Hash all caller-owned semantic inputs and resolved budgets, preserving exact item order and bytes. */
export function workflowRecoveryInputHash(value: {
  input?: string;
  typedInput?: WorkflowTypedInput;
  items: readonly string[];
  args?: Record<string, unknown>;
  budget: unknown;
  noOperator?: boolean;
}): string {
  const args = Object.fromEntries(
    Object.entries(value.args ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: value.typedInput === undefined ? 1 : 2,
        ...(value.typedInput === undefined
          ? { input: value.input ?? null }
          : { typedInput: workflowTypedInputProjection(value.typedInput) }),
        items: value.items,
        args,
        budget: value.budget,
        noOperator: value.noOperator === true,
      }),
    )
    .digest("hex");
}

export function readInterruptedWorkflowResumeBinding(
  projectRoot: string,
  runId: string,
  expected: InterruptedRecoveryExpectation,
): WorkflowRunResultEnvelope {
  const runDir = resolveWorkflowRunDir(projectRoot, runId);
  if (workflowRunFileExists(runDir, workflowResultFile(runDir)))
    throw new Error("Interrupted recovery requires an absent result.json, not a malformed or completed result");
  const directories = listWorkflowRunDirectories(projectRoot);
  const source = directories.find((entry) => entry.runId === runId);
  if (
    source === undefined ||
    source.kind === "child" ||
    directories.some((entry) => entry.storageRootRunId === source.storageRootRunId && entry.kind === "child")
  ) {
    throw new Error("Interrupted recovery currently supports root serial workflows without saved children only");
  }
  const binding = readWorkflowLaunchBinding(projectRoot, runId, runDir);
  if (binding === null) throw new Error(workflowExecutionMigrationMessage(runId));
  if (
    JSON.stringify(binding.target) !== JSON.stringify(expected.target) ||
    binding.scriptIdentity.scriptSha256 !== expected.scriptSha256 ||
    binding.recoveryInputSha256 !== expected.recoveryInputSha256
  ) {
    throw new Error(
      "Interrupted recovery requires the identical target, source, input, items, arguments and resolved budget",
    );
  }
  if (
    binding.scriptIdentity.identityCoverage !== "self-contained-static" ||
    binding.scriptIdentity.builtinImports.length !== 0 ||
    binding.scriptIdentity.unboundDependencies.length !== 0
  ) {
    throw new Error("Interrupted recovery requires a self-contained orchestration-only source without imports");
  }
  const sourceText = readWorkflowRunTextFile(runDir, binding.scriptIdentity.snapshotPath);
  if (
    orchestrationOnlyWorkflowSourceShapeDiagnostics(sourceText).some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new Error("Interrupted recovery source does not pass the current orchestration-only checker");
  }
  const journal = readWorkflowRunJournalState(projectRoot, runId, runDir);
  if (journal.diagnostics.length > 0 || journal.lines.length === 0)
    throw new Error("Interrupted recovery journal is missing or damaged");
  if (journal.lines.some((line) => line.kind === "group_start" || line.kind === "error"))
    throw new Error("Interrupted recovery refuses grouped or already-failed execution; operator review is required");
  const starts = journal.lines.filter((line) => line.kind === "agent_start");
  const ends = journal.lines.filter((line) => line.kind === "agent_end");
  if (
    starts.length === 0 ||
    starts.length !== ends.length ||
    new Set(starts.map((line) => line.callId)).size !== starts.length
  ) {
    throw new Error("Interrupted recovery has unconfirmed child effects; operator review is required");
  }
  let activeCall: string | undefined;
  for (const line of journal.lines) {
    if (line.kind === "agent_start") {
      if (activeCall !== undefined || line.callId === undefined)
        throw new Error("Interrupted recovery refuses overlapping or unnamed execution");
      activeCall = line.callId;
    } else if (line.kind === "agent_end") {
      if (activeCall === undefined || activeCall !== line.callId)
        throw new Error("Interrupted recovery refuses an unordered confirmation prefix");
      activeCall = undefined;
    }
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!,
      end = ends[index]!;
    if (
      start.callId === undefined ||
      start.label === undefined ||
      start.callId !== end.callId ||
      end.status !== "completed" ||
      (end.schemaValidation !== undefined && end.schemaValidation.status !== "valid")
    ) {
      throw new Error("Interrupted recovery requires a fully confirmed labelled serial prefix");
    }
  }
  const rawReplay = readWorkflowRunTextFile(runDir, workflowReplayFile(runDir));
  const rawRows = rawReplay.split("\n").filter((row) => row.trim() !== "");
  const replay = readWorkflowReplayLog(projectRoot, runId);
  if (
    !rawReplay.endsWith("\n") ||
    rawRows.length !== replay.length ||
    replay.length !== ends.length ||
    replay.some(
      (entry, index) => entry.kind !== "agent" || !entry.ok || entry.seq !== index || entry.node === undefined,
    )
  ) {
    throw new Error("Interrupted recovery replay prefix is missing, partial, unordered or unconfirmed");
  }
  // No success, disposition or synthetic result is persisted: this object is admission metadata only.
  return {
    runId,
    storageRootRunId: source.storageRootRunId,
    ok: false,
    target: binding.target,
    scriptIdentity: binding.scriptIdentity,
    workspaceDir: binding.workspace.absolutePath,
    workspaceDirRelative: binding.workspace.relativePath,
    workspaceDirExplicit: binding.workspace.explicit,
    workspacePhysicalIdentity: binding.workspace.physicalIdentity,
    workspacePhysicalIdentitySchemaVersion: 1,
    semanticInputPresent: binding.semanticInput.present,
    semanticInputSha256: binding.semanticInput.sha256,
    ...(binding.typedInput === undefined ? {} : { typedInput: workflowTypedInputProjection(binding.typedInput) }),
  };
}

/** No changed prefix may silently turn an interrupted recovery into duplicate fresh work. */
export function confirmedRecoveryAgentCount(entries: readonly WorkflowReplayEntry[]): number {
  return entries.filter((entry) => entry.kind === "agent").length;
}

/** Completed typed replay proves complete recorded work; legacy fallback remains in resume. */
export function assertCompletedTypedReplayEvidence(
  projectRoot: string,
  runId: string,
  scriptIdentity: WorkflowScriptIdentity,
  recorded: readonly WorkflowReplayEntry[],
): void {
  const runDir = resolveWorkflowRunDir(projectRoot, runId);
  const journal = readWorkflowRunJournalState(projectRoot, runId, runDir);
  const counts = JSON.parse(readWorkflowRunTextFile(runDir, workflowResultFile(runDir))).replay;
  const agentRows = recorded.filter((entry) => entry.kind === "agent");
  const starts = journal.lines.filter((line) => line.kind === "agent_start");
  const ends = journal.lines.filter((line) => line.kind === "agent_end");
  const calls = new Set(starts.map((line) => line.logicalCallId ?? line.callId));
  const raw = workflowRunFileExists(runDir, workflowReplayFile(runDir))
    ? readWorkflowRunTextFile(runDir, workflowReplayFile(runDir))
    : "";
  const rows = raw.split("\n").filter((row) => row.trim() !== "");
  const source = parse(
    Lang.JavaScript,
    readWorkflowRunTextFile(path.dirname(scriptIdentity.snapshotPath), scriptIdentity.snapshotPath),
  ).root();
  const valuesPossible = source
    .findAll({ rule: { kind: "call_expression" } })
    .some((node) => ["now", "random"].includes(ownedStandardDslCall(source, node) ?? ""));
  if (
    journal.diagnostics.length !== 0 ||
    journal.lines.length === 0 ||
    counts?.recorded !== true ||
    !Number.isSafeInteger(counts.freshCalls) ||
    counts.freshCalls < 0 ||
    !Number.isSafeInteger(counts.replayedCalls) ||
    counts.replayedCalls < 0 ||
    counts.freshCalls + counts.replayedCalls !== agentRows.length ||
    calls.size !== agentRows.length ||
    starts.some((start) => !ends.some((end) => end.callId === start.callId)) ||
    rows.length !== recorded.length ||
    (raw !== "" && !raw.endsWith("\n")) ||
    (raw === "" && valuesPossible) ||
    ["agent", "clock", "random"].some((kind) =>
      recorded.filter((entry) => entry.kind === kind).some((entry, index) => entry.seq !== index),
    )
  )
    throw new Error("typed input replay evidence is missing, damaged or incomplete");
}
