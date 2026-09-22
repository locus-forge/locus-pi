import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import {
  createAgentExecutionPromptCapsule,
  formatAgentKickoffPrompt,
} from "../../../../extensions/_shared/agent-runtime/agent-execution-prompt.js";
import type { AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { createHarness, runTool } from "../../../test-harness.js";

const runSpy = vi.fn();
const tempRoots: string[] = [];

vi.mock("../../../../extensions/_shared/agent-runtime/agent-sdk-host.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../extensions/_shared/agent-runtime/agent-sdk-host.js")>(
    "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js",
  );
  return {
    ...actual,
    createAgentSdkSessionExecutor() {
      return {
        async run(request: AgentRunRequest) {
          const capsule = createAgentExecutionPromptCapsule(request);
          const kickoff = formatAgentKickoffPrompt(capsule);
          runSpy({ request, kickoff });
          return fakeResult();
        },
      };
    },
  };
});

afterEach(() => {
  runSpy.mockReset();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = "locus-parent-context-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/**
 * A root that owns `reviewer` outright.
 *
 * Discovery is project → user → bundled, so a root with no `.agents/agents/` reads
 * whatever catalog the developer installed under `$HOME`. That was harmless while
 * agent frontmatter `model:` was parsed and never used; now that it selects the
 * child's model, a stale home catalog can refuse the run and these assertions would
 * fail for a reason that has nothing to do with parent context.
 */
function tempRootWithReviewer(prefix = "locus-parent-context-"): string {
  const root = tempRoot(prefix);
  mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Project reviewer\ntools: read, search\nrisk: medium\n---\nReview.",
    "utf8",
  );
  return root;
}

describe("agents task parent context", () => {
  it("accepts one task string and omits parent context", async () => {
    const h = createHarness(tempRootWithReviewer());
    agents(h.pi);

    const result = await runTool(h, "spawn_agent", {
      agent: "reviewer",
      task: "One child task",
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]![0].request).not.toHaveProperty("parentContext");
    expect(result.details).toMatchObject({
      parentContextBroker: { forwarded: false, sources: [], agentDefault: false },
    });
  });

  it("forwards non-empty parent context and reads artifact payload into kickoff", async () => {
    const root = tempRootWithReviewer();
    const h = createHarness(root);
    agents(h.pi);
    const artifactPath = path.join(root, "parent-context.md");
    writeFileSync(artifactPath, "PARENT_ARTIFACT_SENTINEL\n", "utf8");

    const result = await runTool(h, "spawn_agent", {
      agent: "reviewer",
      task: "Child assignment without sentinel",
      parentContext: {
        inline: "INLINE_PARENT_SENTINEL",
        artifactPath,
      },
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    const { kickoff, request } = runSpy.mock.calls[0]![0] as {
      kickoff: string;
      request: { parentContext?: { inline?: string; artifactPath?: string } };
    };
    expect(request.parentContext).toMatchObject({ inline: "INLINE_PARENT_SENTINEL", artifactPath });
    expect(kickoff).toContain("INLINE_PARENT_SENTINEL");
    expect(kickoff).toContain("PARENT_ARTIFACT_SENTINEL");
    expect(kickoff).toContain("Child assignment without sentinel");
    expect(kickoff).not.toContain("INLINE_PARENT_SENTINEL\n---\nChild assignment without sentinel");
    expect(result.details).toMatchObject({
      parentContextBroker: { forwarded: true, sources: ["inline", "artifactPath"], agentDefault: false },
    });
  });

  it("reports forwarded false and agentDefault true when parentContextDefault is set but payload is absent", async () => {
    const root = tempRoot("locus-parent-default-agent-");
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "parent-default.md"),
      `---\nname: parent-default\ndescription: Parent default agent\ntools: read\nrisk: low\nparentContextDefault: true\n---\nAgent.`,
      "utf8",
    );
    const h = createHarness(root);
    agents(h.pi);

    const result = await runTool(h, "spawn_agent", {
      agent: "parent-default",
      task: "No payload",
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]![0].request).not.toHaveProperty("parentContext");
    expect(result.details).toMatchObject({
      parentContextBroker: { forwarded: false, sources: [], agentDefault: true },
    });
  });
});

function fakeResult() {
  return {
    status: "completed",
    agentName: "reviewer",
    reason: "done",
    diagnostics: [],
    lifecycleEntryIds: [],
    text: "done",
    childOutputStats: {
      entryCount: 1,
      assistantMessageCount: 1,
      assistantToolCallCount: 0,
      toolResultCount: 0,
      hasWorkloadProof: false,
    },
  };
}
