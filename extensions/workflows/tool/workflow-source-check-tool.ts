/** Pi-native boundary for the standard workflow source-shape validator. */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../../_shared/host/pi-api.js";
import { errorResult, getProjectRoot, registerToolWithErrorResults, textResult } from "../../_shared/host/pi-api.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import { safeToolText } from "../../_shared/host/safe-output.js";
import { validateParams } from "../../_shared/host/validation.js";
import {
  orchestrationOnlyWorkflowSourceShapeDiagnostics,
  standardWorkflowSourceShapeDiagnostics,
  type WorkflowSourceDiagnostic,
} from "./workflow-source-shape.js";

const WorkflowSourceCheckParams = Type.Object(
  {
    path: Type.String({
      description: "Project-relative path of one .workflow.mjs source file to validate without executing it.",
      minLength: 1,
      maxLength: 4096,
    }),
    mode: Type.Optional(
      Type.Union([Type.Literal("compatibility"), Type.Literal("orchestration-only")], {
        description:
          "Use orchestration-only for newly authored workflows; compatibility preserves the broader validator for existing reviewed source.",
      }),
    ),
  },
  { additionalProperties: false },
);
const MAX_WORKFLOW_SOURCE_BYTES = 512 * 1024;

export function registerWorkflowSourceCheckTool(pi: ExtensionAPI): void {
  registerToolWithErrorResults(pi, {
    name: "workflow_check_source",
    label: "workflow source check",
    description:
      "Validate one project workflow source up to 512 KiB without importing or executing it. The default compatibility mode accepts the full standard grammar; orchestration-only mode restricts newly authored source to prompts, agent edges, DSL control flow, and in-memory text publication. The path must stay inside the current project.",
    parameters: WorkflowSourceCheckParams,
    approval: "read",
    formatApprovalDetails: (args) => {
      const value = args !== null && typeof args === "object" ? String((args as { path?: unknown }).path ?? "") : "";
      const mode =
        args !== null && typeof args === "object"
          ? String((args as { mode?: unknown }).mode ?? "compatibility")
          : "compatibility";
      return [
        `Workflow source: ${value}`,
        `Validation mode: ${mode}`,
        "Action: static validation only; the workflow is not imported or run",
      ];
    },
    execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(WorkflowSourceCheckParams, params);
      if (!valid.ok) return valid.result;
      try {
        const projectRoot = getProjectRoot(ctx);
        const sourcePath = confinedProjectFile(projectRoot, valid.value.path);
        const displayPath = path.relative(projectRoot, sourcePath).split(path.sep).join("/");
        const mode = valid.value.mode ?? "compatibility";
        const source = readFileSync(sourcePath, "utf8");
        const diagnostics = checkWorkflowSourceText(source, mode);
        const shapeLabel =
          mode === "orchestration-only" ? "orchestration-only workflow source" : "standard workflow source";
        const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        const errorCount = new Set(errorDiagnostics.map((diagnostic) => diagnostic.message)).size;
        const warningCount = diagnostics.length - errorDiagnostics.length;
        const details = {
          owner: "workflows",
          path: displayPath,
          errorCount,
          warningCount,
          diagnostics,
          sha256: createHash("sha256").update(source).digest("hex"),
        };
        if (errorDiagnostics.length > 0) {
          const output = safeToolText(
            `${displayPath}: ${shapeLabel} shape failed:
${diagnostics.map((diagnostic) => formatWorkflowSourceDiagnostic(displayPath, diagnostic)).join("\n")}`,
          );
          return errorResult(output.text, {
            ...details,
            outputTruncated: output.truncated,
            outputRedacted: output.redacted,
          });
        }
        if (warningCount > 0) {
          const output = safeToolText(
            `${displayPath}: ${shapeLabel} shape passed with ${warningCount} warning(s):
${diagnostics.map((diagnostic) => formatWorkflowSourceDiagnostic(displayPath, diagnostic)).join("\n")}`,
          );
          return textResult(output.text, {
            ...details,
            outputTruncated: output.truncated,
            outputRedacted: output.redacted,
          });
        }
        return textResult(`${displayPath}: ${shapeLabel} shape passed`, details);
      } catch (error) {
        return errorResult(`workflow_check_source: ${errorMessage(error)}`, { owner: "workflows" });
      }
    },
  });
}

/** Check these bytes without importing them; publication uses this same host gate. */
export function checkWorkflowSourceText(
  source: string,
  mode: "compatibility" | "orchestration-only",
): WorkflowSourceDiagnostic[] {
  if (Buffer.byteLength(source) > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(`source exceeds the ${MAX_WORKFLOW_SOURCE_BYTES}-byte validation limit`);
  }
  const diagnostics =
    mode === "orchestration-only"
      ? orchestrationOnlyWorkflowSourceShapeDiagnostics(source)
      : standardWorkflowSourceShapeDiagnostics(source);
  const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (syntax.status !== 0)
    diagnostics.push({
      code: "WF_SOURCE_PARSE",
      severity: "error",
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
      message: `Node syntax check failed: ${syntax.error?.message ?? syntax.stderr ?? syntax.signal}`,
    });
  return diagnostics;
}

function formatWorkflowSourceDiagnostic(displayPath: string, diagnostic: WorkflowSourceDiagnostic): string {
  return `${displayPath}:${diagnostic.line}:${diagnostic.column} [${diagnostic.code}] ${diagnostic.message}`;
}

function confinedProjectFile(projectRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("path must be project-relative");
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalFile = path.resolve(lexicalRoot, relativePath);
  assertWithin(lexicalRoot, lexicalFile, "path escapes the project root");
  const physicalRoot = realpathSync(lexicalRoot);
  const physicalFile = realpathSync(lexicalFile);
  assertWithin(physicalRoot, physicalFile, "path escapes the project root through a symlink");
  const sourceStat = statSync(physicalFile);
  if (!sourceStat.isFile()) throw new Error("path is not a regular file");
  if (sourceStat.size > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(`source exceeds the ${MAX_WORKFLOW_SOURCE_BYTES}-byte validation limit`);
  }
  return lexicalFile;
}

function assertWithin(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(message);
}
