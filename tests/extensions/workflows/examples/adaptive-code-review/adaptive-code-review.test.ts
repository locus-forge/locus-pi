import { describe, expect, it } from "vitest";
import runAdaptiveReview, {
  meta,
} from "../../../../../examples/workflows/adaptive-code-review/adaptive-code-review.workflow.mjs";
import { createWorkflowArtifactStore } from "../../../../../extensions/workflows/runtime/workflow-artifacts.js";
import { ensureWorkflowRunDir } from "../../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../../../extensions/workflows/runtime/workflow-runtime.js";
import type { WorkflowAwaitOperatorDeclaration } from "../../../../../extensions/workflows/runtime/workflow-handoff-contract.js";
import { completed, temporaryValue } from "../../../../fixtures/scripted-agent-runtime.js";

type Intake = {
  status: "ready" | "needs_input";
  reviewMode: "adaptive" | "full";
  taskGoal: string;
  changeTarget: string;
  repositoryInstructions: string;
  reviewScope: string;
  changedOwnersAndContracts: string;
  callersAndConsumers: string;
  likelyImpact: string;
  evidenceSources: string;
  missingContextQuestion: string;
};

type Assignment = {
  id: string;
  lens: "code-standard" | "codebase-design";
  question: string;
  scope: string;
  evidenceTargets: string;
  resultContract: string;
  reason: string;
};

type Selection = {
  mode: "adaptive" | "full";
  summary: string;
  codeStandard: { disposition: "selected" | "skipped"; reason: string };
  codebaseDesign: { disposition: "selected" | "skipped"; reason: string };
  assignments: Assignment[];
};

type AdaptiveReviewInput = {
  reviewMode: "adaptive" | "full";
  task?: string;
  change?: string;
  repositoryInstructions?: string;
  reviewScope?: string;
};

const SMALL_INPUT = {
  reviewMode: "adaptive",
  task: "Update one internal formatter",
  change: "current diff",
  repositoryInstructions: "AGENTS.md",
  reviewScope: "formatter and direct callers",
} as const;

const READY_INTAKE: Intake = {
  status: "ready",
  reviewMode: "adaptive",
  taskGoal: "Update one internal formatter",
  changeTarget: "current diff",
  repositoryInstructions: "AGENTS.md",
  reviewScope: "formatter and direct callers",
  changedOwnersAndContracts: "formatter implementation; no public interface",
  callersAndConsumers: "two direct formatting callers",
  likelyImpact: "local rendering behavior",
  evidenceSources: "diff, formatter tests, direct callers",
  missingContextQuestion: "",
};

const STANDARD_ASSIGNMENT: Assignment = {
  id: "CS-001",
  lens: "code-standard",
  question: "Does the formatter change preserve the behavior its callers use?",
  scope: "formatter implementation and two direct callers",
  evidenceTargets: "current diff, callers, focused formatter tests",
  resultContract: "FINDINGS, NO_FINDING, or BLOCKED with evidence and limits",
  reason: "The local behavior changed and needs consumer verification.",
};

const DESIGN_ASSIGNMENT: Assignment = {
  id: "CD-001",
  lens: "codebase-design",
  question: "Does the public interface keep the guarantee at its existing owner?",
  scope: "public interface, implementation owner, and downstream consumers",
  evidenceTargets: "exports, callers, compatibility tests, owning documentation",
  resultContract: "FINDINGS, NO_FINDING, or BLOCKED with evidence and limits",
  reason: "The change crosses an interface and ownership boundary.",
};

const SMALL_SELECTION: Selection = {
  mode: "adaptive",
  summary: "One local consumer-contract review is sufficient.",
  codeStandard: { disposition: "selected", reason: "Behavior changed for direct callers." },
  codebaseDesign: { disposition: "skipped", reason: "No interface or owner boundary changed." },
  assignments: [STANDARD_ASSIGNMENT],
};

