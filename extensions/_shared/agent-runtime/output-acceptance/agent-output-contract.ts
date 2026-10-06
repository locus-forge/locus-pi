import type { AgentFailureCause } from "../agent-failure-cause.js";

export function supportsObservedOutputVersion(version: string | undefined): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:([-+]).*)?$/u.exec(version ?? "");
  return (
    parts !== null &&
    Number(parts[1]) >= 1 &&
    !(parts[1] === "1" && parts[2] === "0" && parts[3] === "0" && parts[4] === "-")
  );
}

/** Caller-owned output acceptance; the SDK host owns session lifecycle and cumulative budgets. */
export interface AgentResponseAcceptance {
  /** Strict raw-protocol acceptance requires actual host hooks before any dispatch. */
  observedReturn?: AgentObservedReturn;
  executionLedger?: AgentExecutionLedger;
  toolNames: readonly string[];
  bindToolRestriction(restrict: () => void): void;
  inspect():
    | {
        status: "accepted";
        text: string;
        attempts: number;
        toolName: string;
        structuredReceipt?: AgentStructuredReceipt;
      }
    | { status: "retry"; prompt: string }
    | { status: "failed"; reason: string; failureCause?: AgentFailureCause };
}

export interface AgentExecutionLedger {
  toolCalls: number;
  admittedToolCalls: number;
  assistantTurns: number;
  toolNames: Set<string>;
  deadline?: number;
}
/** The caller understands provider data; the shared host only chains lifecycle hooks. */
export interface AgentObservedReturn {
  observationLost(): void;
  initialize(): Promise<void>;
  beforeRequest(context: unknown): void;
  providerEvent(event: unknown, model: unknown): void;
  beforeTool(context: unknown): { block?: boolean; reason?: string; terminate?: boolean } | undefined;
  finishTurn(context: unknown): { action: "end" } | undefined;
}
export interface AgentStructuredReceipt {
  version: 4;
  contract: unknown;
  schemaSha256: string;
  sourceIdentity: string | "unavailable";
  inputIdentity: string | "unavailable";
  observerRevision: string;
  value: unknown;
  allowances: {
    outputAttempts: number;
    assistantTurns: number | "unbounded";
    toolCalls: number | "unbounded";
    timeoutMs: number | "unbounded";
  };
  spent: { outputAttempts: number; assistantTurns: number; toolCalls: number; elapsedMs: number };
  rawTurns: readonly {
    responseId: string;
    terminal: "completed";
    workTools: boolean;
    calls: readonly { callId: string; arguments: string; validation: "accepted" | "rejected" | "duplicate" }[];
  }[];
  validation: "accepted";
  customValidation: "accepted" | "absent";
}

export interface AgentOutputAcceptance {
  source: "tool";
  contractVersion?: 4;
  attempts: number;
  toolName: string;
  structuredReceipt?: AgentStructuredReceipt;
}
