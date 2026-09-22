import { appendFile, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkExtensionLayers } from "../../scripts/check-extension-layers.js";

/** Where the registry and facade cases plant violations: the one feature that reads workflow runs from outside. */
const CROSS_FEATURE_READER = "extensions/agents/index.ts";
const fixtureRoots: string[] = [];

afterEach(async () => {
  while (fixtureRoots.length > 0) await rm(fixtureRoots.pop()!, { recursive: true, force: true });
});

describe("extension layer checker negative rules", () => {
  it("rejects a shared module importing feature code", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, "extensions/_shared/host/error-text.ts"),
      '\nimport "../../workflows/index.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 1 (no upward import)");
  });

  it("rejects a shared module importing a higher layer", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, "extensions/_shared/host/error-text.ts"),
      '\nimport "../runtime/session-core.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 2 (layer order)");
  });

  it("rejects an unowned shared module", async () => {
    const root = await extensionFixture();
    await writeFile(path.join(root, "extensions/_shared/host/unowned.ts"), "export const unowned = true;\n", "utf8");

    await expectRule(root, "rule 3 (complete ownership)");
  });

  it("rejects a registry symbol named outside its owner", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, CROSS_FEATURE_READER),
      '\nvoid Symbol.for("locus-pi.agent-live-store.v5");\n',
      "utf8",
    );

    await expectRule(root, "rule 4 (registry ownership)");
  });

  it("rejects an undeclared mutable shared export", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, "extensions/_shared/host/error-text.ts"),
      "\nexport const reviewMutableState = new Map<string, string>();\n",
      "utf8",
    );

    await expectRule(root, "rule 5 (mutable module state)");
  });

  it("rejects a cross-feature import that bypasses the read facade", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, CROSS_FEATURE_READER),
      '\nimport "../workflows/runtime/workflow-journal.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 6 (feature-internal facade)");
  });

  it("rejects a cross-feature import of the journal event format", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, CROSS_FEATURE_READER),
      '\nimport "../workflows/runtime/workflow-journal-format.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 6 (feature-internal facade)");
  });

  it("rejects a cross-feature import of the persisted result envelope", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, CROSS_FEATURE_READER),
      '\nimport "../workflows/runtime/workflow-result.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 6 (feature-internal facade)");
  });

  it("rejects a cross-feature import of the persisted run snapshot reader", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, CROSS_FEATURE_READER),
      '\nimport "../workflows/runtime/workflow-run-snapshot.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 6 (feature-internal facade)");
  });

  it("rejects a cross-feature import of the resume authority", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, CROSS_FEATURE_READER),
      '\nimport "../workflows/runtime/workflow-run-resume.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 6 (feature-internal facade)");
  });

  it("rejects a cross-feature import of the ordered run admission", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, CROSS_FEATURE_READER),
      '\nimport "../workflows/runtime/workflow-run-admission.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 6 (feature-internal facade)");
  });

  it("rejects a cross-feature import of the workflow live projection", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, CROSS_FEATURE_READER),
      '\nimport "../workflows/runtime/workflow-live.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 6 (feature-internal facade)");
  });

  it("rejects a declared pure module that value-imports a host-bound builtin", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, "extensions/workflows/runtime/workflow-outcome.ts"),
      '\nimport { readFileSync } from "node:fs";\nvoid readFileSync;\n',
      "utf8",
    );

    await expectRule(root, "rule 7 (pure modules)");
  });

  it("accepts a per-specifier type-only edge from a pure module into a host-bound module", async () => {
    const root = await extensionFixture();
    // No `type` on the clause: only the specifier is type-only, so the edge
    // erases at compile time and rule 7 must not follow it into workflow-result.ts,
    // which reaches node:fs through the run layout.
    await appendFile(
      path.join(root, "extensions/workflows/runtime/workflow-outcome.ts"),
      '\nimport { type WorkflowResultPersistence } from "./workflow-result.js";\nexport type PersistenceEcho = WorkflowResultPersistence;\n',
      "utf8",
    );

    await expectClean(root);
  });
});

async function extensionFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "locus-extension-layers-"));
  fixtureRoots.push(root);
  await cp(path.resolve("extensions"), path.join(root, "extensions"), { recursive: true });
  return root;
}

async function expectClean(root: string): Promise<void> {
  const previousExitCode = process.exitCode;
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  process.exitCode = undefined;
  try {
    await checkExtensionLayers(root);
    expect(error.mock.calls.flatMap((call) => call.map(String)).join("\n")).toBe("");
    expect(process.exitCode).toBeUndefined();
  } finally {
    error.mockRestore();
    log.mockRestore();
    process.exitCode = previousExitCode;
  }
}

async function expectRule(root: string, message: string): Promise<void> {
  const previousExitCode = process.exitCode;
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.exitCode = undefined;
  try {
    await checkExtensionLayers(root);
    const output = error.mock.calls.flatMap((call) => call.map(String)).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain(message);
  } finally {
    error.mockRestore();
    process.exitCode = previousExitCode;
  }
}
