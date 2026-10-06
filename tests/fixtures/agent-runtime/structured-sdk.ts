import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
} from "../../../extensions/workflows/runtime/workflow-replay.js";
import type { ReadOnlyAgentCustomTool } from "../../../extensions/_shared/agent-runtime/agent-read-only-policy.js";
/** Real SDK, Agent loop and Codex adapter; only fetch bytes are synthetic. Never inference. */
import * as sdk from "@earendil-works/pi-coding-agent";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { stream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentSdkSessionExecutor,
  type SdkAgentSessionLike,
} from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { createWorkflowAgentRunner } from "../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { createWorkflowRuntime } from "../../../extensions/workflows/runtime/workflow-runtime.js";
import { createWorkflowArtifactStore } from "../../../extensions/workflows/runtime/workflow-artifacts.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { createHarness } from "../../test-harness.js";
import type {
  WorkflowAgentStructuredOptions,
  WorkflowAgentAnyOptions,
  WorkflowAgentRequest,
  WorkflowAgentResult,
} from "../../../extensions/workflows/runtime/workflow-agent-contract.js";
import type { AgentOutputAcceptance } from "../../../extensions/_shared/agent-runtime/agent-runner.js";

let turnSerial = 0;
export function rawTurn(values: string[], terminal = "completed", extra: object[] = [], names?: string[]): object[] {
  const serial = ++turnSerial;
  const responseId = `response_${serial}`;
  const items = values.map((arguments_, index) => ({
    type: "function_call",
    id: `fc_${serial}_${index}`,
    call_id: `call_${serial}_${index}`,
    name: names?.[index] ?? "workflow_return",
    arguments: arguments_,
  }));
  return [
    { type: "response.created", response: { id: responseId, status: "in_progress" } },
    ...items.flatMap((item, index) => [
      { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } },
      {
        type: "response.function_call_arguments.done",
        output_index: index,
        item_id: item.id,
        arguments: item.arguments,
      },
      { type: "response.output_item.done", output_index: index, item },
    ]),
    ...extra,
    ...(terminal === "disconnect"
      ? []
      : [
          {
            type: `response.${terminal}`,
            response: {
              id: responseId,
              status: terminal,
              output: items,
              ...(terminal === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
            },
          },
        ]),
  ];
}

