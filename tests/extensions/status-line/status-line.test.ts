import { afterEach, describe, expect, it, vi } from "vitest";
import statusLine from "../../../extensions/status-line/index.js";
import {
  LocusFooterComponent,
  renderStatusLines,
  type StatusLineSnapshot,
} from "../../../extensions/status-line/footer.js";
import { clearViewerExternalRows, viewerExternalRows } from "../../../extensions/_shared/operator/viewer-geometry.js";
import { createHarness, emit } from "../../test-harness.js";

afterEach(() => clearViewerExternalRows("status-line-overflow"));

function snapshot(overrides: Partial<StatusLineSnapshot> = {}): StatusLineSnapshot {
  return {
    model: "gpt-5.6-sol",
    effort: "high",
    cwd: "~/projects/locus-pi",
    branch: "codex/subagent-interactive-view",
    contextTokens: 63_200,
    contextWindow: 200_000,
    contextPercent: 31.6,
    compaction: { kind: "idle" },
    ...overrides,
  };
}

describe("status-line footer", () => {
  it("uses one row when the full groups fit and two rows only on overflow", () => {
    const wide = renderStatusLines(snapshot(), 240);
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatch(/^~\/projects\/locus-pi \(codex\/subagent-interactive-view\)/u);
    expect(wide[0]).toMatch(/31\.6%\/200k \(pi:auto\) gpt-5\.6-sol high$/u);
    expect(wide[0]).not.toContain("tok:");
    expect(wide[0]).not.toContain("ctx:");
    expect(wide[0]).not.toContain("git:");

    const overflow = renderStatusLines(snapshot(), 80);
    expect(overflow).toHaveLength(2);
    expect(overflow[0]).toBe("~/projects/locus-pi (codex/subagent-interactive-view)");
    expect(overflow[1]).toMatch(/31\.6%\/200k \(pi:auto\) gpt-5\.6-sol high$/u);

    const narrow = renderStatusLines(snapshot(), 48);
    expect(narrow).toHaveLength(2);
    expect(narrow[0]).toMatch(/^locus-pi/u);
    expect(narrow[1]).toHaveLength(48);
    expect(narrow[1]).toMatch(/31\.6%\/200k \(pi:auto\) gpt-5\.6-sol high$/u);
  });

  it("renders honest compacting and post-compaction measuring states", () => {
    expect(renderStatusLines(snapshot({ compaction: { kind: "compacting" } }), 180).join("\n")).toContain("COMPACTING");
    expect(
      renderStatusLines(
        snapshot({ contextTokens: null, compaction: { kind: "compacted", tokensBefore: 182_000, completedAt: 1 } }),
        180,
      ).join("\n"),
    ).toContain("(COMPACTED 182k→measuring…)");
  });

  it("installs one violet footer in TUI mode and restores Pi's footer on shutdown", async () => {
    const harness = createHarness();
    harness.ctx.model = { provider: "openai", id: "gpt-5.6-sol", contextWindow: 200_000 };
    harness.ctx.thinkingLevel = "high";
    harness.ctx.getContextUsage = () => ({ tokens: 10_000, contextWindow: 200_000, percent: 5 });
    statusLine(harness.pi);
    await emit(harness, "session_start");
    expect(harness.footerFactory).toBeTypeOf("function");

    const requestRender = vi.fn();
    const unsubscribe = vi.fn();
    const component = harness.footerFactory?.(
      { requestRender, terminal: { rows: 30, columns: 120 } },
      { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
      {
        getGitBranch: () => "codex/status-line",
        getExtensionStatuses: () => new Map([["locus", "PLAN · doing"]]),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => unsubscribe,
      },
    );
    const rendered = component?.render(240) ?? [];
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("\u001b[48;2;42;27;61m");
    expect(rendered[0]).toContain("5%/200k (pi:auto) gpt-5.6-sol high");
    const narrow = component?.render(40) ?? [];
    expect(narrow).toHaveLength(2);
    expect(narrow.every((line) => line.match(/\u001b\[0m/gu)?.length === 1)).toBe(true);
    expect(viewerExternalRows()).toBe(1);
    expect(component?.render(240)).toHaveLength(1);
    expect(viewerExternalRows()).toBe(0);

    await emit(harness, "session_before_compact", { reason: "threshold" });
    expect(component?.render(240).join("\n")).toContain("COMPACTING");
    await emit(harness, "session_compact", { compactionEntry: { tokensBefore: 182_000 } });
    expect(component?.render(240).join("\n")).toContain("COMPACTED");
    await emit(harness, "session_shutdown");
    expect(harness.footerFactory).toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(viewerExternalRows()).toBe(0);
  });
});
