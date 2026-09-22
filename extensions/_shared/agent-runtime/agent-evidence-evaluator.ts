import type { AgentEvidencePolicy } from "./agents.js";

/**
 * The evaluation contract lives here because `evaluateEvidence` below is the only producer
 * of an `EvidenceEvaluation` in the package, and the only consumer of the input shape. The
 * policy it grades against is parsed from agent frontmatter and therefore owned by
 * `agents.ts`; taking it type-only keeps this module free of that module's `node:fs`, which
 * is what lets the workflow core name the result type without pulling a host dependency in.
 */

/** The verdict values of `EvidenceEvaluation`; not named anywhere else, so module-private. */
type CompletionEvidence =
  "reasoning_only" | "evidence_backed" | "missing_expected_evidence" | "claims_without_evidence";

export interface EvidenceEvaluation {
  evidence: CompletionEvidence;
  warnings: string[];
  missingRequiredTools: string[];
  observedTools: string[];
}

export interface EvidenceEvaluationInput {
  agentName: string;
  policy: AgentEvidencePolicy;
  toolCallCount: number;
  toolResultCount: number;
  observedToolNames: string[];
  outputText: string;
  status: "blocked" | "running" | "completed" | "failed" | "cancelled";
}

const ANY_TOOL_CALL = "<any tool call>";
// Child agents are prompted in English, so this honesty check only matches English claims.
const CLAIM_WITHOUT_EVIDENCE_PATTERN =
  /\b(?:i|we)\s+(?:read|changed|edited|modified|updated|ran|run|executed)\b|\b(?:ran|run|executed)\s+(?:the\s+)?tests\b/iu;

export function evaluateEvidence(input: EvidenceEvaluationInput): EvidenceEvaluation {
  const observedTools = normalizeObservedTools(input.observedToolNames);
  const warnings: string[] = [];
  const traceIsEmpty = input.toolCallCount <= 0 && input.toolResultCount <= 0;

  if (input.policy.claimsWithoutEvidence !== "off" && traceIsEmpty && claimsConcreteRuntimeWork(input.outputText)) {
    warnings.push(`${input.agentName} claims runtime work, but the child trace has no tool calls or tool results.`);
    return {
      evidence: "claims_without_evidence",
      warnings,
      missingRequiredTools: [],
      observedTools,
    };
  }

  const missingRequiredTools = findMissingRequiredTools(input, observedTools);
  if (input.policy.mode !== "none" && missingRequiredTools.length > 0) {
    warnings.push(formatMissingEvidenceWarning(input.agentName, input.policy.mode, missingRequiredTools));
    return {
      evidence: "missing_expected_evidence",
      warnings,
      missingRequiredTools,
      observedTools,
    };
  }

  if (traceIsEmpty) {
    return {
      evidence: "reasoning_only",
      warnings,
      missingRequiredTools: [],
      observedTools,
    };
  }

  return {
    evidence: "evidence_backed",
    warnings,
    missingRequiredTools: [],
    observedTools,
  };
}

function normalizeObservedTools(toolNames: string[]): string[] {
  return [...new Set(toolNames.map((tool) => tool.trim()).filter(Boolean))].sort();
}

function findMissingRequiredTools(input: EvidenceEvaluationInput, observedTools: string[]): string[] {
  const missing: string[] = [];
  if (input.policy.requireAnyToolCall === true && input.toolCallCount <= 0) missing.push(ANY_TOOL_CALL);

  const requiredAnyOf = input.policy.requireAnyOf?.map((tool) => tool.trim()).filter(Boolean) ?? [];
  if (requiredAnyOf.length > 0 && !requiredAnyOf.some((tool) => observedTools.includes(tool))) {
    missing.push(...requiredAnyOf);
  }

  return [...new Set(missing)];
}

function claimsConcreteRuntimeWork(outputText: string): boolean {
  return CLAIM_WITHOUT_EVIDENCE_PATTERN.test(outputText);
}

function formatMissingEvidenceWarning(
  agentName: string,
  mode: "warn" | "require",
  missingRequiredTools: string[],
): string {
  const expected = missingRequiredTools.join(", ");
  if (mode === "require") {
    return `${agentName} is missing required runtime evidence (${expected}); mode=require should be mapped by the caller to failed or needs_review.`;
  }
  return `${agentName} is missing expected runtime evidence (${expected}); mode=warn allows the run status to remain completed.`;
}
