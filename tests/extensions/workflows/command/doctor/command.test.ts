import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import workflows from "../../../../../extensions/workflows/index.js";
import { WORKFLOW_SKILL_NAMES, WORKFLOW_SKILL_STATE_FILE } from "../../../../../extensions/workflows/command/skills.js";
import { createHarness, emit } from "../../../../test-harness.js";

vi.mock("@earendil-works/pi-coding-agent", async (load) => ({
  ...(await load<typeof import("@earendil-works/pi-coding-agent")>()),
  highlightCode: (text: string) => text.split("\n"),
}));

const fixtureState = vi.hoisted(() => ({ fault: undefined as ((file: string) => void) | undefined }));
vi.mock(import("../../../../../extensions/workflows/command/skills.js"), async (load) => {
  const original = await load();
  return {
    ...original,
    operateWorkflowSkillHosts: (options) =>
      original.operateWorkflowSkillHosts({
        ...options,
        _testAtBoundary: (boundary, file) => {
          if (boundary === "before-readback") fixtureState.fault?.(file);
        },
      }),
  };
});

const roots: string[] = [];
afterEach(() => {
  fixtureState.fault = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(mode: "tui" | "rpc" = "rpc") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow-doctor-test-")));
  roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  const harness = createHarness(project, { mode });
  workflows(harness.pi);
  const run = (input: string) => harness.commands.get("workflows")!.handler(input, harness.ctx);
  const text = () => [...harness.notifications, harness.widgets.get("workflows") ?? ""].join("\n");
  return { root, home, project, harness, run, text };
}

describe("/workflows doctor", () => {
  it("shows an actionable Codex group when Claude's marker is invalid and exposes scoped details", async () => {
    const f = setup();
    const codex = path.join(f.home, ".agents", "skills");
    const claude = path.join(f.home, ".claude", "skills");
    mkdirSync(claude, { recursive: true });
    writeFileSync(path.join(claude, WORKFLOW_SKILL_STATE_FILE), "{");
    await f.run("doctor");
    expect(f.text()).toContain(codex);
    expect(f.text()).toContain(claude);
    expect(f.text()).toContain("0/4 links installed on disk");
    expect(f.text()).toContain("/workflows doctor install --host codex --scope user");
    expect(f.text()).toContain("/workflows doctor check --host claude --scope user");
    expect(existsSync(codex)).toBe(false);
    await f.run("doctor install --host all --scope user");
    expect(f.text()).toContain("Write refused");
    expect(existsSync(codex)).toBe(false);
    await f.run("doctor check --host codex --scope project");
    const scoped = f.harness.widgets.get("workflows")!;
    expect(scoped.replace(/\n/g, "")).toContain(path.join(f.project, ".agents", "skills"));
    expect(scoped).toContain("/workflows doctor install --host codex --scope project");
    expect(scoped).not.toContain("--host all --scope user");
  });

  it("refuses a project write if a dangling personal redirect would share its new root", async () => {
    const f = setup();
    const personal = path.join(f.home, ".agents");
    const project = path.join(f.project, ".agents");
    symlinkSync(project, personal, "dir");
    await f.run("doctor check --host codex --scope project");
    expect(f.text()).toContain("Shared destination");
    expect(f.text()).not.toContain("/workflows doctor install");
    await f.run("doctor install --host codex --scope project");
    expect(f.text()).toContain("Write refused");
    expect(existsSync(project)).toBe(false);
  });

  it("translates old writes into scoped advice without touching files and replaces help", async () => {
    const f = setup();
    const destination = path.join(f.project, ".agents");
    await f.run("skills sync --host codex --scope project");
    expect(f.text()).toContain("/workflows doctor install --host codex --scope project");
    expect(existsSync(destination)).toBe(false);
    await f.run("doctor install");
    expect(f.text()).toContain("Choose --host");
    expect(existsSync(path.join(f.home, ".agents"))).toBe(false);
    await f.run("");
    const help = f.harness.widgets.get("workflows")!;
    expect(help).toContain("/workflows doctor recovery");
    expect(help).not.toContain("/workflows skills");
  });

  it("shows the scoped manual recovery for an ambiguous live v1 claim", async () => {
    const f = setup();
    const root = path.join(f.project, ".agents", "skills");
    const skill = path.join(root, WORKFLOW_SKILL_NAMES[0]);
    const marker = path.join(root, WORKFLOW_SKILL_STATE_FILE);
    mkdirSync(root, { recursive: true });
    symlinkSync("/retired-package/skills/placeholder", skill, "dir");
    const original = JSON.stringify({
      owner: "@kroffske/locus-pi",
      schema: "locus-pi.workflow-skills.v1",
      links: [WORKFLOW_SKILL_NAMES[0]],
    });
    writeFileSync(marker, original);
    await f.run("doctor install --host codex --scope project");
    expect(f.text()).toContain("/workflows doctor check --host codex --scope project");
    expect(f.text()).toContain("backup outside this skills folder");
    expect(f.text().replace(/\n/g, "")).toContain(skill);
    expect(readFileSync(marker, "utf8")).toBe(original);
  });

  it("qualifies Claude's default path and the command when its override is separate", async () => {
    const f = setup();
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(f.root, "alternate"));
    await f.run("doctor check --host claude --scope user");
    expect(f.text()).toContain("Claude Code default folder (user)");
    expect(f.text()).toContain("Skill discovery with CLAUDE_CONFIG_DIR is unverified.");
    expect(f.text()).toContain(
      "Install or repair default folder: /workflows doctor install --host claude --scope user",
    );
    await f.run("skills remove --host claude");
    expect(f.text()).toContain("Remove from Claude Code default folder");
    expect(f.text()).toContain("/workflows doctor remove --host claude --scope user");
    expect(existsSync(path.join(f.root, "alternate"))).toBe(false);
  });

  it.each(["rpc", "tui"] as const)("retrieves full rollback in %s with session isolation", async (mode) => {
    const f = setup(mode);
    const installed = path.join(f.project, ".agents", "skills", WORKFLOW_SKILL_NAMES[0]);
    const foreign = path.join(path.dirname(installed), "replacement");
    fixtureState.fault = (file) => {
      if (file !== installed) return;
      symlinkSync("/different-target", foreign, "dir");
      renameSync(foreign, file);
    };
    await f.run("doctor install --host codex --scope project");
    expect(f.harness.widgets.get("workflows")).toContain("Incomplete rollback");
    expect(f.harness.widgets.get("workflows")).toContain("/workflows doctor recovery");
    fixtureState.fault = undefined;
    if (mode === "tui") f.harness.customInputQueue.push("end", "\x1b");
    await f.run("doctor recovery");
    const retrieved = mode === "rpc" ? f.harness.notifications.at(-1)! : f.harness.customRenderFrames.flat().join("\n");
    expect(retrieved).toContain("/workflows doctor check --host codex --scope project");
    expect(retrieved).toContain("Publication identity could not be verified.");
    expect(retrieved.replace(/\n/g, "")).toContain(installed);
    await emit(f.harness, "session_start", {});
    await f.run("doctor recovery");
    expect(f.harness.widgets.get("workflows")).toContain("No incomplete rollback");
  });
});
