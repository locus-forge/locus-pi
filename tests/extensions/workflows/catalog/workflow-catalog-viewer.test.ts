import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderOperatorBlock, type OperatorBlock } from "../../../../extensions/_shared/operator/operator-ui.js";
import {
  clearViewerExternalRows,
  setViewerExternalRows,
} from "../../../../extensions/_shared/operator/viewer-geometry.js";
import workflows from "../../../../extensions/workflows/index.js";
import { WorkflowCatalogViewer, WorkflowInfoViewer } from "../../../../extensions/workflows/catalog/catalog-viewer.js";
import {
  buildWorkflowActionPrompt,
  buildWorkflowCatalogModel,
  buildWorkflowInfoBlock,
} from "../../../../extensions/workflows/catalog/workflow-catalog.js";
import { createHarness } from "../../../test-harness.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  workflowJournalFile,
  workflowRunRuntimeDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
  clearViewerExternalRows("test-workflow-catalog");
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("focused workflow catalog", () => {
  it("routes TUI list through focused custom UI and closes with Esc", async () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const harness = createHarness(root);
    harness.ctx.hasUI = true;
    harness.customInputQueue.push("\x1b");
    workflows(harness.pi);

    await harness.commands.get("workflows")!.handler("list", harness.ctx);

    expect(harness.customComponents).toHaveLength(1);
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("[SELECT] Workflow catalog");
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("[Package 12]");
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("> live-smoke · [PKG]");
    expect(harness.widgets.get("workflows")).toBe("");
  });

  it("selects only current rows, opens inert source, then restores catalog cursor", async () => {
    const root = projectWithWorkflows({
      alpha: source("alpha", "Alpha workflow"),
      beta: ["globalThis.__workflowViewerExecuted = true;", ...source("beta", "Beta workflow").split("\n")].join("\n"),
    });
    writeRun(root, "20260101-000001-alpha", "alpha");
    const harness = createHarness(root);
    harness.ctx.hasUI = true;
    harness.customInputQueue.push("left", "left", "down", "enter", "escape", "escape");
    workflows(harness.pi);

    await harness.commands.get("workflows")!.handler("list", harness.ctx);

    const frames = harness.customRenderFrames.map((frame) => frame.join("\n"));
    expect(frames.some((frame) => frame.includes("[VIEW] [P] beta"))).toBe(true);
    expect(frames.some((frame) => frame.includes("globalThis.__workflowViewerExecuted = true;"))).toBe(true);
    expect(frames.at(-1)).toContain("> beta · [P]");
    expect((globalThis as Record<string, unknown>).__workflowViewerExecuted).toBeUndefined();
  });

  it("shows the active catalog directory without adding file paths to rows", () => {
    const root = projectWithWorkflows({
      alpha: source("alpha", "Alpha workflow"),
      beta: source("beta", "Beta workflow"),
    });
    writeRun(root, "20260101-000001-alpha", "alpha");
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 18);
    focusProject(viewer);

    let lines = viewer.render(146);
    let row = lines.findIndex((line) => line.includes("> alpha · [P]"));
    expect(row).toBeGreaterThanOrEqual(0);
    expect(lines[row]).not.toContain(model.current[0]!.originPath);
    expect(lines[row]).not.toMatch(/\b(?:Project|User|Package)\b/u);
    expect(lines[row + 1]).toContain("   · Alpha workflow");
    expect(lines.join("\n")).not.toContain("profile=");
    expect(lines.join("\n")).not.toContain(model.current[0]!.originPath);
    expect(lines.join("\n")).toContain(`Catalog: ${path.join(root, ".locus-pi", "workflows")}`);

    viewer.handleInput("down");
    lines = viewer.render(146);
    row = lines.findIndex((line) => line.includes("> beta · [P]"));
    expect(row).toBeGreaterThanOrEqual(0);
    expect(lines[row + 1]).toContain("   · Beta workflow");

    viewer.handleInput("left");
    lines = viewer.render(146);
    row = lines.findIndex((line) => line.includes("> alpha · run 20260101-000001-alpha · [P]"));
    expect(row).toBeGreaterThanOrEqual(0);
    expect(lines[row]).not.toMatch(/\b(?:Project|User|Package)\b/u);
    expect(lines[row + 1]).toContain("   · historical run snapshot");
  });

  it("keeps source sections and folder hierarchy readable at narrow widths", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 48);

    for (const width of [40, 48, 80]) {
      const lines = viewer.render(width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      const narrow = lines.join("\n");
      expect(narrow).toContain(width < 64 ? "P 1" : "Project 1");
      expect(narrow).toContain(width < 64 ? "U 0" : "User 0");
      expect(narrow).toContain(width < 64 ? "[PKG 12]" : "[Package 12]");
      expect(narrow).toContain("necessity");
      expect(lines.some((line) => /^ {2}└ necessity/u.test(line))).toBe(true);
      expect(narrow).toContain("7 children");
    }
    const rendered = viewer.render(80).join("\n");
    expect(rendered).toContain("post-code-review · [PKG] · 7 children");
    expect(rendered).toMatch(/^ {2}└ necessity · \[PKG\]$/mu);
    expect(rendered).toContain("      · Challenge behavioral and code-shape fixes");
    expect(rendered).not.toContain("    └ Challenge behavioral and code-shape fixes");
  });

  it("renders a group-only header once and keeps its filtered children selectable", () => {
    const root = emptyProject();
    const namespace = path.join(root, ".locus-pi", "workflows", "airflow-dag-builder");
    writeWorkflow(namespace, "implement", source("airflow-dag-builder/implement", "Implement DAG"));
    writeWorkflow(namespace, "plan", source("airflow-dag-builder/plan", "Plan DAG"));
    const model = buildWorkflowCatalogModel(root, root, "airflow-dag-builder");
    const { viewer } = createViewer(model, root, 48);

    expect(model.current.map((row) => row.name)).toEqual(["airflow-dag-builder/implement", "airflow-dag-builder/plan"]);
    const initial = viewer.render(100).join("\n");
    expect(initial.match(/group-only \(not runnable\)/gu)).toHaveLength(1);
    expect(initial.match(/└ implement · \[P\]/gu)).toHaveLength(1);
    expect(initial.match(/└ plan · \[P\]/gu)).toHaveLength(1);

    viewer.handleInput("down");
    expect(viewer.render(100).join("\n")).toContain("> └ plan · [P]");
    viewer.handleInput("enter");
    expect(viewer.render(100).join("\n")).toContain("[VIEW] [P] airflow-dag-builder/plan");
  });

  it("wraps catalog detail at word boundaries without adding profile or path noise", () => {
    const description = "Alpha workflow description uses complete words across the available terminal width";
    const root = projectWithWorkflows({ alpha: source("alpha", description) });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 18);
    focusProject(viewer);

    const rendered = viewer.render(48).join("\n");
    expect(rendered).toContain("   · Alpha workflow description uses complete");
    expect(rendered).toContain("     words across the available terminal width");
    expect(rendered).not.toContain("profile=");
    expect(rendered).not.toContain(model.current[0]!.originPath);
  });

  it("keeps Project, User, Package, and History as persistent source tabs", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    writeRun(root, "20260101-000001-alpha", "alpha");
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 48);

    expect(viewer.render(146).join("\n")).toContain("Project 1  User 0  [Package 12]  History 1");
    viewer.handleInput("left");
    expect(viewer.render(146).join("\n")).toContain("Project 1  [User 0]  Package 12  History 1");
    viewer.handleInput("left");
    expect(viewer.render(146).join("\n")).toContain("[Project 1]  User 0  Package 12  History 1");
    viewer.handleInput("left");
    const history = viewer.render(146).join("\n");
    expect(history).toContain("Project 1  User 0  Package 12  [History 1]");
    expect(history).toContain("alpha · run 20260101-000001-alpha · [P]");
    expect(history).not.toContain("> alpha · [P]");
  });

  it("pins the source tabs directly below the header across different content heights", () => {
    const root = projectWithWorkflows(manyWorkflows(18));
    writeRun(root, "20260101-000001-alpha", "alpha");
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 48);
    const tabRows: number[] = [];

    for (let index = 0; index < 4; index += 1) {
      const lines = viewer.render(146);
      tabRows.push(lines.findIndex((line) => line.includes("Project 18") && line.includes("Package 12")));
      viewer.handleInput("left");
    }

    expect(tabRows).toEqual([1, 1, 1, 1]);
  });

  it("uses the fixed workflow-purple active-tab palette only for themed rendering", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root);
    const themed = createViewer(model, root, 18, { fg: (_color: string, text: string) => text }).viewer.render(146);
    const plain = createViewer(model, root, 18).viewer.render(146);

    expect(themed[1]).toContain("\u001b[48;2;88;61;121m\u001b[38;2;248;241;255m[Package 12]\u001b[0m");
    expect(visibleWidth(themed[1]!)).toBe(visibleWidth(plain[1]!));
    expect(plain[1]).toContain("[Package 12]");
    expect(plain[1]).not.toContain("\u001b[");
  });

  it("opens the richest current source and keeps fixed-order ties deterministic", () => {
    const personalRichRoot = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    writeWorkflow(
      path.join(personalRichRoot, "home", ".locus-pi", "workflows"),
      "personal-19",
      source("personal-19", "Personal"),
    );
    for (let index = 0; index < 18; index += 1) {
      const name = `personal-${String(index).padStart(2, "0")}`;
      writeWorkflow(path.join(personalRichRoot, "home", ".locus-pi", "workflows"), name, source(name, "Personal"));
    }
    const personal = createViewer(
      buildWorkflowCatalogModel(personalRichRoot, personalRichRoot),
      personalRichRoot,
    ).viewer;
    expect(personal.render(100).join("\n")).toContain("Project 1  [User 19]  Package 12");

    const tiedRoot = projectWithWorkflows(manyWorkflows(19));
    const tied = createViewer(buildWorkflowCatalogModel(tiedRoot, tiedRoot), tiedRoot).viewer;
    expect(tied.render(100).join("\n")).toContain("[Project 19]  User 0  Package 12");
  });

  it("cycles catalog tabs with Tab plus named, ANSI, and application arrow keys", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 18);

    viewer.handleInput("tab");
    expect(viewer.render(100).join("\n")).toContain("[History 0]");
    viewer.handleInput("right");
    expect(viewer.render(100).join("\n")).toContain("[Project 1]");
    viewer.handleInput("\x1b[C");
    expect(viewer.render(100).join("\n")).toContain("[User 0]");
    viewer.handleInput("\x1bOC");
    expect(viewer.render(100).join("\n")).toContain("[Package 12]");
    viewer.handleInput("left");
    expect(viewer.render(100).join("\n")).toContain("[User 0]");
    viewer.handleInput("\x1b[D");
    expect(viewer.render(100).join("\n")).toContain("[Project 1]");
    viewer.handleInput("\x1bOD");
    expect(viewer.render(100).join("\n")).toContain("[History 0]");
  });

  it("reports deletion and returns without losing the selected row", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root);
    const file = path.join(root, ".locus-pi", "workflows", "alpha.workflow.mjs");
    rmSync(file);
    const { viewer, done } = createViewer(model, root);
    focusProject(viewer);

    viewer.handleInput("enter");
    expect(viewer.render(80).join("\n")).toContain("is no longer in the current catalog");
    viewer.handleInput("escape");
    expect(viewer.screenKind).toBe("catalog");
    expect(viewer.selectedIndex).toBe(0);
    expect(done).not.toHaveBeenCalled();
  });

  it("reports a new higher-precedence shadow instead of opening another path", () => {
    const root = emptyProject();
    const home = path.join(root, "home");
    process.env.HOME = home;
    writeWorkflow(path.join(home, ".locus-pi", "workflows"), "same", source("same", "Personal source"));
    const model = buildWorkflowCatalogModel(root, root);
    writeWorkflow(path.join(root, ".locus-pi", "workflows"), "same", source("same", "New project shadow"));
    const { viewer } = createViewer(model, root);
    viewer.handleInput("left");

    viewer.handleInput("enter");
    const rendered = viewer.render(100).join("\n");
    expect(rendered).toContain("changed precedence");
    expect(rendered).toContain("Nothing was opened");
    expect(rendered).not.toContain("New project shadow");
  });

  it("shows an explicit unreadable state", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const file = path.join(root, ".locus-pi", "workflows", "alpha.workflow.mjs");
    const model = buildWorkflowCatalogModel(root, root);
    chmodSync(file, 0o000);
    try {
      const { viewer } = createViewer(model, root);
      focusProject(viewer);
      viewer.handleInput("enter");
      expect(viewer.render(80).join("\n")).toContain("could not be read");
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it("scrolls from the first through the final source line", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `const line${index + 1} = ${index + 1};`);
    const root = projectWithWorkflows({ alpha: lines.join("\n") });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 7);
    focusProject(viewer);

    viewer.handleInput("enter");
    expect(viewer.render(80).join("\n")).toContain("const line1 = 1;");
    viewer.handleInput("end");
    const tail = viewer.render(80).join("\n");
    expect(tail).toContain("const line20 = 20;");
    expect(tail).toContain("/20");
    viewer.handleInput("home");
    expect(viewer.render(80).join("\n")).toContain("const line1 = 1;");
  });

  it("keeps source code inside a persistent top and bottom frame while scrolling", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`);
    const root = projectWithWorkflows({ alpha: lines.join("\n") });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 32);
    focusProject(viewer);

    viewer.handleInput("enter");
    const first = viewer.render(80).join("\n");
    expect(first).toContain("╭─ Code ");
    expect(first).toMatch(/╰─ 1-\d+\/40 /u);
    viewer.handleInput("end");
    const last = viewer.render(80).join("\n");
    expect(last).toContain("╭─ Code ");
    expect(last).toMatch(/╰─ \d+-40\/40 /u);
    expect(last).toContain("const line40 = 40;");
  });

  it("uses the shared purple fill for horizontal actions and semantic colors for settled metadata", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root);
    const fg = vi.fn((_color: string, text: string) => text);
    const { viewer } = createViewer(model, root, 18, { fg });

    viewer.handleInput("enter");
    expect(viewer.render(80).join("\n")).toContain("\u001b[48;2;88;61;121m\u001b[38;2;248;241;255m› [Back]\u001b[0m");
    expect(fg).toHaveBeenCalledWith("success", "[VIEW]");
    expect(fg).toHaveBeenCalledWith("success", "Source:");
    expect(fg).toHaveBeenCalledWith("success", "Catalog:");
    expect(fg).toHaveBeenCalledWith("success", "Path:");
    expect(fg).toHaveBeenCalledWith("text", "Start");
    expect(fg).not.toHaveBeenCalledWith("success", "Start");

    fg.mockClear();
    viewer.handleInput("tab");
    expect(viewer.render(80).join("\n")).toContain("\u001b[48;2;88;61;121m\u001b[38;2;248;241;255m› [Start]\u001b[0m");
    expect(fg).toHaveBeenCalledWith("text", "Back");
    expect(fg).not.toHaveBeenCalledWith("success", "Back");
  });

  it("keeps catalog and source lines bounded at wide and narrow widths", () => {
    const root = projectWithWorkflows({
      "a-very-long-workflow-name": source(
        "a-very-long-workflow-name",
        "A description long enough to overflow narrow terminals",
      ),
    });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 8);

    for (const width of [146, 80, 48, 8, 1]) {
      const lines = viewer.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain(width >= 48 ? "[SELECT]" : "[");
    }
    const narrowCatalog = viewer.render(48).join("\n");
    expect(narrowCatalog).toContain("Tab/←/→ · ↑/↓ Enter · Esc");
    viewer.handleInput("enter");
    for (const width of [146, 80, 48, 8, 1]) {
      const lines = viewer.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines).toHaveLength(5);
      expect(lines[0]).toContain(width >= 48 ? "[VIEW]" : "[");
    }
    const narrow = viewer.render(48).join("\n");
    expect(narrow).toContain("› [Back] Start Edit Review");
    expect(narrow).toContain("Tab/←/→ action");
    viewer.handleInput("i");
    const identity = viewer.render(48);
    expect(identity).toHaveLength(5);
    expect(identity[0]).toContain("[IDENTITY]");
    expect(identity.join("\n")).toContain("↑/↓ scroll · PgUp/PgDn page");
    expect(identity.join("\n")).toContain("i/Esc source · Help: /workflows info");
    expect(viewer.render(146).join("\n")).toContain("↑/↓ scroll · PgUp/PgDn page · Home/End jump");
  });

  it.each([
    [3, 1],
    [4, 1],
    [5, 2],
    [6, 3],
    [27, 24],
    [32, 29],
    [48, 45],
  ])("claims at most the %i-row terminal's %i viewer rows and pads none of them", (rows, expected) => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, rows);

    for (const width of [146, 80, 48]) {
      const lines = viewer.render(width);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(expected);
      // One workflow never fills a tall terminal: the frame must stop at its own
      // content instead of pushing the transcript into scrollback with blanks.
      expect(lines).not.toContain(" ".repeat(width));
      expect(lines.at(-1)).not.toBe("");
    }
  });

  it("also reserves the active workflow widget beneath the focused catalog", () => {
    const root = projectWithWorkflows(manyWorkflows(24));
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root, 24);

    const withoutWidget = viewer.render(80);
    setViewerExternalRows("test-workflow-catalog", 2);
    const withWidget = viewer.render(80);

    // The catalog overflows 24 rows, so both frames are clipped by geometry alone.
    expect(withoutWidget.length).toBeGreaterThan(24 - 3 - 2);
    expect(withoutWidget.length).toBeLessThanOrEqual(24 - 3);
    expect(withWidget.length).toBeLessThanOrEqual(24 - 3 - 2);
    expect(withWidget.length).toBeLessThan(withoutWidget.length);
  });

  it.each([3, 4, 5, 6])("shows the exact compact target Enter inspects at %i terminal rows", (rows) => {
    const root = projectWithWorkflows({
      alpha: source("alpha", "Alpha workflow"),
      beta: source("beta", "Beta workflow"),
    });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer, terminal } = createViewer(model, root, rows);
    focusProject(viewer);
    viewer.handleInput("down");

    const compact = viewer.render(48).join("\n");
    expect(compact).toContain("beta · [P] · Beta workflow");
    if (rows < 6) expect(compact).not.toMatch(/\b(?:Project|User|Package)\b/u);
    if (rows === 6) {
      expect(compact).toContain("[SELECT] Workflow catalog");
      expect(compact).toContain("[P 2]");
    } else if (rows === 5) {
      expect(viewer.render(48)).toHaveLength(2);
      expect(compact).toContain("[P 2]");
    } else {
      expect(viewer.render(48)).toEqual(["beta · [P] · Beta workflow"]);
    }

    viewer.handleInput("enter");
    terminal.rows = 32;
    expect(viewer.render(80).join("\n")).toContain("[VIEW] [P] beta");
  });

  it("distinguishes compact history selection from current selection", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    writeRun(root, "20260101-000001-alpha", "alpha");
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer, terminal } = createViewer(model, root, 6);
    focusProject(viewer);

    expect(viewer.render(48).join("\n")).toContain("alpha · [P] · Alpha workflow");
    viewer.handleInput("left");
    expect(viewer.render(48).join("\n")).toContain("alpha · run 20260101-000001-alpha · [P]");
    viewer.handleInput("enter");
    terminal.rows = 32;
    expect(viewer.render(80).join("\n")).toContain("[VIEW] [R] [P] alpha");
  });

  it.each([7, 8, 9])(
    "keeps the selected history target visible in the low-height fallback at %i terminal rows",
    (rows) => {
      const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
      writeRun(root, "20260101-000001-alpha", "alpha");
      const model = buildWorkflowCatalogModel(root, root);
      const { viewer } = createViewer(model, root, rows);
      focusProject(viewer);

      viewer.handleInput("left");

      const rendered = viewer.render(48).join("\n");
      expect(rendered).toContain("alpha · run 20260101-000001-alpha · [P]");
      expect(rendered).not.toContain("Current (");
      expect(rendered).not.toContain("History [R]");
    },
  );

  it.each([3, 4, 5, 6])("shows a compact no-rows state at %i terminal rows", (rows) => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root, "no-match");
    const { viewer } = createViewer(model, root, rows);

    const rendered = viewer.render(48).join("\n");
    expect(rendered).toContain("No workflow rows in this source.");
    expect(rendered).not.toContain("[C]");
    expect(rendered).not.toContain("[R:");
  });

  it("renders and exposes only Back when the source viewer has one row", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer, done, terminal } = createViewer(model, root, 32);

    viewer.handleInput("enter");
    viewer.handleInput("tab");
    expect(viewer.render(80).join("\n")).toContain("Back › [Start]");
    terminal.rows = 3;

    expect(viewer.render(48)).toEqual(["[Back] · Enter/Esc back"]);
    viewer.handleInput("tab");
    viewer.handleInput("enter");

    expect(viewer.screenKind).toBe("catalog");
    expect(done).not.toHaveBeenCalled();
  });

  it("opens a history-only query result as immutable review-only source", () => {
    const root = emptyProject();
    writeRun(root, "20260101-000001-old", "old-history");
    const model = buildWorkflowCatalogModel(root, root, "old-history");
    expect(model.current).toHaveLength(0);
    expect(model.history).toHaveLength(1);
    const { viewer } = createViewer(model, root);

    viewer.handleInput("enter");
    expect(viewer.screenKind).toBe("source");
    const rendered = viewer.render(80).join("\n");
    expect(rendered).toContain("[R] [P] old-history");
    expect(rendered).toContain("Run: 20260101-000001-old");
    expect(rendered).toContain("› [Back] Review");
    expect(rendered).not.toContain("Start");
    expect(rendered).not.toContain("Edit");
  });

  it("cycles current actions with Tab and resolves only a typed intent", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer, done } = createViewer(model, root);
    focusProject(viewer);

    viewer.handleInput("enter");
    expect(viewer.render(80).join("\n")).toContain("› [Back] Start Edit Review");
    viewer.handleInput("tab");
    expect(viewer.render(80).join("\n")).toContain("Back › [Start] Edit Review");
    viewer.handleInput("enter");

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "start",
        row: model.current[0],
        sourceState: expect.objectContaining({ kind: "ready" }),
      }),
    );
  });

  it("offers copy actions for a folder-owned Package namespace", () => {
    const root = emptyProject();
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer, done } = createViewer(model, root, 18);

    viewer.handleInput("enter");
    expect(viewer.render(120).join("\n")).toContain("› [Back] Start Edit Review Copy to Project Copy to User");
    for (let index = 0; index < 4; index += 1) viewer.handleInput("tab");
    expect(viewer.render(120).join("\n")).toContain("› [Copy to Project]");
    viewer.handleInput("enter");

    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ action: "copy-project", row: expect.objectContaining({ source: "package" }) }),
    );
  });

  it("copies a Package namespace from the TUI without filling or submitting the editor", async () => {
    const root = emptyProject();
    const harness = createHarness(root);
    harness.customInputQueue.push("enter", "tab", "tab", "tab", "tab", "enter");
    workflows(harness.pi);

    await harness.commands.get("workflows")!.handler("list", harness.ctx);

    expect(harness.widgets.get("workflows")).toContain('Copied workflow "live-smoke" to Project');
    expect(existsSync(path.join(root, ".locus-pi", "workflows", "live-smoke", "live-smoke.workflow.mjs"))).toBe(true);
    expect(harness.editorText).toBe("");
    expect(harness.sentMessages).toEqual([]);
    expect(harness.sentUserMessages).toEqual([]);
  });

  it("cycles source actions both ways with named, ANSI, and application arrow keys", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const model = buildWorkflowCatalogModel(root, root);
    const { viewer } = createViewer(model, root);
    focusProject(viewer);

    viewer.handleInput("enter");
    viewer.handleInput("left");
    expect(viewer.render(100).join("\n")).toContain("Back Start Edit › [Review]");
    viewer.handleInput("right");
    expect(viewer.render(100).join("\n")).toContain("› [Back] Start Edit Review");
    viewer.handleInput("\x1b[D");
    expect(viewer.render(100).join("\n")).toContain("Back Start Edit › [Review]");
    viewer.handleInput("\x1b[C");
    expect(viewer.render(100).join("\n")).toContain("› [Back] Start Edit Review");
    viewer.handleInput("\x1bOD");
    expect(viewer.render(100).join("\n")).toContain("Back Start Edit › [Review]");
    viewer.handleInput("\x1bOC");
    const wrapped = viewer.render(100).join("\n");
    expect(wrapped).toContain("› [Back] Start Edit Review");
    expect(wrapped).toContain("Tab/←/→ action · Enter choose · i details · Esc back");
  });

  it("allows historical Review but never Start or Edit", () => {
    const root = emptyProject();
    writeRun(root, "20260101-000001-old", "old-history");
    const model = buildWorkflowCatalogModel(root, root, "old-history");
    const { viewer, done } = createViewer(model, root);

    viewer.handleInput("enter");
    viewer.handleInput("tab");
    expect(viewer.render(80).join("\n")).toContain("Back › [Review]");
    viewer.handleInput("enter");

    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "review",
        row: model.history[0],
        sourceState: expect.objectContaining({ kind: "ready" }),
      }),
    );
  });

  it("reviews an unavailable historical snapshot without current-source substitution", () => {
    const root = emptyProject();
    writeRun(root, "20260101-000001-missing", "missing-history");
    const model = buildWorkflowCatalogModel(root, root, "missing-history");
    const snapshot = model.history[0]!.snapshot;
    if (snapshot.path !== undefined) rmSync(snapshot.path);
    const { viewer, done } = createViewer(model, root);

    viewer.handleInput("enter");
    expect(viewer.render(80).join("\n")).toContain("snapshot is missing");
    viewer.handleInput("tab");
    expect(viewer.render(80).join("\n")).toContain("Back › [Diagnose]");
    viewer.handleInput("enter");

    const intent = done.mock.calls[0]?.[0];
    expect(intent).toMatchObject({ action: "review", sourceState: { kind: "missing" } });
    expect(buildPromptFromIntent(intent)).toContain('snapshot state "missing"');
    expect(buildPromptFromIntent(intent)).toContain("diagnose why the immutable snapshot is unavailable");
    expect(buildPromptFromIntent(intent)).toContain("Skill: locus-pi-workflow-create");
    expect(buildPromptFromIntent(intent)).not.toContain("Snapshot unavailable:");
    expect(buildPromptFromIntent(intent)).toMatch(
      /^Request: .+\nSkill: locus-pi-workflow-create\n\nAdditional instructions:\n$/u,
    );
  });

  it("fails stale when a run snapshot identity changes between catalog build and inspect", () => {
    const root = emptyProject();
    const runId = "20260101-000001-replaced";
    writeRun(root, runId, "replaced-history", "// original snapshot\n");
    const model = buildWorkflowCatalogModel(root, root, "replaced-history");
    const originalSnapshot = model.history[0]!.snapshot;
    writeRun(root, runId, "replaced-history", "// replacement snapshot\n");
    const { viewer, done } = createViewer(model, root);

    viewer.handleInput("enter");
    const rendered = viewer.render(80).join("\n");
    expect(rendered).toContain("snapshot identity changed after catalog selection");
    expect(rendered).not.toContain("replacement snapshot");
    viewer.handleInput("tab");
    viewer.handleInput("enter");

    const intent = done.mock.calls[0]?.[0];
    expect(intent).toMatchObject({ action: "review", sourceState: { kind: "stale" } });
    const prompt = buildPromptFromIntent(intent);
    expect(prompt).toContain('snapshot state "stale"');
    expect(prompt).toContain(`SHA-256 ${JSON.stringify(originalSnapshot.sha256)}`);
    expect(prompt).not.toContain("Snapshot unavailable:");
  });

  it.each([8, 1])("makes the exact historical path and SHA reachable at width %i", (width) => {
    const root = emptyProject();
    writeRun(root, "20260101-000001-identity", "identity-history");
    const model = buildWorkflowCatalogModel(root, root, "identity-history");
    const history = model.history[0]!;
    const { viewer } = createViewer(model, root, 12);

    viewer.handleInput("enter");
    viewer.handleInput("i");
    const reached = collectIdentityPages(viewer, width, 160);

    expect(reached).toContain(history.sourceLocator);
    expect(reached).toContain(history.originPath);
    expect(reached).toContain(history.snapshot.sha256);
    expect(viewer.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("fills the final identity page and keeps repeated PageDown stable", () => {
    const root = emptyProject();
    writeRun(root, "20260101-000001-identity-page", "identity-history-with-a-long-name");
    const model = buildWorkflowCatalogModel(root, root, "identity-history-with-a-long-name");
    const { viewer } = createViewer(model, root, 12);
    viewer.handleInput("enter");
    viewer.handleInput("i");

    viewer.handleInput("end");
    const finalPage = viewer.render(16);
    const range = /^(\d+)-(\d+)\/(\d+)/u.exec(finalPage.at(-2) ?? "");
    expect(range).not.toBeNull();
    const first = Number(range![1]!);
    const last = Number(range![2]!);
    const total = Number(range![3]!);
    expect(last).toBe(total);
    expect(last - first + 1).toBe(6);

    viewer.handleInput("pageDown");
    expect(viewer.render(16)).toEqual(finalPage);
    viewer.handleInput("pageDown");
    expect(viewer.render(16)).toEqual(finalPage);
  });

  it("uses the rendered narrow width for PageDown without skipping source lines", () => {
    const sourceLines = Array.from({ length: 12 }, (_, index) => `// ${String(index + 1).padStart(2, "0")}`);
    const root = projectWithWorkflows({ alpha: sourceLines.join("\n") });
    const model = buildWorkflowCatalogModel(root, root, "alpha");
    const { viewer } = createViewer(model, root, 12);

    viewer.handleInput("enter");
    const before = viewer.render(8).join("\n");
    viewer.handleInput("pageDown");
    const after = viewer.render(8).join("\n");

    expect(before).toContain("// 01");
    expect(before).toContain("// 02");
    expect(after).toContain("// 02");
    expect(after).toContain("// 03");
  });

  it("fills the restored editor after Start selection without starting or sending", async () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const harness = createHarness(root);
    harness.ctx.hasUI = true;
    harness.customInputQueue.push("left", "left", "enter", "tab", "enter");
    workflows(harness.pi);

    await harness.commands.get("workflows")!.handler("list", harness.ctx);

    expect(harness.editorText).toBe("/workflows run alpha");
    expect(harness.sentMessages).toEqual([]);
    expect(harness.sentUserMessages).toEqual([]);
    expect(existsSync(path.join(root, ".locus-pi", "runs"))).toBe(false);
  });

  it("never calls setEditorText before the custom browser promise resolves", async () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const harness = createHarness(root);
    const row = buildWorkflowCatalogModel(root, root).current[0]!;
    let resolveCustom: ((value: unknown) => void) | undefined;
    const editor = vi.fn();
    harness.ctx.ui.setEditorText = editor;
    harness.ctx.ui.custom = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCustom = resolve;
        }),
    ) as NonNullable<typeof harness.ctx.ui.custom>;
    workflows(harness.pi);

    const pending = harness.commands.get("workflows")!.handler("list", harness.ctx);
    await Promise.resolve();
    expect(editor).not.toHaveBeenCalled();
    resolveCustom?.({
      action: "review",
      row,
      sourceState: { kind: "ready", row, path: row.target.path, source: "source" },
    });
    await pending;

    expect(editor).toHaveBeenCalledOnce();
    expect(editor.mock.calls[0]?.[0]).toContain("Request: Review the exact current workflow at");
    expect(editor.mock.calls[0]?.[0]).toContain("Skill: locus-pi-workflow-create");
  });

  it("keeps cancel, custom rejection, and missing editor support fail-closed", async () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const cancel = createHarness(root);
    cancel.customInputQueue.push("escape");
    const cancelEditor = vi.fn();
    cancel.ctx.ui.setEditorText = cancelEditor;
    workflows(cancel.pi);
    await cancel.commands.get("workflows")!.handler("list", cancel.ctx);
    expect(cancelEditor).not.toHaveBeenCalled();

    const rejected = createHarness(root);
    const rejectedEditor = vi.fn();
    rejected.ctx.ui.setEditorText = rejectedEditor;
    rejected.ctx.ui.custom = vi.fn(async () => {
      throw new Error("closed");
    });
    workflows(rejected.pi);
    await rejected.commands.get("workflows")!.handler("list", rejected.ctx);
    expect(rejectedEditor).not.toHaveBeenCalled();
    expect(rejected.widgets.get("workflows")).toContain("No editor text was changed and no workflow was started");

    const missingSetter = createHarness(root);
    missingSetter.customInputQueue.push("enter", "tab", "enter");
    delete missingSetter.ctx.ui.setEditorText;
    workflows(missingSetter.pi);
    await missingSetter.commands.get("workflows")!.handler("list", missingSetter.ctx);
    expect(missingSetter.widgets.get("workflows")).toContain("expose setEditorText().");
    expect(missingSetter.sentMessages).toEqual([]);

    const throwingSetter = createHarness(root);
    throwingSetter.customInputQueue.push("enter", "tab", "enter");
    throwingSetter.ctx.ui.setEditorText = vi.fn(() => {
      throw new Error("setter failed");
    });
    workflows(throwingSetter.pi);
    await throwingSetter.commands.get("workflows")!.handler("list", throwingSetter.ctx);
    expect(throwingSetter.widgets.get("workflows")).toContain("setter failed");
    expect(throwingSetter.sentMessages).toEqual([]);
  });

  it("routes TUI /workflows info through custom UI after clearing the transient widget", async () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const harness = createHarness(root);
    const lifecycle: string[] = [];
    const originalSetWidget = harness.ctx.ui.setWidget.bind(harness.ctx.ui);
    harness.ctx.ui.setWidget = ((key, content, options) => {
      if (key === "workflows" && content === undefined) lifecycle.push("clear");
      originalSetWidget(key, content, options);
    }) as typeof harness.ctx.ui.setWidget;
    const originalCustom = harness.ctx.ui.custom!;
    harness.ctx.ui.custom = (async (factory, options) => {
      lifecycle.push("custom");
      return originalCustom(factory, options);
    }) as NonNullable<typeof harness.ctx.ui.custom>;
    const setEditorText = vi.fn();
    harness.ctx.ui.setEditorText = setEditorText;
    harness.customInputQueue.push("escape");
    workflows(harness.pi);

    await harness.commands.get("workflows")!.handler("info alpha", harness.ctx);

    expect(lifecycle).toEqual(["clear", "custom"]);
    expect(harness.customComponents).toHaveLength(1);
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("[VIEW] Workflow info: alpha");
    expect(harness.widgets.get("workflows")).toBe("");
    expect(setEditorText).not.toHaveBeenCalled();
    expect(harness.sentMessages).toEqual([]);
    expect(harness.sentUserMessages).toEqual([]);
    expect(existsSync(path.join(root, ".locus-pi", "runs"))).toBe(false);
  });

  it.each(["rpc", "print"] as const)("keeps %s passive even if a host object exposes custom UI", async (mode) => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const harness = createHarness(root, { mode });
    const custom = vi.fn(async () => undefined);
    harness.ctx.ui.custom = custom as NonNullable<typeof harness.ctx.ui.custom>;
    const setEditorText = vi.fn();
    harness.ctx.ui.setEditorText = setEditorText;
    workflows(harness.pi);

    await harness.commands.get("workflows")!.handler("info alpha", harness.ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(harness.widgets.get("workflows")).toContain("[VIEW] Workflow info: alpha");
    expect(setEditorText).not.toHaveBeenCalled();
    expect(harness.sentMessages).toEqual([]);
  });

  it("does not open custom info UI when the TUI declares no UI", async () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const harness = createHarness(root);
    harness.ctx.hasUI = false;
    const custom = vi.fn(async () => undefined);
    harness.ctx.ui.custom = custom as NonNullable<typeof harness.ctx.ui.custom>;
    workflows(harness.pi);

    await harness.commands.get("workflows")!.handler("info alpha", harness.ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(harness.widgetPayloads.get("workflows")).toBeUndefined();
    expect(harness.widgets.get("workflows")).toBe("");
  });

  it("renders an honest passive fallback when TUI custom UI is missing", async () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const harness = createHarness(root);
    harness.ctx.hasUI = true;
    delete harness.ctx.ui.custom;
    workflows(harness.pi);

    await harness.commands.get("workflows")!.handler("info alpha", harness.ctx);

    const rendered = harness.widgets.get("workflows") ?? "";
    expect(rendered).toContain("[VIEW] Workflow info: alpha");
    expect(rendered).toContain("Interactive workflow info unavailable");
    expect(rendered).toContain("Read-only fallback shown");
  });
});

