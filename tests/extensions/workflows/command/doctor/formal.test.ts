import {
  accessSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  operateWorkflowSkillHosts,
  WORKFLOW_SKILL_NAMES,
  WORKFLOW_SKILL_STATE_FILE,
} from "../../../../../extensions/workflows/command/skills.js";
import { testHooks as fixtureState, setup } from "./fixture.js";

const [first, second] = WORKFLOW_SKILL_NAMES;
const schema = "locus-pi.workflow-skills.v2";
const owner = "@kroffske/locus-pi";
const claude = "Claude Code default folder";

function proof(file: string) {
  const st = lstatSync(file, { bigint: true });
  return {
    name: path.basename(file),
    target: readlinkSync(file),
    identity: {
      device: String(st.dev),
      inode: String(st.ino),
      born: String(st.birthtimeNs),
      changed: String(st.ctimeNs),
    },
  };
}
function writeProofs(skills: string, links: unknown[]) {
  writeFileSync(path.join(skills, WORKFLOW_SKILL_STATE_FILE), JSON.stringify({ schema, owner, links }));
}

it("records a marker inserted at publication as incomplete and preserves it", async () => {
  const f = setup();
  const skills = path.join(f.project, ".agents", "skills");
  const marker = path.join(skills, WORKFLOW_SKILL_STATE_FILE);
  mkdirSync(skills, { recursive: true });
  fixtureState.fault = (file, boundary) => {
    if (file === marker && boundary === "after-guard") writeFileSync(marker, "foreign", { flag: "wx" });
  };
  expect(await f.fresh("doctor install --host codex --scope project")).toContain("Incomplete rollback");
  expect(readFileSync(marker, "utf8")).toBe("foreign");
  expect(existsSync(path.join(skills, first))).toBe(false);
  expect(await f.fresh("doctor recovery")).toContain(`Skipped or failed: ${marker}`);
});

