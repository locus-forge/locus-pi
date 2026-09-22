import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "../_shared/host/pi-api.js";
import { getProjectRoot, textResult } from "../_shared/host/pi-api.js";
import { validateParams } from "../_shared/host/validation.js";
import { applyPreview, discardPreview, getLatestPendingPreview, getPreview } from "./ast-engine.js";
import { emitDevEvent } from "../_shared/runtime/event-bus.js";

const ResolveParams = Type.Object({
  action: Type.Union([Type.Literal("apply"), Type.Literal("discard")], {
    description: "Whether to apply or discard the pending preview",
  }),
  reason: Type.String({ description: "Why applying or discarding the pending preview", maxLength: 500 }),
  extra: Type.Optional(
    Type.Object(
      {
        previewId: Type.Optional(
          Type.String({
            description:
              "Preview id returned by ast_edit. Optional; resolve defaults to the latest pending AST preview.",
          }),
        ),
      },
      { additionalProperties: true, description: "Free-form resolve metadata" },
    ),
  ),
});

export default function resolveTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "resolve",
    description: "Resolve a pending ast_edit preview by applying or discarding it.",
    parameters: ResolveParams,
    approval: previewFinalizerApproval,
    formatApprovalDetails: previewFinalizerApprovalDetails,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(ResolveParams, params);
      if (!valid.ok) return valid.result;
      const previewId = valid.value.extra?.previewId ?? getLatestPendingPreview(getProjectRoot(ctx))?.id;
      if (!previewId)
        return {
          isError: true,
          content: [{ type: "text", text: "No pending action to resolve. Nothing to apply or discard." }],
        };
      return finalizePreview(previewId, valid.value.action, valid.value.reason, ctx);
    },
  });
}

async function finalizePreview(previewId: string, action: "apply" | "discard", reason: string, ctx: ExtensionContext) {
  const preview = getPreview(previewId);
  if (!preview) return { isError: true, content: [{ type: "text" as const, text: `Unknown preview: ${previewId}` }] };
  if (action === "discard") {
    discardPreview(previewId);
    emitDevEvent("resolve:discard", { previewId, reason });
    return textResult(`Discarded ${previewId}`, resolveDetails(action, reason, previewId));
  }
  const result = await applyPreview(previewId, getProjectRoot(ctx));
  if (result.stale.length) {
    emitDevEvent("resolve:stale", { previewId, files: result.stale.length });
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Preview is stale; refusing apply:\n${result.stale.join("\n")}` }],
      details: { ...resolveDetails(action, reason, previewId), stale: result.stale },
    };
  }
  emitDevEvent("resolve:apply", { previewId, files: result.applied });
  return textResult(`Applied ${previewId} to ${result.applied} files`, {
    ...resolveDetails(action, reason, previewId),
    filesApplied: result.applied,
  });
}

function resolveDetails(action: "apply" | "discard", reason: string, previewId: string) {
  return {
    action,
    reason,
    sourceToolName: "resolve",
    label: `ast_edit preview ${previewId}`,
    extra: { previewId },
    sourceResultDetails: { previewId },
  };
}

function previewFinalizerApproval(args: unknown) {
  return previewFinalizerAction(args) === "apply"
    ? { tier: "write" as const, reason: "Applying an AST preview writes files." }
    : "read";
}

function previewFinalizerApprovalDetails(args: unknown): string[] {
  const action = previewFinalizerAction(args);
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const extra =
    record.extra !== null && typeof record.extra === "object" ? (record.extra as Record<string, unknown>) : undefined;
  const previewId = String(record.previewId ?? extra?.previewId ?? "latest-pending-preview");
  return [`Action: ${action}`, `Preview: ${previewId}`];
}

function previewFinalizerAction(args: unknown): "apply" | "discard" {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return record.action === "apply" ? "apply" : "discard";
}
