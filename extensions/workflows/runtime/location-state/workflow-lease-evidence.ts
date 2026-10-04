/** Same-host liveness, terminal-result proof, and actionable lease diagnostics. */

import { findWorkflowRunDir } from "../workflow-run-layout.js";
import { projectWorkflowDisposition } from "../workflow-outcome.js";
import { readWorkflowRunResult, workflowPersistedResultInvalidity, workflowResultFile } from "../workflow-result.js";
import type { WorkflowWorkspaceDirectory } from "../workflow-workspace.js";
import type { WorkflowLeaseRecord } from "./workflow-location-lease.js";
import { projectRelativeStatePath, stateFileRemovalCommand } from "./workflow-state-files.js";

const PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;

type WorkflowTerminalResultProof = { complete: true } | { complete: false; reason: string };

export type WorkflowLeaseOwnerInspection = {
  liveness: "alive" | "dead" | "unverifiable";
  terminalResult: WorkflowTerminalResultProof;
};

export function inspectLeaseOwner(projectRoot: string, record: WorkflowLeaseRecord): WorkflowLeaseOwnerInspection {
  const liveness = processLiveness(record.pid);
  return {
    liveness,
    terminalResult:
      liveness === "alive"
        ? inspectCompleteTerminalResult(projectRoot, record.rootRunId)
        : { complete: false, reason: "the recorded owner is not a verifiably live process" },
  };
}

export function leaseMayBeReclaimed(force: boolean, owner: WorkflowLeaseOwnerInspection): boolean {
  return owner.liveness === "dead" || (force && owner.liveness === "alive" && owner.terminalResult.complete);
}

function inspectCompleteTerminalResult(projectRoot: string, rootRunId: string): WorkflowTerminalResultProof {
  try {
    const runDir = findWorkflowRunDir(projectRoot, rootRunId);
    if (runDir === undefined) return { complete: false, reason: `no run directory exists for ${rootRunId}` };
    const result = readWorkflowRunResult(projectRoot, rootRunId, runDir);
    if (result === null) return { complete: false, reason: "the terminal result is missing or unreadable" };
    if (result.runUnbound !== undefined || result.runId === undefined) {
      return { complete: false, reason: "the terminal result has no bound runId" };
    }
    if (result.runId !== rootRunId) {
      return { complete: false, reason: `the terminal result belongs to run ${result.runId}` };
    }
    const invalidity = workflowPersistedResultInvalidity(result);
    if (invalidity !== undefined) {
      return { complete: false, reason: `the terminal result is invalid: ${invalidity}` };
    }
    if (typeof result.ok !== "boolean") {
      return { complete: false, reason: "the terminal result has no boolean ok field" };
    }
    if (result.disposition === undefined) {
      return { complete: false, reason: "the terminal result has no disposition" };
    }
    if (result.resultPersistence?.ok !== true || result.resultPersistence.path !== workflowResultFile(runDir)) {
      return { complete: false, reason: "the terminal result has no successful matching persistence record" };
    }
    const projection = projectWorkflowDisposition({
      ok: result.ok,
      result: result.result,
      ...(result.error === undefined ? {} : { error: result.error }),
      disposition: result.disposition,
    });
    if (projection.status === "unknown") {
      return { complete: false, reason: "the terminal disposition is malformed or inconsistent with ok" };
    }
    return { complete: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Ambiguous workflow run id:")) {
      return { complete: false, reason: `run evidence is ambiguous for ${rootRunId}` };
    }
    if (message.startsWith("Invalid workflow run location:")) {
      return { complete: false, reason: `run evidence is stored at an invalid location for ${rootRunId}` };
    }
    return { complete: false, reason: "the terminal result could not be resolved or read" };
  }
}

export function workflowLeaseOwnershipError(
  input: {
    projectRoot: string;
    kind: "workspace";
    location: WorkflowWorkspaceDirectory;
    force: boolean;
  },
  lockFile: string,
  current: WorkflowLeaseRecord,
  owner: WorkflowLeaseOwnerInspection,
): Error {
  const leasePath = projectRelativeStatePath(input.projectRoot, lockFile);
  const heading =
    owner.liveness === "alive"
      ? `workflow workspace ${JSON.stringify(input.location.relativePath)} is owned by live run ${current.rootRunId} (pid ${current.pid}, acquired ${current.acquiredAt})`
      : `workflow workspace ${JSON.stringify(input.location.relativePath)} has an unverifiable owner pid ${current.pid} (run ${current.rootRunId}, acquired ${current.acquiredAt})`;
  let recovery: string;
  if (owner.terminalResult.complete && !input.force) {
    recovery = "Retry the same launch with --force to reclaim this completed run's leaked lease.";
  } else if (leaseBelongsToCurrentProcessLifetime(current)) {
    recovery = `Run /workflows stop ${current.rootRunId}, then retry.`;
  } else if (process.platform === "win32") {
    const remove = stateFileRemovalCommand(leasePath);
    recovery =
      `Inspect with tasklist /FI \"PID eq ${current.pid}\". Exit Pi in its own window; ` +
      `fallback: taskkill /PID ${current.pid} /T /F. If the PID is unrelated, from the project root remove only ` +
      `the named lease with ${remove}.`;
  } else {
    const remove = stateFileRemovalCommand(leasePath);
    recovery =
      `Inspect with ps -p ${current.pid} -o pid,stat,lstart,command. Ctrl+Z suspends Pi: use fg in its original ` +
      `terminal and exit normally. If the PID is not Pi or started after ${current.acquiredAt}, from the project root ` +
      `remove only the named lease with ${remove}.`;
  }
  const forceRefusal =
    input.force && !owner.terminalResult.complete ? `\n--force refused: ${owner.terminalResult.reason}.` : "";
  return new Error(
    `${heading}.${forceRefusal}\nLease: ${leasePath}\nRecovery: ${recovery}\nOr choose another workspaceDir.`,
  );
}

function leaseBelongsToCurrentProcessLifetime(record: WorkflowLeaseRecord): boolean {
  if (record.pid !== process.pid) return false;
  const acquiredAt = Date.parse(record.acquiredAt);
  return Number.isFinite(acquiredAt) && acquiredAt >= PROCESS_STARTED_AT_MS - 1000;
}

function processLiveness(pid: number): "alive" | "dead" | "unverifiable" {
  if (!Number.isSafeInteger(pid) || pid < 1) return "unverifiable";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ESRCH") return "dead";
    return "unverifiable";
  }
}
