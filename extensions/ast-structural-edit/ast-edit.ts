import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { errorResult, getProjectRoot, textResult } from "../_shared/host/pi-api.js";
import { validateParams } from "../_shared/host/validation.js";
import { expandPaths } from "../_shared/host/files.js";
import { AST_LANGUAGES, astErrorMessage, astPreview } from "./ast-engine.js";
import { safeToolText } from "../_shared/host/safe-output.js";
import { emitDevEvent } from "../_shared/runtime/event-bus.js";

const AstEditParams = Type.Object({
  ops: Type.Array(
    Type.Object({
      pat: Type.String({ description: "AST pattern to match", maxLength: 2000 }),
      out: Type.String({ description: "Replacement template", maxLength: 2000 }),
    }),
    { maxItems: 20, description: "Rewrite operations" },
  ),
  paths: Type.Array(Type.String({ description: "Files, directories, or globs" }), { maxItems: 50 }),
  language: Type.Optional(
    Type.Union(
      AST_LANGUAGES.map((language) => Type.Literal(language)),
      { default: "auto", description: "Language override" },
    ),
  ),
});

export default function astEditTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ast_edit",
    description: "Preview-only AST edit planner; it never writes files. Use resolve to apply or discard the preview.",
    parameters: AstEditParams,
    approval: "read",
    formatApprovalDetails: astEditApprovalDetails,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(AstEditParams, params);
      if (!valid.ok) return valid.result;
      const files = await expandPaths(valid.value.paths, getProjectRoot(ctx), 200);
      let preview;
      try {
        preview = await astPreview(valid.value.ops, files, valid.value.language ?? "auto");
      } catch (error) {
        return errorResult(astErrorMessage(error));
      }
      const summary =
        preview.replacements.map((item) => `${item.file}: ${item.replacements} replacements`).join("\n") ||
        "No replacements";
      const text = safeToolText(`Preview ${preview.id}\n${summary}`, 50 * 1024);
      emitDevEvent("ast:preview", { previewId: preview.id, files: preview.replacements.length });
      return textResult(text.text, {
        previewId: preview.id,
        files: preview.replacements.map((item) => ({ path: item.file, replacements: item.replacements })),
        totalReplacements: preview.replacements.reduce((sum, item) => sum + item.replacements, 0),
        stale: false,
      });
    },
  });
}

function astEditApprovalDetails(args: unknown): string[] {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const paths = Array.isArray(record.paths) ? record.paths.map(String).join(", ") : "none";
  return ["Action: preview-only AST edit plan", `Paths: ${paths}`];
}
