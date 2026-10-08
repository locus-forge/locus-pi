import {
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
} from "../../../extensions/workflows/runtime/workflow-journal.js";
import { zstdDecompressSync } from "node:zlib";
import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
} from "../../../extensions/workflows/runtime/workflow-replay.js";
import type { ReadOnlyAgentCustomTool } from "../../../extensions/_shared/agent-runtime/agent-read-only-policy.js";
/** Real SDK, Agent loop and Codex adapter; only fetch bytes are synthetic. Never inference. */
import * as sdk from "@earendil-works/pi-coding-agent";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { stream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentSdkSessionExecutor,
  type SdkAgentSessionLike,
} from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import {
  createWorkflowAgentRunner,
  type WorkflowAgentBridgeOptions,
} from "../../../extensions/workflows/runtime/workflow-agent-bridge.js";
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

/** Shared synthetic transport factory; source-run tests use the real runner/identity owner. */
export async function createStructuredSdkExecutor(
  root: string,
  scripted: object[][],
  tweak?: (session: sdk.AgentSession) => void,
) {
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
  const catalogModel = openaiCodexProvider().getModels()[0]!;
  if (catalogModel === undefined) throw new Error("Actual installed model catalog lacks fixture model");
  const model = { ...catalogModel };
  const payloads: unknown[] = [];
  const urls: string[] = [];
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
  models.registerProvider("openai-codex", {
    api: model.api,
    apiKey: syntheticToken,
    streamSimple: (actual, context, args) => {
      const fetch: typeof globalThis.fetch = async (url, init) => {
        urls.push(String(url));
        const body = init?.body;
        if (typeof body === "string") payloads.push(JSON.parse(body));
        else if (body instanceof Uint8Array && new Headers(init?.headers).get("content-encoding") === "zstd")
          payloads.push(JSON.parse(zstdDecompressSync(body).toString("utf8")));
        const events = scripted[counters.generations++] ?? rawTurn([]);
        return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      };
      return stream(actual as Parameters<typeof stream>[0], context, {
        ...args,
        transport: "sse",
        maxRetries: 0,
        fetch,
      });
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
  const createExecutor: NonNullable<WorkflowAgentBridgeOptions["createExecutor"]> = (opts) =>
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
          sessionManager: sdk.SessionManager.inMemory(root),
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
        };
        tweak?.(session);
        return { session: session as unknown as SdkAgentSessionLike, hostVersion: sdk.VERSION };
      },
    });
  return { counters, createExecutor, payloads, urls };
}

export async function structuredSdk(
  options: WorkflowAgentStructuredOptions | WorkflowAgentAnyOptions,
  scripted: object[][],
  tweak?: (session: sdk.AgentSession) => void,
  failEvidence = false,
  beforeAttempt?: (request: WorkflowAgentRequest) => WorkflowAgentResult | undefined,
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "locus-structured-sdk-")));
  const { counters, createExecutor, payloads, urls } = await createStructuredSdkExecutor(root, scripted, tweak);
  let acceptance: AgentOutputAcceptance | undefined;
  let error: unknown;
  let value: unknown;
  let replayRecord: ReturnType<typeof readWorkflowReplayLog> = [];
  const runId = "structured-sdk";
  const runDir = path.join(root, ".locus-pi", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const harness = createHarness(root);
  const store = createWorkflowArtifactStore({ projectRoot: root, runId, runDir });
  const bridge = createWorkflowAgentRunner({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    workflowRunId: runId,
    workflowRunDir: runDir,
    evidenceDestinations: (callId) => store.childEvidenceDestinations(callId),
    createExecutor,
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
  };
}

export async function structuredCause(kind: "refusal" | "incomplete" | "unknown" | "author") {
  // Removed callback failures are historical evidence, not a live producer.
  if (kind === "author") {
    const root = mkdtempSync(path.join(tmpdir(), "locus-cause-historical-"));
    const runId = "historical-author";
    const sink = createWorkflowJournalSink(root, runId);
    sink.write({
      ts: "2026-10-06T00:00:00.000Z",
      runId,
      kind: "error",
      message: "Historical author callback failed",
      failureCause: "author-validation-error",
    });
    const state = readWorkflowRunJournalState(root, runId);
    rmSync(root, { recursive: true, force: true });
    return state.lines.find((line) => line.failureCause === "author-validation-error")?.failureCause;
  }
  const events =
    kind === "refusal"
      ? rawTurn([], "completed", [{ type: "response.refusal.done" }])
      : rawTurn(
          ['{"value":null}'],
          kind === "incomplete" ? "incomplete" : kind === "unknown" ? "disconnect" : "completed",
        );
  const result = await structuredSdk({ schema: { type: "null" } }, [events]);
  return (
    result.error as import("../../../extensions/workflows/runtime/workflow-agent-contract.js").WorkflowAgentExecutionError
  )?.result.failureCause;
}
