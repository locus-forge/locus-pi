import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  clearAllOperatorStatuses,
  clearOperatorStatus,
  OPERATOR_STATUS_KEY,
  renderOperatorStatus,
  setOperatorStatus,
  type OperatorStatusContribution,
} from "../../extensions/_shared/operator/operator-status.js";
import type { ExtensionCommandContext } from "../../extensions/_shared/host/pi-api.js";
import { createHarness } from "../test-harness.js";

describe("operator status projection", () => {
  it("orders lane, descending priority, then id deterministically", () => {
    const ordering = [
      status("secondary.count", "secondary", 100, "S"),
      status("route.default", "route", 100, "R"),
      status("activity.low", "activity", 4, "A4"),
      status("activity.z", "activity", 8, "AZ"),
      status("activity.a", "activity", 8, "AA"),
      status("warning.blocked", "blocking", 1, "B"),
    ];
    expect(renderOperatorStatus(ordering, 146)).toBe("B · AA · AZ · A4 · R · S");
  });

  it("selects wide, compact, and narrow projections at the contract breakpoints", () => {
    const contribution = status("goal.mode", "route", 1, "wide mode", "compact", "narrow");

    expect(renderOperatorStatus([contribution], 146)).toBe("wide mode");
    expect(renderOperatorStatus([contribution], 80)).toBe("compact");
    expect(renderOperatorStatus([contribution], 48)).toBe("narrow");
  });

  it("drops lower-priority contributions whole before truncating the primary token", () => {
    const blocking = status("security.block", "blocking", 1, "blocked: credentials required");
    const activity = status("workflow.run", "activity", 100, "running: repository indexing");

    expect(renderOperatorStatus([activity, blocking], 146)).toBe("blocked: credentials required");

    const longAnsiPrimary = status(
      "security.long",
      "blocking",
      1,
      `\u001b[31m${"blocking recovery required ".repeat(4)}\u001b[0m`,
      "compact",
      "narrow",
    );
    const rendered = renderOperatorStatus([longAnsiPrimary, activity], 146);
    expect(rendered).toBeDefined();
    expect(visibleWidth(rendered ?? "")).toBeLessThanOrEqual(48);
    expect(rendered).not.toContain("repository indexing");
  });

  it("never exceeds the Locus budget or a smaller terminal width", () => {
    const long = status("goal.long", "blocking", 1, "x".repeat(100), "x".repeat(100), "x".repeat(100));

    expect(visibleWidth(renderOperatorStatus([long], 146) ?? "")).toBeLessThanOrEqual(48);
    expect(visibleWidth(renderOperatorStatus([long], 80) ?? "")).toBeLessThanOrEqual(28);
    expect(visibleWidth(renderOperatorStatus([long], 48) ?? "")).toBeLessThanOrEqual(16);
    expect(visibleWidth(renderOperatorStatus([long], 8) ?? "")).toBeLessThanOrEqual(8);
    expect(renderOperatorStatus([long], 0)).toBeUndefined();
  });

  it("keeps truncated status data free of terminal control sequences", () => {
    const routes = status(
      "model.roles",
      "route",
      60,
      "routes DEFAULT=gpt-5.3-codex SMOL=deepseek-v4-flash",
      "routes D:gpt-5.3-codex M:deepseek-v4-flash",
      "routes 2",
    );
    const rendered = renderOperatorStatus([routes], 80);

    expect(rendered).toBe("routes D:gpt-5.3-codex M:...");
    expect(rendered).not.toContain("\u001b");
  });

  it("strips ANSI styling from a short contribution before the width decision", () => {
    const styled = status("security.block", "blocking", 1, "\u001b[31mERR\u001b[0m");
    const rendered = renderOperatorStatus([styled], 146);

    expect(rendered).toBe("ERR");
    expect(rendered).not.toContain("\u001b");
    expect(visibleWidth(rendered ?? "")).toBeLessThanOrEqual(48);
  });
});

