import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The proof T-135 W4 owes for moving `fleet-menu.ts` into `extensions/_shared/agent-runtime/`.
 *
 * `check:layers` rule 4 asserts STATICALLY that exactly one module names
 * `Symbol.for("locus-pi.fleet-menu-state.v3")` and the active-viewer companion
 * `Symbol.for("locus-pi.fleet-viewed-row.v1")`. That is a source-level count, and it stays green
 * for a relocation that breaks the runtime: Pi loads each registered entrypoint with the module
 * cache disabled, so `extensions/agents/index.ts` and `extensions/workflows/index.ts` each hold
 * their OWN instance of `fleet-menu.ts`. A same-process test that pokes `globalThis` proves
 * nothing about that, because the failure mode is per-entrypoint module instances, not
 * per-process state. Sibling registries already carry this proof
 * (`agent-live-store-entrypoints.test.ts`, `workflow-live-executions-entrypoints.test.ts`); this
 * registry had none, and the move is when it is owed.
 *
 * So this test loads two separately registered entrypoints through the real
 * `discoverAndLoadExtensions` and drives the state ACROSS them, in both directions:
 *
 *   - Both sides subscribe to `fleetMenuState.emitter` FIRST. Each side must then receive the
 *     other side's mutations, not only its own. Two copies give each listener a count of 1
 *     instead of 2, and no assertion about a single side's own bookkeeping can see that.
 *   - The producer opens and focuses the menu; the consumer must read back the producer's
 *     `focused`, `selectedRowId` and visible-row projection.
 *   - The consumer then runs the exact close sequence of
 *     `extensions/agents/fleet/fleet-menu-controller.ts` (`setFocused(false)` + `setVisibleRows([])`)
 *     on state it did not open, and the producer must observe the release.
 *
 * Why the cross-release is the sharp assertion: `extensions/agents/fleet/interrupt-guard.ts:30` reads
 * `fleetMenuState.focused` to decide whether to swallow an interrupt. With two copies, a menu
 * focused through one entrypoint is invisible to the guard living in the other, and a release
 * performed by a peer is a SILENT no-op — the peer keeps believing it holds focus. That is
 * exactly the class of breakage a static owner count cannot see.
 */
