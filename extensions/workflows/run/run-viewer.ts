import { highlightCode } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CustomUiComponent, CustomUiTui } from "../../_shared/host/pi-api.js";
import {
  readWorkflowArtifactIndex,
  readWorkflowArtifactRecord,
  type WorkflowArtifactRecord,
} from "../runtime/workflow-artifacts.js";
import {
  listWorkflowRuns,
  readWorkflowRunJournalState,
  readWorkflowRunResult,
  readWorkflowRunSummary,
  workflowPersistedResultInvalidity,
  type WorkflowJournalDiagnostic,
  type WorkflowRunStatus,
} from "../runtime/workflow-journal.js";
import { resolveWorkflowRunDir } from "../runtime/workflow-run-layout.js";
import type { WorkflowJournalLine } from "../runtime/workflow-runtime.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import { clamp, clipLines, fitLine, viewerRows as sharedViewerRows } from "../../_shared/operator/viewer-geometry.js";

const DEFAULT_TERMINAL_ROWS = 24;
// Keep two rows of breathing room above the one-row Locus footer so focused
// browsers never collide with host redraws on short terminals.
const PI_HOST_FOOTER_ROWS = 3;
const VIEWER_FOOTER_ROWS = 2;
const MAX_EVIDENCE_BYTES = 512 * 1024;

interface RunViewerTheme {
  fg?(color: string, text: string): string;
}

interface RunViewerKeybindings {
  matches(
    data: string,
    keybinding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  ): boolean;
}

interface RunRow {
  runId: string;
  status: WorkflowRunStatus;
  phase: string | null;
  agents: string;
  journalDiagnostics: number;
}

interface RunEvidenceModel {
  runId: string;
  status: WorkflowRunStatus;
  stages: StageRow[];
  runProblem?: string;
  artifactProblem?: string;
  journalProblem?: string;
}

interface StageRow {
  key: string;
  label: string;
  evidence: EvidenceRow[];
}

type EvidenceRow =
  | { kind: "artifact"; record: WorkflowArtifactRecord }
  | { kind: "log"; stage: string; lines: WorkflowJournalLine[] }
  | { kind: "problem"; message: string };

type ViewerScreen =
  | { kind: "runs" }
  | { kind: "stages"; run: RunEvidenceModel }
  | { kind: "evidence"; run: RunEvidenceModel; stage: StageRow }
  | { kind: "content"; run: RunEvidenceModel; stage: StageRow; evidence: EvidenceRow; content: ContentState };

type ContentState =
  | { kind: "ready"; title: string; lines: string[]; mediaType: string }
  | { kind: "error"; title: string; message: string };

/**
 * Read-only persisted workflow evidence browser. It deliberately owns no live
 * agent/session state: every screen is rebuilt from the run journal and the
 * digest-bound artifact index on disk.
 */
export class WorkflowRunViewer implements CustomUiComponent {
  #screen: ViewerScreen = { kind: "runs" };
  #runIndex = 0;
  #stageIndex = 0;
  #evidenceIndex = 0;
  #contentScroll = 0;
  #lastWidth = 80;
  #done: (() => void) | undefined;
  readonly #theme: RunViewerTheme;
  readonly #runs: RunRow[];

  constructor(
    private readonly tui: CustomUiTui,
    theme: unknown,
    private readonly keybindings: unknown,
    private readonly projectRoot: string,
    done: () => void,
    initialRunId?: string,
  ) {
    this.#theme = asTheme(theme);
    this.#done = done;
    this.#runs = listWorkflowRuns(projectRoot).map((run) => runRow(projectRoot, run.runId, run.runDir));
    if (initialRunId !== undefined) {
      const index = this.#runs.findIndex((run) => run.runId === initialRunId);
      if (index >= 0) this.#runIndex = index;
      this.#screen = { kind: "stages", run: loadRunEvidence(projectRoot, initialRunId) };
    }
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    this.#lastWidth = safeWidth;
    switch (this.#screen.kind) {
      case "runs":
        return this.#renderRuns(safeWidth);
      case "stages":
        return this.#renderStages(this.#screen, safeWidth);
      case "evidence":
        return this.#renderEvidence(this.#screen, safeWidth);
      case "content":
        return this.#renderContent(this.#screen, safeWidth);
    }
  }

