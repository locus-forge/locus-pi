import { highlightCode } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import path from "node:path";
import type { CustomUiComponent, CustomUiTui } from "../../_shared/host/pi-api.js";
import {
  renderOperatorBlock,
  styleActiveSelection,
  type OperatorBlock,
  type OperatorThemeLike,
} from "../../_shared/operator/operator-ui.js";
import { clamp, clipLines, fitLine, viewerRows as sharedViewerRows } from "../../_shared/operator/viewer-geometry.js";
import {
  readWorkflowCatalogSource,
  workflowSourceBadge,
  type WorkflowBrowserAction,
  type WorkflowBrowserIntent,
  type WorkflowCatalogCurrentRow,
  type WorkflowCatalogHistoryRow,
  type WorkflowCatalogModel,
  type WorkflowSourceReadState,
} from "./workflow-catalog.js";
import { workflowCopyDestinations, type WorkflowCopyDestination } from "./workflow-copy.js";
import { packagedExamplesDir } from "../runtime/workflow-discovery.js";
import {
  WORKFLOW_ROOT_DIRNAME,
  WORKFLOW_SAVED_SOURCE_DIRNAME,
  workflowRunsRootDir,
} from "../runtime/workflow-run-layout.js";

const DEFAULT_TERMINAL_ROWS = 24;
// Keep two rows of breathing room above the one-row Locus footer so focused
// browsers never collide with host redraws on short terminals.
const PI_HOST_FOOTER_ROWS = 3;
const COMPACT_FOOTER_ROWS = 2;
const SOURCE_FRAME_ROWS = 2;
// Same `keys action · keys action` shape every other footer in this browser uses,
// so scroll hints read as a list instead of one run-on key sequence.
const SCROLL_CONTROLS = "↑/↓ scroll · PgUp/PgDn page · Home/End jump";
interface WorkflowCatalogTheme {
  fg?(color: string, text: string): string;
  bold?(text: string): string;
}

interface WorkflowCatalogKeybindings {
  matches(
    data: string,
    keybinding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  ): boolean;
}

type SelectableWorkflowRow = WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow;
type CatalogTabId = "project" | "personal" | "package" | "history";
type SourceAction = "back" | WorkflowBrowserAction;
type CatalogScreen =
  | { kind: "catalog" }
  | { kind: "source"; selected: SelectableWorkflowRow; state: WorkflowSourceReadState }
  | { kind: "identity"; selected: SelectableWorkflowRow; state: WorkflowSourceReadState };

/** Focused read-only browser. It can only resolve a typed editor intent or cancellation. */
export class WorkflowCatalogViewer implements CustomUiComponent {
  #screen: CatalogScreen = { kind: "catalog" };
  #tabIndex = 0;
  #selectedIndex = 0;
  #sourceScroll = 0;
  #identityScroll = 0;
  #actionIndex = 0;
  #lastWidth = 80;
  #highlightedSource: string[] | undefined;
  #done: ((intent?: WorkflowBrowserIntent) => void) | undefined;
  readonly #theme: WorkflowCatalogTheme;

