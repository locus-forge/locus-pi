import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  assembleParentContext,
  createAgentExecutionPromptCapsule,
  formatAgentKickoffPrompt,
} from "../../../extensions/_shared/agent-runtime/agent-execution-prompt.js";
import {
  createAgentRunRequest,
  executeAgentRunBoundary,
  type AgentExecutor,
} from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import type { ExtensionAPI, ExtensionContext } from "../../../extensions/_shared/host/pi-api.js";
import type { AgentDefinition } from "../../../extensions/_shared/agent-runtime/agents.js";

const agent: AgentDefinition = {
  name: "reviewer",
  description: "Review code",
  allowedTools: ["read", "yield"],
  tools: ["read", "yield"],
  risk: "low",
  readOnly: true,
  source: "project",
};

function pi(): ExtensionAPI {
  return {
    registerCommand() {},
    registerTool() {},
    on() {},
    appendEntry: vi.fn(async () => {}),
    async sendUserMessage() {},
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  };
}

function ctx(projectRoot: string, getBranch: ReturnType<typeof vi.fn>): ExtensionContext {
  return {
    cwd: projectRoot,
    isIdle() {
      return true;
    },
    ui: {
      async select() {
        return { value: "", cancelled: true };
      },
      async input() {
        return { value: "", cancelled: true };
      },
      async editor() {
        return { value: "", cancelled: true };
      },
      async confirm() {
        return true;
      },
      notify() {},
      setStatus() {},
      setWidget() {},
      setTitle() {},
      setWorkingIndicator() {},
    },
    session: { id: "parent-session", projectRoot, workingDirectory: projectRoot },
    sessionManager: {
      getEntries() {
        return [];
      },
      getBranch,
      getSessionId() {
        return "parent-session";
      },
      getSessionFile() {
        return undefined;
      },
    },
  };
}

describe("T-119 explicit parent-context", () => {
  it("does not call sessionManager.getBranch on the default false/absent path", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "locus-parent-context-"));
    const getBranch = vi.fn(() => {
      throw new Error("getBranch must not be called without a proven Branch A contract");
    });
    const executor: AgentExecutor = {
      async run(request) {
        return {
          status: "completed",
          agentName: request.agent?.name ?? "sub-agent",
          reason: "completed without parent branch inheritance",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    };

    const result = await executeAgentRunBoundary({
      pi: pi(),
      ctx: ctx(projectRoot, getBranch),
      request: createAgentRunRequest(agent, "Review this change", { approvalTier: "allow" }),
      executor,
    });

    expect(result.status).toBe("completed");
    expect(getBranch).not.toHaveBeenCalled();
  });

  it("omits parent context from the default kickoff payload", () => {
    const request = {
      ...createAgentRunRequest(agent, "Review this change", { approvalTier: "allow" }),
      parentSessionId: "parent-session",
      projectRoot: "/project",
      workingDirectory: "/project",
    };

    const capsule = createAgentExecutionPromptCapsule(request, [], {
      LOCUS_AGENT_CONTEXT_EXTRAS: "0",
    });
    expect(Object.hasOwn(capsule, "parentContext")).toBe(false);

    const kickoffString = formatAgentKickoffPrompt(capsule);
    const reference = formatAgentKickoffPrompt(capsule);
    expect(kickoffString).toBe(reference);
    expect(kickoffString).not.toContain("Parent-provided context (explicit, read-only):");
  });

  it("adds inline parent context to the kickoff payload", () => {
    const request = {
      ...createAgentRunRequest(agent, "Review this change", {
        approvalTier: "allow",
        parentContext: { inline: "PARENT_CTX_SENTINEL" },
      }),
      parentSessionId: "parent-session",
      projectRoot: "/project",
      workingDirectory: "/project",
    };

    const capsule = createAgentExecutionPromptCapsule(request, [], {
      LOCUS_AGENT_CONTEXT_EXTRAS: "0",
    });
    expect(capsule.parentContext).toContain("PARENT_CTX_SENTINEL");

    const kickoffString = formatAgentKickoffPrompt(capsule);
    expect(kickoffString).toContain("PARENT_CTX_SENTINEL");
    expect(kickoffString).toContain("Parent-provided context (explicit, read-only):");
  });

  it("adds artifact parent context from an explicit path", () => {
    const result = assembleParentContext({ artifactPath: "/fake/path.md" }, () => "ARTIFACT_SENTINEL");

    expect(result).toContain("ARTIFACT_SENTINEL");
  });

  it("passes a large parent context to the child whole, and says so in the receipt", () => {
    // This is the child's INPUT, not a projection for a human reader. Cutting it at 16 KiB
    // deleted the half of the brief the child never learns it was missing — and the marker
    // it left behind is not the data. What a large context earns now is a receipt line the
    // operator can act on, never a silent edit.
    const twentyThousand = "X".repeat(20_000);
    const assembled = assembleParentContext({ inline: twentyThousand });

    expect(assembled).toBe(twentyThousand);
    expect(assembled).not.toContain("parent context truncated");

    const diagnostics: string[] = [];
    const capsule = createAgentExecutionPromptCapsule(
      {
        ...createAgentRunRequest(agent, "Review this change", {
          approvalTier: "allow",
          parentContext: { inline: twentyThousand },
        }),
        parentSessionId: "parent-session",
        projectRoot: "/project",
        workingDirectory: "/project",
      },
      diagnostics,
      { LOCUS_AGENT_CONTEXT_EXTRAS: "0" },
    );

    expect(capsule.parentContext).toBe(twentyThousand);
    expect(formatAgentKickoffPrompt(capsule)).toContain(twentyThousand);
    const note = diagnostics.find((entry) => entry.includes("Parent context is"));
    expect(note).toContain("20000 bytes");
    expect(note).toContain("whole (no truncation)");
    expect(capsule.contextDiagnostics).toContain(note);
  });

  it("leaves a small parent context unremarked", () => {
    const diagnostics: string[] = [];
    const capsule = createAgentExecutionPromptCapsule(
      {
        ...createAgentRunRequest(agent, "Review this change", {
          approvalTier: "allow",
          parentContext: { inline: "PARENT_CTX_SENTINEL" },
        }),
        parentSessionId: "parent-session",
        projectRoot: "/project",
        workingDirectory: "/project",
      },
      diagnostics,
      { LOCUS_AGENT_CONTEXT_EXTRAS: "0" },
    );

    expect(capsule.parentContext).toBe("PARENT_CTX_SENTINEL");
    expect(diagnostics.some((entry) => entry.includes("Parent context is"))).toBe(false);
  });
});