describe("fleet menu state across Pi entrypoints", () => {
  it("shares one state object and one change emitter across real moduleCache:false entrypoints", () => {
    const producerPath = path.resolve("tests/fixtures/extensions/fleet-menu-producer.ts");
    const consumerPath = path.resolve("tests/fixtures/extensions/fleet-menu-consumer.ts");
    const harnessUrl = pathToFileURL(path.resolve("tests/test-harness.ts")).href;
    const script = `
const runtimeGlobal = globalThis;
const registryKey = Symbol.for("locus-pi.fleet-menu-state.v3");
const viewedRowRegistryKey = Symbol.for("locus-pi.fleet-viewed-row.v1");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;
const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
const { createHarness } = await import(${JSON.stringify(harnessUrl)});
const producerPath = ${JSON.stringify(producerPath)};
const consumerPath = ${JSON.stringify(consumerPath)};
const harness = createHarness();
const check = (condition, message) => { if (!condition) throw new Error(message); };
const loadEntrypoints = async () => {
  const loaded = await discoverAndLoadExtensions(
    [producerPath, consumerPath],
    process.cwd(),
    mkdtempSync(path.join(tmpdir(), "locus-pi-empty-fleet-dir-")),
  );
  check(loaded.errors.length === 0, "loader errors: " + JSON.stringify(loaded.errors));
  return loaded;
};
const command = (loaded, extensionPath, name) => {
  const handler = loaded.extensions.find((extension) => extension.resolvedPath === extensionPath)?.commands.get(name)?.handler;
  check(typeof handler === "function", "missing " + name);
  return handler;
};

// No slot exists until a fleet-menu module is loaded — the registry is created on import.
check(runtimeGlobal[registryKey] === undefined, "registry slot existed before any entrypoint ran");
check(runtimeGlobal[viewedRowRegistryKey] === undefined, "viewed-row registry slot existed before any entrypoint ran");

const firstLoad = await loadEntrypoints();
const firstSlot = runtimeGlobal[registryKey];
const firstViewedRowSlot = runtimeGlobal[viewedRowRegistryKey];
check(firstSlot?.version === 3 && firstSlot.state !== undefined, "first fleet-menu slot missing");
check(firstViewedRowSlot?.version === 1, "first fleet-viewed-row slot missing");
const firstState = firstSlot.state;
const descriptor = Object.getOwnPropertyDescriptor(runtimeGlobal, registryKey);
const viewedRowDescriptor = Object.getOwnPropertyDescriptor(runtimeGlobal, viewedRowRegistryKey);

// Both sides subscribe BEFORE either mutates, so each listener is in place for the peer's change.
await command(firstLoad, producerPath, "test-fleet-producer-listen")("", harness.ctx);
await command(firstLoad, consumerPath, "test-fleet-consumer-listen")("", harness.ctx);

// The producer opens and focuses the menu. Two emits: fallback-focus flag, then focused.
await command(firstLoad, producerPath, "test-fleet-producer-focus")("", harness.ctx);
// The consumer reads back state it never wrote. Captured immediately: the reloaded instance
// below writes the same widget key, and a later read would silently return that one instead.
await command(firstLoad, consumerPath, "test-fleet-consumer-observe")("", harness.ctx);
const consumerObserved = harness.widgets.get("fleet-consumer-observe");

// The consumer releases focus it never took. One more emit: focused true -> false.
await command(firstLoad, consumerPath, "test-fleet-consumer-release")("", harness.ctx);
// The producer must see the peer's release, and its listener must have received every emit.
await command(firstLoad, producerPath, "test-fleet-producer-observe")("", harness.ctx);
const producerObserved = harness.widgets.get("fleet-producer-observe");

// The producer opens a transcript row; the independently loaded consumer must see the same
// row so its lower roster can collapse to the one agent being inspected.
await command(firstLoad, producerPath, "test-fleet-producer-view-row")("", harness.ctx);
await command(firstLoad, consumerPath, "test-fleet-consumer-viewed-row")("", harness.ctx);
const consumerViewedRow = harness.widgets.get("fleet-consumer-viewed-row");

// A second discovery pass must adopt the same slot and the same state object.
const secondLoad = await loadEntrypoints();
const secondSlot = runtimeGlobal[registryKey];
const secondViewedRowSlot = runtimeGlobal[viewedRowRegistryKey];
await command(secondLoad, consumerPath, "test-fleet-consumer-observe")("", harness.ctx);
const reloadedConsumerObserved = harness.widgets.get("fleet-consumer-observe");
await command(secondLoad, consumerPath, "test-fleet-consumer-viewed-row")("", harness.ctx);
const reloadedConsumerViewedRow = harness.widgets.get("fleet-consumer-viewed-row");

process.stdout.write(JSON.stringify({
  ok: true,
  loads: 2,
  // Before any mutation both sides agree the menu is unfocused with no events yet.
  producerListen: harness.widgets.get("fleet-producer-listen"),
  consumerListen: harness.widgets.get("fleet-consumer-listen"),
  // The producer's own view right after it focused.
  producerFocus: harness.widgets.get("fleet-producer-focus"),
  // The consumer sees the producer's focus, selection and row — one state object, one store.
  consumerObserved,
  // The peer's close released the producer's focus and cleared its visible rows.
  consumerReleased: harness.widgets.get("fleet-consumer-release"),
  // The emitter proof: the producer's listener received the peer's emit too.
  producerObserved,
  consumerViewedRow,
  // A freshly loaded module instance adopts the existing state rather than a blank one.
  reloadedConsumerObserved,
  reloadedConsumerViewedRow,
  sameSlot: secondSlot === firstSlot,
  sameState: secondSlot?.state === firstState,
  sameViewedRowSlot: secondViewedRowSlot === firstViewedRowSlot,
  slotConfigurable: descriptor?.configurable,
  slotWritable: descriptor?.writable,
  viewedRowSlotConfigurable: viewedRowDescriptor?.configurable,
  viewedRowSlotWritable: viewedRowDescriptor?.writable,
}) + "\\n");
`;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const proof = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

    expect(proof).toEqual({
      ok: true,
      loads: 2,
      producerListen: "focused=false\nchanges=0",
      consumerListen: "focused=false\nchanges=0",
      producerFocus: "focused=true\nselected=fleet-producer-row",
      // Only possible on one shared state object: the consumer never opened a row, never
      // focused, and never set the fallback shortcut flag, yet it reads all three back.
      // changes=2 — both of the producer's emits reached the CONSUMER's listener.
      consumerObserved: "focused=true\nselected=fleet-producer-row\nvisible=1\nfallbackFocus=true\nchanges=2",
      consumerReleased: "focused=false\nvisible=0",
      // changes=3 — its own two emits AND the consumer's release emit reached this listener.
      producerObserved: "focused=false\nselected=undefined\nvisible=0\nfallbackFocus=true\nchanges=3",
      consumerViewedRow: "viewed=fleet-producer-row",
      // The reloaded consumer instance reads the released state and the still-true fallback
      // flag out of the shared slot. Its own `changes` counter is 0 because a module-level
      // `let` does NOT survive cache-disabled reloading and its listener was never
      // reattached — which is precisely why this state lives in a registry and not a module.
      reloadedConsumerObserved: "focused=false\nselected=undefined\nvisible=0\nfallbackFocus=true\nchanges=0",
      reloadedConsumerViewedRow: "viewed=fleet-producer-row",
      sameSlot: true,
      sameState: true,
      sameViewedRowSlot: true,
      // The module installs the slot non-configurable and non-writable, so nothing can swap the
      // fleet state out from under a focused menu.
      slotConfigurable: false,
      slotWritable: false,
      viewedRowSlotConfigurable: false,
      viewedRowSlotWritable: false,
    });
  }, 30_000);
});
