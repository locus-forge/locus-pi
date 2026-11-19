import {
  lstatSync,
  existsSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  operateWorkflowSkillHosts,
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
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow-skill-hosts-")));
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
      Array.from({ length: 8 }, () => "created"),
    );
    for (const hostRoot of [path.join(f.userHome, ".agents", "skills"), path.join(f.userHome, ".claude", "skills")]) {
      for (const skill of WORKFLOW_SKILL_NAMES) {
        const link = path.join(hostRoot, skill);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(path.resolve(hostRoot, readlinkSync(link))).toBe(path.join(f.packageRoot, "skills", skill));
      }
    }

    const marker = path.join(f.userHome, ".agents", "skills", WORKFLOW_SKILL_STATE_FILE);
    const originalMarker = readFileSync(marker, "utf8");
    const originalInode = lstatSync(marker).ino;
    const second = operateWorkflowSkillHosts({
      action: "sync",
      host: "all",
      scope: "user",
      projectRoot: f.projectRoot,
      packageRoot: f.packageRoot,
      userHome: f.userHome,
    });
    expect(second.rows.every((row) => row.changed === "none")).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe(originalMarker);
    expect(lstatSync(marker).ino).toBe(originalInode);
  });

  it("repairs a package move and removes only identity-proven retired links", () => {
    const f = fixture();
    const options = { ...f, host: "codex" as const, scope: "project" as const };
    operateWorkflowSkillHosts({ ...options, action: "sync" });
    const hostRoot = path.join(f.projectRoot, ".agents", "skills");
    const marker = path.join(hostRoot, WORKFLOW_SKILL_STATE_FILE);
    const previous = JSON.parse(readFileSync(marker, "utf8"));
    for (const name of [
      "locus-pi-workflows",
      "locus-pi-run-workflow",
      "locus-task-workflow",
      "locus-pi-workflow-implement-task",
    ]) {
      const target = path.join(f.root, "old-package", "skills", name);
      const link = path.join(hostRoot, name);
      symlinkSync(target, link, "dir");
      const st = lstatSync(link, { bigint: true });
      previous.links.push({
        name,
        target,
        identity: {
          device: String(st.dev),
          inode: String(st.ino),
          born: String(st.birthtimeNs),
          changed: String(st.ctimeNs),
        },
      });
    }
    writeFileSync(marker, JSON.stringify(previous));
    const nextPackage = path.join(f.root, "moved-install");
    renameSync(f.packageRoot, nextPackage);
    const result = operateWorkflowSkillHosts({ ...options, packageRoot: nextPackage, action: "sync" });
    expect(result.rows.filter((row) => row.changed === "replaced")).toHaveLength(4);
    expect(result.rows.filter((row) => row.changed === "removed")).toHaveLength(4);
    expect(JSON.parse(readFileSync(marker, "utf8")).owner).toBe("@kroffske/locus-pi");
    for (const row of result.rows) {
      if (row.legacy) expect(lstatSync(row.path, { throwIfNoEntry: false })).toBeUndefined();
      else expect(readlinkSync(row.path)).toBe(path.join(nextPackage, "skills", row.skill));
    }
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
    ).toThrow("Ownership conflict");
    expect(
      lstatSync(path.join(f.userHome, ".agents", "skills", WORKFLOW_SKILL_NAMES[0]), { throwIfNoEntry: false }),
    ).toBeUndefined();
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
    ).toThrow("Ownership conflict");
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

