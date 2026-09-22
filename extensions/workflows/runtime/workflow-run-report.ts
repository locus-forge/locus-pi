/**
 * workflow-run-report.ts — the human-readable outputs of one workflow execution.
 * Root outputs live under `.locus-pi/runs/<storageRootRunId>/outputs/`; saved
 * children and resume attempts use the fixed nested execution directories.
 *
 * Everything here is deliberate: the workflow publishes supporting documents
 * and at most one primary document, while the mandatory result owner persists
 * exact terminal prose. Automatic child answers remain runtime evidence. Files
 * an agent writes itself stay in the separate project-local workflow workspace.
 *
 * Documents are projected as an update cycle, not an accumulation: an artifact
 * NAME is one document, and a name that was written several times (a plan
 * redrafted each round, a task ledger republished per step) becomes ONE file
 * holding the newest revision, with the README listing every revision and
 * linking each one's verbatim bytes in the machine store. A reader who opens
 * `plan.md` gets the plan as it stood when the run ended; a reader who wants
 * round 2 follows the revision link. The superseded projection — one
 * `NN-author-name` copy per write — duplicated every revision into the folder
 * and made the current document a filename guess.
 *
 * The runtime directory (`../runtime/`) stays machine-owned: journal.ndjson, the
 * replay record, the result envelope, the script snapshot, and the hash-verified
 * artifact store that replay and continuations depend on. Nothing in the runtime
 * reads the outputs projection back; deleting runtime loses required evidence.
 *
 * Best-effort by contract: a failed secondary projection costs the readable
 * folder, never the run or its durable evidence.
 */

import path from "node:path";
import type { WorkflowArtifactRecord, WorkflowArtifactRef } from "./workflow-artifacts.js";
import {
  assertWorkflowRunDir,
  ensureWorkflowDirectoryNoSymlink,
  readWorkflowRunTextFile,
  replaceWorkflowRunFileAtomically,
  workflowRunFileExists,
  workflowRunDir,
  writeWorkflowRunFile,
  resolveWorkflowRunDir,
  workflowRunOutputsDir,
} from "./workflow-run-layout.js";
import { WORKFLOW_BUDGET_UNBOUNDED, type WorkflowBudget } from "./workflow-budget.js";
import type { WorkflowJournalLine } from "./workflow-runtime.js";
import { assertWorkflowRootLease, writeWorkflowWorkspaceRunLink, type WorkflowRootLease } from "./workflow-output.js";

/** Stable navigation only: terminal status remains in each run's authoritative receipt. */
export function writeWorkflowRunGroupReport(
  input: {
    projectRoot: string;
    runId: string;
    storageRootRunId: string;
    workspaceDir: string;
    workflow: string;
  },
  lease: WorkflowRootLease,
): void {
  assertWorkflowRootLease(lease);
  if (lease.record.rootRunId !== input.runId)
    throw new Error("Only the root lease owner may write workflow group navigation.");
  const groupDir = workflowRunDir(input.projectRoot, input.storageRootRunId);
  const readme = path.join(groupDir, "README.md");
  const marker = "<!-- locus-pi:workflow-run-group:v1 -->";
  const workspaceHref = path.relative(groupDir, input.workspaceDir).split(path.sep).map(encodeURIComponent).join("/");
  const body = [
    marker,
    "# Workflow run group",
    "",
    `Workflow: ${JSON.stringify(input.workflow)}`,
    `Group: ${input.storageRootRunId}`,
    "",
    `- [Workspace working files](${workspaceHref}/).`,
    "- [First run journal](runtime/journal.ndjson).",
    "",
    "The terminal runtime/result.json and optional outputs/, children/, and attempts/ directories appear only when the runtime writes that evidence.",
    "Each execution has its own runId and runtime/. After completion, runtime/result.json holds the terminal status; journal.ndjson also shows unfinished execution.",
    "This page contains stable links, not a latest-status summary. Keep runtime/: history and resume depend on it.",
    "",
  ].join("\n");
  if (workflowRunFileExists(groupDir, readme)) {
    const existing = readWorkflowRunTextFile(groupDir, readme);
    if (!existing.startsWith(marker + "\n")) {
      throw new Error(`Reserved workflow group file already exists: ${readme}`);
    }
    if (existing !== body) {
      assertWorkflowRootLease(lease);
      replaceWorkflowRunFileAtomically(groupDir, readme, body, {
        beforeRename: () => assertWorkflowRootLease(lease),
      });
    }
  } else {
    assertWorkflowRootLease(lease);
    replaceWorkflowRunFileAtomically(groupDir, readme, body, {
      beforeRename: () => assertWorkflowRootLease(lease),
    });
  }
  writeWorkflowWorkspaceRunLink(lease, groupDir, input.storageRootRunId);
}

