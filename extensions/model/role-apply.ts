/**
 * extensions/model/role-apply.ts — what happens when the selector applies one
 * route: validate the model/effort pair, mutate the Pi session only when the
 * chosen role owns the current model, persist the route, record both evidence
 * trails (`role-evidence.ts`), and turn all of that into the single receipt the
 * selector shows.
 */

import {
  formatAssignment,
  getModelRolesConfigPath,
  setModelRoleSetting,
  type ModelRoleAssignment,
} from "../_shared/model/model-settings.js";
import type { ExtensionAPI, ExtensionContext, ModelLike, ThinkingLevel } from "../_shared/host/pi-api.js";
import { errorMessage } from "../_shared/host/error-text.js";
import {
  effortLevelsForModel,
  modelSelector,
  type AppliedModelRoleState,
  type ModelRoleSelection,
} from "./model-role-selector.js";
import { currentModelRoleState, updateModelRoleStatus } from "./operator-surface.js";
import { appendModelRoleEntry, recordModelRoleRuntimeEvent } from "./role-evidence.js";

export async function applyModelRole(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selection: ModelRoleSelection,
): Promise<AppliedModelRoleState> {
  const assignment = assignmentFromModel(selection.model, selection.thinking);
  if (!assignment) {
    return {
      ...(await currentModelRoleState(pi, ctx, undefined)),
      receipt: { kind: "error", text: "Selected model has no canonical provider/model selector." },
    };
  }

  const supportedEfforts = effortLevelsForModel(selection.model);
  if (!supportedEfforts.includes(selection.thinking)) {
    const message = `${selection.thinking} is not supported by ${assignment.model}; route was not saved.`;
    return {
      ...(await currentModelRoleState(pi, ctx, undefined)),
      receipt: { kind: "error", text: message },
    };
  }

  const targetSelector = formatAssignment(assignment);
  const beforeSelector = ctx.model ? modelSelector(ctx.model) : undefined;
  const beforeThinking = pi.getThinkingLevel?.();
  const shouldApplyModel = selection.action.appliesCurrentModel;
  let currentSelector = beforeSelector;
  let currentThinking = beforeThinking;
  let modelApplied = false;
  let thinkingApplied = false;
  let rolePersisted = false;
  let rolePersistenceError: string | undefined;
  let lockReleaseError: string | undefined;
  let applyError: string | undefined;
  if (!shouldApplyModel) {
    modelApplied = false;
    thinkingApplied = false;
  } else if (!pi.setModel) {
    applyError = "Pi host did not expose current model switching for /model-roles.";
  } else if (!pi.setThinkingLevel || !pi.getThinkingLevel) {
    applyError = "Pi host did not expose verified thinking-level control for /model-roles.";
  } else {
    try {
      const selected = await pi.setModel(selection.model);
      if (selected === false) {
        applyError = "Pi host refused the selected model for /model-roles.";
      } else {
        currentSelector = ctx.model ? modelSelector(ctx.model) : undefined;
        modelApplied = currentSelector === assignment.model;
        if (!modelApplied) {
          applyError = `Pi accepted the model switch, but Current session stayed ${currentSelector ?? "unset"}.`;
        } else {
          pi.setThinkingLevel(selection.thinking);
          currentThinking = pi.getThinkingLevel();
          thinkingApplied = currentThinking === selection.thinking;
          if (!thinkingApplied) {
            applyError = `Pi clamped effort ${selection.thinking} to ${currentThinking}; DEFAULT route was not saved.`;
          }
        }
      }
    } catch (error) {
      applyError = errorMessage(error);
    }
  }

  let customEntryAppended = false;
  const hostApplySucceeded = !shouldApplyModel || (modelApplied && thinkingApplied);
  if (hostApplySucceeded) {
    try {
      const persistence = await setModelRoleSetting(selection.action.role, assignment);
      rolePersisted = persistence.rolePersisted;
      lockReleaseError = persistence.lockReleaseError;
    } catch (error) {
      rolePersistenceError = errorMessage(error);
      rolePersisted = false;
    }
    customEntryAppended = await appendModelRoleEntry(
      pi,
      selection.action.role,
      assignment,
      beforeSelector,
      currentSelector,
      modelApplied,
      rolePersisted,
    );
  } else {
    customEntryAppended = await appendModelRoleEntry(
      pi,
      selection.action.role,
      assignment,
      beforeSelector,
      currentSelector,
      modelApplied,
      false,
    );
  }

  const runtimeEventRecorded = recordModelRoleRuntimeEvent(ctx, {
    role: selection.action.role,
    assignment: targetSelector,
    requestedThinking: selection.thinking,
    beforeModel: beforeSelector,
    currentModel: currentSelector,
    currentThinking,
    modelApplied,
    thinkingApplied,
    rolePersisted,
    ...(rolePersistenceError === undefined ? {} : { rolePersistenceError }),
    ...(lockReleaseError === undefined ? {} : { lockReleaseError }),
    customEntryAppended,
    configPath: getModelRolesConfigPath(),
  });

  const succeeded = rolePersisted && hostApplySucceeded;
  const appliedState = await updateModelRoleStatus(ctx, currentSelector, pi);
  const evidenceWarnings = [
    ...(lockReleaseError === undefined ? [] : [lockReleaseError]),
    ...(!customEntryAppended ? ["session evidence unavailable"] : []),
    ...(!runtimeEventRecorded ? ["runtime event unavailable"] : []),
  ];
  const partialSessionApply = shouldApplyModel && modelApplied && thinkingApplied && !rolePersisted;
  let receiptKind: "success" | "warning" | "error";
  let receiptText: string;
  if (succeeded) {
    receiptKind = evidenceWarnings.length > 0 ? "warning" : "success";
    receiptText = [
      `${selection.action.tag} → ${targetSelector} saved${shouldApplyModel ? "; Current session updated" : ""}.`,
      ...(evidenceWarnings.length === 0 ? [] : [`Evidence warning: ${evidenceWarnings.join(", ")}.`]),
    ].join(" ");
  } else if (partialSessionApply) {
    receiptKind = "warning";
    receiptText = `Current session changed to ${assignment.model} · effort ${selection.thinking}, but DEFAULT route was not saved${rolePersistenceError ? `: ${rolePersistenceError}` : "."}`;
  } else {
    receiptKind = "error";
    receiptText = applyError ?? rolePersistenceError ?? `${selection.action.tag} route was not saved.`;
  }
  return {
    ...appliedState,
    receipt: { kind: receiptKind, text: receiptText },
  };
}

function assignmentFromModel(model: ModelLike, thinking: ThinkingLevel): ModelRoleAssignment | undefined {
  const selector = modelSelector(model);
  return selector ? { model: selector, thinking } : undefined;
}
