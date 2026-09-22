import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSdkSessionExecutor,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
  type SdkCreateSessionOptionsLike,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";
import type { AgentExecutor } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { createWorkflowAgentRunner } from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
  readWorkflowRunSummary,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  resetWorkflowLiveExecutions,
  workflowAgentLiveRowId,
} from "../../../../extensions/workflows/runtime/workflow-live.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentResult,
  type WorkflowJournalLine,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import type { ModelLike, ThinkingLevel } from "../../../../extensions/_shared/host/pi-api.js";
import { createHarness, type Harness } from "../../../test-harness.js";
import { restoreGlobalModelRolesHome, writeGlobalModelRoles } from "../../../model-roles-fixture.js";

/**
 * Model tiers, end to end.
 *
 * The claim under test is narrow and was false before T-129: the model a stage
 * declares is the model the child session is created with, and every refusal names
 * what it refused. Everything here is deterministic — the SDK factory is injected,
 * so `createSession` is observed by value rather than believed.
 *
 * A real Pi peer honoring the model remains live-run evidence.
 *
 * ROUTING only. The selector grammar and the host registry lookup this suite stands
 * on belong to the shared resolver and are proven in
 * `tests/shared/model/workflow-model-resolve.test.ts`; what is decided here is which
 * declaration wins, what a refusal says, and what the run evidence records.
 */

const FAST: ModelLike = { provider: "test", id: "fast", name: "Test Fast" };
const STRONG: ModelLike = { provider: "test", id: "strong", name: "Test Strong" };
afterEach(() => {
  resetWorkflowLiveExecutions();
  agentLiveStore.reset();
  restoreGlobalModelRolesHome();
});

/** The shape the post-child validator cases hand the runtime, so `validate` is reached at all. */
const COUNT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["count"],
  properties: { count: { type: "integer" } },
} as const;

/**
 * A project that owns every agent it names.
 *
 * Discovery is project → user → bundled, so a root without `.agents/agents/` reads
 * the developer's home catalog and these assertions would depend on their machine.
 */
function tieredProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-"));
  const dir = path.join(root, ".agents", "agents");
  mkdirSync(dir, { recursive: true });
  const agents: Array<[string, string]> = [
    ["default", "---\nname: default\ndescription: General purpose agent\nmodel: task\n---\nDo the work.\n"],
    ["roled", "---\nname: roled\ndescription: Agent on a role tier\nmodel: smol\n---\nWork cheaply.\n"],
    ["pinned", "---\nname: pinned\ndescription: Agent pinned to one model\nmodel: test/strong\n---\nWork.\n"],
    ["bare", "---\nname: bare\ndescription: Agent with no model line\n---\nWork.\n"],
    ["stale", "---\nname: stale\ndescription: Agent on the pre-tier namespace\nmodel: pi/smol\n---\nWork.\n"],
    // The half of `pi/<x>` that is NOT package history: an operator naming a
    // provider this host does not have. It must keep failing closed.
    ["ghost", "---\nname: ghost\ndescription: Agent on an absent provider\nmodel: pi/gpt-5\n---\nWork.\n"],
  ];
  for (const [name, body] of agents) writeFileSync(path.join(dir, `${name}.md`), body, "utf8");
  return root;
}

type ExecutorOptions = Parameters<NonNullable<Parameters<typeof createWorkflowAgentRunner>[0]["createExecutor"]>>[0];

interface SdkProbe {
  createExecutor: (o: ExecutorOptions) => AgentExecutor;
  /** Every `createSession` call, in order. Length 0 proves no child was ever spawned. */
  captured: SdkCreateSessionOptionsLike[];
}

/**
 * The bridge's own executor factory, with only the SDK boundary faked.
 *
 * `createAgentSdkSessionExecutor` is the real one, so a passing assertion covers the
 * whole path bridge → boundary → executor → `createSession`, not just the bridge's
 * intention. `readsBackThinking: false` is a peer whose session names no effort.
 */
function sdkProbe(sessionModel?: unknown, answer = "tier answer", readsBackThinking = true): SdkProbe {
  const captured: SdkCreateSessionOptionsLike[] = [];
  const reportsDir = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-reports-"));
  const createExecutor = (o: ExecutorOptions): AgentExecutor =>
    createAgentSdkSessionExecutor({
      ...(o.model !== undefined ? { model: o.model } : {}),
      ...(o.thinkingLevel !== undefined ? { thinkingLevel: o.thinkingLevel } : {}),
      ...(o.live !== undefined ? { live: o.live } : {}),
      createSession: async (options) => {
        captured.push(options);
        const thinking = readsBackThinking ? options.thinkingLevel : undefined;
        return { session: fakeSession(sessionModel, answer, thinking, options) };
      },
      reportsDir,
      now: () => "fixed",
    });
  return { createExecutor, captured };
}

