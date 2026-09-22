import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const runPath = "skills/locus-pi-workflow-run/SKILL.md";
const createPath = "skills/locus-pi-workflow-create/SKILL.md";
const read = (relativePath: string): string => readFileSync(path.join(root, relativePath), "utf8");

/** Follow the actual entrypoint link, so an unlinked reference cannot satisfy a routing contract. */
function linkedText(from: string, target: string): string {
  const link = [...read(from).matchAll(/\]\(([^)]+)\)/gu)].find((match) => match[1] === target);
  expect(link, `${from} must route to ${target}`).toBeDefined();
  const [file] = target.split("#");
  return read(path.posix.normalize(path.posix.join(path.posix.dirname(from), file!)));
}

function containsAll(text: string, contracts: string[]): void {
  for (const contract of contracts) expect(text, contract).toContain(contract);
}

describe("shipped workflow skill routes", () => {
  it("selects native execution or an inspectable external session without losing structured fields", () => {
    const run = read(runPath);
    containsAll(run, [
      "If the request supplies `items` or `continuation`",
      "stop as unsupported when that tool is unavailable",
      "If a structured tool named `workflow` is available",
      "non-interactive execution is explicitly requested",
      "Supply exactly one of `name` or `scriptPath`",
      "Do not spawn Pi or translate the request into a slash command",
      "is not sandboxed",
      "create-and-run needs no repeat approval",
      "physical file before following relative links",
    ]);
    const external = linkedText(runPath, "../external-locus-pi/SKILL.md");
    containsAll(external, ["interactive Pi terminal retained by tmux", "Keep the", "terminal open"]);
    linkedText(runPath, "../../docs/workflows/running.md#workflow-tool-programmatic");
    expect(run).not.toContain("otherwise send the literal");
  });

  it("requires the explicit JSON protocol and persisted evidence rather than process success", () => {
    const run = read(runPath);
    containsAll(run, [
      "Only for an explicit non-interactive request",
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
      "actual persisted result",
      "process exit code alone are not semantic success",
    ]);
    const protocol = linkedText(runPath, "../../docs/workflows/running.md#run-from-an-agent-without-a-wrapper");
    containsAll(protocol, ["message_end", "workflow_rejected", "workflow_end", "resultPersisted"]);
    const lifecycle = linkedText(runPath, "references/external-lifecycle.md");
    containsAll(lifecycle, ["Never start a second writer", "Disable automatic restart"]);
  });

  it("loads the stopped-run procedure before launch and preserves evidence-based continuation", () => {
    const run = read(runPath);
    containsAll(run, ["stopped run known only by its run id", "## Recover a stopped run", "before\nlaunching"]);
    const recovery = linkedText(runPath, "references/recovery.md");
    containsAll(recovery, [
      "The `workflow` tool schema has no `status` operation",
      "Resolve the actual `runDir`",
      "`children/<runId>/` and `attempts/<runId>/`",
      "Confirm the requested id",
      "does not establish missing evidence",
      "<runDir>/runtime/result.json",
      "`failureDiagnostic`",
      "`evidencePath`",
      "<runDir>/runtime/journal.ndjson",
      "<runDir>/runtime/replay.ndjson",
      "`[phase, label, occurrence]`",
      "Name `continue` or `refuse`",
      "exact original semantic input and source workspace",
      "an explicit `outputDir` or `runName`",
      "Source edits are allowed and expected",
      "needs no new approval ritual",
      "does not recreate files",
      "first fresh call makes the whole suffix fresh",
      "`replay: not recorded`",
      "Original semantic input is unavailable",
      "Status is `awaiting_operator`",
      "recorded calls have no node names/labels",
      "Never manufacture `result.json`",
      "Name that ancestor and the orphan separately",
      "NEW run's `runtime/result.json`",
      "`replayedCalls`, `divergedAtCall` and `divergedAtNode`",
      "`freshCalls` alone proves nothing",
    ]);
    const replay = linkedText(
      "skills/locus-pi-workflow-run/references/recovery.md",
      "../../../docs/workflows/replay.md#resume-and-replay",
    );
    containsAll(replay, ["return-contract-changed", "unnamed-node", "fusion resume cannot mix"]);
    const interruption = linkedText(
      "skills/locus-pi-workflow-run/references/recovery.md",
      "../../../docs/workflows/recovery-and-continuation.md#explicit-interrupted-run-recovery",
    );
    containsAll(interruption, ["recoverInterrupted: true", "started-but-unconfirmed", "workspace lease"]);
  });

  it("keeps model and budget details reachable under their actual selection conditions", () => {
    const run = read(runPath);
    containsAll(run, [
      "Model choice belongs to the operator",
      "Preserve the current Pi session and its configured defaults",
      "Before an explicit selector or role override",
      "Never invent an agent-count cap",
      "automatic budget increase",
      "other undeclared axes are unbounded",
    ]);
    const models = linkedText(runPath, "../../docs/workflows/models.md#inspect-model-configuration");
    containsAll(models, [
      "pi --list-models",
      "pi --list-models <provider>",
      "defaultProvider, defaultModel, defaultThinkingLevel, enabledModels",
      "~/.pi/agent/model-roles/config.json",
      "must be permitted by `enabledModels`",
    ]);
    linkedText(runPath, "../../docs/workflows/budgets.md#run-budget");
    expect(run).not.toContain("openai-codex");
    expect(run).not.toContain("gpt-5.6");
  });

  it("routes authoring through method documentation, selected examples and the exact-source gate", () => {
    const create = read(createPath);
    containsAll(create, [
      "Do not use merely to run an existing workflow",
      "Before writing source, read the",
      "only the sections for methods and agent options this graph uses",
      "When adapting an example, read its exact source and adjacent guide",
      "unique literal `label`",
      "workflow_check_source",
      'mode: "orchestration-only"',
      "node --check <exact-path>",
      "npm run check:workflow-source -- --mode orchestration-only <exact-path>",
      "Never import unchecked source",
      "unavailable or failed gate means Build failed",
    ]);
    linkedText(createPath, "../../docs/workflows/dsl.md#dsl-surface-v0");
    linkedText(createPath, "../../examples/workflows/README.md");
    linkedText(createPath, "../locus-pi-workflow-run/SKILL.md");
  });
});