describe("workflow info viewer", () => {
  it.each([146, 80, 48])("makes every bare and named operator line reachable at width %i", (width) => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    for (const block of [buildWorkflowInfoBlock(root, root), buildWorkflowInfoBlock(root, root, "alpha")]) {
      const { viewer } = createInfoViewer(block, 12);
      const expected = renderOperatorBlock(block, width, {});
      const reached = collectInfoLines(viewer, width, expected.length + 8);
      expect(expected.every((line) => reached.has(line))).toBe(true);
      expect([...reached].join("\n")).not.toContain("hidden)");
      const semantic = block.body?.join("\n") ?? "";
      for (const label of ["trust:", "history:", "agent models:", "agents:", "DSL:", "resolver:"]) {
        expect(semantic).toContain(label);
      }
      if (block.subject.endsWith(": alpha")) {
        expect(semantic).toContain("source locator: .locus-pi/workflows/alpha.workflow.mjs");
        expect(semantic).not.toContain(root);
      }
    }
  });

  it("keeps End and repeated PageDown on the same filled final page", () => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const block = buildWorkflowInfoBlock(root, root, "alpha");
    const { viewer } = createInfoViewer(block, 12);

    viewer.handleInput("end");
    const finalPage = viewer.render(48);
    const range = /^(\d+)-(\d+)\/(\d+)/u.exec(finalPage.at(-1) ?? "");
    expect(range).not.toBeNull();
    expect(Number(range![2]!)).toBe(Number(range![3]!));
    expect(Number(range![2]!) - Number(range![1]!) + 1).toBe(8);
    viewer.handleInput("pageDown");
    expect(viewer.render(48)).toEqual(finalPage);
    viewer.handleInput("pageDown");
    expect(viewer.render(48)).toEqual(finalPage);
  });

  it.each([
    [3, 1],
    [4, 1],
    [5, 2],
    [6, 3],
    [32, 29],
  ])("stays bounded at terminal rows %i", (rows, expectedRows) => {
    const root = projectWithWorkflows({ alpha: source("alpha", "Alpha workflow") });
    const { viewer } = createInfoViewer(buildWorkflowInfoBlock(root, root), rows);
    for (const width of [146, 80, 48, 8, 1]) {
      const lines = viewer.render(width);
      expect(lines).toHaveLength(expectedRows);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("renders unknown named warnings completely and closes with q", () => {
    const root = emptyProject();
    const block = buildWorkflowInfoBlock(root, root, "unknown");
    const { viewer, done } = createInfoViewer(block, 12);
    const expected = renderOperatorBlock(block, 48, {});
    const reached = collectInfoLines(viewer, 48, expected.length + 4);

    expect(expected.every((line) => reached.has(line))).toBe(true);
    expect([...reached].join("\n")).toContain("Unknown current workflow");
    viewer.handleInput("q");
    expect(done).toHaveBeenCalledOnce();
  });
});

function createViewer(
  model: ReturnType<typeof buildWorkflowCatalogModel>,
  root: string,
  rows = 12,
  theme: unknown = {},
) {
  const done = vi.fn();
  const terminal = { rows, columns: 100 };
  const viewer = new WorkflowCatalogViewer({ requestRender: vi.fn(), terminal }, theme, {}, model, root, root, done);
  return { viewer, done, terminal };
}

function createInfoViewer(block: OperatorBlock, rows = 12) {
  const done = vi.fn();
  const terminal = { rows, columns: 100 };
  const viewer = new WorkflowInfoViewer({ requestRender: vi.fn(), terminal }, {}, {}, block, done);
  return { viewer, done, terminal };
}

function focusProject(viewer: WorkflowCatalogViewer): void {
  viewer.handleInput("left");
  viewer.handleInput("left");
}

function collectInfoLines(viewer: WorkflowInfoViewer, width: number, pages: number): Set<string> {
  const reached = new Set<string>();
  viewer.handleInput("home");
  for (let index = 0; index < pages; index += 1) {
    const frame = viewer.render(width);
    for (const line of frame.slice(0, -1)) reached.add(line);
    const before = frame.join("\n");
    viewer.handleInput("pageDown");
    if (viewer.render(width).join("\n") === before) break;
  }
  return reached;
}

function projectWithWorkflows(files: Record<string, string>): string {
  const root = emptyProject();
  for (const [name, content] of Object.entries(files)) {
    writeWorkflow(path.join(root, ".locus-pi", "workflows"), name, content);
  }
  return root;
}

function emptyProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-catalog-viewer-"));
  roots.push(root);
  process.env.HOME = path.join(root, "home");
  return root;
}

