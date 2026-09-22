// Assertions for tests/manual/repair-continue-tui/run.sh. Reads the continuation run's
// own result envelope; the TUI screenshot proves what the operator saw, this proves what
// the runtime actually did.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const project = process.env.PROJECT;
const first = process.env.FIRST;
if (!project || !first) throw new Error("PROJECT and FIRST are required");

const attemptsDir = path.join(project, ".locus-pi", "runs", first, "attempts");
const attempts = readdirSync(attemptsDir)
  .map((name) => path.join(attemptsDir, name))
  .filter((dir) => statSync(dir).isDirectory())
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
if (attempts.length === 0) throw new Error(`no continuation attempt under ${attemptsDir}`);

const attempt = attempts[0];
const result = JSON.parse(readFileSync(path.join(attempt, "runtime", "result.json"), "utf8"));
const replay = result.replay ?? {};
const checks = [
  ["continuation reused recorded work", replay.replayed === true],
  ["exactly the one completed call was replayed", replay.replayedCalls === 1],
  ["the repaired node and its tail ran fresh", (replay.freshCalls ?? 0) >= 2],
  ["divergence is named at the repaired node", String(replay.divergedAtNode ?? "").includes("review")],
  ["the continuation completed", result.ok === true && result.disposition?.status === "completed"],
];

console.log(`attempt: ${attempt}`);
console.log(`replay:  ${JSON.stringify(replay)}`);
console.log(`status:  ${result.disposition?.status ?? "(none)"} (ok=${result.ok})`);
for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
