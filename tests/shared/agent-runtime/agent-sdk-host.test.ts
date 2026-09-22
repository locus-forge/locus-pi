import { mkdtempSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_SDK_UNAVAILABLE_DIAGNOSTIC,
  AgentSdkUnavailableError,
  createAgentSdkSessionExecutor,
  materializeSdkSessionOptions,
  type CreateAgentSessionFactory,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
  type SdkCreateSessionOptionsLike,
} from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
} from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  compactWorkflowParentRows,
  elapsedSinceStart,
  formatDuration,
  formatModelBadge,
} from "../../../extensions/_shared/agent-runtime/agent-live-panel.js";
import { buildAgentSystemPrompt } from "../../../extensions/_shared/agent-runtime/agent-system-prompt.js";
import type { AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import type { AgentDefinition } from "../../../extensions/_shared/agent-runtime/agents.js";
import type { ThinkingLevel } from "../../../extensions/_shared/host/pi-api.js";

/**
 * INSURANCE, NOT PROOF.
 *
 * These tests inject a FAKE createAgentSession factory and only prove the wiring:
 * boundary contract -> SDK executor -> exact text result + graceful
 * degradation. They deliberately do NOT spawn a real child agent.
 * Real proof must come from a live `task`-tool run on a working host, captured via
 * the exported .locus/runtime/reports JSONL — that is out of scope here.
 */

const reviewer: AgentDefinition = {
  name: "reviewer",
  description: "Review code",
  allowedTools: ["read", "search", "yield"],
  tools: ["read", "search", "yield"],
  risk: "medium",
  readOnly: true,
  source: "project",
  filePath: "/repo/.agents/agents/reviewer.md",
};

function request(): Extract<AgentRunRequest, { executionMode: "named" }> {
  return {
    executionMode: "named",
    agent: reviewer,
    task: "Review this change",
    parentSessionId: "parent-session",
    projectRoot: "/repo",
    workingDirectory: "/repo",
    maxTurns: 5,
    depth: 0,
    maxDepth: 1,
    allowedTools: ["read", "search", "yield"],
    approvalTier: "allow",
  };
}

function requestWithSystemPrompt(): Extract<AgentRunRequest, { executionMode: "named" }> {
  return {
    ...request(),
    agent: {
      ...reviewer,
      systemPrompt: "Run this task autonomously and report succinctly.",
    },
  };
}

function inMemoryFileSystem(entries: Map<string, string>) {
  return {
    exists: (filePath: string) => entries.has(filePath),
    readFile: (filePath: string) => {
      const value = entries.get(filePath);
      if (value === undefined) throw new Error(`No file: ${filePath}`);
      return value;
    },
  };
}

interface FakeSessionConfig {
  toolCalls: number;
  toolResults: number;
  lastAssistantText: string | undefined;
  sessionId?: string;
  /**
   * When set, prompt() resolves but the terminal `agent_end` event is NEVER
   * emitted, so the only way out of the turn is the timeout (or an abort). Used
   * to prove the executor cannot hang waiting for a completion that never comes.
   */
  neverEnds?: boolean;
  /** When set, prompt() rejects with this message (simulates a transport failure). */
  promptError?: string;
  messages?: readonly unknown[];
  events?: SdkAgentSessionEventLike[];
  /** What the host says this session runs on. Absent = an older peer or a structural mock. */
  model?: unknown;
  /** What the host says this session actually used for reasoning. */
  thinkingLevel?: ThinkingLevel;
  activeToolNames?: string[];
  exposesActiveToolNames?: boolean;
  onPrompt?: (text: string) => void;
}

interface FakeSession {
  session: SdkAgentSessionLike;
  disposeSpy: ReturnType<typeof vi.fn>;
  abortSpy: ReturnType<typeof vi.fn>;
}

function fakeSession(config: FakeSessionConfig): FakeSession {
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-sdk-host-export-"));
  const disposeSpy = vi.fn();
  const abortSpy = vi.fn(async () => {});
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  const session: SdkAgentSessionLike = {
    sessionId: config.sessionId ?? "sdk-child",
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
    ...(config.messages !== undefined ? { messages: config.messages } : {}),
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async prompt(text) {
      config.onPrompt?.(text);
      if (config.promptError !== undefined) throw new Error(config.promptError);
      for (const event of config.events ?? []) listener?.(event);
      // Drive the terminal event synchronously unless the fake never completes.
      if (config.neverEnds !== true) listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return {
        sessionId: config.sessionId ?? "sdk-child",
        toolCalls: config.toolCalls,
        toolResults: config.toolResults,
      };
    },
    getLastAssistantText() {
      return config.lastAssistantText;
    },
    ...(config.exposesActiveToolNames === false
      ? {}
      : { getActiveToolNames: () => [...(config.activeToolNames ?? ["read"])] }),
    exportToJsonl(outputPath) {
      const target = outputPath ?? path.join(exportDir, "session.jsonl");
      writeFileSync(target, "{}\n", "utf8");
      return target;
    },
    dispose: disposeSpy,
    abort: abortSpy,
  };
  return { session, disposeSpy, abortSpy };
}

function tmpReportsDir(): string {
  return mkdtempSync(path.join(tmpdir(), "locus-sdk-host-reports-"));
}

describe("agent SDK session executor (insurance, not proof)", () => {
  it("isolates default-adapter child sessions from the operator session catalog", async () => {
    const manager = { kind: "run-scoped-child" };
    const create = vi.fn(() => manager);

    const materialized = await materializeSdkSessionOptions(
      { SessionManager: { create } },
      { cwd: "/repo", evidenceSessionDir: "/evidence/call-0001/.sessions", excludeTools: ["spawn_agent"] },
    );

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith("/repo", "/evidence/call-0001/.sessions");
    expect(materialized).toMatchObject({
      cwd: "/repo",
      excludeTools: ["spawn_agent"],
      sessionManager: manager,
    });
  });

  it("fails closed when the host cannot create an isolated child session manager", async () => {
    await expect(materializeSdkSessionOptions({}, { cwd: "/repo" })).rejects.toThrow("SessionManager.create");
  });

  it("registers exactly the return tool on a real tool-free SDK session", async () => {
    // Item 2's decision, proved on the real host rather than on a structural mock.
    //
    // Pi builds the child's tool REGISTRY from the allowlist (`tools`, or `[]` when
    // `noTools: "all"` and no list is given), so a custom tool that is not named there is
    // filtered out before `setActiveToolsByName` could ever enable it. Clearing the list
    // is what made a shaped tool-free Fusion judge impossible: every member answered, and
    // only then did the judge fail for a receipt the session never carried.
    //
    // Naming the return tool — and nothing else — keeps "tool-free" exactly as strict: no
    // built-ins, no extensions, no skills. The readback below is the proof.
    const sdk = await import("@earendil-works/pi-coding-agent");
    const { getModel } = await import("@earendil-works/pi-ai/compat");
    const { Type } = await import("@sinclair/typebox");
    const cwd = tmpReportsDir();
    const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
    const model = { ...getModel("openai", "gpt-4o-mini"), baseUrl: "cli://fixture" };
    const returnTool = {
      name: "workflow_return",
      label: "Return",
      description: "Return the shaped result to the workflow.",
      parameters: Type.Object({ value: Type.String() }),
      execute: async () => ({ output: "recorded" }),
    };
    const runtime = await sdk.ModelRuntime.create({
      authPath: path.join(cwd, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(cwd, "models-store.json"),
      refreshOnCreate: false,
    });
    const { session } = await sdk.createAgentSession({
      cwd,
      model,
      modelRuntime: runtime,
      settingsManager: settings,
      sessionManager: sdk.SessionManager.inMemory(),
      noTools: "all",
      tools: ["workflow_return"],
      excludeTools: ["spawn_agent", "ask"],
      customTools: [returnTool] as never,
    });
    try {
      expect(session.getActiveToolNames()).toEqual(["workflow_return"]);
      // The acceptance restriction the host applies before each turn still holds.
      session.setActiveToolsByName(["workflow_return"]);
      expect(session.getActiveToolNames()).toEqual(["workflow_return"]);
    } finally {
      session.dispose();
    }
  });

  it("leaves a real tool-free SDK session with no tools at all when no shape is declared", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const { getModel } = await import("@earendil-works/pi-ai/compat");
    const cwd = tmpReportsDir();
    const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
    const model = { ...getModel("openai", "gpt-4o-mini"), baseUrl: "cli://fixture" };
    const runtime = await sdk.ModelRuntime.create({
      authPath: path.join(cwd, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(cwd, "models-store.json"),
      refreshOnCreate: false,
    });
    const { session } = await sdk.createAgentSession({
      cwd,
      model,
      modelRuntime: runtime,
      settingsManager: settings,
      sessionManager: sdk.SessionManager.inMemory(),
      noTools: "all",
      tools: [],
      excludeTools: ["spawn_agent", "ask"],
      customTools: [],
    });
    try {
      expect(session.getActiveToolNames()).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it("keeps the package-owned generic child identity in the tool-free system prompt without a catalog persona", () => {
    const prompt = buildAgentSystemPrompt(request(), { suppressContextExtras: true });

    expect(prompt).toContain('<active_agent name="reviewer"/>');
    expect(prompt).toContain("You are a pi coding agent sub-agent.");
    expect(prompt).toContain("Working directory: /repo");
  });

  it("omits context extras when the opt-in flag is unset", () => {
    const prompt = buildAgentSystemPrompt(requestWithSystemPrompt(), {
      env: {
        LOCUS_AGENT_CONTEXT_EXTRAS: "0",
        LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
      },
      readFile: () => {
        throw new Error("memory reads must not run when extras are disabled");
      },
      exists: () => false,
    });

    expect(prompt).not.toContain("# Context extras");
    expect(prompt).not.toContain("## Memory");
    expect(prompt).not.toContain("## Skill: reviewer");
  });

  it("falls back to <projectRoot>/MEMORY.md when memory env is unset", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-memory-default-"));
    const memoryPath = path.join(root, "MEMORY.md");
    const filesystem = inMemoryFileSystem(new Map([[memoryPath, "DEFAULT_MEMORY\nline-2"]]));

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toContain("## Memory");
    expect(prompt).toContain(`Requested: ${memoryPath}`);
    expect(prompt).toContain("DEFAULT_MEMORY");
  });

  it("preserves live parentRowId through session events, stats, and terminal status", async () => {
    agentLiveStore.reset();
    try {
      const session = fakeSession({ toolCalls: 1, toolResults: 1, lastAssistantText: "done" });
      const createSession: CreateAgentSessionFactory = async () => ({ session: session.session });
      const executor = createAgentSdkSessionExecutor({
        createSession,
        reportsDir: tmpReportsDir(),
        now: () => "fixed",
        live: {
          parentRowId: "workflow:run:reviewer:review-step:smoke",
          label: "SDK child session",
          model: "test/strong",
          thinking: "high",
          isolated: true,
          noMcp: true,
        },
      });

      await executor.run(request(), new AbortController().signal);
      const row = [...agentLiveStore.rows.values()].find(
        (candidate) => candidate.parentRowId === "workflow:run:reviewer:review-step:smoke",
      );

      expect(row).toBeDefined();
      expect(row).toMatchObject({
        parentRowId: "workflow:run:reviewer:review-step:smoke",
        label: "SDK child session",
        status: "done",
        activityState: "completed",
        model: "test/strong",
        currentPath: "/repo",
        childSessionId: "sdk-child",
        finalAnswer: "done",
        isolated: true,
        noMcp: true,
      });
      expect(row).not.toHaveProperty("thinking"); // `high` was requested; this session read none back
      expect(row?.stepCount).toBeGreaterThanOrEqual(2);
    } finally {
      agentLiveStore.reset();
    }
  });

  it("injects enabled memory extras whole, however long the file is", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-memory-"));
    const memoryLines = Array.from({ length: 300 }, (_, index) =>
      index === 0 ? "MEMORY_SENTINEL" : `line-${index + 1}`,
    );
    const memoryPath = path.join(root, "MEMORY.md");
    const filesystem = inMemoryFileSystem(new Map([[memoryPath, memoryLines.join("\n")]]));

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("MEMORY_SENTINEL");
    // Selected context is passed whole: no line budget, no trailing clip marker.
    expect(prompt).toContain("line-300");
    expect(prompt).not.toContain("First 200 lines kept.");
    expect(prompt).not.toContain("[truncated]");
  });

  it("reports the size of large context extras instead of cutting them", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-large-"));
    const memoryPath = path.join(root, "MEMORY.md");
    const body = `MEMORY_SENTINEL\n${"M".repeat(40 * 1024)}\nMEMORY_TAIL`;
    const filesystem = inMemoryFileSystem(new Map([[memoryPath, body]]));

    const prompt = buildAgentSystemPrompt(
      { ...requestWithSystemPrompt(), projectRoot: root, workingDirectory: root },
      {
        env: { LOCUS_AGENT_CONTEXT_EXTRAS: "1" },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toContain("MEMORY_SENTINEL");
    expect(prompt).toContain("MEMORY_TAIL");
    expect(prompt).toMatch(/Context extras are large: \d+ bytes passed whole/u);
    expect(prompt).toContain("Nothing was truncated.");
  });

  it("injects enabled skill extras from simple names with canonical source path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-skill-"));
    const skillPath = path.join(root, ".agents", "skills", "reviewer", "SKILL.md");
    const filesystem = inMemoryFileSystem(new Map([[skillPath, "SKILL_SENTINEL\n"]]));

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
          LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toContain("## Skill: reviewer");
    expect(prompt).toContain(`Source: ${skillPath}`);
    expect(prompt).toContain("Requested: reviewer");
    expect(prompt).toContain("SKILL_SENTINEL");
  });

  it("resolves simple skill names via .pi/skills fallback when .agents/skills is absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-skill-pi-"));
    const skillPath = path.join(root, ".pi", "skills", "reviewer", "SKILL.md");
    const memoryPath = path.join(root, "MEMORY.md");
    const filesystem = inMemoryFileSystem(
      new Map([
        [memoryPath, "DEFAULT_MEMORY\n"],
        [skillPath, "PI_SKILL_SENTINEL\n"],
      ]),
    );

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
          LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toContain(`Source: ${skillPath}`);
    expect(prompt).toContain("PI_SKILL_SENTINEL");
  });

  it("returns diagnostics instead of throwing when requested memory/skill assets are missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-missing-"));
    const missingSkillPath = path.join(root, ".agents", "skills", "missing", "SKILL.md");
    const missingMemoryPath = path.join(root, "missing-memory.md");

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
          LOCUS_AGENT_MEMORY_FILE: missingMemoryPath,
          LOCUS_AGENT_PRELOAD_SKILLS: "missing",
        },
        readFile() {
          throw new Error("must not read missing files");
        },
        exists: () => false,
      },
    );

    expect(prompt).toContain("- Missing memory file: ");
    expect(prompt).toContain(missingMemoryPath);
    expect(prompt).toContain(`- Requested: missing`);
    expect(prompt).toContain(missingSkillPath);
    expect(prompt).toContain("Skill source missing. Tried");
    expect(prompt).toContain("(skill content unavailable)");
  });

  it("produces byte-identical prompts for identical inputs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-stable-"));
    const memoryPath = path.join(root, "MEMORY.md");
    const skillPath = path.join(root, ".agents", "skills", "reviewer", "SKILL.md");
    const filesystem = inMemoryFileSystem(
      new Map([
        [memoryPath, "MEMORY_SENTINEL\nline-2"],
        [skillPath, "SKILL_SENTINEL\n"],
      ]),
    );

    const requestWithExtras = {
      ...requestWithSystemPrompt(),
      projectRoot: root,
      workingDirectory: root,
    };
    const env = {
      LOCUS_AGENT_CONTEXT_EXTRAS: "1",
      LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
    };
    const promptA =
      buildAgentSystemPrompt(requestWithExtras, {
        env,
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      }) ?? "";
    const promptB =
      buildAgentSystemPrompt(requestWithExtras, {
        env,
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      }) ?? "";

    expect(Buffer.byteLength(promptA, "utf8")).toBe(Buffer.byteLength(promptB, "utf8"));
    expect(promptA).toBe(promptB);
  });

  it("appends opt-in memory and skill extras to the SDK child system prompt", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-sdk-host-extras-"));
    const memoryPath = path.join(root, "MEMORY.md");
    const memoryLines = ["MEMORY_SENTINEL", ...Array.from({ length: 204 }, (_, index) => `memory-line-${index + 2}`)];
    writeFileSync(memoryPath, memoryLines.join("\n"), "utf8");
    const skillPath = path.join(root, ".agents", "skills", "reviewer", "SKILL.md");
    mkdirSync(path.dirname(skillPath), { recursive: true });
    const skillLines = ["SKILL_SENTINEL", ...Array.from({ length: 204 }, (_, index) => `skill-line-${index + 2}`)];
    writeFileSync(skillPath, skillLines.join("\n"), "utf8");
    const env = {
      LOCUS_AGENT_CONTEXT_EXTRAS: "1",
      LOCUS_AGENT_MEMORY_FILE: memoryPath,
      LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
    } as NodeJS.ProcessEnv;

    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "SDK extras result.",
    });
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      createSession: async (options) => {
        capturedOptions = options;
        return { session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      promptEnv: env,
    });

    const result = await executor.run(
      { ...requestWithSystemPrompt(), projectRoot: root, workingDirectory: root },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    const prompt = String(capturedOptions?.appendSystemPrompt ?? "");
    expect(prompt).toContain("# Context extras");
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("MEMORY_SENTINEL");
    expect(prompt).toContain("## Skill: reviewer");
    expect(prompt).toContain(`Source: ${skillPath}`);
    expect(prompt).toContain("Requested: reviewer");
    expect(prompt).toContain("SKILL_SENTINEL");
    expect(prompt).toContain("memory-line-201");
    expect(prompt).toContain("skill-line-201");
    expect(prompt).not.toContain("First 200 lines kept.");
    expect(prompt).not.toContain("[context extras truncated]");
  });

  it("appends extras when the agent has no systemPrompt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-no-system-prompt-"));
    const memoryPath = path.join(root, "MEMORY.md");
    const skillPath = path.join(root, ".pi", "skills", "reviewer", "SKILL.md");
    const filesystem = inMemoryFileSystem(
      new Map([
        [memoryPath, "MEMORY_SENTINEL\n"],
        [skillPath, "PI_SKILL_SENTINEL\n"],
      ]),
    );

    const prompt = buildAgentSystemPrompt(
      {
        ...request(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
          LOCUS_AGENT_MEMORY_FILE: memoryPath,
          LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toBeDefined();
    const promptText = prompt ?? "";
    expect(promptText).toContain('<active_agent name="reviewer"/>');
    expect(promptText).toContain("You are a pi coding agent sub-agent.");
    expect(promptText).toContain("# Context extras");
    expect(promptText).toContain("## Memory");
    expect(promptText).toContain("MEMORY_SENTINEL");
    expect(promptText).toContain("## Skill: reviewer");
    expect(promptText).toContain(`Source: ${skillPath}`);
    expect(promptText).toContain("PI_SKILL_SENTINEL");
    expect(promptText).not.toContain("<agent_instructions>");
    expect(promptText.indexOf("# Context extras")).toBeGreaterThan(
      promptText.indexOf("You have been invoked to handle a specific task autonomously."),
    );
  });

  it("surfaces missing context-extra diagnostics without failing the SDK run", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-sdk-host-extras-missing-"));
    const missingMemoryPath = path.join(root, "missing-memory.md");
    const missingSkillPath = path.join(root, ".agents", "skills", "missing", "SKILL.md");
    const env = {
      LOCUS_AGENT_CONTEXT_EXTRAS: "1",
      LOCUS_AGENT_MEMORY_FILE: missingMemoryPath,
      LOCUS_AGENT_PRELOAD_SKILLS: "missing",
    } as NodeJS.ProcessEnv;

    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "SDK missing diagnostics result.",
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      promptEnv: env,
    });

    const result = await executor.run(
      { ...requestWithSystemPrompt(), projectRoot: root, workingDirectory: root },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing memory file"),
        expect.stringContaining(missingMemoryPath),
        expect.stringContaining("Requested: missing"),
        expect.stringContaining("Skill source missing. Tried"),
        expect.stringContaining(missingSkillPath),
        expect.stringContaining("(skill content unavailable)"),
      ]),
    );
  });

  it("drops every late SDK projection after the execution's stable row is replaced", async () => {
    agentLiveStore.reset();
    let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
    let releasePrompt = () => {};
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const reportsDir = tmpReportsDir();
    const session: SdkAgentSessionLike = {
      sessionId: "sdk-a",
      messages: [{ role: "assistant", content: [{ type: "text", text: "late transcript A" }], stopReason: "stop" }],
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        await promptGate;
      },
      getSessionStats() {
        return {
          sessionId: "sdk-a",
          toolCalls: 3,
          toolResults: 2,
          tokens: { input: 300, output: 120 },
        };
      },
      getLastAssistantText() {
        return "late final A";
      },
      exportToJsonl(outputPath) {
        const target = outputPath ?? path.join(reportsDir, "sdk-a.jsonl");
        writeFileSync(target, `${JSON.stringify({ type: "session", id: "sdk-a" })}\n`, "utf8");
        return target;
      },
      dispose: vi.fn(),
      abort: vi.fn(async () => {}),
    };
    const observedExecutions: unknown[] = [];
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir,
      now: () => "fixed",
      childTimeoutMs: 60_000,
      live: { rowId: "sdk-overlap", label: "execution A", slotKey: "verify", round: 1 },
      onLiveExecution: (execution) => observedExecutions.push(execution),
    });

    const running = executor.run(request(), new AbortController().signal);
    await vi.waitFor(() => expect(listener).toBeDefined());
    expect(observedExecutions).toHaveLength(1);
    const staleExecution = observedExecutions[0] as ReturnType<typeof agentLiveStore.captureExecutionAuthority>;
    expect(staleExecution).toBe(agentLiveStore.captureExecutionAuthority("sdk-overlap"));

    const replacement = agentLiveStore.beginExecution({
      id: "sdk-overlap",
      agentName: "reviewer",
      label: "execution B",
      slotKey: "verify",
      round: 2,
    });
    agentLiveStore.patchExecution(replacement, {
      status: "working",
      finalAnswer: "B owns this row",
      errors: ["B sentinel"],
      tokenCount: { input: 900, output: 400 },
    });
    agentLiveStore.feedExecutionEvent(replacement, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "current transcript B" }], stopReason: "stop" },
    });

    listener?.({ type: "tool_execution_start", toolCallId: "late-a", toolName: "read", args: {} });
    listener?.({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "late event A" }], stopReason: "stop" },
    });
    listener?.({ type: "agent_end", willRetry: false });
    releasePrompt();
    const result = await running;

    expect(result).toMatchObject({ status: "completed", text: "late final A" });
    expect(staleExecution === undefined ? undefined : agentLiveStore.rowForExecution(staleExecution)).toBeUndefined();
    expect(agentLiveStore.rowForExecution(replacement)).toMatchObject({
      status: "working",
      finalAnswer: "B owns this row",
      errors: ["B sentinel"],
      tokenCount: { input: 900, output: 400 },
      latestMessage: "current transcript B",
      currentTools: [],
    });
    expect(JSON.stringify(agentLiveStore.rowForExecution(replacement))).not.toContain("late event A");
    expect(JSON.stringify(agentLiveStore.rowForExecution(replacement))).not.toContain("late transcript A");
  });

  it("cleans caller abort and row cancellation listeners when onLiveExecution throws", async () => {
    agentLiveStore.reset();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const signal = {
      aborted: false,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;
    const createSession = vi.fn<CreateAgentSessionFactory>();
    const executor = createAgentSdkSessionExecutor({
      createSession: createSession as unknown as CreateAgentSessionFactory,
      live: { rowId: "callback-throws", label: "callback throws" },
      onLiveExecution: () => {
        throw new Error("observer failed");
      },
    });

    await expect(executor.run(request(), signal)).rejects.toThrow("observer failed");

    expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(createSession).not.toHaveBeenCalled();
    expect(agentLiveStore.captureCancellationAuthority("callback-throws")).toBeUndefined();
    expect(agentLiveStore.cancel("callback-throws")).toBe(false);
    expect(agentLiveStore.rows.get("callback-throws")).toMatchObject({
      status: "error",
      finalAnswer: "observer failed",
      errors: ["observer failed"],
    });
  });

  it("leaves a synchronous same-id replacement byte-for-byte unchanged when onLiveExecution throws", async () => {
    agentLiveStore.reset();
    let replacement: ReturnType<typeof agentLiveStore.captureExecutionAuthority>;
    let replacementBytes = "";
    const executor = createAgentSdkSessionExecutor({
      createSession: vi.fn() as unknown as CreateAgentSessionFactory,
      live: { rowId: "observer-replacement", label: "execution A" },
      onLiveExecution: () => {
        replacement = agentLiveStore.beginExecution({
          id: "observer-replacement",
          agentName: "reviewer",
          label: "execution B",
          model: "test/b",
        });
        agentLiveStore.patchExecution(replacement, {
          status: "working",
          finalAnswer: "B sentinel",
          errors: ["B error sentinel"],
          tokenCount: { input: 9, output: 4 },
        });
        replacementBytes = JSON.stringify(agentLiveStore.rowForExecution(replacement));
        throw new Error("observer replaced then failed");
      },
    });

    await expect(executor.run(request(), new AbortController().signal)).rejects.toThrow(
      "observer replaced then failed",
    );

    expect(replacement).toBeDefined();
    expect(JSON.stringify(replacement === undefined ? undefined : agentLiveStore.rowForExecution(replacement))).toBe(
      replacementBytes,
    );
  });

  it("runs a child session through the SDK host and returns exact text", async () => {
    const { session, disposeSpy } = fakeSession({
      toolCalls: 2,
      toolResults: 1,
      lastAssistantText: "  Reviewed via SDK\n",
    });
    const reportsDir = tmpReportsDir();
    const createSession: CreateAgentSessionFactory = async () => ({ session });
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir, now: () => "fixed" });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result).toMatchObject({
      status: "completed",
      reason: "  Reviewed via SDK\n",
      text: "  Reviewed via SDK\n",
      childSession: { id: "sdk-child" },
      childOutputStats: {
        assistantToolCallCount: 2,
        toolResultCount: 1,
        hasWorkloadProof: true,
      },
    });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    const transcripts = readdirSync(reportsDir).filter((name) => name.endsWith(".jsonl"));
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatch(/^agent-sdk-reviewer-[a-z0-9-]+-fixed\.jsonl$/u);
    expect(existsSync(path.join(reportsDir, transcripts[0]!))).toBe(true);
  });

  it("routes viewer input into the active SDK child as a steering message", async () => {
    agentLiveStore.reset();
    let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
    let liveExecution: AgentLiveExecutionHandle | undefined;
    let releasePromptPreflight: () => void = () => {};
    let releaseInitialPrompt: () => void = () => {};
    let markPromptInvoked: () => void = () => {};
    let markPromptStarted: () => void = () => {};
    const promptPreflightGate = new Promise<void>((resolve) => {
      releasePromptPreflight = resolve;
    });
    const initialPromptGate = new Promise<void>((resolve) => {
      releaseInitialPrompt = resolve;
    });
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const promptInvoked = new Promise<void>((resolve) => {
      markPromptInvoked = resolve;
    });
    let streaming = false;
    const promptSpy = vi.fn(async (_text: string, options?: { source?: string; streamingBehavior?: "steer" }) => {
      if (options?.source === "locus-pi-agent-sdk-host") {
        markPromptInvoked();
        await promptPreflightGate;
        streaming = true;
        markPromptStarted();
        await initialPromptGate;
        listener?.({ type: "agent_end", willRetry: false });
        streaming = false;
      }
    });
    const session: SdkAgentSessionLike = {
      sessionId: "interactive-sdk-child",
      get isStreaming() {
        return streaming;
      },
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      prompt: promptSpy,
      getSessionStats: () => ({ sessionId: "interactive-sdk-child", toolCalls: 0, toolResults: 0 }),
      getLastAssistantText: () => "Interactive child finished",
      exportToJsonl(outputPath) {
        const target = outputPath ?? path.join(tmpReportsDir(), "session.jsonl");
        writeFileSync(target, "{}\n", "utf8");
        return target;
      },
      dispose: vi.fn(),
      abort: vi.fn(async () => {}),
    };
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      onLiveExecution: (execution) => {
        liveExecution = execution;
      },
    });

    const running = executor.run(request(), new AbortController().signal);
    await promptInvoked;
    expect(liveExecution).toBeDefined();
    expect(agentLiveStore.canSendInputForExecution(liveExecution!)).toBe(false);
    releasePromptPreflight();
    await promptStarted;
    expect(agentLiveStore.canSendInputForExecution(liveExecution!)).toBe(true);
    const input = await agentLiveStore.sendInputForExecution(liveExecution!, "Please also inspect tests.");
    expect(input).toEqual({ ok: true });
    expect(promptSpy).toHaveBeenCalledWith("Please also inspect tests.", {
      source: "locus-pi-agent-viewer",
      streamingBehavior: "steer",
    });

    releaseInitialPrompt();
    await expect(running).resolves.toMatchObject({ status: "completed", text: "Interactive child finished" });
    await expect(agentLiveStore.sendInputForExecution(liveExecution!, "Too late")).resolves.toEqual({
      ok: false,
      reason: "This agent is no longer accepting input.",
    });
  });

  it("accepts a non-empty text completion with no child workload proof", async () => {
    const { session, disposeSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "Reviewed via SDK",
    });
    const createSession: CreateAgentSessionFactory = async () => ({ session });
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.reason).toBe("Reviewed via SDK");
    expect(result.childOutputStats).toMatchObject({ hasWorkloadProof: false });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("treats JSON-looking SDK output as ordinary text", async () => {
    const { session, disposeSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: '{"status":"failed","summary":"Reasoning-only final answer."}',
    });
    const createSession: CreateAgentSessionFactory = async () => ({ session });
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.text).toBe('{"status":"failed","summary":"Reasoning-only final answer."}');
    expect(result).not.toHaveProperty("structuredResult");
    expect(result.childOutputStats).toMatchObject({ hasWorkloadProof: false });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces the provider error from assistant messages before the empty-result fallback", async () => {
    const providerError = "OAuth token refresh failed for provider";
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: providerError }],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toBe(providerError);
    expect(result.reason).not.toBe("Agent result text is empty.");
    expect([...agentLiveStore.rows.values()].at(-1)).toMatchObject({
      status: "error",
      errors: [providerError],
      transcript: {
        blocks: [{ kind: "assistant", message: { stopReason: "error", errorMessage: providerError } }],
      },
    });
  });

  it("preserves the empty-result failure when no assistant/provider diagnostic exists", async () => {
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      messages: [{ role: "assistant", content: [], stopReason: "stop" }],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("Agent result text is empty.");
  });

  it("does not let a recovered earlier provider error override the terminal assistant success", async () => {
    const answer = "Recovered final answer.";
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: answer,
      messages: [
        { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary provider failure" },
        { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" },
      ],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.reason).toBe(answer);
  });

  it("passes the selected agent persona as appended child system prompt instructions", async () => {
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "Persona-aware SDK answer.",
    });
    let capturedOptions: unknown;
    const createSession: CreateAgentSessionFactory = async (options) => {
      capturedOptions = options;
      return { session };
    };
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(
      {
        ...request(),
        agent: { ...reviewer, readOnly: false, systemPrompt: "Review for correctness first." },
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(capturedOptions).toMatchObject({
      cwd: "/repo",
      excludeTools: ["spawn_agent"],
      appendSystemPrompt: expect.stringContaining("Review for correctness first."),
    });
    expect((capturedOptions as { appendSystemPrompt?: string }).appendSystemPrompt).toContain(
      '<active_agent name="reviewer"/>',
    );
    expect((capturedOptions as { appendSystemPrompt?: string }).appendSystemPrompt).toContain(
      "Do not call `spawn_agent` directly",
    );
    expect((capturedOptions as { appendSystemPrompt?: string }).appendSystemPrompt).toContain("`workflow`");
    expect((capturedOptions as SdkCreateSessionOptionsLike | undefined)?.noTools).toBeUndefined();
    expect((capturedOptions as SdkCreateSessionOptionsLike | undefined)?.resourceLoaderOptions).toBeUndefined();
  });

  it("materializes tool-free Fusion with no tools, no discovered resources, and no package context extras", async () => {
    const order: string[] = [];
    let kickoff = "";
    const fake = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "Tool-free answer.",
      activeToolNames: [],
      onPrompt(text) {
        order.push("prompt");
        kickoff = text;
      },
    });
    fake.session.getActiveToolNames = () => {
      order.push("readback");
      return [];
    };
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      createSession: async (options) => {
        capturedOptions = options;
        return { session: fake.session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      promptEnv: {
        LOCUS_AGENT_CONTEXT_EXTRAS: "1",
        LOCUS_AGENT_MEMORY_FILE: "/canary/MEMORY_SENTINEL.md",
        LOCUS_AGENT_PRELOAD_SKILLS: "SKILL_SENTINEL",
      },
    });

    const result = await executor.run(
      {
        ...requestWithSystemPrompt(),
        capabilityMode: "tool-free",
        agent: {
          ...requestWithSystemPrompt().agent,
          readOnly: true,
          allowedTools: [],
          tools: [],
          systemPrompt: "CATALOG_PERSONA_SENTINEL",
        },
        allowedTools: [],
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: "completed",
      activeToolNames: [],
    });
    expect(order).toEqual(["readback", "prompt"]);
    expect(capturedOptions).toMatchObject({
      noTools: "all",
      tools: [],
      customTools: [],
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        appendSystemPrompt: [],
        systemPrompt: expect.stringContaining("CATALOG_PERSONA_SENTINEL"),
      },
    });
    expect(capturedOptions?.appendSystemPrompt).toBeUndefined();
    expect(JSON.stringify(capturedOptions)).not.toContain("MEMORY_SENTINEL");
    expect(JSON.stringify(capturedOptions)).not.toContain("SKILL_SENTINEL");
    expect(kickoff).toContain("CATALOG_PERSONA_SENTINEL");
    expect(kickoff).not.toContain("MEMORY_SENTINEL");
    expect(kickoff).not.toContain("SKILL_SENTINEL");
  });

  it("keeps exactly the return tool on a shaped tool-free child and accepts its receipt", async () => {
    // A Fusion judge with a `schema` runs tool-free like the rest of its panel. Clearing
    // `customTools` removed the ONE tool such a judge needs, so the panel paid for every
    // member and then failed the judge on a transport question. The return tool performs
    // no external effect — it records the declared value — so keeping it registered does
    // not make the child able to act, and the readback below still proves it has nothing
    // else.
    const { normalizeWorkflowReturnContract } =
      await import("../../../extensions/workflows/runtime/workflow-return.js");
    const { createWorkflowReturnController } = await import("../../../extensions/workflows/runtime/workflow-return.js");
    const contract = normalizeWorkflowReturnContract({ output: { type: "string", singleLine: true } });
    const { tool, acceptance } = createWorkflowReturnController(contract);
    let active: string[] = [tool.name];
    let prompts = 0;
    let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
    const exportDir = tmpReportsDir();
    const session: SdkAgentSessionLike = {
      sessionId: "sdk-child",
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        prompts += 1;
        listener?.({ type: "turn_start" });
        listener?.({ type: "tool_execution_start", toolName: tool.name, toolCallId: "t1" });
        await tool.execute("t1", { value: "the panel verdict" }, new AbortController().signal);
        listener?.({ type: "agent_end", willRetry: false });
      },
      getSessionStats: () => ({ sessionId: "sdk-child", toolCalls: 1, toolResults: 1 }),
      getLastAssistantText: () => "narrative the host must not accept",
      getActiveToolNames: () => active,
      setActiveToolsByName(names) {
        active = [...names];
      },
      exportToJsonl(outputPath) {
        const target = outputPath ?? path.join(exportDir, "session.jsonl");
        writeFileSync(target, "{}\n", "utf8");
        return target;
      },
      dispose: vi.fn(),
      abort: vi.fn(async () => {}),
    };
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      createSession: async (options) => {
        capturedOptions = options;
        return { session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(
      {
        ...request(),
        capabilityMode: "tool-free",
        agent: { ...reviewer, readOnly: true, allowedTools: [], tools: [] },
        allowedTools: [],
        customTools: [tool],
        responseAcceptance: acceptance,
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(result.text).toBe(JSON.stringify("the panel verdict"));
    expect(prompts).toBe(1);
    expect(capturedOptions).toMatchObject({ noTools: "all", tools: [tool.name] });
    expect(capturedOptions?.customTools?.map(({ name }) => name)).toEqual([tool.name]);
  });

  it("constructs the real SDK resource-loader seam with closed discovery overrides", async () => {
    const fake = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "Tool-free answer.",
      activeToolNames: [],
    });
    let loaderOptions: Record<string, unknown> | undefined;
    let createdOptions: Record<string, unknown> | undefined;
    const isolatedSessionManager = { kind: "run-scoped-child" };
    class CapturedResourceLoader {
      constructor(options: Record<string, unknown>) {
        loaderOptions = options;
      }
      reload(): void {}
    }
    vi.doMock("@earendil-works/pi-coding-agent", () => ({
      DefaultResourceLoader: CapturedResourceLoader,
      getAgentDir: () => "/agent-dir",
      SessionManager: { create: () => isolatedSessionManager },
      createAgentSession: async (options: Record<string, unknown>) => {
        createdOptions = options;
        return { session: fake.session };
      },
    }));
    try {
      const executor = createAgentSdkSessionExecutor({ reportsDir: tmpReportsDir(), now: () => "fixed" });
      const result = await executor.run(
        {
          ...requestWithSystemPrompt(),
          capabilityMode: "tool-free",
          agent: {
            ...requestWithSystemPrompt().agent,
            readOnly: true,
            allowedTools: [],
            tools: [],
            systemPrompt: "CATALOG_PERSONA_SENTINEL",
          },
          allowedTools: [],
        },
        new AbortController().signal,
      );

      expect(result.status).toBe("completed");
      expect(loaderOptions).toMatchObject({
        cwd: "/repo",
        agentDir: "/agent-dir",
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      expect((loaderOptions?.systemPromptOverride as (() => string) | undefined)?.()).toContain(
        "CATALOG_PERSONA_SENTINEL",
      );
      expect((loaderOptions?.appendSystemPromptOverride as (() => string[]) | undefined)?.()).toEqual([]);
      expect(createdOptions).toMatchObject({
        noTools: "all",
        tools: [],
        customTools: [],
        sessionManager: isolatedSessionManager,
      });
      expect(createdOptions?.resourceLoader).toBeInstanceOf(CapturedResourceLoader);
      expect(createdOptions).not.toHaveProperty("resourceLoaderOptions");
      expect(createdOptions).not.toHaveProperty("appendSystemPrompt");
    } finally {
      vi.doUnmock("@earendil-works/pi-coding-agent");
    }
  });

  it.each([
    ["missing readback", { exposesActiveToolNames: false }, /requires AgentSession\.getActiveToolNames/u],
    ["non-empty readback", { activeToolNames: ["read"] }, /exposed active tools before prompt: read/u],
  ])("fails tool-free Fusion before prompt on %s", async (_name, sessionConfig, expected) => {
    const promptSpy = vi.fn();
    const fake = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "must not run",
      onPrompt: promptSpy,
      ...sessionConfig,
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session: fake.session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(
      {
        ...request(),
        capabilityMode: "tool-free",
        agent: { ...reviewer, readOnly: true, allowedTools: [], tools: [] },
        allowedTools: [],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(expected);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(fake.disposeSpy).toHaveBeenCalledOnce();
  });

  it("records agent-mode active tools without imposing an empty registry", async () => {
    const fake = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "Agent answer.",
      activeToolNames: ["read", "bash"],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session: fake.session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });
    const result = await executor.run(
      { ...requestWithSystemPrompt(), capabilityMode: "agent" },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ activeToolNames: ["read", "bash"] });
    expect(result).not.toHaveProperty("capabilityMode");
  });

  it("blocks direct nested agent tools even when the child profile allows every tool", async () => {
    const { session } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "Wildcard child answer." });
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      createSession: async (options) => {
        capturedOptions = options;
        return { session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(
      {
        ...requestWithSystemPrompt(),
        agent: { ...reviewer, readOnly: false, allowedTools: ["*"], tools: ["*"] },
        allowedTools: ["*"],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(capturedOptions?.tools).toBeUndefined();
    expect(capturedOptions?.excludeTools).toEqual(["spawn_agent"]);
    expect(capturedOptions?.excludeTools).not.toContain("workflow");
    // "All tools" is never a bare claim: the receipt names what is still excluded.
    expect(result.diagnostics).toEqual(
      expect.arrayContaining(['Tool access "*" means every host tool except: spawn_agent.']),
    );
  });

  it('names the stacked exclusions in the capability receipt of a tools:["*"] child', async () => {
    const { session } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "Wide answer." });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(
      {
        ...requestWithSystemPrompt(),
        agent: { ...reviewer, readOnly: false, allowedTools: ["*"], tools: ["*"] },
        allowedTools: ["*"],
        additionalExcludeTools: ["ask"],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining(['Tool access "*" means every host tool except: ask, spawn_agent.']),
    );
  });

  it("enforces read-only child capabilities and rejects Git mutations without a shell", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-read-only-agent-"));
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(path.join(root, "tracked.txt"), "candidate\n", "utf8");
    const { session } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "Read-only answer." });
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      createSession: async (options) => {
        capturedOptions = options;
        return { session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(
      {
        ...request(),
        projectRoot: root,
        workingDirectory: root,
        allowedTools: ["read", "git_read", "grep", "find", "bash", "write", "edit", "workflow", "unknown"],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(capturedOptions?.tools).toEqual(["read", "git_read", "grep", "find"]);
    expect(capturedOptions?.excludeTools).toEqual(
      expect.arrayContaining(["spawn_agent", "workflow", "bash", "edit", "write", "unknown"]),
    );
    expect(capturedOptions?.tools).not.toEqual(expect.arrayContaining(["bash", "write", "edit", "workflow"]));

    const gitRead = capturedOptions?.customTools?.find((tool) => tool.name === "git_read");
    expect(gitRead).toBeDefined();
    const readResult = await gitRead!.execute(
      "read-status",
      { args: ["status", "--short"] },
      new AbortController().signal,
    );
    expect(readResult.isError).not.toBe(true);
    expect(readResult.content[0]?.text).toContain("tracked.txt");

    const mutationResult = await gitRead!.execute(
      "blocked-checkout",
      { args: ["checkout", "-b", "forbidden"] },
      new AbortController().signal,
    );
    expect(mutationResult).toMatchObject({ isError: true, details: { blocked: true } });
    expect(mutationResult.content[0]?.text).toContain("blocks mutating or unsupported subcommand: checkout");
    const externalProcessResult = await gitRead!.execute(
      "blocked-pager",
      { args: ["grep", "--open-files-in-pager", "candidate"] },
      new AbortController().signal,
    );
    expect(externalProcessResult).toMatchObject({ isError: true, details: { blocked: true } });
    expect(externalProcessResult.content[0]?.text).toContain("external-process options");
    expect(execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim()).not.toBe(
      "forbidden",
    );
  });

  it("offers ast_index only when requested and blocks its destructive commands", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-ast-index-agent-"));
    const { session } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "Read-only answer." });
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      createSession: async (options) => {
        capturedOptions = options;
        return { session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    await executor.run(
      { ...request(), projectRoot: root, workingDirectory: root, allowedTools: ["read", "grep", "find"] },
      new AbortController().signal,
    );
    expect(capturedOptions?.customTools?.some((tool) => tool.name === "ast_index")).not.toBe(true);

    await executor.run(
      {
        ...request(),
        projectRoot: root,
        workingDirectory: root,
        allowedTools: ["read", "ast_index", "grep", "find", "bash"],
      },
      new AbortController().signal,
    );

    expect(capturedOptions?.tools).toEqual(["read", "ast_index", "grep", "find"]);
    expect(capturedOptions?.excludeTools).toEqual(expect.arrayContaining(["bash", "write", "edit"]));
    const astIndex = capturedOptions?.customTools?.find((tool) => tool.name === "ast_index");
    expect(astIndex).toBeDefined();

    for (const [args, expected] of [
      [["clear"], "blocks destructive or unsupported command: clear"],
      [["watch"], "blocks destructive or unsupported command: watch"],
      [["symbol; rm -rf /"], "blocks destructive or unsupported command"],
      [["search", "--output=/tmp/out.txt", "run"], "blocks output-file options"],
    ] as Array<[string[], string]>) {
      const blockedResult = await astIndex!.execute("blocked", { args }, new AbortController().signal);
      expect(blockedResult, args.join(" ")).toMatchObject({ isError: true, details: { blocked: true } });
      expect(blockedResult.content[0]?.text, args.join(" ")).toContain(expected);
    }

    const missingArgs = await astIndex!.execute("bad-input", { command: "symbol" }, new AbortController().signal);
    expect(missingArgs).toMatchObject({ isError: true, details: { blocked: true } });
    expect(missingArgs.content[0]?.text).toContain("ast_index requires one `args` string array.");
  });

  it("returns a blocked result with the unavailable diagnostic when the host is too old", async () => {
    const createSession: CreateAgentSessionFactory = async () => {
      throw new AgentSdkUnavailableError("Installed Pi host does not export createAgentSession (host too old).");
    };
    const executor = createAgentSdkSessionExecutor({
      createSession,
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      live: { rowId: "unavailable-row", label: "unavailable" },
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toContain(AGENT_SDK_UNAVAILABLE_DIAGNOSTIC);
    expect(result.reason).toContain("host too old");
    expect(agentLiveStore.rows.get("unavailable-row")).toMatchObject({
      status: "error",
      finalAnswer: expect.stringContaining("host too old"),
      errors: [expect.stringContaining("host too old")],
    });
  });

  it("fails honestly when child session creation throws a non-substrate error", async () => {
    const createSession: CreateAgentSessionFactory = async () => {
      throw new Error("boom");
    };
    const executor = createAgentSdkSessionExecutor({
      createSession,
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      live: { rowId: "create-failure-row", label: "create failure" },
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("boom");
    // The stale M11 replacement-session text must never appear on this path.
    expect(JSON.stringify(result)).not.toContain("replacement-session");
    // No child was ever created, so no child evidence is attached and the dispose
    // path (guarded by disposeQuietly) is never reached — the throw is the result.
    expect(result.childSession).toBeUndefined();
    expect(result.childOutputStats).toBeUndefined();
    expect(agentLiveStore.rows.get("create-failure-row")).toMatchObject({
      status: "error",
      finalAnswer: "boom",
      errors: ["boom"],
    });
  });

  it("cancels before creating a child session when the signal is already aborted", async () => {
    const createSession = vi.fn<CreateAgentSessionFactory>();
    const executor = createAgentSdkSessionExecutor({
      createSession: createSession as unknown as CreateAgentSessionFactory,
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.run(request(), controller.signal);

    expect(result.status).toBe("cancelled");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("cancels without prompting when the signal aborts during session creation", async () => {
    // The abort lands while createSession() is in flight: the child must be
    // disposed and the run cancelled WITHOUT ever prompting a turn.
    const { session, disposeSpy } = fakeSession({ toolCalls: 9, toolResults: 9, lastAssistantText: undefined });
    const promptSpy = vi.spyOn(session, "prompt");
    const controller = new AbortController();
    const createSession: CreateAgentSessionFactory = async () => {
      controller.abort(); // signal flips between creation and prompting
      return { session };
    };
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(request(), controller.signal);

    expect(result.status).toBe("cancelled");
    expect(result.reason).toContain("before child session kickoff");
    expect(promptSpy).not.toHaveBeenCalled();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the child turn exceeds its timeout instead of hanging", async () => {
    // prompt() resolves but agent_end never fires: only the timeout can end the turn.
    const { session, disposeSpy, abortSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      neverEnds: true,
    });
    const createSession: CreateAgentSessionFactory = async () => ({ session });
    const executor = createAgentSdkSessionExecutor({
      createSession,
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      childTimeoutMs: 5, // times out fast: the whole child gets 5 ms
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("budget and was aborted");
    expect(abortSpy).toHaveBeenCalledTimes(1); // child was force-stopped
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { maxTurns: 20, cycles: 20, status: "completed" },
    { maxTurns: 20, cycles: 21, status: "failed" },
    { maxTurns: 1000, cycles: 25, status: "completed" },
    { maxTurns: 1000, cycles: 1000, status: "completed" },
    { maxTurns: 1000, cycles: 1001, status: "failed" },
  ])("enforces $maxTurns assistant cycles on plain text ($cycles cycles)", async ({ maxTurns, cycles, status }) => {
    const { session, abortSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "Review complete.",
      events: Array.from({ length: cycles }, () => [
        { type: "turn_start" },
        { type: "message_start", message: { role: "assistant" } },
      ]).flat(),
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      childTimeoutMs: 1000,
    });
    const result = await executor.run({ ...request(), maxTurns }, new AbortController().signal);
    expect(result.status).toBe(status);
    if (status === "failed") {
      expect(result.failureCause).toBe("assistant-turn-budget");
      expect(abortSpy).toHaveBeenCalledOnce();
      expect(result.text).toBeUndefined();
    } else {
      expect(result.text).toBe("Review complete.");
      expect(abortSpy).not.toHaveBeenCalled();
    }
  });

  it("does not multiply the deadline by the turn count any more", async () => {
    // The former `turnTimeoutMs * maxTurns` turned a legal per-turn value into an
    // unrepresentable product and refused the child before it started. One number
    // in, one deadline out: the same inputs now simply run.
    const { session } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "done" });
    const createSession = vi.fn<CreateAgentSessionFactory>(async () => ({ session }));
    const executor = createAgentSdkSessionExecutor({
      createSession,
      reportsDir: tmpReportsDir(),
      childTimeoutMs: 2_147_483_647,
    });
    const result = await executor.run({ ...request(), maxTurns: 2 }, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("honours a deadline longer than one Node timer as a chain of representable waits", async () => {
    // 48 hours. A single `setTimeout` would clamp this to 1 ms and abort the child
    // immediately, which is exactly the failure the chain removes.
    const { session, abortSpy } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "done" });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      childTimeoutMs: 48 * 60 * 60 * 1000,
    });
    const result = await executor.run(request(), new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the child starts a tool call beyond its configured budget", async () => {
    const { session, disposeSpy, abortSpy } = fakeSession({
      toolCalls: 4,
      toolResults: 3,
      lastAssistantText: undefined,
      neverEnds: true,
      events: [
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_start", toolName: "bash" },
      ],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      childTimeoutMs: 60_000,
      maxToolCalls: 3,
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("exceeded the 3 tool-call budget");
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses the over-budget tool call before it runs, not after", async () => {
    // Counting `tool_execution_start` and then aborting told the host a budget had been
    // breached only once the child had already taken the action — Pi emits that event
    // before the tool is prepared, so the (N+1)-th `bash` could still execute while the
    // abort was in flight. Pi's agent loop exposes a pre-dispatch admission hook, so the
    // refusal now happens there: the extra call never runs, and the named budget stop and
    // the evidence already gathered are exactly what they were.
    const executed: string[] = [];
    const blocked: (string | undefined)[] = [];
    const hooks: {
      beforeToolCall?: (
        context: unknown,
        signal?: AbortSignal,
      ) => Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined>;
    } = {};
    const { session, abortSpy } = fakeSession({
      toolCalls: 3,
      toolResults: 2,
      lastAssistantText: undefined,
      neverEnds: true,
    });
    Object.defineProperty(session, "agent", { value: hooks });
    const listeners: ((event: SdkAgentSessionEventLike) => void)[] = [];
    vi.spyOn(session, "subscribe").mockImplementation((fn) => {
      listeners.push(fn);
      return () => {
        listeners.splice(listeners.indexOf(fn), 1);
      };
    });
    vi.spyOn(session, "prompt").mockImplementation(async () => {
      for (const id of ["t1", "t2", "t3"]) {
        // Pi's own order: the start event is emitted, THEN the call is prepared and the
        // admission hook decides whether it may run.
        for (const listener of [...listeners]) listener({ type: "tool_execution_start", toolName: "bash" });
        const decision = await hooks.beforeToolCall?.({ toolCall: { id, name: "bash" }, args: {} });
        if (decision?.block === true) {
          blocked.push(decision.reason);
          break;
        }
        executed.push(id);
      }
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      childTimeoutMs: 60_000,
      maxToolCalls: 2,
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(executed).toEqual(["t1", "t2"]);
    expect(blocked).toEqual([expect.stringContaining("2 tool-call budget")]);
    expect(result.status).toBe("failed");
    expect(result.failureCause).toBe("tool-call-budget");
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps enforcing the tool budget on a host that exposes no admission hook", async () => {
    // The fallback stays exactly as it was: no loop object, no veto, and the budget is
    // still enforced by counting and aborting — one action late, and now documented.
    const { session } = fakeSession({
      toolCalls: 3,
      toolResults: 2,
      lastAssistantText: undefined,
      neverEnds: true,
      events: [
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_start", toolName: "bash" },
      ],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      childTimeoutMs: 60_000,
      maxToolCalls: 2,
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.failureCause).toBe("tool-call-budget");
  });

  it("ends the loop before the turn that would exceed the assistant-turn budget", async () => {
    const stopDecisions: boolean[] = [];
    const hooks: {
      shouldStopAfterTurn?: (context: unknown, signal?: AbortSignal) => boolean | Promise<boolean>;
    } = {};
    const { session } = fakeSession({
      toolCalls: 1,
      toolResults: 1,
      lastAssistantText: undefined,
      neverEnds: true,
    });
    Object.defineProperty(session, "agent", { value: hooks });
    const listeners: ((event: SdkAgentSessionEventLike) => void)[] = [];
    vi.spyOn(session, "subscribe").mockImplementation((fn) => {
      listeners.push(fn);
      return () => {
        listeners.splice(listeners.indexOf(fn), 1);
      };
    });
    vi.spyOn(session, "prompt").mockImplementation(async () => {
      for (let turn = 0; turn < 5; turn += 1) {
        for (const listener of [...listeners]) listener({ type: "turn_start" });
        const stop = await hooks.shouldStopAfterTurn?.({ toolResults: [{ role: "toolResult" }] });
        stopDecisions.push(stop === true);
        if (stop === true) break;
      }
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      childTimeoutMs: 60_000,
    });

    const result = await executor.run({ ...request(), maxTurns: 2 }, new AbortController().signal);

    // Two turns generated, and the third never started.
    expect(stopDecisions).toEqual([false, true]);
    expect(result.status).toBe("failed");
    expect(result.failureCause).toBe("assistant-turn-budget");
  });

  it("lets a final turn end on its own instead of calling it a turn-budget stop", async () => {
    const hooks: {
      shouldStopAfterTurn?: (context: unknown, signal?: AbortSignal) => boolean | Promise<boolean>;
    } = {};
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "done",
      neverEnds: true,
    });
    Object.defineProperty(session, "agent", { value: hooks });
    const listeners: ((event: SdkAgentSessionEventLike) => void)[] = [];
    vi.spyOn(session, "subscribe").mockImplementation((fn) => {
      listeners.push(fn);
      return () => {
        listeners.splice(listeners.indexOf(fn), 1);
      };
    });
    vi.spyOn(session, "prompt").mockImplementation(async () => {
      for (const listener of [...listeners]) listener({ type: "turn_start" });
      // A turn with no tool results: the agent loop was going to stop anyway.
      const stop = await hooks.shouldStopAfterTurn?.({ toolResults: [] });
      expect(stop).toBe(false);
      for (const listener of [...listeners]) listener({ type: "agent_end", willRetry: false });
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      childTimeoutMs: 60_000,
    });

    const result = await executor.run({ ...request(), maxTurns: 1 }, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("done");
  });

  it("aborts an in-flight child turn when the signal fires mid-run", async () => {
    // The turn is in flight (prompt() entered, no agent_end yet) when the caller
    // aborts. The abort is fired from inside prompt() so it lands AFTER the
    // pre-kickoff guard and is handled by the abort branch of the turn race.
    const controller = new AbortController();
    const { session, disposeSpy, abortSpy } = fakeSession({
      toolCalls: 1,
      toolResults: 1,
      lastAssistantText: undefined,
      neverEnds: true,
    });
    vi.spyOn(session, "prompt").mockImplementation(async () => {
      controller.abort();
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      childTimeoutMs: 60_000, // long enough that the abort, not the timeout, wins
    });

    const result = await executor.run(request(), controller.signal);

    expect(result.status).toBe("cancelled");
    expect(result.reason).toBe("Agent run was cancelled.");
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("routes a selected live-row stop through the child AbortController", async () => {
    agentLiveStore.reset();
    let wallNow = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    try {
      const { session, disposeSpy, abortSpy } = fakeSession({
        toolCalls: 1,
        toolResults: 1,
        lastAssistantText: undefined,
        neverEnds: true,
      });
      const executor = createAgentSdkSessionExecutor({
        createSession: async () => ({ session }),
        reportsDir: tmpReportsDir(),
        now: () => "fixed",
        childTimeoutMs: 60_000,
        live: { rowId: "fleet-cancel-row", label: "cancel me" },
      });

      const running = executor.run(request(), new AbortController().signal);
      await vi.waitFor(() => {
        expect(agentLiveStore.rows.get("fleet-cancel-row")?.status).toBe("working");
      });
      agentLiveStore.patch("fleet-cancel-row", {
        startedAt: 1_000,
        currentTools: ["bash"],
        currentToolArgs: '{"command":"sleep 60"}',
        currentToolStartMs: 1_000,
      });

      wallNow = 10_000;
      expect(agentLiveStore.cancel("fleet-cancel-row")).toBe(true);
      const result = await running;

      expect(result.status).toBe("cancelled");
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(agentLiveStore.rows.get("fleet-cancel-row")).toMatchObject({
        status: "cancelled",
        currentTools: [],
        finalAnswer: "Agent run was cancelled.",
        elapsedMs: 9_000,
      });
      const terminalRow = agentLiveStore.rows.get("fleet-cancel-row")!;
      expect("currentToolArgs" in terminalRow).toBe(false);
      expect("currentToolStartMs" in terminalRow).toBe(false);
      wallNow = 70_000;
      expect(formatDuration(terminalRow.elapsedMs ?? elapsedSinceStart(terminalRow))).toBe("9s");
      expect(agentLiveStore.cancel("fleet-cancel-row")).toBe(false);
    } finally {
      clock.mockRestore();
      agentLiveStore.reset();
    }
  });

  it("fails honestly when prompt() rejects (e.g. transport/credential failure)", async () => {
    // Mirrors the live-host reality: createAgentSession spawns, but prompt() rejects
    // with "No API key found ..." — that is a genuine run failure, never fake success.
    const { session, disposeSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      promptError: "No API key found for deepseek.",
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("No API key found");
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The executed model, at the host boundary.
 *
 * The bridge-level cases live in `tests/extensions/workflows/runtime/workflow-model-tiers.test.ts`;
 * these two prove the two halves that only this layer can prove — that the option
 * object handed to `createSession` carries the exact model, and that the value the
 * result reports is READ BACK from the session rather than the request repeated.
 */
describe("executed-model readback", () => {
  const FAST = { provider: "test", id: "fast", name: "Test Fast" };
  const STRONG = { provider: "test", id: "strong", name: "Test Strong" };

  it("hands createSession the exact model object and reports the session's own model back", async () => {
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "done",
      model: FAST,
      thinkingLevel: "medium",
    });
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      model: FAST,
      thinkingLevel: "high",
      createSession: async (options) => {
        capturedOptions = options;
        return { session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("completed");
    // By value: `toBeTruthy()` would pass on any model at all.
    expect(capturedOptions?.model).toEqual(FAST);
    expect(capturedOptions?.thinkingLevel).toBe("high");
    expect(result.executedModel).toBe("test/fast");
    expect(result.executedThinking).toBe("medium");
  });

  it("fails closed when the session's model contradicts the requested one", async () => {
    const { session, disposeSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "done",
      model: STRONG,
    });
    let prompted = false;
    const promptingSession = {
      ...session,
      async prompt(text: string, options?: { source?: string }) {
        prompted = true;
        return session.prompt(text, options);
      },
    } satisfies SdkAgentSessionLike;
    const executor = createAgentSdkSessionExecutor({
      model: FAST,
      createSession: async () => ({ session: promptingSession }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("test/strong");
    expect(result.reason).toContain("test/fast");
    expect(prompted).toBe(false);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    // Mismatch is explained in the reason, not published as executed evidence.
    expect(result.executedModel).toBeUndefined();
    expect(result.reason).toContain("did not honour the selected model");
  });

  it("publishes no executed model when the run is cancelled before child kickoff", async () => {
    const controller = new AbortController();
    const { session, disposeSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "done",
      model: FAST,
    });
    let prompted = false;
    const promptingSession = {
      ...session,
      async prompt(text: string, options?: { source?: string }) {
        prompted = true;
        return session.prompt(text, options);
      },
    } satisfies SdkAgentSessionLike;
    const executor = createAgentSdkSessionExecutor({
      model: FAST,
      // Abort while createSession is in flight: the session is real, the child is not.
      createSession: async () => {
        controller.abort();
        return { session: promptingSession };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      live: { rowId: "pre-kickoff-row", label: "pre kickoff", model: "test/fast" },
    });

    const result = await executor.run(request(), controller.signal);

    expect(result.status).toBe("cancelled");
    expect(prompted).toBe(false);
    expect(result.childSession?.id).toBe(session.sessionId);
    expect(result.executedModel).toBeUndefined();
    const row = agentLiveStore.rows.get("pre-kickoff-row");
    expect(row?.status).toBe("cancelled");
    expect(row?.model).toBeUndefined();
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("publishes no executed model when the transport rejects the prompt", async () => {
    const { session, disposeSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      model: FAST,
      promptError: "No API key found for deepseek.",
    });
    const executor = createAgentSdkSessionExecutor({
      model: FAST,
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      live: { rowId: "prompt-rejected-row", label: "prompt rejected", model: "test/fast" },
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("No API key found");
    expect(result.executedModel).toBeUndefined();
    const row = agentLiveStore.rows.get("prompt-rejected-row");
    expect(row?.status).toBe("error");
    expect(row?.model).toBeUndefined();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("publishes no executed model when cancellation beats the prompt into the transport", async () => {
    // The third way out without a turn, and the one that still returns normally rather
    // than throwing: the operator cancels while `prompt()` is in flight, the transport
    // never acknowledges, and no child event ever arrives. `driveChildTurn` settles on
    // `aborted` with the dispatch unconfirmed — so the settlement alone cannot be the
    // gate, and `promptAccepted` is what keeps this call out of the execution evidence.
    const controller = new AbortController();
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      model: FAST,
    });
    const hangingPrompt = {
      ...session,
      async prompt() {
        controller.abort();
        await new Promise<void>(() => {});
      },
    } satisfies SdkAgentSessionLike;
    const executor = createAgentSdkSessionExecutor({
      model: FAST,
      createSession: async () => ({ session: hangingPrompt }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      live: { rowId: "abort-in-flight-row", label: "abort in flight", model: "test/fast" },
    });

    const result = await executor.run(request(), controller.signal);

    expect(result.status).toBe("cancelled");
    expect(result.executedModel).toBeUndefined();
    expect(agentLiveStore.rows.get("abort-in-flight-row")?.model).toBeUndefined();
  });

  it("publishes no executed model when the child subscription throws before dispatch", async () => {
    // The other way out of `driveChildTurn` without a turn: `subscribe()` throws, so
    // the prompt is never sent. Same rule, different mechanism — no dispatch, no
    // execution evidence, and no model left on the row.
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "done",
      model: FAST,
    });
    const brokenSubscription = {
      ...session,
      subscribe() {
        throw new Error("event subscription failed");
      },
    } satisfies SdkAgentSessionLike;
    const executor = createAgentSdkSessionExecutor({
      model: FAST,
      createSession: async () => ({ session: brokenSubscription }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      live: { rowId: "subscribe-failed-row", label: "subscribe failed", model: "test/fast" },
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("event subscription failed");
    expect(result.executedModel).toBeUndefined();
    expect(agentLiveStore.rows.get("subscribe-failed-row")?.model).toBeUndefined();
  });

  it("records `unavailable` rather than echoing the requested selector", async () => {
    const { session } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "done" });
    const executor = createAgentSdkSessionExecutor({
      model: FAST,
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.executedModel).toBe("unavailable");
    expect(result.executedModel).not.toBe("test/fast");
  });

  const terminalPaths = [
    ["done", "done", "completed", {}],
    ["unparseable-answer", "error", "failed", { lastAssistantText: " " }],
    ["provider-error", "error", "failed", { messages: [{ role: "assistant", content: [], stopReason: "error" }] }],
    ["cancelled", "cancelled", "cancelled", { lastAssistantText: undefined, neverEnds: true }],
  ] as const;
  it.each(
    terminalPaths.flatMap(([path, rowStatus, resultStatus, turn]) => [
      [
        path,
        "fast medium",
        rowStatus,
        resultStatus,
        turn,
        { model: FAST, thinkingLevel: "medium" as const },
        "test/fast",
        "medium",
      ],
      [path, "strong", rowStatus, resultStatus, turn, {}, "test/strong", undefined],
    ]),
  )(
    "badges a %s row from readback: %s",
    async (_path, badge, rowStatus, resultStatus, turn, readback, model, thinking) => {
      agentLiveStore.reset();
      const controller = new AbortController();
      const anchor = agentLiveStore.begin({ id: "workflow:run:w:step:x", label: "anchor", model: "test/strong" });
      const { session } = fakeSession({
        toolCalls: 0,
        toolResults: 0,
        lastAssistantText: "done",
        ...turn,
        ...readback,
        ...(_path === "cancelled" ? { onPrompt: () => controller.abort() } : {}),
      });
      const executor = createAgentSdkSessionExecutor({
        model: FAST,
        thinkingLevel: "high",
        createSession: async () => ({ session }),
        reportsDir: tmpReportsDir(),
        now: () => "fixed",
        live: { rowId: "row", parentRowId: anchor.id, label: "child", model: "test/strong", thinking: "high" },
      });

      const result = await executor.run(request(), controller.signal);

      const row = agentLiveStore.rows.get("row");
      expect(result.status).toBe(resultStatus);
      expect([row?.status, row?.model, row?.thinking]).toEqual([rowStatus, model, thinking]);
      expect(compactWorkflowParentRows([...agentLiveStore.rows.values()]).map(formatModelBadge)).toEqual([badge]);
    },
  );

  it("clears the row's requested model when the session was never created", async () => {
    // A terminal row must not retain a requested model that never ran.
    const executor = createAgentSdkSessionExecutor({
      model: FAST,
      createSession: async () => {
        throw new Error("create failed");
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      live: { rowId: "create-failed-row", label: "create failed", model: "test/fast" },
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.executedModel).toBeUndefined();
    const row = agentLiveStore.rows.get("create-failed-row");
    expect(row?.status).toBe("error");
    expect(row?.model).toBeUndefined();
    expect(row?.request).toBe("Review this change");
  });

  it("bounds the request retained for the live viewer and reports omitted characters", async () => {
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => {
        throw new Error("create failed");
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      live: { rowId: "bounded-request-row", label: "bounded request" },
    });

    await executor.run({ ...request(), task: "x".repeat(32_125) }, new AbortController().signal);

    const retained = agentLiveStore.rows.get("bounded-request-row")?.request;
    expect(retained?.startsWith("x".repeat(32_000))).toBe(true);
    expect(retained).toContain("… 125 additional request character(s) omitted");
    expect(retained?.length).toBeLessThan(32_125);
  });

  it("leaves no model on the row when the call fails closed on a mismatch", async () => {
    // A pre-prompt mismatch names both selectors in the error but shows neither as executed.
    const { session } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "done", model: STRONG });
    const executor = createAgentSdkSessionExecutor({
      model: FAST,
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      live: { rowId: "mismatch-row", label: "mismatch", model: "test/fast" },
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("test/strong");
    expect(result.reason).toContain("test/fast");
    const row = agentLiveStore.rows.get("mismatch-row");
    expect(row?.status).toBe("error");
    expect(row?.model).toBeUndefined();
  });
});