/**
 * A child session on a host that CAN carry a shaped result: it registers the custom tools
 * it was given, reports its active tool set back, and — when a `workflow_return` tool is
 * present — submits the scripted answer through it, the way a real child would. Without
 * that readback the host refuses every shaped call by capability, which is a different
 * test from the ones here.
 */
function fakeSession(
  model: unknown,
  answer = "tier answer",
  thinkingLevel?: ThinkingLevel,
  options?: { customTools?: Array<{ name: string; execute: (...args: never[]) => unknown }> },
): SdkAgentSessionLike {
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-export-"));
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  const returnTool = options?.customTools?.find((tool) => tool.name === "workflow_return");
  let activeTools = (options?.customTools ?? []).map((tool) => tool.name);
  return {
    sessionId: "tier-child",
    // Absent on purpose when the caller passes nothing: an older peer or a
    // structural mock exposes no model, and that must record as `unavailable`.
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
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
      if (returnTool !== undefined) {
        let value: unknown = answer;
        try {
          value = JSON.parse(answer);
        } catch {
          // A non-JSON scripted answer is submitted verbatim, as a child would.
        }
        (returnTool.execute as (id: string, input: unknown, signal: AbortSignal) => unknown)(
          "tool-call-1",
          { value },
          new AbortController().signal,
        );
      }
      listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return { sessionId: "tier-child", toolCalls: 1, toolResults: 1 };
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

/** Every `locus.agent.run-result.v2` body written under a project root, read off disk. */
function runResultArtifacts(projectRoot: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.startsWith("agent-run-") && entry.name.endsWith(".json")) {
        const envelope = JSON.parse(readFileSync(next, "utf8")) as { content?: string };
        if (envelope.content !== undefined) found.push(JSON.parse(envelope.content) as Record<string, unknown>);
      }
    }
  };
  try {
    walk(path.join(projectRoot, ".locus", "runtime", "artifacts"));
  } catch {
    return [];
  }
  return found;
}

async function harnessWithRoles(roles?: Record<string, string>): Promise<Harness> {
  const root = tieredProject();
  writeGlobalModelRoles(root, roles ?? {});
  const h = createHarness(root, { sessionId: "tier-parent" });
  h.ctx.model = STRONG;
  return h;
}

// ---------------------------------------------------------------------------
// W2 / W3 / W12 — the resolved tier reaches the child session
// ---------------------------------------------------------------------------

