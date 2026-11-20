import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWorkflowRunResultText,
  resolveWorkflowRunId,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import {
  workflowResultFile,
  workflowResultTextFile,
  writeWorkflowResultText,
} from "../../../../extensions/workflows/runtime/workflow-result.js";
import {
  ensureWorkflowRunDir,
  workflowJournalFile,
  workflowRunDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { WorkflowFailureNotices } from "../../../../extensions/workflows/operator/operator-surface.js";
import { openWorkflowRunViewer } from "../../../../extensions/workflows/command/workflow-editor-handoff.js";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];
initTheme(undefined, false);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-result-text-"));
  roots.push(root);
  return root;
}

const REVIEW_TEXT = [
  "# Code Review",
  "",
  "## Verdict",
  "",
  "Needs changes",
  "",
  ...Array.from({ length: 60 }, (_value, index) => `Finding line ${index + 1} of the full review body.`),
  "",
  "## Last line of the review",
].join("\n");

/**
 * One finished run on disk. `resultText: false` exercises the JSON recovery path
 * when the readable output projection is unavailable.
 */
function writeFinishedRun(
  root: string,
  runId: string,
  result: unknown,
  options: { resultText?: boolean; ts?: string } = {},
): string {
  const runDir = workflowRunDir(root, runId);
  ensureWorkflowRunDir(root, runId);
  writeFileSync(
    workflowJournalFile(runDir),
    `${JSON.stringify({ ts: options.ts ?? "2026-07-26T21:27:52.000Z", runId, kind: "phase", phase: "review" })}\n`,
    "utf8",
  );
  writeFileSync(workflowResultFile(runDir), `${JSON.stringify({ runId, ok: true, result }, null, 2)}\n`, "utf8");
  if (options.resultText !== false) writeWorkflowResultText(runDir, result);
  return runDir;
}

