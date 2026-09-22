import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHarness } from "../../../test-harness.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";

/**
 * Iskhod-1 regression: a workflow failure must be CONTAINED as ok:false with an
 * honest error, and must never crash the host pi process.
 *
 * The detached-rejection case is the load-bearing one: an unawaited Promise.reject
 * inside the workflow body escapes the awaited try/catch and, without the
 * run-scoped guard in runWorkflowScript, reaches Node's default unhandledRejection
 * handler and terminates the process. We assert the run resolves ok:false carrying
 * the real error text instead.
 */

function writeWorkflow(root: string, name: string, body: string): void {
  const dir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.workflow.mjs`), body, "utf8");
}

async function runNamed(root: string, name: string) {
  const h = createHarness(root);
  return runWorkflowScript({
    pi: h.pi,
    ctx: h.ctx,
    signal: new AbortController().signal,
    name,
  });
}

describe("workflow runner — host-crash containment (Iskhod-1)", () => {
  it("contains a synchronous throw in the workflow body as ok:false", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-crash-sync-"));
    try {
      writeWorkflow(root, "boom-sync", `export default async function () { throw new Error("boom"); }\n`);
      const res = await runNamed(root, "boom-sync");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("boom");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains a DETACHED promise rejection (out-of-band) as ok:false without crashing the host", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-crash-detached-"));
    try {
      writeWorkflow(
        root,
        "boom-detached",
        // Unawaited, uncaught rejection — the class that killed pi under a dead model.
        `export default async function () {\n` +
          `  Promise.reject(new Error("model openai-codex gpt-5.5 failed to resolve/auth"));\n` +
          `  await new Promise((r) => setTimeout(r, 30));\n` +
          `  return { ok: true };\n` +
          `}\n`,
      );
      const res = await runNamed(root, "boom-detached");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("openai-codex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still returns ok:true for a clean workflow (guard does not false-trip)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-crash-clean-"));
    try {
      writeWorkflow(root, "clean", `export default async function () { return { ok: true, value: 42 }; }\n`);
      const res = await runNamed(root, "clean");
      expect(res.ok).toBe(true);
      expect(res.result).toMatchObject({ ok: true, value: 42 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // T-148: refcounted guard hardening (re-entrant safety + no listener leak).
  //
  // SCOPE NOTE (honest framing): the real Iskhod-1 crash-fix is the guard catching
  // an out-of-band reject/throw DURING a run (proven by `boom-detached` above) —
  // without it Node's default handler kills the host. The refcount is a separate
  // DESIGN change: it collapses the previous per-run install/remove into ONE shared
  // listener pair that lives while ANY run is active. It is robustness + simplicity
  // (one pair instead of N under overlap, no accumulation), NOT a fix for a
  // demonstrated overlap crash — the old per-run scheme used a fresh closure pair
  // per run, so one run's removeListener never touched another run's distinct
  // handler; overlap survived under the old scheme too. These cases therefore prove
  // CORRECTNESS of the refcount: (a) nested workflow() stays inline and never
  // re-installs, (b) overlapping top-level runs are each contained and attributed
  // to the right run, and (c) refcount returns to baseline with no listener leak.
  // ---------------------------------------------------------------------------

  function hostCrashListenerCounts(): { rej: number; exc: number } {
    return {
      rej: process.listeners("unhandledRejection").length,
      exc: process.listeners("uncaughtException").length,
    };
  }

  it("ground truth: nested workflow() runs INLINE and a detached rejection inside it is still contained", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-crash-nested-"));
    try {
      // dsl.workflow(subFn) executes subFn inline (workflow-runtime.ts) — it does
      // NOT call runWorkflowScript recursively, so NO second guard is installed.
      // A detached rejection raised from the nested body is still caught by the
      // single top-level guard and contained as ok:false.
      const before = hostCrashListenerCounts();
      writeWorkflow(
        root,
        "nested",
        `export default async function (dsl) {\n` +
          `  return dsl.workflow(async () => {\n` +
          `    Promise.reject(new Error("nested-detached-boom"));\n` +
          `    await new Promise((r) => setTimeout(r, 30));\n` +
          `    return { ok: true };\n` +
          `  });\n` +
          `}\n`,
      );
      const res = await runNamed(root, "nested");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("nested-detached-boom");
      // No leak after a nested run settles (refcount returns to its baseline).
      expect(hostCrashListenerCounts()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overlapping top-level runs: a late detached rejection in the still-open run is contained and attributed to it (refcount correctness)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-crash-overlap-"));
    try {
      // FAST resolves quickly (its finally fires first). SLOW stays open long
      // enough that its detached rejection lands AFTER fast has finished. We assert
      // the shared refcounted guard is still armed for slow (so its late rejection
      // is contained as slow's ok:false, not a host crash) and that the refcount
      // returns to baseline once both settle — no listener leak.
      //
      // This is a CORRECTNESS check of the shared-pair refcount, NOT a regression
      // against the old per-run scheme: that scheme used a distinct closure pair per
      // run, so fast's removeListener removed only fast's own handler and slow's
      // separate handler stayed installed — overlap was already safe there. The
      // refcount's win is one shared pair instead of N (simpler, no accumulation),
      // which this test exercises rather than a previously-demonstrated overlap crash.
      const before = hostCrashListenerCounts();
      writeWorkflow(root, "fast", `export default async function () { return { ok: true }; }\n`);
      writeWorkflow(
        root,
        "slow",
        `export default async function () {\n` +
          `  await new Promise((r) => setTimeout(r, 40));\n` +
          `  Promise.reject(new Error("slow-late-detached"));\n` +
          `  await new Promise((r) => setTimeout(r, 40));\n` +
          `  return { ok: true };\n` +
          `}\n`,
      );
      const slowP = runNamed(root, "slow");
      const fastRes = await runNamed(root, "fast"); // finishes while slow is still open
      const slowRes = await slowP;
      expect(fastRes.ok).toBe(true);
      expect(slowRes.ok).toBe(false);
      expect(slowRes.error).toContain("slow-late-detached");
      // Both settled → refcount back to baseline, no leak.
      expect(hostCrashListenerCounts()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clean run leaves NO host-crash listener leak (refcount returns to zero)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-crash-noleak-"));
    try {
      const before = hostCrashListenerCounts();
      writeWorkflow(root, "noleak", `export default async function () { return { ok: true }; }\n`);
      const res = await runNamed(root, "noleak");
      expect(res.ok).toBe(true);
      const after = hostCrashListenerCounts();
      expect(after).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
