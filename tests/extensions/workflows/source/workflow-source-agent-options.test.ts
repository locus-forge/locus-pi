import { describe, expect, it } from "vitest";
import { checkWorkflowSourceText } from "../../../../extensions/workflows/tool/workflow-source-check-tool.js";

function source(options: string, declarations = ""): string {
  return `export const meta = { name: "choice-contract", profile: "standard" };
${declarations}
export default async function run(dsl) {
  return dsl.agent("Choose the next action", ${options});
}`;
}

describe("static agent choice declarations", () => {
  it.each(["validate", "repair", "outputTransport"])("names removed %s without restoring an author API", (option) => {
    for (const mode of ["compatibility", "orchestration-only"] as const)
      expect(checkWorkflowSourceText(source(`{ label: "result", ${option}: {} }`), mode)).toContainEqual(
        expect.objectContaining({
          code: "WF_POLICY",
          severity: "error",
          message: expect.stringContaining(`agent ${option} was removed`),
        }),
      );
  });
  it.each(["compatibility", "orchestration-only"] as const)("rejects an undeclared fallback in %s mode", (mode) => {
    const diagnostics = checkWorkflowSourceText(
      source(
        '{ label: "route", choice: ["route_to_verify", "route_to_fix_defects"], choiceFallback: "route_to_stop_run" }',
      ),
      mode,
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "WF_POLICY",
        severity: "error",
        message: "agent choiceFallback must be one of the declared choices",
      }),
    );
  });

  it("accepts a declared fallback with parentheses, escapes, comments and a trailing comma", () => {
    expect(
      checkWorkflowSourceText(
        source('{ label: "route", choice: (["accept", ("f\\u0069x"), /* branch */]), choiceFallback: (`fix`) }'),
        "orchestration-only",
      ),
    ).toEqual([]);
  });

  it("honors the last direct property instead of rejecting an overwritten fallback", () => {
    expect(
      checkWorkflowSourceText(
        source('{ label: "route", choice: ["accept", "fix"], choiceFallback: "stop", choiceFallback: "fix" }'),
        "orchestration-only",
      ),
    ).toEqual([]);
  });

  it.each([
    ['{ label: "route", choice: ["accept", "fix"], choiceFallback: FALLBACK }', 'const FALLBACK = "fix";'],
    ['{ label: "route", choice: CHOICES, choiceFallback: "stop" }', 'const CHOICES = ["accept", "stop"];'],
    [
      '{ label: "route", choice: ["accept", "fix"], ...OPTIONS, choiceFallback: "stop" }',
      'const OPTIONS = { choice: ["accept", "stop"] };',
    ],
    ['{ label: "route", choice: ["accept", , "fix"], choiceFallback: "stop" }', ""],
  ])("leaves unresolved declaration values to the runtime", (options, declarations) => {
    expect(
      checkWorkflowSourceText(source(options, declarations), "orchestration-only").map(
        (diagnostic) => diagnostic.message,
      ),
    ).not.toContain("agent choiceFallback must be one of the declared choices");
  });
});
