import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  operateWorkflowSkillHosts,
  parseWorkflowSkillHostCommand,
  WORKFLOW_SKILL_NAMES,
  WORKFLOW_SKILL_STATE_FILE,
} from "../../../../extensions/workflows/command/skills.js";

const roots: string[] = [];
const packageName = (JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { name: string })
  .name;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; packageRoot: string; projectRoot: string; userHome: string } {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-skill-hosts-"));
  roots.push(root);
  const packageRoot = path.join(root, "node_modules", ...packageName.split("/"));
  const projectRoot = path.join(root, "project");
  const userHome = path.join(root, "home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  for (const skill of WORKFLOW_SKILL_NAMES) {
    const skillRoot = path.join(packageRoot, "skills", skill);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), `---\nname: ${skill}\n---\n`, "utf8");
  }
  return { root, packageRoot, projectRoot, userHome };
}

describe("workflow skill host command", () => {
  it("parses action defaults and explicit host/scope options", () => {
    expect(parseWorkflowSkillHostCommand("skills status")).toEqual({
      ok: true,
      command: { action: "status", host: "all", scope: "user" },
    });
    expect(parseWorkflowSkillHostCommand("skills sync --scope project --host codex")).toEqual({
      ok: true,
      command: { action: "sync", host: "codex", scope: "project" },
    });
    expect(parseWorkflowSkillHostCommand("skills sync --host foreign")).toEqual({
      ok: false,
      message: "Unsupported skills host: foreign.",
    });
  });

  it("syncs canonical links for both user hosts and remains idempotent", () => {
    const f = fixture();
    const first = operateWorkflowSkillHosts({
      action: "sync",
      host: "all",
      scope: "user",
      projectRoot: f.projectRoot,
      packageRoot: f.packageRoot,
      userHome: f.userHome,
    });
    expect(first.rows.filter((row) => !row.legacy).map((row) => row.changed)).toEqual(
      Array.from({ length: 6 }, () => "created"),
    );
    for (const hostRoot of [path.join(f.userHome, ".agents", "skills"), path.join(f.userHome, ".claude", "skills")]) {
      for (const skill of WORKFLOW_SKILL_NAMES) {
        const link = path.join(hostRoot, skill);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(path.resolve(hostRoot, readlinkSync(link))).toBe(path.join(f.packageRoot, "skills", skill));
      }
    }

    const second = operateWorkflowSkillHosts({
      action: "sync",
      host: "all",
      scope: "user",
      projectRoot: f.projectRoot,
      packageRoot: f.packageRoot,
      userHome: f.userHome,
    });
    expect(second.rows.every((row) => row.changed === "none")).toBe(true);
  });

  it("atomically replaces stale managed links and removes retired names", () => {
    const f = fixture();
    const hostRoot = path.join(f.projectRoot, ".agents", "skills");
    mkdirSync(hostRoot, { recursive: true });
    const skill = WORKFLOW_SKILL_NAMES[0];
    const staleRoot = path.join(f.root, "node_modules", "@kroffske", "locus-pi", "skills");
    symlinkSync(path.join(staleRoot, skill), path.join(hostRoot, skill), "dir");
    symlinkSync(path.join(staleRoot, "locus-pi-workflows"), path.join(hostRoot, "locus-pi-workflows"), "dir");
    writeFileSync(
      path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE),
      `${JSON.stringify({
        schema: "locus-pi.workflow-skills.v1",
        owner: "@kroffske/locus-pi",
        links: [skill, "locus-pi-workflows"],
      })}\n`,
      "utf8",
    );

    const status = operateWorkflowSkillHosts({
      action: "status",
      host: "codex",
      scope: "project",
      projectRoot: f.projectRoot,
      packageRoot: f.packageRoot,
      userHome: f.userHome,
    });
    expect(status.rows).toContainEqual(expect.objectContaining({ skill, state: "stale", changed: "none" }));

    const result = operateWorkflowSkillHosts({
      action: "sync",
      host: "codex",
      scope: "project",
      projectRoot: f.projectRoot,
      packageRoot: f.packageRoot,
      userHome: f.userHome,
    });

    expect(result.rows).toContainEqual(expect.objectContaining({ skill, changed: "replaced" }));
    expect(result.rows).toContainEqual(
      expect.objectContaining({ skill: "locus-pi-workflows", changed: "removed", legacy: true }),
    );
    expect(path.resolve(hostRoot, readlinkSync(path.join(hostRoot, skill)))).toBe(
      path.join(f.packageRoot, "skills", skill),
    );
    expect(packageName).toBe("@locus-forge/locus-pi");
    expect(JSON.parse(readFileSync(path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE), "utf8")).owner).toBe(
      "@kroffske/locus-pi",
    );
    expect(lstatSync(path.join(hostRoot, "locus-pi-workflows"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("adds the external session skill to a two-skill installation without replacing existing links", () => {
    const f = fixture();
    const hostRoot = path.join(f.userHome, ".agents", "skills");
    mkdirSync(hostRoot, { recursive: true });
    const previous = ["locus-pi-workflow-create", "locus-pi-workflow-run"];
    for (const name of previous)
      symlinkSync(path.join(f.packageRoot, "skills", name), path.join(hostRoot, name), "dir");
    mkdirSync(path.join(hostRoot, "user-owned-skill"));
    writeFileSync(
      path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE),
      JSON.stringify({ schema: "locus-pi.workflow-skills.v1", owner: "@kroffske/locus-pi", links: previous }),
    );

    const result = operateWorkflowSkillHosts({
      action: "sync",
      host: "codex",
      scope: "user",
      projectRoot: f.projectRoot,
      packageRoot: f.packageRoot,
      userHome: f.userHome,
    });
    expect(result.rows.filter((row) => row.changed !== "none")).toEqual([
      expect.objectContaining({ skill: "external-locus-pi", changed: "created" }),
    ]);
    for (const name of previous)
      expect(readlinkSync(path.join(hostRoot, name))).toBe(path.join(f.packageRoot, "skills", name));
    expect(lstatSync(path.join(hostRoot, "user-owned-skill")).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE), "utf8")).links).toEqual([
      "external-locus-pi",
      "locus-pi-workflow-create",
      "locus-pi-workflow-run",
    ]);
  });

  it("preflights every target and refuses host-owned paths without partial writes", () => {
    const f = fixture();
    const conflict = path.join(f.userHome, ".claude", "skills", WORKFLOW_SKILL_NAMES[0]);
    mkdirSync(conflict, { recursive: true });

    expect(() =>
      operateWorkflowSkillHosts({
        action: "sync",
        host: "all",
        scope: "user",
        projectRoot: f.projectRoot,
        packageRoot: f.packageRoot,
        userHome: f.userHome,
      }),
    ).toThrow("Refusing to change unmanaged skill path");
    expect(
      lstatSync(path.join(f.userHome, ".agents", "skills", WORKFLOW_SKILL_NAMES[0]), { throwIfNoEntry: false }),
    ).toBeUndefined();
  });

  it("rolls back provenance and earlier links after a later filesystem failure", () => {
    const f = fixture();
    let mutations = 0;
    expect(() =>
      operateWorkflowSkillHosts({
        action: "sync",
        host: "all",
        scope: "user",
        projectRoot: f.projectRoot,
        packageRoot: f.packageRoot,
        userHome: f.userHome,
        _testAfterMutation: () => {
          mutations += 1;
          if (mutations === 4) throw new Error("injected late failure");
        },
      }),
    ).toThrow("injected late failure");
    for (const hostRoot of [path.join(f.userHome, ".agents", "skills"), path.join(f.userHome, ".claude", "skills")]) {
      for (const skill of WORKFLOW_SKILL_NAMES) {
        expect(lstatSync(path.join(hostRoot, skill), { throwIfNoEntry: false })).toBeUndefined();
      }
      expect(lstatSync(path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE), { throwIfNoEntry: false })).toBeUndefined();
    }
  });

  it("does not infer ownership from a foreign symlink target that looks like locus-pi", () => {
    const f = fixture();
    const hostRoot = path.join(f.projectRoot, ".agents", "skills");
    mkdirSync(hostRoot, { recursive: true });
    const skill = WORKFLOW_SKILL_NAMES[0];
    symlinkSync(
      path.join(f.root, "node_modules", "@kroffske", "locus-pi", "skills", skill),
      path.join(hostRoot, skill),
      "dir",
    );
    expect(() =>
      operateWorkflowSkillHosts({
        action: "remove",
        host: "codex",
        scope: "project",
        projectRoot: f.projectRoot,
        packageRoot: f.packageRoot,
        userHome: f.userHome,
      }),
    ).toThrow("Refusing to change unmanaged skill path");
    expect(lstatSync(path.join(hostRoot, skill)).isSymbolicLink()).toBe(true);
  });

  it("removes only managed links", () => {
    const f = fixture();
    const options = {
      host: "codex" as const,
      scope: "project" as const,
      projectRoot: f.projectRoot,
      packageRoot: f.packageRoot,
      userHome: f.userHome,
    };
    operateWorkflowSkillHosts({ ...options, action: "sync" });
    const removed = operateWorkflowSkillHosts({ ...options, action: "remove" });
    expect(removed.rows.filter((row) => !row.legacy).every((row) => row.changed === "removed")).toBe(true);
    expect(
      lstatSync(path.join(f.projectRoot, ".agents", "skills", WORKFLOW_SKILL_STATE_FILE), {
        throwIfNoEntry: false,
      }),
    ).toBeUndefined();
  });
});