describe("the declared tier reaches the child session", () => {
  it("creates the child session with the model a modelRole resolves to", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "cheap work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("completed");
    // The parent session runs `test/strong`, so inheritance cannot pass this.
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(FAST);
    expect(h.ctx.model).toEqual(STRONG);
  });

  it("resolves a tier suffix and applies its reasoning effort to the child session", async () => {
    // The two grammars have to agree. `provider/id:high` names a model at a level;
    // `smol:high` names the SAME tier at a level. Looking the whole token up as a
    // role name finds nothing, and a role that resolves to nothing degrades to the
    // parent — so the author who spelled out the cheap tier would silently get the
    // expensive one. The level must reach createSession as real reasoning effort.
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "cheap work", agent: "bare", modelRole: "smol:high" });

    expect(result.status).toBe("completed");
    // By value: the parent is `test/strong`, so inheritance cannot satisfy this.
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(FAST);
    expect(probe.captured[0]?.thinkingLevel).toBe("high");
    // And it resolved rather than degraded — a degradation would have recorded one.
    expect(result.modelRoleFallback).toBeUndefined();
  });

  it("runs an assigned strict role and records the fail-closed declaration on agent_start", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const runId = "strict-role-assigned";
    const projectRoot = h.ctx.session!.projectRoot!;
    const { dsl } = createWorkflowRuntime({
      runId,
      agentRunner: runner,
      journal: createWorkflowJournalSink(projectRoot, runId),
    });

    await expect(dsl.agent("strict work", { modelRole: "smol:high", requireModelRole: true })).resolves.toBe(
      "tier answer",
    );

    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(FAST);
    expect(
      readWorkflowRunJournalState(projectRoot, runId).lines.find((line) => line.kind === "agent_start"),
    ).toMatchObject({
      modelRole: "smol:high",
      requireModelRole: true,
    });
  });

  it("refuses a concrete model that would bypass an otherwise strict role", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({
      prompt: "strict work",
      agent: "bare",
      model: "test/strong",
      modelRole: "smol:high",
      requireModelRole: true,
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("cannot be combined with a concrete model");
    expect(probe.captured).toHaveLength(0);
  });

  it("lets a per-call model outrank the agent's frontmatter tier", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    // `roled` declares `model: smol` (→ test/fast); the call pins test/strong.
    const result = await runner({ prompt: "pin it", agent: "roled", model: "test/strong" });

    expect(result.status).toBe("completed");
    expect(probe.captured[0]?.model).toEqual(STRONG);
  });

  it("applies a concrete selector's reasoning effort to the child session", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({
      prompt: "pin it",
      agent: "roled",
      model: "test/strong:medium",
    });

    expect(result.status).toBe("completed");
    expect(probe.captured[0]).toMatchObject({ model: STRONG, thinkingLevel: "medium" });
  });

  it("routes an agent's own frontmatter role when the call declares nothing", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("completed");
    expect(probe.captured[0]?.model).toEqual(FAST);
  });

  it("routes a model-less agent through AGENT instead of the current session model", async () => {
    const h = await harnessWithRoles({ agent: "test/fast", task: "test/strong", default: "test/strong" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare" });

    expect(result.status).toBe("completed");
    expect(probe.captured[0]?.model).toEqual(FAST);
  });

  it("inherits CURRENT when AGENT is unset, ignoring TASK and DEFAULT routes", async () => {
    const h = await harnessWithRoles({ task: "test/fast", default: "test/fast" });
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare" });

    expect(result.status).toBe("completed");
    expect(result.modelRoleFallback).toBeUndefined();
    expect(probe.captured[0]?.model).toEqual(STRONG);
  });

  it("inherits the parent reasoning effort instead of falling through to the host default", async () => {
    // The user's global/default route is deliberately low, while this live parent
    // session is medium. A model-less agent declared no override, so both model and
    // effort must inherit from the live parent as one contract.
    const h = await harnessWithRoles({ default: "test/fast:low" });
    h.pi.setThinkingLevel?.("medium");
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "thinking-inherit", agentRunner: runner });

    await expect(dsl.agent("work", { agent: "bare" })).resolves.toBe("tier answer");

    expect(probe.captured[0]).toMatchObject({ model: STRONG, thinkingLevel: "medium" });
    expect(getJournal().find((line) => line.kind === "agent_end")?.thinking).toBe("medium");
  });

  it("keeps an explicit role reasoning override above the parent and journals the host readback", async () => {
    const h = await harnessWithRoles({ smol: "test/fast:high" });
    h.pi.setThinkingLevel?.("medium");
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "thinking-role", agentRunner: runner });

    await expect(dsl.agent("work", { agent: "bare", modelRole: "smol" })).resolves.toBe("tier answer");

    expect(probe.captured[0]).toMatchObject({ model: FAST, thinkingLevel: "high" });
    expect(getJournal().find((line) => line.kind === "agent_end")?.thinking).toBe("high");
  });

  it("resolves a declared role WITHOUT the purpose fallback chain", async () => {
    // Purpose resolution may choose a purpose-owned route. An author who wrote
    // `modelRole: "smol"` asked about `smol`; answering with `agent` would run a
    // different model under the requested tier's name.
    const h = await harnessWithRoles({ agent: "test/fast", task: "test/fast", default: "test/fast" });
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("completed");
    // Other roles resolve to test/fast; `smol` does not resolve at all, so the child
    // must inherit the session model rather than borrow theirs.
    expect(probe.captured[0]?.model).toEqual(STRONG);
    expect(result.modelRoleFallback).toContain('"smol"');
  });
});

// ---------------------------------------------------------------------------
// W2 — a concrete selector that does not resolve ends the call, with no child
// ---------------------------------------------------------------------------

