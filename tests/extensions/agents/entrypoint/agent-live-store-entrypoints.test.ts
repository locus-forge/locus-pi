import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("agent live store across Pi entrypoints", () => {
  it("shares v6 execution, cancellation, and input authority across moduleCache:false entrypoints without adopting v4", async () => {
    const producerPath = path.resolve("tests/fixtures/extensions/shared-store-producer.ts");
    const consumerPath = path.resolve("tests/fixtures/extensions/shared-store-consumer.ts");
    const harnessUrl = pathToFileURL(path.resolve("tests/test-harness.ts")).href;
    const script = `
const runtimeGlobal = globalThis;
const v4Key = Symbol.for("locus-pi.agent-live-store.v4");
const v6Key = Symbol.for("locus-pi.agent-live-store.v6");
const installedV4 = Object.freeze({ version: 4, store: { marker: "must remain untouched" } });
Object.defineProperty(runtimeGlobal, v4Key, {
  value: installedV4,
  enumerable: false,
  configurable: false,
  writable: false,
});
const v4ValueBefore = runtimeGlobal[v4Key];
const v4DescriptorBefore = Object.getOwnPropertyDescriptor(runtimeGlobal, v4Key);
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
    mkdtempSync(path.join(tmpdir(), "locus-pi-empty-agent-dir-")),
  );
  check(loaded.errors.length === 0, "loader errors: " + JSON.stringify(loaded.errors));
  return loaded;
};
const command = (loaded, extensionPath, name) => {
  const handler = loaded.extensions.find((extension) => extension.resolvedPath === extensionPath)?.commands.get(name)?.handler;
  check(typeof handler === "function", "missing " + name);
  return handler;
};
const firstLoad = await loadEntrypoints();
const firstV6Slot = runtimeGlobal[v6Key];
const firstStore = firstV6Slot?.store;
check(firstV6Slot?.version === 6 && firstStore !== undefined, "first v6 slot missing");
await command(firstLoad, producerPath, "test-produce-shared-row")("", harness.ctx);
await command(firstLoad, consumerPath, "test-consume-shared-row")("", harness.ctx);
check(harness.widgets.get("shared-store-proof") === "shared execution, cancellation, and input authority", "forward authority failed");
check(harness.widgets.get("shared-store-cancel") === "producer cancellation reached", "forward cancel failed");
check(harness.widgets.get("shared-store-input") === "producer input reached: forward", "forward input failed");
const secondLoad = await loadEntrypoints();
const secondV6Slot = runtimeGlobal[v6Key];
check(secondV6Slot === firstV6Slot, "v6 slot identity changed across discovery");
check(secondV6Slot?.store === firstStore, "v6 store identity changed across discovery");
await command(secondLoad, consumerPath, "test-consumer-produce-shared-row")("", harness.ctx);
await command(secondLoad, producerPath, "test-producer-consume-shared-row")("", harness.ctx);
check(harness.widgets.get("shared-store-reverse-proof") === "consumer execution reached producer", "reverse authority failed");
check(harness.widgets.get("shared-store-reverse-cancel") === "consumer cancellation reached", "reverse cancel failed");
check(harness.widgets.get("shared-store-reverse-input") === "consumer input reached: reverse", "reverse input failed");
const v4DescriptorAfter = Object.getOwnPropertyDescriptor(runtimeGlobal, v4Key);
check(runtimeGlobal[v4Key] === v4ValueBefore, "v4 value changed");
check(v4DescriptorAfter?.value === v4DescriptorBefore?.value, "v4 descriptor value changed");
check(v4DescriptorAfter?.configurable === false && v4DescriptorAfter?.writable === false, "v4 descriptor weakened");
const v6Slot = runtimeGlobal[v6Key];
check(v6Slot?.version === 6, "v6 slot missing");
check(v6Slot?.store !== installedV4.store, "v4 store was adopted");
process.stdout.write(JSON.stringify({
  ok: true,
  loads: 2,
  forward: harness.widgets.get("shared-store-proof"),
  reverse: harness.widgets.get("shared-store-reverse-proof"),
  v4Configurable: v4DescriptorBefore?.configurable,
  v4Writable: v4DescriptorBefore?.writable,
  v6Version: v6Slot?.version,
  sameSlot: secondV6Slot === firstV6Slot,
  sameStore: secondV6Slot?.store === firstStore,
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
      forward: "shared execution, cancellation, and input authority",
      reverse: "consumer execution reached producer",
      v4Configurable: false,
      v4Writable: false,
      v6Version: 6,
      sameSlot: true,
      sameStore: true,
    });
  }, 30_000);
});
