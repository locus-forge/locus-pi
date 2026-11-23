import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

it("starts an empty Pi session with the live selection and keeps ordinary new sessions at their defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-clean-"));
  const provider = "clean-fixture";
  const client = new RpcClient({
    cwd: dir,
    cliPath: resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    env: { PI_CODING_AGENT_DIR: dir, PI_MODEL_ROLES_HOME: dir, PI_OFFLINE: "1" },
    args: [
      "--no-extensions",
      "-e",
      resolve("extensions/model/index.ts"),
      "--no-mcp",
      "--no-skills",
      "--no-context-files",
    ],
  });
  try {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ defaultProvider: provider, defaultModel: "baseline", defaultThinkingLevel: "off" }),
    );
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          [provider]: {
            baseUrl: "http://127.0.0.1:1",
            api: "openai-completions",
            apiKey: "offline-fixture",
            models: [{ id: "baseline" }, { id: "selected", reasoning: true, thinkingLevelMap: { max: "max" } }],
          },
        },
      }),
    );
    await client.start();
    expect(await client.getCommands()).toContainEqual(expect.objectContaining({ name: "clean" }));
    const previous = SessionManager.create(dir, dir);
    const message = { role: "user" as const, content: "Previous conversation", timestamp: Date.now() };
    previous.appendMessage(message);
    const previousFile = previous.getSessionFile()!;
    await client.switchSession(previousFile);
    await client.setModel(provider, "selected");
    await client.setThinkingLevel("max");
    const before = await client.getState();
    expect(before.messageCount).toBeGreaterThan(0);
    expect(before.thinkingLevel).toBe("max");

    await client.prompt("/clean");

    const after = await client.getState();
    expect(after.sessionId).not.toBe(before.sessionId);
    expect(after).toMatchObject({ model: { provider, id: "selected" }, thinkingLevel: "max", messageCount: 0 });

    await client.newSession();
    expect(await client.getState()).toMatchObject({ model: { provider, id: "baseline" }, thinkingLevel: "off" });

    await client.switchSession(previousFile);
    expect(await client.getMessages()).toContainEqual(message);
    expect(await client.getState()).toMatchObject({
      sessionId: before.sessionId,
      model: { provider, id: "selected" },
      thinkingLevel: "max",
    });
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
