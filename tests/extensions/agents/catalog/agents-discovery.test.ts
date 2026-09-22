import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import { discoverAgentDefinitions, parseAgentMarkdown } from "../../../../extensions/_shared/agent-runtime/agents.js";
import type { ExtensionCommandContext } from "../../../../extensions/_shared/host/pi-api.js";
import { createHarness, runTool } from "../../../test-harness.js";

// Force the SDK host absent so the `task` tool degrades deterministically to the
// honest fail-closed surface instead of attempting a real network-backed child.
vi.mock("@earendil-works/pi-coding-agent", () => ({}));

const tempRoots: string[] = [];

beforeEach(() => {
  vi.stubEnv("HOME", tempRoot("locus-pi-agents-home"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = path.join(tmpdir(), `${prefix}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function writeAgent(root: string, relativeDir: string, fileName: string, body: string): void {
  const dir = path.join(root, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), body);
}

describe("agents discovery", () => {
  it("parses valid markdown agent definitions", () => {
    const parsed = parseAgentMarkdown(
      [
        "---",
        "name: reviewer",
        "description: Review code",
        "tools: read, search",
        "spawns: explore",
        "model: pi/slow",
        "thinking-level: high",
        "blocking: true",
        "---",
        "Review carefully.",
      ].join("\n"),
      "project",
      "/repo/.agents/agents/reviewer.md",
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.definition).toMatchObject({
      name: "reviewer",
      description: "Review code",
      allowedTools: ["read", "search", "yield"],
      spawns: ["explore"],
      model: ["pi/slow"],
      thinkingLevel: "high",
      blocking: true,
      source: "project",
      readOnly: true,
    });
  });

  it("parses permissionMode metadata", () => {
    const parsed = parseAgentMarkdown(
      [
        "---",
        "name: restricted-reviewer",
        "description: Review code with restricted permissions",
        "tools: read, search",
        "permissionMode: restricted",
        "---",
        "Review carefully.",
      ].join("\n"),
      "project",
      "/repo/.agents/agents/restricted-reviewer.md",
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.definition).toMatchObject({
      name: "restricted-reviewer",
      permissionMode: "restricted",
      readOnly: true,
    });
  });

  it("reports invalid permissionMode metadata", () => {
    const parsed = parseAgentMarkdown(
      "---\nname: reviewer\ndescription: Review code\npermissionMode: sandboxed\n---\nReview.",
      "project",
      "/repo/reviewer.md",
    );

    expect(parsed.definition).toBeDefined();
    expect(parsed.definition?.permissionMode).toBeUndefined();
    expect(parsed.diagnostics).toEqual([
      {
        filePath: "/repo/reviewer.md",
        message: "frontmatter.permissionMode must be one of: inherit-parent, agent-defined, restricted",
      },
    ]);
  });

  it("reports invalid frontmatter diagnostics", () => {
    const missingFrontmatter = parseAgentMarkdown("No frontmatter", "project", "/repo/bad.md");
    const missingName = parseAgentMarkdown("---\ndescription: Missing name\n---\nBody", "project", "/repo/missing.md");

    expect(missingFrontmatter.diagnostics).toEqual([{ filePath: "/repo/bad.md", message: "missing frontmatter" }]);
    expect(missingName.diagnostics).toEqual([
      { filePath: "/repo/missing.md", message: "frontmatter.name is required" },
    ]);
    expect(missingName.definition).toBeUndefined();
  });

  it("discovers project definitions before user definitions", () => {
    const project = tempRoot("locus-pi-agents-project");
    const userHome = tempRoot("locus-pi-agents-user");
    writeAgent(
      project,
      ".agents/agents",
      "reviewer.md",
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read\n---\nProject.",
    );
    writeAgent(
      userHome,
      ".agents/agents",
      "reviewer.md",
      "---\nname: reviewer\ndescription: User reviewer\ntools: bash\n---\nUser.",
    );
    const discovered = discoverAgentDefinitions(project, { userHome });

    expect(discovered.definitions.map((agent) => `${agent.name}:${agent.description}:${agent.source}`)).toEqual([
      "reviewer:Project reviewer:project",
    ]);
  });

  it("lists and inspects definitions while task execution falls back closed when the SDK host is absent", async () => {
    const project = tempRoot("locus-pi-agents-command");
    writeAgent(
      project,
      ".agents/agents",
      "reviewer.md",
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read\nrisk: medium\n---\nProject.",
    );
    const h = createHarness(project);
    agents(h.pi);

    await h.commands.get("agent")!.handler("list", h.ctx);
    const list = h.widgets.get("agents") ?? "";
    const listOptions = h.widgetOptions.get("agents");
    await h.commands.get("agent")!.handler("inspect reviewer", h.ctx);
    const inspect = h.widgets.get("agents") ?? "";
    const inspectOptions = h.widgetOptions.get("agents");
    const runResult = await runTool(h, "spawn_agent", { agent: "reviewer", task: "Review this" });

    expect(list).toContain("[VIEW]");
    expect(list).toContain("Agent catalog");
    expect(list).toContain("loaded definition(s)");
    expect(list).toContain("reviewer [project] · Project reviewer");
    expect(list).toContain("Project reviewer");
    expect(list).not.toContain("definition(s) hidden");
    expect(list.split(/\r?\n/).length).toBeLessThanOrEqual(18);
    expect(list.split(/\r?\n/).every((line) => line.length <= 80)).toBe(true);
    expect(list).not.toContain("widget truncated");
    expect(listOptions).toEqual({ placement: "belowEditor" });
    expect(inspectOptions).toEqual({ placement: "belowEditor" });
    expect(inspect).toContain("source: project");
    expect(inspect).toContain("risk: medium");
    expect(runResult.isError).toBe(true);
    expect(runResult.details).toMatchObject({
      owner: "agents-runtime",
      requestedSurface: "spawn_agent",
      hostCapability: "agent-sdk-session-unavailable",
      toolExecutorAvailable: false,
    });
    // The honest fail-closed surface must not resurrect the stale M11 /
    // replacement-session metadata for a createAgentSession substrate gap.
    expect(JSON.stringify(runResult.details)).not.toContain("M11");
    expect(JSON.stringify(runResult.details)).not.toContain("replacement-session");
    const runText = runResult.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(runText).toContain("cannot spawn the requested child session");
    expect(runText).not.toContain("replacement session");
  });

  it("uses bare execution when omitted and treats default/general as exact names", async () => {
    const project = tempRoot("locus-pi-agents-default-resolution");
    const h = createHarness(project);
    agents(h.pi);

    const omitted = await runTool(h, "spawn_agent", { task: "Run default" });
    const defaultAlias = await runTool(h, "spawn_agent", { agent: "default", task: "Run default" });
    const generalAlias = await runTool(h, "spawn_agent", { agent: "general", task: "Run general" });

    expect(omitted.details).toMatchObject({ executionMode: "bare" });
    expect(defaultAlias.details).toMatchObject({ requestedAgent: "default", errorCode: "unknown-agent" });
    expect(generalAlias.details).toMatchObject({ requestedAgent: "general", errorCode: "unknown-agent" });
  });

  it("does not apply the general alias when a project/user general agent exists", async () => {
    const project = tempRoot("locus-pi-agents-general-override");
    writeAgent(
      project,
      ".agents/agents",
      "general.md",
      "---\nname: general\ndescription: Project general agent\ntools: read\n---\nProject general.",
    );
    const h = createHarness(project);
    agents(h.pi);

    const result = await runTool(h, "spawn_agent", { agent: "general", task: "Run general" });

    expect(result.details).toMatchObject({ requestedAgent: "general", agent: "general" });
    expect(result.details).not.toHaveProperty("aliasApplied");
  });

  it("returns human unknown-agent ToolResult details and writes a durable artifact", async () => {
    const project = tempRoot("locus-pi-agents-unknown");
    writeAgent(
      project,
      ".agents/agents",
      "reviewer.md",
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read\n---\nProject.",
    );
    const h = createHarness(project);
    agents(h.pi);

    const result = await runTool(h, "spawn_agent", { agent: "missing", task: "Run missing" });

    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(result.isError).toBe(true);
    expect(text).toContain('Unknown agent: "missing".');
    expect(text).toContain("Available agents:");
    expect(text).toContain("reviewer [project]");
    expect(text).toContain("Named agents come only from the project and user catalogs.");
    expect(text).toContain("Run /agent list");
    expect(result.details).toMatchObject({
      owner: "agents-catalog",
      requestedSurface: "spawn_agent",
      status: "blocked",
      errorCode: "unknown-agent",
      requestedAgent: "missing",
      hint: "/agent list",
    });
    const artifactPath = String(result.details?.artifactPath);
    expect(artifactPath).toBeTruthy();
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      content: string;
      metadata: Record<string, unknown>;
    };
    const content = JSON.parse(artifact.content) as Record<string, unknown>;
    expect(artifact.metadata).toMatchObject({
      source: "agents-catalog",
      requestedSurface: "spawn_agent",
      errorCode: "unknown-agent",
      requestedAgent: "missing",
    });
    expect(content).toMatchObject({
      version: "locus.agent.unknown-agent.v2",
      status: "blocked",
      requestedSurface: "spawn_agent",
      requestedAgent: "missing",
    });
  });

  it("registers spawn_agent as a model-friendly alias that routes through the same task surface", async () => {
    const project = tempRoot("locus-pi-agents-spawn-alias");
    writeAgent(
      project,
      ".agents/agents",
      "reviewer.md",
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read\n---\nProject.",
    );
    const h = createHarness(project);
    agents(h.pi);

    // One canonical tool is registered; the duplicate alias is absent.
    expect(h.tools.has("spawn_agent")).toBe(true);
    expect(h.tools.has("task")).toBe(false);

    const viaSpawn = await runTool(h, "spawn_agent", { agent: "missing", task: "Run missing" });

    expect(viaSpawn.isError).toBe(true);
    expect(viaSpawn.details).toMatchObject({
      owner: "agents-catalog",
      requestedSurface: "spawn_agent",
      status: "blocked",
      errorCode: "unknown-agent",
      requestedAgent: "missing",
    });
  });
});

describe("evidence policy", () => {
  it("agent without evidence block defaults to mode none", () => {
    const parsed = parseAgentMarkdown(
      "---\nname: reviewer\ndescription: Review code\n---\nReview.",
      "project",
      "/repo/reviewer.md",
    );

    expect(parsed.definition!.evidence!.mode).toBe("none");
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.message.includes("evidence"))).toEqual([]);
  });

  it("parses mode: none", () => {
    const parsed = parseAgentMarkdown(
      "---\nname: reviewer\ndescription: Review code\nevidence:\n  mode: none\n---\nReview.",
      "project",
      "/repo/reviewer.md",
    );

    expect(parsed.definition!.evidence!.mode).toBe("none");
  });

  it("parses mode: warn", () => {
    const parsed = parseAgentMarkdown(
      "---\nname: reviewer\ndescription: Review code\nevidence:\n  mode: warn\n---\nReview.",
      "project",
      "/repo/reviewer.md",
    );

    expect(parsed.definition!.evidence!.mode).toBe("warn");
  });

  it("parses mode: require", () => {
    const parsed = parseAgentMarkdown(
      "---\nname: reviewer\ndescription: Review code\nevidence:\n  mode: require\n---\nReview.",
      "project",
      "/repo/reviewer.md",
    );

    expect(parsed.definition!.evidence!.mode).toBe("require");
  });

  it("invalid evidence field warns but agent still loads", () => {
    const parsed = parseAgentMarkdown(
      "---\nname: reviewer\ndescription: Review code\nevidence:\n  bogus: 1\n---\nReview.",
      "project",
      "/repo/reviewer.md",
    );

    expect(parsed.definition).toBeDefined();
    expect(parsed.diagnostics.some((diagnostic) => /bogus|unknown field/.test(diagnostic.message))).toBe(true);
  });
});

describe("agent list/inspect rendering surface", () => {
  function writeManyAgents(project: string): void {
    for (let index = 0; index < 14; index += 1) {
      writeAgent(
        project,
        ".agents/agents",
        `proj-${index}.md`,
        `---\nname: proj-${index}\ndescription: Project agent ${index}\ntools: read\nrisk: medium\n---\nBody.`,
      );
    }
  }

  it("routes /agent list through the inline scroll surface (full catalog, untruncated) when custom UI is available", async () => {
    const project = tempRoot("locus-pi-agents-list-overlay");
    writeManyAgents(project);
    const h = createHarness(project);
    h.ctx.hasUI = true;
    h.customInputQueue.push("q");
    agents(h.pi);

    await h.commands.get("agent")!.handler("list", h.ctx as ExtensionCommandContext);

    expect(h.customOptions).toEqual([{ overlay: false }]);
    const frame = h.customRenderFrames[0]?.join("\n") ?? "";
    expect(frame).toContain("Agent catalog");
    expect(frame).toContain("proj-0");
    // The inline surface receives the FULL formatted catalog (no maxLines clip / "more:" stub).
    expect(frame).not.toContain("not shown");
    // Footer denominator is the full body length (>> the bounded 10-line cap),
    // proving the untruncated project catalog reached the overlay.
    const footer = h.customRenderFrames[0]?.find((line) => line.includes("q/esc close")) ?? "";
    const total = Number(/\/(\d+)/.exec(footer)?.[1] ?? "0");
    expect(total).toBeGreaterThanOrEqual(14);
    // A late project agent that the bounded passive path would hide is reachable by scrolling.
    const surface = h.customComponents.at(-1)!;
    let foundLateProjectAgent = false;
    await surface.handleInput!("home");
    for (let page = 0; page < 8; page += 1) {
      if (surface.render(80).join("\n").includes("proj-9")) foundLateProjectAgent = true;
      await surface.handleInput!("pageDown");
    }
    expect(foundLateProjectAgent).toBe(true);
    // Passive bounded widget must NOT be the surface used here.
    expect(h.widgets.get("agents") ?? "").not.toMatch(/more: \d+ agent\(s\) not shown/);
  });

  it("routes /agent inspect through the inline scroll surface when custom UI is available", async () => {
    const project = tempRoot("locus-pi-agents-inspect-overlay");
    writeAgent(
      project,
      ".agents/agents",
      "reviewer.md",
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read\nrisk: medium\n---\nProject.",
    );
    const h = createHarness(project);
    h.ctx.hasUI = true;
    h.customInputQueue.push("q");
    agents(h.pi);

    await h.commands.get("agent")!.handler("inspect reviewer", h.ctx as ExtensionCommandContext);

    expect(h.customOptions).toEqual([{ overlay: false }]);
    const frame = h.customRenderFrames[0]?.join("\n") ?? "";
    expect(frame).toContain("[VIEW] Agent definition");
    expect(frame).toContain("reviewer: Project reviewer");
    expect(frame).toContain("source: project");
    expect(frame).toContain("risk: medium");
  });

  it("does not open the overlay for an unknown inspect target (falls back to the bounded widget)", async () => {
    const project = tempRoot("locus-pi-agents-inspect-unknown");
    const h = createHarness(project);
    h.ctx.hasUI = true;
    agents(h.pi);

    await h.commands.get("agent")!.handler("inspect missing", h.ctx as ExtensionCommandContext);

    expect(h.customOptions).toEqual([]);
    expect(h.widgets.get("agents") ?? "").toContain("Unknown agent");
  });

  it("falls back to a plain string-array catalog in RPC mode", async () => {
    const project = tempRoot("locus-pi-agents-list-rpc");
    writeManyAgents(project);
    const h = createHarness(project, { mode: "rpc" });
    h.ctx.hasUI = true;
    agents(h.pi);

    await h.commands.get("agent")!.handler("list", h.ctx as ExtensionCommandContext);

    expect(h.customOptions).toEqual([]);
    const list = h.widgets.get("agents") ?? "";
    expect(Array.isArray(h.widgetPayloads.get("agents"))).toBe(true);
    expect(list).toContain("[VIEW] Agent catalog");
    expect(list).toContain("proj-0 [project] · Project agent 0");
    const loadedCount = Number(/^(\d+) loaded definition\(s\)\./mu.exec(list)?.[1] ?? "0");
    const hiddenCount = Number(/^\+(\d+) definition\(s\) hidden$/mu.exec(list)?.[1] ?? "0");
    expect(loadedCount).toBeGreaterThanOrEqual(14);
    expect(hiddenCount).toBe(loadedCount - 2);
    expect(list).toContain("Inspect: /agent inspect <name>");
    expect(list).not.toContain("widget truncated");
  });

  it("keeps inspect and unknown-agent recovery visible in bounded RPC output", async () => {
    const project = tempRoot("locus-pi-agents-inspect-rpc");
    writeAgent(
      project,
      ".agents/agents",
      "reviewer.md",
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read, grep\nrisk: medium\n---\nProject.",
    );
    const h = createHarness(project, { mode: "rpc" });
    h.ctx.hasUI = true;
    agents(h.pi);

    await h.commands.get("agent")!.handler("inspect reviewer", h.ctx as ExtensionCommandContext);
    const inspect = h.widgets.get("agents") ?? "";
    expect(Array.isArray(h.widgetPayloads.get("agents"))).toBe(true);
    expect(inspect).toContain("[VIEW] Agent definition");
    expect(inspect).toContain("Run: /agent run reviewer <task>");
    expect(inspect).not.toContain("widget truncated");

    await h.commands.get("agent")!.handler("inspect missing", h.ctx as ExtensionCommandContext);
    const unknown = h.widgets.get("agents") ?? "";
    expect(unknown).toContain("[ERROR] Agent catalog");
    expect(unknown).toContain("Recovery: /agent list");
    expect(unknown).not.toContain("widget truncated");
  });

  it("falls back to the bounded text widget for inspect when custom UI is unavailable", async () => {
    const project = tempRoot("locus-pi-agents-inspect-headless");
    writeAgent(
      project,
      ".agents/agents",
      "reviewer.md",
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read\nrisk: medium\n---\nProject.",
    );
    const h = createHarness(project);
    h.ctx.hasUI = true;
    delete h.ctx.ui.custom;
    agents(h.pi);

    await h.commands.get("agent")!.handler("inspect reviewer", h.ctx as ExtensionCommandContext);

    expect(h.customOptions).toEqual([]);
    const inspect = h.widgets.get("agents") ?? "";
    expect(inspect).toContain("source: project");
    expect(inspect).toContain("risk: medium");
  });
});
