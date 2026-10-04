import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import runStyle from "../../../../../examples/workflows/post-code-review/style.workflow.mjs";
import { completed, temporaryValue } from "../../../../fixtures/scripted-agent-runtime.js";
import { createWorkflowRuntime } from "../../../../../extensions/workflows/runtime/workflow-runtime.js";

type Criteria = "omitted" | "empty" | "supplied" | "missing" | "directory" | "symlink" | "unreadable";

async function review(criteria: Criteria) {
  return temporaryValue(async (root) => {
    const workspace = path.join(root, "native-state");
    const criteriaPath = path.join(root, "operator-criteria.md");
    const reportPath = path.join(root, "assigned-style-review.md");
    const targetPath = path.join(root, "symlink-target.md");
    const supplied = "Exact operator bytes\n  preserve whitespace; do not widen scope\n";
    mkdirSync(workspace);
    if (criteria === "empty") writeFileSync(criteriaPath, "");
    if (criteria === "supplied" || criteria === "unreadable") writeFileSync(criteriaPath, supplied);
    if (criteria === "directory") mkdirSync(criteriaPath);
    if (criteria === "symlink") {
      writeFileSync(targetPath, supplied);
      symlinkSync(targetPath, criteriaPath);
    }
    if (criteria === "unreadable") chmodSync(criteriaPath, 0);
    // A misleading prior workspace file must never supply omitted/missing criteria.
    writeFileSync(path.join(workspace, "style.md"), "OLD WORKSPACE CRITERIA: forbidden fallback");
    const input = `Review accepted scope. Exact review-style.md destination: ${reportPath}\n${criteria === "omitted" ? "No extra criteria." : `Exact criteria-file path: ${criteriaPath}`}`;
    const calls: string[] = [];
    let observed: string | undefined;
    const runtime = createWorkflowRuntime({
      runId: "style-criteria-test",
      projectRoot: root,
      workspaceDir: workspace,
      agentRunner: async (request) => {
        calls.push(request.label!);
        expect(request.prompt).toContain(input);
        if (request.label === "admit style criteria") {
          expect(request.prompt).toContain("inspect its leaf without following a symlink");
          let route = "ready";
          if (criteria !== "omitted") {
            try {
              const stat = lstatSync(criteriaPath);
              if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid criteria leaf: ${criteriaPath}`);
              accessSync(criteriaPath, constants.R_OK);
              observed = readFileSync(criteriaPath, "utf8");
            } catch {
              route = "failed";
            }
          }
          return {
            ...completed(request, JSON.stringify(route)),
            outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const },
          };
        }
        expect(request.label).toBe("audit comments and code style");
        expect(request.prompt).toContain("Write or replace exactly one complete Markdown file named review-style.md");
        expect(request.prompt).toContain(
          "Omitted criteria or an empty regular file means no additional style criteria",
        );
        // The scripted ordinary-tool reader uses only the path supplied by the caller.
        if (criteria !== "omitted") expect(readFileSync(criteriaPath, "utf8")).toBe(observed);
        writeFileSync(
          reportPath,
          observed ? `Read-only criteria:\n${observed}` : "No additional criteria; project conventions still apply.",
        );
        return completed(request, "Style report written at assigned path.");
      },
    });
    const result = await runStyle(runtime.dsl, input);
    if (criteria === "unreadable") chmodSync(criteriaPath, 0o600);
    return {
      result,
      calls,
      observed,
      supplied,
      report: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : undefined,
      criteriaBytes:
        existsSync(criteriaPath) && lstatSync(criteriaPath).isFile() ? readFileSync(criteriaPath, "utf8") : undefined,
      targetBytes: existsSync(targetPath) ? readFileSync(targetPath, "utf8") : undefined,
      workspaceBytes: readFileSync(path.join(workspace, "style.md"), "utf8"),
    };
  });
}

describe("post-code-review caller-owned optional style criteria", () => {
  it.each<Criteria>(["omitted", "empty"])(
    "uses no extra criteria for %s without workspace fallback",
    async (criteria) => {
      const result = await review(criteria);
      expect(result.result).toBe("Style report written at assigned path.");
      expect(result.report).toContain("No additional criteria");
      expect(result.observed ?? "").toBe("");
      expect(result.workspaceBytes).toBe("OLD WORKSPACE CRITERIA: forbidden fallback");
    },
  );

  it("preserves supplied bytes and writes only the assigned style report", async () => {
    const result = await review("supplied");
    expect(result.criteriaBytes).toBe(result.supplied);
    expect(result.observed).toBe(result.supplied);
    expect(result.report).toBe(`Read-only criteria:\n${result.supplied}`);
  });

  it.each<Criteria>(["missing", "directory", "symlink", "unreadable"])(
    "refuses named %s criteria before review without substitution",
    async (criteria) => {
      const result = await review(criteria);
      expect(result.result).toEqual({ ok: false, status: "failed", reason: "style_criteria_unavailable" });
      expect(result.calls).toEqual(["admit style criteria"]);
      expect(result.report).toBeUndefined();
      expect(result.workspaceBytes).toBe("OLD WORKSPACE CRITERIA: forbidden fallback");
      if (criteria === "symlink") expect(result.targetBytes).toBe(result.supplied);
      if (criteria === "unreadable") expect(result.criteriaBytes).toBe(result.supplied);
    },
  );
});