function accepted(request: WorkflowAgentRequest, value: unknown): WorkflowAgentResult {
  const structuredReceipt = {
    version: 4 as const,
    contract: request.returnContract,
    schemaSha256: "a".repeat(64),
    sourceIdentity: "unavailable" as const,
    inputIdentity: "unavailable" as const,
    observerRevision: "codex-responses-v3",
    value,
    allowances: {
      outputAttempts: 2,
      assistantTurns: "unbounded" as const,
      toolCalls: "unbounded" as const,
      timeoutMs: "unbounded" as const,
    },
    spent: { outputAttempts: 1, assistantTurns: 1, toolCalls: 1, elapsedMs: 1 },
    validation: "accepted" as const,
    customValidation: "absent" as const,
    rawTurns: [],
  };
  return {
    ...completed(request, request.returnContract === undefined ? String(value) : JSON.stringify(value)),
    ...(request.returnContract === undefined
      ? {}
      : {
          outputAcceptance: {
            source: "tool" as const,
            attempts: 1,
            toolName: "workflow_return" as const,
            structuredReceipt,
          },
        }),
  };
}

async function scenario(input: AdaptiveReviewInput, intake: Intake, selection: Selection, failedWorkerId?: string) {
  return temporaryValue(async (root) => {
    const runId = "adaptive-code-review-test";
    const store = createWorkflowArtifactStore({
      projectRoot: root,
      runId,
      runDir: ensureWorkflowRunDir(root, runId),
    });
    const requests: WorkflowAgentRequest[] = [];
    const handoffs: WorkflowAwaitOperatorDeclaration[] = [];
    const runtime = createWorkflowRuntime({
      runId,
      artifactPorts: store,
      onAwaitOperator: (declaration) => handoffs.push(declaration),
      agentRunner: async (request) => {
        requests.push(request);
        if (request.label === "collect-review-context") return accepted(request, intake);
        if (request.label === "select-review-assignments") return accepted(request, selection);
        if (request.label === "review-assignment") {
          const id = request.prompt.includes("CD-001") ? "CD-001" : "CS-001";
          if (id === failedWorkerId) {
            return {
              ok: false,
              status: "failed",
              failureCause: "provider-error",
              summary: `${id} reviewer unavailable`,
              diagnostics: ["provider refused the review call"],
            };
          }
          return accepted(request, `${id} NO_FINDING\nEvidence: exact caller and contract locations inspected.`);
        }
        expect(request.label).toBe("synthesize-adaptive-review");
        return accepted(
          request,
          "# Adaptive code review\n\nVerdict: READY\n\nAll selected evidence is preserved; skipped lanes are explained.",
        );
      },
    });

    const result = await runAdaptiveReview(runtime.dsl, input);
    return {
      result,
      requests,
      handoffs,
      primary: store.list().filter((record) => record.kind === "primary"),
      resultText: store.read(result).toString(),
      journal: runtime.getJournal(),
    };
  });
}

async function expectRejectedBeforeWorker(intake: Intake, selection: Selection, message: string) {
  return temporaryValue(async () => {
    const requests: WorkflowAgentRequest[] = [];
    const runtime = createWorkflowRuntime({
      runId: "adaptive-invalid-contract",
      agentRunner: async (request) => {
        requests.push(request);
        return accepted(request, request.label === "collect-review-context" ? intake : selection);
      },
    });
    await expect(runAdaptiveReview(runtime.dsl, SMALL_INPUT)).rejects.toThrow(message);
    expect(requests.some((request) => request.label === "review-assignment")).toBe(false);
    return requests;
  });
}