  handleInput(data: string): void {
    if (this.#screen.kind === "runs") this.#handleRuns(data);
    else if (this.#screen.kind === "stages") this.#handleStages(data);
    else if (this.#screen.kind === "evidence") this.#handleEvidence(data);
    else this.#handleContent(data);
  }

  invalidate(): void {}

  dispose(): void {
    this.#done = undefined;
  }

  get screenKind(): ViewerScreen["kind"] {
    return this.#screen.kind;
  }

  #handleRuns(data: string): void {
    if (isCancel(this.keybindings, data)) {
      this.#finish();
      return;
    }
    if (this.#runs.length === 0) return;
    if (isUp(this.keybindings, data)) this.#runIndex = cycleIndex(this.#runIndex, -1, this.#runs.length);
    else if (isDown(this.keybindings, data)) this.#runIndex = cycleIndex(this.#runIndex, 1, this.#runs.length);
    else if (isConfirm(this.keybindings, data)) {
      const selected = this.#runs[this.#runIndex];
      if (selected === undefined) return;
      this.#stageIndex = 0;
      this.#screen = { kind: "stages", run: loadRunEvidence(this.projectRoot, selected.runId) };
    } else return;
    this.tui.requestRender();
  }

  #handleStages(data: string): void {
    const screen = this.#screen;
    if (screen.kind !== "stages") return;
    if (isCancel(this.keybindings, data)) {
      this.#screen = { kind: "runs" };
      this.tui.requestRender();
      return;
    }
    if (screen.run.stages.length === 0) return;
    if (isUp(this.keybindings, data)) this.#stageIndex = cycleIndex(this.#stageIndex, -1, screen.run.stages.length);
    else if (isDown(this.keybindings, data))
      this.#stageIndex = cycleIndex(this.#stageIndex, 1, screen.run.stages.length);
    else if (isConfirm(this.keybindings, data)) {
      const stage = screen.run.stages[this.#stageIndex];
      if (stage === undefined) return;
      this.#evidenceIndex = 0;
      this.#screen = { kind: "evidence", run: screen.run, stage };
    } else return;
    this.tui.requestRender();
  }

  #handleEvidence(data: string): void {
    const screen = this.#screen;
    if (screen.kind !== "evidence") return;
    if (isCancel(this.keybindings, data)) {
      this.#screen = { kind: "stages", run: screen.run };
      this.tui.requestRender();
      return;
    }
    if (screen.stage.evidence.length === 0) return;
    if (isUp(this.keybindings, data)) {
      this.#evidenceIndex = cycleIndex(this.#evidenceIndex, -1, screen.stage.evidence.length);
    } else if (isDown(this.keybindings, data)) {
      this.#evidenceIndex = cycleIndex(this.#evidenceIndex, 1, screen.stage.evidence.length);
    } else if (isConfirm(this.keybindings, data)) {
      const evidence = screen.stage.evidence[this.#evidenceIndex];
      if (evidence === undefined) return;
      this.#contentScroll = 0;
      this.#screen = {
        kind: "content",
        run: screen.run,
        stage: screen.stage,
        evidence,
        content: loadEvidenceContent(this.projectRoot, screen.run.runId, evidence),
      };
    } else return;
    this.tui.requestRender();
  }

  #handleContent(data: string): void {
    const screen = this.#screen;
    if (screen.kind !== "content") return;
    if (isCancel(this.keybindings, data)) {
      this.#screen = { kind: "evidence", run: screen.run, stage: screen.stage };
      this.tui.requestRender();
      return;
    }
    if (screen.content.kind !== "ready") return;
    const page = Math.max(1, contentBodyHeight(this.tui) - 1);
    if (isUp(this.keybindings, data)) this.#contentScroll -= 1;
    else if (isDown(this.keybindings, data)) this.#contentScroll += 1;
    else if (["pageUp", "pageup", "\x1b[5~"].includes(data)) this.#contentScroll -= page;
    else if (["pageDown", "pagedown", "\x1b[6~"].includes(data)) this.#contentScroll += page;
    else if (["home", "\x1b[H", "\x1b[1~"].includes(data)) this.#contentScroll = 0;
    else if (["end", "\x1b[F", "\x1b[4~"].includes(data)) this.#contentScroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#contentScroll = Math.max(0, this.#contentScroll);
    this.tui.requestRender();
  }

  #renderRuns(width: number): string[] {
    const height = viewerRows(this.tui);
    const header = style(this.#theme, "accent", fitLine("[SELECT] Workflow runs · persisted evidence", width));
    if (height === 1) return [header];
    const footer = listFooter("Enter stages", height);
    const bodyHeight = Math.max(0, height - 1 - footer.length);
    const body =
      this.#runs.length === 0
        ? ["No workflow runs with persisted journal/result evidence."]
        : selectableWindow(
            this.#runs,
            this.#runIndex,
            bodyHeight,
            width,
            this.#theme,
            (row) =>
              `${row.runId} · ${row.status} · phase=${row.phase ?? "-"} · agents=${row.agents}${row.journalDiagnostics === 0 ? "" : ` · journal=corrupt(${row.journalDiagnostics})`}`,
          );
    return [header, ...clipLines(body, bodyHeight, width), ...footer.map((line) => fitLine(line, width))];
  }

  #renderStages(screen: Extract<ViewerScreen, { kind: "stages" }>, width: number): string[] {
    const height = viewerRows(this.tui);
    const header = style(
      this.#theme,
      screen.run.runProblem === undefined &&
        screen.run.artifactProblem === undefined &&
        screen.run.journalProblem === undefined
        ? "accent"
        : "warning",
      fitLine(`[VIEW] ${screen.run.runId} · ${screen.run.status} · stages`, width),
    );
    if (height === 1) return [header];
    const footer = listFooter("Enter evidence", height);
    const bodyHeight = Math.max(0, height - 1 - footer.length);
    const body =
      screen.run.stages.length === 0
        ? [screen.run.runProblem ?? screen.run.artifactProblem ?? "No persisted stages or evidence."]
        : selectableWindow(
            screen.run.stages,
            this.#stageIndex,
            bodyHeight,
            width,
            this.#theme,
            (stage) => `${stage.label} · ${stage.evidence.length} evidence item(s)`,
          );
    return [header, ...clipLines(body, bodyHeight, width), ...footer.map((line) => fitLine(line, width))];
  }

