import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type * as PiSdk from "@earendil-works/pi-coding-agent";

const packageRoot = process.cwd();
const entered = "synthetic workflow body entered";
const minimal = { mode: "compact" };
const full = { mode: "full", context: "  synthetic context\nunchanged  " };
interface InputCase {
  fields: Record<string, unknown>;
  expected?: unknown;
  error?: string;
  name?: string;
}
const cases: InputCase[] = [
  { fields: { inputValue: minimal }, expected: minimal },
  { fields: { inputValue: full }, expected: full },
  { fields: { inputValue: JSON.stringify(minimal) }, error: "must be object" },
  { fields: { inputValue: null }, error: "must be object" },
  { fields: { inputValue: [] }, error: "must be object" },
  { fields: { inputValue: { mode: "invalid" } }, error: "allowed values" },
  { fields: { inputValue: { ...minimal, context: 7 } }, error: "must be string" },
  { fields: { inputValue: {} }, error: "required" },
  { fields: { inputValue: { ...minimal, extra: true } }, error: "additional properties" },
  { fields: { input: JSON.stringify(minimal) }, error: "requires explicit inputValue and meta.inputSchema" },
  { fields: {}, error: "requires explicit inputValue and meta.inputSchema" },
  { name: "legacy-echo", fields: { input: "  exact legacy input\n" }, expected: "  exact legacy input\n" },
];

/** Synthetic parsed tool calls exercise host-tool integration, not provider parsing or slash commands.
 * The bundled CLI loader embeds TypeBox as virtual modules; the SDK uses Jiti aliases. */
describe.each(["sdk", "bundled-cli"] as const)("typed workflow tool through Pi %s", (host) => {
  it("preserves JSON objects and legacy text, while rejecting invalid typed input before entry", async () => {
    const sdk: typeof PiSdk =
      host === "sdk"
        ? await import("@earendil-works/pi-coding-agent")
        : await import(
            pathToFileURL(path.join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js"))
              .href
          );
    const root = mkdtempSync(path.join(tmpdir(), "locus-typed-host-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const workflowDir = path.join(cwd, ".locus-pi", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const body = `export default function run(dsl,input){dsl.log(${JSON.stringify(entered)});return input;}`;
    writeFileSync(
      path.join(workflowDir, "typed-echo.workflow.mjs"),
      'export const meta={profile:"dataflow-v1",inputSchema:{type:"object",properties:{mode:{type:"string",enum:["compact","full"]},context:{type:"string"}},required:["mode"],additionalProperties:false}};' +
        body,
    );
    writeFileSync(path.join(workflowDir, "legacy-echo.workflow.mjs"), body);
    const previousHome = process.env.HOME;
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousCwd = process.cwd();
    process.env.HOME = root;
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.chdir(cwd);
    let session: PiSdk.AgentSession | undefined;
    try {
      const settingsManager = sdk.SettingsManager.inMemory({
        packages: [{ source: packageRoot, extensions: ["extensions/workflows/index.ts"], skills: [] }],
        retry: { enabled: false },
      });
      const loader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const model = getModel("openai", "gpt-4o-mini");
      const modelRuntime = await sdk.ModelRuntime.create({
        authPath: path.join(root, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(root, "models.json"),
        refreshOnCreate: false,
      });
      ({ session } = await sdk.createAgentSession({
        cwd,
        agentDir,
        model,
        modelRuntime,
        resourceLoader: loader,
        settingsManager,
        sessionManager: sdk.SessionManager.inMemory(cwd),
        tools: ["workflow"],
      }));
      await session.bindExtensions({});
      let turns = 0;
      session.agent.streamFunction = () => {
        const index = turns++;
        const request = cases[index];
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: request
            ? [
                {
                  type: "toolCall",
                  id: `echo-${index}`,
                  name: "workflow",
                  arguments: { name: request.name ?? "typed-echo", ...request.fields },
                },
              ]
            : [{ type: "text", text: "fixture complete" }],
          stopReason: request ? "toolUse" : "stop",
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
        stream.push({ type: "done", reason: request ? "toolUse" : "stop", message });
        stream.end();
        return stream;
      };
      await session.agent.prompt("Run the synthetic input fixtures.");
      const results = session.messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(cases.length);
      for (const [index, result] of results.entries()) {
        const request = cases[index]!;
        const detail = JSON.stringify({ fields: request.fields, result });
        expect(result.isError, detail).toBe(request.error !== undefined);
        expect(result.toolCallId, detail).toBe(`echo-${index}`);
        const details = result.details as { resultPath: string; journal: Array<{ kind: string; message?: string }> };
        const persisted = JSON.parse(readFileSync(details.resultPath, "utf8"));
        const bindingPath = path.join(path.dirname(details.resultPath), "launch-binding.json");
        expect(persisted.ok, detail).toBe(request.error === undefined);
        expect(
          details.journal.some((line) => line.message === entered),
          detail,
        ).toBe(request.error === undefined);
        expect(
          details.journal.some((line) => line.kind === "agent_start"),
          detail,
        ).toBe(false);
        if (request.error !== undefined) {
          expect(persisted.error, detail).toContain(request.error);
          expect(existsSync(bindingPath), detail).toBe(false);
        } else {
          expect(persisted.result, detail).toEqual(request.expected);
          const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
          if (request.name === undefined) expect(binding.typedInput.value, detail).toEqual(request.expected);
          else expect(binding.typedInput, detail).toBeUndefined();
        }
      }
    } finally {
      session?.dispose();
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
