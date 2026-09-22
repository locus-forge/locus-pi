/**
 * Bindings and scopes: which names a source declares, where they are visible,
 * and that nothing shadows a trusted DSL, collection or `Error` name. The facts
 * under test belong to `source/workflow-source-bindings.ts`.
 */
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../../extensions/workflows/tool/workflow-source-shape.js";

function standardSource(run: string, declarations = ""): string {
  return [
    'export const meta = { name: "contract-test", profile: "standard", description: "Contract test." };',
    declarations,
    run,
  ]
    .filter(Boolean)
    .join("\n");
}

describe("standard workflow source bindings and scopes", () => {
  it.each([
    [
      "switch-scoped agent renderer",
      standardSource(`export default function run({ agent }, input) {
  switch (input) {
    default: {
      const agent = JSON.stringify;
      return agent({ report: input });
    }
  }
}`),
    ],
    [
      "switch-scoped dsl object",
      standardSource(`export default function run(dsl, input) {
  switch (input) {
    default: {
      const dsl = { agent: JSON.stringify };
      return dsl.agent({ report: input });
    }
  }
}`),
    ],
    [
      "for-of log eval",
      standardSource(`export default function run({ log }, input) {
  for (const log of [eval]) return log(input);
}`),
    ],
    [
      "for-of Error Function",
      standardSource(`export default function run(dsl, input) {
  for (const Error of [Function]) return new Error(input);
}`),
    ],
  ])("rejects reviewer lexical-shadow probe: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "bare log callback parameter",
      standardSource(`export default function run({ log }, input) {
  return [eval].map(log => log(input));
}`),
    ],
    [
      "bare agent callback parameter",
      standardSource(`export default function run({ agent, parallel }, input) {
  return parallel([eval].map(agent => agent(input)));
}`),
    ],
    [
      "bare Error callback parameter",
      standardSource(`export default function run(dsl, input) {
  return [Function].map(Error => new Error(input));
}`),
    ],
    [
      "bare collection callback parameter",
      standardSource(`export default function run({ pipeline, items }, input) {
  return pipeline(items(), agent => agent(input));
}`),
    ],
  ])("rejects reviewer bare-arrow shadow probe: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "process name followed by an outer process read",
      standardSource(
        `export default async function run({ agent, parallel }) {
  await parallel(KNOWN.map(function process(item) {
    return () => agent(item);
  }));
  if (process.env.DEPLOY === "yes") return agent("Deploy");
  return agent("Hold");
}`,
        'const KNOWN = ["one"];',
      ),
    ],
    [
      "Buffer name followed by an outer Buffer read",
      standardSource(
        `export default async function run({ agent, parallel }) {
  await parallel(KNOWN.map(function Buffer(item) {
    return () => agent(item);
  }));
  if (Buffer.poolSize > 0) return agent("Deploy");
  return agent("Hold");
}`,
        'const KNOWN = ["one"];',
      ),
    ],
  ])("rejects named callback ambient-root leakage: %s", (_label, text) => {
    const errors = standardWorkflowSourceShapeErrors(text);
    expect(errors).toContain("standard profile uses arrow functions for inline callbacks");
    expect(errors).toContain(
      "standard profile reads values only from declared lexical bindings and approved language roots",
    );
  });

  it("keeps a named function-expression name local while rejecting the callback form", () => {
    const text = standardSource(
      `export default function run({ agent, parallel }) {
  return parallel(KNOWN.map(function process(item) {
    if (process) return () => agent(item);
    return () => agent(item);
  }));
}`,
      'const KNOWN = ["one"];',
    );
    const errors = standardWorkflowSourceShapeErrors(text);
    expect(errors).toContain("standard profile uses arrow functions for inline callbacks");
    expect(errors).not.toContain(
      "standard profile reads values only from declared lexical bindings and approved language roots",
    );
  });

  it.each([
    [
      "trusted assignment in for increment",
      standardSource(`export default function run({ log }, input) {
  for (let index = 0; log !== eval; log = eval) {}
  return log(input);
}`),
    ],
    [
      "trusted destructuring assignment in for increment",
      standardSource(`export default function run({ agent }) {
  for (let index = 0; index < 1; [agent] = [eval]) {}
  return agent("x");
}`),
    ],
    [
      "second run parameter masquerading as DSL",
      standardSource('export default function run({ log }, { agent }) { return agent("payload"); }'),
    ],
  ])("rejects trusted binding provenance violation: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });
});