/** Extensions worth preserving verbatim; anything else becomes readable Markdown. */
const WORKFLOW_REPORT_EXTENSION_REGEX = /\.[A-Za-z0-9]{1,8}$/u;

export function workflowReportDir(projectRoot: string, runId: string): string {
  return workflowRunOutputsDir(resolveWorkflowRunDir(projectRoot, runId));
}

export interface WorkflowRunReportInput {
  projectRoot: string;
  runId: string;
  /** Execution directory claimed before this projection writer is constructed. */
  runDir: string;
  /** Project-local directory where agents write workflow-owned files. */
  workspaceDir?: string;
  /** Terminal disposition status: completed / awaiting_operator / cancelled / failed. */
  status: string;
  target?: { kind: string; ref: string; source: string };
  result?: unknown;
  error?: string;
  journal: readonly WorkflowJournalLine[];
  /** What this run was allowed to spend, and the one spend figure the journal
   *  cannot produce. Absent only for callers that predate the budget contract. */
  budget?: WorkflowRunReportBudget;
}

export interface WorkflowRunReportBudget {
  applied: WorkflowBudget;
  /**
   * Gate-owned high-water mark of simultaneously executing leaf agents. It cannot
   * be recomputed from the journal: `agent_start` is written before the
   * concurrency gate is acquired, so overlapping start/end intervals count queued
   * children too. That is demand, and printing it against a concurrency limit
   * would show a breach that never happened.
   */
  peakConcurrency: number;
}

/** The slice of the artifact store the report needs; the store itself satisfies it. */
export interface WorkflowRunReportEvidenceSource {
  list(): WorkflowArtifactRecord[];
  read(ref: WorkflowArtifactRef): Buffer;
}

export type WorkflowRunReportOutcome =
  { ok: true; path: string; documents: number; primaryOutputPath?: string } | { ok: false; message: string };

/** One write of a document: who produced these bytes and where they live verbatim. */
interface WorkflowReportRevision {
  author: string;
  kind: string;
  stage?: string;
  /** Repo-relative-from-report link target of the verbatim machine bytes. */
  machineHref: string;
}

/** One document — one artifact name — with its whole revision chain in creation order. */
interface WorkflowReportDocument {
  fileName: string;
  name: string;
  revisions: WorkflowReportRevision[];
  /** The workflow explicitly declared this document as its semantic result. */
  isPrimary: boolean;
  unavailable?: string;
}

/** One child transcript, named by the stage that produced it. */
interface WorkflowReportTranscript {
  author: string;
  stage?: string;
  machineHref: string;
}

