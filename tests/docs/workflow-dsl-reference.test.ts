import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { STANDARD_DSL_METHODS } from "../../extensions/workflows/source/workflow-source-bindings.js";
import {
  orchestrationOnlyWorkflowSourceShapeDiagnostics,
  standardWorkflowSourceShapeDiagnostics,
} from "../../extensions/workflows/tool/workflow-source-shape.js";
import { root } from "../contracts/helpers/package-contract.js";

const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const reference = read("docs/workflows/dsl.md");
const examples = new Map(
  [...reference.matchAll(/<!-- dsl-example: ([\w-]+) -->\s*```js( expect-error)?\n([\s\S]*?)\n```/gu)].map((match) => [
    match[1]!,
    { source: match[3]!, expectsError: match[2] !== undefined },
  ]),
);

function example(name: string): string {
  const snippet = examples.get(name);
  expect(snippet, `Missing checked DSL example: ${name}`).toBeDefined();
  expect(snippet!.expectsError, `${name}: explicitly mark only rejected examples`).toBe(name.startsWith("rejected-"));
  return snippet!.source;
}

describe("workflow DSL reader reference", () => {
  it("gives every runtime method a searchable signature, example, and availability row", () => {
    const source = ts.createSourceFile(
      "workflow-runtime.ts",
      read("extensions/workflows/runtime/workflow-runtime.ts"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const contract = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "WorkflowDsl",
    );
    expect(contract).toBeDefined();
    const methods = new Set(
      contract!.members.filter(ts.isMethodSignature).map((method) => method.name.getText(source)),
    );
    const entries = new Map(
      [...reference.matchAll(/^### (\w+)\n([\s\S]*?)(?=^#{2,3} |$(?![\s\S]))/gmu)].map((match) => [
        match[1]!,
        match[2]!,
      ]),
    );
    expect([...entries.keys()].sort()).toEqual([...methods].sort());
    for (const method of methods) {
      expect(entries.get(method), `${method} signature`).toMatch(/\*\*Signatures?:\*\*/u);
      expect(entries.get(method), `${method} usable example`).toMatch(/\*\*(?:Migration )?[Ee]xample/u);
      expect(reference, `${method} availability`).toContain(`[\`${method}\`](#${method.toLowerCase()})`);
    }
    const rows = reference.split("\n").filter((line) => /^\| \[`\w+`\]\(#/u.test(line));
    for (const row of rows) {
      const method = /\[`(\w+)`\]/u.exec(row)![1]!;
      const standard = row.split("|")[3]!.trim();
      expect(standard.startsWith("Yes"), `${method}: documented standard availability`).toBe(
        STANDARD_DSL_METHODS.has(method),
      );
    }
  });

  it.each(["orchestration-only", "checked-source-publication"])(
    "admits the documented %s example in both checker modes",
    (name) => {
      const source = example(name);
      for (const check of [standardWorkflowSourceShapeDiagnostics, orchestrationOnlyWorkflowSourceShapeDiagnostics]) {
        expect(check(source).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      }
    },
  );

  it.each(["rejected-consumed-text", "rejected-continuation-text"])(
    "refuses property extraction from opaque host results in %s",
    (name) => {
      const source = example(name);
      expect(standardWorkflowSourceShapeDiagnostics(source)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "WF_DATA_FLOW", severity: "error" })]),
      );
      expect(orchestrationOnlyWorkflowSourceShapeDiagnostics(source)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "WF_DATA_FLOW", severity: "error" }),
          expect.objectContaining({ code: "WF_AUTHORING_SUBSET", severity: "error" }),
        ]),
      );
    },
  );

  it("accepts the workspace example only in standard compatibility mode", () => {
    const source = example("standard");
    expect(standardWorkflowSourceShapeDiagnostics(source).filter((item) => item.severity === "error")).toEqual([]);
    expect(orchestrationOnlyWorkflowSourceShapeDiagnostics(source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("orchestration-only authoring does not call outputDir()"),
        }),
      ]),
    );
  });

  it.each([
    ["rejected-schema", "raw schema"],
    ["rejected-fusion", "calls only direct DSL primitives"],
  ])("refuses the documented runtime-only %s example in both authoring modes", (name, reason) => {
    for (const check of [standardWorkflowSourceShapeDiagnostics, orchestrationOnlyWorkflowSourceShapeDiagnostics]) {
      expect(check(example(name))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: "error", message: expect.stringContaining(reason) }),
        ]),
      );
    }
  });
});