  constructor(
    private readonly tui: CustomUiTui,
    theme: unknown,
    private readonly keybindings: unknown,
    private readonly model: WorkflowCatalogModel,
    private readonly projectRoot: string,
    private readonly workingDirectory: string,
    done: (intent?: WorkflowBrowserIntent) => void,
  ) {
    this.#theme = asTheme(theme);
    this.#done = done;
    this.#tabIndex = initialCatalogTabIndex(model);
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    this.#lastWidth = safeWidth;
    if (this.#screen.kind === "catalog") return this.#renderCatalog(safeWidth);
    if (this.#screen.kind === "identity") return this.#renderIdentity(this.#screen, safeWidth);
    return this.#renderSource(this.#screen, safeWidth);
  }

  handleInput(data: string): void {
    if (this.#screen.kind === "catalog") this.#handleCatalogInput(data);
    else if (this.#screen.kind === "identity") this.#handleIdentityInput(data);
    else this.#handleSourceInput(data);
  }

  invalidate(): void {
    this.#highlightedSource = undefined;
  }

  dispose(): void {
    this.#done = undefined;
  }

  get selectedIndex(): number {
    return this.#selectedIndex;
  }
  get screenKind(): CatalogScreen["kind"] {
    return this.#screen.kind;
  }

  #handleCatalogInput(data: string): void {
    if (matchesInput(this.keybindings, data, "tui.select.cancel", ["escape", "\x1b", "q", "Q"])) {
      this.#finish();
      return;
    }
    if (["tab", "\t", "right", "\x1b[C", "\x1bOC"].includes(data)) {
      this.#tabIndex = cycleIndex(this.#tabIndex, 1, CATALOG_TABS.length);
      this.#selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (["left", "\x1b[D", "\x1bOD"].includes(data)) {
      this.#tabIndex = cycleIndex(this.#tabIndex, -1, CATALOG_TABS.length);
      this.#selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    const rows = selectableRows(this.model, activeCatalogTab(this.#tabIndex).id);
    if (rows.length === 0) return;
    if (matchesInput(this.keybindings, data, "tui.select.up", ["up", "k", "\x1b[A", "\x1bOA"])) {
      this.#selectedIndex = cycleIndex(this.#selectedIndex, -1, rows.length);
      this.tui.requestRender();
      return;
    }
    if (matchesInput(this.keybindings, data, "tui.select.down", ["down", "j", "\x1b[B", "\x1bOB"])) {
      this.#selectedIndex = cycleIndex(this.#selectedIndex, 1, rows.length);
      this.tui.requestRender();
      return;
    }
    if (matchesInput(this.keybindings, data, "tui.select.confirm", ["enter", "\r", "\n"])) {
      const selected = rows[this.#selectedIndex];
      if (selected === undefined) return;
      this.#screen = {
        kind: "source",
        selected,
        state: readWorkflowCatalogSource(selected, this.projectRoot, this.workingDirectory),
      };
      this.#sourceScroll = 0;
      this.#identityScroll = 0;
      this.#actionIndex = 0;
      this.#highlightedSource = undefined;
      this.tui.requestRender();
    }
  }

  #handleSourceInput(data: string): void {
    if (matchesInput(this.keybindings, data, "tui.select.cancel", ["escape", "\x1b", "q", "Q"])) {
      this.#returnToCatalog();
      return;
    }
    const screen = this.#screen;
    if (screen.kind !== "source") return;
    if (data === "i" || data === "I") {
      this.#screen = { kind: "identity", selected: screen.selected, state: screen.state };
      this.#identityScroll = 0;
      this.tui.requestRender();
      return;
    }
    const actions = sourceActions(screen, viewerRows(this.tui));
    if (["tab", "\t"].includes(data)) {
      this.#actionIndex = cycleIndex(this.#actionIndex, 1, actions.length);
      this.tui.requestRender();
      return;
    }
    if (["right", "\x1b[C", "\x1bOC"].includes(data)) {
      this.#actionIndex = cycleIndex(this.#actionIndex, 1, actions.length);
      this.tui.requestRender();
      return;
    }
    if (["left", "\x1b[D", "\x1bOD"].includes(data)) {
      this.#actionIndex = cycleIndex(this.#actionIndex, -1, actions.length);
      this.tui.requestRender();
      return;
    }
    if (matchesInput(this.keybindings, data, "tui.select.confirm", ["enter", "\r", "\n"])) {
      const action = actions[this.#actionIndex] ?? "back";
      if (action === "back") this.#returnToCatalog();
      else if (screen.selected.kind === "history") {
        if (action === "review") this.#finish({ action, row: screen.selected, sourceState: screen.state });
      } else {
        this.#finish({ action, row: screen.selected, sourceState: screen.state });
      }
      return;
    }
    if (screen.state.kind !== "ready") return;
    const page = Math.max(1, sourceBodyHeight(this.tui, screen, this.#lastWidth) - 1);
    if (matchesInput(this.keybindings, data, "tui.select.up", ["up", "k", "\x1b[A", "\x1bOA"])) this.#sourceScroll -= 1;
    else if (matchesInput(this.keybindings, data, "tui.select.down", ["down", "j", "\x1b[B", "\x1bOB"]))
      this.#sourceScroll += 1;
    else if (["pageUp", "pageup", "\x1b[5~"].includes(data)) this.#sourceScroll -= page;
    else if (["pageDown", "pagedown", "\x1b[6~"].includes(data)) this.#sourceScroll += page;
    else if (["home", "\x1b[H", "\x1b[1~"].includes(data)) this.#sourceScroll = 0;
    else if (["end", "\x1b[F", "\x1b[4~"].includes(data)) this.#sourceScroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#sourceScroll = Math.max(0, this.#sourceScroll);
    this.tui.requestRender();
  }

  #handleIdentityInput(data: string): void {
    const screen = this.#screen;
    if (screen.kind !== "identity") return;
    if (
      matchesInput(this.keybindings, data, "tui.select.cancel", ["escape", "\x1b", "q", "Q"]) ||
      data === "i" ||
      data === "I"
    ) {
      this.#screen = { kind: "source", selected: screen.selected, state: screen.state };
      this.tui.requestRender();
      return;
    }
    const page = Math.max(1, identityBodyHeight(this.tui));
    if (matchesInput(this.keybindings, data, "tui.select.up", ["up", "k", "\x1b[A", "\x1bOA"]))
      this.#identityScroll -= 1;
    else if (matchesInput(this.keybindings, data, "tui.select.down", ["down", "j", "\x1b[B", "\x1bOB"]))
      this.#identityScroll += 1;
    else if (["pageUp", "pageup", "\x1b[5~"].includes(data)) this.#identityScroll -= page;
    else if (["pageDown", "pagedown", "\x1b[6~"].includes(data)) this.#identityScroll += page;
    else if (["home", "\x1b[H", "\x1b[1~"].includes(data)) this.#identityScroll = 0;
    else if (["end", "\x1b[F", "\x1b[4~"].includes(data)) this.#identityScroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#identityScroll = Math.max(0, this.#identityScroll);
    this.tui.requestRender();
  }

  #returnToCatalog(): void {
    this.#screen = { kind: "catalog" };
    this.#sourceScroll = 0;
    this.#identityScroll = 0;
    this.#actionIndex = 0;
    this.#highlightedSource = undefined;
    this.tui.requestRender();
  }

  #finish(intent?: WorkflowBrowserIntent): void {
    const done = this.#done;
    this.#done = undefined;
    done?.(intent);
  }

  #renderCatalog(width: number): string[] {
    const height = viewerRows(this.tui);
    const tab = activeCatalogTab(this.#tabIndex);
    if (height <= 6)
      return compactCatalogProjection(this.model, tab.id, this.#selectedIndex, height, width, this.#theme);
    const tabs = fitLine(catalogTabBar(this.model, tab.id, width, this.#theme), width);
    const controls = catalogControls(this.model, tab.id);
    const footerHeight = Math.min(1, Math.max(0, height - 2));
    const location = catalogLocationLines(this.model, tab.id, this.projectRoot, width, this.#theme).slice(
      0,
      Math.max(0, height - 2 - footerHeight),
    );
    const bodyHeight = Math.max(0, height - 2 - location.length - footerHeight);
    const query = this.model.query === undefined ? "" : ` · query ${JSON.stringify(this.model.query)}`;
    const rows = selectableRows(this.model, tab.id);
    const header = fitLine(
      style(this.#theme, "accent", `[SELECT] Workflow catalog · ${tab.label} (${rows.length})${query}`),
      width,
    );
    const body = catalogBody(this.model, tab.id, this.#selectedIndex, bodyHeight, width, this.#theme);
    return [
      header,
      tabs,
      ...location,
      ...clipLines(body, bodyHeight, width),
      ...(footerHeight === 0 ? [] : [fitLine(controls, width)]),
    ];
  }

  #renderSource(screen: Extract<CatalogScreen, { kind: "source" }>, width: number): string[] {
    const height = viewerRows(this.tui);
    if (height === 1) return [fitLine("[Back] · Enter/Esc back", width)];
    const layout = sourceLayout(this.tui, screen, width);
    const identity = sourceIdentityLines(screen.selected, width, layout.identityLimit, this.#theme).slice(
      0,
      height - layout.footerHeight,
    );
    const actions = sourceActions(screen, height);
    this.#actionIndex = clamp(this.#actionIndex, 0, actions.length - 1);
    let body: string[];
    let position = "";
    if (screen.state.kind === "ready") {
      const highlighted = (this.#highlightedSource ??= highlightCode(screen.state.source, "javascript"));
      const total = Math.max(1, highlighted.length);
      const maxScroll = Math.max(0, total - layout.bodyHeight);
      this.#sourceScroll = clamp(this.#sourceScroll, 0, maxScroll);
      body = highlighted
        .slice(this.#sourceScroll, this.#sourceScroll + layout.bodyHeight)
        .map((line) => fitLine(line, width));
      const first = Math.min(total, this.#sourceScroll + 1);
      const last = Math.min(total, this.#sourceScroll + Math.max(1, body.length));
      position = `${first}-${last}/${total}`;
    } else {
      body = wrapPlain(screen.state.message, width).slice(0, layout.bodyHeight);
    }
    const framedBody = layout.framed
      ? [
          sourceFrameLine("top", "Code", width, this.#theme),
          ...clipLines(body, layout.bodyHeight, width),
          sourceFrameLine("bottom", position, width, this.#theme),
        ]
      : clipLines(body, layout.bodyHeight, width);
    const footer = sourceFooter(screen, actions, this.#actionIndex, layout.framed ? "" : position, this.#theme);
    return [...identity, ...framedBody, ...footer.slice(0, layout.footerHeight).map((line) => fitLine(line, width))];
  }

  #renderIdentity(screen: Extract<CatalogScreen, { kind: "identity" }>, width: number): string[] {
    const height = viewerRows(this.tui);
    const footerHeight = Math.min(COMPACT_FOOTER_ROWS, Math.max(0, height - 1));
    const bodyHeight = Math.max(0, height - 1 - footerHeight);
    const wrapped = identityTextLines(screen.selected).flatMap((line) =>
      wrapTextWithAnsi(styleIdentityLine(line, this.#theme), width),
    );
    const total = Math.max(1, wrapped.length);
    const maxScroll = Math.max(0, total - bodyHeight);
    this.#identityScroll =
      this.#identityScroll === Number.MAX_SAFE_INTEGER ? maxScroll : clamp(this.#identityScroll, 0, maxScroll);
    const visible = wrapped
      .slice(this.#identityScroll, this.#identityScroll + bodyHeight)
      .map((line) => fitLine(line, width));
    const first = Math.min(total, this.#identityScroll + 1);
    const last = Math.min(total, this.#identityScroll + Math.max(1, visible.length));
    return [
      fitLine(`[IDENTITY] ${screen.selected.name}`, width),
      ...clipLines(visible, bodyHeight, width),
      ...identityFooter(first, last, total)
        .slice(0, footerHeight)
        .map((line) => fitLine(line, width)),
    ];
  }
}

/** Workflow-owned read-only projection of one immutable semantic info block. */
export class WorkflowInfoViewer implements CustomUiComponent {
  #scroll = 0;
  #done: (() => void) | undefined;
  readonly #theme: OperatorThemeLike | undefined;

  constructor(
    private readonly tui: CustomUiTui,
    theme: unknown,
    private readonly keybindings: unknown,
    private readonly block: OperatorBlock,
    done: () => void,
  ) {
    this.#theme = asOperatorTheme(theme);
    this.#done = done;
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    const height = viewerRows(this.tui);
    const footerHeight = height > 1 ? 1 : 0;
    const bodyHeight = Math.max(1, height - footerHeight);
    const content = renderOperatorBlock(this.block, safeWidth, this.#theme);
    const total = Math.max(1, content.length);
    const maxScroll = Math.max(0, total - bodyHeight);
    this.#scroll = this.#scroll === Number.MAX_SAFE_INTEGER ? maxScroll : clamp(this.#scroll, 0, maxScroll);
    const visible = content.slice(this.#scroll, this.#scroll + bodyHeight);
    if (footerHeight === 0) return visible.slice(0, 1).map((line) => fitLine(line, safeWidth));
    const first = Math.min(total, this.#scroll + 1);
    const last = Math.min(total, this.#scroll + visible.length);
    return [
      ...clipLines(visible, bodyHeight, safeWidth),
      fitLine(`${first}-${last}/${total} · ${SCROLL_CONTROLS} · Esc/q close`, safeWidth),
    ];
  }

  handleInput(data: string): void {
    if (matchesInput(this.keybindings, data, "tui.select.cancel", ["escape", "\x1b", "q", "Q"])) {
      this.#finish();
      return;
    }
    const page = Math.max(1, viewerRows(this.tui) - 1);
    if (matchesInput(this.keybindings, data, "tui.select.up", ["up", "k", "\x1b[A", "\x1bOA"])) this.#scroll -= 1;
    else if (matchesInput(this.keybindings, data, "tui.select.down", ["down", "j", "\x1b[B", "\x1bOB"]))
      this.#scroll += 1;
    else if (["pageUp", "pageup", "\x1b[5~"].includes(data)) this.#scroll -= page;
    else if (["pageDown", "pagedown", "\x1b[6~"].includes(data)) this.#scroll += page;
    else if (["home", "\x1b[H", "\x1b[1~"].includes(data)) this.#scroll = 0;
    else if (["end", "\x1b[F", "\x1b[4~"].includes(data)) this.#scroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#scroll = Math.max(0, this.#scroll);
    this.tui.requestRender();
  }

  invalidate(): void {
    // Semantic block is immutable; width-specific projection is rebuilt on render.
  }

  dispose(): void {
    this.#done = undefined;
  }

  #finish(): void {
    const done = this.#done;
    this.#done = undefined;
    done?.();
  }
}

const CATALOG_TABS: ReadonlyArray<{ id: CatalogTabId; label: string; compactLabel: string }> = [
  { id: "project", label: "Project", compactLabel: "P" },
  { id: "personal", label: "User", compactLabel: "U" },
  { id: "package", label: "Package", compactLabel: "PKG" },
  { id: "history", label: "History", compactLabel: "H" },
];

function activeCatalogTab(index: number): (typeof CATALOG_TABS)[number] {
  return CATALOG_TABS[clamp(index, 0, CATALOG_TABS.length - 1)]!;
}

function initialCatalogTabIndex(model: WorkflowCatalogModel): number {
  let richestIndex = 0;
  let richestCount = 0;
  for (let index = 0; index < CATALOG_TABS.length - 1; index += 1) {
    const count = selectableRows(model, CATALOG_TABS[index]!.id).length;
    if (count > richestCount) {
      richestIndex = index;
      richestCount = count;
    }
  }
  if (richestCount > 0) return richestIndex;
  return model.history.length > 0 ? CATALOG_TABS.length - 1 : 0;
}

function selectableRows(model: WorkflowCatalogModel, tab: CatalogTabId): SelectableWorkflowRow[] {
  if (tab === "history") return model.history;
  return model.current.filter((row) => row.source === tab);
}

function sourceActions(
  screen: Extract<CatalogScreen, { kind: "source" }>,
  height = Number.MAX_SAFE_INTEGER,
): SourceAction[] {
  if (height <= 1) return ["back"];
  if (screen.selected.kind === "history") return ["back", "review"];
  if (screen.state.kind !== "ready") return ["back"];
  return ["back", "start", "edit", "review", ...workflowCopyDestinations(screen.selected).map(copyDestinationAction)];
}

function copyDestinationAction(destination: WorkflowCopyDestination): "copy-project" | "copy-personal" {
  return destination === "project" ? "copy-project" : "copy-personal";
}

function catalogControls(model: WorkflowCatalogModel, active: CatalogTabId): string {
  const rows = selectableRows(model, active);
  return rows.length === 0
    ? "Tab/←/→ source · Esc close · no rows in this source"
    : `Tab/←/→ source · ↑/↓ select · Enter inspect · Esc close${active === "history" ? " · review-only" : ""}`;
}

function catalogTabBar(
  model: WorkflowCatalogModel,
  active: CatalogTabId,
  width: number,
  theme: WorkflowCatalogTheme,
): string {
  const compact = width < 64;
  return CATALOG_TABS.map((tab) => {
    const label = `${compact ? tab.compactLabel : tab.label} ${selectableRows(model, tab.id).length}`;
    if (tab.id !== active) return label;
    const selected = `[${label}]`;
    return styleActiveSelection(theme, selected);
  }).join("  ");
}

function compactCatalogProjection(
  model: WorkflowCatalogModel,
  tab: CatalogTabId,
  selectedIndex: number,
  height: number,
  width: number,
  theme: WorkflowCatalogTheme,
): string[] {
  const rows = selectableRows(model, tab);
  const selected = rows[selectedIndex];
  const row = fitLine(
    selected === undefined ? "No workflow rows in this source." : compactSelectedRowLine(selected),
    width,
  );
  if (height === 1) return [row];
  const tabs = fitLine(catalogTabBar(model, tab, width, theme), width);
  if (height === 2) return [row, tabs];
  const query = model.query === undefined ? "" : ` · query ${JSON.stringify(model.query)}`;
  const active = CATALOG_TABS.find((candidate) => candidate.id === tab)!;
  const header = fitLine(style(theme, "accent", `[SELECT] Workflow catalog · ${active.label}${query}`), width);
  if (height === 3) {
    return [header, row, tabs];
  }
  return clipLines(
    [header, row, tabs, fitLine(selected === undefined ? "Tab/←/→ · Esc" : "Tab/←/→ · ↑/↓ Enter · Esc", width)],
    height,
    width,
  );
}

function compactSelectedRowLine(row: SelectableWorkflowRow): string {
  return catalogRowSummary(row);
}

function sourceFooter(
  screen: Extract<CatalogScreen, { kind: "source" }>,
  actions: readonly SourceAction[],
  selected: number,
  position: string,
  theme: WorkflowCatalogTheme,
): string[] {
  const controls = "Tab/←/→ action · Enter choose · i details · Esc back";
  return [
    `${actionBar(screen, actions, selected, theme)}${position === "" ? "" : ` ${position}`}`,
    screen.selected.kind === "history"
      ? `${controls} · Review handoff`
      : `${controls} · Start direct; Edit/Review handoff`,
  ];
}

function identityFooter(first: number, last: number, total: number): string[] {
  return [`${first}-${last}/${total} · ${SCROLL_CONTROLS}`, "i/Esc source · Help: /workflows info"];
}

function sourceIdentityLines(
  row: SelectableWorkflowRow,
  width: number,
  limit: number,
  theme: WorkflowCatalogTheme = {},
): string[] {
  const lines = identityTextLines(row).flatMap((line) => wrapTextWithAnsi(styleIdentityLine(line, theme), width));
  return lines.slice(0, limit).map((line) => fitLine(line, width));
}

function styleIdentityLine(line: string, theme: WorkflowCatalogTheme): string {
  if (line.startsWith("[VIEW]")) return `${style(theme, "success", "[VIEW]")}${line.slice("[VIEW]".length)}`;
  const separator = line.indexOf(":");
  return separator < 0 ? line : `${style(theme, "success", line.slice(0, separator + 1))}${line.slice(separator + 1)}`;
}

function identityTextLines(row: SelectableWorkflowRow): string[] {
  return [
    `[VIEW] ${row.kind === "history" ? "[R] " : ""}${workflowSourceBadge(row.source)} ${row.name}`,
    ...(row.kind === "history"
      ? [`Run: ${row.runId}`, `Snapshot: ${row.originPath}`]
      : [`Source: ${row.sourceLabel}`, `Catalog: ${catalogDirectoryForRow(row)}`, `Path: ${row.originPath}`]),
    ...(row.kind === "history" && row.snapshot.sha256 !== undefined ? [`SHA-256: ${row.snapshot.sha256}`] : []),
  ];
}

function actionBar(
  screen: Extract<CatalogScreen, { kind: "source" }>,
  actions: readonly SourceAction[],
  selected: number,
  theme: WorkflowCatalogTheme,
): string {
  return actions
    .map((action, index) => {
      const label = action === "review" && screen.state.kind !== "ready" ? "Diagnose" : title(action);
      return index === selected ? styleActiveSelection(theme, `› [${label}]`) : style(theme, "text", label);
    })
    .join(" ");
}

function title(action: SourceAction): string {
  if (action === "copy-project") return "Copy to Project";
  if (action === "copy-personal") return "Copy to User";
  return action[0]!.toUpperCase() + action.slice(1);
}

function catalogBody(
  model: WorkflowCatalogModel,
  tab: CatalogTabId,
  selectedIndex: number,
  height: number,
  width: number,
  theme: WorkflowCatalogTheme,
): string[] {
  const rows = selectableRows(model, tab);
  if (height === 1) {
    const selected = rows[selectedIndex];
    return [
      fitLine(
        selected === undefined ? "No workflow rows in this source." : rowLines(selected, true, width, theme, false)[0]!,
        width,
      ),
    ];
  }
  const entries = catalogRenderEntries(model, tab, selectedIndex, width, theme);
  if (entries.length === 0) {
    const empty = model.query === undefined ? "No workflows in this source." : "No matches in this source.";
    return clipLines([style(theme, "muted", empty)], height, width);
  }
  const selectedEntry = Math.max(
    0,
    entries.findIndex((entry) => entry.rowIndex === selectedIndex),
  );
  let start = selectedEntry;
  let used = entries[start]!.lines.length;
  while (start > 0 && used + entries[start - 1]!.lines.length <= height) {
    start -= 1;
    used += entries[start]!.lines.length;
  }
  const lines: string[] = [];
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (lines.length > 0 && lines.length + entry.lines.length > height) break;
    lines.push(...entry.lines.slice(0, height - lines.length));
    if (lines.length >= height) break;
  }
  return clipLines(lines, height, width);
}

function groupOnlyHeaderLine(header: WorkflowCatalogModel["groups"][number], theme: WorkflowCatalogTheme): string {
  return style(theme, "muted", `  ${header.name} · ${workflowSourceBadge(header.source)} · group-only (not runnable)`);
}

function catalogRenderEntries(
  model: WorkflowCatalogModel,
  tab: CatalogTabId,
  selectedIndex: number,
  width: number,
  theme: WorkflowCatalogTheme,
): Array<{ rowIndex?: number; lines: string[] }> {
  const rows = selectableRows(model, tab);
  if (tab === "history") {
    return rows.map((row, rowIndex) => ({
      rowIndex,
      lines: rowLines(row, rowIndex === selectedIndex, width, theme, true),
    }));
  }
  const groups = model.groups.filter((group) => group.source === tab);
  const groupByName = new Map(groups.map((group) => [group.name, group]));
  const emittedGroups = new Set<string>();
  const entries: Array<{ rowIndex?: number; lines: string[] }> = [];
  for (const [rowIndex, row] of rows.entries()) {
    const header = row.kind === "current" && row.role === "child" ? groupByName.get(row.rootName) : undefined;
    if (header !== undefined && !emittedGroups.has(header.name)) {
      entries.push({ lines: [groupOnlyHeaderLine(header, theme)] });
      emittedGroups.add(header.name);
    }
    entries.push({ rowIndex, lines: rowLines(row, rowIndex === selectedIndex, width, theme, true) });
  }
  for (const group of groups) {
    if (!emittedGroups.has(group.name)) entries.push({ lines: [groupOnlyHeaderLine(group, theme)] });
  }
  return entries;
}

function rowLines(
  row: SelectableWorkflowRow,
  selected: boolean,
  width: number,
  theme: WorkflowCatalogTheme,
  expanded: boolean,
): string[] {
  if (!expanded) {
    const summary = fitLine(`${selected ? ">" : " "} ${catalogRowSummary(row)}`, width);
    return [selected ? bold(theme, style(theme, "accent", summary)) : style(theme, "text", summary)];
  }
  const isChild = row.kind === "current" && row.role === "child";
  const pathPrefix = isChild ? "      · " : "   · ";
  const continuationPrefix = isChild ? "        " : "     ";
  const detailWidth = Math.max(0, width - visibleWidth(pathPrefix));
  const details = wrapPlain(row.description, Math.max(1, detailWidth));
  return [
    fitLine(styledCatalogRowIdentity(row, selected, theme), width),
    ...details.map((detail, index) => {
      const prefix = index === 0 ? pathPrefix : continuationPrefix;
      return fitLine(
        `${selected ? bold(theme, style(theme, "accent", prefix)) : style(theme, "muted", prefix)}${style(
          theme,
          selected ? "text" : "muted",
          detail,
        )}`,
        width,
      );
    }),
  ];
}

function styledCatalogRowIdentity(row: SelectableWorkflowRow, selected: boolean, theme: WorkflowCatalogTheme): string {
  const marker = selected ? bold(theme, style(theme, "accent", ">")) : " ";
  const run = row.kind === "history" ? ` · run ${row.runId}` : "";
  const treeName = row.kind === "current" && row.role === "child" ? `└ ${row.label}` : row.name;
  const composition =
    row.kind !== "current" || row.role === "child" || row.children.length === 0
      ? ""
      : ` · ${row.children.length} children`;
  const identity = selected
    ? bold(theme, style(theme, "accent", `${treeName}${run}`))
    : style(theme, "text", `${treeName}${run}`);
  const metadata = style(theme, "muted", ` · ${workflowSourceBadge(row.source)}${composition}`);
  return `${marker} ${identity}${metadata}`;
}

function catalogRowIdentity(row: SelectableWorkflowRow): string {
  const run = row.kind === "history" ? ` · run ${row.runId}` : "";
  const treeName = row.kind === "current" && row.role === "child" ? `└ ${row.label}` : row.name;
  const composition =
    row.kind !== "current" || row.role === "child" || row.children.length === 0
      ? ""
      : ` · ${row.children.length} children`;
  return `${treeName}${run} · ${workflowSourceBadge(row.source)}${composition}`;
}

function catalogRowSummary(row: SelectableWorkflowRow): string {
  return `${catalogRowIdentity(row)} · ${row.description}`;
}

function catalogLocationLines(
  model: WorkflowCatalogModel,
  tab: CatalogTabId,
  projectRoot: string,
  width: number,
  theme: WorkflowCatalogTheme,
): string[] {
  const directories = catalogDirectories(model, tab, projectRoot);
  const label = directories.length === 1 ? "Catalog" : "Catalogs";
  return directories.flatMap((directory, index) => {
    const prefix = index === 0 ? `${label}: ` : "          ";
    return wrapTextWithAnsi(`${style(theme, "dim", prefix)}${style(theme, "muted", directory)}`, width);
  });
}

function catalogDirectories(model: WorkflowCatalogModel, tab: CatalogTabId, projectRoot: string): string[] {
  if (tab === "history") return [workflowRunsRootDir(projectRoot)];
  const directories = [
    ...new Set(
      selectableRows(model, tab)
        .filter((row): row is WorkflowCatalogCurrentRow => row.kind === "current")
        .map(catalogDirectoryForRow),
    ),
  ];
  if (directories.length > 0) return directories;
  if (tab === "personal") return [path.join(homedir(), WORKFLOW_ROOT_DIRNAME, WORKFLOW_SAVED_SOURCE_DIRNAME)];
  if (tab === "package") return [packagedExamplesDir()];
  return [path.join(projectRoot, WORKFLOW_ROOT_DIRNAME, WORKFLOW_SAVED_SOURCE_DIRNAME)];
}

function catalogDirectoryForRow(row: WorkflowCatalogCurrentRow): string {
  const namespaceDirectory = path.dirname(row.originPath);
  return path.basename(namespaceDirectory) === row.rootName ? path.dirname(namespaceDirectory) : namespaceDirectory;
}

function middleTruncate(value: string, width: number): string {
  if (width <= 0) return "";
  const total = visibleWidth(value);
  if (total <= width) return value;
  if (width === 1) return "…";
  const basename = value.split(/[\\/]/u).at(-1) ?? value;
  const suffixWidth = Math.min(width - 2, Math.max(1, visibleWidth(basename), Math.floor(width * 0.55)));
  const prefixWidth = Math.max(1, width - suffixWidth - 1);
  return `${sliceByColumn(value, 0, prefixWidth)}…${sliceByColumn(value, total - suffixWidth, total)}`;
}

function sourceFrameLine(edge: "top" | "bottom", label: string, width: number, theme: WorkflowCatalogTheme): string {
  const left = edge === "top" ? "╭─ " : "╰─ ";
  const right = edge === "top" ? "╮" : "╯";
  const prefix = `${left}${label} `;
  const fill = "─".repeat(Math.max(0, width - visibleWidth(prefix) - visibleWidth(right)));
  return fitLine(style(theme, "borderAccent", `${prefix}${fill}${right}`), width);
}

function matchesInput(
  keybindings: unknown,
  data: string,
  binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  fallbacks: readonly string[],
): boolean {
  return isKeybindings(keybindings) ? keybindings.matches(data, binding) : fallbacks.includes(data);
}

function isKeybindings(value: unknown): value is WorkflowCatalogKeybindings {
  return typeof value === "object" && value !== null && typeof (value as { matches?: unknown }).matches === "function";
}

function asTheme(value: unknown): WorkflowCatalogTheme {
  return typeof value === "object" && value !== null ? (value as WorkflowCatalogTheme) : {};
}

function asOperatorTheme(value: unknown): OperatorThemeLike | undefined {
  return typeof value === "object" && value !== null ? (value as OperatorThemeLike) : undefined;
}

function style(theme: WorkflowCatalogTheme, color: string, text: string): string {
  return typeof theme.fg === "function" ? theme.fg(color, text) : text;
}

function bold(theme: WorkflowCatalogTheme, text: string): string {
  return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function viewerRows(tui: CustomUiTui): number {
  return sharedViewerRows(tui, {
    minimumRows: 3,
    fallbackRows: DEFAULT_TERMINAL_ROWS,
    hostFooterRows: PI_HOST_FOOTER_ROWS,
  });
}

function identityBodyHeight(tui: CustomUiTui): number {
  return Math.max(0, viewerRows(tui) - 1 - COMPACT_FOOTER_ROWS);
}

function sourceBodyHeight(tui: CustomUiTui, screen: Extract<CatalogScreen, { kind: "source" }>, width: number): number {
  return sourceLayout(tui, screen, width).bodyHeight;
}

function sourceLayout(
  tui: CustomUiTui,
  screen: Extract<CatalogScreen, { kind: "source" }>,
  width: number,
): {
  bodyHeight: number;
  footerHeight: number;
  framed: boolean;
  identityLimit: number;
} {
  const height = viewerRows(tui);
  const footerHeight = Math.min(COMPACT_FOOTER_ROWS, Math.max(0, height - 1));
  const identityLimit = screen.state.kind === "ready" ? Math.max(1, height - footerHeight - 2) : 1;
  const identityHeight = sourceIdentityLines(screen.selected, width, identityLimit).slice(
    0,
    height - footerHeight,
  ).length;
  const contentHeight = Math.max(0, height - identityHeight - footerHeight);
  const framed = screen.state.kind === "ready" && contentHeight >= SOURCE_FRAME_ROWS + 1;
  return {
    bodyHeight: Math.max(0, contentHeight - (framed ? SOURCE_FRAME_ROWS : 0)),
    footerHeight,
    framed,
    identityLimit,
  };
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function wrapPlain(value: string, width: number): string[] {
  return value.split(/\r?\n/u).flatMap((line) => wrapTextWithAnsi(line, width));
}

function cycleIndex(index: number, delta: number, total: number): number {
  return total <= 0 ? 0 : (index + delta + total) % total;
}
