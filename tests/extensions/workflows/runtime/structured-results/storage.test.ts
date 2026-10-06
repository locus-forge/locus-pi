import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  writeAgentRunResultArtifact,
  type AgentRunRequest,
  type AgentRunResult,
} from "../../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { rawTurn, structuredSdk } from "../../../../fixtures/agent-runtime/structured-sdk.js";

it("removes provisional v4 acceptance when canonical result storage fails, preserving answer evidence", async () => {
  const observed = await structuredSdk({ schema: { type: "null" } }, [rawTurn(['{"value":null}'])]);
  expect(observed.error).toBeUndefined();
  const root = mkdtempSync(path.join(tmpdir(), "structured-result-storage-"));
  const request: AgentRunRequest = {
    executionMode: "bare",
    task: "fixture",
    parentSessionId: "fixture",
    projectRoot: root,
    depth: 0,
    maxDepth: 1,
    allowedTools: ["*"],
    approvalTier: "allow",
  };
  const result: AgentRunResult = {
    executionMode: "bare",
    status: "completed",
    reason: "fixture completed",
    diagnostics: [],
    lifecycleEntryIds: [],
    text: "null",
    outputAcceptance: observed.acceptance!,
  };
  try {
    const blocked = path.join(root, "blocked");
    writeFileSync(blocked, "a file blocks the artifact directory");
    const stored = writeAgentRunResultArtifact(root, request, result, blocked);
    expect(stored).toMatchObject({
      status: "storage-failed",
      text: "null",
      resultStorage: { executionStatus: "completed", answerAvailable: true },
    });
    expect(stored.outputAcceptance).toBeUndefined();
    expect(result.outputAcceptance).toBeDefined();
    const stopped = writeAgentRunResultArtifact(root, request, {
      ...result,
      status: "failed",
      failureCause: "call-timeout",
    });
    expect(stopped.outputAcceptance).toBeUndefined();
    expect(stopped.status).toBe("failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
