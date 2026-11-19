import {
  existsSync,
  lstatSync,
  unlinkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_SKILL_NAMES, WORKFLOW_SKILL_STATE_FILE } from "../../../../../extensions/workflows/command/skills.js";
import { emit } from "../../../../test-harness.js";
import { testHooks as fixtureState, setup } from "./fixture.js";

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
    expect(help).toContain("Catalog: /workflows list [query]");
    expect(help).toContain("/workflows doctor check");
    expect(help).toContain("/workflows doctor recovery");
    expect(help.replace(/\s+/gu, " ")).toContain(
      "/workflows doctor [check|install|remove] [--host codex|claude|all] [--scope user|project]",
    );
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

  it("preserves both hosts when explicit Claude config uses Codex skills and project is HOME", async () => {
    const f = setup("rpc", true);
    await f.run("doctor install --host codex");
    const base = path.join(f.home, ".agents");
    const skills = path.join(base, "skills");
    const kept = path.join(skills, WORKFLOW_SKILL_NAMES[0]);
    const missing = path.join(skills, WORKFLOW_SKILL_NAMES[1]);
    const marker = path.join(skills, WORKFLOW_SKILL_STATE_FILE);
    unlinkSync(missing);
    const markerBefore = readFileSync(marker, "utf8");
    const ids = [lstatSync(kept).ino, lstatSync(marker).ino];
    vi.stubEnv("CLAUDE_CONFIG_DIR", base);
    f.harness.notifications.length = 0;
    await f.run("doctor check --host codex");
    expect(f.text()).toContain("Shared destination");
    for (const host of ["codex", "all"]) {
      for (const action of ["install", "remove"]) {
        await f.run(`doctor ${action} --host ${host}`);
        expect(f.text()).toContain("Write refused");
        expect([lstatSync(kept).ino, lstatSync(marker).ino]).toEqual(ids);
        expect(readFileSync(marker, "utf8")).toBe(markerBefore);
        expect(existsSync(missing)).toBe(false);
        expect(existsSync(path.join(f.home, ".claude"))).toBe(false);
      }
    }
  });

  it("recognizes equivalent parent spellings while the Claude skills directory is absent", async ({ skip }) => {
    const f = setup();
    const parent = path.join(f.home, ".claude");
    const alternate = path.join(f.home, ".CLAUDE");
    mkdirSync(parent);
    if (!existsSync(alternate)) skip();
    vi.stubEnv("CLAUDE_CONFIG_DIR", alternate);
    for (const action of ["check", "install", "remove"]) {
      await f.run(`doctor ${action} --host claude`);
      expect(f.text()).toContain("Shared destination");
      expect(existsSync(path.join(alternate, "skills"))).toBe(false);
    }
  });

  it("refuses a case-variant Claude override when both destination components are absent", async ({ skip }) => {
    const f = setup();
    const probe = path.join(f.home, "Case-Probe");
    mkdirSync(probe);
    if (!existsSync(path.join(f.home, "case-probe"))) skip("Fixture volume is case-sensitive.");
    const alternate = path.join(f.home, ".CLAUDE");
    vi.stubEnv("CLAUDE_CONFIG_DIR", alternate);
    for (const action of [
      "check --host claude",
      "install --host claude",
      "remove --host claude",
      "install --host all",
    ]) {
      f.harness.notifications.length = 0;
      await f.run(`doctor ${action}`);
      expect(f.text()).toContain("Shared destination");
      if (action.startsWith("check")) expect(f.text()).not.toContain("/workflows doctor install");
      else expect(f.text()).toContain("Write refused");
      expect(existsSync(alternate)).toBe(false);
      expect(existsSync(path.join(f.home, ".agents"))).toBe(false);
    }
  });

  it("uses the physical HOME for install and remove when a nested link precedes ..", async () => {
    const f = setup();
    const team = path.join(f.root, "team");
    const physicalHome = path.join(team, "home");
    const child = path.join(team, "child");
    const homeAlias = path.join(f.root, "home-link");
    mkdirSync(child, { recursive: true });
    mkdirSync(physicalHome);
    symlinkSync(child, path.join(f.root, "jump"), "dir");
    symlinkSync("jump/../home", homeAlias, "dir");
    expect(statSync(homeAlias).ino).toBe(statSync(physicalHome).ino);
    vi.stubEnv("HOME", homeAlias);
    const skills = path.join(physicalHome, ".agents", "skills");
    const shadow = path.join(f.home, ".agents");
    const marker = path.join(skills, WORKFLOW_SKILL_STATE_FILE);
    await f.run("doctor check --host codex");
    expect(f.text().replace(/\n/gu, "")).toContain(skills);
    await f.run("doctor install --host codex");
    expect(lstatSync(path.join(skills, WORKFLOW_SKILL_NAMES[0])).isSymbolicLink()).toBe(true);
    expect(existsSync(shadow)).toBe(false);
    await f.run("doctor remove --host codex");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(skills, WORKFLOW_SKILL_NAMES[0]))).toBe(false);
    expect(existsSync(shadow)).toBe(false);
  });

  it("keeps traversal order through nested links in a missing Claude peer", async () => {
    const f = setup();
    const child = path.join(f.home, "child");
    const alternate = path.join(f.root, "alternate");
    mkdirSync(child);
    symlinkSync(child, path.join(f.root, "jump"), "dir");
    symlinkSync("jump/../.claude", alternate, "dir");
    vi.stubEnv("CLAUDE_CONFIG_DIR", alternate);
    for (const verb of ["check", "install", "remove"]) {
      f.harness.notifications.length = 0;
      await f.run(`doctor ${verb} --host claude`);
      expect(f.text()).toContain("Shared destination");
      expect(existsSync(path.join(f.home, ".claude"))).toBe(false);
    }
  });

  it("preserves an edited stage when the destination guard also fails", async () => {
    const f = setup();
    const skills = path.join(f.project, ".agents", "skills");
    const marker = path.join(skills, WORKFLOW_SKILL_STATE_FILE);
    const stage = `${marker}.${process.pid}-1234`;
    vi.spyOn(Date, "now").mockReturnValue(1234);
    let modifiedInode = 0;
    fixtureState.fault = (file, boundary) => {
      if (boundary !== "before-guard" || file !== marker) return;
      modifiedInode = lstatSync(stage).ino;
      writeFileSync(stage, "foreign stage");
      writeFileSync(marker, "foreign marker", { flag: "wx" });
    };
    await f.run("doctor install --host codex --scope project");
    expect(readFileSync(marker, "utf8")).toBe("foreign marker");
    expect(readFileSync(stage, "utf8")).toBe("foreign stage");
    expect(lstatSync(stage).ino).toBe(modifiedInode);
    expect(existsSync(path.join(skills, WORKFLOW_SKILL_NAMES[0]))).toBe(false);
    await f.run("doctor recovery");
    expect(f.harness.notifications.at(-1)).toContain(`Skipped or failed: ${stage}`);
    expect(f.harness.notifications.at(-1)).toContain(`Skipped or failed: ${marker}`);
  });

  it.each(["link", "marker", "marker contents"] as const)(
    "preserves a foreign %s stage before publication",
    async (stage) => {
      const f = setup();
      const skills = path.join(f.project, ".agents", "skills");
      const destination = path.join(skills, stage === "link" ? WORKFLOW_SKILL_NAMES[0] : WORKFLOW_SKILL_STATE_FILE);
      let temporary = "";
      let foreignInode = 0;
      vi.spyOn(Date, "now").mockReturnValue(1234);
      fixtureState.fault = (file, boundary) => {
        if (boundary !== "before-guard" || file !== destination) return;
        temporary = stage === "link" ? `${file}.locus-pi-${process.pid}-1234` : `${file}.${process.pid}-1234`;
        if (stage === "marker contents") writeFileSync(temporary, "foreign stage");
        else {
          const replacement = path.join(skills, "foreign");
          writeFileSync(replacement, "foreign stage");
          renameSync(replacement, temporary);
        }
        foreignInode = lstatSync(temporary).ino;
      };
      await f.run("doctor install --host codex --scope project");
      expect(existsSync(destination)).toBe(false);
      expect(readFileSync(temporary, "utf8")).toBe("foreign stage");
      expect(lstatSync(temporary).ino).toBe(foreignInode);
      await f.run("doctor recovery");
      expect(f.harness.notifications.at(-1)).toContain(temporary);
    },
  );

  it.each(["before-guard", "after-guard"])(
    "reports a lost unlink target at %s after restoring an earlier removal",
    async (seam) => {
      const f = setup();
      const skills = path.join(f.project, ".agents", "skills");
      const first = path.join(skills, WORKFLOW_SKILL_NAMES[0]);
      const lost = path.join(skills, WORKFLOW_SKILL_NAMES[1]);
      const marker = path.join(skills, WORKFLOW_SKILL_STATE_FILE);
      await f.run("doctor install --host codex --scope project");
      const claim = () => JSON.parse(readFileSync(marker, "utf8")).links[1];
      const originalClaim = claim();
      fixtureState.fault = (file, boundary) => {
        if (boundary === seam && file === lost) unlinkSync(lost);
      };
      await f.run("doctor remove --host codex --scope project");
      expect(lstatSync(first).isSymbolicLink()).toBe(true);
      expect(existsSync(lost)).toBe(false);
      expect(claim()).toEqual(originalClaim);
      expect(f.harness.widgets.get("workflows")).toContain("Incomplete rollback");
      await f.run("doctor recovery");
      expect(f.harness.notifications.at(-1)).toContain(`Skipped or failed: ${lost}`);
      expect(f.harness.notifications.at(-1)).toContain("/workflows doctor check --host codex --scope project");
    },
  );

  it("makes recovery discoverable from a 50-column, nine-row TUI", async () => {
    const f = setup("tui");
    const installed = path.join(f.project, ".agents", "skills", WORKFLOW_SKILL_NAMES[0]);
    fixtureState.fault = (file, boundary) => {
      if (boundary !== "before-readback" || file !== installed) return;
      unlinkSync(file);
      symlinkSync("/different-target", file, "dir");
    };
    f.harness.customInputQueue.push("\x1b");
    await f.run("doctor install --host codex --scope project");
    const factory = f.harness.widgetPayloads.get("workflows");
    if (typeof factory === "function") {
      factory({ requestRender() {}, terminal: { columns: 50, rows: 9 } }, {}).render(50);
    }
    const warning = () => f.harness.customRenderFrames.flat().join("\n");
    await expect.poll(warning).toContain("Incomplete rollback");
    expect(warning()).toContain("/workflows doctor recovery");
  });

  it.each(["rpc", "tui"] as const)("retrieves full rollback in %s with session isolation", async (mode) => {
    const f = setup(mode);
    const installed = path.join(f.project, ".agents", "skills", WORKFLOW_SKILL_NAMES[0]);
    const foreign = path.join(path.dirname(installed), "replacement");
    fixtureState.fault = (file, boundary) => {
      if (boundary !== "before-readback" || file !== installed) return;
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