  #renderEvidence(screen: Extract<ViewerScreen, { kind: "evidence" }>, width: number): string[] {
    const height = viewerRows(this.tui);
    const header = style(
      this.#theme,
      "accent",
      fitLine(`[VIEW] ${screen.run.runId} · stage ${screen.stage.label} · evidence`, width),
    );
    if (height === 1) return [header];
    const footer = listFooter("Enter content", height);
    const bodyHeight = Math.max(0, height - 1 - footer.length);
    const body =
      screen.stage.evidence.length === 0
        ? ["No persisted evidence for this stage."]
        : selectableWindow(screen.stage.evidence, this.#evidenceIndex, bodyHeight, width, this.#theme, evidenceLabel);
    return [header, ...clipLines(body, bodyHeight, width), ...footer.map((line) => fitLine(line, width))];
  }

  #renderContent(screen: Extract<ViewerScreen, { kind: "content" }>, width: number): string[] {
    const height = viewerRows(this.tui);
    const header = style(
      this.#theme,
      screen.content.kind === "ready" ? "accent" : "error",
      fitLine(`[VIEW] ${screen.run.runId} · ${screen.stage.label} · ${screen.content.title}`, width),
    );
    if (height === 1) return [header];
    const footer = listFooter("↑/↓ scroll", height);
    const bodyHeight = Math.max(0, height - 1 - footer.length);
    let body: string[];
    let position = "";
    if (screen.content.kind === "error") {
      body = wrapPlain(screen.content.message, width);
    } else {
      const lines = screen.content.lines.flatMap((line) => wrapTextWithAnsi(line, width));
      const maxScroll = Math.max(0, lines.length - bodyHeight);
      this.#contentScroll = clamp(this.#contentScroll, 0, maxScroll);
      body = lines.slice(this.#contentScroll, this.#contentScroll + bodyHeight);
      if (lines.length > 0) {
        const first = Math.min(lines.length, this.#contentScroll + 1);
        const last = Math.min(lines.length, this.#contentScroll + Math.max(1, body.length));
        position = `${first}-${last}/${lines.length} · ${screen.content.mediaType}`;
      }
    }
    const renderedFooter = footer.map((line, index) =>
      index === 0 && position !== "" ? `${line} · ${position}` : line,
    );
    return [header, ...clipLines(body, bodyHeight, width), ...renderedFooter.map((line) => fitLine(line, width))];
  }

  #finish(): void {
    const done = this.#done;
    this.#done = undefined;
    done?.();
  }
}

/**
 * One screen, one job: the entire terminal text of a finished run, scrollable
 * and never clipped. `/workflows result` opens this instead of asking the
 * operator to walk run → stage → evidence → content for the one artifact they
 * always want, and instead of leaving them with the 160-character digest line.
 */
export class WorkflowResultViewer implements CustomUiComponent {
  #scroll = 0;
  #done: (() => void) | undefined;
  readonly #theme: RunViewerTheme;
  readonly #lines: string[];