it("records a foreign directory appearing during preparation", async () => {
  const f = setup();
  const parent = path.join(f.project, ".agents");
  const sentinel = path.join(parent, "foreign");
  const mkdir = fs.mkdirSync;
  const spy = vi.spyOn(fs, "mkdirSync").mockImplementation((...args) => {
    if (args[0] === parent) {
      mkdir(parent);
      writeFileSync(sentinel, "preserve");
    }
    return mkdir(...args);
  });
  syncBuiltinESMExports();
  try {
    expect(await f.fresh("doctor install --host codex --scope project")).toContain("Incomplete rollback");
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(readFileSync(sentinel, "utf8")).toBe("preserve");
  expect(existsSync(path.join(parent, "skills"))).toBe(false);
  expect(await f.fresh("doctor recovery")).toContain(`Skipped or failed: ${parent}`);
});

it("reports readable Codex state with an inaccessible Claude peer and refuses all writes", async ({ skip }) => {
  const f = setup();
  await f.run("doctor install --host codex");
  const codex = path.join(f.home, ".agents", "skills");
  const peer = path.join(f.home, ".claude", "skills");
  mkdirSync(peer, { recursive: true });
  unlinkSync(path.join(codex, second));
  chmodSync(path.dirname(peer), 0);
  try {
    try {
      accessSync(peer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      const checked = await f.fresh("doctor");
      expect(checked).toContain("3/4 links installed on disk");
      expect(checked).toContain("Cannot rule out a shared destination");
      expect(checked.replace(/\n/gu, "")).toContain(peer);
      expect(await f.fresh("doctor install --host all")).toContain("Write refused");
      expect(existsSync(path.join(codex, second))).toBe(false);
      return;
    }
    skip("Effective user can traverse mode-000 directories.");
  } finally {
    chmodSync(path.dirname(peer), 0o700);
  }
});

it("repairs an owned link whose raw target resolves through a nested symlink to a different manifest", async () => {
  const f = setup();
  const packageRoot = path.join(f.root, "package");
  fixtureState.packageRoot = packageRoot;
  for (const name of WORKFLOW_SKILL_NAMES) {
    const dir = path.join(packageRoot, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "packaged");
  }
  const shadow = path.join(f.root, "team", "package", "skills", first);
  const child = path.join(f.root, "team", "child");
  mkdirSync(shadow, { recursive: true });
  mkdirSync(child);
  writeFileSync(path.join(shadow, "SKILL.md"), "shadow");
  symlinkSync(child, path.join(f.root, "jump"));
  await f.run("doctor install --host codex");
  const skills = path.join(f.home, ".agents", "skills");
  const hostLink = path.join(skills, first);
  unlinkSync(hostLink);
  symlinkSync(`${f.root}/jump/../package/skills/${first}`, hostLink);
  writeProofs(
    skills,
    WORKFLOW_SKILL_NAMES.map((name) => proof(path.join(skills, name))),
  );
  expect(readFileSync(path.join(hostLink, "SKILL.md"), "utf8")).toBe("shadow");
  expect(await f.fresh("doctor check --host codex")).toContain(`${first}: stale`);
  expect(await f.fresh("doctor install --host codex")).toContain(`${first}: replaced`);
  expect(readFileSync(path.join(hostLink, "SKILL.md"), "utf8")).toBe("packaged");
  expect(readFileSync(path.join(shadow, "SKILL.md"), "utf8")).toBe("shadow");
});

it("chooses a viewer at the actual Pi geometry and preserves a full result if it fails after install", async () => {
  const f = setup("tui");
  const ui = f.harness.ctx.ui;
  const setWidget = ui.setWidget.bind(ui);
  const custom = ui.custom!.bind(ui);
  let escapeIsReservedByWidget: boolean | undefined;
  ui.custom = (...args) => {
    escapeIsReservedByWidget = f.harness.terminalInputHandlers.size > 0;
    return custom(...args);
  };
  ui.setWidget = (key, content, options) => {
    setWidget(key, content, options);
    if (key === "workflows" && typeof content === "function") {
      const widget = content({ requestRender() {}, terminal: { rows: 9 } }, {}) as { render(width: number): string[] };
      widget.render(50);
    }
  };
  f.harness.customInputQueue.push("end", "\x1b");
  await f.run("doctor");
  await expect.poll(() => f.harness.customRenderFrames.flat().join(" ")).toContain("Claude Code");
  expect(escapeIsReservedByWidget).toBe(false);
  await expect.poll(() => f.harness.terminalInputHandlers.size).toBe(1);
  ui.custom = async () => {
    throw new Error("viewer failed");
  };
  await f.run("doctor install --host all");
  await expect.poll(() => f.harness.notifications.join("\n")).toMatch(/Codex[\s\S]+4\/4[\s\S]+Claude Code[\s\S]+4\/4/u);
  expect(existsSync(path.join(f.home, ".agents", "skills", first))).toBe(true);
  expect(existsSync(path.join(f.home, ".claude", "skills", first))).toBe(true);
});

it("describes the unresolved case when both missing tails may alias and case rules are unknown", async () => {
  const f = setup();
  const alternate = path.join(f.home, ".CLAUDE");
  vi.stubEnv("CLAUDE_CONFIG_DIR", alternate);
  expect(await f.fresh("doctor check --host claude")).toContain("Cannot determine whether");
  expect(await f.fresh("doctor install --host claude")).toContain("Write refused");
  expect(existsSync(alternate)).toBe(false);
});

it("qualifies the physical Claude user folder and its own check after an all-host refusal and incomplete rollback", async () => {
  const f = setup();
  const alternate = path.join(f.root, "alternate");
  const linked = path.join(f.root, "linked-home");
  symlinkSync(f.home, linked);
  vi.stubEnv("HOME", linked);
  vi.stubEnv("CLAUDE_CONFIG_DIR", alternate);
  const skills = path.join(f.home, ".claude", "skills");
  const marker = path.join(skills, WORKFLOW_SKILL_STATE_FILE);
  mkdirSync(skills, { recursive: true });
  writeFileSync(marker, "foreign");
  const refused = (await f.fresh("doctor install --host all")).replace(/\n/gu, " ");
  expect(refused).toContain(`${claude} ${skills}`);
  expect(refused).toContain("/workflows doctor check --host claude --scope user");
  expect(refused).toContain("Check: /workflows doctor check --host all --scope user");
  expect(refused).not.toContain(linked);
  unlinkSync(marker);
  fixtureState.fault = (file, boundary) => {
    if (boundary === "after-guard" && file === marker) writeFileSync(marker, "foreign", { flag: "wx" });
  };
  await f.fresh("doctor install --host claude");
  const report = await f.fresh("doctor recovery");
  expect(report).toContain(`${claude} ${skills}`);
  expect(report).toContain("/workflows doctor check --host claude --scope user");
  expect(await f.fresh("skills sync --host claude")).toContain("Logical HOME path");
});

it.each(["inode", "target", "encoding"])(
  "refuses an invalid v2 marker with invalid %s and shows its path",
  async (bad) => {
    const f = setup();
    const skills = path.join(f.home, ".agents", "skills");
    const marker = path.join(skills, WORKFLOW_SKILL_STATE_FILE);
    mkdirSync(skills, { recursive: true });
    if (bad === "encoding") writeFileSync(marker, Buffer.from([0xff]));
    else
      writeProofs(skills, [
        {
          name: first,
          target: bad === "target" ? "" : "/old",
          identity: { device: "1", inode: bad === "inode" ? "00" : "1", born: "2", changed: "3" },
        },
      ]);
    const before = readFileSync(marker);
    const refused = await f.fresh("doctor remove --host codex");
    expect(refused).toContain("Write refused");
    expect(refused.replace(/\n/gu, "")).toContain(marker);
    expect(readFileSync(marker)).toEqual(before);
  },
);

it("counts retired managed links awaiting removal and labels their details", async () => {
  const f = setup();
  const skills = path.join(f.home, ".agents", "skills");
  await f.run("doctor install --host codex");
  const retired = path.join(skills, "locus-pi-workflows");
  symlinkSync("/old-package/locus-pi-workflows", retired);
  writeProofs(skills, [...WORKFLOW_SKILL_NAMES.map((name) => proof(path.join(skills, name))), proof(retired)]);
  expect(await f.fresh("doctor")).toContain("1 pending removal");
  const detail = await f.fresh("doctor check --host codex");
  expect(detail).toContain("locus-pi-workflows: pending removal");
  expect(detail).toContain("/workflows doctor install --host codex --scope user");
});

it("returns only the host groups as the source of per-entry results", () => {
  const f = setup();
  const result = operateWorkflowSkillHosts({
    action: "status",
    host: "all",
    scope: "user",
    userHome: f.home,
    projectRoot: f.project,
  });
  expect(result).not.toHaveProperty("rows");
  expect(result.groups.map((group) => group.rows.length)).toEqual([8, 8]);
});

it("keeps Info and Doctor discoverable in bounded RPC help", async () => {
  const f = setup();
  await f.run("");
  const help = f.harness.widgets.get("workflows")!;
  expect(help).toContain("/workflows info [exact-name]");
  expect(help.replace(/\s+/gu, " ")).toContain(
    "/workflows doctor [check|install|remove] [--host codex|claude|all] [--scope user|project]",
  );
});

it.each([".agentſ", ".ａｇｅｎｔｓ"])(
  "refuses missing Unicode alias %s when case rules cannot be established",
  async (name) => {
    const f = setup();
    const alternate = path.join(f.home, name);
    const selected = path.join(f.home, ".agents");
    vi.stubEnv("CLAUDE_CONFIG_DIR", alternate);

    const check = await f.fresh("doctor check --host codex");
    const refused = await f.fresh("doctor install --host codex");
    expect(refused).toContain("Write refused");
    expect(check).not.toContain("/workflows doctor install");
    expect(check).toContain("Cannot determine whether");
    expect(refused.replace(/\n/gu, "")).toContain(path.join(alternate, "skills"));
    expect(existsSync(selected)).toBe(false);
    expect(existsSync(alternate)).toBe(false);
  },
);

it("repairs links to an old skill directory even when it shares the new manifest", async () => {
  const f = setup();
  const oldPackage = path.join(f.root, "old-package");
  const newPackage = path.join(f.root, "new-package");
  for (const [root, guide] of [
    [oldPackage, "previous"],
    [newPackage, "current"],
  ] as const) {
    for (const name of WORKFLOW_SKILL_NAMES) {
      const skill = path.join(root, "skills", name);
      mkdirSync(path.join(skill, "references"), { recursive: true });
      writeFileSync(path.join(skill, "SKILL.md"), guide);
      writeFileSync(path.join(skill, "references", "guide.md"), guide);
    }
  }
  fixtureState.packageRoot = oldPackage;
  await f.run("doctor install --host codex");
  const link = path.join(f.home, ".agents", "skills", first);
  const oldManifest = path.join(oldPackage, "skills", first, "SKILL.md");
  unlinkSync(oldManifest);
  symlinkSync(path.join(newPackage, "skills", first, "SKILL.md"), oldManifest);
  fixtureState.packageRoot = newPackage;

  expect(readFileSync(path.join(link, "SKILL.md"), "utf8")).toBe("current");
  expect(readFileSync(path.join(link, "references", "guide.md"), "utf8")).toBe("previous");
  expect(await f.fresh("doctor check --host codex")).toContain(`${first}: stale`);
  expect(await f.fresh("doctor install --host codex")).toContain(`${first}: replaced`);
  expect(readlinkSync(link)).toBe(path.join(newPackage, "skills", first));
  expect(readFileSync(path.join(link, "references", "guide.md"), "utf8")).toBe("current");
  expect(readFileSync(path.join(path.dirname(oldManifest), "references", "guide.md"), "utf8")).toBe("previous");
  unlinkSync(path.join(newPackage, "skills", first, "SKILL.md"));
  expect(await f.fresh("doctor check --host codex")).toContain("Package skill source unavailable");
});

it("reports rejected unlink after a foreign directory replaces an owned link", async () => {
  const f = setup();
  const skills = path.join(f.project, ".agents", "skills");
  const replaced = path.join(skills, first);
  const laterLink = path.join(skills, second);
  const marker = path.join(skills, WORKFLOW_SKILL_STATE_FILE);
  const sentinel = path.join(replaced, "foreign");
  await f.run("doctor install --host codex --scope project");
  const before = readFileSync(marker);
  const laterProof = proof(laterLink);
  fixtureState.fault = (file, boundary) => {
    if (file !== replaced || boundary !== "after-guard") return;
    unlinkSync(replaced);
    mkdirSync(replaced);
    writeFileSync(sentinel, "preserve");
  };

  const outcome = await f.fresh("doctor remove --host codex --scope project");
  const report = await f.fresh("doctor recovery");
  expect(readFileSync(sentinel, "utf8")).toBe("preserve");
  expect(readFileSync(marker)).toEqual(before);
  expect(proof(laterLink)).toEqual(laterProof);
  expect(outcome).toContain("Incomplete rollback");
  expect(report).toMatch(/EPERM|EISDIR|EACCES/u);
  expect(report).toContain(`Skipped or failed: ${replaced}`);
  expect(report).toContain("/workflows doctor check --host codex --scope project");
});

it("keeps a rejected unlink with matching readback a refusal with no recovery record", async () => {
  const f = setup();
  await f.run("doctor install --host codex");
  const link = path.join(f.home, ".agents", "skills", first);
  const before = proof(link);
  const unlink = fs.unlinkSync;
  const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
    if (file === link) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    unlink(file);
  });
  syncBuiltinESMExports();
  try {
    expect(await f.fresh("doctor remove --host codex")).toContain("Write refused");
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(proof(link)).toEqual(before);
  expect(await f.fresh("doctor recovery")).toContain("No incomplete rollback");
});