describe("an unresolvable concrete selector fails the call", () => {
  it("refuses a per-call model and spawns nothing", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({
      prompt: "work",
      agent: "bare",
      model: "no-such-provider/no-such-model",
    });

    expect(result.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join("\n")).toContain('"no-such-provider/no-such-model"');
    expect(probe.captured).toHaveLength(0);
    // The SUMMARY has to carry the whole reason, not a headline. A live run showed
    // `diagnostics` never reaches `agent_end` or the result envelope, so a refusal
    // whose actionable half lives only there leaves the operator with a quoted
    // selector and no next step.
    expect(result.summary).toContain('provider "no-such-provider" has no model "no-such-model"');
  });

  it("refuses a role whose assignment names a model this host does not have", async () => {
    const h = await harnessWithRoles({ smol: "no-such-provider/no-such-model" });
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("failed");
    const diagnostic = result.diagnostics.join("\n");
    // Both halves, because either alone leaves the operator guessing which to edit.
    expect(diagnostic).toContain('"smol"');
    expect(diagnostic).toContain('"no-such-provider/no-such-model"');
    expect(probe.captured).toHaveLength(0);
  });

  it("refuses a MALFORMED role assignment instead of reading it as unassigned", async () => {
    // Round-2 finding 1. `parseModelSelector` drops any value without a "/", so a
    // typo'd assignment used to arrive at the bridge indistinguishable from a role
    // nobody assigned — and OD5 degrades an unassigned role. The operator therefore
    // got the parent's model under the name `smol`, plus a note claiming the role was
    // "not assigned in the global model-roles config" that their own file contradicts.
    // A typo is OD5's fail-closed case.
    const h = await harnessWithRoles({ smol: "deepseek-v4-flash" });
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("failed");
    const diagnostic = result.diagnostics.join("\n");
    expect(diagnostic).toContain('"smol"');
    // The value as written and the layer that carried it — the two facts needed to fix it.
    expect(diagnostic).toContain('"deepseek-v4-flash"');
    expect(diagnostic).toContain("global model-roles config");
    // And it must NOT be described as unassigned, which is the false statement.
    expect(diagnostic).not.toContain("is not assigned in the global model-roles config");
    expect(probe.captured).toHaveLength(0);
  });

  it("refuses a malformed assignment behind an agent's frontmatter tier too", async () => {
    // The frontmatter path is the softer one by D3b, but D3b softens an UNASSIGNED
    // role so a stock install works — not a broken roles file, which only this
    // machine's own config can produce.
    const h = await harnessWithRoles({ smol: "deepseek-v4-flash" });
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    // `roled` declares `model: smol` in its frontmatter and the call declares nothing.
    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("failed");
    expect(result.diagnostics.join("\n")).toContain('"deepseek-v4-flash"');
    expect(probe.captured).toHaveLength(0);
  });

  it("refuses pi/<not-a-role> — an absent provider is not package history", async () => {
    // The prefix alone does not buy the repair. `gpt-5` names no role in the table,
    // so the only reading left is "provider pi, model gpt-5", which this host cannot
    // run: refuse by name rather than invent a tier the author never wrote.
    const h = await harnessWithRoles();
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "ghost" });

    expect(result.status).toBe("failed");
    const diagnostic = result.diagnostics.join("\n");
    expect(diagnostic).toContain('"pi/gpt-5"');
    // Still the migration hint, because that IS the likely mistake — it just cannot
    // be applied for the author when the token names no role.
    expect(diagnostic).toContain("pre-tier role namespace");
    expect(probe.captured).toHaveLength(0);
  });

  it("refuses a per-call pi/<role> model, which is code written against today's grammar", async () => {
    // The frontmatter repair below is for a catalog this package shipped. A script
    // author typing `model: "pi/smol"` now is writing new code, and silently reading
    // it as a role would teach the dead spelling instead of the live one.
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "default", model: "pi/smol" });

    expect(result.status).toBe("failed");
    expect(result.diagnostics.join("\n")).toContain('modelRole: "smol"');
    expect(probe.captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The pre-tier `pi/<role>` namespace in agent FRONTMATTER is read as the role
// ---------------------------------------------------------------------------

describe("a frontmatter tier in the pre-tier pi/<role> namespace", () => {
  it("degrades to the session model instead of failing a stale catalog closed", async () => {
    // The upgrade case an operator actually hits: a `~/.agents/agents/` or vendored
    // project catalog copied from a release that wrote `pi/<role>`. Refusing it
    // fails EVERY workflow step before a child exists, which breaks the same promise
    // D3b makes for an unassigned role — and the operator never wrote the spelling.
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "stale" });

    expect(result.status).toBe("completed");
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(STRONG);
    // Degraded like any unassigned role — and the note carries the extra sentence,
    // because this is now the only place the operator learns the catalog is stale.
    expect(result.modelRoleFallback).toContain("inherited the parent session model");
    expect(result.modelRoleFallback).toContain('"pi/smol"');
    expect(result.modelRoleFallback).toContain("`model: smol`");
  });

  it("executes the role's assignment when the roles table has one", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "stale" });

    expect(result.status).toBe("completed");
    expect(probe.captured[0]?.model).toEqual(FAST);
    // Resolved, not degraded: the repair routes through the roles table like any
    // bare tier, so an assignment reaches `createSession` unchanged.
    expect(result.modelRoleFallback).toBeUndefined();
  });

  it("keeps the author's thinking level across the namespace repair", async () => {
    const root = tieredProject();
    writeFileSync(
      path.join(root, ".agents", "agents", "stale.md"),
      "---\nname: stale\ndescription: Pre-tier tier with a level\nmodel: pi/smol:high\n---\nWork.\n",
      "utf8",
    );
    const h = createHarness(root, { sessionId: "tier-parent" });
    h.ctx.model = STRONG;
    writeGlobalModelRoles(root, { smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "stale" });

    expect(result.status).toBe("completed");
    expect(probe.captured[0]?.model).toEqual(FAST);
    expect(probe.captured[0]?.thinkingLevel).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// W2 — an unassigned ROLE degrades to the session model and says so out loud
// ---------------------------------------------------------------------------

describe("an unassigned role degrades and records the degradation", () => {
  it("runs the child on the session model and names the role and the layers", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("completed");
    // The child DID run — a package whose every default agent fails closed on a
    // stock install is not a shipped feature (OD5).
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(STRONG);
    expect(result.modelRoleFallback).toContain('"smol"');
    expect(result.modelRoleFallback).toContain("model-roles");
    expect(result.modelRoleFallback).toContain("session");
    expect(result.modelRoleFallback).toContain("inherited the parent session model");
    expect(result.diagnostics[0]).toBe(result.modelRoleFallback);
  });

  it("refuses an unassigned strict role before creating a child session", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({
      prompt: "strict review",
      agent: "bare",
      modelRole: "smol:xhigh",
      requireModelRole: true,
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain('modelRole "smol:xhigh" is required');
    expect(result.summary).toContain("/model-roles");
    expect(result.modelRoleFallback).toBeUndefined();
    expect(probe.captured).toHaveLength(0);
  });

  it("carries the degradation into the run-result artifact, not just the result object", async () => {
    // W7's actual claim is about `locus.agent.run-result.v2`. The result object had
    // it all along; the ARTIFACT did not, because `createAgentRunRequest` is an
    // allowlist that dropped the field on the way in. The existing artifact test
    // could not catch that: it built its request literal by hand.
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("completed");
    const bodies = runResultArtifacts(h.ctx.session!.projectRoot!);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.modelRoleFallback).toContain('"smol"');
  });

  it("records no degradation when a session was built but the child never ran", async () => {
    // Round-2 finding 2, bridge half. The degradation note is PAST TENSE ("the child
    // inherited the parent session model"). It used to be gated on a child session
    // merely EXISTING, and a session created then cancelled before kickoff has an id
    // — so a call that spent no tokens still told `agent_end` and the result envelope
    // that a child had inherited and run. Nothing ran, so nothing may say it did.
    const h = await harnessWithRoles();
    const controller = new AbortController();
    const captured: SdkCreateSessionOptionsLike[] = [];
    const reportsDir = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-reports-"));
    const createExecutor = (o: { model?: unknown }): AgentExecutor =>
      createAgentSdkSessionExecutor({
        ...(o.model !== undefined ? { model: o.model } : {}),
        createSession: async (options) => {
          captured.push(options);
          // Abort while the session is being built: real session, no child turn.
          controller.abort();
          return { session: fakeSession(STRONG) };
        },
        reportsDir,
        now: () => "fixed",
      });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: controller.signal,
      createExecutor,
    });

    // `roled` declares `model: smol`, nothing assigns `smol` — the degrade path.
    const result = await runner({ prompt: "work", agent: "roled" });

    // The session was genuinely built, which is what makes this the tricky case.
    expect(captured).toHaveLength(1);
    expect(result.status).not.toBe("completed");
    expect(result.modelRoleFallback).toBeUndefined();
    expect(result.diagnostics.join("\n")).not.toContain("inherited the parent session model");
  });

  it("records no degradation when the per-call timeout fires before the child is prompted", async () => {
    // The same rule on the OTHER exit. The bridge returns early when its per-call
    // fuse fires (`timedOut`), and that return built its own result object — so the
    // gate that keeps the past-tense note off a call that never ran had to hold
    // there too, not only on the settled path. A timeout during session setup is
    // exactly the shape that reaches it.
    const h = await harnessWithRoles();
    const captured: SdkCreateSessionOptionsLike[] = [];
    const reportsDir = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-reports-"));
    const createExecutor = (o: { model?: unknown }): AgentExecutor =>
      createAgentSdkSessionExecutor({
        ...(o.model !== undefined ? { model: o.model } : {}),
        createSession: async (options) => {
          captured.push(options);
          // Ordered, not raced: the fuse timer is armed before this executor is
          // ever entered, so its 1 ms expiry always precedes this 50 ms one.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { session: fakeSession(STRONG) };
        },
        reportsDir,
        now: () => "fixed",
      });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor,
    });

    // `roled` declares `model: smol`, nothing assigns `smol` — the degrade path.
    const result = await runner({ prompt: "work", agent: "roled", timeoutMs: 1 });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("timeout");
    expect(result.executedModel).toBeUndefined();
    expect(result.modelRoleFallback).toBeUndefined();
    expect(result.diagnostics.join("\n")).not.toContain("inherited the parent session model");
  });

  it("does not let a declared frontmatter role fall through to another assigned tier", async () => {
    // The regression this closes: `resolveAgentModelPreference` used to answer a
    // bare frontmatter role through purpose resolution. So `roled` (frontmatter
    // `model: smol`) with `smol` UNASSIGNED but `task` assigned would run the
    // `task` tier — a different model under the requested tier's name, which is the
    // silent substitution D3a exists to stop and which no evidence surface would
    // have explained.
    const h = await harnessWithRoles({ task: "test/fast", agent: "test/fast", default: "test/fast" });
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("completed");
    // The session model, NOT `test/fast` — the assigned fallback roles are visible
    // to the chain and must not be reachable from a declared role.
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(STRONG);
    expect(result.modelRoleFallback).toContain('"smol"');
  });

  it("refuses a slash-bearing modelRole instead of degrading to the session model", async () => {
    // OD1's grammar: a "/" means a concrete provider/id. `modelRole` only ever names
    // a role (D4), so a slash-bearing value is a category error, not an unassigned
    // role — and degrading it would silently run something other than the model the
    // author spelled out, which is the fail-closed case OD5 keeps loud.
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare", modelRole: "test/fast" });

    expect(result.status).toBe("failed");
    expect(result.failureCause).toBe("unclassified");
    expect(result.summary).toContain("test/fast");
    expect(result.summary).toContain("modelRole");
    // The actionable half: which option to use instead.
    expect(result.summary).toContain("model:");
    // Zero child sessions — the refusal lands before anything is spawned.
    expect(probe.captured).toHaveLength(0);
  });

  it("says nothing about tiers when the agent declared none", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare" });

    expect(result.status).toBe("completed");
    expect(result.modelRoleFallback).toBeUndefined();
    expect(probe.captured[0]?.model).toEqual(STRONG);
  });
});

