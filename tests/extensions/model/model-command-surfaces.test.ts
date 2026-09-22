import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import model from "../../../extensions/model/index.js";
import { roleSummaries } from "../../../extensions/model/model-role-selector.js";
import { modelRoleStatusContribution } from "../../../extensions/model/operator-surface.js";
import {
  buildModelRolesState,
  getModelRolesConfigPath,
  loadModelRolesState,
} from "../../../extensions/_shared/model/model-settings.js";
import { createHarness, emit, type Harness } from "../../test-harness.js";

const ENTER = "\r";
const DOWN = "\x1b[B";

const REASONING_MODELS = [
  { provider: "test", id: "fast", name: "Test Fast", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
  { provider: "test", id: "strong", name: "Test Strong", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
];

describe("model command surfaces", () => {
  let previousHome: string | undefined;
  let root: string;
  let harness: Harness;

  beforeEach(async () => {
    previousHome = process.env.PI_MODEL_ROLES_HOME;
    root = await mkdtemp(join(tmpdir(), "pi-model-surfaces-"));
    process.env.PI_MODEL_ROLES_HOME = join(root, "home");
    harness = createHarness(join(root, "project"), { models: REASONING_MODELS });
    model(harness.pi);
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PI_MODEL_ROLES_HOME;
    else process.env.PI_MODEL_ROLES_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  it("refuses to open the selector when the registry offers no models", async () => {
    const empty = createHarness(join(root, "empty-registry"), { models: [] });
    model(empty.pi);

    await empty.commands.get("model-roles")!.handler("", empty.ctx);

    expect(empty.customOptions).toHaveLength(0);
    expect(empty.widgets.get("model-roles")).toContain("[WARN] Model roles");
    expect(empty.widgets.get("model-roles")).toContain("No configured models are available");
    expect(empty.entries).toEqual([]);
    expect(empty.notifications).toEqual([]);
  });

  it("treats a host without a model registry as no models at all", async () => {
    delete harness.ctx.modelRegistry;

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    expect(harness.customOptions).toHaveLength(0);
    expect(harness.widgets.get("model-roles")).toContain("No configured models are available");
  });

  it("reports current model, effort, DEFAULT route and other routes in the read-only fallback", async () => {
    await writeJson(getModelRolesConfigPath(), {
      version: 1,
      roles: { default: "test/fast:high", agent: "test/strong:low" },
    });
    harness.ctx.model = REASONING_MODELS[0]!;
    harness.pi.setThinkingLevel?.("high");
    delete harness.ctx.ui.custom;

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const widget = harness.widgets.get("model-roles") ?? "";
    expect(widget).toContain("Current session model: test/fast");
    expect(widget).toContain("Current session effort: high");
    expect(widget).toContain("DEFAULT route: test/fast:high");
    expect(widget).toContain("Other routes: AGENT=test/strong:low");
    expect(widget).toContain("storage: ~/.pi/agent/model-roles/config.json");
  });

  it("names an unset model, unknown effort and unset routes when the host exposes neither", async () => {
    delete harness.pi.getThinkingLevel;
    delete harness.ctx.ui.custom;

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const widget = harness.widgets.get("model-roles") ?? "";
    expect(widget).toContain("Current session model: unset");
    expect(widget).toContain("Current session effort: unknown");
    expect(widget).toContain("DEFAULT route: unset");
    expect(widget).toContain("Other routes: none");
  });

  it("keeps the DEFAULT route unset when the host cannot switch the current model", async () => {
    delete harness.pi.setModel;
    harness.customInputQueue.push(ENTER, ENTER, ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const state = await loadModelRolesState();
    expect(state.effective.get("default")?.assignment).toBeUndefined();
    expect(joinFrames(harness)).toContain("[ERROR] Pi host did not expose current model switching for /model-roles.");
  });

  it("reports a thrown host model switch as the receipt error", async () => {
    harness.pi.setModel = () => {
      throw new Error("host exploded");
    };
    harness.customInputQueue.push(ENTER, ENTER, ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const state = await loadModelRolesState();
    expect(state.effective.get("default")?.assignment).toBeUndefined();
    expect(joinFrames(harness)).toContain("[ERROR] host exploded");
  });

  it("saves the route but warns when session evidence cannot be appended", async () => {
    harness.pi.appendEntry = async () => {
      throw new Error("no session");
    };
    harness.customInputQueue.push(ENTER, ENTER, ...repeat(DOWN, 4), ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const state = await loadModelRolesState();
    expect(state.effective.get("default")?.assignment).toEqual({ model: "test/fast", thinking: "high" });
    // The receipt wraps inside the selector frame, so it is pinned in the two
    // pieces the operator actually reads.
    const frames = joinFrames(harness);
    expect(frames).toContain("[WARN] DEFAULT → test/fast:high saved; Current session updated. Evidence");
    expect(frames).toContain("warning: session evidence unavailable.");
  });

  it("refuses an effort the selected model does not support without touching the route", async () => {
    const plain = createHarness(join(root, "plain-model"), {
      models: [{ provider: "test", id: "plain", name: "Plain", reasoning: false }],
    });
    model(plain.pi);
    plain.customInputQueue.push(ENTER, ENTER, ENTER, "q");

    await plain.commands.get("model-roles")!.handler("", plain.ctx);

    const state = await loadModelRolesState();
    expect(state.effective.get("default")?.assignment).toEqual({ model: "test/plain", thinking: "off" });
    expect(plain.thinkingLevel).toBe("off");
  });

  it("moves one strong focus from model to role to effort", async () => {
    const customTheme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    harness = createHarness(join(root, "project"), { models: REASONING_MODELS, customTheme });
    harness.ctx.model = REASONING_MODELS[0]!;
    model(harness.pi);
    harness.customInputQueue.push(ENTER, ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const frames = harness.customRenderFrames.map((lines) => lines.join("\n"));
    const models = frames.find((frame) => frame.includes("[models]")) ?? "";
    const roles = frames.find((frame) => frame.includes("[roles]")) ?? "";
    const effort = frames.find((frame) => frame.includes("[effort]")) ?? "";
    const fill = "\x1b[48;2;88;61;121m";
    expect(models.split(fill)).toHaveLength(3); // provider + model
    expect(roles.split(fill)).toHaveLength(3); // provider + role
    expect(roles).toContain(`[DEFAULT] ${fill}\x1b[38;2;248;241;255mSet as DEFAULT\x1b[0m`);
    expect(roles).not.toContain(`${fill}\x1b[38;2;248;241;255m> [CURRENT]`);
    expect(effort.split(fill)).toHaveLength(2); // effort only
    expect(effort).toContain(`${fill}\x1b[38;2;248;241;255moff\x1b[0m`);
  });

  it("names mode, current level and supported levels when the effort selector cannot open", async () => {
    const rpc = createHarness(join(root, "rpc-effort"), { models: REASONING_MODELS, mode: "rpc" });
    rpc.ctx.model = REASONING_MODELS[0]!;
    model(rpc.pi);

    await rpc.commands.get("effort")!.handler("", rpc.ctx);

    const widget = (rpc.widgetPayloads.get("effort") as string[]).join("\n");
    expect(widget).toContain("[WARN] Thinking effort");
    expect(widget).toContain("Interactive effort selection is unavailable in rpc mode.");
    expect(widget).toContain("Current: off");
    expect(widget).toContain("Scope: current Pi session");
    expect(rpc.thinkingLevel).toBeUndefined();
  });

  it("clears the routes status contribution while every role is unassigned", async () => {
    await emit(harness, "session_start");

    expect(modelRoleStatusContribution(roleSummaries(await loadModelRolesState()))).toBeUndefined();
    expect(harness.statuses.has("locus")).toBe(false);
    expect(harness.statuses.has("model-roles")).toBe(false);
  });

  it("abbreviates roles and counts the overflow in the routes contribution", () => {
    const state = buildModelRolesState("/user/config.json", {
      roles: { default: "openai/gpt-5.6:high", agent: "deepseek/v4:low", task: "openrouter/long-model-name" },
    });

    const contribution = modelRoleStatusContribution(roleSummaries(state));

    expect(contribution?.wide).toBe("routes DEFAULT=gpt-5.6 AGENT=v4 +1");
    expect(contribution?.compact).toBe("routes D:gpt-5.6 A:v4 +1");
    expect(contribution?.narrow).toBe("routes 3");
    expect(contribution?.priority).toBe(60);
  });
});

function repeat(value: string, count: number): string[] {
  return Array.from({ length: count }, () => value);
}

function joinFrames(harness: Harness): string {
  return harness.customRenderFrames.flat().join("\n");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
