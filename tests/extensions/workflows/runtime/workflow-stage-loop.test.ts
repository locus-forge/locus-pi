import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workflowRunOutputsDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  cleanupReplayProjects,
  runWorkflow,
  temporaryProject,
  writeWorkflow,
} from "../../../fixtures/workflow-replay-project.js";

afterEach(cleanupReplayProjects);

const source = readFileSync(path.resolve("examples/workflows/stage-loop/stage-loop.workflow.mjs"), "utf8");
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

async function runStage(
  mode: "committed" | "refused" | "failed" | "stale-file" | "old-commit" | "wrong-content" | "transport" | "bad-choice",
) {
  const root = temporaryProject();
  git(root, "init", "-q");
  git(root, "config", "user.name", "Stage fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(root, ".gitignore"), "/.agents/\n/.locus-pi/\n/reports/\n");
  writeFileSync(path.join(root, "app.ts"), "export const value = 1;\n");
  git(root, "add", ".gitignore", "app.ts");
  git(root, "commit", "--no-gpg-sign", "-qm", "stage base");
  const base = git(root, "rev-parse", "HEAD");
  const branch = git(root, "branch", "--show-current");
  const stageFile = path.join(root, "reports", "stage.md");
  const decisionFile = path.join(root, "reports", "decision.md");
  mkdirSync(path.dirname(stageFile));
  const input = `Task: change value to 2; base ${base}; branch ${branch}; owned app.ts; stage.md: ${stageFile}; round decision file: ${decisionFile}`;
  let commitReport = "";
  writeWorkflow(root, "stage-loop", source);
  const outcome = await runWorkflow(root, "stage-loop", {
    input,
    answer(prompt) {
      if (prompt.startsWith("Implement the stage")) {
        writeFileSync(path.join(root, "app.ts"), "export const value = 2;\n");
      }
      if (prompt.startsWith("Choose the control identity")) {
        writeFileSync(
          decisionFile,
          `Branch: ${branch}\nPre-commit HEAD: ${base}\n\nAccepted changes:\n${git(root, "diff")}`,
        );
        return "ready";
      }
      if (prompt.startsWith("The stage of")) {
        if (mode === "transport") throw new Error("commit transport unavailable");
        if (mode === "wrong-content") writeFileSync(path.join(root, "app.ts"), "export const value = 3;\n");
        if (["committed", "stale-file", "bad-choice", "wrong-content"].includes(mode)) {
          git(root, "add", "app.ts");
          git(root, "commit", "--no-gpg-sign", "-qm", "accepted stage");
        }
        commitReport =
          mode === "refused"
            ? "I refused because unrelated changes are present."
            : mode === "failed"
              ? "Commit failed; no commit was made."
              : `Committed ${git(root, "rev-parse", "HEAD")}.\nOwned file: app.ts\nComplete accepted stage summary.`;
        writeFileSync(stageFile, mode === "stale-file" ? "stale handoff" : commitReport);
        return commitReport;
      }
      if (prompt.startsWith("Verify the commit outcome")) {
        expect(prompt).toContain(input);
        expect(prompt).toContain(commitReport);
        expect(prompt).toContain("pre-commit HEAD");
        if (mode === "bad-choice") return "looks good to me";
        const head = git(root, "rev-parse", "HEAD");
        const recordedDecision = readFileSync(decisionFile, "utf8");
        const verified =
          head !== base &&
          recordedDecision ===
            `Branch: ${git(root, "branch", "--show-current")}\nPre-commit HEAD: ${git(root, "rev-parse", "HEAD^")}\n\nAccepted changes:\n${git(root, "diff", "HEAD^", head)}` &&
          readFileSync(stageFile, "utf8") === commitReport &&
          commitReport.includes(head);
        return verified ? "committed" : "blocked";
      }
      return "complete stage evidence";
    },
  });
  return { ...outcome, commitReport, stageFile };
}

describe("packaged stage-loop commit completion", () => {
  it.each(["refused", "failed", "stale-file", "old-commit", "wrong-content"] as const)(
    "preserves non-success and commit evidence for %s",
    async (mode) => {
      const result = await runStage(mode);
      expect(result.ok).toBe(false);
      expect(result.result).toMatchObject({ ok: false, status: "blocked", summary: "commit_blocked" });
      expect(existsSync(path.join(workflowRunOutputsDir(result.runDir), "stage.md"))).toBe(false);
      expect(readFileSync(path.join(workflowRunOutputsDir(result.runDir), "commit.md"), "utf8")).toContain(
        result.commitReport,
      );
    },
  );

  it("fails on a commit transport error without publishing success", async () => {
    const result = await runStage("transport");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("commit transport unavailable");
    expect(existsSync(path.join(workflowRunOutputsDir(result.runDir), "stage.md"))).toBe(false);
  });

  it("publishes the complete handoff only after verifying actual Git and current file evidence", async () => {
    const result = await runStage("committed");
    expect(result.ok).toBe(true);
    expect(result.executedPrompts.some((prompt) => prompt.startsWith("Verify the commit outcome"))).toBe(true);
    expect(readFileSync(path.join(workflowRunOutputsDir(result.runDir), "stage.md"), "utf8")).toContain(
      result.commitReport,
    );
    expect(readFileSync(result.stageFile, "utf8")).toBe(result.commitReport);
  });

  it("blocks malformed verification rather than treating arbitrary prose as success", async () => {
    const result = await runStage("bad-choice");
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(workflowRunOutputsDir(result.runDir), "stage.md"))).toBe(false);
  });
});
