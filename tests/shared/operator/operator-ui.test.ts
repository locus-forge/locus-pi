import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  renderOperatorBlock,
  renderOperatorBlockPlain,
  styleActiveSelection,
  type OperatorBlock,
  type OperatorSurfaceType,
  type OperatorThemeLike,
} from "../../../extensions/_shared/operator/operator-ui.js";
import {
  HOST_STRING_ARRAY_WIDGET_LINES,
  setOperatorWidget,
} from "../../../extensions/_shared/operator/widget-render.js";
import type { CustomUiComponent } from "../../../extensions/_shared/host/pi-api.js";
import { createHarness } from "../../test-harness.js";

const block: OperatorBlock = {
  type: "VIEW",
  subject: "Goal",
  primary: "Keep operator state legible",
  badges: [
    { text: "ACTIVE", tone: "success" },
    { text: "PROJECT", tone: "muted" },
  ],
  body: ["Objective: distinguish state, action, and help without losing the current value."],
  metadata: ["Scope: project", "Source: .locus/goal.md"],
  hint: ["Hint: use /goal edit to change the objective."],
  controls: ["enter inspect · esc close"],
};

const surfaceTypes: OperatorSurfaceType[] = [
  "VIEW",
  "CHANGE",
  "RUN",
  "INPUT",
  "SELECT",
  "RESULT",
  "LIVE",
  "WARN",
  "ERROR",
];

describe("typed operator block renderer", () => {
  it("owns the fixed purple selection fill and keeps its plain fallback ANSI-free", () => {
    const theme = ansiTheme("36");

    expect(styleActiveSelection(theme, "[Project]")).toBe(
      "\u001b[48;2;88;61;121m\u001b[38;2;248;241;255m[Project]\u001b[0m",
    );
    expect(styleActiveSelection(undefined, "[Project]")).toBe("[Project]");
  });

  it("uses the purple-family border for SELECT while INPUT keeps the host accent border", () => {
    const theme = ansiTheme("36");
    const select = renderOperatorBlock({ type: "SELECT", subject: "Choice", primary: "Pick" }, 48, theme);
    const input = renderOperatorBlock({ type: "INPUT", subject: "Value", primary: "Type" }, 48, theme);

    expect(select[0]).toContain("\u001b[38;2;196;167;231m╭─ \u001b[39m");
    expect(select.at(-1)).toContain("\u001b[38;2;196;167;231m");
    expect(input[0]).toContain("\u001b[36m╭─ \u001b[0m");
    expect(input.join("\n")).not.toContain("\u001b[38;2;196;167;231m");
  });

  it.each([146, 80, 48])("keeps themed and plain projections width-safe at %i columns", (width) => {
    const theme = ansiTheme("36");

    for (const lines of [renderOperatorBlock(block, width, theme), renderOperatorBlockPlain(block, width)]) {
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).toContain("[VIEW]");
      expect(lines.join("\n")).toContain(block.primary);
    }
  });

  it.each([146, 80, 48, 12])("separates the framed heading from its top rule at %i columns", (width) => {
    const overflowing: OperatorBlock = {
      ...block,
      subject: "A subject far longer than any terminal column budget can hold",
    };

    for (const candidate of [block, overflowing, { type: "VIEW", subject: "", primary: "p" } as OperatorBlock]) {
      const top = renderOperatorBlock(candidate, width, ansiTheme("36"))[0] ?? "";
      const plain = top.replace(/\x1b\[[0-9;]*m/gu, "");

      // The rule occupies whatever the heading leaves, so the corner always lands
      // on the last column and the heading never touches the dashes.
      expect(visibleWidth(top)).toBe(width);
      expect(plain.startsWith("╭─ ")).toBe(true);
      expect(plain.endsWith("╮")).toBe(true);
      expect(plain.slice(3, -1).replace(/─+$/u, "")).toMatch(/ $/u);
    }
  });

  it("keeps the fixed heading, primary, body, metadata, hint, controls hierarchy", () => {
    expect(renderOperatorBlockPlain(block, 80)).toEqual([
      "[VIEW] Goal [ACTIVE]",
      "Keep operator state legible",
      "Objective: distinguish state, action, and help without losing the current value.",
      "Scope: project",
      "Source: .locus/goal.md",
      "Hint: use /goal edit to change the objective.",
      "enter inspect · esc close",
    ]);
  });

  it("retains every textual surface label without relying on color", () => {
    for (const type of surfaceTypes) {
      const text = renderOperatorBlockPlain({ type, subject: "Proof", primary: "Primary value" }, 48).join("\n");
      expect(text).toContain(`[${type}]`);
      expect(text).toContain("Primary value");
    }
  });

  it("uses responsive badge tiers and keeps plain output free of ANSI and decorative framing", () => {
    expect(renderOperatorBlockPlain(block, 146)[0]).toBe("[VIEW] Goal [ACTIVE] [PROJECT]");
    expect(renderOperatorBlockPlain(block, 80)[0]).toBe("[VIEW] Goal [ACTIVE]");
    expect(renderOperatorBlockPlain(block, 48)[0]).toBe("[VIEW] Goal");
    expect(renderOperatorBlockPlain(block, 146).join("\n")).not.toMatch(/[\x1b╭╮╰╯│─]/u);
  });

  it("rebuilds themed strings on every render instead of retaining stale color codes", () => {
    const theme = mutableAnsiTheme("31");
    const first = renderOperatorBlock(block, 80, theme).join("\n");
    theme.color = "34";
    const second = renderOperatorBlock(block, 80, theme).join("\n");

    expect(first).toContain("\x1b[31m");
    expect(second).toContain("\x1b[34m");
    expect(second).not.toContain("\x1b[31m");
  });

  it("prioritizes type and primary in a one-line ANSI-free compact projection", () => {
    const compact = renderOperatorBlock(
      {
        type: "WARN",
        subject: "A very long subject that cannot share the one-line viewport",
        primary: "PRIMARY длинное значение remains visible",
      },
      48,
      ansiTheme("33"),
      { maxLines: 1 },
    );

    expect(compact).toHaveLength(1);
    expect(compact[0]).toContain("[WARN] PRIMARY");
    expect(compact[0]).not.toContain("\x1b");
    expect(visibleWidth(compact[0] ?? "")).toBeLessThanOrEqual(48);
  });
});

