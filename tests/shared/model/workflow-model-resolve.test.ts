import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseModelSelector,
  resolveWorkflowModel,
  type WorkflowModelRegistrySource,
} from "../../../extensions/_shared/model/workflow-model-resolve.js";
import type { ModelLike } from "../../../extensions/_shared/host/pi-api.js";
import { createHarness, type Harness } from "../../test-harness.js";
import { restoreGlobalModelRolesHome, writeGlobalModelRoles } from "../../model-roles-fixture.js";

/**
 * The shared selector/registry resolver, on its own.
 *
 * These cases are about the SHARED module and nothing above it: how a
 * `provider/id[:thinking]` token is read, and what the host model registry answers for
 * one. Workflow ROUTING — which of `model` / `modelRole` / frontmatter wins, and what a
 * refusal says — belongs to the workflow model owner and stays in
 * `tests/extensions/workflows/runtime/workflow-model-tiers.test.ts`. Apart, a grammar
 * change breaks the grammar suite instead of fifty routing cases.
 */

const FAST: ModelLike = { provider: "test", id: "fast", name: "Test Fast" };
const STRONG: ModelLike = { provider: "test", id: "strong", name: "Test Strong" };

afterEach(() => {
  restoreGlobalModelRolesHome();
});

/** A harness whose registry holds exactly the two models these cases name. */
async function harnessWithRoles(roles?: Record<string, string>): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "locus-model-resolve-"));
  writeGlobalModelRoles(root, roles ?? {});
  const h = createHarness(root, { sessionId: "resolver-parent" });
  h.ctx.model = STRONG;
  return h;
}

// ---------------------------------------------------------------------------
// W1 — the selector grammar, which OD3 settled as "real thinking levels only"
// ---------------------------------------------------------------------------

describe("model selector grammar", () => {
  it("splits a plain provider/id selector", () => {
    expect(parseModelSelector("openai/gpt-5")).toEqual({ provider: "openai", id: "gpt-5" });
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh"])(
    "strips the real thinking level %s and keeps it for display",
    (level) => {
      expect(parseModelSelector(`openai/gpt-5:${level}`)).toEqual({
        provider: "openai",
        id: "gpt-5",
        thinking: level,
      });
    },
  );

  it("keeps a suffix that is not a thinking level as part of the id", () => {
    // The two parsers used to disagree here: this module stripped the LITERAL
    // string ":thinking" while the roles table stripped real levels. One grammar
    // now, and the literal word is just an id suffix that will fail to resolve.
    expect(parseModelSelector("openai/gpt-5:thinking")).toEqual({ provider: "openai", id: "gpt-5:thinking" });
  });

  it.each(["smol", "slow", "default"])("treats the slash-free token %s as a role, not a selector", (token) => {
    expect(parseModelSelector(token)).toBeUndefined();
  });

  it.each(["", "/", "openai/", "/gpt-5", "openai/:high"])("refuses the malformed selector %j", (selector) => {
    expect(parseModelSelector(selector)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W1 — resolution goes through the host registry and never returns "undefined,
// figure it out yourself"
// ---------------------------------------------------------------------------

describe("registry resolution", () => {
  it("resolves a configured model to the registry's own object", async () => {
    const h = await harnessWithRoles();
    const resolution = await resolveWorkflowModel("test/fast", h.ctx);

    expect(resolution).toMatchObject({ ok: true, selector: "test/fast", provider: "test", id: "fast" });
    expect(resolution.ok && resolution.model).toEqual(FAST);
  });

  it("strips the thinking level BEFORE the registry lookup", async () => {
    const seen: Array<[string, string]> = [];
    const source: WorkflowModelRegistrySource = {
      modelRegistry: {
        find(provider, id) {
          seen.push([provider, id]);
          return provider === "test" && id === "fast" ? FAST : undefined;
        },
      },
    } as WorkflowModelRegistrySource;

    const resolution = await resolveWorkflowModel("test/fast:low", source);

    expect(seen).toEqual([["test", "fast"]]);
    expect(resolution).toMatchObject({ ok: true, thinking: "low" });
  });

  it("names an unknown model instead of returning nothing", async () => {
    const h = await harnessWithRoles();
    const resolution = await resolveWorkflowModel("test/absent", h.ctx);

    expect(resolution.ok).toBe(false);
    expect(resolution).toMatchObject({ reason: "unknown-model" });
    expect(!resolution.ok && resolution.message).toContain('"test/absent"');
    expect(!resolution.ok && resolution.message).toContain('provider "test" has no model "absent"');
  });

  it("names an unparseable selector", async () => {
    const h = await harnessWithRoles();
    const resolution = await resolveWorkflowModel("smol", h.ctx);

    expect(resolution).toMatchObject({ ok: false, reason: "unparseable-selector" });
  });

  it("names a host with no model registry rather than guessing", async () => {
    const resolution = await resolveWorkflowModel("test/fast", {} as WorkflowModelRegistrySource);

    expect(resolution).toMatchObject({ ok: false, reason: "no-model-registry" });
  });
});
