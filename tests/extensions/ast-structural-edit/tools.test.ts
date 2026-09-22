import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import astGrep from "../../../extensions/ast-structural-edit/ast-grep.js";
import astEdit from "../../../extensions/ast-structural-edit/ast-edit.js";
import astApply from "../../../extensions/ast-structural-edit/resolve.js";
import astStructuralEdit from "../../../extensions/ast-structural-edit/index.js";
import { createHarness, runTool } from "../../test-harness.js";

async function fixtureRoot() {
  const dir = path.join(tmpdir(), `pi-dev-ext-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "sample.ts"),
    "function greet(name) { return name }\nconst value = greet('x')\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "sample.py"),
    "def greet(name):\n    return name\n\nvalue = greet('x')\ntext = \"greet('string')\"\n# greet('comment')\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "script.txt"),
    "def greet(name):\n    return name\n\nvalue = greet('override')\n",
    "utf8",
  );
  return dir;
}

describe("AST/LSP/dev tools", () => {
  it("finds, previews, applies, and rejects stale AST edits", async () => {
    const root = await fixtureRoot();
    const h = createHarness(root);
    astStructuralEdit(h.pi);
    const grep = await runTool(h, "ast_grep", { pat: "greet($A)", paths: ["sample.ts"] });
    expect(grep.details?.totalMatches).toBeGreaterThan(0);
    const preview = await runTool(h, "ast_edit", {
      ops: [{ pat: "greet($A)", out: "hello($A)" }],
      paths: ["sample.ts"],
    });
    expect(await readFile(path.join(root, "sample.ts"), "utf8")).toContain("greet('x')");
    const previewId = String(preview.details?.previewId);
    const applied = await runTool(h, "resolve", { action: "apply", reason: "test apply" });
    expect(applied.isError).not.toBe(true);
    expect(applied.details).toMatchObject({ extra: { previewId }, filesApplied: 1 });
    expect(await readFile(path.join(root, "sample.ts"), "utf8")).toContain("hello('x')");
    expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);

    const stale = await runTool(h, "ast_edit", { ops: [{ pat: "hello($A)", out: "greet($A)" }], paths: ["sample.ts"] });
    const staleId = String(stale.details?.previewId);
    await writeFile(path.join(root, "sample.ts"), "changed()\n", "utf8");
    const rejected = await runTool(h, "resolve", {
      action: "apply",
      reason: "test stale apply",
      extra: { previewId: staleId },
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.details).toMatchObject({ stale: [path.join(root, "sample.ts")] });
    expect(await readFile(path.join(root, "sample.ts"), "utf8")).toBe("changed()\n");
  });

  it("discards the latest pending AST preview without writing files", async () => {
    const root = await fixtureRoot();
    const h = createHarness(root);
    astEdit(h.pi);
    astApply(h.pi);
    const preview = await runTool(h, "ast_edit", {
      ops: [{ pat: "greet($A)", out: "hello($A)" }],
      paths: ["sample.ts"],
    });
    const previewId = String(preview.details?.previewId);

    const discarded = await runTool(h, "resolve", { action: "discard", reason: "not needed" });

    expect(discarded.isError).not.toBe(true);
    expect(discarded.details).toMatchObject({ action: "discard", extra: { previewId } });
    expect(await readFile(path.join(root, "sample.ts"), "utf8")).toContain("greet('x')");
    expect(await readFile(path.join(root, "sample.ts"), "utf8")).not.toContain("hello('x')");
    const retry = await runTool(h, "resolve", { action: "apply", reason: "should be gone" });
    expect(retry.isError).toBe(true);
    expect(retry.content[0]?.type === "text" ? retry.content[0].text : "").toContain("No pending action to resolve");
  });

  it("supports Python AST search, rewrite, language override, and stale rejection", async () => {
    const root = await fixtureRoot();
    const h = createHarness(root);
    astGrep(h.pi);
    astEdit(h.pi);
    astApply(h.pi);

    const grep = await runTool(h, "ast_grep", { pat: "greet($A)", paths: ["sample.py"] });
    expect(grep.details?.totalMatches).toBe(1);
    expect(String(grep.content[0]?.type === "text" ? grep.content[0].text : "")).toContain("greet('x')");
    expect(String(grep.content[0]?.type === "text" ? grep.content[0].text : "")).not.toContain("comment");
    expect(String(grep.content[0]?.type === "text" ? grep.content[0].text : "")).not.toContain("string");

    const override = await runTool(h, "ast_grep", { pat: "greet($A)", paths: ["script.txt"], language: "python" });
    expect(override.details?.totalMatches).toBe(1);
    expect((await runTool(h, "ast_grep", { pat: "greet($A)", paths: ["script.txt"] })).isError).toBe(true);

    const preview = await runTool(h, "ast_edit", {
      ops: [{ pat: "greet($A)", out: "hello($A)" }],
      paths: ["sample.py"],
      language: "python",
    });
    const previewId = String(preview.details?.previewId);
    const applied = await runTool(h, "resolve", { action: "apply", reason: "test python apply", extra: { previewId } });
    expect(applied.isError).not.toBe(true);
    expect(await readFile(path.join(root, "sample.py"), "utf8")).toContain("hello('x')");

    const stale = await runTool(h, "ast_edit", { ops: [{ pat: "hello($A)", out: "greet($A)" }], paths: ["sample.py"] });
    const staleId = String(stale.details?.previewId);
    await writeFile(path.join(root, "sample.py"), "changed()\n", "utf8");
    const rejected = await runTool(h, "resolve", {
      action: "apply",
      reason: "test python stale apply",
      extra: { previewId: staleId },
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.details).toMatchObject({ stale: [path.join(root, "sample.py")] });
    expect(await readFile(path.join(root, "sample.py"), "utf8")).toBe("changed()\n");
  });
});