describe("adaptive-code-review packaged workflow", () => {
  it("declares typed adaptive input, dataflow checking, and complete operator info", () => {
    expect(meta.profile).toBe("dataflow-v1");
    expect(meta.inputSchema.required).toEqual(["reviewMode"]);
    expect(meta.inputSchema.properties.reviewMode.enum).toEqual(["adaptive", "full"]);
    expect(meta.info.map((section) => section.title)).toEqual([
      "Purpose",
      "Inputs",
      "Selection",
      "Full review",
      "Models",
      "Compatibility",
      "Artifact",
      "Continuation",
    ]);
  });

  it("selects one code-standard assignment for a small internal change and publishes one report", async () => {
    const { requests, primary, resultText } = await scenario(SMALL_INPUT, READY_INTAKE, SMALL_SELECTION);
    const workers = requests.filter((request) => request.label === "review-assignment");
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ modelRole: "agent:high", requireModelRole: true });
    expect(workers[0]!.prompt).toContain("Required lens/skill: code-standard");
    expect(workers[0]!.prompt).toContain("Read its complete SKILL.md and every mandatory example or reference");
    expect(workers[0]!.prompt).toContain(STANDARD_ASSIGNMENT.question);

    const selection = requests.find((request) => request.label === "select-review-assignments")!;
    expect(selection).toMatchObject({ modelRole: "task:xhigh", requireModelRole: true });
    expect(selection.prompt).toContain(READY_INTAKE.changedOwnersAndContracts);

    const synthesis = requests.find((request) => request.label === "synthesize-adaptive-review")!;
    expect(synthesis.prompt).toContain('"disposition": "skipped"');
    expect(synthesis.prompt).toContain("No interface or owner boundary changed.");
    expect(synthesis.prompt).toContain("Workflow agent execution report");
    expect(synthesis.prompt).toContain("Label: review-assignment");
    expect(synthesis.prompt).toContain("CS-001 NO_FINDING");
    expect(synthesis.prompt).toContain("code-standard conclusion");
    expect(synthesis.prompt).toContain("codebase-design conclusion");

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.prompt).toContain("repository and Git state as read-only");
    }

    expect(primary).toHaveLength(1);
    expect(primary[0]!.name).toBe("adaptive-code-review.md");
    expect(resultText).toContain("Verdict: READY");
  });

  it("rejects incomplete ready context and a nonactionable missing-context handoff", async () => {
    const incomplete = await expectRejectedBeforeWorker(
      { ...READY_INTAKE, taskGoal: " " },
      SMALL_SELECTION,
      "Ready review context must provide every explicit context field",
    );
    expect(incomplete.map((request) => request.label)).toEqual(["collect-review-context"]);

    const nonactionable = await expectRejectedBeforeWorker(
      { ...READY_INTAKE, status: "needs_input", missingContextQuestion: " " },
      SMALL_SELECTION,
      "Missing review context requires one nonblank operator question",
    );
    expect(nonactionable.map((request) => request.label)).toEqual(["collect-review-context"]);
  });

  it("rejects an incomplete assignment contract before starting a worker", async () => {
    const requests = await expectRejectedBeforeWorker(
      READY_INTAKE,
      { ...SMALL_SELECTION, assignments: [{ ...STANDARD_ASSIGNMENT, question: " " }] },
      "Every review assignment must have a complete nonblank contract",
    );
    expect(requests.map((request) => request.label)).toEqual(["collect-review-context", "select-review-assignments"]);
  });

  it("selects both lenses for an interface change and runs them behind one keyed barrier", async () => {
    const intake = {
      ...READY_INTAKE,
      changedOwnersAndContracts: "public interface and implementation owner",
      callersAndConsumers: "three downstream package consumers",
      likelyImpact: "public compatibility and ownership",
    };
    const selection: Selection = {
      mode: "adaptive",
      summary: "The interface change needs consumer and owner review.",
      codeStandard: { disposition: "selected", reason: "Public consumers must retain contract behavior." },
      codebaseDesign: { disposition: "selected", reason: "The owner/interface boundary changed." },
      assignments: [STANDARD_ASSIGNMENT, DESIGN_ASSIGNMENT],
    };
    const { requests, journal } = await scenario(
      { ...SMALL_INPUT, task: "Change a public interface", reviewScope: "interface and consumers" },
      intake,
      selection,
    );

    const workers = requests.filter((request) => request.label === "review-assignment");
    expect(workers).toHaveLength(2);
    expect(workers.map((request) => request.prompt)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Required lens/skill: code-standard"),
        expect.stringContaining("Required lens/skill: codebase-design"),
      ]),
    );
    expect(journal.filter((line) => line.kind === "group_start")).toEqual([
      expect.objectContaining({
        groupKind: "parallel",
        groupLabel: "Selected adaptive review assignments",
        groupTotal: 2,
        groupKeys: ["CS-001", "CD-001"],
      }),
    ]);
  });

  it("enforces both lenses for full mode before starting any worker", async () => {
    const selection = { ...SMALL_SELECTION, mode: "full" as const };
    await temporaryValue(async (root) => {
      const requests: WorkflowAgentRequest[] = [];
      const runtime = createWorkflowRuntime({
        runId: "adaptive-full-invariant",
        agentRunner: async (request) => {
          requests.push(request);
          if (request.label === "collect-review-context") {
            return accepted(request, { ...READY_INTAKE, reviewMode: "full" });
          }
          return accepted(request, selection);
        },
      });
      await expect(runAdaptiveReview(runtime.dsl, { ...SMALL_INPUT, reviewMode: "full" })).rejects.toThrow(
        "Full review mode requires both review lenses",
      );
      expect(requests.filter((request) => request.label === "review-assignment")).toHaveLength(0);
    });
  });

  it("runs both lenses for a valid explicit full override", async () => {
    const selection: Selection = {
      mode: "full",
      summary: "Full mode requires both lenses.",
      codeStandard: { disposition: "selected", reason: "Explicit full-review override." },
      codebaseDesign: { disposition: "selected", reason: "Explicit full-review override." },
      assignments: [STANDARD_ASSIGNMENT, DESIGN_ASSIGNMENT],
    };
    const { requests } = await scenario(
      { ...SMALL_INPUT, reviewMode: "full" },
      { ...READY_INTAKE, reviewMode: "full" },
      selection,
    );
    expect(requests.filter((request) => request.label === "review-assignment")).toHaveLength(2);
  });

  it("preserves an eligible failed worker as synthesis evidence and still publishes the report", async () => {
    const selection: Selection = {
      mode: "adaptive",
      summary: "Both lenses are required for the interface change.",
      codeStandard: { disposition: "selected", reason: "Verify supported consumers." },
      codebaseDesign: { disposition: "selected", reason: "Verify the owner boundary." },
      assignments: [STANDARD_ASSIGNMENT, DESIGN_ASSIGNMENT],
    };
    const { requests, primary } = await scenario(
      { ...SMALL_INPUT, task: "Change a public interface" },
      { ...READY_INTAKE, changedOwnersAndContracts: "public interface owner" },
      selection,
      "CD-001",
    );
    const synthesis = requests.find((request) => request.label === "synthesize-adaptive-review")!;
    expect(synthesis.prompt).toContain("Execution: failed");
    expect(synthesis.prompt).toContain("Cause: provider-error");
    expect(synthesis.prompt).toContain("CD-001 reviewer unavailable");
    expect(primary).toHaveLength(1);
  });

  it("creates one actionable handoff and passes typed continuation answers to fresh intake", async () => {
    await temporaryValue(async (root) => {
      const prompts: string[] = [];
      const handoffs: WorkflowAwaitOperatorDeclaration[] = [];
      const runId = "adaptive-missing-context";
      const store = createWorkflowArtifactStore({
        projectRoot: root,
        runId,
        runDir: ensureWorkflowRunDir(root, runId),
      });
      const missing: Intake = {
        ...READY_INTAKE,
        status: "needs_input",
        taskGoal: "",
        missingContextQuestion: "Which accepted task defines the intended formatter behavior?",
      };
      const runtime = createWorkflowRuntime({
        runId,
        artifactPorts: store,
        onAwaitOperator: (declaration) => handoffs.push(declaration),
        agentRunner: async (request) => {
          prompts.push(request.prompt);
          return accepted(request, missing);
        },
      });

      await runAdaptiveReview(runtime.dsl, { reviewMode: "adaptive", change: "current diff" });
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]!.operatorHandoff?.questions).toHaveLength(1);
      expect(handoffs[0]!.operatorHandoff?.continuationArtifactRefs).toHaveLength(1);
      expect(store.list().filter((record) => record.name === "adaptive-code-review-intake.md")).toHaveLength(1);
      expect(prompts).toHaveLength(1);

      const continued = createWorkflowRuntime({
        runId: "adaptive-missing-context-child",
        agentRunner: async (request) => {
          prompts.push(request.prompt);
          return accepted(request, missing);
        },
        onAwaitOperator: () => void 0,
      });
      await expect(
        runAdaptiveReview(
          continued.dsl,
          { reviewMode: "adaptive", change: "current diff" },
          {
            operatorAnswer: "Task T-42 defines the accepted formatter behavior.",
          },
        ),
      ).rejects.toThrow("workflow artifact store is not configured");
      expect(prompts.at(-1)).toContain("Task T-42 defines the accepted formatter behavior.");
      expect(prompts.at(-1)).toContain('"change": "current diff"');
    });
  });

  it("stops at structured intake when the v4 output contract is unavailable", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const runtime = createWorkflowRuntime({
      runId: "adaptive-v4-unavailable",
      agentRunner: async (request) => {
        requests.push(request);
        return {
          ok: false,
          status: "failed",
          failureCause: "output-contract-unavailable",
          summary: "structured output contract unavailable",
          diagnostics: ["Pi >=1.0.0 compatible Responses route required"],
        };
      },
    });

    await expect(runAdaptiveReview(runtime.dsl, SMALL_INPUT)).rejects.toThrow(
      /structured output contract unavailable/u,
    );
    expect(requests.map((request) => request.label)).toEqual(["collect-review-context"]);
  });
});