  constructor(
    private readonly tui: CustomUiTui,
    theme: unknown,
    private readonly keybindings: unknown,
    private readonly title: string,
    text: string,
    done: () => void,
  ) {
    this.#theme = asTheme(theme);
    this.#done = done;
    this.#lines = highlightCode(text, "markdown");
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    const height = viewerRows(this.tui);
    const header = style(this.#theme, "accent", fitLine(`[VIEW] ${this.title}`, safeWidth));
    if (height === 1) return [header];
    const footer = listFooter("↑/↓ scroll", height);
    const bodyHeight = Math.max(0, height - 1 - footer.length);
    const lines = this.#lines.flatMap((line) => wrapTextWithAnsi(line, safeWidth));
    const maxScroll = Math.max(0, lines.length - bodyHeight);
    this.#scroll = clamp(this.#scroll, 0, maxScroll);
    const body = lines.slice(this.#scroll, this.#scroll + bodyHeight);
    const first = Math.min(lines.length, this.#scroll + 1);
    const last = Math.min(lines.length, this.#scroll + Math.max(1, body.length));
    const position = lines.length === 0 ? "" : `${first}-${last}/${lines.length}`;
    const renderedFooter = footer.map((line, index) =>
      index === 0 && position !== "" ? `${line} · ${position}` : line,
    );
    return [
      header,
      ...clipLines(body, bodyHeight, safeWidth),
      ...renderedFooter.map((line) => fitLine(line, safeWidth)),
    ];
  }

  handleInput(data: string): void {
    if (isCancel(this.keybindings, data)) {
      const done = this.#done;
      this.#done = undefined;
      done?.();
      return;
    }
    const page = Math.max(1, contentBodyHeight(this.tui) - 1);
    if (isUp(this.keybindings, data)) this.#scroll -= 1;
    else if (isDown(this.keybindings, data)) this.#scroll += 1;
    else if (["pageUp", "pageup", "\x1b[5~"].includes(data)) this.#scroll -= page;
    else if (["pageDown", "pagedown", "\x1b[6~"].includes(data)) this.#scroll += page;
    else if (["home", "\x1b[H", "\x1b[1~"].includes(data)) this.#scroll = 0;
    else if (["end", "\x1b[F", "\x1b[4~"].includes(data)) this.#scroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#scroll = Math.max(0, this.#scroll);
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    this.#done = undefined;
  }
}

function runRow(projectRoot: string, runId: string, runDir: string): RunRow {
  const summary = readWorkflowRunSummary(projectRoot, runId, runDir);
  const journal = readWorkflowRunJournalState(projectRoot, runId, runDir);
  return {
    runId,
    status: summary.status,
    phase: summary.phase,
    agents: `${summary.agentsEnded}/${summary.agentsStarted}`,
    journalDiagnostics: journal.diagnostics.length,
  };
}

function loadRunEvidence(projectRoot: string, runId: string): RunEvidenceModel {
  let runDir: string;
  try {
    runDir = resolveWorkflowRunDir(projectRoot, runId);
  } catch (error) {
    return {
      runId,
      status: "unknown",
      artifactProblem: `${errorMessage(error)}.`,
      stages: [
        {
          key: "run",
          label: "run",
          evidence: [{ kind: "problem", message: "Run id refused before filesystem access." }],
        },
      ],
    };
  }
  const { lines: journal, diagnostics: journalDiagnostics } = readWorkflowRunJournalState(projectRoot, runId, runDir);
  const summary = readWorkflowRunSummary(projectRoot, runId, runDir);
  const persistedInvalidity = workflowPersistedResultInvalidity(readWorkflowRunResult(projectRoot, runId, runDir));
  const artifactState = readWorkflowArtifactIndex(projectRoot, runId, runDir);
  const records = artifactState.status === "ready" ? artifactState.index.artifacts : [];
  const stageKeys: string[] = [];
  const addStage = (value: string | undefined): void => {
    const key = stageKey(value);
    if (!stageKeys.includes(key)) stageKeys.push(key);
  };
  for (const line of journal) addStage(line.phase);
  for (const record of records) addStage(record.stage);
  if (stageKeys.length === 0) stageKeys.push("run");

  const artifactProblem = artifactState.status === "ready" ? undefined : artifactState.message;
  const journalProblem = formatJournalProblem(journalDiagnostics);
  const stages = stageKeys.map((key, stageIndex): StageRow => {
    const artifacts = records
      .filter((record) => stageKey(record.stage) === key)
      .sort(compareArtifactRecords)
      .map((record): EvidenceRow => ({ kind: "artifact", record }));
    const logs = journal.filter((line) => stageKey(line.phase) === key);
    const evidence: EvidenceRow[] = [...artifacts];
    if (logs.length > 0) evidence.push({ kind: "log", stage: key, lines: logs });
    if (persistedInvalidity !== undefined && stageIndex === 0) {
      evidence.push({ kind: "problem", message: `Malformed persisted metadata (${persistedInvalidity}).` });
    }
    if (artifactProblem !== undefined && stageIndex === 0) evidence.push({ kind: "problem", message: artifactProblem });
    return { key, label: key, evidence };
  });
  if (journalProblem !== undefined) {
    stages.unshift({
      key: "__journal-corruption__",
      label: `journal corruption (${journalDiagnostics.length})`,
      evidence: [{ kind: "problem", message: journalProblem }],
    });
  }
  return {
    runId,
    status: summary.status,
    stages,
    ...(persistedInvalidity === undefined
      ? {}
      : { runProblem: `Malformed persisted metadata (${persistedInvalidity}).` }),
    ...(artifactProblem !== undefined ? { artifactProblem } : {}),
    ...(journalProblem !== undefined ? { journalProblem } : {}),
  };
}

function compareArtifactRecords(left: WorkflowArtifactRecord, right: WorkflowArtifactRecord): number {
  const leftCall = left.callId ?? "~";
  const rightCall = right.callId ?? "~";
  return (
    leftCall.localeCompare(rightCall) ||
    artifactKindOrder(left.kind) - artifactKindOrder(right.kind) ||
    left.artifactId.localeCompare(right.artifactId)
  );
}

function artifactKindOrder(kind: WorkflowArtifactRecord["kind"]): number {
  switch (kind) {
    case "answer":
      return 0;
    case "transcript":
      return 1;
    case "result":
      return 2;
    case "published":
      return 3;
    case "primary":
      return 4;
    case "input":
      return 5;
    case "operator-ask":
      return 6;
  }
}

function loadEvidenceContent(projectRoot: string, runId: string, evidence: EvidenceRow): ContentState {
  if (evidence.kind === "problem") return { kind: "error", title: "evidence unavailable", message: evidence.message };
  if (evidence.kind === "log") {
    const text = evidence.lines.map(formatJournalEvidenceLine).join("\n");
    return { kind: "ready", title: "log", mediaType: "application/x-ndjson", lines: highlightCode(text, "text") };
  }
  const record = evidence.record;
  if (record.size > MAX_EVIDENCE_BYTES) {
    return {
      kind: "error",
      title: record.name,
      message: `Evidence is ${record.size} bytes; the interactive viewer limit is ${MAX_EVIDENCE_BYTES} bytes. The file was not loaded.`,
    };
  }
  const state = readWorkflowArtifactRecord(projectRoot, runId, record.artifactId);
  if (state.status !== "ready") return { kind: "error", title: record.name, message: state.message };
  if (!sameArtifactRecord(state.record, record)) {
    return {
      kind: "error",
      title: record.name,
      message: "Workflow artifact index changed while this evidence view was open. Reopen the run before reading it.",
    };
  }
  try {
    const text = state.bytes.toString("utf8");
    if (record.mediaType.includes("json")) {
      const structured = formatJsonEvidence(text, record.mediaType.includes("ndjson"));
      return {
        kind: "ready",
        title: record.name,
        mediaType: record.mediaType,
        lines: highlightCode(structured, "json"),
      };
    }
    if (record.mediaType.includes("markdown")) {
      return { kind: "ready", title: record.name, mediaType: record.mediaType, lines: highlightCode(text, "markdown") };
    }
    return { kind: "ready", title: record.name, mediaType: record.mediaType, lines: text.split(/\r?\n/u) };
  } catch (error) {
    return { kind: "error", title: record.name, message: `Evidence could not be rendered: ${errorMessage(error)}.` };
  }
}

function sameArtifactRecord(left: WorkflowArtifactRecord, right: WorkflowArtifactRecord): boolean {
  return (
    left.runId === right.runId &&
    left.artifactId === right.artifactId &&
    left.name === right.name &&
    left.sha256 === right.sha256 &&
    left.kind === right.kind &&
    left.mediaType === right.mediaType &&
    left.size === right.size &&
    left.relativePath === right.relativePath &&
    left.provenance === right.provenance &&
    left.createdAt === right.createdAt &&
    left.callId === right.callId &&
    left.toolCallId === right.toolCallId &&
    left.sequence === right.sequence &&
    left.stage === right.stage &&
    left.childSessionId === right.childSessionId &&
    sameArtifactRef(left.source, right.source) &&
    left.replaySourceRunId === right.replaySourceRunId
  );
}

function sameArtifactRef(left: WorkflowArtifactRecord["source"], right: WorkflowArtifactRecord["source"]): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.runId === right.runId &&
    left.artifactId === right.artifactId &&
    left.name === right.name &&
    left.sha256 === right.sha256
  );
}

function formatJournalProblem(diagnostics: readonly WorkflowJournalDiagnostic[]): string | undefined {
  if (diagnostics.length === 0) return undefined;
  const shown = diagnostics.slice(0, 8).map((diagnostic) => {
    const location = diagnostic.lineNumber === null ? "journal" : `line ${diagnostic.lineNumber}`;
    return `${location}: ${diagnostic.message}`;
  });
  const omitted = diagnostics.length - shown.length;
  return [
    `Journal corruption detected: ${diagnostics.length} malformed or unreadable row(s).`,
    ...shown,
    ...(omitted > 0 ? [`${omitted} additional diagnostic(s) omitted from this bounded view.`] : []),
  ].join("\n");
}

function formatJsonEvidence(text: string, ndjson: boolean): string {
  if (!ndjson) return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  const rows = text.split(/\r?\n/u).filter((row) => row.trim() !== "");
  return rows.map((row) => JSON.stringify(JSON.parse(row) as unknown, null, 2)).join("\n");
}

function formatJournalEvidenceLine(line: WorkflowJournalLine): string {
  const continuation =
    line.continuation === undefined
      ? undefined
      : `continuation=${line.continuation.originRunId} [${line.continuation.artifacts
          .map(({ sourceRef, consumedRef }) => `${sourceRef.name}:${sourceRef.artifactId}->${consumedRef.artifactId}`)
          .join(", ")}]`;
  const suffix = [
    line.callId === undefined ? undefined : `call=${line.callId}`,
    line.agent === undefined ? undefined : `agent=${line.agent}`,
    line.label === undefined ? undefined : `label=${JSON.stringify(line.label)}`,
    line.status === undefined ? undefined : `status=${line.status}`,
    line.message,
    continuation,
  ].filter((value): value is string => value !== undefined && value !== "");
  return `${line.ts} ${line.kind}${suffix.length === 0 ? "" : ` · ${suffix.join(" · ")}`}`;
}

function evidenceLabel(evidence: EvidenceRow): string {
  if (evidence.kind === "problem") return `unavailable · ${evidence.message}`;
  if (evidence.kind === "log") return `log · ${evidence.lines.length} journal event(s)`;
  const record = evidence.record;
  const call = record.callId === undefined ? "workflow" : record.callId;
  return `${record.kind} · ${call} · ${record.name} · ${record.provenance} · ${record.size} B`;
}

function stageKey(value: string | undefined): string {
  return value === undefined || value.trim() === "" ? "run" : value;
}

function selectableWindow<T>(
  values: readonly T[],
  selected: number,
  height: number,
  width: number,
  theme: RunViewerTheme,
  label: (value: T) => string,
): string[] {
  if (height <= 0) return [];
  const start = windowStart(selected, values.length, height);
  return values.slice(start, start + height).map((value, offset) => {
    const active = start + offset === selected;
    return style(theme, active ? "accent" : "text", fitLine(`${active ? ">" : " "} ${label(value)}`, width));
  });
}

function listFooter(action: string, height: number): string[] {
  if (height <= 1) return [];
  const lines = [`${action} · Esc back`, "↑/↓ select · persisted files only"];
  return lines.slice(0, Math.min(VIEWER_FOOTER_ROWS, height - 1));
}

function viewerRows(tui: CustomUiTui): number {
  return sharedViewerRows(tui, {
    minimumRows: 3,
    fallbackRows: DEFAULT_TERMINAL_ROWS,
    hostFooterRows: PI_HOST_FOOTER_ROWS,
  });
}

function contentBodyHeight(tui: CustomUiTui): number {
  return Math.max(0, viewerRows(tui) - 1 - VIEWER_FOOTER_ROWS);
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function wrapPlain(value: string, width: number): string[] {
  return value.split(/\r?\n/u).flatMap((line) => wrapTextWithAnsi(line, width));
}

function windowStart(selected: number, total: number, limit: number): number {
  if (limit <= 0 || total <= limit) return 0;
  return clamp(selected - Math.floor(limit / 2), 0, total - limit);
}

function cycleIndex(index: number, delta: number, total: number): number {
  return total <= 0 ? 0 : (index + delta + total) % total;
}

function isUp(keybindings: unknown, data: string): boolean {
  return matchesInput(keybindings, data, "tui.select.up", ["up", "k", "\x1b[A", "\x1bOA"]);
}

function isDown(keybindings: unknown, data: string): boolean {
  return matchesInput(keybindings, data, "tui.select.down", ["down", "j", "\x1b[B", "\x1bOB"]);
}

function isConfirm(keybindings: unknown, data: string): boolean {
  return matchesInput(keybindings, data, "tui.select.confirm", ["enter", "\r", "\n"]);
}

function isCancel(keybindings: unknown, data: string): boolean {
  return matchesInput(keybindings, data, "tui.select.cancel", ["escape", "\x1b", "q", "Q"]);
}

function matchesInput(
  keybindings: unknown,
  data: string,
  binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  fallbacks: readonly string[],
): boolean {
  return isKeybindings(keybindings) ? keybindings.matches(data, binding) : fallbacks.includes(data);
}

function isKeybindings(value: unknown): value is RunViewerKeybindings {
  return typeof value === "object" && value !== null && typeof (value as { matches?: unknown }).matches === "function";
}

function asTheme(value: unknown): RunViewerTheme {
  return typeof value === "object" && value !== null ? (value as RunViewerTheme) : {};
}

function style(theme: RunViewerTheme, color: string, text: string): string {
  return typeof theme.fg === "function" ? theme.fg(color, text) : text;
}
