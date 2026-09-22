import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The proof T-135 W3 owes for moving `workflow-journal.ts` out of `extensions/_shared/`.
 *
 * `check:layers` rule 4 asserts STATICALLY that exactly one module names
 * `Symbol.for("locus-pi.workflow-live-executions.v1")`. That is a source-level count and
 * cannot show what the process actually gets: Pi loads each registered entrypoint with the
 * module cache disabled, so every entrypoint holds its OWN instance of workflow-live.ts,
 * the module that declares the registry, and a relocation that split the registry into two
 * slots — or left one entrypoint resolving a different copy — would keep rule 4 green while
 * breaking the run.
 *
 * A same-process test that pokes `globalThis` would prove nothing here, because the failure
 * mode is per-entrypoint module instances, not per-process state. So this test loads two
 * separately registered entrypoints through the real `discoverAndLoadExtensions` and drives
 * the registry ACROSS them: each side opens a journal writer, and the OTHER side closes it.
 *
 * Why closing a peer's writer is the sharp assertion: `applyWorkflowJournalLineToAgentLiveStore`
 * looks the writer up by execution key and returns early when it holds none. With two copies
 * of the map the terminal line is therefore a SILENT no-op — the peer's live row stays
 * `working` and its writer entry never clears — which is exactly the class of breakage a
 * static owner count cannot see.
 */
describe("workflow live executions across Pi entrypoints", () => {
  it("shares one writer registry and one authority across real moduleCache:false entrypoints", () => {
    const producerPath = path.resolve("tests/fixtures/extensions/workflow-live-producer.ts");
    const consumerPath = path.resolve("tests/fixtures/extensions/workflow-live-consumer.ts");
    const harnessUrl = pathToFileURL(path.resolve("tests/test-harness.ts")).href;
    const script = `
const runtimeGlobal = globalThis;
const registryKey = Symbol.for("locus-pi.workflow-live-executions.v1");
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
    mkdtempSync(path.join(tmpdir(), "locus-pi-empty-workflow-dir-")),
  );
  check(loaded.errors.length === 0, "loader errors: " + JSON.stringify(loaded.errors));
  return loaded;
};
const command = (loaded, extensionPath, name) => {
  const handler = loaded.extensions.find((extension) => extension.resolvedPath === extensionPath)?.commands.get(name)?.handler;
  check(typeof handler === "function", "missing " + name);
  return handler;
};

// No slot exists until a journal module is asked for one — the registry is created lazily.
check(runtimeGlobal[registryKey] === undefined, "registry slot existed before any entrypoint ran");

const firstLoad = await loadEntrypoints();
// Each entrypoint opens its own writer. Both sides must land in ONE map.
await command(firstLoad, producerPath, "test-workflow-open-writer")("", harness.ctx);
await command(firstLoad, consumerPath, "test-workflow-consumer-open-writer")("", harness.ctx);
const firstSlot = runtimeGlobal[registryKey];
check(firstSlot instanceof Map, "registry slot is not a Map after both entrypoints wrote");
const descriptor = Object.getOwnPropertyDescriptor(runtimeGlobal, registryKey);

// Each side now closes the OTHER side's writer. This only works on a shared registry.
await command(firstLoad, consumerPath, "test-workflow-consumer-close-peer-writer")("", harness.ctx);
await command(firstLoad, producerPath, "test-workflow-close-peer-writer")("", harness.ctx);

// A second discovery pass must adopt the same slot rather than install a fresh one.
const secondLoad = await loadEntrypoints();
await command(secondLoad, producerPath, "test-workflow-producer-observe")("", harness.ctx);
await command(secondLoad, consumerPath, "test-workflow-consumer-observe")("", harness.ctx);
const secondSlot = runtimeGlobal[registryKey];

process.stdout.write(JSON.stringify({
  ok: true,
  loads: 2,
  // Two writers open, observed through the map both entrypoints share.
  bothOpen: harness.widgets.get("workflow-live-consumer-open"),
  producerOpen: harness.widgets.get("workflow-live-producer-open"),
  // Each close is performed by the entrypoint that did NOT open the writer.
  consumerClosedProducer: harness.widgets.get("workflow-live-consumer-close"),
  producerClosedConsumer: harness.widgets.get("workflow-live-producer-close"),
  // Both entrypoints agree the registry is empty again after the cross closes.
  producerObserved: harness.widgets.get("workflow-live-producer-observe"),
  consumerObserved: harness.widgets.get("workflow-live-consumer-observe"),
  sameSlot: secondSlot === firstSlot,
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
      // The producer opened first and saw one writer; the consumer's own open saw both,
      // which is only possible if the two module instances share one map.
      producerOpen: "count=1\nstatus=working\nslotIsMap=true",
      bothOpen: "count=2\nstatus=working\nslotIsMap=true",
      // Cross-closes: each terminal line found the PEER's execution handle, patched the
      // peer's row to `done`, and removed the peer's writer entry.
      consumerClosedProducer: "count=1\nstatus=done",
      producerClosedConsumer: "count=0\nstatus=done",
      // Both entrypoints, reloaded, agree the shared map is empty.
      producerObserved: "count=0\nslotIsMap=true",
      consumerObserved: "count=0\nslotIsMap=true",
      sameSlot: true,
      // The journal installs the slot non-configurable and non-writable, so nothing can
      // swap the registry out from under a live run.
      slotConfigurable: false,
      slotWritable: false,
    });
  }, 30_000);
});
