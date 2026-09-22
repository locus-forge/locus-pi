import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  matchWorkflowPhaseGroups,
  readWorkflowMeta,
  staticWorkflowMetaPhases,
} from "../../../../extensions/workflows/catalog/workflow-meta.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import {
  packagedWorkflowNames,
  packagedWorkflowPath,
} from "../../../../extensions/workflows/runtime/workflow-discovery.js";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness } from "../../../test-harness.js";

/**
 * T-113 — a workflow may declare its pipeline before anyone runs it.
 *
 * The load-bearing property is not the feature, it is the guarantee underneath:
 * the declaration is read from bytes, so cataloguing never imports or evaluates
 * a workflow module. Every fixture below is written to prove that by exploding
 * if it is ever executed.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(contents: string, name = "phased.workflow.mjs"): string {
  const root = mkdtempSync(path.join(tmpdir(), "wf-phases-"));
  roots.push(root);
  const file = path.join(root, name);
  writeFileSync(file, contents, "utf8");
  return file;
}

/** Phase titles a workflow actually emits, in source order. */
function phaseCallTitles(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...new Set([...source.matchAll(/\bphase\("([^"]+)"\)/gu)].map((match) => match[1]!))];
}

describe("static meta.phases", () => {
  it("reads a declared pipeline without importing or evaluating the module", () => {
    const file = fixture(
      [
        "export const meta = {",
        '  description: "Two declared stages.",',
        "  phases: [",
        '    { title: "plan", detail: "Decide  what   to do." },',
        '    { title: "apply" },',
        "  ],",
        "};",
        'throw new Error("must not execute");',
      ].join("\n"),
    );

    const meta = readWorkflowMeta(file);

    expect(meta.description).toBe("Two declared stages.");
    expect(meta.phases).toEqual([{ title: "plan", detail: "Decide what to do." }, { title: "apply" }]);
  });

  it("keeps phase scanning inside the same bounded prefix as the description", () => {
    const file = fixture(
      `${" ".repeat(70 * 1024)}export const meta = { description: "too late", phases: [{ title: "late" }] };\n`,
    );

    expect(readWorkflowMeta(file)).toEqual({ description: "no description", profile: "unclassified", phases: [] });
  });

  it("discards the whole declaration when any entry is not literal", () => {
    const interpolated = fixture(
      'const x = "p"; export const meta = { description: "d.", phases: [{ title: `${x}lan` }] };\n',
    );
    const computed = fixture('export const meta = { description: "d.", phases: buildPhases() };\n');
    const spread = fixture('export const meta = { description: "d.", phases: [{ ...base, title: "plan" }] };\n');
    const scalar = fixture('export const meta = { description: "d.", phases: ["plan", "apply"] };\n');
    const emptyTitle = fixture('export const meta = { description: "d.", phases: [{ title: "  " }] };\n');
    const badDetail = fixture('export const meta = { description: "d.", phases: [{ title: "plan", detail: 7 }] };\n');

    // A half-read pipeline would describe a shape the workflow does not have.
    for (const file of [interpolated, computed, spread, scalar, emptyTitle, badDetail]) {
      expect(readWorkflowMeta(file).phases, file).toEqual([]);
      // The description is independent and still readable.
      expect(readWorkflowMeta(file).description, file).toBe("d.");
    }
  });

  it("leaves a workflow that declares nothing exactly as it was", () => {
    const file = fixture('export const meta = { name: "plain", description: "No declaration." };\n');

    expect(readWorkflowMeta(file)).toEqual({
      description: "No declaration.",
      profile: "unclassified",
      phases: [],
    });
    expect(staticWorkflowMetaPhases('export const meta = { description: "x." };')).toEqual([]);
  });
});

describe("declared versus observed phases", () => {
  it("keeps declared order and marks what the run never reached", () => {
    const declared = [{ title: "plan", detail: "d" }, { title: "apply" }, { title: "verify" }];

    const groups = matchWorkflowPhaseGroups(declared, ["plan", "apply"]);

    expect(groups).toEqual([
      { title: "plan", detail: "d", declared: true, reached: true },
      { title: "apply", declared: true, reached: true },
      { title: "verify", declared: true, reached: false },
    ]);
  });

  it("gives an undeclared phase() its own group instead of failing", () => {
    const groups = matchWorkflowPhaseGroups([{ title: "plan" }], ["plan", "hotfix", "hotfix", "cleanup"]);

    expect(groups).toEqual([
      { title: "plan", declared: true, reached: true },
      { title: "hotfix", declared: false, reached: true },
      { title: "cleanup", declared: false, reached: true },
    ]);
  });

  it("reports every phase as unreached when a run emitted none", () => {
    expect(matchWorkflowPhaseGroups([{ title: "plan" }], [])).toEqual([
      { title: "plan", declared: true, reached: false },
    ]);
    expect(matchWorkflowPhaseGroups([], [])).toEqual([]);
  });
});

describe("/workflows status <runId> declared-versus-observed", () => {
  /** Declares two stages, reaches one of them, and emits one it never declared. */
  const DRIFTING_WORKFLOW = [
    "export const meta = {",
    '  name: "drifting",',
    '  description: "Declares two stages and takes a detour.",',
    '  phases: [{ title: "plan" }, { title: "verify" }],',
    "};",
    "export default async function runWorkflow(dsl) {",
    '  dsl.phase("plan");',
    '  await dsl.agent("work");',
    '  dsl.phase("extra");',
    "  return { ok: true };",
    "}",
    "",
  ].join("\n");

  it("marks an unreached declaration and gives an undeclared phase its own group", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-phase-status-"));
    roots.push(root);
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Phase test agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
    writeFileSync(path.join(root, ".locus-pi", "workflows", "drifting.workflow.mjs"), DRIFTING_WORKFLOW, "utf8");

    const runHarness = createHarness(root, { sessionId: "phase-run" });
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        return {
          status: "completed" as const,
          agentName: request.agent?.name ?? "sub-agent",
          reason: "answered",
          text: "ok",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });
    const run = await runWorkflowScript({
      pi: runHarness.pi,
      ctx: runHarness.ctx,
      signal: new AbortController().signal,
      name: "drifting",
      createExecutor,
    });
    expect(run.ok).toBe(true);

    const statusHarness = createHarness(root, { sessionId: "phase-status", mode: "rpc" });
    workflows(statusHarness.pi);
    await statusHarness.commands.get("workflows")!.handler(`status ${run.runId}`, statusHarness.ctx);
    const rendered = statusHarness.widgets.get("workflows") ?? "";

    // Declared order first, then the detour — and nothing failed because of it.
    expect(rendered).toContain("phases: 2/3 reached");
    expect(rendered).toContain("[x] plan");
    expect(rendered).toContain("[ ] verify");
    expect(rendered).toContain("[x] extra (undeclared)");
  });
});

