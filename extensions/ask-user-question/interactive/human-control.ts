import type { ExtensionAPI, ExtensionContext } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getSessionId, getWorkingDirectory } from "../../_shared/host/pi-api.js";
import {
  createSessionStore,
  selectSessionStoreBackend,
  type SessionStoreBackend,
} from "../../_shared/runtime/runtime-capabilities.js";

export interface HumanDecisionInput {
  decisionId?: string;
  question?: string;
  answer?: unknown;
  status: "answered" | "cancelled" | "deferred";
  source: string;
  metadata?: Record<string, unknown>;
}

export interface HumanDecisionRecord {
  decisionId: string;
  backend: SessionStoreBackend;
  diagnostics: string[];
}

export async function recordDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: HumanDecisionInput,
): Promise<HumanDecisionRecord> {
  const decisionId = input.decisionId ?? stableDecisionId(input.source, input.question ?? input.status);
  const metadata = {
    source: input.source,
    ...(input.metadata ?? {}),
  };
  const payload: {
    decisionId: string;
    question?: string;
    answer?: unknown;
    status: "answered" | "cancelled" | "deferred";
    metadata: Record<string, unknown>;
  } = {
    decisionId,
    status: input.status,
    metadata,
  };
  if (input.question !== undefined) payload.question = input.question;
  if (input.answer !== undefined) payload.answer = input.answer;
  const backend = selectSessionStoreBackend();
  const diagnostics: string[] = [];
  if (backend === "jsonl") {
    const store = createSessionStore({ projectRoot: getProjectRoot(ctx), backend: "jsonl" });
    const sessionId = ensureRuntimeSession(store, ctx);
    store.appendEntry(sessionId, { type: "decision", payload });
    if ("diagnostics" in store) diagnostics.push(...store.diagnostics);
  }
  await pi.appendEntry("decision", payload);
  return { decisionId, backend, diagnostics };
}

export function stableDecisionId(source: string, seed: string): string {
  return (
    `${source}-${seed}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "decision"
  );
}

function ensureRuntimeSession(store: ReturnType<typeof createSessionStore>, ctx: ExtensionContext): string {
  const sessionId = getSessionId(ctx);
  if (store.getSession(sessionId) === undefined) {
    store.createSession({
      id: sessionId,
      projectRoot: getProjectRoot(ctx),
      workingDirectory: getWorkingDirectory(ctx),
    });
  }
  return sessionId;
}
