import { describe, expect, it } from "vitest";
import { evaluateEvidence } from "../../../extensions/_shared/agent-runtime/agent-evidence-evaluator.js";
import type { EvidenceEvaluationInput } from "../../../extensions/_shared/agent-runtime/agent-evidence-evaluator.js";

const baseInput: EvidenceEvaluationInput = {
  agentName: "default",
  policy: { mode: "none" },
  toolCallCount: 0,
  toolResultCount: 0,
  observedToolNames: [],
  outputText: "This can be answered from reasoning.",
  status: "completed",
};

describe("evaluateEvidence", () => {
  it("returns reasoning_only without warnings for a default agent with no tool calls", () => {
    const result = evaluateEvidence(baseInput);

    expect(result).toEqual({
      evidence: "reasoning_only",
      warnings: [],
      missingRequiredTools: [],
      observedTools: [],
    });
  });

  it("does not mistake read-only requirements prose for a runtime-work claim", () => {
    const result = evaluateEvidence({
      ...baseInput,
      outputText: "The requested command and repository workflow are read-only.",
    });

    expect(result.evidence).toBe("reasoning_only");
    expect(result.warnings).toEqual([]);
  });

  it("returns missing_expected_evidence and a warning for scout warn mode with no tool calls", () => {
    const result = evaluateEvidence({
      ...baseInput,
      agentName: "scout",
      policy: { mode: "warn", requireAnyToolCall: true },
    });

    expect(result.evidence).toBe("missing_expected_evidence");
    expect(result.warnings).toEqual([
      "scout is missing expected runtime evidence (<any tool call>); mode=warn allows the run status to remain completed.",
    ]);
    expect(result.missingRequiredTools).toEqual(["<any tool call>"]);
    expect(result.observedTools).toEqual([]);
  });

  it("returns missing_expected_evidence with require-severity warning for implementer missing required tools", () => {
    const result = evaluateEvidence({
      ...baseInput,
      agentName: "implementer",
      policy: { mode: "require", requireAnyOf: ["bash", "apply_patch"] },
      toolCallCount: 1,
      toolResultCount: 1,
      observedToolNames: ["read_file"],
    });

    expect(result.evidence).toBe("missing_expected_evidence");
    expect(result.warnings).toEqual([
      "implementer is missing required runtime evidence (bash, apply_patch); mode=require should be mapped by the caller to failed or needs_review.",
    ]);
    expect(result.missingRequiredTools).toEqual(["bash", "apply_patch"]);
    expect(result.observedTools).toEqual(["read_file"]);
  });

  it("returns claims_without_evidence when output claims runtime work but trace is empty", () => {
    const result = evaluateEvidence({
      ...baseInput,
      agentName: "tester",
      policy: { mode: "warn", claimsWithoutEvidence: "warn" },
      outputText: "I read the files, changed the code, and ran tests.",
    });

    expect(result.evidence).toBe("claims_without_evidence");
    expect(result.warnings).toEqual([
      "tester claims runtime work, but the child trace has no tool calls or tool results.",
    ]);
    expect(result.missingRequiredTools).toEqual([]);
  });

  it("returns evidence_backed when expected tools are observed", () => {
    const result = evaluateEvidence({
      ...baseInput,
      agentName: "tester",
      policy: { mode: "require", requireAnyOf: ["bash", "apply_patch"] },
      toolCallCount: 2,
      toolResultCount: 2,
      observedToolNames: ["apply_patch", "bash", "bash"],
      outputText: "Done.",
    });

    expect(result).toEqual({
      evidence: "evidence_backed",
      warnings: [],
      missingRequiredTools: [],
      observedTools: ["apply_patch", "bash"],
    });
  });
});