/** Write the whole `outputs/` projection for one finished run. Never throws. */
export function writeWorkflowRunReport(
  input: WorkflowRunReportInput,
  evidence: WorkflowRunReportEvidenceSource,
): WorkflowRunReportOutcome {
  try {
    const runDir = assertWorkflowRunDir(input.projectRoot, input.runId, input.runDir);
    const reportDir = workflowRunOutputsDir(runDir);
    ensureWorkflowDirectoryNoSymlink(runDir, reportDir);

    let records: WorkflowArtifactRecord[] = [];
    let indexUnavailable: string | undefined;
    try {
      records = evidence.list();
    } catch (error) {
      indexUnavailable = errorMessage(error);
    }

    const authors = authorsByCallId(input.journal);
    const machineArtifactsHref = "../runtime/artifacts";
    const readable = records.filter((record) => record.kind === "published" || record.kind === "primary");
    const primaryRecord = readable.find((record) => record.kind === "primary");
    // The operator task, whichever way this run received it. A fresh run publishes
    // it; a CONTINUATION receives the same bytes as a transferred input, and
    // matching only `published` left that run with no `task.md` at all and a
    // document called `task-2.md` — the name it took after the runner-owned
    // `task.md` slot stayed empty. Published wins when a run has both.
    const taskRecord = readable.find((record) => isTaskName(record.name));

    let taskWritten = false;
    if (taskRecord !== undefined) {
      const bytes = tryRead(evidence, taskRecord);
      if (bytes !== undefined) {
        writeWorkflowRunFile(runDir, path.join(reportDir, "task.md"), bytes);
        taskWritten = true;
      }
    }
    // Once `task.md` is written, every record carrying that name is the same
    // document and belongs to it. A continuation holds at least two — the
    // transferred input it consumed and the copy it republished — and keeping
    // the others in the document chain produced a byte-identical `task-2.md`
    // leading the list under a name that says nothing. A task that could NOT be
    // written stays in the chain instead, so its bytes are still reachable.
    const chain = readable.filter((record) => (taskWritten ? !isTaskName(record.name) : record !== taskRecord));

    const revisionOf = (record: WorkflowArtifactRecord): WorkflowReportRevision => {
      return {
        author: "workflow",
        kind: record.kind,
        ...(record.stage !== undefined ? { stage: record.stage } : {}),
        machineHref: `${machineArtifactsHref}/${hrefPath(record.relativePath)}`,
      };
    };

    // One document per artifact NAME, in first-write order; the newest revision's
    // bytes become the document file. `README.md`, `task.md` and `workflow-result.md` are
    // runner-owned names, so a document is never allowed to claim them.
    const byName = new Map<string, WorkflowArtifactRecord[]>();
    for (const record of chain) {
      const revisions = byName.get(record.name) ?? [];
      revisions.push(record);
      byName.set(record.name, revisions);
    }
    const hasResultText = typeof input.result === "string" && input.result.trim() !== "";
    // Reserve only the names this report actually writes. A workflow-published
    // `result.md` remains a valid semantic document because the runtime-owned
    // terminal copy has the distinct name `workflow-result.md`.
    const claimedFileNames = new Set([
      "readme.md",
      ...(taskWritten ? ["task.md"] : []),
      ...(hasResultText ? ["workflow-result.md"] : []),
    ]);
    const documents: WorkflowReportDocument[] = [];
    for (const [name, revisionRecords] of byName) {
      const newest = revisionRecords[revisionRecords.length - 1]!;
      const bytes = tryRead(evidence, newest);
      // A JSON document is machine truth; the reader gets a Markdown rendering
      // of it, and the verbatim bytes stay in the artifact store.
      const rendered = bytes !== undefined && newest.name.endsWith(".json") ? renderedJsonMarkdown(bytes) : undefined;
      const fileName = claimDocumentFileName(name, rendered !== undefined, claimedFileNames);
      const document: WorkflowReportDocument = {
        fileName,
        name,
        revisions: revisionRecords.map(revisionOf),
        isPrimary:
          primaryRecord !== undefined &&
          revisionRecords.some((record) => record.artifactId === primaryRecord.artifactId),
      };
      if (bytes === undefined) {
        document.unavailable = "the stored artifact could not be read back";
      } else {
        writeWorkflowRunFile(runDir, path.join(reportDir, fileName), rendered ?? bytes);
      }
      documents.push(document);
    }

    const transcripts: WorkflowReportTranscript[] = records
      .filter((record) => record.kind === "transcript")
      .map((record) => {
        const author = record.callId !== undefined ? authors.get(record.callId) : undefined;
        return {
          author: author ?? "agent",
          ...(record.stage !== undefined ? { stage: record.stage } : {}),
          machineHref: `${machineArtifactsHref}/${hrefPath(record.relativePath)}`,
        };
      });

    writeWorkflowRunFile(
      runDir,
      path.join(reportDir, "README.md"),
      reportReadme({
        input,
        documents,
        transcripts,
        taskWritten,
        hasResultText,
        hasStructuredResult: !hasResultText && input.result !== undefined,
        ...(indexUnavailable !== undefined ? { indexUnavailable } : {}),
      }),
    );

    const primary = documents.find((document) => document.isPrimary);
    const primaryOutputPath =
      primary !== undefined
        ? path.join(reportDir, primary.fileName)
        : taskRecord?.kind === "primary" && taskWritten
          ? path.join(reportDir, "task.md")
          : undefined;
    return {
      ok: true,
      path: reportDir,
      documents: documents.length,
      ...(primaryOutputPath === undefined ? {} : { primaryOutputPath }),
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The document keeps the artifact's own name: `plan.md` is `plan.md`, with the
 * extension preserved and `.md` appended only when the name carries none. A
 * document rendered from JSON becomes Markdown and takes `.md` in place of
 * `.json`. Names are claimed case-insensitively against the runner-owned files
 * and against each other — two artifact names that sanitize to one filename are
 * two documents, so the later one takes a `-2` suffix rather than silently
 * overwriting the first.
 */
function claimDocumentFileName(artifactName: string, asMarkdown: boolean, claimed: Set<string>): string {
  const extension = WORKFLOW_REPORT_EXTENSION_REGEX.exec(artifactName)?.[0] ?? "";
  const base = safeFileComponent(extension === "" ? artifactName : artifactName.slice(0, -extension.length));
  const finalExtension = asMarkdown || extension === "" ? ".md" : extension.toLowerCase();
  let candidate = `${base}${finalExtension}`;
  for (let suffix = 2; claimed.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${base}-${suffix}${finalExtension}`;
  }
  claimed.add(candidate.toLowerCase());
  return candidate;
}

/** Markdown link path for a machine-store relative path, in URL separators. */
function hrefPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * Markdown rendering of one JSON document, or undefined when the bytes are not
 * JSON (then the verbatim file keeps its own extension). A flat object — every
 * top-level value a scalar or a list of scalars — becomes a readable key list
 * ("verdict: accept", numbered defects); anything nested stays pretty-printed
 * JSON inside a fence, because inventing prose for an unknown shape would be a
 * guess, not a rendering.
 */
function renderedJsonMarkdown(bytes: Buffer): Buffer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const structured = flatObjectMarkdown(value);
  const body = structured ?? `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  return Buffer.from(`${body}\n`, "utf8");
}

function flatObjectMarkdown(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const lines: string[] = [];
  for (const [key, field] of Object.entries(value)) {
    if (isRenderableScalar(field)) {
      lines.push(`- **${key}**: ${scalarText(field)}`);
      continue;
    }
    if (Array.isArray(field) && field.every(isRenderableScalar)) {
      if (field.length === 0) {
        lines.push(`- **${key}**: (none)`);
      } else {
        lines.push(`- **${key}**:`);
        for (const [index, item] of field.entries()) lines.push(`  ${index + 1}. ${scalarText(item)}`);
      }
      continue;
    }
    return undefined;
  }
  return lines.join("\n");
}

function isRenderableScalar(value: unknown): value is string | number | boolean | null {
  if (typeof value === "string") return !value.includes("\n");
  return typeof value === "number" || typeof value === "boolean" || value === null;
}

function scalarText(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

function authorsByCallId(journal: readonly WorkflowJournalLine[]): Map<string, string> {
  const authors = new Map<string, string>();
  for (const line of journal) {
    if (line.kind !== "agent_start" && line.kind !== "agent_end") continue;
    if (line.callId === undefined) continue;
    const author = line.label ?? line.agent;
    if (author !== undefined && author.trim() !== "") authors.set(line.callId, author);
  }
  return authors;
}

/**
 * Per-call model facts, from `agent_end` only.
 *
 * `agent_start` carries a REQUEST, so reading it here would let the report name a
 * model that never ran — the exact confusion the run README exists to remove.
 */
function isTaskName(name: string): boolean {
  return name === "task.md" || name === "task";
}

function safeFileComponent(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^[-.]+|[-.]+$/gu, "") || "document"
  );
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

function reportReadme(options: {
  input: WorkflowRunReportInput;
  documents: readonly WorkflowReportDocument[];
  transcripts: readonly WorkflowReportTranscript[];
  taskWritten: boolean;
  hasResultText: boolean;
  hasStructuredResult: boolean;
  indexUnavailable?: string;
}): string {
  const { input, documents } = options;
  const lines: string[] = [];
  const title = input.target !== undefined ? `\`${input.target.ref}\`` : "workflow";
  lines.push(`# Workflow run ${input.runId} — ${stripBackticks(title)}`, "");
  if (input.target !== undefined) {
    lines.push(`- Workflow: \`${input.target.ref}\` (${input.target.source})`);
  }
  lines.push(`- Status: ${input.status}`);
  const finishedAt = lastJournalTimestamp(input.journal);
  if (finishedAt !== undefined) lines.push(`- Last event: ${finishedAt}`);
  if (options.taskWritten) lines.push(`- Task: [task.md](task.md)`);
  if (options.hasResultText) {
    lines.push(`- Result: [workflow-result.md](workflow-result.md)`);
  } else if (options.hasStructuredResult) {
    lines.push(`- Result: structured — see \`result.json\` in the machine records`);
  }
  if (input.error !== undefined && input.error.trim() !== "") {
    lines.push(`- Error: ${singleLine(input.error)}`);
  }
  lines.push(
    ...(input.workspaceDir === undefined
      ? []
      : [`- Workflow workspace: \`${input.workspaceDir}\` — agent-owned files under their exact names`]),
    "- Machine records: `../runtime/` — journal.ndjson, replay record, result envelope, script snapshot, " +
      "transcripts and call envelopes",
  );
  lines.push(...failureSection(input));
  lines.push(...budgetSection(input));
  lines.push(...fusionCapabilitySection(input.journal));
  const retryLines = retriedCallLines(input.journal);
  lines.push("", "## Documents", "");
  if (documents.length === 0) {
    lines.push(
      options.indexUnavailable !== undefined
        ? `- none — the artifact index was unavailable: ${singleLine(options.indexUnavailable)}`
        : "- none",
    );
  } else {
    lines.push(
      "One file per document, holding its newest revision. A document written " +
        "more than once lists every revision below it, each linking the verbatim " +
        "machine bytes.",
      "",
    );
    // Which of these is the answer, and which are the work that produced it. A
    // run that ended without one says so instead of leaving its last draft to be
    // read as a result.
    lines.push(
      documents.some((document) => document.isPrimary)
        ? "The document marked **primary output** is the workflow-declared result; the rest are supporting documents."
        : `This run returned no document as its result (status \`${input.status}\`), so every document below is working material.`,
      "",
    );
    for (const [position, document] of documents.entries()) {
      lines.push(`${position + 1}. ${documentEntry(document)}`);
      if (document.revisions.length > 1) {
        for (const [index, revision] of document.revisions.entries()) {
          lines.push(`   ${index + 1}. ${revisionEntry(revision)}`);
        }
      }
    }
  }
  lines.push(...logsSection(options.transcripts));
  lines.push(...retryLines);
  lines.push("");
  return lines.join("\n");
}

function fusionCapabilitySection(journal: readonly WorkflowJournalLine[]): string[] {
  const calls = journal.filter(
    (
      line,
    ): line is WorkflowJournalLine & {
      kind: "agent_end" | "error";
      capabilityMode: "tool-free" | "agent";
      callId: string;
    } =>
      (line.kind === "agent_end" || line.kind === "error") &&
      line.capabilityMode !== undefined &&
      line.callId !== undefined,
  );
  if (calls.length === 0) return [];
  return [
    "",
    "## Fusion capability evidence",
    "",
    "Declared mode and host active-tool readback are separate facts. Replayed calls start no child and therefore carry no live readback.",
    "",
    "| Call | Leg | Declared mode | Host active tools | Execution |",
    "| --- | --- | --- | --- | --- |",
    ...calls.map((line) => {
      const tools =
        line.activeToolNames === undefined
          ? "not recorded"
          : line.activeToolNames.length === 0
            ? "none (`[]`)"
            : line.activeToolNames.map((name) => markdownTableCell(name, true)).join(", ");
      const execution =
        line.replayed === true ? "replayed; no child ran" : line.replayed === false ? "fresh" : "not recorded";
      return `| ${markdownTableCell(line.callId, true)} | ${markdownTableCell(line.label ?? line.agent ?? "agent")} | ${markdownTableCell(line.capabilityMode, true)} | ${tools} | ${execution} |`;
    }),
  ];
}

function markdownTableCell(value: string, code = false): string {
  const escaped = singleLine(value)
    .replace(/&/gu, "&amp;")
    .replace(/\|/gu, "&#124;")
    .replace(/`/gu, "&#96;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
  return code ? `<code>${escaped}</code>` : escaped;
}

/**
 * Why a run that did not complete did not complete, at full length.
 *
 * Every live surface bounds this text — the chat digest at 160 characters
 * because it enters model context, the panel at the terminal width — so an
 * operator whose run stopped saw a sentence fragment ending in `...` and had
 * nowhere to read the rest. A structured result made it worse: the README said
 * "see result.json" and the defects that explain the stop lived only there, in
 * a machine file. This section renders that structured result as Markdown —
 * the same flat-object rendering the JSON documents get — so the reason is in
 * the reader's own folder, unabridged.
 */
function failureSection(input: WorkflowRunReportInput): string[] {
  if (input.status === "completed") return [];
  const technical = input.error !== undefined && input.error.trim() !== "" ? singleLine(input.error) : undefined;
  // A prose result is already written verbatim to workflow-result.md and linked above;
  // repeating it here would duplicate a document rather than explain a stop.
  const structured =
    typeof input.result === "string" || input.result === undefined ? undefined : flatObjectMarkdown(input.result);
  if (technical === undefined && structured === undefined) return [];
  return [
    "",
    `## Why this run ended \`${input.status}\``,
    "",
    ...(technical === undefined ? [] : [technical, ""]),
    ...(structured === undefined ? [] : [structured, ""]),
    "The live surfaces clip this text; these are the full values the run returned.",
  ];
}

/**
 * Where the raw runtime evidence lives, by stage name. The journal is one file whose every
 * line names its agent, stage and round; each child's full transcript is its
 * own ndjson. Links, not copies: the report stays a projection, and the
 * machine store keeps the single source of truth.
 */
function logsSection(transcripts: readonly WorkflowReportTranscript[]): string[] {
  const lines: string[] = ["", "## Logs", ""];
  lines.push(
    "- [journal.ndjson](../runtime/journal.ndjson) — every run event " +
      "on one line each, tagged with its agent, stage and round",
  );
  for (const transcript of transcripts) {
    const stage = transcript.stage === undefined ? "" : ` · ${transcript.stage}`;
    lines.push(`- ${transcript.author}${stage} — [transcript](${transcript.machineHref})`);
  }
  return lines;
}

/**
 * One logical `agent()` call that had to run more than one child.
 *
 * A discarded attempt is a real agent call: it burned an invocation of the run cap and left
 * its own transcript. Without this section the journal shows the stage as one clean
 * answer and the second bill appears nowhere they would look.
 */
interface WorkflowReportRetriedCall {
  author: string;
  stage?: string;
  attempts: Array<{ callId: string; attempt: number; declared: number; status: string; failureCause?: string }>;
}

/**
 * Group the lines that carry an attempt ordinal into their logical calls.
 *
 * A physical attempt has exactly ONE terminal journal record: `agent_end` when the child
 * returned a result, and `error` when it threw — the runtime emits the error line instead
 * of, never alongside, the end line. Reading only `agent_end` would therefore hide the
 * sequence that matters most: a call that timed out, was re-run, and then threw leaves one
 * `agent_end` behind and would render as a stage that never retried at all.
 *
 * Grouped by the runtime's own `logicalCallId`, which every physical attempt of one
 * `agent()` call carries. Neither adjacency nor (agent, label, phase, group) can do this
 * job: `parallel()` may interleave two retrying calls that agree on all four of those
 * fields, and grouping by them would attribute one call's discarded attempt to the other —
 * worse than no section at all, because this one reads as evidence.
 */
function retriedCalls(journal: readonly WorkflowJournalLine[]): WorkflowReportRetriedCall[] {
  const open = new Map<string, WorkflowReportRetriedCall>();
  const ordered: WorkflowReportRetriedCall[] = [];
  for (const line of journal) {
    if (line.kind !== "agent_end" && line.kind !== "error") continue;
    if (line.attempt === undefined || line.attempts === undefined || line.callId === undefined) continue;
    // The journal reader refuses an ordinal without one, so absence here is a line this
    // reader cannot honestly place — skipped rather than guessed into somebody's group.
    if (line.logicalCallId === undefined) continue;
    let group = open.get(line.logicalCallId);
    if (group === undefined) {
      group = {
        author: line.label ?? line.agent ?? "agent",
        ...(line.phase !== undefined ? { stage: line.phase } : {}),
        attempts: [],
      };
      open.set(line.logicalCallId, group);
      ordered.push(group);
    }
    group.attempts.push({
      callId: line.callId,
      attempt: line.attempt,
      declared: line.attempts,
      // An `error` line carries no status field: the attempt ended by throwing, which is a
      // different fact from a failed result and is named as itself rather than flattened.
      status: line.kind === "error" ? "threw" : (line.status ?? "unknown"),
      ...(line.failureCause !== undefined ? { failureCause: line.failureCause } : {}),
    });
  }
  // A call that declared a budget and never needed it is not a retried call.
  return ordered.filter((group) => group.attempts.length > 1);
}

function retriedCallLines(journal: readonly WorkflowJournalLine[]): string[] {
  const calls = retriedCalls(journal);
  if (calls.length === 0) return [];
  const lines: string[] = ["", "## Retried agent calls", ""];
  lines.push(
    "Each line below is a separate child run charged to this run's budget, with its own " +
      "transcript in the machine records.",
    "",
  );
  for (const call of calls) {
    lines.push(`- ${call.author}${call.stage === undefined ? "" : ` · ${call.stage}`}`);
    for (const attempt of call.attempts) {
      const cause = attempt.failureCause === undefined ? "" : ` (${attempt.failureCause})`;
      lines.push(
        `  - attempt ${attempt.attempt} of ${attempt.declared} — \`${attempt.callId}\` — ${attempt.status}${cause}`,
      );
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Budget versus spend
// ---------------------------------------------------------------------------

/** What the report prints when the evidence for an axis does not exist. Never `0`:
 *  a zero would read as a measured spend of nothing, which is a different claim. */
const NOT_RECORDED = "not recorded";

/**
 * Every axis with the value that applied, beside the spend this run's evidence can
 * actually measure. Three tiers, and the report says which tier each axis is in:
 * measurable from the journal, measurable only because the concurrency gate counts
 * it, and not measurable at all. The last group prints "not recorded" rather than a
 * number nobody counted — the same honesty rule cost is held to.
 */
function budgetSection(input: WorkflowRunReportInput): string[] {
  if (input.budget === undefined) return [];
  const { applied, peakConcurrency } = input.budget;
  const spend = journalSpend(input.journal);
  const axis = (name: keyof WorkflowBudget, suffix = ""): string => {
    const value = applied[name];
    return value === undefined ? WORKFLOW_BUDGET_UNBOUNDED : `${String(value)}${suffix}`;
  };
  const freshAgents = spend.agents - spend.replayedAgents;
  const rows: Array<[string, string, string]> = [
    ["`concurrency`", axis("concurrency"), `${String(peakConcurrency)} peak (gate-owned)`],
    [
      "`totalAgents`",
      axis("totalAgents"),
      // Three numbers, because they answer three different questions and only one of
      // them is the charge: logical calls are what the script asked for, fresh
      // attempts are what this axis bounds, and replayed ones started no child at all.
      spend.replayedAgents === 0
        ? `${String(freshAgents)} fresh`
        : `${String(freshAgents)} fresh + ${String(spend.replayedAgents)} replayed (not charged)`,
    ],
    ["`runtimeMs`", axis("runtimeMs", " ms"), `${String(spend.runMs)} ms over the journal`],
    [
      "`timeoutMs`",
      axis("timeoutMs", " ms"),
      // Fresh children only. A replayed attempt's durationMs measures projecting a
      // recorded answer, which never ran against this fuse; a run served entirely
      // from records therefore has no longest child at all and says so.
      spend.longestChildMs === undefined ? NOT_RECORDED : `${String(spend.longestChildMs)} ms longest child`,
    ],
    ["`toolCalls`", axis("toolCalls"), NOT_RECORDED],
    ["`turns`", axis("turns"), NOT_RECORDED],
    ["tokens", "not enforced", spend.tokens === undefined ? NOT_RECORDED : `${String(spend.tokens)} observed`],
    ["cost", "not enforced", "not available"],
  ];
  return [
    "",
    "## Budget",
    "",
    "| Axis | Applied | Spend |",
    "| --- | --- | --- |",
    ...rows.map(([axisName, appliedText, spendText]) => `| ${axisName} | ${appliedText} | ${spendText} |`),
    "",
    `An axis that reads \`${WORKFLOW_BUDGET_UNBOUNDED}\` was declared by nobody, so nothing stops this run on it: ` +
      "no timer is armed and no counter refuses a child. There are no package defaults for these axes — a budget " +
      "spends someone's money, so the author or the operator sets it, on the workflow header, the launch, or the " +
      "individual call.",
    "",
    `Spend is read from this run's own journal, so it can only report what the journal carries. \`toolCalls\` ` +
      `and \`turns\` are enforced per child and counted by nobody, so they read "${NOT_RECORDED}" ` +
      `rather than \`0\`. Cost is unavailable because the host reports no price at all, and a limit over an ` +
      "unknown would report “under budget” forever.",
    "",
    "There is no answer-size axis. A completed child's answer is never refused for its length; a consumer that " +
      "needs a bounded value declares it as a contract on the call (`output.maxLength`, or `maxLength`/`maxItems` " +
      "inside a schema), where the child is told and can correct it before it finishes.",
    "",
    "A replayed call starts no child, so it is NOT charged against `totalAgents` and is excluded from the " +
      "longest-child duration and from the observed tokens. A resume of a finished run therefore cannot die on a " +
      `cap the original run satisfied, and a run served entirely from records reports its longest child as ` +
      `"${NOT_RECORDED}", because no child ran.`,
    "",
    "An explicit axis is checked BEFORE the next spend — before the next child starts, before the next turn, " +
      "before the next tool call. Reaching one ends the run as “stopped by budget”, with every answer already " +
      "received kept and readable; it is never a statement that the work was wrong.",
    "",
    "`runtimeMs` bounds the agent chain: it is checked when a child starts, so a run is bounded by it plus at " +
      "most one child's own `timeoutMs`, and script code that calls no further agent is not bounded by it.",
  ];
}

interface WorkflowJournalSpend {
  /** Agent invocations, replayed ones included. Only the fresh ones are charged. */
  agents: number;
  /** How many of those were served from a record, so the count above cannot be
   *  read as "children that ran". */
  replayedAgents: number;
  runMs: number;
  /** Longest FRESH child. Absent when nothing but replays ended. */
  longestChildMs?: number;
  tokens?: number;
}

function journalSpend(journal: readonly WorkflowJournalLine[]): WorkflowJournalSpend {
  let agents = 0;
  let replayedAgents = 0;
  let longestChildMs: number | undefined;
  let tokens: number | undefined;
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  for (const line of journal) {
    if (line.kind === "agent_start") {
      agents += 1;
      // Never inferred from a missing duration or a zero token count — only the
      // explicit marker the runtime writes on both start and end lines counts.
      if (line.replayed === true) replayedAgents += 1;
    }
    // A post-child validator/artifact failure has no agent_end: its `error` line is
    // the sole terminal record and carries executed-model evidence plus usage.
    // Transport throws carry neither and therefore do not masquerade as executed
    // children here.
    const executedTerminal =
      line.kind === "agent_end" ||
      (line.kind === "error" && (line.executedModel !== undefined || line.usage !== undefined));
    if (executedTerminal) {
      // A replayed attempt started no child: its durationMs is how long projecting a
      // recorded answer took, which is not a spend against the per-child wall clock.
      if (
        line.replayed !== true &&
        typeof line.durationMs === "number" &&
        (longestChildMs === undefined || line.durationMs > longestChildMs)
      ) {
        longestChildMs = line.durationMs;
      }
      const total = line.usage?.totalTokens;
      // Absent usage is absent, not zero: the host omits it rather than reporting 0.
      if (typeof total === "number") tokens = (tokens ?? 0) + total;
    }
    const ms = Date.parse(line.ts ?? "");
    if (!Number.isNaN(ms)) {
      if (firstMs === undefined) firstMs = ms;
      lastMs = ms;
    }
  }
  return {
    agents,
    replayedAgents,
    runMs: firstMs === undefined || lastMs === undefined ? 0 : lastMs - firstMs,
    ...(longestChildMs === undefined ? {} : { longestChildMs }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

function revisionDescription(revision: WorkflowReportRevision): string {
  return [revision.author, ...(revision.stage !== undefined ? [revision.stage] : [])].join(" · ");
}

function documentEntry(document: WorkflowReportDocument): string {
  const newest = document.revisions[document.revisions.length - 1];
  const description = newest === undefined ? "" : ` — ${revisionDescription(newest)}`;
  const result = document.isPrimary ? " — **primary output**" : "";
  const revisionCount = document.revisions.length > 1 ? ` — ${document.revisions.length} revisions:` : "";
  return document.unavailable !== undefined
    ? `${document.fileName}${description} — unavailable: ${document.unavailable}`
    : `[${document.fileName}](${document.fileName})${result}${description}${revisionCount}`;
}

function revisionEntry(revision: WorkflowReportRevision): string {
  return `${revisionDescription(revision)} — [machine copy](${revision.machineHref})`;
}

function lastJournalTimestamp(journal: readonly WorkflowJournalLine[]): string | undefined {
  const last = journal.length > 0 ? journal[journal.length - 1] : undefined;
  return typeof last?.ts === "string" && last.ts.trim() !== "" ? last.ts : undefined;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stripBackticks(value: string): string {
  return value.replace(/`/gu, "");
}

function tryRead(evidence: WorkflowRunReportEvidenceSource, record: WorkflowArtifactRecord): Buffer | undefined {
  try {
    return evidence.read({
      runId: record.runId,
      artifactId: record.artifactId,
      name: record.name,
      sha256: record.sha256,
    });
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
