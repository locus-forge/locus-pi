import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentRunRequest,
  createAgentRunRequest,
  executeAgentRunBoundary,
  validateRunPolicy,
} from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  MemorySessionStore,
  createDeterministicSessionIdFactory,
} from "../../../extensions/_shared/runtime/session-core.js";
import type { AgentDefinition } from "../../../extensions/_shared/agent-runtime/agents.js";
import { createHarness } from "../../test-harness.js";

const reviewer: AgentDefinition = {
  name: "reviewer",
  description: "Review code",
  allowedTools: ["read", "search", "yield"],
  tools: ["read", "search", "yield"],
  risk: "medium",
  readOnly: true,
  source: "project",
  filePath: "/repo/.agents/agents/reviewer.md",
};

function fullRequest(input: Partial<AgentRunRequest>): AgentRunRequest {
  return {
    ...createAgentRunRequest(reviewer, "Task", { approvalTier: "allow", ...input }),
    parentSessionId: "parent-session",
    projectRoot: "/repo",
    workingDirectory: "/repo",
  };
}

describe("agent runner contract", () => {
  it("invents no turn budget when the caller declares none", () => {
    const request = createAgentRunRequest(reviewer, "Task", { approvalTier: "allow" });
    expect(request.maxTurns).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(request, "maxTurns")).toBe(false);
    expect(validateRunPolicy(fullRequest({}))).toBeUndefined();
    // A caller that wants a stop still gets exactly the one it named.
    expect(createAgentRunRequest(reviewer, "Task", { maxTurns: 3 }).maxTurns).toBe(3);
  });

  it("blocks without an executor while recording child lifecycle entries", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const store = new MemorySessionStore({
      idFactory: createDeterministicSessionIdFactory("m10"),
      now: () => "2026-06-02T00:00:00.000Z",
    });

    const result = await executeAgentRunBoundary({
      pi: h.pi,
      ctx: h.ctx,
      sessionStore: store,
      request: createAgentRunRequest(reviewer, "Review this change", { approvalTier: "allow" }),
      // See the approval case below: an unwritable envelope is its own reported failure now.
      resultArtifactsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-runner-artifacts-")),
    });

    expect(result).toMatchObject({
      status: "blocked",
      agentName: "reviewer",
      reason: "No agent executor is configured.",
    });
    expect(result.childSession?.id).toBe("m10-session-1-child-of-parent-session");
    expect(result.lifecycleEntryIds).toHaveLength(2);
    expect(store.latestEntry("parent-session", "child_run")).toMatchObject({
      payload: {
        childSessionId: result.childSession?.id,
        status: "failed",
      },
    });
    expect(store.latestEntry(result.childSession!.id, "message")?.payload.content).toContain(
      "Sub-agent run requested for reviewer.",
    );
  });

  it("enforces budgets, depth, and allowed tools before creating a child run", () => {
    for (const maxTurns of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateRunPolicy(fullRequest({ maxTurns }))).toBe(
        "maxTurns must be a positive safe integer when declared.",
      );
    }
    expect(validateRunPolicy(fullRequest({ maxTurns: 1000 }))).toBeUndefined();
    expect(validateRunPolicy(fullRequest({ depth: 1, maxDepth: 1 }))).toBe(
      "Direct child-agent nesting depth for this scheduler is reached; no deeper managed child is started.",
    );
    expect(validateRunPolicy(fullRequest({ allowedTools: ["read", "bash"] }))).toBe(
      "Requested tools exceed the agent definition allow-list.",
    );
  });

  it("does not run local approval prompts before creating a child run", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    h.ctx.ui.confirm = async () => false;
    const store = new MemorySessionStore({
      idFactory: createDeterministicSessionIdFactory("m10"),
      now: () => "2026-06-02T00:00:00.000Z",
    });

    // A real directory for the result envelope: `/repo` does not exist, and a run that
    // cannot store its envelope is now reported as a storage failure rather than under
    // its execution status. This case is about approvals, so let the write succeed.
    const result = await executeAgentRunBoundary({
      pi: h.pi,
      ctx: h.ctx,
      sessionStore: store,
      request: createAgentRunRequest(reviewer, "Review this change", { approvalTier: "prompt" }),
      resultArtifactsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-runner-artifacts-")),
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "No agent executor is configured.",
    });
    expect(result.childSession?.id).toBe("m10-session-1-child-of-parent-session");
    expect(store.getSession("parent-session")).not.toBeUndefined();
    expect(h.entries.filter((entry) => entry.type === "decision")).toHaveLength(0);
  });
});
