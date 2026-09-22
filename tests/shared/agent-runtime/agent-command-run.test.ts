import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLivePanel } from "../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import type { SdkAgentSessionEventLike } from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import type { AgentLiveRow } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import type { ExtensionCommandContext } from "../../../extensions/_shared/host/pi-api.js";
import { createHarness, runTool, type Harness } from "../../test-harness.js";
import { restoreGlobalModelRolesHome, writeGlobalModelRoles } from "../../model-roles-fixture.js";

// T-188 W2: `/agent run` and `task`/`spawn_agent` share the live-row model.

const tempRoots: string[] = [];

/**
 * Every `locus.agent.run-result.v2` body the run wrote, read off disk.
 *
 * The artifact is written INSIDE the boundary, so it is the only place an
 * interactive run's recorded degradation can be observed — the command handler
 * returns nothing and the live row does not carry it.
 */
function readAgentRunArtifacts(projectRoot: string): Array<Record<string, unknown>> {
  const dir = path.join(projectRoot, ".locus", "runtime", "artifacts");
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
    walk(dir);
  } catch {
    return [];
  }
  return found;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  restoreGlobalModelRolesHome();
});

function projectWithReviewer(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-pi-agent-command-"));
  writeGlobalModelRoles(root, {});
  mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Project reviewer\ntools: read, search\nrisk: medium\n---\nProject.",
    "utf8",
  );
  tempRoots.push(root);
  return root;
}

/** Mock the SDK host so a headless child session completes deterministically. */
function mockSdkSession(
  sessionId: string,
  opts: { summary?: string; toolCalls?: number; toolResults?: number } = {},
): void {
  vi.doMock("@earendil-works/pi-coding-agent", () => ({
    SessionManager: { create: () => ({ kind: "isolated-test-session" }) },
    DefaultResourceLoader: class {
      constructor(_options: Record<string, unknown>) {}
      reload() {}
    },
    getAgentDir() {
      return tmpdir();
    },
    async createAgentSession() {
      let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
      return {
        session: {
          sessionId,
          subscribe(fn: (event: SdkAgentSessionEventLike) => void) {
            listener = fn;
            return () => {
              listener = undefined;
            };
          },
          async prompt() {
            listener?.({ type: "turn_start" });
            listener?.({ type: "tool_call", toolName: "read" });
            listener?.({ type: "tool_result", toolName: "read" });
            listener?.({ type: "agent_end", willRetry: false });
          },
          getSessionStats() {
            return { sessionId, toolCalls: opts.toolCalls ?? 1, toolResults: opts.toolResults ?? 1 };
          },
          getLastAssistantText() {
            return opts.summary ?? "Reviewed";
          },
          exportToJsonl(outputPath: string) {
            return outputPath;
          },
          dispose() {},
        },
      };
    },
  }));
}

// Load the agents extension AND the store from the SAME post-mock module graph so
// assertions and production code share one agentLiveStore instance.
async function loadAgents() {
  const { default: agents } = await import("../../../extensions/agents/index.js");
  const { agentLiveStore } = await import("../../../extensions/_shared/agent-runtime/agent-live-store.js");
  // The production store is intentionally process-shared across fresh jiti
  // entrypoints. Reset explicitly between isolated unit cases; resetModules no
  // longer implies a new store (that implication caused the live Pi bug).
  agentLiveStore.reset();
  return { agents, agentLiveStore };
}

function reviewerRow(store: { rows: Map<string, AgentLiveRow> }): AgentLiveRow | undefined {
  return [...store.rows.values()].find((row) => row.agentName === "reviewer");
}

function renderRow(row: AgentLiveRow): string {
  return new AgentLivePanel({}).renderRows([row], 200)[0] ?? "";
}