describe("workflow result text persistence", () => {
  it("writes a prose result verbatim and leaves a structured result to result.json", () => {
    const root = makeRoot();
    const runDir = writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);

    const written = readFileSync(workflowResultTextFile(runDir), "utf8");
    expect(written).toContain("# Code Review");
    expect(written).toContain("## Last line of the review");
    expect(written.trimEnd()).toBe(REVIEW_TEXT.trimEnd());

    const structuredDir = writeFinishedRun(root, "20260726-212752-aa11", { verdict: "pass", findings: [] });
    expect(writeWorkflowResultText(structuredDir, { verdict: "pass" })).toBeUndefined();
  });

  it("reads the whole text back, including from result.json when the readable projection is missing", () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    writeFinishedRun(root, "20260725-101010-7f3a", REVIEW_TEXT, { resultText: false });

    const fresh = readWorkflowRunResultText(root, "20260726-212752-98cc");
    expect(fresh.status).toBe("ready");
    if (fresh.status !== "ready") return;
    expect(fresh.path.endsWith("workflow-result.md")).toBe(true);
    expect(fresh.text).toContain("## Last line of the review");

    const recovered = readWorkflowRunResultText(root, "20260725-101010-7f3a");
    expect(recovered.status).toBe("ready");
    if (recovered.status !== "ready") return;
    expect(recovered.path.endsWith("result.json")).toBe(true);
    expect(recovered.text).toContain("## Last line of the review");
    expect(recovered.text).not.toContain("\\n");
  });

  it.each([
    ["different prose", "accepted report", "refused report\n"],
    ["extra whitespace", "accepted report", "accepted report \n"],
    ["empty projection", "accepted report", ""],
    ["structured failure", { ok: false, status: "blocked" }, "stage committed\n"],
    ["no result", undefined, "stage committed\n"],
  ])("rejects a readable projection that disagrees with the envelope: %s", (_name, result, projection) => {
    const root = makeRoot();
    const runId = "20260726-212752-98cc";
    const runDir = writeFinishedRun(root, runId, result);
    mkdirSync(path.dirname(workflowResultTextFile(runDir)), { recursive: true });
    writeFileSync(workflowResultTextFile(runDir), projection, "utf8");

    expect(readWorkflowRunResultText(root, runId)).toMatchObject({ status: "invalid" });
    expect(readFileSync(workflowResultTextFile(runDir), "utf8")).toBe(projection);
  });

  it.each(["missing", "malformed"])("does not accept orphan Markdown with a %s envelope", (kind) => {
    const root = makeRoot();
    const runId = "20260726-212752-98cc";
    const runDir = writeFinishedRun(root, runId, REVIEW_TEXT);
    if (kind === "missing") rmSync(workflowResultFile(runDir));
    else writeFileSync(workflowResultFile(runDir), "{not-json", "utf8");

    expect(readWorkflowRunResultText(root, runId)).toMatchObject({ status: "none" });
    expect(readFileSync(workflowResultTextFile(runDir), "utf8")).toContain("# Code Review");
  });

  it.each(["report", "report\n", "report\n\n"])("accepts exactly the writer projection of %j", (result) => {
    const root = makeRoot();
    const runId = "20260726-212752-98cc";
    const runDir = writeFinishedRun(root, runId, result);
    expect(readWorkflowRunResultText(root, runId)).toEqual({
      status: "ready",
      runId,
      path: workflowResultTextFile(runDir),
      text: result.endsWith("\n") ? result : `${result}\n`,
    });
  });

  it("resolves the run id an operator actually has: the printed short suffix, or last", () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260725-101010-7f3a", "older run", { ts: "2026-07-25T10:10:10.000Z" });
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);

    expect(resolveWorkflowRunId(root, "20260726-212752-98cc")).toEqual({
      status: "resolved",
      runId: "20260726-212752-98cc",
    });
    expect(resolveWorkflowRunId(root, "98cc")).toEqual({ status: "resolved", runId: "20260726-212752-98cc" });
    expect(resolveWorkflowRunId(root, "#98cc")).toEqual({ status: "resolved", runId: "20260726-212752-98cc" });
    expect(resolveWorkflowRunId(root, "last")).toEqual({ status: "resolved", runId: "20260726-212752-98cc" });
    expect(resolveWorkflowRunId(root, "nope")).toEqual({ status: "not-found" });
    for (const malformed of ["../98cc", "bad/98cc", String.raw`bad\\98cc`, "#98cc/", "☃98cc"]) {
      expect(resolveWorkflowRunId(root, malformed)).toEqual({ status: "not-found" });
    }
  });

  it("rejects malformed selectors before consulting the project path or retained evidence", () => {
    let projectRootAccessed = false;
    const unreadableProjectRoot = {
      [Symbol.toPrimitive]() {
        projectRootAccessed = true;
        throw new Error("project root must not be consulted");
      },
    } as unknown as string;

    for (const malformed of ["../outside", "bad/id", String.raw`bad\\id`, "#bad/id", "☃", "a".repeat(129)]) {
      expect(resolveWorkflowRunId(unreadableProjectRoot, malformed)).toEqual({ status: "not-found" });
    }
    expect(projectRootAccessed).toBe(false);
  });

  it("refuses an ambiguous short id instead of opening the wrong run", () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260725-101010-98cc", "older run");
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);

    const resolution = resolveWorkflowRunId(root, "98cc");
    expect(resolution.status).toBe("ambiguous");
    if (resolution.status !== "ambiguous") return;
    expect(resolution.candidates).toHaveLength(2);
    expect(resolution.matched).toBe(2);
  });

  it("names retired workflows storage without reading or migrating it", async () => {
    const root = makeRoot();
    const runId = "20260720-101010-old1";
    const legacyDir = path.join(root, ".pi", "locus-pi", "workflows", runId);
    mkdirSync(legacyDir, { recursive: true });
    const marker = path.join(legacyDir, "marker.txt");
    writeFileSync(marker, "leave this untouched", "utf8");

    const resolution = resolveWorkflowRunId(root, runId);
    expect(resolution).toMatchObject({ status: "legacy", runId });
    if (resolution.status !== "legacy") return;
    expect(resolution.message).toContain("retired storage location");
    expect(resolution.message).toContain(legacyDir);
    expect(readWorkflowRunResultText(root, runId)).toMatchObject({ status: "none", message: resolution.message });

    const h = createHarness(root, { mode: "rpc" });
    workflows(h.pi);
    await h.commands.get("workflows")!.handler(`result ${runId}`, h.ctx);
    expect(h.widgets.get("workflows") ?? "").toContain("retired storage location");
    expect(readFileSync(marker, "utf8")).toBe("leave this untouched");
    expect(existsSync(workflowRunDir(root, runId))).toBe(false);
  });

  it("reports the real number of matching runs even when the listed candidates are capped", async () => {
    const root = makeRoot();
    for (const index of [1, 2, 3, 4, 5, 6]) writeFinishedRun(root, `2026072${index}-101010-98cc`, `run ${index}`);

    const resolution = resolveWorkflowRunId(root, "98cc");
    expect(resolution.status).toBe("ambiguous");
    if (resolution.status !== "ambiguous") return;
    // The list is what fits in a message; the count must stay the truth.
    expect(resolution.matched).toBe(6);
    expect(resolution.candidates).toHaveLength(5);

    const h = createHarness(root, { mode: "rpc" });
    workflows(h.pi);
    await h.commands.get("workflows")!.handler("result 98cc", h.ctx);
    const widget = h.widgets.get("workflows") ?? "";
    expect(widget).toContain("matches 6 runs");
    expect(widget).toContain("5 of 6 shown");
  });
});

