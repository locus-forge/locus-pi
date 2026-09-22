import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentSdkSessionExecutor,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
  type SdkCreateSessionOptionsLike,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import type { AgentExecutor } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  createWorkflowAgentPreflight,
  createWorkflowAgentRunner,
} from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  normalizeWorkflowReturnContract,
  type WorkflowReturnContract,
} from "../../../../extensions/workflows/runtime/workflow-return.js";
import { WORKFLOW_SHAPED_TRANSPORT_REFUSAL } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { transportHostsSessionTools } from "../../../../extensions/_shared/model/session-tool-transport.js";
import type { ModelLike } from "../../../../extensions/_shared/host/pi-api.js";
import { createHarness, type Harness } from "../../../test-harness.js";

/**
 * Shaped calls on a transport that cannot host session tools.
 *
 * A shaped result travels as a `workflow_return` receipt registered ON the child
 * session. The Claude Code CLI adapter shells out to the `claude` binary and
 * forwards no Pi tools at all (`piToolAllowlistForwarded: false`), so the receipt
 * can never arrive. Before this, the run paid for the whole child and only then
 * heard that its answer could not be carried back.
 *
 * The claim under test is that the refusal happens BEFORE the prompt: not "the
 * result is still a failure" but "`createSession` was never called". A plain text
 * call on the same route must keep working, because the incapacity is about shaped
 * transport and nothing else.
 */

/** The adapter's real registry shape: the api id is what names the transport. */
const CLAUDE_CLI: ModelLike = {
  provider: "claude-code",
  id: "sonnet",
  name: "Claude Code CLI Sonnet",
  api: "claude-code-cli",
};
/** An ordinary tool-hosting route, for the contrast cases. */
const CAPABLE: ModelLike = { provider: "test", id: "fast", name: "Test Fast", api: "anthropic-messages" };

const CONTRACT: WorkflowReturnContract = normalizeWorkflowReturnContract({ choices: ["yes", "no"] });

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-shaped-transport-"));
  const dir = path.join(root, ".agents", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "bare.md"),
    "---\nname: bare\ndescription: Agent with no model line\n---\nWork.\n",
    "utf8",
  );
  return root;
}

function harness(): Harness {
  const h = createHarness(project(), { sessionId: "shaped-transport-parent", models: [CLAUDE_CLI, CAPABLE] });
  h.ctx.model = CAPABLE;
  return h;
}

interface Probe {
  createExecutor: (o: { model?: unknown }) => AgentExecutor;
  /** Every `createSession`, in order. Length 0 is the proof that nothing was spent. */
  captured: SdkCreateSessionOptionsLike[];
}

function sdkProbe(answer = "plain answer"): Probe {
  const captured: SdkCreateSessionOptionsLike[] = [];
  const reportsDir = mkdtempSync(path.join(tmpdir(), "locus-shaped-transport-reports-"));
  const createExecutor = (o: { model?: unknown }): AgentExecutor =>
    createAgentSdkSessionExecutor({
      ...(o.model !== undefined ? { model: o.model } : {}),
      createSession: async (options) => {
        captured.push(options);
        return { session: fakeSession(answer, options) };
      },
      reportsDir,
      now: () => "fixed",
    });
  return { createExecutor, captured };
}

/** A host that CAN host session tools, so any refusal here is the bridge's, not the host's. */
function fakeSession(
  answer: string,
  options?: { customTools?: Array<{ name: string; execute: (...args: never[]) => unknown }> },
): SdkAgentSessionLike {
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-shaped-transport-export-"));
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  let activeTools = (options?.customTools ?? []).map((tool) => tool.name);
  return {
    sessionId: "shaped-transport-child",
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    getActiveToolNames() {
      return [...activeTools];
    },
    setActiveToolsByName(names: string[]) {
      activeTools = [...names];
    },
    async prompt() {
      listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return { sessionId: "shaped-transport-child", toolCalls: 0, toolResults: 0 };
    },
    getLastAssistantText() {
      return answer;
    },
    exportToJsonl(outputPath) {
      const target = outputPath ?? path.join(exportDir, "session.jsonl");
      writeFileSync(target, "{}\n", "utf8");
      return target;
    },
    dispose() {},
  };
}

describe("transport session-tool capability", () => {
  it("reads the declared flag first and otherwise keys on the api id", () => {
    expect(transportHostsSessionTools(CLAUDE_CLI)).toBe(false);
    expect(transportHostsSessionTools(CAPABLE)).toBe(true);
    // Unknown routes fail OPEN: the host's own pre-prompt refusal stays the backstop.
    expect(transportHostsSessionTools({ provider: "who", id: "knows" })).toBe(true);
    expect(transportHostsSessionTools(undefined)).toBe(true);
    // An explicit declaration on the record overrides the ledger in both directions.
    expect(transportHostsSessionTools({ ...CLAUDE_CLI, hostsSessionTools: true })).toBe(true);
    expect(transportHostsSessionTools({ ...CAPABLE, hostsSessionTools: false })).toBe(false);
  });
});

describe("shaped call on a transport that cannot host session tools", () => {
  it("refuses with output-contract-unavailable before any child session exists", async () => {
    const h = harness();
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({
      prompt: "decide",
      agent: "bare",
      model: "claude-code/sonnet",
      returnContract: CONTRACT,
    });

    expect(result).toMatchObject({ ok: false, status: "failed", failureCause: "output-contract-unavailable" });
    expect(result.summary).toBe(WORKFLOW_SHAPED_TRANSPORT_REFUSAL);
    // The whole point: nothing was prompted, so nothing was paid for.
    expect(probe.captured).toHaveLength(0);
  });

  it("still runs a plain text call on the same transport", async () => {
    const h = harness();
    const probe = sdkProbe("cli answer");
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "summarize", agent: "bare", model: "claude-code/sonnet" });

    expect(result).toMatchObject({ ok: true, status: "completed", text: "cli answer" });
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(CLAUDE_CLI);
  });

  it("lets a shaped call through on a transport that does host session tools", async () => {
    const h = harness();
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({
      prompt: "decide",
      agent: "bare",
      model: "test/fast",
      returnContract: CONTRACT,
    });

    // It is NOT refused by the bridge — this fake child never submits a receipt, so the
    // host's own acceptance path owns whatever happens next; a child was started.
    expect(result.failureCause).not.toBe("output-contract-unavailable");
    expect(probe.captured).toHaveLength(1);
  });
});

describe("composition preflight", () => {
  it("refuses a shaped judge on the incapable transport before any member runs", async () => {
    const h = harness();
    const preflight = createWorkflowAgentPreflight({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
    });

    await expect(
      preflight([{ model: "test/fast" }, { model: "claude-code/sonnet", expectsShapedResult: true }]),
    ).rejects.toThrow(WORKFLOW_SHAPED_TRANSPORT_REFUSAL);
  });

  it("accepts the same transport as an unshaped panel member", async () => {
    const h = harness();
    const preflight = createWorkflowAgentPreflight({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
    });

    await expect(preflight([{ model: "claude-code/sonnet" }, { model: "test/fast" }])).resolves.toBeUndefined();
  });
});
