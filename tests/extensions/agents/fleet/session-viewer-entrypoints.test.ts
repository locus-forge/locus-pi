import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The cross-entrypoint proof `Symbol.for("locus-pi.active-agent-session-viewers.v1")` never got.
 *
 * Five of the seven declared process-global registries carry one of these; two did not, because
 * the rule for writing them was keyed on "the slice that moves the registry" and this one's owner,
 * `extensions/agents/fleet/session-viewer.ts`, never moved. Its two consumers also both sit inside the
 * agents extension, which makes it look like single-instance state. It is not: Pi loads every
 * registered entrypoint with the module cache disabled, and Pi reload re-runs discovery in a
 * live process, so more than one instance of `session-viewer.ts` exists at once and each one would
 * get its own viewer set if the registry were a module binding.
 *
 * `check:layers` rule 4 asserts STATICALLY that exactly one module names the symbol. That is a
 * source-level count and it stays green for a change that keeps the `Symbol.for` line and returns
 * a module-local `Set` from `activeSessionViewers()` — the exact shape a careless edit produces.
 * A same-process test that pokes `globalThis` cannot see it either, because the failure mode is
 * per-module-instance state, not per-process state.
 *
 * So this test loads two separately registered entrypoints through the real
 * `discoverAndLoadExtensions` and drives the registry ACROSS them, in both directions:
 *
 *   - The producer opens an `AgentSessionViewer`; the consumer, which opened nothing, must read
 *     `hasActiveAgentSessionViewer() === true`. That predicate is what
 *     `extensions/agents/fleet/interrupt-guard.ts:30` consults to decide whether to swallow an
 *     interrupt, so with two sets a viewer that owns the terminal and Escape is invisible to the
 *     guard living in the other instance.
 *   - The consumer then runs the teardown of `extensions/agents/index.ts:37`
 *     (`disposeAgentSessionViewers()`) against a viewer it did not create, and the producer must
 *     observe its own viewer torn down — `render()` returns no lines only once `#disposed` is set.
 *     With two sets that call is a silent no-op: the TUI component and its
 *     `agentLiveStore.emitter` "change" subscription leak, and the peer keeps believing it holds
 *     the terminal.
 *   - Then the reverse: the consumer opens, the producer disposes. One slot is not enough; the
 *     authority has to run both ways.
 *   - `done` stays false on both sides throughout. `dispose()` must not invoke the owner's close
 *     callback — only `#close()` does — so a peer teardown may not re-enter the owning
 *     extension's exit path.
 */