describe("/workflows result", () => {
  it("opens the entire text scrollable, addressed by the short id the panel printed", async () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    const h = createHarness(root);
    h.ctx.hasUI = true;
    h.customInputQueue.push("escape");
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("result 98cc", h.ctx);

    const first = h.customRenderFrames[0]?.join("\n") ?? "";
    expect(first).toContain("workflow result · run 20260726-212752-98cc");
    expect(first).toContain("# Code Review");
    const component = h.customComponents[0]!;
    component.handleInput?.("end");
    expect(component.render(80).join("\n")).toContain("Last line of the review");
  });

  it("defaults to the newest run and says so when there is nothing to read", async () => {
    const root = makeRoot();
    const empty = createHarness(root);
    empty.ctx.hasUI = true;
    workflows(empty.pi);
    await empty.commands.get("workflows")!.handler("result", empty.ctx);
    expect(empty.widgets.get("workflows") ?? "").toContain("No workflow run with persisted evidence was found");

    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    const h = createHarness(root);
    h.ctx.hasUI = true;
    h.customInputQueue.push("escape");
    workflows(h.pi);
    await h.commands.get("workflows")!.handler("result", h.ctx);
    expect(h.customRenderFrames[0]?.join("\n") ?? "").toContain("run 20260726-212752-98cc");
  });

  it("lets /workflows status take the same short id, and names the runs when it matches several", async () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    const single = createHarness(root, { mode: "rpc" });
    workflows(single.pi);
    await single.commands.get("workflows")!.handler("status 98cc", single.ctx);
    expect(single.widgets.get("workflows") ?? "").toContain("20260726-212752-98cc");

    writeFinishedRun(root, "20260725-101010-98cc", "older run");
    const ambiguous = createHarness(root, { mode: "rpc" });
    workflows(ambiguous.pi);
    await ambiguous.commands.get("workflows")!.handler("status 98cc", ambiguous.ctx);
    const widget = ambiguous.widgets.get("workflows") ?? "";
    // Two runs were found: saying "not found" would be the opposite of the truth.
    expect(widget).toContain("matches 2 runs");
    expect(widget).not.toContain("not found");
  });

  it("gives a host without custom UI the text preview plus the exact file path", async () => {
    const root = makeRoot();
    const runDir = writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    const rpc = createHarness(root, { mode: "rpc" });
    workflows(rpc.pi);

    await rpc.commands.get("workflows")!.handler("result 98cc", rpc.ctx);

    const widget = rpc.widgets.get("workflows") ?? "";
    expect(widget).toContain("# Code Review");
    // The bounded widget may wrap a long path across lines; the path itself must
    // survive intact once the wrapping is undone, and the line count must be the
    // whole result rather than whatever fitted.
    const unwrapped = widget.replace(/\n/gu, "");
    expect(unwrapped).toContain(workflowResultTextFile(runDir));
    expect(unwrapped).toContain(`full text: ${REVIEW_TEXT.split("\n").length} line(s)`);
  });
});

const first = "20261120-000001-aaaa";
const second = "20261120-000002-aaaa";
it("shows the selected recorded reason and acknowledges only that full ID", async () => {
  const root = makeRoot();
  const h = createHarness(root, { mode: "tui" });
  h.ctx.hasUI = true;
  const notices = new WorkflowFailureNotices();
  for (const id of [first, second]) {
    writeFileSync(
      workflowResultFile(ensureWorkflowRunDir(root, id)),
      JSON.stringify({ runId: id, ok: false, error: `line one\nreason for ${id}` }),
    );
    notices.publish(h.ctx, id, "earlier live summary");
  }
  expect(h.widgets.get("workflows-failure-notice")).toContain("(+1)");
  expect(h.widgets.get("workflows-failure-notice")).toContain(first);
  h.customInputQueue.push("e");
  await openWorkflowRunViewer(h.ctx, root, second, notices);
  expect(h.customRenderFrames.flat().join("\n")).toContain(`reason for ${second}`);
  expect(h.ctx.ui.getEditorText?.()).toContain(second);
  expect(h.sentUserMessages).toHaveLength(0);
  expect(notices.reason(second)).toBeUndefined();
  expect(notices.reason(first)).toBe("earlier live summary");
  notices.reset();
  expect(notices.reason(first)).toBeUndefined();
});

