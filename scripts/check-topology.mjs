// Size ratchet: fail on file-size or directory-file-count growth since the base ref.
//
// Delegates to the locally installed Locus CLI (`locus topology check`), which reads
// `.locus-topology.toml` for accepted exceptions. `code-lines` there counts physical
// lines; the warn threshold is 500. This is a growth gate, not an absolute ceiling:
// existing oversized owners are debt, and a change that adds lines to one must either
// shrink it elsewhere or record a narrow exception with an owner and a trigger.
//
// Base ref: LOCUS_TOPOLOGY_BASE, else origin/dev. Set the variable when the branch is
// stacked on another feature branch that has not merged yet.
//
// Without the CLI the gate cannot run; it says so and exits 0 so contributors without
// Locus are not blocked. CI does not install Locus, so the pre-push hook is where this
// gate actually bites.
import { spawnSync } from "node:child_process";

const base = process.env.LOCUS_TOPOLOGY_BASE ?? "origin/dev";
const probe = spawnSync("locus", ["--version"], { stdio: "ignore" });
if (probe.error) {
  console.log(`topology ratchet skipped: locus CLI not installed (base would be ${base})`);
  process.exit(0);
}
const result = spawnSync("locus", ["topology", "check", "--base", base], { stdio: "inherit" });
process.exit(result.status ?? 1);
