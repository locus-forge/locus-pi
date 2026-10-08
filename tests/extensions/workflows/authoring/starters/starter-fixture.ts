import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { completed, tempRun, temporaryValue } from "../../../../fixtures/scripted-agent-runtime.js";
import { createWorkflowArtifactStore } from "../../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../../../extensions/workflows/runtime/workflow-runtime.js";

const base = "extensions/workflows/references/examples/starters";
const input = "Deliver the requested outcome; retain required checks and uncertainty.\nSources: task.md";

/** Execute a checked starter with scripted ordinary file tools and inspect its native/text evidence. */
type ChildEffect = (request: WorkflowAgentRequest, occurrence: number, workspace: string) => void | Promise<void>;

export async function runStarter(
  name: string,
  answers: Record<string, Array<string | WorkflowAgentResult>>,
  effect?: ChildEffect,
  items: string[] = [],
  taskInput = input,
) {
  return temporaryValue(async (root) => {
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    const assigned = path.join(root, "orchestration");
    mkdirSync(assigned);
    const names = [
      "guide.md",
      "purpose.md",
      "commands.md",
      "audit.md",
      "implementation.md",
      "findings.md",
      "plan.md",
      "next-step.md",
      "delivery.md",
      "document.md",
    ];
    const wholeInput = `${taskInput}\nExpected checkout: ${root}\nProduct root: ${path.join(root, "product")}\nOrchestration/evidence folder: ${assigned}\nExact file destinations:\n${names.map((file) => `${file}: ${path.join(assigned, file)}`).join("\n")}`;
    const seen: WorkflowAgentRequest[] = [];
    const counts: Record<string, number> = {};
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: name, runDir: tempRun(root, name) });
    const runtime = createWorkflowRuntime({
      runId: name,
      projectRoot: root,
      workspaceDir: workspace,
      items,
      artifactPorts: store,
      agentRunner: async (request) => {
        seen.push(request);
        const label = request.label!;
        const occurrence = counts[label] ?? 0;
        counts[label] = occurrence + 1;
        expect(request.prompt).toContain(wholeInput);
        await effect?.(request, occurrence, assigned);
        const script = answers[label];
        expect(script, `unscripted child: ${label}`).toBeDefined();
        const answer = script![occurrence] ?? script!.at(-1)!;
        if (typeof answer !== "string") return answer;
        const written =
          name === "caller-audit" && label === "synthesize"
            ? "audit.md"
            : name === "plan-replan" && label === "deliver"
              ? "delivery.md"
              : (name === "reflection" || name === "parallel-reflection") && label === "revise"
                ? "document.md"
                : undefined;
        if (written) {
          expect(request.prompt).toMatch(/(?:Write|write).*?(?:assigned|exact)/su);
          writeFileSync(path.join(assigned, written), answer);
        }
        return {
          ...completed(request, request.returnContract ? JSON.stringify(answer) : answer),
          ...(request.returnContract
            ? { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }
            : {}),
        };
      },
    });
    const module = await import(pathToFileURL(path.resolve(`${base}/${name}.workflow.mjs`)).href);
    const result = await module.default(runtime.dsl, wholeInput);
    const artifacts = store.list().map((record) => ({
      ...record,
      text: store
        .read({ runId: record.runId, artifactId: record.artifactId, name: record.name, sha256: record.sha256 })
        .toString(),
    }));
    return {
      result,
      seen,
      counts,
      journal: runtime.getJournal(),
      files: Object.fromEntries(
        readdirSync(assigned).map((file) => [file, readFileSync(path.join(assigned, file), "utf8")]),
      ),
      artifacts,
      primary: artifacts.filter((record) => record.kind === "primary").map((record) => record.text),
      published: artifacts.filter((record) => record.kind === "published").map((record) => record.text),
    };
  });
}
