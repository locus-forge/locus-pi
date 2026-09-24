import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { orchestrationOnlyWorkflowSourceShapeDiagnostics } from "../../../../extensions/workflows/tool/workflow-source-shape.js";
const errors = (source: string) =>
  orchestrationOnlyWorkflowSourceShapeDiagnostics(source).filter((item) => item.severity === "error");
const wrap = (body: string, declarations = "") =>
  `export const meta = { name: "test", profile: "standard" };\n${declarations}\nexport default async function run(dsl, input) { ${body} }`;
const bounded = (body: string) =>
  wrap(
    `let carry = ""; for (let round = 1; round <= 3; round += 1) { const answer = await dsl.agent(input, { label: "work" }); ${body} } return carry;`,
  );
describe("standard bounded carry and author-owned records; requires native ast-grep", () => {
  it.each(["fixed", "refinement", "decomposition", "adaptive-slices", "adaptive-design"])(
    "checks the actual %s example source, not a rewritten fixture",
    (name: string) => {
      const source = readFileSync(
        path.resolve(`extensions/workflows/references/examples/${name}.workflow.mjs`),
        "utf8",
      );
      expect(errors(source)).toEqual([]);
    },
  );
  it("carries a complete discovered queue without making its items author-known", () => {
    const queueSource = (use: string) =>
      wrap(`let queue = []; for (let i = 0; i < 3; i++) {
      const next = await dsl.agent(input, { label: "cut", handoffs: { maxItems: 100 } });
      queue = next; ${use}
    } return queue;`);
    expect(errors(queueSource('const item = queue[0]; await dsl.agent(item, { label: "work" });'))).toEqual([]);
    expect(errors(queueSource('for (const item of queue) { await dsl.agent(item, { label: "work" }); }'))).toEqual([]);
    for (const use of [
      "const item = queue[0]; if (item.done) return item;",
      "const alias = queue; for (const item of alias) { if (item.done) return item; }",
      'await dsl.parallel(queue.map((item) => () => dsl.agent(item.title, { label: "work" })));',
      "queue = [];",
      'queue.push("fabricated");',
      "queue = next.slice(0, 1);",
      "await dsl.parallel([async () => { queue = next; return next; }]);",
    ])
      expect(errors(queueSource(use)).length, use).toBeGreaterThan(0);
  });
  it("allows prompt joins of nested runtime lists but not opaque text", () => {
    expect(
      errors(
        wrap(
          'for (let i = 0; i < 2; i++) { const queue = await dsl.agent(input, { label: "cut", handoffs: { maxItems: 3 } }); await dsl.agent(`Queue: ${queue.join("\\n---\\n")}`, { label: "work" }); }',
        ),
      ),
    ).toEqual([]);
    expect(
      errors(
        wrap(
          'for (let i = 0; i < 2; i++) { const report = await dsl.agent(input, { label: "read" }); await dsl.agent(`Report: ${report.join("\\n")}`, { label: "work" }); }',
        ),
      ).length,
    ).toBeGreaterThan(0);
  });
  it("allows whole-answer carry and exact runtime control, including ++ bounds", () => {
    expect(errors(bounded("carry = answer;"))).toEqual([]);
    expect(
      errors(
        wrap(
          'let previous = "start"; for (let i = 0; i < 2; i++) { const decision = await dsl.agent(input, { label: "route", choice: ["complete", ' +
            '"continue"] }); if (previous === "complete") return decision; previous = decision; } return previous;',
        ),
      ),
    ).toEqual([]);
  });
  it("accepts an adaptive owner loop with whole evidence, exact routes, and a hard turn cap", () => {
    const source = wrap(
      [
        'const inspection = await dsl.agent(input, { label: "inspect" });',
        'let lastOutcome = "";',
        "for (let turn = 1; turn <= 6; turn += 1) {",
        'const slice = await dsl.agent(`Select from ${inspection} and ${lastOutcome}`, { label: "select" });',
        'const route = await dsl.agent(`Route ${slice}`, { label: "route", choice: ["work", "complete", "stop"] });',
        'if (route === "complete") return dsl.agent(`Verify ${lastOutcome}`, { label: "verify" });',
        'if (route === "stop") return { ok: false, status: "failed", reason: "owner_stop", diagnostics: slice };',
        'const work = await dsl.agent(`Implement ${slice}`, { label: "implement" });',
        'lastOutcome = await dsl.agent(`Review ${slice} and ${work}`, { label: "review" });',
        "}",
        'return { ok: false, status: "failed", reason: "turn_cap", diagnostics: lastOutcome };',
      ].join("\n"),
    );
    expect(errors(source)).toEqual([]);
  });
  it("joins alternative whole reports only through a carry inside its nearest bounded loop", () => {
    const reviewLoop = [
      'const product = await dsl.agent(input, { label: "implement" });',
      'let latestReview = ""; let latestRoute = ""; let latestCorrection = "";',
      "for (let round = 1; round <= 2; round += 1) {",
      'const review = await dsl.agent(`Review ${product} after ${latestCorrection}`, { label: "review" });',
      'const reviewRoute = await dsl.agent(`Route ${review}`, { label: "review-route", choice: ["accept", "correct"] });',
      "latestReview = review; latestRoute = reviewRoute;",
      'if (reviewRoute === "accept" || round === 2) break;',
      'const correction = await dsl.agent(`Correct ${review}`, { label: "correct" });',
      "latestCorrection = correction;",
      "}",
      'const record = await dsl.agent(`Record ${latestRoute}: ${latestReview}`, { label: "record" });',
      'if (latestRoute === "accept") return record;',
      'return { ok: false, status: "failed", reason: "unresolved" };',
    ].join("\n");
    expect(errors(wrap(reviewLoop))).toEqual([]);

    const branchJoin = wrap(
      [
        'const review = await dsl.agent(input, { label: "review" });',
        'const route = await dsl.agent(`Route ${review}`, { label: "route", choice: ["accept", "correct"] });',
        'let latestReport = "";',
        'if (route === "accept") { latestReport = review; }',
        'if (route === "correct") { const recheck = await dsl.agent(`Recheck ${review}`, { label: "recheck" }); latestReport = recheck; }',
        'return dsl.agent(`Record ${latestReport}`, { label: "record" });',
      ].join("\n"),
    );
    const nestedCarry = wrap(
      'let carry = ""; for (let outer = 1; outer <= 2; outer += 1) { for (let inner = 1; inner <= 2; inner += 1) ' +
        '{ const answer = await dsl.agent(input, { label: "work" }); carry = answer; } } return carry;',
    );
    const outerBlockCarry = wrap(
      'const route = await dsl.agent(input, { label: "route", choice: ["a", "b"] }); let carry = ""; ' +
        'if (route === "a") { for (let round = 1; round <= 2; round += 1) { const answer = await dsl.agent(input, { label: "work" }); carry = answer; } } ' +
        "return carry;",
    );
    for (const invalid of [branchJoin, nestedCarry, outerBlockCarry]) {
      const codes = errors(invalid).map((item) => item.code);
      expect(codes).toContain("WF_EXPRESSION");
      expect(codes).toContain("WF_DATA_FLOW");
    }
  });
  it("requires the exact choice option and a supported diagnostic publication method", () => {
    const valid = wrap(
      'const route = await dsl.agent(input, { label: "route", choice: ["passed", "failed"] }); ' +
        'if (route === "failed") { dsl.publishArtifact("diagnostic.md", "literal reason"); return { ok: false, status: "failed" }; } return route;',
    );
    const invalidChoice = wrap(
      'const route = await dsl.agent(input, { label: "route", choices: ["passed", "failed"] }); return route;',
    );
    const invalidMethod = wrap('dsl.publishText("diagnostic.md", "literal reason"); return "failed";');
    const composedPublication = wrap(
      'const report = await dsl.agent(input, { label: "report" }); ' +
        'dsl.publishArtifact("diagnostic.md", `Failure: ${report}`); return report;',
    );
    expect(errors(valid)).toEqual([]);
    expect(errors(invalidChoice).map((item) => item.code)).toContain("WF_AUTHORING_SUBSET");
    expect(errors(invalidMethod).map((item) => item.code)).toContain("WF_CALL");
    expect(errors(composedPublication)).toEqual([]);
  });
  it("treats one repeated bounded callsite as replay-safe and distinct duplicate callsites as unsafe", () => {
    const repeated = wrap(
      'let queue = []; for (let slice = 0; slice <= 6; slice += 1) { queue = await dsl.agent(input, { label: "source-slice", handoffs: {} }); if (queue.length === 0) break; } return queue;',
    );
    const duplicated = wrap(
      'const first = await dsl.agent(input, { label: "source-slice" }); const second = await dsl.agent(first, { label: "source-slice" }); return second;',
    );

    expect(errors(repeated)).toEqual([]);
    expect(errors(duplicated)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WF_AGENT_LABEL_DUPLICATE",
          message: expect.stringContaining('label "source-slice" is already used'),
        }),
      ]),
    );
  });
  it("allows named author-owned record properties and flat destructuring", () => {
    const declarations =
      'const FIELDS = [{ key: "id", question: "Exact ID?" }, { key: "schedule", question: "Schedule?" }];';
    expect(
      errors(
        wrap(
          'return dsl.parallel(FIELDS.map((field) => () => dsl.agent(field.question, { label: "field", title: field.key })), { keys: ' +
            "FIELDS.map((entry) => entry.key), concurrency: 2 });",
          declarations,
        ),
      ),
    ).toEqual([]);
    expect(
      errors(
        wrap(
          'return dsl.parallel(FIELDS.map(({ key, question }) => () => dsl.agent(question, { label: "field", title: key })));',
          declarations,
        ),
      ),
    ).toEqual([]);
  });
  it.each([
    "carry = answer.trim();",
    "carry = answer; const alias = carry; if (alias.length > 0) return alias;",
    'carry = answer; if (carry === "complete") return carry;',
    "carry = { text: answer };",
    "carry = answer; round = 1;",
    "carry = answer; await dsl.parallel([async () => { carry = answer; return answer; }]);",
  ])("rejects transforms, taint laundering and shared mutation: %s", (body: string) => {
    expect(errors(bounded(body)).length).toBeGreaterThan(0);
  });
  it.each([
    'let carry = ""; while (true) { carry = await dsl.agent(input, { label: "work" }); }',
    'let carry = ""; for (let i = 0; i < input; i++) { carry = await dsl.agent(input, { label: "work" }); }',
    'let carry = ""; for (let i = 0; i < 3; i--) { carry = await dsl.agent(input, { label: "work" }); }',
    'let carry = ""; for (let i = 0; i < 3; i++) { carry = await dsl.agent(input, { label: "work" }); carry = "forged"; }',
  ])("does not admit carry without a proven finite loop: %s", (body: string) => {
    expect(errors(wrap(body)).length).toBeGreaterThan(0);
  });
  it("does not turn captured model output into an author-owned mapped object", () => {
    const body =
      'const text = await dsl.agent(input, { label: "read" }); const records = ["id"].map((key) => ({ key, value: text })); return ' +
      'dsl.parallel(records.map((record) => () => dsl.agent(record.value, { label: "write" })));';
    expect(errors(wrap(body)).length).toBeGreaterThan(0);
  });
  it("admits handoffs through the return tool and still refuses raw schema regardless of transport", () => {
    expect(
      errors(
        wrap(
          'const units = await dsl.agent(input, { label: "discover", handoffs: { minItems: 1, maxItems: 3 }, returnVia: "tool", ' +
            'repair: { maxAttempts: 2 } }); return dsl.parallel(units.map((unit) => () => dsl.agent(unit, { label: "work" })));',
        ),
      ),
    ).toEqual([]);
    expect(
      errors(wrap('return dsl.agent(input, { label: "verify", schema: { type: "object" }, returnVia: "tool" });')).map(
        (item) => item.message,
      ),
    ).toContainEqual(expect.stringMatching(/owns no raw schema/u));
  });
  it("keeps discovered handoffs opaque despite the new author-record syntax", () => {
    const body =
      'const values = await dsl.agent(input, { label: "discover", handoffs: { maxItems: 3 } }); return dsl.parallel(values.map(({ key }) => () => dsl.agent(key, { label: "work" })));';
    expect(errors(wrap(body)).length).toBeGreaterThan(0);
  });
});

