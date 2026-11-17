export const AGENT_STARTUP_STAGES = [
  "agent_start",
  "model_roles_load_start",
  "model_roles_loaded",
  "model_resolve_start",
  "model_resolved",
  "capability_checked",
  "runner_enter",
  "sdk_host_enter",
  "sdk_import_start",
  "sdk_imported",
  "session_options_start",
  "session_manager_start",
  "session_manager_created",
  "resources_load_start",
  "resources_loaded",
  "create_session_start",
  "session_ready",
  "first_provider_request",
  "first_provider_response",
] as const;

export type AgentStartupStage = (typeof AGENT_STARTUP_STAGES)[number];

/** Internal snapshot immediately before admission; CPU values are process microseconds. */
export interface AgentStartupEpoch {
  ts: string;
  monotonicMs: number;
  cpu: { user: number; system: number };
}

export interface AgentStartupMark {
  stage: AgentStartupStage;
  ts: string;
  elapsedMs: number;
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  eventLoopDelayMs: number;
}

/** Persisted startup measurements are optional on legacy records, strict when present. */
export function agentStartupMarkProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "Startup mark must be an object.";
  const mark = value as Record<string, unknown>;
  const fields = ["elapsedMs", "wallMs", "cpuUserMs", "cpuSystemMs", "eventLoopDelayMs"];
  if (
    !AGENT_STARTUP_STAGES.includes(mark.stage as AgentStartupStage) ||
    typeof mark.ts !== "string" ||
    !Number.isFinite(Date.parse(mark.ts)) ||
    fields.some(
      (field) => typeof mark[field] !== "number" || !Number.isFinite(mark[field]) || (mark[field] as number) < 0,
    ) ||
    Object.keys(mark).some((field) => !["stage", "ts", ...fields].includes(field))
  ) {
    return "Startup mark must have a known stage, timestamp and non-negative finite measurements.";
  }
  return undefined;
}