it("keeps a draft and identifies a session-only failure when no valid result can be read", async () => {
  const root = makeRoot();
  const h = createHarness(root, { mode: "tui" });
  h.ctx.hasUI = true;
  const notices = new WorkflowFailureNotices();
  writeFileSync(
    workflowResultFile(ensureWorkflowRunDir(root, first)),
    JSON.stringify({ runId: second, ok: false, error: "wrong run" }),
  );
  notices.publish(h.ctx, first, "observed here");
  h.ctx.ui.setEditorText?.("draft to keep");
  h.customInputQueue.push("e", "\x1b", "\x1b", "\x1b");
  await openWorkflowRunViewer(h.ctx, root, first, notices);
  const screen = h.customRenderFrames.flat().join("\n");
  expect(screen).toContain("Saved result unavailable");
  expect(screen).toContain("observed here");
  expect(screen).not.toContain("wrong run");
  expect(notices.reason(first)).toBe("observed here");
  h.customInputQueue.push("d", "\x1b", "\x1b");
  await openWorkflowRunViewer(h.ctx, root, first, notices);
  expect(notices.reason(first)).toBeUndefined();
  expect(h.ctx.ui.getEditorText?.()).toBe("draft to keep");
  expect(h.sentUserMessages).toHaveLength(0);
});

it("labels a structured failure as the recorded result, without inventing a technical cause", async () => {
  const root = makeRoot();
  const h = createHarness(root, { mode: "tui" });
  h.ctx.hasUI = true;
  writeFileSync(
    workflowResultFile(ensureWorkflowRunDir(root, first)),
    JSON.stringify({ runId: first, ok: false, result: { ok: false, summary: "Missing input" } }),
  );
  h.customInputQueue.push("\x1b", "\x1b", "\x1b");
  await openWorkflowRunViewer(h.ctx, root, first);
  expect(h.customRenderFrames[0]?.join("\n")).toContain("failed · recorded result");
  expect(h.customRenderFrames[0]?.join("\n")).toContain("Missing input");
});

it.each([false, true])(
  "shows missing or unreadable results when re-opening a failed run in a new session (file exists: %s)",
  async (unreadable) => {
    const root = makeRoot(),
      h = createHarness(root, { mode: "tui" });
    h.ctx.hasUI = true;
    const dir = ensureWorkflowRunDir(root, first);
    writeFileSync(
      workflowJournalFile(dir),
      JSON.stringify({
        kind: "error",
        source: "runtime",
        runId: first,
        ts: "2026-11-20T00:00:01Z",
        message: "prior failure",
      }) + "\n",
    );
    if (unreadable) writeFileSync(workflowResultFile(dir), "{");
    h.customInputQueue.push("\x1b", "\x1b");
    await openWorkflowRunViewer(h.ctx, root, first);
    expect(h.customRenderFrames[0]?.join("\n")).toContain("Saved result unavailable");
  },
);

it("keeps unbound historical evidence readable without acknowledging a live failure", async () => {
  const root = makeRoot(),
    h = createHarness(root, { mode: "tui" });
  h.ctx.hasUI = true;
  writeFileSync(
    workflowResultFile(ensureWorkflowRunDir(root, first)),
    JSON.stringify({ ok: false, error: "historical reason" }),
  );
  const notices = new WorkflowFailureNotices();
  notices.publish(h.ctx, first, "live failure");
  h.customInputQueue.push("\x1b", "\x1b", "\x1b");
  await openWorkflowRunViewer(h.ctx, root, first, notices);
  const screen = h.customRenderFrames[0]?.join("\n");
  expect(screen).toContain("Legacy result (run ID not recorded)");
  expect(screen).toContain("historical reason");
  expect(screen).toContain("live failure");
  expect(notices.reason(first)).toBe("live failure");
  h.customInputQueue.push("e");
  await openWorkflowRunViewer(h.ctx, root, first, notices);
  expect(notices.reason(first)).toBe("live failure");
  notices.reset();
});