describe("operator status host registry", () => {
  it("updates, clears, and aggregates through the single locus host key", () => {
    const h = createHarness();
    setOperatorStatus(h.ctx, status("workflow.route", "route", 1, "route: review"), 146);
    setOperatorStatus(h.ctx, status("goal.activity", "activity", 1, "run: goal"), 146);

    expect([...h.statuses.keys()]).toEqual([OPERATOR_STATUS_KEY]);
    expect(h.statuses.get(OPERATOR_STATUS_KEY)).toBe("run: goal · route: review");

    setOperatorStatus(h.ctx, status("workflow.route", "route", 1, "route: build"), 146);
    expect(h.statuses.get(OPERATOR_STATUS_KEY)).toBe("run: goal · route: build");

    clearOperatorStatus(h.ctx, "goal.activity", 146);
    expect(h.statuses.get(OPERATOR_STATUS_KEY)).toBe("route: build");

    clearAllOperatorStatuses(h.ctx);
    expect(h.statuses.has(OPERATOR_STATUS_KEY)).toBe(false);
  });

  it("isolates contributions by ctx.ui", () => {
    const first = createHarness();
    const second = createHarness();

    setOperatorStatus(first.ctx, status("first.route", "route", 1, "first"), 146);
    setOperatorStatus(second.ctx, status("second.route", "route", 1, "second"), 146);

    expect(first.statuses.get(OPERATOR_STATUS_KEY)).toBe("first");
    expect(second.statuses.get(OPERATOR_STATUS_KEY)).toBe("second");

    clearAllOperatorStatuses(first.ctx);
    expect(first.statuses.has(OPERATOR_STATUS_KEY)).toBe(false);
    expect(second.statuses.get(OPERATOR_STATUS_KEY)).toBe("second");
    clearAllOperatorStatuses(second.ctx);
  });

  it("styles only the toned contribution in TUI while keeping the plain projection ANSI-free", () => {
    const h = createHarness(process.cwd(), {
      theme: {
        fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
        bg: (_tone: string, text: string) => text,
        bold: (text: string) => text,
      },
    });
    const activity = status("workflow.activity", "activity", 1, "workflow running");
    const plan = status("plan.mode", "route", 1, "MODE PLAN", "MODE plan", "PLAN", "warning");

    setOperatorStatus(h.ctx, activity, 146);
    setOperatorStatus(h.ctx, plan, 146);

    expect(h.statuses.get(OPERATOR_STATUS_KEY)).toBe("workflow running · <warning>MODE PLAN</warning>");
    expect(renderOperatorStatus([activity, plan], 146)).toBe("workflow running · MODE PLAN");
    clearAllOperatorStatuses(h.ctx);
  });

  it("shares one host scope across fresh Pi entrypoint module caches", async () => {
    const producerPath = path.resolve("tests/fixtures/extensions/operator-status-producer.ts");
    const consumerPath = path.resolve("tests/fixtures/extensions/operator-status-consumer.ts");
    const loaded = await discoverAndLoadExtensions(
      [producerPath, consumerPath],
      process.cwd(),
      mkdtempSync(path.join(tmpdir(), "locus-pi-empty-agent-dir-")),
    );
    expect(loaded.errors).toEqual([]);
    const producer = loaded.extensions.find((extension) => extension.resolvedPath === producerPath);
    const consumer = loaded.extensions.find((extension) => extension.resolvedPath === consumerPath);
    const produce = producer?.commands.get("test-produce-operator-status")?.handler as unknown as
      ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
    const consume = consumer?.commands.get("test-consume-operator-status")?.handler as unknown as
      ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
    const h = createHarness();

    expect(produce).toBeDefined();
    expect(consume).toBeDefined();
    await produce?.("", h.ctx);
    await consume?.("", h.ctx);

    expect([...h.statuses.keys()]).toEqual([OPERATOR_STATUS_KEY]);
    expect(h.statuses.get(OPERATOR_STATUS_KEY)).toBe("run: goal review · route: plan-build-review");
    clearAllOperatorStatuses(h.ctx);
  });

  it("fails explicitly when the versioned global slot is incompatible", () => {
    const symbol = Symbol.for("locus-pi.operator-status.v1");
    const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
    const previous = globalRecord[symbol];
    const h = createHarness();

    try {
      globalRecord[symbol] = { version: 2, byUi: new WeakMap() };
      expect(() => setOperatorStatus(h.ctx, status("goal.mode", "route", 1, "goal"), 146)).toThrow(
        /Incompatible global operator status registry/,
      );
    } finally {
      if (previous === undefined) delete globalRecord[symbol];
      else globalRecord[symbol] = previous;
    }
  });
});

function status(
  id: string,
  lane: OperatorStatusContribution["lane"],
  priority: number,
  wide: string,
  compact = wide,
  narrow = compact,
  tone?: OperatorStatusContribution["tone"],
): OperatorStatusContribution {
  return { id, lane, priority, wide, compact, narrow, ...(tone === undefined ? {} : { tone }) };
}
