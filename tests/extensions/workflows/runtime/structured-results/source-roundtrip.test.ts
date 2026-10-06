import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkWorkflowSourceText } from "../../../../../extensions/workflows/tool/workflow-source-check-tool.js";
import { workflowReplayFile } from "../../../../../extensions/workflows/runtime/workflow-replay.js";
import { rawTurn } from "../../../../fixtures/agent-runtime/structured-sdk.js";
import { withStructuredSourceSdk } from "../../../../fixtures/agent-runtime/structured-source-sdk.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["fix", "accept"] },
    findings: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "score"],
        properties: { text: { type: "string" }, score: { type: "number" } },
      },
    },
  },
};
const review = {
  verdict: "fix",
  findings: [
    { text: "one", score: 0 },
    { text: "two", score: 0.5 },
  ],
};
const meta = 'export const meta = { name: "structured-source", profile: "standard" };';
const returns = (value: unknown) => rawTurn([JSON.stringify({ value })]);
function checked(source: string): void {
  for (const mode of ["compatibility", "orchestration-only"] as const)
    expect(checkWorkflowSourceText(source, mode).filter((entry) => entry.severity === "error")).toEqual([]);
}
function objectSource(options: { arrow?: boolean; constant?: boolean; map?: boolean; alias?: boolean } = {}): string {
  const agent = options.alias ? "agent" : "dsl.agent";
  return `${meta}
${options.constant ? `const ReviewSchema = ${JSON.stringify(schema)};` : ""}
export default ${options.arrow ? "async (dsl) =>" : "async function run(dsl)"} {
  ${options.alias ? "const { agent } = dsl;" : ""}
  const review = await ${agent}("Review source", { label: "review", schema: ${options.constant ? "ReviewSchema" : JSON.stringify(schema)} });
  ${
    options.map
      ? "return review.findings.map((finding) => finding.text);"
      : `if (review.verdict === "fix") {
    for (const finding of review.findings) {
      await ${agent}(\`Follow \${finding.text}\`, { label: "follow", schema: { type: "string" } });
    }
  }
  return review;`
  }
}${options.arrow ? ";" : ""}`;
}

describe("checked source to real SDK receipt and persisted replay", () => {
  it("keeps the existing checked Choice path as a real-runner fixture control", async () => {
    const source = `${meta}\nexport default async function run(dsl) {
      return await dsl.agent("Choose", { label: "choice", choice: ["known", "other"] });
    }`;
    checked(source);
    await withStructuredSourceSdk(source, [returns("known")], async (fixture) => {
      const first = await fixture.run();
      expect(first.ok, first.error).toBe(true);
      expect(first.result).toBe("known");
      expect(fixture.counters).toMatchObject({ physical: 1, sessions: 1 });
      expect(fixture.counters.generations).toBeGreaterThan(0);
      const before = { ...fixture.counters };
      const resumed = await fixture.run({ resumeFromRunId: first.runId });
      expect(resumed.ok, resumed.error).toBe(true);
      expect(resumed.result).toBe("known");
      expect(resumed.replay).toMatchObject({ replayedCalls: 1, freshCalls: 0 });
      expect(fixture.counters).toEqual(before);
    });
  });
  it.each([
    { arrow: false, constant: false },
    { arrow: false, constant: true },
    { arrow: true, constant: false },
    { arrow: true, constant: true },
    { arrow: false, constant: false, alias: true },
    { arrow: true, constant: true, alias: true },
  ])("proves object fields, enum routing and array iteration through %j", async (options) => {
    const source = objectSource(options);
    checked(source);
    await withStructuredSourceSdk(
      source,
      [returns(review), returns("detail-one"), returns("detail-two")],
      async (fixture) => {
        const first = await fixture.run({ input: "same input" });
        expect(first.ok, first.error).toBe(true);
        expect(first.result).toEqual(review);
        expect(fixture.counters).toMatchObject({ physical: 3, sessions: 3, generations: 3 });
        expect(first.scriptIdentity).toMatchObject({ identityCoverage: "self-contained-static" });
        const receipts = first.records.flatMap((entry) =>
          entry.kind === "agent" && entry.ok && entry.structuredReceipt ? [entry.structuredReceipt] : [],
        );
        expect(receipts).toHaveLength(3);
        for (const receipt of receipts) {
          expect(receipt.sourceIdentity).toBe(first.scriptIdentity!.scriptSha256);
          expect(receipt.inputIdentity).toMatch(/^[a-f0-9]{64}$/u);
          expect(receipt.observerRevision).toBe("codex-responses-v3");
        }
        expect(receipts[0]!.value).toEqual(review);
        expect(Object.isFrozen(receipts[0]!.value)).toBe(true);
        const nested = receipts[0]!.value as typeof review;
        expect(Object.isFrozen(nested.findings)).toBe(true);
        expect(Object.isFrozen(nested.findings[0])).toBe(true);
        const before = { ...fixture.counters };
        const resumed = await fixture.run({ input: "same input", resumeFromRunId: first.runId });
        expect(resumed.ok, resumed.error).toBe(true);
        expect(resumed.result).toEqual(review);
        expect(resumed.replay).toMatchObject({ replayedCalls: 3, freshCalls: 0 });
        expect(fixture.counters).toEqual(before);
      },
    );
  });
  it("covers schema-array map without treating arbitrary object methods as owned callbacks", async () => {
    const source = objectSource({ map: true });
    checked(source);
    await withStructuredSourceSdk(source, [returns(review)], async (fixture) => {
      const first = await fixture.run();
      expect(first.ok, first.error).toBe(true);
      expect(first.result).toEqual(["one", "two"]);
      const before = { ...fixture.counters };
      const resumed = await fixture.run({ resumeFromRunId: first.runId });
      expect(resumed.ok, resumed.error).toBe(true);
      expect(resumed.result).toEqual(["one", "two"]);
      expect(resumed.replay).toMatchObject({ replayedCalls: 1, freshCalls: 0 });
      expect(fixture.counters).toEqual(before);
    });
  });
  it.each([
    { type: "null", value: null },
    { type: "boolean", value: false },
    { type: "number", value: 0 },
    { type: "string", value: "native text" },
  ])("preserves a JSON $type result and replays without generation", async ({ type, value }) => {
    const source = `${meta}\nexport default async function run(dsl) {
      return await dsl.agent("Return value", { label: "value", schema: { type: "${type}" } });
    }`;
    checked(source);
    await withStructuredSourceSdk(source, [returns(value)], async (fixture) => {
      const first = await fixture.run();
      expect(first.ok, first.error).toBe(true);
      expect(first.result).toEqual(value);
      const before = { ...fixture.counters };
      const resumed = await fixture.run({ resumeFromRunId: first.runId });
      expect(resumed.ok, resumed.error).toBe(true);
      expect(resumed.result).toEqual(value);
      expect(resumed.replay).toMatchObject({ replayedCalls: 1, freshCalls: 0 });
      expect(fixture.counters).toEqual(before);
    });
  });
  it.each(["schema", "input", "value", "observer"])("refuses changed %s without a fresh child", async (mode) => {
    const source = `${meta}\nexport default async function run(dsl) {
      return await dsl.agent("Return value", { label: "value", schema: { type: "string", minLength: 1 } });
    }`;
    checked(source);
    await withStructuredSourceSdk(source, [returns("known")], async (fixture) => {
      const first = await fixture.run({ input: "original" });
      expect(first.ok, first.error).toBe(true);
      if (mode === "value" || mode === "observer") {
        const file = workflowReplayFile(first.runDir);
        const rows = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (mode === "value") rows[0].structuredReceipt.value = "changed";
        else rows[0].structuredReceipt.observerRevision = "codex-responses-v2";
        writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      }
      const before = { ...fixture.counters };
      const resumed = await fixture.run({
        resumeFromRunId: first.runId,
        input: mode === "input" ? "changed" : "original",
        ...(mode === "schema" ? { source: source.replace("minLength: 1", "minLength: 2") } : {}),
      });
      expect(resumed.ok).toBe(false);
      expect(resumed.error).toContain("replay-contract-failure");
      expect(fixture.counters).toEqual(before);
    });
  });
});

it.each(["nested-map", "for-of-map"])("replays composed schema arrays: %s", async (mode) => {
  const source = `${meta}
export default async function run(dsl) {
  const rows = await dsl.agent("Return nested rows", {
    label: "rows", schema: { type: "array", items: { type: "array", items: { type: "string" } } }
  });
  ${
    mode === "nested-map"
      ? "return rows.map((row) => row.map((value) => value));"
      : "for (const row of rows) { row.map((value) => value); } return rows;"
  }
}`;
  checked(source);
  const value = [["one"], ["two"]];
  await withStructuredSourceSdk(source, [returns(value)], async (fixture) => {
    const first = await fixture.run();
    expect(first.ok, first.error).toBe(true);
    expect(first.result).toEqual(value);
    expect(fixture.counters).toMatchObject({ physical: 1, sessions: 1, generations: 1 });
    expect(first.records[0]).toMatchObject({
      ok: true,
      structuredReceipt: {
        sourceIdentity: first.scriptIdentity!.scriptSha256,
        observerRevision: "codex-responses-v3",
        value,
      },
    });
    const before = { ...fixture.counters };
    const resumed = await fixture.run({ resumeFromRunId: first.runId });
    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumed.result).toEqual(value);
    expect(resumed.replay).toMatchObject({ replayedCalls: 1, freshCalls: 0 });
    expect(fixture.counters).toEqual(before);
  });
});

it.each([
  "return rows.map(async row => row);",
  "return await rows.map(async row => row);",
  "return rows.map(row => () => row);",
  "return rows.map(row => [() => row]);",
  "return rows.map(row => true ? (() => row) : (() => row));",
  "return rows.map(row => true && (() => row));",
  "return rows.map(row => [true ? (() => row) : (() => row)]);",
])("refuses replay of unchecked non-JSON map projections rejected by source checks: %s", async (projection) => {
  const source = `${meta}
export default async function run({ agent }) {
  const rows = await agent("Rows", {label:"rows",schema:{type:"array",items:{type:"string"}}});
  ${projection}
}`;
  for (const mode of ["compatibility", "orchestration-only"] as const)
    expect(
      checkWorkflowSourceText(source, mode).some(
        (entry) => entry.severity === "error" && entry.message.includes("structured array map"),
      ),
    ).toBe(true);
  // The trusted runner can execute unchecked JavaScript; source admission is checked separately above.
  await withStructuredSourceSdk(source, [returns(["one", "two"])], async (fixture) => {
    const first = await fixture.run();
    expect(first.ok, first.error).toBe(true);
    const receipts = first.records.flatMap((entry) =>
      entry.kind === "agent" && entry.ok && entry.structuredReceipt ? [entry.structuredReceipt] : [],
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.sourceIdentity).toBe("unavailable");
    const counters = { ...fixture.counters };
    const resumed = await fixture.run({ resumeFromRunId: first.runId });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("structured receipt/source identity mismatch");
    expect(fixture.counters).toEqual(counters);
  });
});

it("settles owned parallel branch factories before persisting or replaying their values", async () => {
  const source = `${meta}
export default async function run({ agent, parallel }) {
  const rows = await agent("Rows", {label:"rows",schema:{type:"array",items:{type:"string"}}});
  return await parallel(rows.map(row => () => agent(row, {label:"next",schema:{type:"string"}})));
}`;
  checked(source);
  await withStructuredSourceSdk(
    source,
    [returns(["one", "two"]), returns("first"), returns("second")],
    async (fixture) => {
      const first = await fixture.run();
      expect(first.ok, first.error).toBe(true);
      expect(first.result).toEqual(["first", "second"]);
      const counters = { ...fixture.counters };
      const resumed = await fixture.run({ resumeFromRunId: first.runId });
      expect(resumed.ok, resumed.error).toBe(true);
      expect(resumed.result).toEqual(first.result);
      expect(fixture.counters).toEqual(counters);
    },
  );
});