describe("opaque execution-report authoring", () => {
  it("allows whole-report forwarding with either DSL syntax", () => {
    const body =
      'const report = await dsl.agent(input, { label: "review", result: "report" }); return dsl.agent(report, { label: "arbiter" });';
    expect(errors(wrap(body))).toEqual([]);
    expect(
      errors(wrap(body).replace("run(dsl, input)", "run({ agent }, input)").replaceAll("dsl.agent", "agent")),
    ).toEqual([]);
  });
  it.each([
    'result: "typo"',
    "result: input",
    'result: "report", choice: ["yes", "no"]',
    'result: "report", returnVia: "tool"',
    'result: "report", handoffs: { maxItems: 2 }',
  ])("rejects hidden or mixed report policy: %s", (opts) => {
    expect(errors(wrap(`return dsl.agent(input, { label: "review", ${opts} });`)).length).toBeGreaterThan(0);
  });
  it("does not impose report policy on unrelated returned records", () => {
    expect(errors(wrap('return { result: "ordinary application value" };'))).toEqual([]);
  });
  it.each([
    'if (report.status === "completed") return report;',
    "return report[0];",
    'if (report === "ready") return report;',
  ])("rejects interpretation of report content: %s", (body) => {
    expect(
      errors(wrap(`const report = await dsl.agent(input, { label: "review", result: "report" }); ${body}`)).length,
    ).toBeGreaterThan(0);
  });
});
