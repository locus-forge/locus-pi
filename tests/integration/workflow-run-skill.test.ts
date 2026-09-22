import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("shipped workflow run skill", () => {
  it("routes by host capability and treats typed receipts as workflow truth", () => {
    const runSkill = readFileSync(path.join(root, "skills/locus-pi-workflow-run/SKILL.md"), "utf8");
    const authoringSkill = readFileSync(path.join(root, "skills/locus-pi-workflow-create/SKILL.md"), "utf8");

    for (const contract of [
      "If a structured tool named `workflow` is available",
      "If the request supplies `items` or `continuation`",
      "[external-locus-pi](../external-locus-pi/SKILL.md)",
      "non-interactive execution is explicitly requested",
      "stop as unsupported when that tool is unavailable",
      '"pi", "--mode", "json", "-p", "--no-session", "--approve", prompt',
      "`target`, `runName`, `outputDir`, and `resumeFromRunId`",
      "Reject a command-token value",
      "first character is `-`",
      'message.customType == "locus-workflow-run"',
      "workflow_start",
      "workflow_rejected",
      "workflow_end",
      "journalPath",
      "resultPersisted",
      "process exit code alone as semantic success",
      "not sandboxed",
    ]) {
      expect(runSkill, contract).toContain(contract);
    }
    expect(runSkill).not.toContain("locus-pi workflow run");
    expect(runSkill).not.toContain("monitor, or inspect");
    expect(authoringSkill).toContain("Do not use merely to run an existing workflow");
    expect(authoringSkill).toContain("`locus-pi-workflow-run` skill");
  });

  it("owns the stopped-run recovery procedure and routes to it", () => {
    const runSkill = readFileSync(path.join(root, "skills/locus-pi-workflow-run/SKILL.md"), "utf8");

    // Without the description the skill is never selected for "the run stopped",
    // and the procedure below is unreachable however complete it is.
    expect(runSkill).toContain("recover a run that stopped, failed, or was interrupted when only its run id is known");
    expect(runSkill).toContain("## Recover a stopped run");

    for (const contract of [
      // Evidence path an agent can walk on its own: files, not an operator command.
      "The `workflow` tool schema has no `status` operation",
      ".locus-pi/runs/<runId>/runtime/result.json",
      "`failureDiagnostic` inside that file",
      "The child result, transcript or answer at `evidencePath`",
      ".locus-pi/runs/<runId>/runtime/journal.ndjson",
      "`replay: not recorded reason=…` means no later run can resume from it",
      // The completed prefix is readable from the record by node name alone.
      "carries a `node` naming the call as `[phase, label, occurrence]`",
      "without reading the workflow source",
      // Outcome declared before launch, then proven from the new run.
      "Name `continue` or `refuse` before starting anything",
      "prove that outcome\nfrom the new run's evidence afterwards",
      // Replay reuses answer text only; a cleaned workspace is a false green.
      "It does not re-create files, re-read\n  the project, or repeat any child side effect",
      'cleaned workspace turns a replayed "checks passed" answer into a false green',
      // Repair is the expected reason to edit, not a reason to lose the prefix.
      "Editing the stopped workflow first is allowed and\n  expected",
      "Changed source bytes no longer\n  end a resume",
      "The first fresh call ends reuse for the whole run",
      // The fusion boundary is named, and what it refuses is a MIXED panel: a whole
      // fresh panel after the divergence point is ordinary work, not a terminal error.
      "runs as an ordinary fresh panel",
      "What stays refused is a MIXED panel",
      "`fusion resume cannot mix recorded and fresh agent calls`",
      "A fully replayed panel is not charged against `totalAgents`",
      // The real replay boundary of this release, plain-text calls included.
      "re-runs from its first\n  agent call, whatever that call is",
      // Reuse is proven from the new run, and a fresh-call count proves nothing.
      "`divergedAtNode` names the node",
      "`freshCalls` alone proves nothing",
      // Resume is bound to the source workspace.
      "A resume runs in the workspace of the source run",
      "repeat it with `outputDir`",
      "fails closed instead of creating a new\nworkspace silently",
      // The seven named refusals.
      "A missing result requires the explicit interrupted-recovery checks",
      "The source journal says `replay: not recorded`",
      "`scriptPath` resolves outside the current `projectRoot`",
      "The original semantic input is unavailable",
      "The terminal status is `awaiting_operator`",
      "The workspace or project prerequisites needed by replayed calls are no longer",
      "Resume was requested without the source workspace, or with a different one",
      "recorded before node names existed",
      // Source edits belong to the authoring skill; operator answers are never invented.
      "belongs to the `locus-pi-workflow-create` skill",
      "every\n`agent()` call carries a unique literal `label`",
      "the answer must never be synthesized",
    ]) {
      expect(runSkill, contract).toContain(contract);
    }

    // One answer to "the run stopped" per file: the broad retry promise is gone.
    expect(runSkill).not.toContain("retry a failed run through `resumeFromRunId`");
    expect(runSkill).toContain('it is not a general "retry the failed run" switch');
    // The rejected route must not survive as a name anywhere in the procedure.
    expect(runSkill).not.toContain("repair-then-fresh");
    expect(runSkill).not.toContain("script-changed");
  });

  it("keeps provider, model, and role selection operator-owned", () => {
    const runSkill = readFileSync(path.join(root, "skills/locus-pi-workflow-run/SKILL.md"), "utf8");

    expect(runSkill).toContain("Model choice belongs to the operator");
    expect(runSkill).toContain("pi --list-models");
    expect(runSkill).toContain("pi --list-models <provider>");
    expect(runSkill).toContain("defaultProvider, defaultModel, defaultThinkingLevel, enabledModels");
    expect(runSkill).toContain("~/.pi/agent/model-roles/config.json");
    expect(runSkill).not.toContain("settings.json#modelRoles` as an input");
    expect(runSkill).toContain("must be permitted by `enabledModels`");
    expect(runSkill).toMatch(/preserve the current Pi\s+session and its configured defaults/);
    expect(runSkill).not.toContain("openai-codex");
    expect(runSkill).not.toContain("gpt-5.6");
  });
});
