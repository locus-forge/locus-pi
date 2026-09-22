import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/release-candidate.mjs");

describe("npm release candidate", () => {
  it("binds the staged filename, package identity, and bytes to pack evidence", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "locus-pi-candidate-test-"));
    try {
      execFileSync(process.execPath, [script, "pack", directory]);
      const evidencePath = path.join(directory, "candidate.json");
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { filename: string; name: string };

      evidence.name = "@other/package";
      writeFileSync(evidencePath, JSON.stringify(evidence));
      expect(() => execFileSync(process.execPath, [script, "verify", directory], { stdio: "pipe" })).toThrow();

      evidence.name = "@locus-forge/locus-pi";
      writeFileSync(evidencePath, JSON.stringify(evidence));
      writeFileSync(path.join(directory, evidence.filename), "tampered");
      expect(() => execFileSync(process.execPath, [script, "verify", directory], { stdio: "pipe" })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
