import { expect, it } from "vitest";
import type { CustomUiComponent, CustomUiFactory } from "../../../../../extensions/_shared/host/pi-api.js";
import { setOperatorWidget } from "../../../../../extensions/_shared/operator/widget-render.js";
import {
  workflowBackgroundFailureBlock,
  workflowWarningBlock,
} from "../../../../../extensions/workflows/operator/operator-ui.js";
import { emit } from "../../../../test-harness.js";
import { setup } from "./fixture.js";

it.each(["Escape", "viewer rejection", "session shutdown", "widget cleanup"])(
  "does not restore the Doctor widget after %s takes it out of use",
  async (end) => {
    const f = setup("tui");
    const ui = f.harness.ctx.ui;
    const tui = { terminal: { columns: 60, rows: 16 }, requestRender() {} };
    let widget: CustomUiComponent | undefined;
    let viewer: CustomUiComponent | undefined;
    let rejectViewer!: (error: Error) => void;
    ui.setWidget = (key, content) => {
      if (key !== "workflows") return;
      // Pi disposes the existing component for both replacement and removal.
      widget?.dispose?.();
      widget = typeof content === "function" ? (content(tui, {}) as CustomUiComponent) : undefined;
      widget?.render(60);
    };
    ui.custom = <T>(factory: CustomUiFactory<T>) =>
      new Promise<T>((resolve, reject) => {
        rejectViewer = reject;
        void Promise.resolve(factory(tui, {}, {}, resolve)).then((component) => {
          viewer = component;
        }, reject);
      });

    await f.run("doctor");
    await expect.poll(() => viewer?.render(60).join(" ")).toContain("External hosts");

    const newerWarning = "Late fault";
    if (end === "widget cleanup") ui.setWidget("workflows", undefined);
    else if (end === "session shutdown") await emit(f.harness, "session_shutdown");
    else {
      const warning =
        end === "Escape"
          ? workflowBackgroundFailureBlock(new Error(newerWarning))
          : workflowWarningBlock(newerWarning, "Inspect: /workflows status");
      setOperatorWidget(f.harness.ctx, "workflows", warning);
      expect(widget?.render(60).join(" ")).toContain(newerWarning);
    }
    const current = widget;
    if (end === "viewer rejection") rejectViewer(new Error("Viewer rejected"));
    else await viewer?.handleInput?.("\x1b");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(widget, "the shared widget slot should keep its current presentation").toBe(current);
    if (end === "Escape" || end === "viewer rejection") expect(widget?.render(60).join(" ")).toContain(newerWarning);
    if (end === "session shutdown") expect(widget?.render(60) ?? []).toEqual([]);
    if (end === "viewer rejection") expect(f.harness.notifications.join(" ")).toContain("External hosts");
  },
);
