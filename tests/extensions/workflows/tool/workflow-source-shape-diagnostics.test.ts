import { describe, expect, it } from "vitest";
import {
  standardWorkflowSourceShapeDiagnostics,
  standardWorkflowSourceShapeErrors,
} from "../../../../extensions/workflows/tool/workflow-source-shape.js";

function phasedSource(declared: readonly string[], calls: readonly string[]): string {
  const phases = declared.map((title) => `{ title: ${JSON.stringify(title)} }`).join(", ");
  const body = calls.map((title) => `phase(${JSON.stringify(title)});`).join(" ");
  return `export const meta = { name: "sample", profile: "standard", phases: [${phases}] };\nexport default function run({ phase }) { ${body} return { ok: true }; }\n`;
}

describe("standard workflow source diagnostics", () => {
  it("adds stable codes and exact one-based multiline source spans", () => {
    const source = [
      'export const meta = { name: "sample", profile: "standard" };',
      "import {",
      "  value,",
      '} from "node:fs";',
      "export default function run() { return value; }",
      "",
    ].join("\n");

    const diagnostics = standardWorkflowSourceShapeDiagnostics(source);
    const imported = diagnostics.find((diagnostic) => diagnostic.code === "WF_IMPORT");

    expect(imported).toEqual({
      code: "WF_IMPORT",
      severity: "error",
      message: "standard profile imports no node: modules",
      line: 2,
      column: 1,
      endLine: 4,
      endColumn: 18,
    });
    expect(standardWorkflowSourceShapeErrors(source)).toContain("standard profile imports no node: modules");
  });

  it("orders by source position and reports exact related spans", () => {
    const diagnostics = standardWorkflowSourceShapeDiagnostics(phasedSource(["Scope", "stale"], ["scope", "publish"]));

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "WF_PHASE_UNUSED_DECLARATION",
      "WF_PHASE_CASE_MISMATCH",
      "WF_PHASE_UNDECLARED",
    ]);
    expect(diagnostics.find((diagnostic) => diagnostic.code === "WF_PHASE_CASE_MISMATCH")).toEqual({
      code: "WF_PHASE_CASE_MISMATCH",
      severity: "error",
      message: 'meta.phases title "Scope" differs from literal phase("scope") only by case',
      line: 2,
      column: 48,
      endLine: 2,
      endColumn: 55,
      related: [
        {
          message: 'declared as "Scope" here',
          line: 1,
          column: 78,
          endLine: 1,
          endColumn: 85,
        },
      ],
    });
  });

  it("keeps duplicate messages at distinct token locations and preserves the exact legacy projection", () => {
    const source = [
      'export const meta = { name: "sample", profile: "standard" };',
      'import fs from "node:fs";',
      'import path from "node:path";',
      "export default function run() { return true; }",
      "",
    ].join("\n");

    expect(
      standardWorkflowSourceShapeDiagnostics(source)
        .filter((diagnostic) => diagnostic.code === "WF_IMPORT")
        .map(({ line, column, endLine, endColumn }) => ({ line, column, endLine, endColumn })),
    ).toEqual([
      { line: 2, column: 1, endLine: 2, endColumn: 26 },
      { line: 3, column: 1, endLine: 3, endColumn: 30 },
    ]);
    expect(standardWorkflowSourceShapeErrors(source)).toEqual([
      "standard profile imports no node: modules",
      "standard profile reads values only from declared lexical bindings and approved language roots",
      "standard profile top level permits only literal constants, literal meta, and one default run export",
    ]);
  });

  it("keeps distinct same-code same-span messages in locale-independent code-unit order", () => {
    const source = [
      'export const meta = { name: "sample", profile: "standard" };',
      "export default function run() {",
      "  const holder = { f: function () {} };",
      "  return holder;",
      "}",
      "",
    ].join("\n");

    const policy = standardWorkflowSourceShapeDiagnostics(source).filter(
      (diagnostic) => diagnostic.code === "WF_POLICY",
    );

    expect(policy).toEqual([
      expect.objectContaining({
        message: "standard profile keeps no object or variable function wrapper",
        line: 3,
        column: 23,
        endLine: 3,
        endColumn: 37,
      }),
      expect.objectContaining({
        message: "standard profile uses arrow functions for inline callbacks",
        line: 3,
        column: 23,
        endLine: 3,
        endColumn: 37,
      }),
    ]);
    expect(standardWorkflowSourceShapeErrors(source)).toEqual(
      expect.arrayContaining([
        "standard profile keeps no object or variable function wrapper",
        "standard profile uses arrow functions for inline callbacks",
      ]),
    );
  });

  it("keeps empty declarations and repeated calls valid, and projects warnings out of legacy errors", () => {
    expect(standardWorkflowSourceShapeDiagnostics(phasedSource([], ["scope", "scope"]))).toEqual([]);
    expect(standardWorkflowSourceShapeDiagnostics(phasedSource(["scope"], ["scope", "scope"]))).toEqual([]);

    const warnings = standardWorkflowSourceShapeDiagnostics(phasedSource(["scope"], []));
    expect(warnings).toEqual([expect.objectContaining({ code: "WF_PHASE_UNUSED_DECLARATION", severity: "warning" })]);
    expect(standardWorkflowSourceShapeErrors(phasedSource(["scope"], []))).toEqual([]);
  });

  it("warns when declaration order differs from first literal phase occurrence", () => {
    const diagnostics = standardWorkflowSourceShapeDiagnostics(
      phasedSource(["publish", "scope"], ["scope", "publish"]),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "WF_PHASE_ORDER_DRIFT", severity: "warning", line: 1 }),
    ]);
    expect(diagnostics[0]?.related).toEqual([
      {
        message: "first literal phase() occurrence",
        line: 2,
        column: 48,
        endLine: 2,
        endColumn: 55,
      },
    ]);
  });

  it.each([
    {
      label: "callback parameter",
      body: '[1].map((phase) => phase("fake"));',
    },
    {
      label: "local variable",
      body: '{ const phase = (value) => value; phase("fake"); }',
    },
    {
      label: "local function",
      body: '{ function phase() {} phase("fake"); }',
    },
  ])("does not treat a shadowed $label as the trusted DSL phase binding", ({ body }) => {
    const source = [
      'export const meta = { name: "sample", profile: "standard", phases: [{ title: "real" }] };',
      "export default function run({ phase }) {",
      `  ${body}`,
      '  phase("real");',
      "  return { ok: true };",
      "}",
      "",
    ].join("\n");
    const diagnostics = standardWorkflowSourceShapeDiagnostics(source);

    expect(diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(diagnostics.filter((diagnostic) => diagnostic.code.startsWith("WF_PHASE_"))).toEqual([]);
  });

  it("activates a trusted root-body phase destructure only after its initializer", () => {
    const source = [
      'export const meta = { name: "sample", profile: "standard", phases: [{ title: "after" }] };',
      "export default function run(dsl) {",
      '  phase("before");',
      "  const { phase } = dsl;",
      '  phase("after");',
      "  return { ok: true };",
      "}",
      "",
    ].join("\n");
    const diagnostics = standardWorkflowSourceShapeDiagnostics(source);

    expect(diagnostics.filter((diagnostic) => diagnostic.code.startsWith("WF_PHASE_"))).toEqual([]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WF_IDENTIFIER",
          message: "standard profile reads values only from declared lexical bindings and approved language roots",
          line: 3,
        }),
      ]),
    );
  });

  it("keeps root dsl.phase and an activated root-body alias as trusted facts", () => {
    const source = [
      'export const meta = { name: "sample", profile: "standard", phases: [{ title: "root" }, { title: "alias" }] };',
      "export default function run(dsl) {",
      '  dsl.phase("root");',
      "  const { phase } = dsl;",
      '  phase("alias");',
      "  return { ok: true };",
      "}",
      "",
    ].join("\n");

    expect(
      standardWorkflowSourceShapeDiagnostics(source).filter((diagnostic) => diagnostic.code.startsWith("WF_PHASE_")),
    ).toEqual([]);
  });

  it("treats a nested-block var phase as a function-scoped shadow", () => {
    const source = [
      'export const meta = { name: "sample", profile: "standard", phases: [{ title: "real" }] };',
      "export default function run(dsl) {",
      "  { var phase = (value) => value; }",
      '  phase("fake");',
      '  dsl.phase("real");',
      "  return { ok: true };",
      "}",
      "",
    ].join("\n");

    expect(
      standardWorkflowSourceShapeDiagnostics(source).filter((diagnostic) => diagnostic.code.startsWith("WF_PHASE_")),
    ).toEqual([]);
  });

  it("treats a nested-block var dsl as a function-scoped shadow", () => {
    const source = [
      'export const meta = { name: "sample", profile: "standard", phases: [{ title: "real" }] };',
      "export default function run(dsl) {",
      "  { var dsl = { phase() {} }; }",
      '  dsl.phase("fake");',
      "  return { ok: true };",
      "}",
      "",
    ].join("\n");
    const phaseDiagnostics = standardWorkflowSourceShapeDiagnostics(source).filter((diagnostic) =>
      diagnostic.code.startsWith("WF_PHASE_"),
    );

    expect(phaseDiagnostics).toEqual([
      expect.objectContaining({
        code: "WF_PHASE_UNUSED_DECLARATION",
        message: 'meta.phases title "real" has no literal phase("real") call',
      }),
    ]);
    expect(phaseDiagnostics.some((diagnostic) => diagnostic.message.includes("fake"))).toBe(false);
  });

  it.each([
    {
      declared: ["scope", "scope"],
      message: 'meta.phases repeats title "scope"',
      related: 'first declared as "scope" here',
    },
    {
      declared: ["Scope", "scope"],
      message: 'meta.phases title "scope" duplicates "Scope" by case',
      related: 'first declared as "Scope" here',
    },
  ])("rejects exact and case-equivalent duplicate declarations: $declared", ({ declared, message, related }) => {
    const diagnostics = standardWorkflowSourceShapeDiagnostics(phasedSource(declared, ["scope"]));

    expect(diagnostics.filter((diagnostic) => diagnostic.code.startsWith("WF_PHASE_"))).toEqual([
      {
        code: "WF_PHASE_DUPLICATE_DECLARATION",
        severity: "error",
        message,
        line: 1,
        column: 98,
        endLine: 1,
        endColumn: 105,
        related: [
          {
            message: related,
            line: 1,
            column: 78,
            endLine: 1,
            endColumn: 85,
          },
        ],
      },
    ]);
  });

  it("checks literal calls inside branches and ignores computed phase values", () => {
    const source = [
      'export const meta = { name: "sample", profile: "standard", phases: [{ title: "scope" }] };',
      "export default function run({ phase }) {",
      '  const dynamic = "computed";',
      '  if (true) phase("scope");',
      "  phase(dynamic);",
      "  return { ok: true };",
      "}",
      "",
    ].join("\n");

    expect(
      standardWorkflowSourceShapeDiagnostics(source).filter((diagnostic) => diagnostic.code.startsWith("WF_PHASE_")),
    ).toEqual([]);
  });

  it("always supplies a bounded span for parser failures", () => {
    expect(standardWorkflowSourceShapeDiagnostics("export const meta = {")).toEqual([
      expect.objectContaining({
        code: "WF_SOURCE_PARSE",
        severity: "error",
        line: expect.any(Number),
        column: expect.any(Number),
        endLine: expect.any(Number),
        endColumn: expect.any(Number),
      }),
    ]);
  });
});