export async function structuredSdk(
  options: WorkflowAgentStructuredOptions | WorkflowAgentAnyOptions,
  scripted: object[][],
  tweak?: (session: sdk.AgentSession) => void,
  failEvidence = false,
  beforeAttempt?: (request: WorkflowAgentRequest) => WorkflowAgentResult | undefined,
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "locus-structured-sdk-")));
  const counters = {
    physical: 0,
    sessions: 0,
    generations: 0,
    raw: 0,
    priorPrepare: 0,
    priorFinish: 0,
    tools: 0,
    effects: 0,
    prompts: 0,
  };
  let acceptance: AgentOutputAcceptance | undefined;
  let error: unknown;
  let value: unknown;
  let replayRecord: ReturnType<typeof readWorkflowReplayLog> = [];
  const runId = "structured-sdk";
  const runDir = path.join(root, ".locus-pi", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const native = "outputTransport" in options && options.outputTransport === "native";
  const nativeApi = native ? await import("@earendil-works/pi-ai/api/openai-responses") : undefined;
  const catalogModel = native
    ? (await import("@earendil-works/pi-ai/providers/openai"))
        .openaiProvider()
        .getModels()
        .find((model) => model.id === "gpt-6.1-sol")!
    : openaiCodexProvider().getModels()[0]!;
  if (catalogModel === undefined) throw new Error("Actual installed model catalog lacks fixture model");
  const model = { ...catalogModel };
  const payloads: unknown[] = [];
  const urls: string[] = [];
  let messages: unknown[] = [];
  let persisted: unknown[] = [];
  const syntheticToken =
    "fixture." +
    Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-only" } })).toString(
      "base64url",
    ) +
    ".fixture";
  const models = await sdk.ModelRuntime.create({
    authPath: path.join(root, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(root, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  models.registerProvider(native ? "openai" : "openai-codex", {
    api: model.api,
    apiKey: native ? "synthetic-offline-only" : syntheticToken,
    streamSimple: (actual, context, args) => {
      const fetch: typeof globalThis.fetch = async (url, init) => {
        urls.push(String(url));
        if (typeof init?.body === "string") payloads.push(JSON.parse(init.body));
        const events = scripted[counters.generations++] ?? rawTurn([]);
        return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      };
      return native
        ? nativeApi!.stream(actual as Parameters<NonNullable<typeof nativeApi>["stream"]>[0], context, {
            ...args,
            maxRetries: 0,
            fetch,
          })
        : stream(actual as Parameters<typeof stream>[0], context, { ...args, transport: "sse", maxRetries: 0, fetch });
    },
  });
  const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, cacheWarming: "off" });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Local synthetic fixture",
  });
  await loader.reload();
  const harness = createHarness(root);
  if (native) harness.ctx.model = { ...model };
  const store = createWorkflowArtifactStore({ projectRoot: root, runId, runDir });
  const bridge = createWorkflowAgentRunner({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    workflowRunId: runId,
    workflowRunDir: runDir,
    evidenceDestinations: (callId) => store.childEvidenceDestinations(callId),
    createExecutor: (opts) =>
      createAgentSdkSessionExecutor({
        model,
        ...(opts.live === undefined ? {} : { live: opts.live }),
        ...(opts.maxToolCalls === undefined ? {} : { maxToolCalls: opts.maxToolCalls }),
        ...(opts.childTimeoutMs === undefined ? {} : { childTimeoutMs: opts.childTimeoutMs }),
        ...(opts.reportsDir === undefined ? {} : { reportsDir: opts.reportsDir }),
        ...(opts.onLiveExecution === undefined ? {} : { onLiveExecution: opts.onLiveExecution }),
        createSession: async (request) => {
          counters.sessions++;
          const workTool: ReadOnlyAgentCustomTool = {
            name: "fixture_work",
            label: "Work",
            description: "Local counter only",
            parameters: { type: "object", properties: {} },
            execute: () => {
              counters.effects++;
              return { content: [{ type: "text" as const, text: "local evidence" }] };
            },
          };
          const tools = [...(request.customTools ?? []), workTool].map((tool) => ({
            ...tool,
            execute: (...args: Parameters<typeof tool.execute>) => {
              counters.tools++;
              return tool.execute(...args);
            },
          }));
          const { session } = await sdk.createAgentSession({
            cwd: root,
            agentDir: root,
            modelRuntime: models,
            model,
            settingsManager: settings,
            resourceLoader: loader,
            sessionManager: native
              ? sdk.SessionManager.create(root, path.join(root, "sessions"))
              : sdk.SessionManager.inMemory(root),
            noTools: "all",
            tools: tools.map((tool) => tool.name),
            customTools: tools as unknown as NonNullable<sdk.CreateAgentSessionOptions["customTools"]>,
          });
          const priorRaw = session.agent.onProviderStreamEvent;
          session.agent.onProviderStreamEvent = async (event, model) => {
            counters.raw++;
            await priorRaw?.(event, model);
          };
          session.agent.prepareRequest = () => {
            counters.priorPrepare++;
          };
          session.agent.finishTurn = () => {
            counters.priorFinish++;
          };
          const prompt = session.prompt.bind(session);
          session.prompt = async (...args) => {
            counters.prompts++;
            await prompt(...args);
            if (native) {
              messages = structuredClone(session.messages);
              const file = session.sessionManager.getSessionFile();
              if (file !== undefined)
                persisted = readFileSync(file, "utf8")
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line));
            }
          };
          tweak?.(session);
          return { session: session as unknown as SdkAgentSessionLike, hostVersion: sdk.VERSION };
        },
      }),
  });
  const runtime = createWorkflowRuntime({
    runId,
    replay: createWorkflowReplayController({ runDir }),
    artifactPorts: failEvidence
      ? {
          ...store,
          recordAgentEvidence() {
            throw new Error("fixture storage failed");
          },
        }
      : store,
    structuredSourceIdentity: { sha256: "a".repeat(64), covered: true, inputSha256: "c".repeat(64) },
    agentRunner: async (request) => {
      counters.physical++;
      const result = beforeAttempt?.(request) ?? (await bridge(request));
      acceptance = result.outputAcceptance;
      return result;
    },
  });
  try {
    value = await runtime.dsl.agent("Return authoritative data", options as WorkflowAgentStructuredOptions);
  } catch (caught) {
    error = caught;
  } finally {
    replayRecord = readWorkflowReplayLog(root, runId);
    rmSync(root, { recursive: true, force: true });
    agentLiveStore.reset();
  }
  return {
    value,
    error,
    acceptance,
    counters,
    replayRecord,
    journal: runtime.getJournal(),
    payloads,
    urls,
    messages,
    persisted,
  };
}

export async function structuredCause(kind: "refusal" | "incomplete" | "unknown" | "author") {
  const events =
    kind === "refusal"
      ? rawTurn([], "completed", [{ type: "response.refusal.done" }])
      : rawTurn(
          ['{"value":null}'],
          kind === "incomplete" ? "incomplete" : kind === "unknown" ? "disconnect" : "completed",
        );
  const result = await structuredSdk(
    {
      schema: { type: "null" },
      repair: { maxAttempts: 1 },
      ...(kind === "author"
        ? {
            validate: () => {
              throw new Error("author bug");
            },
          }
        : {}),
    },
    [events],
  );
  return (
    result.error as import("../../../extensions/workflows/runtime/workflow-agent-contract.js").WorkflowAgentExecutionError
  )?.result.failureCause;
}

let serial = 0;
export function nativeTurn(raw = '{"value":"known"}', phase: unknown = "final_answer", terminal = "completed") {
  const id = ++serial;
  const item = {
    type: "message",
    id: `native_message_${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: raw, annotations: [] }],
    ...(phase === "absent" ? {} : { phase }),
  };
  return [
    { type: "response.created", response: { id: `native_response_${id}`, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: raw },
    { type: "response.output_item.done", output_index: 0, item },
    ...(terminal === "disconnect"
      ? []
      : [
          {
            type: `response.${terminal}`,
            response: {
              id: `native_response_${id}`,
              status: terminal,
              output: [item],
            },
          },
        ]),
  ];
}