describe("agent command run (unified live surface)", () => {
  it("runs a single agent as a shared live row through the SDK host, not a replacement session", async () => {
    mockSdkSession("sdk-run-1", { summary: "Reviewed" });
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    h.ctx.hasUI = true;
    const commandCtx = h.ctx as ExtensionCommandContext;
    // Proof the slash path never touches the replacement-session host anymore.
    commandCtx.newSession = async () => {
      throw new Error("must not use a replacement session");
    };
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", commandCtx);

    const row = reviewerRow(agentLiveStore);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      status: "done",
      finalAnswer: "Reviewed",
      childSessionId: "sdk-run-1",
      request: "Review this",
    });
    // REQ-007 fleet stays below the editor while focus replaces only the editor.
    expect(h.widgetOptions.get("agents")).toEqual({ placement: "belowEditor" });
    expect(typeof h.widgetPayloads.get("agents")).toBe("function");
    // T-191: new fleet grammar — petname + title, no `[Working]`/`on task`/hash tail.
    const line = renderRow(row!);
    expect(line).toContain("Review this");
    expect(line).not.toContain("on task");
    expect(line).not.toContain("[Working]");
    expect(line).not.toMatch(/reviewer#\w+/);
  });

  it("suppresses the kickoff lifecycle line when begin emission synchronously replaces the execution", async () => {
    mockSdkSession("sdk-reentrant", { summary: "stale execution completed" });
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    agents(h.pi);
    let replaced = false;
    const replaceOnBegin = () => {
      if (replaced) return;
      const row = reviewerRow(agentLiveStore);
      if (row === undefined) return;
      replaced = true;
      agentLiveStore.beginExecution({
        id: row.id,
        agentName: "reviewer",
        label: "replacement execution",
      });
    };
    agentLiveStore.emitter.on("change", replaceOnBegin);
    try {
      await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);
    } finally {
      agentLiveStore.emitter.off("change", replaceOnBegin);
    }

    expect(replaced).toBe(true);
    expect(h.notifications.filter((message) => message.includes(" started"))).toEqual([]);
    expect(reviewerRow(agentLiveStore)).toMatchObject({
      status: "queued",
      label: "replacement execution",
    });
  });

  it("produces the same live row from the tool trigger and the slash trigger (Q8 parity)", async () => {
    mockSdkSession("sdk-parity", { summary: "Reviewed" });
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "test", id: "strong", name: "Strong" };
    agents(h.pi);

    // LLM tool trigger (the primary user scenario).
    await runTool(h, "spawn_agent", { agent: "reviewer", task: "Review this" });
    const toolRow = reviewerRow(agentLiveStore)!;
    const toolLine = renderRow(toolRow);
    agentLiveStore.reset();

    // Slash trigger.
    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);
    const slashRow = reviewerRow(agentLiveStore)!;
    const slashLine = renderRow(slashRow);

    expect(toolRow).toBeDefined();
    expect(slashRow).toBeDefined();
    expect(toolRow.request).toBe("Review this");
    expect(slashRow.request).toBe("Review this");
    // T-191: petname is per-instance (derived from the row id), so the two triggers
    // differ in name — parity is now on the shared title, model badge, and state.
    for (const rowLine of [toolLine, slashLine]) {
      expect(rowLine).toContain("Review this");
      expect(rowLine).toContain("strong"); // provider prefix stripped from `test/strong`
      expect(rowLine).not.toContain("on task");
      expect(rowLine).not.toContain("/effort=");
      expect(rowLine).not.toMatch(/reviewer#\w+/);
    }
    expect(slashRow.model).toBe(toolRow.model);
    expect(slashRow.status).toBe(toolRow.status);
    expect(slashRow.childSessionId).toBe(toolRow.childSessionId);
  });

  it("does not interpret JSON-looking text as a lifecycle status", async () => {
    const text = '{"status":"cancelled","summary":"Operator cancelled child"}';
    mockSdkSession("sdk-json-text", { summary: text });
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    agents(h.pi);

    const toolResult = await runTool(h, "spawn_agent", { agent: "reviewer", task: "Return JSON-looking text" });
    const toolRow = reviewerRow(agentLiveStore)!;
    expect(toolResult.isError).not.toBe(true);
    expect(toolRow).toMatchObject({ status: "done", finalAnswer: text });

    agentLiveStore.reset();
    await h.commands.get("agent")!.handler("run reviewer Return JSON-looking text", h.ctx as ExtensionCommandContext);
    const slashRow = reviewerRow(agentLiveStore)!;
    expect(slashRow).toMatchObject({ status: "done", finalAnswer: text });
  });

  it("shows an honest above-editor settled summary with units on a headless host", async () => {
    mockSdkSession("sdk-headless", { summary: "Reviewed", toolCalls: 2, toolResults: 2 });
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    // headless: no hasUI, so no live panel — summary goes below the editor.
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);

    const widget = h.widgets.get("agents") ?? "";
    expect(widget).toMatch(/Agent reviewer#\w+: completed/);
    expect(widget).toContain("childSessionId: sdk-headless");
    expect(widget).toContain("childEntries: 4 (events)");
    expect(widget).toContain("childToolCalls: 2 (tool calls)");
    expect(h.widgetOptions.get("agents")).toEqual({ placement: "aboveEditor" });
    // The row survives for `/agent drill` (W5).
    expect(reviewerRow(agentLiveStore)?.status).toBe("done");
  });

  it.each(["--yes", "--approve"])("keeps legacy %s runs without Locus prompting", async (flag) => {
    mockSdkSession("sdk-flag");
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    const confirm = vi.fn(async () => {
      throw new Error("explicit proof override must not prompt");
    });
    h.ctx.ui.confirm = confirm;
    agents(h.pi);

    await h.commands.get("agent")!.handler(`run ${flag} reviewer Review this`, h.ctx as ExtensionCommandContext);

    expect(confirm).not.toHaveBeenCalled();
    expect(reviewerRow(agentLiveStore)?.status).toBe("done");
    expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);
  });

  it("fails closed with an honest reason when the SDK host is absent (no replacement-session text)", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", () => ({}));
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);

    const widget = h.widgets.get("agents") ?? "";
    expect(widget).toContain("Agent reviewer");
    expect(widget).toMatch(/blocked|error/);
    expect(widget).not.toContain("replacement session");
    // The run still leaves a terminal, drillable row rather than vanishing.
    expect(reviewerRow(agentLiveStore)?.status).toBe("error");
  });

  it("reports unknown agents above the editor with an explicit proof flag without prompting", async () => {
    const { agents } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    const confirm = vi.fn(async () => true);
    h.ctx.ui.confirm = confirm;
    agents(h.pi);

    await h.commands.get("agent")!.handler("run --yes missing Review this", h.ctx as ExtensionCommandContext);

    expect(confirm).not.toHaveBeenCalled();
    const widget = h.widgets.get("agents") ?? "";
    expect(widget).toContain('Unknown agent: "missing".');
    expect(widget).toContain("Available agents (");
    expect(widget).toContain("reviewer [project]");
    expect(widget).toContain("Named agents come only from the project and user catalogs.");
    expect(h.widgetOptions.get("agents")).toEqual({ placement: "aboveEditor" });
  });

  it("rejects unknown run flags instead of treating them as agent names", async () => {
    const { agents } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    agents(h.pi);

    await h.commands.get("agent")!.handler("run --force reviewer Review this", h.ctx as ExtensionCommandContext);

    expect(h.notifications).toEqual([]);
    const widget = h.widgets.get("agents") ?? "";
    expect(widget).toContain("[WARN] Agent command");
    expect(widget).toContain("Unknown or incomplete /agent action: run --force reviewer Review this");
    expect(widget).toContain("No agent run, catalog mutation, or live control action was attempted.");
    expect(widget).toContain("Usage: /agent list | /agent inspect <name>");
  });

  it("task tool falls back honestly when the SDK host is absent", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", () => ({}));
    const { agents } = await loadAgents();
    const h: Harness = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    agents(h.pi);

    const taskResult = await runTool(h, "spawn_agent", { agent: "reviewer", task: "Review this" });

    // Legacy alias remains gone.
    expect(h.tools.has("runAgent")).toBe(false);
    expect(taskResult.isError).toBe(true);
    expect(taskResult.details).toMatchObject({
      requestedSurface: "spawn_agent",
      hostCapability: "agent-sdk-session-unavailable",
      toolExecutorAvailable: false,
    });
    const text = taskResult.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(text).not.toContain("replacement session");
    expect(JSON.stringify(taskResult.details)).not.toContain("M11");
  });

  it("shows an explicit task title in the live row (REQ-003, tool trigger)", async () => {
    mockSdkSession("sdk-title-tool", { summary: "Reviewed" });
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    agents(h.pi);

    await runTool(h, "spawn_agent", {
      agent: "reviewer",
      task: "Review this",
      title: "review auth middleware",
    });

    const row = reviewerRow(agentLiveStore)!;
    expect(row.title).toBe("review auth middleware");
    expect(renderRow(row)).toContain("review auth middleware");
  });

  it("accepts --title on /agent run and shows it in the live row (REQ-003, slash trigger)", async () => {
    mockSdkSession("sdk-title-slash", { summary: "Reviewed" });
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    agents(h.pi);

    await h.commands
      .get("agent")!
      .handler('run --title "review auth middleware" reviewer Review the middleware', h.ctx as ExtensionCommandContext);

    const row = reviewerRow(agentLiveStore)!;
    expect(row.title).toBe("review auth middleware");
    expect(renderRow(row)).toContain("review auth middleware");
  });
});

