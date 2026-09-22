/** Shared temporary-project setup for the workflow durable-execution test family. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentExecutor, AgentRunRequest } from "../../extensions/_shared/agent-runtime/agent-runner.js";

/** A throwaway project root that already carries the saved-workflow directory. */
export function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-durable-"));
  mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
  return root;
}

/** Save one single-file workflow into a project created by `project()`. */
export function writeWorkflow(root: string, name: string, source: string): void {
  writeFileSync(path.join(root, ".locus-pi", "workflows", `${name}.workflow.mjs`), source, "utf8");
}

/** Save a multi-entry workflow directory (an entry plus its owned children). */
export function writeWorkflowTree(root: string, name: string, entries: Record<string, string>): void {
  const directory = path.join(root, ".locus-pi", "workflows", name);
  mkdirSync(directory, { recursive: true });
  for (const [entry, source] of Object.entries(entries)) {
    writeFileSync(path.join(directory, `${entry}.workflow.mjs`), source, "utf8");
  }
}

function authoredPrompt(request: AgentRunRequest): string {
  return request.task.slice(request.task.lastIndexOf("\n\n---\n\n") + "\n\n---\n\n".length);
}

/** A stub agent executor that answers from the authored prompt alone. */
export function executor(
  run: (prompt: string, request: AgentRunRequest, signal: AbortSignal) => Promise<string> | string,
): () => AgentExecutor {
  return () => ({
    async run(request, signal) {
      try {
        const text = await run(authoredPrompt(request), request, signal);
        return {
          status: "completed" as const,
          agentName: request.agent?.name ?? "sub-agent",
          reason: "answered",
          text,
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      } catch (error) {
        return {
          status: "failed" as const,
          agentName: request.agent?.name ?? "sub-agent",
          reason: error instanceof Error ? error.message : String(error),
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      }
    },
  });
}

/** A saved child that writes one item and publishes the primary file for it. */
export const CHILD = `export const meta = { name: "child", profile: "standard" };
export default async function run(dsl, input) {
  await dsl.agent("write:" + input, { label: "write item" });
  return dsl.publishPrimaryFile(dsl.items()[0] + ".md");
}
`;

/** A root that fans its items out to `CHILD`, one saved child per item. */
export const PARENT = `export const meta = { name: "parent", profile: "standard" };
export default async function run(dsl, input) {
  const items = dsl.items();
  const results = [];
  for (const item of items) {
    results.push(await dsl.invokeWorkflow({
      name: "child",
      key: item,
      keys: items,
      input: input + ":" + item,
      items: [item],
      outputDir: dsl.outputDir(),
    }));
  }
  return results;
}
`;
