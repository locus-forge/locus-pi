import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { errorResult, getProjectRoot, textResult } from "../_shared/host/pi-api.js";
import { validateParams } from "../_shared/host/validation.js";
import { expandPaths } from "../_shared/host/files.js";
import { AST_LANGUAGES, astErrorMessage, astSearch } from "./ast-engine.js";
import { safeToolText } from "../_shared/host/safe-output.js";

const AstGrepParams = Type.Object({
  pat: Type.String({ description: "AST pattern to match", maxLength: 2000 }),
  paths: Type.Array(Type.String({ description: "Files, directories, or globs" }), { maxItems: 50 }),
  language: Type.Optional(
    Type.Union(
      AST_LANGUAGES.map((language) => Type.Literal(language)),
      { default: "auto", description: "Language override" },
    ),
  ),
});

export default function astGrepTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ast_grep",
    description: "Read-only structural search for JS/TS/Python using in-process ast-grep.",
    parameters: AstGrepParams,
    approval: "read",
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(AstGrepParams, params);
      if (!valid.ok) return valid.result;
      const files = await expandPaths(valid.value.paths, getProjectRoot(ctx), 500);
      let matches;
      try {
        matches = (await astSearch(valid.value.pat, files, valid.value.language ?? "auto")).slice(0, 500);
      } catch (error) {
        return errorResult(astErrorMessage(error));
      }
      const text = safeToolText(
        matches.map((m) => `${m.file}:${m.line}:${m.column}: ${m.text}`).join("\n") || "No matches",
        50 * 1024,
      );
      return textResult(text.text, {
        matches,
        totalMatches: matches.length,
        filesWithMatches: new Set(matches.map((m) => m.file)).size,
        filesSearched: files.length,
        truncated: text.truncated,
      });
    },
  });
}
