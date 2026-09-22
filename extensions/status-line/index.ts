import type { ExtensionAPI, ExtensionContext } from "../_shared/host/pi-api.js";
import { LocusFooterComponent, type CompactionDisplayState } from "./footer.js";

export default function statusLine(pi: ExtensionAPI): void {
  let component: LocusFooterComponent | undefined;
  let state: CompactionDisplayState = { kind: "idle" };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || ctx.ui.setFooter === undefined) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      component?.dispose();
      component = new LocusFooterComponent(tui, theme, ctx, footerData);
      component.setCompaction(state);
      return component;
    });
  });

  pi.on("session_before_compact", () => {
    state = { kind: "compacting" };
    component?.setCompaction(state);
  });

  pi.on("session_compact", (event) => {
    const entry = isRecord(event.compactionEntry) ? event.compactionEntry : undefined;
    const tokensBefore = numericField(entry, "tokensBefore");
    state = { kind: "compacted", ...(tokensBefore === undefined ? {} : { tokensBefore }), completedAt: Date.now() };
    component?.setCompaction(state);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    component?.dispose();
    component = undefined;
    ctx.ui.setFooter?.(undefined);
  });
}

function numericField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
