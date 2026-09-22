import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// T-194 / REQ-010 honesty guard. Shipped workflow examples are fixtures a reader
// can mistake for real runs, so they must not regress to the internal placeholder
// row title "SDK child session" (the label the owner flagged as unreadable on the
// T-188 after-report; REQ-003). The real-model-id rule is a manual policy rule in
// docs/evidence.md, NOT guarded here: runnable live-proof workflows (e.g.
// live-args) legitimately pin a real model, so a regex would false-positive.

const EXAMPLES_DIR = path.resolve(process.cwd(), "extensions/workflows/examples");
const PLACEHOLDER_LABEL = "SDK child session";

describe("evidence honesty: workflow example fixtures (T-194 / REQ-010)", () => {
  const files = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(path.join(EXAMPLES_DIR, entry.name), { withFileTypes: true })
        .filter((child) => child.isFile() && child.name.endsWith(".workflow.mjs"))
        .map((child) => path.join(entry.name, child.name)),
    );

  it("ships at least one example workflow to guard", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s carries no 'SDK child session' placeholder label", (file) => {
    const source = readFileSync(path.join(EXAMPLES_DIR, file), "utf8");
    expect(source).not.toContain(PLACEHOLDER_LABEL);
  });
});
