import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import * as sdk from "@earendil-works/pi-coding-agent";
import {
  createExecutionState,
  type ExecutionIdentity,
  type ExecutionLease,
} from "../../../extensions/_shared/runtime/execution-state.js";

/** Tests the internal scheduling seam with real SDK sessions and synthetic streams.
 * fixture_delegate is test-only; no published child tool exclusion is changed. */
describe("shared execution ownership through the real Pi agent loop", () => {
  it("suspends and resumes two generations of tool-waiting parents at concurrency=1", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "locus-execution-owner-sdk-"));
    const owner = createExecutionState({
      concurrency: 1,
      totalAgents: 3,
      capError: () => new Error("fixture cap exceeded"),
      deadlineError: () => new Error("fixture deadline exceeded"),
    });
    const evidence: Array<{
      identity: ExecutionIdentity;
      sessionId: string;
      text: string | undefined;
      activeTools: string[];
    }> = [];
    async function runSession(depth: number, lease: ExecutionLease): Promise<string> {
      const model = getModel("openai", "gpt-4o-mini");
      const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
      const modelRuntime = await sdk.ModelRuntime.create({
        authPath: path.join(cwd, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(cwd, `models-${depth}.json`),
        refreshOnCreate: false,
      });
      const loader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const customTools: sdk.ToolDefinition[] =
        depth === 0
          ? []
          : [
              {
                name: "fixture_delegate",
                label: "fixture delegation",
                description: "Exercise owned child admission",
                parameters: Type.Object({}),
                async execute() {
                  const text = await lease.withChildren(async (children) =>
                    children.createInvocation("fresh").run(async (child) => runSession(depth - 1, child)),
                  );
                  return { content: [{ type: "text", text }], details: {} };
                },
              },
            ];
      const { session } = await sdk.createAgentSession({
        cwd,
        agentDir: cwd,
        model,
        modelRuntime,
        resourceLoader: loader,
        settingsManager,
        sessionManager: sdk.SessionManager.inMemory(cwd),
        customTools,
        tools: customTools.map((tool) => tool.name),
      });
      await session.bindExtensions({});
      let turns = 0;
      session.agent.streamFunction = () => {
        const delegate = depth > 0 && turns++ === 0;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: delegate
            ? [{ type: "toolCall", id: `delegate-${depth}`, name: "fixture_delegate", arguments: {} }]
            : [{ type: "text", text: `done-${depth}` }],
          stopReason: delegate ? "toolUse" : "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: delegate ? "toolUse" : "stop", message });
        stream.end();
        return stream;
      };
      try {
        await session.agent.prompt(`fixture depth ${depth}`);
        const transcript = session.exportToJsonl(path.join(cwd, `session-${depth}.jsonl`));
        expect(JSON.parse(readFileSync(transcript, "utf8").split("\n")[0]!)).toMatchObject({
          type: "session",
          id: session.sessionId,
        });
        const result = session.messages.find((message) => message.role === "toolResult");
        if (depth > 0)
          expect(result).toMatchObject({
            role: "toolResult",
            isError: false,
            content: [{ type: "text", text: `done-${depth - 1}` }],
          });
        evidence.push({
          identity: lease.identity,
          sessionId: session.sessionId,
          text: session.getLastAssistantText(),
          activeTools: session.getActiveToolNames(),
        });
        return session.getLastAssistantText()!;
      } finally {
        session.dispose();
      }
    }
    try {
      expect(await owner.createInvocation("fresh").run(async (root) => runSession(2, root))).toBe("done-2");
      expect(evidence.map((item) => item.identity)).toEqual([
        { sequence: 3, parentSequence: 2 },
        { sequence: 2, parentSequence: 1 },
        { sequence: 1 },
      ]);
      expect(new Set(evidence.map((item) => item.sessionId)).size).toBe(3);
      expect(evidence.map((item) => item.activeTools)).toEqual([[], ["fixture_delegate"], ["fixture_delegate"]]);
      expect(owner.invocationCounts()).toEqual({ fresh: 3, replayed: 0 });
      expect(owner.peakAgentConcurrency()).toBe(1);
      expect(owner.activeAgentConcurrency()).toBe(0);
    } finally {
      await owner.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