describe("active agent session viewers across Pi entrypoints", () => {
  it("shares one viewer registry and one dispose authority across real moduleCache:false entrypoints", () => {
    const producerPath = path.resolve("tests/fixtures/extensions/session-viewer-producer.ts");
    const consumerPath = path.resolve("tests/fixtures/extensions/session-viewer-consumer.ts");
    const harnessUrl = pathToFileURL(path.resolve("tests/test-harness.ts")).href;
    const script = `
const runtimeGlobal = globalThis;
const registryKey = Symbol.for("locus-pi.active-agent-session-viewers.v1");
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
    mkdtempSync(path.join(tmpdir(), "locus-pi-empty-viewer-dir-")),
  );
  check(loaded.errors.length === 0, "loader errors: " + JSON.stringify(loaded.errors));
  return loaded;
};
const command = (loaded, extensionPath, name) => {
  const handler = loaded.extensions.find((extension) => extension.resolvedPath === extensionPath)?.commands.get(name)?.handler;
  check(typeof handler === "function", "missing " + name);
  return handler;
};

// The set is installed lazily on first use, not on import, so nothing holds the slot yet.
check(runtimeGlobal[registryKey] === undefined, "viewer registry existed before any entrypoint ran");

const firstLoad = await loadEntrypoints();

// Forward: producer opens, peer observes, peer disposes, producer sees its viewer gone.
await command(firstLoad, producerPath, "test-viewer-producer-open")("", harness.ctx);
const producerOpened = harness.widgets.get("viewer-producer-open");
await command(firstLoad, consumerPath, "test-viewer-consumer-observe")("", harness.ctx);
const consumerObserved = harness.widgets.get("viewer-consumer-observe");
await command(firstLoad, consumerPath, "test-viewer-consumer-dispose")("", harness.ctx);
const consumerDisposed = harness.widgets.get("viewer-consumer-dispose");
await command(firstLoad, producerPath, "test-viewer-producer-observe")("", harness.ctx);
const producerAfterPeerDispose = harness.widgets.get("viewer-producer-observe");

const firstSlot = runtimeGlobal[registryKey];
check(firstSlot instanceof Set, "viewer registry is not a Set after use");
const descriptor = Object.getOwnPropertyDescriptor(runtimeGlobal, registryKey);

// Reverse: the consumer opens and the producer disposes, so the authority runs both ways.
await command(firstLoad, consumerPath, "test-viewer-consumer-open")("", harness.ctx);
const consumerOpened = harness.widgets.get("viewer-consumer-open");
await command(firstLoad, producerPath, "test-viewer-producer-dispose")("", harness.ctx);
const producerDisposed = harness.widgets.get("viewer-producer-dispose");
await command(firstLoad, consumerPath, "test-viewer-consumer-observe-own")("", harness.ctx);
const consumerAfterPeerDispose = harness.widgets.get("viewer-consumer-observe-own");

// A second discovery pass — what Pi reload does — must adopt the same set object, and a
// viewer opened by a freshly loaded instance must be visible to the older peer instance.
const secondLoad = await loadEntrypoints();
const secondSlot = runtimeGlobal[registryKey];
await command(secondLoad, producerPath, "test-viewer-producer-open")("", harness.ctx);
await command(firstLoad, consumerPath, "test-viewer-consumer-observe")("", harness.ctx);
const reloadObservedAcrossPasses = harness.widgets.get("viewer-consumer-observe");
await command(firstLoad, consumerPath, "test-viewer-consumer-dispose")("", harness.ctx);
await command(secondLoad, producerPath, "test-viewer-producer-observe")("", harness.ctx);
const reloadedProducerAfterPeerDispose = harness.widgets.get("viewer-producer-observe");

process.stdout.write(JSON.stringify({
  ok: true,
  loads: 2,
  // The producer's own view of the viewer it just opened: registered, and rendering
  // the complete empty-transcript view (six lines here, independent of terminal height).
  producerOpened,
  // Only possible on one shared set: the consumer opened nothing and reads the peer's viewer.
  consumerObserved,
  consumerDisposed,
  // rendered=0 is the sharp assertion — the peer's dispose reached the producer's component.
  // done=false because dispose() must not re-enter the owner's close callback.
  producerAfterPeerDispose,
  consumerOpened,
  producerDisposed,
  consumerAfterPeerDispose,
  reloadObservedAcrossPasses,
  reloadedProducerAfterPeerDispose,
  sameSet: secondSlot === firstSlot,
  emptyAtEnd: firstSlot.size,
  slotConfigurable: descriptor?.configurable,
  slotWritable: descriptor?.writable,
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
      producerOpened: "has=true\nrendered=5",
      // The guard invariant: the peer instance sees the terminal-owning viewer.
      consumerObserved: "has=true",
      consumerDisposed: "has=false",
      producerAfterPeerDispose: "has=false\nrendered=0\ndone=false",
      consumerOpened: "has=true\nrendered=5",
      producerDisposed: "has=false",
      consumerAfterPeerDispose: "has=false\nrendered=0\ndone=false",
      // A viewer opened by the reloaded instance is visible to the first pass's instance.
      reloadObservedAcrossPasses: "has=true",
      // And the first pass's teardown disposes it.
      reloadedProducerAfterPeerDispose: "has=false\nrendered=0\ndone=false",
      sameSet: true,
      emptyAtEnd: 0,
      // Installed non-configurable and non-writable, so nothing can swap the set out from under
      // a viewer that already registered its teardown in it.
      slotConfigurable: false,
      slotWritable: false,
    });
  }, 30_000);
});