function writeWorkflow(directory: string, name: string, content: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.workflow.mjs`), content, "utf8");
}

function manyWorkflows(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_unused, index) => {
      const name = `wf-${String(index).padStart(2, "0")}`;
      return [name, source(name, `Workflow ${index}`)];
    }),
  );
}

function source(name: string, description: string): string {
  return [
    `export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)} };`,
    "export default async function run() { return { ok: true }; }",
  ].join("\n");
}

function writeRun(
  root: string,
  runId: string,
  name: string,
  executedSource = `export default () => ${JSON.stringify(runId)};\n`,
): void {
  const runDir = ensureWorkflowRunDir(root, runId);
  writeFileSync(workflowJournalFile(runDir), "", "utf8");
  const sha256 = createHash("sha256").update(executedSource).digest("hex");
  const snapshotPath = path.join(workflowRunRuntimeDir(runDir), `script-${sha256}.workflow.mjs`);
  writeFileSync(snapshotPath, executedSource, "utf8");
  writeFileSync(
    workflowResultFile(runDir),
    JSON.stringify({
      runId,
      ok: true,
      result: null,
      target: { kind: "name", ref: name, source: "project" },
      scriptIdentity: {
        schemaVersion: 2,
        identityPolicy: "static-node-only-v1",
        sourcePath: path.join(root, ".locus-pi", "workflows", `${name}.workflow.mjs`),
        snapshotPath,
        scriptSha256: sha256,
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        builtinImports: [],
        unboundDependencies: [],
      },
    }),
    "utf8",
  );
}

function collectIdentityPages(viewer: WorkflowCatalogViewer, width: number, pages: number): string {
  let text = "";
  for (let index = 0; index < pages; index += 1) {
    text += viewer.render(width).slice(1, -2).join("").replace(/\s/gu, "");
    viewer.handleInput("pageDown");
  }
  return text;
}

function buildPromptFromIntent(intent: unknown): string {
  return buildWorkflowActionPrompt(intent as Parameters<typeof buildWorkflowActionPrompt>[0]);
}
