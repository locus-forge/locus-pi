import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** @param {string} stdout @param {string} answer */
export function assertAssistantResponse(stdout, answer) {
  const events = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const completed = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
  assert.equal(completed.length, 1, "Expected exactly one accepted assistant message_end");
  assert.equal(completed[0].message.stopReason, "stop");
  assert.deepEqual(completed[0].message.content, [{ type: "text", text: answer }]);
}

// This is an installed-artifact transport probe, not a supported alternate launcher.
/** @param {string} consumerRoot @param {NodeJS.ProcessEnv} env @param {string} profile @param {string} evidenceDirectory */
export async function verifyConsumerTransport(consumerRoot, env, profile, evidenceDirectory) {
  mkdirSync(evidenceDirectory, { recursive: true });
  const piRoot = path.join(consumerRoot, "node_modules/@earendil-works/pi-coding-agent");
  const manifest = JSON.parse(readFileSync(path.join(piRoot, "package.json"), "utf8"));
  /** @type {{method: string | undefined, url: string | undefined, body: string}[]} */
  const requests = [];
  const answer = "locus-local-http-response";
  const prompt = "locus-local-http-request";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    /** @param {{role?: string, content?: string}} delta @param {string | null} finish_reason */
    const chunk = (delta, finish_reason) => ({
      id: "local-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "local-model",
      choices: [{ index: 0, delta, finish_reason }],
    });
    response.end(
      `data: ${JSON.stringify(chunk({ role: "assistant", content: answer }, null))}\n\n` +
        `data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const agentDir = path.join(consumerRoot, "transport-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "local-probe": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "local-fixture-only",
            models: [
              {
                id: "local-model",
                name: "Local fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 64,
              },
            ],
          },
        },
      }),
    );
    const observer = path.join(consumerRoot, "observe-transport.mjs");
    writeFileSync(
      observer,
      `import { fetch } from "undici";\nprocess.on("exit", () => console.error("TRANSPORT " + JSON.stringify({ externalFetch: globalThis.fetch === fetch })));\n`,
    );
    const results = [];
    /** @type {[string, string, boolean][]} */
    const entries = [
      ["manifest-bin", manifest.bin.pi, false],
      ["diagnostic-unbundled", "dist/cli.js", true],
    ];
    for (const [kind, entry, externalFetch] of entries) {
      requests.length = 0;
      /** @type {{stdout: string, stderr: string, exitCode: number | null, signal: string | null, timedOut: boolean, error: string | null}} */
      const output = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            observer,
            path.join(piRoot, entry),
            "--provider",
            "local-probe",
            "--model",
            "local-model",
            "--mode",
            "json",
            "--print",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--tools",
            "",
            prompt,
          ],
          {
            cwd: consumerRoot,
            env: { ...env, PI_CODING_AGENT_DIR: agentDir },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 30_000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: null, signal: null, timedOut, error: error.message });
        });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code, signal, timedOut, error: null });
        });
      });
      const receipt = { kind, entry, ...output, requests: [...requests] };
      const prefix = path.join(evidenceDirectory, `${profile}-${kind}`);
      writeFileSync(prefix + ".stdout", output.stdout);
      writeFileSync(prefix + ".stderr", output.stderr);
      writeFileSync(prefix + ".json", JSON.stringify(receipt, null, 2) + "\n");
      assert.equal(output.error, null, `${profile}/${kind}: spawn error`);
      assert.equal(output.timedOut, false, `${profile}/${kind}: HTTP probe timed out`);
      assert.equal(output.exitCode, 0, `${profile}/${kind}: subprocess failed`);
      assert.equal(output.signal, null);
      assert.equal(requests.length, 1, `${profile}/${kind}: expected one HTTP request`);
      const received = requests[0];
      assert(received);
      assert.equal(received.method, "POST");
      assert.equal(received.url, "/v1/chat/completions");
      /** @type {{model: string, stream: boolean, messages: {role: string, content: unknown}[]}} */
      const request = JSON.parse(received.body);
      assert.equal(request.model, "local-model");
      assert.equal(request.stream, true);
      assert(
        request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(prompt)),
      );
      assertAssistantResponse(output.stdout, answer);
      const observations = output.stderr.split("\n").filter((line) => line.startsWith("TRANSPORT "));
      assert.equal(observations.length, 1);
      assert(observations[0]);
      assert.deepEqual(JSON.parse(observations[0].slice(10)), { externalFetch });
      results.push({
        kind,
        entry,
        requests: requests.length,
        assistantResponse: answer,
        stopReason: "stop",
        externalFetch,
        stdout: output.stdout,
        stderr: output.stderr,
        request: received,
        exitCode: output.exitCode,
      });
    }
    return results;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