/**
 * OD2 — an interactive child and a workflow stage naming the same agent resolve
 * their model through the same chain.
 *
 * `runAgentLiveTask` keeps `/agent run reviewer` and workflow children on the same
 * model-resolution chain.
 */
describe("interactive children resolve the same tier as workflow children", () => {
  function projectWithTieredReviewer(): string {
    const root = mkdtempSync(path.join(tmpdir(), "locus-pi-agent-tier-"));
    writeGlobalModelRoles(root, {});
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read, search\nrisk: medium\nmodel: smol\n---\nProject.",
      "utf8",
    );
    tempRoots.push(root);
    return root;
  }

  /** Same fake session as above, but the createSession options are kept for inspection. */
  function mockSdkSessionCapturing(captured: Array<Record<string, unknown>>): void {
    vi.doMock("@earendil-works/pi-coding-agent", () => ({
      SessionManager: { create: () => ({ kind: "isolated-test-session" }) },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        reload() {}
      },
      getAgentDir() {
        return tmpdir();
      },
      async createAgentSession(options: Record<string, unknown>) {
        captured.push(options);
        let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
        return {
          session: {
            sessionId: "sdk-tier",
            model: options.model,
            subscribe(fn: (event: SdkAgentSessionEventLike) => void) {
              listener = fn;
              return () => {
                listener = undefined;
              };
            },
            async prompt() {
              listener?.({ type: "agent_end", willRetry: false });
            },
            getSessionStats() {
              return { sessionId: "sdk-tier", toolCalls: 1, toolResults: 1 };
            },
            getLastAssistantText() {
              return "Reviewed";
            },
            exportToJsonl(outputPath: string) {
              return outputPath;
            },
            dispose() {},
          },
        };
      },
    }));
  }

  it("creates the child session with the agent's resolved tier, not the session model", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockSdkSessionCapturing(captured);
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithTieredReviewer(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "test", id: "strong", name: "Test Strong" };
    writeGlobalModelRoles(h.ctx.session!.projectRoot!, { smol: "test/fast" });
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);

    expect(reviewerRow(agentLiveStore)).toMatchObject({ status: "done" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.model).toEqual({ provider: "test", id: "fast", name: "Test Fast" });
  });

  it("uses AGENT for a slash-command alias whose profile declares no model", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockSdkSessionCapturing(captured);
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "test", id: "strong", name: "Test Strong" };
    writeGlobalModelRoles(h.ctx.session!.projectRoot!, {
      agent: "test/fast",
      task: "test/strong",
      default: "test/strong",
    });
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);

    expect(reviewerRow(agentLiveStore)).toMatchObject({ status: "done" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.model).toEqual({ provider: "test", id: "fast", name: "Test Fast" });
  });

  it("lets the task tool inherit CURRENT when AGENT is unset", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockSdkSessionCapturing(captured);
    const { agents } = await loadAgents();
    const h = createHarness(projectWithReviewer(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "test", id: "strong", name: "Test Strong" };
    writeGlobalModelRoles(h.ctx.session!.projectRoot!, { task: "test/fast", default: "test/fast" });
    agents(h.pi);

    const result = await runTool(h, "spawn_agent", { agent: "reviewer", task: "Review this" });

    expect(result.isError).not.toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.model).toEqual({ provider: "test", id: "strong", name: "Test Strong" });
  });

  it("inherits the session model when the agent's tier is unassigned", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockSdkSessionCapturing(captured);
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithTieredReviewer(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "test", id: "strong", name: "Test Strong" };
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);

    expect(reviewerRow(agentLiveStore)).toMatchObject({ status: "done" });
    expect(captured[0]?.model).toEqual({ provider: "test", id: "strong", name: "Test Strong" });
  });

  it("records the degradation, so an inherited interactive run explains itself", async () => {
    // OD5's second half. The bridge already wrote this note; `/agent run` and
    // `spawn_agent` did not, so an interactive child dropped to the session model
    // with nothing in the evidence saying why — the unexplained-model problem OD2
    // asked us to close, surviving on the interactive side.
    const captured: Array<Record<string, unknown>> = [];
    mockSdkSessionCapturing(captured);
    const { agents, agentLiveStore } = await loadAgents();
    const root = projectWithTieredReviewer();
    const h = createHarness(root, { sessionId: "parent-session" });
    h.ctx.model = { provider: "test", id: "strong", name: "Test Strong" };
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);

    expect(reviewerRow(agentLiveStore)).toMatchObject({ status: "done" });
    const bodies = readAgentRunArtifacts(root);
    expect(bodies).toHaveLength(1);
    const fallback = bodies[0]!.modelRoleFallback as string | undefined;
    expect(fallback).toContain('"smol"');
    expect(fallback).toContain("model-roles");
  });

  it("does not let the reviewer's declared tier fall through to another assigned role", async () => {
    // Parity for the frontmatter half: `reviewer` declares `model: smol`. With
    // `smol` unassigned and `task` assigned, the purpose chain would have run the
    // `task` tier under the name `smol` here exactly as it did in the bridge.
    const captured: Array<Record<string, unknown>> = [];
    mockSdkSessionCapturing(captured);
    const { agents } = await loadAgents();
    const h = createHarness(projectWithTieredReviewer(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "test", id: "strong", name: "Test Strong" };
    writeGlobalModelRoles(h.ctx.session!.projectRoot!, { task: "test/fast", agent: "test/fast", default: "test/fast" });
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.model).toEqual({ provider: "test", id: "strong", name: "Test Strong" });
  });

  it("refuses by name when the agent's tier resolves to a model this host lacks", async () => {
    const captured: Array<Record<string, unknown>> = [];
    mockSdkSessionCapturing(captured);
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithTieredReviewer(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "test", id: "strong", name: "Test Strong" };
    writeGlobalModelRoles(h.ctx.session!.projectRoot!, { smol: "no-such-provider/no-such-model" });
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);

    const row = reviewerRow(agentLiveStore);
    expect(row?.status).toBe("error");
    expect(row?.errors.join("\n")).toContain('"no-such-provider/no-such-model"');
    // Fail-closed: no child session was created at all.
    expect(captured).toHaveLength(0);
    // …and the row says so. It is opened from the REQUEST before anything resolves, so
    // a refusal that never builds a session leaves a terminal row labelled with a model
    // that ran nothing — indistinguishable, in the panel, from one that ran and failed.
    expect(row?.model).toBeUndefined();
    expect(row?.thinking).toBeUndefined();
  });

  it("refuses a malformed tier assignment rather than inheriting the session model", async () => {
    // Round-2 finding 1, interactive half. One fix in `model-settings` covers the
    // bridge, `/agent run` and `spawn_agent`, and OD2 says the three must agree — so
    // the parity is asserted here rather than assumed from the bridge's test.
    const captured: Array<Record<string, unknown>> = [];
    mockSdkSessionCapturing(captured);
    const { agents, agentLiveStore } = await loadAgents();
    const h = createHarness(projectWithTieredReviewer(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "test", id: "strong", name: "Test Strong" };
    // Assigned, but missing the `provider/` half — a typo, not an unassigned role.
    writeGlobalModelRoles(h.ctx.session!.projectRoot!, { smol: "deepseek-v4-flash" });
    agents(h.pi);

    await h.commands.get("agent")!.handler("run reviewer Review this", h.ctx as ExtensionCommandContext);

    const row = reviewerRow(agentLiveStore);
    expect(row?.status).toBe("error");
    const errors = row?.errors.join("\n") ?? "";
    expect(errors).toContain('"deepseek-v4-flash"');
    expect(errors).not.toContain("is not assigned in the global model-roles config");
    expect(captured).toHaveLength(0);
    // The malformed-role refusal takes the same exit as the concrete-selector one, so
    // it owes the same honesty: the row seeded with the session model — which is NOT
    // what this call asked for and is not what ran, because nothing ran — is cleared.
    expect(row?.model).toBeUndefined();
    expect(row?.thinking).toBeUndefined();
  });
});
