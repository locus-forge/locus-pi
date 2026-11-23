import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";
import workflows from "../../../../../extensions/workflows/index.js";
import { createHarness } from "../../../../test-harness.js";

vi.mock("@earendil-works/pi-coding-agent", async (load) => ({
  ...(await load<typeof import("@earendil-works/pi-coding-agent")>()),
  highlightCode: (text: string) => text.split("\n"),
}));

const fixtureState = vi.hoisted(() => ({
  fault: undefined as ((file: string, boundary: string) => void) | undefined,
  packageRoot: undefined as string | undefined,
}));

vi.mock(import("../../../../../extensions/workflows/command/skills.js"), async (load) => {
  const original = await load();
  return {
    ...original,
    operateWorkflowSkillHosts: (options) =>
      original.operateWorkflowSkillHosts({
        ...options,
        ...(fixtureState.packageRoot ? { packageRoot: fixtureState.packageRoot } : {}),
        _testAtBoundary: (boundary, file) => {
          fixtureState.fault?.(file, boundary);
        },
      }),
  };
});

export const testHooks = fixtureState;
const roots: string[] = [];
afterEach(() => {
  fixtureState.fault = undefined;
  fixtureState.packageRoot = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function setup(mode: "tui" | "rpc" = "rpc", projectAtHome = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow-doctor-test-")));
  roots.push(root);
  const home = path.join(root, "home");
  const project = projectAtHome ? home : path.join(root, "project");
  mkdirSync(home);
  if (!projectAtHome) mkdirSync(project);
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  const harness = createHarness(project, { mode });
  workflows(harness.pi);
  const run = (input: string) => harness.commands.get("workflows")!.handler(input, harness.ctx);
  const text = () => [...harness.notifications, harness.widgets.get("workflows") ?? ""].join("\n");
  const fresh = async (input: string) => {
    harness.notifications.length = 0;
    await run(input);
    return text();
  };
  return { root, home, project, harness, run, text, fresh };
}
