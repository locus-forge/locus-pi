/** Static workflow metadata projected into named `/workflows info` output. */
import type { WorkflowMetaInfoSection, WorkflowMetaPhase } from "./workflow-meta.js";

/** Keep optional workflow-specific guidance beside the declared phase projection. */
export function declaredWorkflowMetaLines(
  phases: readonly WorkflowMetaPhase[],
  info: readonly WorkflowMetaInfoSection[],
): string[] {
  return [...declaredInfoLines(info), ...declaredPhaseLines(phases)];
}

function declaredInfoLines(info: readonly WorkflowMetaInfoSection[]): string[] {
  if (info.length === 0) return [];
  return ["workflow contract:", ...info.map((section) => `  ${section.title}: ${section.detail}`)];
}

/** A declaration describes intended shape; runtime phase evidence remains authoritative. */
function declaredPhaseLines(phases: readonly WorkflowMetaPhase[]): string[] {
  if (phases.length === 0) return [];
  return [
    `phases: ${phases.length} declared before the run starts (declaration, not enforcement)`,
    ...phases.map(
      (phase, index) => `  ${index + 1}. ${phase.title}${phase.detail === undefined ? "" : ` — ${phase.detail}`}`,
    ),
  ];
}