describe("doctor filesystem regressions", () => {
  it.each(["user", "project"] as const)("refuses an alias from the other scope into %s", (scope) => {
    const f = fixture();
    const selected = scope === "user" ? f.userHome : f.projectRoot;
    const other = scope === "user" ? f.projectRoot : f.userHome;
    const options = { ...f, scope, host: "codex" as const };
    operateWorkflowSkillHosts({ ...options, action: "sync" });
    const skills = path.join(selected, ".agents", "skills");
    const marker = path.join(skills, WORKFLOW_SKILL_STATE_FILE);
    const kept = path.join(skills, WORKFLOW_SKILL_NAMES[0]);
    symlinkSync(path.join(selected, ".agents"), path.join(other, ".agents"), "dir");
    const before = readFileSync(marker, "utf8");
    for (const action of ["sync", "remove"] as const) {
      expect(() => operateWorkflowSkillHosts({ ...options, action })).toThrow(/shared|redirect/i);
      expect(readFileSync(marker, "utf8")).toBe(before);
      expect(lstatSync(kept).isSymbolicLink()).toBe(true);
    }
  });

  it.each(["marker", "link"] as const)("preserves a foreign %s staging name on EEXIST", (kind) => {
    const f = fixture();
    const root = path.join(f.userHome, ".agents", "skills");
    mkdirSync(root, { recursive: true });
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const temp = path.join(
        root,
        kind === "marker"
          ? WORKFLOW_SKILL_STATE_FILE + "." + process.pid + "-1234"
          : WORKFLOW_SKILL_NAMES[0] + ".locus-pi-" + process.pid + "-1234",
      );
      writeFileSync(temp, "foreign", { flag: "wx" });
      const inode = lstatSync(temp).ino;
      expect(() => operateWorkflowSkillHosts({ ...f, action: "sync", host: "codex", scope: "user" })).toThrow(/EEXIST/);
      expect(lstatSync(temp).ino).toBe(inode);
      expect(readFileSync(temp, "utf8")).toBe("foreign");
    } finally {
      now.mockRestore();
    }
  });

  it.each([false, true])("restores missing directory chains with a pre-existing parent: %s", (preexisting) => {
    const f = fixture();
    const existing = path.join(f.userHome, ".agents");
    if (preexisting) {
      mkdirSync(existing);
      writeFileSync(path.join(existing, "sentinel"), "unchanged");
    }
    let mutations = 0;
    expect(() =>
      operateWorkflowSkillHosts({
        ...f,
        action: "sync",
        host: "all",
        scope: "user",
        _testAfterMutation: () => {
          if (++mutations === 4) throw new Error("injected failure");
        },
      }),
    ).toThrow(/injected failure/);
    expect(readdirSync(f.userHome)).toEqual(preexisting ? [".agents"] : []);
    if (preexisting) {
      expect(readdirSync(existing)).toEqual(["sentinel"]);
      expect(readFileSync(path.join(existing, "sentinel"), "utf8")).toBe("unchanged");
    }
  });

  it("leaves an occupied directory created during the failed install", () => {
    const f = fixture();
    const root = path.join(f.userHome, ".agents", "skills");
    const sentinel = path.join(root, "foreign");
    expect(() =>
      operateWorkflowSkillHosts({
        ...f,
        action: "sync",
        host: "codex",
        scope: "user",
        _testAfterMutation: () => {
          writeFileSync(sentinel, "keep");
          throw new Error("injected failure");
        },
      }),
    ).toThrow(/incomplete rollback/i);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("preserves a written entry and marker that were subsequently replaced", () => {
    const f = fixture();
    const root = path.join(f.userHome, ".agents", "skills");
    const skill = path.join(root, WORKFLOW_SKILL_NAMES[0]);
    const marker = path.join(root, WORKFLOW_SKILL_STATE_FILE);
    expect(() =>
      operateWorkflowSkillHosts({
        ...f,
        action: "sync",
        host: "codex",
        scope: "user",
        _testAfterMutation: () => {
          if (!existsSync(skill) || !existsSync(marker)) return;
          const separateLink = path.join(root, "substitute");
          symlinkSync(readlinkSync(skill), separateLink, "dir");
          renameSync(separateLink, skill);
          const separateMarker = path.join(root, "substitute-marker");
          writeFileSync(separateMarker, "foreign");
          renameSync(separateMarker, marker);
          throw new Error("injected failure");
        },
      }),
    ).toThrow(/incomplete rollback/i);
    expect(lstatSync(skill).isSymbolicLink()).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("foreign");
  });

  it("leaves a same-target replacement untouched through failed remove and write retries", () => {
    const f = fixture();
    const options = { ...f, host: "codex" as const, scope: "user" as const };
    operateWorkflowSkillHosts({ ...options, action: "sync" });
    const root = path.join(f.userHome, ".agents", "skills");
    const skill = path.join(root, WORKFLOW_SKILL_NAMES[0]);
    const marker = path.join(root, WORKFLOW_SKILL_STATE_FILE);
    const before = readFileSync(marker, "utf8");
    const substitute = path.join(root, "substitute");
    symlinkSync(readlinkSync(skill), substitute, "dir");
    const substituteInode = lstatSync(substitute).ino;
    expect(() =>
      operateWorkflowSkillHosts({
        ...options,
        action: "remove",
        _testAfterMutation: (name) => {
          if (name !== skill) return;
          renameSync(substitute, skill);
          throw new Error("injected failure");
        },
      }),
    ).toThrow(/incomplete rollback/i);
    for (const action of ["sync", "remove"] as const) {
      expect(() => operateWorkflowSkillHosts({ ...options, action })).toThrow(/conflict/i);
      expect(lstatSync(skill).ino).toBe(substituteInode);
      expect(readFileSync(marker, "utf8")).toBe(before);
    }
  });

  it("preserves name-only ownership and refuses to adopt a current-looking v1 link", () => {
    const f = fixture();
    const root = path.join(f.projectRoot, ".agents", "skills");
    const name = WORKFLOW_SKILL_NAMES[0];
    const skill = path.join(root, name);
    const marker = path.join(root, WORKFLOW_SKILL_STATE_FILE);
    mkdirSync(root, { recursive: true });
    symlinkSync(path.join(f.packageRoot, "skills", name), skill, "dir");
    const before = JSON.stringify({
      schema: "locus-pi.workflow-skills.v1",
      owner: "@kroffske/locus-pi",
      links: [name],
    });
    writeFileSync(marker, before);
    for (const action of ["sync", "remove"] as const) {
      expect(() => operateWorkflowSkillHosts({ ...f, action, host: "codex", scope: "project" })).toThrow(
        /v1|ownership/i,
      );
      expect(lstatSync(skill).isSymbolicLink()).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe(before);
    }
  });

  it("refuses both writes when the explicit Claude override aliases the default skills dir", () => {
    const f = fixture();
    const options = { ...f, host: "claude" as const, scope: "user" as const };
    operateWorkflowSkillHosts({ ...options, action: "sync" });
    const root = path.join(f.userHome, ".claude", "skills");
    const alternate = path.join(f.root, "alternate");
    mkdirSync(alternate);
    const redirect = path.join(alternate, "skills");
    symlinkSync(root, redirect, "dir");
    const missing = path.join(root, WORKFLOW_SKILL_NAMES[1]);
    unlinkSync(missing);
    const marker = path.join(root, WORKFLOW_SKILL_STATE_FILE);
    const before = readFileSync(marker, "utf8");
    vi.stubEnv("CLAUDE_CONFIG_DIR", alternate);
    try {
      for (const action of ["sync", "remove"] as const) {
        expect(() => operateWorkflowSkillHosts({ ...options, action })).toThrow(/shared/i);
        expect(lstatSync(path.join(redirect, WORKFLOW_SKILL_NAMES[0])).isSymbolicLink()).toBe(true);
        expect(existsSync(missing)).toBe(false);
        expect(readFileSync(marker, "utf8")).toBe(before);
        expect(readlinkSync(redirect)).toBe(root);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("doctor mutation boundaries", () => {
  it.each([
    ["before-guard", /Entry changed/],
    ["after-guard", /EEXIST/],
  ] as const)("preserves a foreign marker inserted at %s", (insertAt, error) => {
    const f = fixture();
    const root = path.join(f.userHome, ".agents", "skills");
    const marker = path.join(root, WORKFLOW_SKILL_STATE_FILE);
    expect(() =>
      operateWorkflowSkillHosts({
        ...f,
        action: "sync",
        host: "codex",
        scope: "user",
        _testAtBoundary: (boundary, file) => {
          if (boundary === insertAt && file === marker) writeFileSync(marker, "foreign", { flag: "wx" });
        },
      }),
    ).toThrow(error);
    expect(readFileSync(marker, "utf8")).toBe("foreign");
    expect(readdirSync(root)).toEqual([WORKFLOW_SKILL_STATE_FILE]);
  });

  it("compares the symlink published at first readback to its staged inode", () => {
    const f = fixture();
    const first = path.join(f.userHome, ".agents", "skills", WORKFLOW_SKILL_NAMES[0]);
    let savedInode: number | undefined;
    expect(() =>
      operateWorkflowSkillHosts({
        ...f,
        action: "sync",
        host: "codex",
        scope: "user",
        _testAtBoundary: (boundary, file) => {
          if (boundary !== "before-readback" || file !== first) return;
          const foreign = path.join(path.dirname(file), "replacement");
          symlinkSync(readlinkSync(file), foreign, "dir");
          savedInode = lstatSync(foreign).ino;
          renameSync(foreign, file);
        },
      }),
    ).toThrow(/incomplete rollback/i);
    expect(savedInode).toBeDefined();
    expect(lstatSync(first).ino).toBe(savedInode);
  });

  it("preserves a same-value marker replaced before first readback", () => {
    const f = fixture();
    const root = path.join(f.userHome, ".agents", "skills");
    const marker = path.join(root, WORKFLOW_SKILL_STATE_FILE);
    let savedInode: number | undefined;
    expect(() =>
      operateWorkflowSkillHosts({
        ...f,
        action: "sync",
        host: "codex",
        scope: "user",
        _testAtBoundary: (boundary, file) => {
          if (boundary !== "before-readback" || file !== marker) return;
          const foreign = path.join(root, "replacement");
          writeFileSync(foreign, readFileSync(marker));
          savedInode = lstatSync(foreign).ino;
          renameSync(foreign, marker);
        },
      }),
    ).toThrow(/incomplete rollback/i);
    expect(savedInode).toBeDefined();
    expect(lstatSync(marker).ino).toBe(savedInode);
    expect(readdirSync(root)).toEqual([WORKFLOW_SKILL_STATE_FILE]);
  });

  it("does not claim a link as its own removal when unlink sees it disappear after the guard", () => {
    const f = fixture();
    const options = { ...f, host: "codex" as const, scope: "user" as const };
    operateWorkflowSkillHosts({ ...options, action: "sync" });
    const root = path.join(f.userHome, ".agents", "skills");
    const first = path.join(root, WORKFLOW_SKILL_NAMES[0]);
    expect(() =>
      operateWorkflowSkillHosts({
        ...options,
        action: "remove",
        _testAtBoundary: (boundary, file) => {
          if (boundary === "after-guard" && file === first) unlinkSync(first);
        },
      }),
    ).toThrow(/ENOENT/);
    expect(existsSync(first)).toBe(false);
    expect(lstatSync(path.join(root, WORKFLOW_SKILL_NAMES[1])).isSymbolicLink()).toBe(true);
  });

  it("restores proof for a recreated link after a late removal failure", () => {
    const f = fixture();
    const options = { ...f, host: "codex" as const, scope: "user" as const };
    operateWorkflowSkillHosts({ ...options, action: "sync" });
    const root = path.join(f.userHome, ".agents", "skills");
    const marker = path.join(root, WORKFLOW_SKILL_STATE_FILE);
    mkdirSync(path.join(root, "foreign-directory"));
    expect(() =>
      operateWorkflowSkillHosts({
        ...options,
        action: "remove",
        _testAfterMutation: (file) => {
          if (file === marker) throw new Error("late failure");
        },
      }),
    ).toThrow(/^late failure$/);
    const before = lstatSync(marker).ino;
    expect(operateWorkflowSkillHosts({ ...options, action: "sync" }).rows.every((row) => row.changed === "none")).toBe(
      true,
    );
    expect(lstatSync(marker).ino).toBe(before);
    expect(lstatSync(path.join(root, "foreign-directory")).isDirectory()).toBe(true);
  });
});
