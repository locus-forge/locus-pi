import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { staticWorkflowMeta } from "../extensions/workflows/catalog/workflow-meta.js";
import type { WorkflowSourceDiagnostic } from "../extensions/workflows/tool/workflow-source-shape.js";
import { checkWorkflowSourceText } from "../extensions/workflows/tool/workflow-source-check-tool.js";
import { packagedWorkflowNames, packagedWorkflowPath } from "../extensions/workflows/runtime/workflow-discovery.js";

interface SourceShapeTarget {
  label: string;
  path: string;
  requireStandard: boolean;
}

type SourceMode = "compatibility" | "orchestration-only";

const { values, positionals: requestedPaths } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: { mode: { type: "string" } },
});
const requestedMode = values.mode ?? "compatibility";
if (requestedMode !== "compatibility" && requestedMode !== "orchestration-only") {
  console.error('Workflow source mode must be "compatibility" or "orchestration-only".');
  process.exit(1);
}
const mode: SourceMode = requestedMode;
const targets: SourceShapeTarget[] =
  requestedPaths.length > 0
    ? requestedPaths.map((requestedPath) => ({
        label: requestedPath,
        path: path.resolve(process.cwd(), requestedPath),
        requireStandard: true,
      }))
    : packagedWorkflowNames().map((name) => ({
        label: `Package workflow ${name}`,
        path: packagedWorkflowPath(name),
        requireStandard: false,
      }));

let failed = false;
let checked = 0;

for (const target of targets) {
  let source: string;
  try {
    source = readFileSync(target.path, "utf8");
  } catch (error) {
    failed = true;
    console.error(`${target.label}: unable to read source: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const profile = staticWorkflowMeta(source).profile;
  if (profile !== "standard") {
    if (target.requireStandard) {
      failed = true;
      console.error(`${target.label}: expected literal meta.profile \"standard\", found ${profile}`);
    }
    continue;
  }

  checked += 1;
  const diagnostics = checkWorkflowSourceText(source, mode);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  const shapeLabel = mode === "orchestration-only" ? "orchestration-only workflow source" : "standard source";
  if (errors.length === 0) {
    const warningSuffix = warnings.length === 0 ? "" : ` with ${warnings.length} warning(s)`;
    console.log(`${target.label}: ${shapeLabel} shape passed${warningSuffix}`);
    for (const warning of warnings) console.log(`  - ${formatDiagnostic(warning)}`);
    continue;
  }

  failed = true;
  console.error(`${target.label}: ${shapeLabel} shape failed`);
  for (const diagnostic of diagnostics) console.error(`  - ${formatDiagnostic(diagnostic)}`);
}

if (checked === 0 && !failed) {
  failed = true;
  console.error("No standard workflow source was checked.");
}

if (failed) process.exitCode = 1;

function formatDiagnostic(diagnostic: WorkflowSourceDiagnostic): string {
  return `${diagnostic.line}:${diagnostic.column} [${diagnostic.code}] ${diagnostic.message}`;
}
