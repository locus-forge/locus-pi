import {
  renderStatusLines,
  paintStatusLines,
  formatStatusCwd,
  defaultControlHints,
  type CompactionDisplayState,
  type StatusLineSnapshot,
} from "../_shared/agent-runtime/status-line-render.js";
export {
  renderStatusLines,
  defaultControlHints,
  type CompactionDisplayState,
  type StatusLineSnapshot,
} from "../_shared/agent-runtime/status-line-render.js";
import type {
  CustomUiComponent,
  ExtensionContext,
  FooterDataProviderLike,
  ThemeLike,
  WidgetFactoryTui,
} from "../_shared/host/pi-api.js";
import { clearViewerExternalRows, setViewerExternalRows } from "../_shared/operator/viewer-geometry.js";

const COMPACTED_VISIBLE_MS = 12_000;
const STATUS_LINE_OVERFLOW_OWNER = "status-line-overflow";

export class LocusFooterComponent implements CustomUiComponent {
  #unsubscribeBranch: (() => void) | undefined;
  #clearCompactedTimer: ReturnType<typeof setTimeout> | undefined;
  #compaction: CompactionDisplayState = { kind: "idle" };

  constructor(
    private readonly tui: WidgetFactoryTui,
    private readonly theme: ThemeLike,
    private readonly ctx: ExtensionContext,
    private readonly footerData: FooterDataProviderLike,
  ) {
    this.#unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
  }

  setCompaction(state: CompactionDisplayState): void {
    this.#compaction = state;
    if (this.#clearCompactedTimer !== undefined) clearTimeout(this.#clearCompactedTimer);
    this.#clearCompactedTimer = undefined;
    if (state.kind === "compacted") {
      this.#clearCompactedTimer = setTimeout(() => {
        this.#compaction = { kind: "idle" };
        this.#clearCompactedTimer = undefined;
        this.tui.requestRender();
      }, COMPACTED_VISIBLE_MS);
      this.#clearCompactedTimer.unref?.();
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.#unsubscribeBranch?.();
    this.#unsubscribeBranch = undefined;
    if (this.#clearCompactedTimer !== undefined) clearTimeout(this.#clearCompactedTimer);
    this.#clearCompactedTimer = undefined;
    clearViewerExternalRows(STATUS_LINE_OVERFLOW_OWNER);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const plainLines = renderStatusLines(snapshotStatusLine(this.ctx, this.footerData, this.#compaction), safeWidth);
    setViewerExternalRows(STATUS_LINE_OVERFLOW_OWNER, Math.max(0, plainLines.length - 1));
    // Stable violet identity. Semantic content remains plain text and survives
    // terminals/themes that strip ANSI styling.
    return paintStatusLines(plainLines, safeWidth);
  }
}

export function snapshotStatusLine(
  ctx: ExtensionContext,
  footerData: FooterDataProviderLike,
  compaction: CompactionDisplayState = { kind: "idle" },
): StatusLineSnapshot {
  const cwd = ctx.sessionManager?.getCwd?.() ?? ctx.session?.workingDirectory ?? ctx.cwd ?? process.cwd();
  const context = ctx.getContextUsage?.();
  const modelName = ctx.model?.id ?? "no-model";
  const branch = footerData.getGitBranch();
  return {
    model: modelName,
    effort: ctx.thinkingLevel ?? "off",
    cwd: formatStatusCwd(cwd),
    ...(branch === null ? {} : { branch }),
    controls: defaultControlHints(),
    contextTokens: context?.tokens ?? null,
    contextWindow: context?.contextWindow ?? numericField(ctx.model, "contextWindow") ?? 0,
    contextPercent: context?.percent ?? null,
    compaction,
  };
}

function numericField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
