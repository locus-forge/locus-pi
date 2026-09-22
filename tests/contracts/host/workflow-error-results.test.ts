import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import workflows from "../../../extensions/workflows/index.js";
import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";
import { registerWorkflowSourceCheckTool } from "../../../extensions/workflows/tool/workflow-source-check-tool.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow errors through the supported Pi agent loop", () => {
  it.each([false, true])("keeps diagnostics and machine failure aligned (bridge=%s)", async (bridge) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "workflow-pi-errors-"));
    roots.push(cwd);
    const agentDir = path.join(cwd, "agent");
    mkdirSync(agentDir);
    writeFileSync(
      path.join(cwd, "valid.workflow.mjs"),
      'export const meta = { name: "valid", profile: "standard" }; export default function run() { return "done"; }',
    );
    writeFileSync(path.join(cwd, "invalid.workflow.mjs"), 'import fs from "node:fs"; export default function run() {}');
    writeFileSync(
      path.join(cwd, "failed.workflow.mjs"),
      'export const meta = { name: "failed", profile: "standard" }; export default function run() { return { ok: false, status: "failed", reason: "intentional refusal" }; }',
    );
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          // The control removes only the hook, reproducing the old normal-return false green.
          if (bridge) workflows(pi as unknown as ExtensionAPI);
          else
            registerWorkflowSourceCheckTool({
              registerTool: pi.registerTool.bind(pi),
              on: () => {},
            } as unknown as ExtensionAPI);
        },
      ],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    const model = getModel("openai", "gpt-4o-mini");
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      tools: bridge ? ["workflow_check_source", "workflow", "fusion"] : ["workflow_check_source"],
    });
    await session.bindExtensions({});
    // Exercise a disabled Fusion invocation too: its error must survive the host.
    if (bridge) session.setActiveToolsByName(["workflow_check_source", "workflow", "fusion"]);
    let turn = 0;
    const observed: unknown[] = [];
    session.agent.streamFunction = (_model, context) => {
      observed.push(context.messages);
      const first = turn++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: first
          ? [
              ...["valid", "invalid"].map((name) => ({
                type: "toolCall" as const,
                id: name,
                name: "workflow_check_source",
                arguments: { path: `${name}.workflow.mjs`, mode: "orchestration-only" },
              })),
              ...(bridge
                ? [
                    {
                      type: "toolCall" as const,
                      id: "run-failed",
                      name: "workflow",
                      arguments: { scriptPath: "failed.workflow.mjs" },
                    },
                    {
                      type: "toolCall" as const,
                      id: "fusion-disabled",
                      name: "fusion",
                      arguments: { question: "Check error propagation" },
                    },
                  ]
                : []),
            ]
          : [{ type: "text", text: "done" }],
        stopReason: first ? "toolUse" : "stop",
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
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    };
    try {
      await session.agent.prompt("Check both files");
      const results = session.messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(bridge ? 4 : 2);
      expect(results[0]).toMatchObject({ toolCallId: "valid", isError: false, details: { errorCount: 0 } });
      expect(results[1]).toMatchObject({
        toolCallId: "invalid",
        isError: bridge,
        details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: "WF_IMPORT" })]) },
      });
      if (bridge) {
        expect(results[2]).toMatchObject({
          toolCallId: "run-failed",
          isError: true,
          details: { disposition: { status: "failed" }, result: { ok: false } },
        });
        expect(results[3]).toMatchObject({
          toolCallId: "fusion-disabled",
          isError: true,
          details: { owner: "fusion" },
        });
      }
      expect(observed[1]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "toolResult", toolCallId: "invalid", isError: bridge }),
        ]),
      );
    } finally {
      session.dispose();
    }
  });
});