describe("packaged workflow declarations", () => {
  it("declares exactly the unique literal phase() titles every phased workflow emits, in first-source order", () => {
    const declaring = packagedWorkflowNames().filter(
      (name) => readWorkflowMeta(packagedWorkflowPath(name)).phases.length > 0,
    );

    for (const name of declaring) {
      const file = packagedWorkflowPath(name);
      const declared = readWorkflowMeta(file).phases.map((phase) => phase.title);

      // Without this, a renamed stage or an omitted branch leaves the planned pipeline quietly lying.
      expect(declared, name).toEqual(phaseCallTitles(file));
    }
    expect(declaring.length).toBeGreaterThan(0);
  });

  it("keeps meta.phases optional across the packaged registry", () => {
    const undeclared = packagedWorkflowNames().filter(
      (name) => readWorkflowMeta(packagedWorkflowPath(name)).phases.length === 0,
    );

    // These entries each have one implicit stage; declaring it would be ceremony.
    // The post-code-review parent owns and declares their orchestration phases.
    expect(undeclared).toEqual([
      "live-smoke",
      "post-code-review/boundaries",
      "post-code-review/contracts",
      "post-code-review/necessity",
      "post-code-review/scope",
      "post-code-review/simplicity",
      "post-code-review/style",
      "post-code-review/synthesis",
    ]);
  });
});
