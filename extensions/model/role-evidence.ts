/**
 * extensions/model/role-evidence.ts — the two durable records a model-role
 * assignment leaves behind: the Pi session custom entry and the runtime-store
 * `model_role_runtime_event`. Both are best-effort and report whether they
 * landed, so the receipt built in `role-apply.ts` can warn instead of claiming
 * evidence it does not have.
 */

import {
  formatAssignment,
  MODEL_ROLES_SESSION_ENTRY_TYPE,
  type ModelRoleAssignment,
  type ModelRoleSessionEntry,
} from "../_shared/model/model-settings.js";
import type { ExtensionAPI, ExtensionContext, ThinkingLevel } from "../_shared/host/pi-api.js";
import { getProjectRoot, getSessionId, getWorkingDirectory } from "../_shared/host/pi-api.js";
import { createSessionStore, getRuntimeCapabilityReport } from "../_shared/runtime/runtime-capabilities.js";

export interface ModelRoleRuntimeEvent {
  role: string;
  assignment: string;
  requestedThinking: ThinkingLevel;
  beforeModel: string | undefined;
  currentModel: string | undefined;
  currentThinking: ThinkingLevel | undefined;
  modelApplied: boolean;
  thinkingApplied: boolean;
  rolePersisted: boolean;
  rolePersistenceError?: string;
  lockReleaseError?: string;
  customEntryAppended: boolean;
  configPath: string;
}

export async function appendModelRoleEntry(
  pi: ExtensionAPI,
  role: string,
  assignment: ModelRoleAssignment,
  beforeSelector: string | undefined,
  currentSelector: string | undefined,
  modelApplied: boolean,
  rolePersisted = true,
): Promise<boolean> {
  const entry: ModelRoleSessionEntry = {
    version: 1,
    role,
    assignment: formatAssignment(assignment),
    modelApplied,
    rolePersisted,
  };
  try {
    await pi.appendEntry(MODEL_ROLES_SESSION_ENTRY_TYPE, {
      ...entry,
      beforeModel: beforeSelector,
      currentModel: currentSelector,
    });
    return true;
  } catch {
    return false;
  }
}

export function recordModelRoleRuntimeEvent(ctx: ExtensionContext, event: ModelRoleRuntimeEvent): boolean {
  const projectRoot = getProjectRoot(ctx);
  const sessionId = getSessionId(ctx);
  const report = getRuntimeCapabilityReport(projectRoot);
  try {
    const store = createSessionStore({ projectRoot });
    if (store.getSession(sessionId) === undefined) {
      store.createSession({
        id: sessionId,
        projectRoot,
        workingDirectory: getWorkingDirectory(ctx),
        metadata: { source: "model-roles" },
      });
    }
    store.appendEntry(sessionId, {
      type: "custom",
      payload: {
        type: "model_role_runtime_event",
        data: {
          version: 1,
          event: "model_role_applied",
          role: event.role,
          assignment: event.assignment,
          requestedThinking: event.requestedThinking,
          beforeModel: event.beforeModel,
          currentModel: event.currentModel,
          currentThinking: event.currentThinking,
          modelApplied: event.modelApplied,
          thinkingApplied: event.thinkingApplied,
          rolePersisted: event.rolePersisted,
          customEntryAppended: event.customEntryAppended,
          configPath: event.configPath,
          runtimeStore: {
            backend: report.sessionStoreBackend,
            durable: report.durableSessionStore,
            path: report.sessionStorePath,
            writable: report.sessionStoreWritable,
            diagnostics: report.diagnostics,
          },
          ...(event.rolePersistenceError === undefined ? {} : { rolePersistenceError: event.rolePersistenceError }),
          ...(event.lockReleaseError === undefined ? {} : { lockReleaseError: event.lockReleaseError }),
        },
      },
    });
    return true;
  } catch {
    return false;
  }
}