describe("typed operator widget adapter", () => {
  it.each(surfaceTypes)("derives the shared default placement for %s", (type) => {
    const harness = createHarness(process.cwd(), { mode: "tui" });
    harness.ctx.hasUI = true;

    setOperatorWidget(harness.ctx, `operator-${type}`, {
      type,
      subject: "Placement proof",
      primary: "Primary value",
    });

    expect(harness.widgetOptions.get(`operator-${type}`)).toEqual({
      placement: type === "VIEW" ? "belowEditor" : "aboveEditor",
    });
    expect(harness.terminalInputHandlers.size).toBe(type === "VIEW" ? 1 : 0);
  });

  it("uses a rerenderable component factory in TUI mode with explicit placement", () => {
    const harness = createHarness(process.cwd(), { mode: "tui" });
    harness.ctx.hasUI = true;

    setOperatorWidget(harness.ctx, "operator-proof", block, { placement: "aboveEditor" });

    const payload = harness.widgetPayloads.get("operator-proof");
    expect(typeof payload).toBe("function");
    expect(harness.widgetOptions.get("operator-proof")).toEqual({ placement: "aboveEditor" });

    const requestRender = vi.fn();
    const component = (payload as (_tui: unknown, theme: unknown) => CustomUiComponent)(
      { requestRender },
      ansiTheme("35"),
    );
    const lines = component.render(48);
    // Presentation is a normal differential paint; only teardown forces a full
    // redraw, so a block appearing never blinks the frame.
    expect(requestRender).toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalledWith(true);
    expect(lines.join("\n")).toContain("[VIEW]");
    expect(lines.join("\n")).toContain(block.primary);
    expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
    component.invalidate();
    component.dispose?.();
    expect(requestRender).toHaveBeenLastCalledWith(true);
    expect(harness.sentMessages).toEqual([]);
    expect(harness.entries).toEqual([]);
  });

  it.each([146, 80, 48])("keeps a long TUI card inside the 45-row viewport at %i columns", (width) => {
    const harness = createHarness(process.cwd(), { mode: "tui" });
    harness.ctx.hasUI = true;
    const longBlock: OperatorBlock = {
      ...block,
      body: Array.from(
        { length: 60 },
        (_, index) => `Row ${index + 1}: a bounded domain value that remains distinguishable from controls.`,
      ),
      metadata: ["Legend: [R] history · [P] project · [U] user · [PKG] package"],
      controls: ["Filter: /workflows list <query>", "Status: /workflows status"],
    };

    setOperatorWidget(harness.ctx, "operator-proof", longBlock, { placement: "belowEditor" });

    const payload = harness.widgetPayloads.get("operator-proof");
    const component = (payload as (_tui: unknown, theme: unknown) => CustomUiComponent)(
      { requestRender() {}, terminal: { rows: 45, columns: width } },
      ansiTheme("35"),
    );
    const lines = component.render(width);
    const text = lines.join("\n");

    expect(lines.length).toBeLessThanOrEqual(39);
    expect(text).toContain("[VIEW]");
    expect(text).toContain(longBlock.primary);
    expect(text).toContain("Legend: [R] history");
    expect(text).toContain("Filter: /workflows list <query>");
    expect(text).toContain("Status: /workflows status");
    expect(text).toMatch(/\(\+\d+ hidden\)/u);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it.each([9, 10, 11])("keeps type and primary inside an exceptionally short %i-row viewport", (rows) => {
    const harness = createHarness(process.cwd(), { mode: "tui" });
    harness.ctx.hasUI = true;
    const shortViewportBlock: OperatorBlock = {
      type: "WARN",
      subject: "Recovery",
      primary: "PRIMARY remains visible when the viewport is exceptionally short",
      metadata: Array.from({ length: 12 }, (_, index) => `metadata ${index + 1}`),
      controls: ["enter retry", "esc close"],
    };

    setOperatorWidget(harness.ctx, "operator-proof", shortViewportBlock, { placement: "aboveEditor" });

    const payload = harness.widgetPayloads.get("operator-proof");
    const component = (payload as (_tui: unknown, theme: unknown) => CustomUiComponent)(
      { requestRender() {}, terminal: { rows, columns: 48 } },
      ansiTheme("33"),
    );
    const lines = component.render(48);
    const text = lines.join("\n");

    expect(lines.length).toBeLessThanOrEqual(rows - 6);
    expect(text).toContain("[WARN]");
    expect(text).toContain("PRIMARY");
    expect(lines.some((line) => line.startsWith("(+"))).toBe(false);
    expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
  });

  it("uses the plain string-array projection in RPC mode", () => {
    const harness = createHarness(process.cwd(), { mode: "rpc" });
    harness.ctx.hasUI = true;

    setOperatorWidget(harness.ctx, "operator-proof", block, {
      placement: "belowEditor",
      fallbackWidth: 48,
    });

    const payload = harness.widgetPayloads.get("operator-proof");
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toEqual(renderOperatorBlockPlain(block, 48, { maxLines: HOST_STRING_ARRAY_WIDGET_LINES }));
    expect((payload as string[]).every((line) => !line.includes("\x1b"))).toBe(true);
    expect(harness.widgetOptions.get("operator-proof")).toEqual({ placement: "belowEditor" });
    expect(harness.sentMessages).toEqual([]);
    expect(harness.entries).toEqual([]);
  });

  it("keeps controls when long content would overflow the host's string-array clamp", () => {
    // Absolute paths in a deeply nested checkout wrap into many rows; the host
    // clamps by slicing the tail, so without our own budget the operator loses
    // the line that says how to act and gets no sign anything was dropped.
    const long: OperatorBlock = {
      type: "VIEW",
      subject: "Workflow catalog",
      primary: "10 runnable workflow(s).",
      body: Array.from({ length: 8 }, (_unused, index) => `[P] Project entry-${index} · ${"/deep".repeat(24)}/w.mjs`),
      metadata: ["Sources: [P] Project · [U] User"],
      controls: ["Run: /workflows run <name|path>", "Filter: /workflows list <query>"],
    };

    const lines = renderOperatorBlockPlain(long, 80, { maxLines: HOST_STRING_ARRAY_WIDGET_LINES });

    expect(lines.length).toBeLessThanOrEqual(HOST_STRING_ARRAY_WIDGET_LINES);
    expect(lines.join("\n")).toContain("Run: /workflows run <name|path>");
    expect(lines.join("\n")).toMatch(/\(\+\d+ hidden\)/u);
  });

  it("uses the plain projection for a partial host that does not declare a mode", () => {
    const harness = createHarness();
    delete harness.ctx.mode;
    harness.ctx.hasUI = true;

    setOperatorWidget(harness.ctx, "operator-proof", block, { placement: "belowEditor" });

    expect(Array.isArray(harness.widgetPayloads.get("operator-proof"))).toBe(true);
    expect(harness.sentMessages).toEqual([]);
    expect(harness.entries).toEqual([]);
  });

  it.each(["json", "print"] as const)("does not claim UI delivery in %s mode when hasUI is false", (mode) => {
    const harness = createHarness(process.cwd(), { mode });
    harness.ctx.hasUI = false;

    setOperatorWidget(harness.ctx, "operator-proof", block, { placement: "aboveEditor" });

    expect(harness.widgetPayloads.has("operator-proof")).toBe(false);
    expect(harness.widgetOptions.has("operator-proof")).toBe(false);
    expect(harness.sentMessages).toEqual([]);
    expect(harness.entries).toEqual([]);
  });
});

function ansiTheme(color: string): OperatorThemeLike {
  return {
    fg(_tone, text) {
      return `\x1b[${color}m${text}\x1b[0m`;
    },
    bold(text) {
      return `\x1b[1m${text}\x1b[22m`;
    },
  };
}

function mutableAnsiTheme(color: string): OperatorThemeLike & { color: string } {
  return {
    color,
    fg(_tone, text) {
      return `\x1b[${this.color}m${text}\x1b[0m`;
    },
    bold(text) {
      return `\x1b[1m${text}\x1b[22m`;
    },
  };
}
