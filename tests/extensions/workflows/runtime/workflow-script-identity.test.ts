import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadWorkflowScript,
  runWorkflowScript,
  type RunWorkflowScriptResult,
} from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  packagedWorkflowNames,
  packagedWorkflowPath,
} from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import {
  assessWorkflowSourceIdentity,
  createWorkflowScriptSnapshot,
  workflowScriptExecutionPath,
} from "../../../../extensions/workflows/runtime/workflow-script-identity.js";
import { readWorkflowRunResult } from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  ensureWorkflowRunDir,
  workflowRunDir,
  workflowRunRuntimeDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { createHarness } from "../../../test-harness.js";

async function runScript(root: string, scriptPath: string, sessionId: string): Promise<RunWorkflowScriptResult> {
  const harness = createHarness(root, { sessionId });
  return await runWorkflowScript({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    scriptPath,
  });
}

describe("workflow script identity coverage", () => {
  it("classifies only static node imports as self-contained-static by default", () => {
    expect(assessWorkflowSourceIdentity("export default () => true;\n")).toEqual({
      identityCoverage: "self-contained-static",
      builtinImports: [],
      unboundDependencies: [],
    });
    expect(
      assessWorkflowSourceIdentity(
        [
          'import path from "node:path";',
          'export { readFileSync } from "node:fs";',
          "export default () => path.sep;",
        ].join("\n"),
      ),
    ).toEqual({
      identityCoverage: "self-contained-static",
      builtinImports: ["node:fs", "node:path"],
      unboundDependencies: [],
    });

    const unbound = [
      'import "./helper.mjs";',
      'import thing from "some-package";',
      'import "file:///tmp/helper.mjs";',
      'import "/tmp/helper.mjs";',
      'import "data:text/javascript,export default 1";',
      'export * from "./helper.mjs";',
      'const helper = import("./helper.mjs");',
      'const helper = require("./helper.cjs");',
      'const helper = (require)("./helper.cjs");',
      "export default () => import.meta.url;",
    ];
    for (const source of unbound) {
      expect(() => assessWorkflowSourceIdentity(source)).toThrow(/outside self-contained-static identity/u);
    }

    // The policy accounts for declared/direct source edges, not arbitrary code
    // loading by trusted host code. Authors must explicitly downgrade these
    // indirect forms even though static analysis cannot prove their behavior.
    expect(
      assessWorkflowSourceIdentity(
        [
          'import { createRequire as makeRequire } from "node:module";',
          'const load = makeRequire("/tmp/entry.mjs");',
          'eval("import(\\"./helper.mjs\\")");',
          "export default () => typeof load;",
        ].join("\n"),
      ),
    ).toEqual({
      identityCoverage: "self-contained-static",
      builtinImports: ["node:module"],
      unboundDependencies: [],
    });
  });

  it("keeps curated identity coverage explicit for static and resource-backed workflows", () => {
    for (const name of packagedWorkflowNames()) {
      const assessment = assessWorkflowSourceIdentity(readFileSync(packagedWorkflowPath(name), "utf8"));
      expect(assessment, name).toMatchObject({
        identityCoverage: "self-contained-static",
        unboundDependencies: [],
      });
    }
  });

  it("executes exact snapshots and refreshes changed entry bytes in one process", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-strict-"));
    const scriptPath = path.join(root, "strict.workflow.mjs");
    const sourceA = "export default () => ({ version: 'A' });\n";
    const sourceB = "export default () => ({ version: 'B' });\n";
    try {
      writeFileSync(scriptPath, sourceA, "utf8");
      const first = await runScript(root, "strict.workflow.mjs", "wf-identity-strict-a");
      writeFileSync(scriptPath, sourceB, "utf8");
      const second = await runScript(root, "strict.workflow.mjs", "wf-identity-strict-b");

      expect(first).toMatchObject({ ok: true, result: { version: "A" } });
      expect(second).toMatchObject({ ok: true, result: { version: "B" } });
      expect(first.scriptIdentity).toMatchObject({
        schemaVersion: 2,
        identityPolicy: "static-node-only-v1",
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
        sourcePath: scriptPath,
        builtinImports: [],
        unboundDependencies: [],
      });
      expect(second.scriptIdentity).toMatchObject({
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
      });
      expect(first.scriptIdentity?.scriptSha256).not.toBe(second.scriptIdentity?.scriptSha256);
      expect(readFileSync(first.scriptIdentity!.snapshotPath, "utf8")).toBe(sourceA);
      expect(readFileSync(second.scriptIdentity!.snapshotPath, "utf8")).toBe(sourceB);
      expect(first.scriptIdentity?.nodeVersion).toBe(process.version);
      expect(first.scriptIdentity?.platform).toBe(process.platform);
      expect(first.scriptIdentity?.arch).toBe(process.arch);

      const persisted = readWorkflowRunResult(root, first.runId);
      expect(persisted?.scriptIdentity).toEqual(first.scriptIdentity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows static node builtins while executing the retained snapshot", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-builtin-"));
    try {
      writeFileSync(
        path.join(root, "builtin.workflow.mjs"),
        'import path from "node:path";\nexport default () => ({ value: path.basename("/a/b") });\n',
        "utf8",
      );
      const result = await runScript(root, "builtin.workflow.mjs", "wf-identity-builtin");
      expect(result).toMatchObject({ ok: true, result: { value: "b" } });
      expect(result.scriptIdentity).toMatchObject({
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
        builtinImports: ["node:path"],
        unboundDependencies: [],
      });
      expect(workflowScriptExecutionPath(result.scriptIdentity!)).toBe(result.scriptIdentity?.snapshotPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unlabelled relative dependency before either module is evaluated", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-reject-"));
    const marker = path.join(root, "evaluated.marker");
    try {
      writeFileSync(
        path.join(root, "helper.mjs"),
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "helper"); export const value = 1;\n`,
        "utf8",
      );
      writeFileSync(
        path.join(root, "reject.workflow.mjs"),
        'import { value } from "./helper.mjs"; export default () => ({ value });\n',
        "utf8",
      );

      const result = await runScript(root, "reject.workflow.mjs", "wf-identity-reject");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/outside self-contained-static identity/u);
      expect(result.scriptIdentity).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
      expect(JSON.parse(readFileSync(result.resultPersistence.path, "utf8"))).toMatchObject({ ok: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("permits a literal entry-only downgrade and records unbound helper evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-entry-only-"));
    const scriptPath = path.join(root, "modular.workflow.mjs");
    const entrySource = [
      'export const meta = { identityCoverage: "entry-only" };',
      'import { value } from "./helper.mjs";',
      "export default () => ({ value });",
      "",
    ].join("\n");
    try {
      writeFileSync(path.join(root, "helper.mjs"), "export const value = 'v1';\n", "utf8");
      writeFileSync(scriptPath, entrySource, "utf8");
      const first = await runScript(root, "modular.workflow.mjs", "wf-identity-entry-only-a");
      writeFileSync(path.join(root, "helper.mjs"), "export const value = 'v2';\n", "utf8");
      const second = await runScript(root, "modular.workflow.mjs", "wf-identity-entry-only-b");

      expect(first).toMatchObject({ ok: true, result: { value: "v1" } });
      expect(first.scriptIdentity).toMatchObject({
        identityCoverage: "entry-only",
        executionSource: "source",
        builtinImports: [],
        unboundDependencies: ["import:./helper.mjs"],
      });
      expect(workflowScriptExecutionPath(first.scriptIdentity!)).toBe(scriptPath);
      expect(second.scriptIdentity?.scriptSha256).toBe(first.scriptIdentity?.scriptSha256);
      expect(second.scriptIdentity?.identityCoverage).toBe("entry-only");
      expect(readFileSync(path.join(root, "helper.mjs"), "utf8")).toContain("v2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a literal opt-out and downgrades old persisted identity", () => {
    expect(() =>
      assessWorkflowSourceIdentity(
        [
          'const coverage = "entry-only";',
          "export const meta = { identityCoverage: coverage };",
          'import "./helper.mjs";',
        ].join("\n"),
      ),
    ).toThrow(/must be the literal/u);
    expect(() =>
      assessWorkflowSourceIdentity(
        ['export const meta = { identityCoverage: "unknown" };', "export default () => true;"].join("\n"),
      ),
    ).toThrow(/must be the literal/u);

    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-legacy-"));
    const runId = "legacy-run";
    try {
      const runDir = workflowRunDir(root, runId);
      mkdirSync(workflowRunRuntimeDir(runDir), { recursive: true });
      writeFileSync(
        workflowResultFile(runDir),
        JSON.stringify({
          ok: true,
          scriptIdentity: {
            sourcePath: "/private/legacy.workflow.mjs",
            snapshotPath: path.join(workflowRunRuntimeDir(runDir), `script-${"a".repeat(64)}.workflow.mjs`),
            scriptSha256: "a".repeat(64),
          },
        }),
        "utf8",
      );
      expect(readWorkflowRunResult(root, runId)?.scriptIdentity).toMatchObject({
        schemaVersion: 1,
        identityPolicy: "legacy-unversioned",
        identityCoverage: "entry-only-legacy",
        executionSource: "source",
        nodeVersion: "unknown",
      });

      const legacyFields = {
        sourcePath: "/private/legacy.workflow.mjs",
        snapshotPath: path.join(workflowRunRuntimeDir(runDir), `script-${"a".repeat(64)}.workflow.mjs`),
        scriptSha256: "a".repeat(64),
      };
      writeFileSync(
        workflowResultFile(runDir),
        JSON.stringify({
          ok: true,
          scriptIdentity: { ...legacyFields, schemaVersion: 3 },
        }),
        "utf8",
      );
      expect(readWorkflowRunResult(root, runId)?.scriptIdentity).toBeUndefined();

      writeFileSync(
        workflowResultFile(runDir),
        JSON.stringify({
          ok: true,
          scriptIdentity: {
            ...legacyFields,
            schemaVersion: 2,
            identityPolicy: "static-node-only-v1",
            identityCoverage: "self-contained-static",
            executionSource: "source",
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            builtinImports: ["node:fs"],
            unboundDependencies: ["import:./helper.mjs"],
          },
        }),
        "utf8",
      );
      expect(readWorkflowRunResult(root, runId)?.scriptIdentity).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds an explicit downgrade into snapshot bytes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-snapshot-"));
    const scriptPath = path.join(root, "entry.workflow.mjs");
    try {
      writeFileSync(
        scriptPath,
        'export const meta = { identityCoverage: "entry-only" }; export default () => true;\n',
        "utf8",
      );
      const runDir = ensureWorkflowRunDir(root, "20260812-010101-a001");
      const identity = createWorkflowScriptSnapshot(scriptPath, workflowRunRuntimeDir(runDir));
      expect(identity).toMatchObject({ identityCoverage: "entry-only", executionSource: "source" });
      expect(readFileSync(identity.snapshotPath, "utf8")).toContain('identityCoverage: "entry-only"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads strict bytes from the snapshot after the source changes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-snapshot-source-"));
    const scriptPath = path.join(root, "entry.workflow.mjs");
    try {
      writeFileSync(scriptPath, "export default () => 'captured';\n", "utf8");
      const runDir = ensureWorkflowRunDir(root, "20260812-010101-a002");
      const identity = createWorkflowScriptSnapshot(scriptPath, workflowRunRuntimeDir(runDir));
      writeFileSync(scriptPath, "export default () => 'mutated-source';\n", "utf8");
      const mod = await loadWorkflowScript(
        workflowScriptExecutionPath(identity),
        identity.scriptSha256,
        identity.executionSource,
      );
      expect(mod.default?.({} as never)).toBe("captured");
      expect(readFileSync(scriptPath, "utf8")).toContain("mutated-source");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a run-scoped module cache key for explicit entry-only sources", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-cache-scope-"));
    const globalKey = `__wf_identity_${path.basename(root).replace(/\W/gu, "_")}`;
    try {
      writeFileSync(
        path.join(root, "entry.workflow.mjs"),
        [
          'export const meta = { identityCoverage: "entry-only" };',
          `globalThis[${JSON.stringify(globalKey)}] = (globalThis[${JSON.stringify(globalKey)}] ?? 0) + 1;`,
          `const moduleInstance = globalThis[${JSON.stringify(globalKey)}];`,
          "export default () => ({ moduleInstance });",
          "",
        ].join("\n"),
        "utf8",
      );

      const first = await runScript(root, "entry.workflow.mjs", "wf-identity-cache-scope-a");
      const second = await runScript(root, "entry.workflow.mjs", "wf-identity-cache-scope-b");
      expect(first).toMatchObject({ ok: true, result: { moduleInstance: 1 } });
      expect(second).toMatchObject({ ok: true, result: { moduleInstance: 2 } });
      expect(second.scriptIdentity).toMatchObject({ identityCoverage: "entry-only", executionSource: "source" });
    } finally {
      delete (globalThis as Record<string, unknown>)[globalKey];
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when a retained snapshot changes during top-level evaluation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-eval-tamper-"));
    const harness = createHarness(root, { sessionId: "wf-identity-eval-tamper" });
    let runDir: string | undefined;
    let tampered = false;
    const timer = setInterval(() => {
      if (runDir === undefined || tampered) return;
      const runtimeDir = workflowRunRuntimeDir(runDir);
      const snapshot = readdirSync(runtimeDir).find(
        (name) => name.startsWith("script-") && name.endsWith(".workflow.mjs"),
      );
      if (snapshot === undefined) return;
      const snapshotPath = path.join(runtimeDir, snapshot);
      chmodSync(snapshotPath, 0o644);
      appendFileSync(snapshotPath, "\n// evaluation tamper\n", "utf8");
      tampered = true;
    }, 1);
    try {
      writeFileSync(
        path.join(root, "entry.workflow.mjs"),
        "await new Promise((resolve) => setTimeout(resolve, 80));\nexport default () => true;\n",
        "utf8",
      );
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "entry.workflow.mjs",
        onRunStart: (run) => {
          runDir = run.runDir;
        },
      });
      expect(tampered).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/snapshot hash mismatch/u);
    } finally {
      clearInterval(timer);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when script-owned toJSON mutates the retained snapshot", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-identity-tojson-tamper-"));
    const workflowsRoot = path.join(root, ".locus-pi", "runs");
    try {
      writeFileSync(
        path.join(root, "entry.workflow.mjs"),
        [
          'import { appendFileSync, chmodSync, readdirSync } from "node:fs";',
          'import path from "node:path";',
          `const workflowsRoot = ${JSON.stringify(workflowsRoot)};`,
          "export default () => ({",
          "  toJSON() {",
          "    const runId = readdirSync(workflowsRoot)[0];",
          "    const runDir = path.join(workflowsRoot, runId);",
          "    const runtimeDir = path.join(runDir, 'runtime');",
          "    const snapshot = readdirSync(runtimeDir).find((name) => name.startsWith('script-'));",
          "    const snapshotPath = path.join(runtimeDir, snapshot);",
          "    chmodSync(snapshotPath, 0o644);",
          "    appendFileSync(snapshotPath, '\\n// toJSON tamper\\n');",
          "    return { escaped: true };",
          "  },",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runScript(root, "entry.workflow.mjs", "wf-identity-tojson-tamper");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/snapshot hash mismatch/u);
      expect(result.result).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