// ---------------------------------------------------------------------------
// W5 / W6 / W12 — the executed model is READ BACK, and the journal says which
// value is which
// ---------------------------------------------------------------------------

describe("executed-model evidence", () => {
  it("records the host readback on agent_end and the request on agent_start", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-journal", agentRunner: runner });

    await expect(dsl.agent("cheap work", { agent: "bare", modelRole: "smol" })).resolves.toBe("tier answer");

    const journal: readonly WorkflowJournalLine[] = getJournal();
    const start = journal.find((line) => line.kind === "agent_start");
    const end = journal.find((line) => line.kind === "agent_end");
    // agent_start is emitted before the bridge resolves anything, so it can only
    // carry intent — and it says so by name.
    expect(start?.modelRole).toBe("smol");
    expect(start?.executedModel).toBeUndefined();
    expect(end?.executedModel).toBe("test/fast");
  });

  it("round-trips requested, role, executed, and fallback model evidence through the persisted reader", async () => {
    const root = tieredProject();
    writeGlobalModelRoles(root, {});
    const h = createHarness(root, { sessionId: "tier-persisted-journal" });
    h.ctx.model = STRONG;
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const runId = "tier-persisted-journal";
    const { dsl } = createWorkflowRuntime({
      runId,
      agentRunner: runner,
      journal: createWorkflowJournalSink(root, runId),
    });

    await expect(dsl.agent("work", { agent: "bare", modelRole: "smol" })).resolves.toBe("tier answer");
    await expect(dsl.agent("pinned work", { agent: "bare", model: "test/strong" })).resolves.toBe("tier answer");

    const persisted = readWorkflowRunJournalState(root, runId);
    expect(persisted.diagnostics).toEqual([]);
    const starts = persisted.lines.filter((line) => line.kind === "agent_start");
    const end = persisted.lines.find((line) => line.kind === "agent_end");
    expect(starts[0]?.modelRole).toBe("smol");
    expect(starts[1]?.requestedModel).toBe("test/strong");
    expect(end?.executedModel).toBe("test/strong");
    expect(end?.modelRoleFallback).toContain('"smol"');
  });

  it("carries the requested selector under a name that says requested", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-requested", agentRunner: runner });

    await dsl.agent("work", { agent: "bare", model: "test/strong" });

    const start = getJournal().find((line) => line.kind === "agent_start");
    expect(start?.requestedModel).toBe("test/strong");
    expect(start?.executedModel).toBeUndefined();
  });

  it("records `unavailable` when the peer exposes no model, never the request", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(); // structural mock: no `model` on the session
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-unavailable", agentRunner: runner });

    await dsl.agent("cheap work", { agent: "bare", modelRole: "smol" });

    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.executedModel).toBe("unavailable");
    expect(end?.executedModel).not.toBe("test/fast");
    expect(end?.model).toBeUndefined();
  });

  it("does not substitute requested thinking when the child exposes no thinking readback", async () => {
    const h = await harnessWithRoles();
    h.pi.setThinkingLevel?.("medium");
    const probe = sdkProbe(FAST, "tier answer", false);
    const runId = "thinking-unavailable";
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
      workflowRunId: runId,
    });
    // Projected line by line as the workflow tool does, so the executor row sits under its anchor.
    const onEvent = (line: WorkflowJournalLine) => applyWorkflowJournalLineToAgentLiveStore(line);
    const { dsl, getJournal } = createWorkflowRuntime({ runId, agentRunner: runner, onEvent });

    await expect(dsl.agent("work", { agent: "bare", model: "test/fast:high" })).resolves.toBe("tier answer");

    expect(probe.captured[0]?.thinkingLevel).toBe("high");
    const start = getJournal().find((line) => line.kind === "agent_start")!;
    expect(start.thinking).toBe("high"); // the request, seeded onto the anchor
    expect(getJournal().find((line) => line.kind === "agent_end")?.thinking).toBeUndefined();
    const anchor = agentLiveStore.rows.get(workflowAgentLiveRowId(start));
    expect(anchor).toMatchObject({ status: "done", model: "test/fast" });
    expect(anchor?.thinking).toBeUndefined();
    // The anchor is a real parent: the SDK host's executor row ran under it.
    expect([...agentLiveStore.rows.values()].some((row) => row.parentRowId === anchor?.id)).toBe(true);
  });

  it("records the degradation on agent_end so a reader sees the quiet fallback", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-fallback", agentRunner: runner });

    await dsl.agent("work", { agent: "bare", modelRole: "smol" });

    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.modelRoleFallback).toContain('"smol"');
    expect(end?.executedModel).toBe("test/strong");
  });

  /**
   * The mirror of every rule above.
   *
   * Those cases stop a REQUEST being published as a result. These two stop a real
   * RESULT being thrown away: a script `validate` callback or the artifact writer can
   * fail after the child has already answered, and the runtime ends such a call with an
   * `error` line rather than an `agent_end`. If that line carries no `executedModel`,
   * every read side keyed on it — the live row here, the reader's report — concludes no
   * child ran, and the one call that provably DID execute is the one whose evidence
   * disappears. Both assert the journal line AND the row the operator actually watches,
   * because the defect needed both halves to be visible.
   */
  it("keeps the readback on the error line when a script validator throws after the child ran", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(FAST, '{"count":3}', false);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
      workflowRunId: "tier-validator-threw",
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-validator-threw", agentRunner: runner });

    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("cheap work", {
        agent: "bare",
        model: "test/fast:high",
        schema: COUNT_SCHEMA,
        validate: () => {
          throw new Error("validator exploded after the child had already answered");
        },
      }),
    ).rejects.toThrow(/validator exploded/);

    const journal: readonly WorkflowJournalLine[] = getJournal();
    const failure = journal.find((line) => line.kind === "error");
    expect(probe.captured).toHaveLength(1); // the child really ran
    expect(failure?.source).toBe("script");
    expect(failure?.executedModel).toBe("test/fast");

    for (const line of journal) applyWorkflowJournalLineToAgentLiveStore(line);
    const start = journal.find((line) => line.kind === "agent_start")!;
    const row = agentLiveStore.rows.get(workflowAgentLiveRowId(start));
    expect(row).toMatchObject({ status: "error", model: "test/fast" });
    expect(row?.thinking).toBeUndefined(); // the requested `high` was never read back
    expect([...agentLiveStore.rows.values()].some((child) => child.parentRowId === row?.id)).toBe(true);
  });

  it("round-trips usage on the sole error line when a validator throws after execution", async () => {
    const root = tieredProject();
    const runId = "tier-validator-usage";
    const { dsl } = createWorkflowRuntime({
      runId,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: async (request): Promise<WorkflowAgentResult> => ({
        ok: true,
        status: "completed",
        summary: "done",
        text: '{"count":3}',
        diagnostics: [],
        agent: request.agent,
        executedModel: "test/fast",
        usage: { input: 20, output: 10, totalTokens: 30, costTotal: 0 },
        ...(request.returnContract === undefined
          ? {}
          : { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }),
      }),
    });

    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("cheap work", {
        schema: COUNT_SCHEMA,
        validate: () => {
          throw new Error("validator exploded after measured execution");
        },
      }),
    ).rejects.toThrow(/measured execution/u);

    const persisted = readWorkflowRunJournalState(root, runId);
    expect(persisted.diagnostics).toEqual([]);
    const failure = persisted.lines.find((line) => line.kind === "error");
    expect(failure?.executedModel).toBe("test/fast");
    expect(failure?.usage).toEqual({ input: 20, output: 10, totalTokens: 30, costTotal: 0 });
    expect(readWorkflowRunSummary(root, runId).usage).toEqual({
      input: 20,
      output: 10,
      totalTokens: 30,
      costTotal: 0,
    });
  });

  it("keeps the readback on the error line when the artifact writer fails after the child ran", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "tier-artifact-threw",
      agentRunner: runner,
      artifactPorts: {
        recordAgentEvidence: () => {
          throw new Error("artifact store is unwritable");
        },
        publishText: () => {
          throw new Error("unused");
        },
        consumeText: () => {
          throw new Error("unused");
        },
      },
    });

    await expect(dsl.agent("cheap work", { agent: "bare", modelRole: "smol" })).rejects.toThrow(/unwritable/);

    const failure = getJournal().find((line) => line.kind === "error");
    expect(probe.captured).toHaveLength(1);
    expect(failure?.source).toBe("runtime");
    expect(failure?.executedModel).toBe("test/fast");
  });

  /**
   * The third shape, and the quiet one: a REPLAYED call completes.
   *
   * `agent_start` publishes the requested selector by design, and a resumed run serves
   * the recorded answer without creating a child — so `agent_end` has no readback to
   * replace it with. The status is `completed`, which is the one an operator never
   * re-reads, so the request would stand as the model that ran on a call that spent
   * nothing. Driven through the real runtime rather than by feeding the reducer a
   * hand-written line, so it also proves what a replay actually emits: no child was
   * created, and no `executedModel` was invented for one.
   */
  it("leaves no model on a replayed completion, where no child ran at all", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "tier-replayed",
      agentRunner: runner,
      replay: {
        beginAgentAttempt: () => ({ replayed: true as const, text: "recorded answer" }),
        recordAgentAttempt: () => {},
        resolveValue: (_kind, produce) => produce(),
        counts: () => ({ replayedCalls: 1, freshCalls: 0 }),
      },
    });

    // A CONCRETE selector, so `agent_start` really seeds the row with a model and this
    // case can fail. A bare tier would leave the row blank from the start and the
    // assertion below would pass without the rule under test existing at all.
    await expect(dsl.agent("cheap work", { agent: "bare", model: "test/fast:high" })).resolves.toBe("recorded answer");

    const journal: readonly WorkflowJournalLine[] = getJournal();
    expect(probe.captured).toHaveLength(0); // nothing was created to run it
    const end = journal.find((line) => line.kind === "agent_end");
    expect(end?.status).toBe("completed");
    expect(end?.replayed).toBe(true);
    expect(end?.executedModel).toBeUndefined();

    const start = journal.find((line) => line.kind === "agent_start")!;
    const id = workflowAgentLiveRowId(start);
    applyWorkflowJournalLineToAgentLiveStore(start);
    expect(agentLiveStore.rows.get(id)?.model).toBe("test/fast"); // the request is on the row
    expect(agentLiveStore.rows.get(id)?.thinking).toBe("high");

    for (const line of journal.filter((l) => l.kind !== "agent_start")) {
      applyWorkflowJournalLineToAgentLiveStore(line);
    }
    const row = agentLiveStore.rows.get(id);
    expect(row?.status).toBe("done");
    expect(row?.model).toBeUndefined();
    expect(row?.thinking).toBeUndefined();
  });

  it("fails the call when the readback contradicts the resolved request", async () => {
    // The whole point of a readback: a host that quietly ignored the selection is
    // the failure this evidence exists to catch. A pre-execution value echoed back
    // could never produce this test.
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(STRONG); // asked for test/fast, session says test/strong
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "cheap work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("failed");
    const diagnostic = result.diagnostics.join("\n");
    expect(diagnostic).toContain("test/strong");
    expect(diagnostic).toContain("test/fast");
    expect(diagnostic).toContain("did not honour the selected model");
    expect(result.text).toBeUndefined();
  });
});
