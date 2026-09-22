/**
 * scripts/check-extension-manifests.ts — the gate that makes extension manifests a contract.
 *
 * It loads exactly the manifests referenced by `package.json#pi.extensions`, validates each
 * one against `schemas/extension-manifest.schema.json`, and then enforces the cross-file invariants a
 * single-document schema cannot express. `npm run check:manifests` runs it, and `npm run check`
 * runs that first, so an unknown field or an unlisted enum value fails the suite.
 *
 * Why the schema is interpreted here instead of hand-checked: a hand-written validator drifts
 * from the schema file the moment someone edits one and not the other. `validate` below reads
 * the schema file itself, and `assertSupportedSchema` refuses any keyword this interpreter does
 * not implement — so widening the schema without widening the interpreter fails loudly rather
 * than silently skipping a rule. No validation library is added for this: the package ships
 * three runtime dependencies and none of them is a JSON Schema validator.
 *
 * Which files are the manifest set is not decided here: `scripts/extension-manifest-sources.ts`
 * resolves it, so this gate and `scripts/build-public-catalogs.ts` can never disagree about
 * which manifests are active. This file owns only what a rejected manifest means.
 *
 * Every manifest field and the consumer that reads it:
 *
 *   id                  this checker
 *   runtimeRequirements tests/extensions/workflows/fusion/fusion-tool.test.ts, docs/extensions.md
 *   stateUsed           tests/extensions/workflows/fusion/fusion-tool.test.ts, docs/extensions.md
 *   provides            tests/contracts/extensions/runtime-registration.test.ts,
 *                       tests/contracts/host/selective-package-loading.test.ts,
 *                       tests/contracts/docs/extension-reference.test.ts
 *   uiLifecycle         this checker (every entry must name a declared surface); reviewer contract
 *   permissions         reviewer contract, docs/extensions.md and docs/architecture.md; nothing
 *                       in the package grants a capability from it
 *   risk                tests/contracts/docs/extension-reference.test.ts
 *   docsPath            tests/contracts/docs/extension-reference.test.ts,
 *                       tests/docs/public-docs.test.ts, this checker
 *   tests               tests/contracts/docs/extension-reference.test.ts, this checker
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionManifestSources } from "./extension-manifest-sources.js";

const SCHEMA_FILE = "schemas/extension-manifest.schema.json";

/** One rejected manifest. `field` is the path inside the manifest, so each finding names one edit. */
export interface ManifestProblem {
  file: string;
  field: string;
  message: string;
}

type SchemaNode = Record<string, unknown>;

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "enum",
  "pattern",
  "maxLength",
  "minItems",
  "required",
  "properties",
  "additionalProperties",
  "items",
]);

const SUPPORTED_TYPES = new Set(["object", "array", "string", "boolean", "null"]);

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  const problems = extensionManifestProblems(process.cwd());
  if (problems.length > 0) {
    console.error(formatManifestProblems(problems));
    process.exitCode = 1;
  } else {
    console.log(`Extension manifests validated against ${SCHEMA_FILE}`);
  }
}

/**
 * Validate the active manifest set under `root`. Returns every finding rather than throwing on
 * the first, so one run reports the whole edit list.
 */
export function extensionManifestProblems(root: string): ManifestProblem[] {
  const { packageFiles, declarationProblem, sources } = extensionManifestSources(root);
  if (declarationProblem) {
    return [{ file: "package.json", field: "pi.extensions", message: declarationProblem }];
  }

  const schema = JSON.parse(readFileSync(path.join(root, SCHEMA_FILE), "utf8")) as SchemaNode;
  assertSupportedSchema(schema, "#");

  const problems: ManifestProblem[] = [];
  const seenIds = new Map<string, string>();

  for (const source of sources) {
    if (source.state === "invalid-entrypoint") {
      problems.push({
        file: "package.json",
        field: `pi.extensions[${source.index}]`,
        message: `is not an ./extensions/<id>/index.ts entrypoint: ${String(source.entrypoint)}`,
      });
      continue;
    }
    if (source.state === "missing") {
      problems.push({ file: source.file, field: "", message: "declared by package.json#pi.extensions but missing" });
      continue;
    }
    if (source.state === "unreadable") {
      problems.push({ file: source.file, field: "", message: `is not readable JSON: ${source.reason}` });
      continue;
    }

    const { directory, file, manifest } = source;
    const schemaProblems = validate(schema, manifest, "", schema);
    problems.push(...schemaProblems.map((problem) => ({ file, ...problem })));
    if (schemaProblems.length > 0) continue;

    // The manifest matched the schema, so every field below has its declared shape.
    problems.push(
      ...crossFileProblems(root, directory, manifest as unknown as ManifestShape, packageFiles, seenIds).map(
        (problem) => ({ file, ...problem }),
      ),
    );
  }
  return problems;
}

export function formatManifestProblems(problems: readonly ManifestProblem[]): string {
  return problems
    .map(({ file, field, message }) => `${file}${field ? `: ${field}` : ""}: ${message}`)
    .join("\n")
    .concat(`\n${problems.length} extension manifest problem(s)`);
}

interface ManifestShape {
  id: string;
  provides: { tools: string[]; commands: string[]; hooks: string[] };
  uiLifecycle?: { commands?: Array<{ name: string }>; tools?: Array<{ name: string }> };
  docsPath: string;
  tests: string[];
}

/**
 * The invariants that need a second file: the directory, package.json, and the
 * paths a manifest points at.
 */
function crossFileProblems(
  root: string,
  directory: string,
  manifest: ManifestShape,
  packageFiles: readonly string[],
  seenIds: Map<string, string>,
): Array<Omit<ManifestProblem, "file">> {
  const problems: Array<Omit<ManifestProblem, "file">> = [];

  if (manifest.id !== directory) {
    problems.push({ field: "id", message: `must equal the extension directory name ${directory}` });
  }
  const duplicateId = seenIds.get(manifest.id);
  if (duplicateId) problems.push({ field: "id", message: `repeats the id already declared by ${duplicateId}` });
  else seenIds.set(manifest.id, `extensions/${directory}/manifest.json`);

  if (!existsSync(path.join(root, manifest.docsPath))) {
    problems.push({ field: "docsPath", message: `points at a missing file: ${manifest.docsPath}` });
  } else if (!packageFileIncludes(packageFiles, manifest.docsPath)) {
    problems.push({ field: "docsPath", message: `is not published through package.json#files: ${manifest.docsPath}` });
  }

  manifest.tests.forEach((testPath, index) => {
    if (!existsSync(path.join(root, testPath))) {
      problems.push({ field: `tests[${index}]`, message: `points at a missing file: ${testPath}` });
    }
  });

  problems.push(...uiLifecycleProblems(manifest));
  return problems;
}

function packageFileIncludes(patterns: readonly string[], file: string): boolean {
  let included = false;
  for (const declared of patterns) {
    const excluded = declared.startsWith("!");
    const normalized = declared.replace(/^!/u, "").replace(/^\.\//u, "").replace(/\/$/u, "");
    if (file === normalized || file.startsWith(`${normalized}/`)) included = !excluded;
  }
  return included;
}

/**
 * `uiLifecycle` documents surfaces, so a name it lists that `provides` does not declare is a
 * stale entry. Commands are matched on their top-level word, the same projection
 * tests/contracts/extensions/runtime-registration.test.ts compares against live registration.
 */
function uiLifecycleProblems(manifest: ManifestShape): Array<Omit<ManifestProblem, "file">> {
  if (!manifest.uiLifecycle) return [];
  const declared = {
    commands: new Set(manifest.provides.commands.map((command) => command.trim().split(/\s+/u)[0]).filter(Boolean)),
    tools: new Set(manifest.provides.tools),
  } as const;
  const problems: Array<Omit<ManifestProblem, "file">> = [];
  for (const surface of ["commands", "tools"] as const) {
    (manifest.uiLifecycle[surface] ?? []).forEach((entry, index) => {
      if (declared[surface].has(entry.name)) return;
      problems.push({
        field: `uiLifecycle.${surface}[${index}].name`,
        message: `names ${entry.name}, which provides.${surface} does not declare`,
      });
    });
  }
  return problems;
}

/**
 * Refuse a schema this interpreter would only partly apply. Without this, adding a keyword to
 * schemas/extension-manifest.schema.json would silently weaken the gate instead of failing it.
 */
function assertSupportedSchema(node: unknown, pointer: string): void {
  if (!isRecord(node)) throw new Error(`${SCHEMA_FILE} ${pointer}: schema node must be an object`);
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(
        `${SCHEMA_FILE} ${pointer}: unsupported keyword "${keyword}"; teach scripts/check-extension-manifests.ts to apply it or drop it`,
      );
    }
  }
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    throw new Error(`${SCHEMA_FILE} ${pointer}: only "additionalProperties": false is supported`);
  }
  if (typeof node.$ref === "string" && !/^#\/\$defs\/[^/]+$/u.test(node.$ref)) {
    throw new Error(`${SCHEMA_FILE} ${pointer}: only local "#/$defs/<name>" references are supported`);
  }
  for (const declared of asArray(node.type)) {
    if (!SUPPORTED_TYPES.has(String(declared))) {
      throw new Error(`${SCHEMA_FILE} ${pointer}: unsupported type "${String(declared)}"`);
    }
  }
  for (const key of ["properties", "$defs"] as const) {
    const group = node[key];
    if (group === undefined) continue;
    if (!isRecord(group)) throw new Error(`${SCHEMA_FILE} ${pointer}/${key}: must be an object`);
    for (const [name, child] of Object.entries(group)) assertSupportedSchema(child, `${pointer}/${key}/${name}`);
  }
  if (node.items !== undefined) assertSupportedSchema(node.items, `${pointer}/items`);
}

/** Apply `schema` to `value`, collecting one problem per violated rule. */
function validate(
  schema: SchemaNode,
  value: unknown,
  field: string,
  rootSchema: SchemaNode,
): Array<{ field: string; message: string }> {
  const node = resolveRef(schema, rootSchema);
  const problems: Array<{ field: string; message: string }> = [];
  const types = asArray(node.type).map(String);
  if (types.length > 0 && !types.some((declared) => matchesType(declared, value))) {
    return [{ field, message: `must be ${types.join(" or ")}, received ${describe(value)}` }];
  }

  if (Array.isArray(node.enum) && !node.enum.some((allowed) => allowed === value)) {
    problems.push({
      field,
      message: `must be one of ${node.enum.map((allowed) => JSON.stringify(allowed)).join(", ")}, received ${describe(value)}`,
    });
  }
  if (typeof node.pattern === "string" && typeof value === "string" && !new RegExp(node.pattern, "u").test(value)) {
    problems.push({ field, message: `must match ${node.pattern}, received ${JSON.stringify(value)}` });
  }
  if (typeof node.maxLength === "number" && typeof value === "string" && value.length > node.maxLength) {
    problems.push({ field, message: `must be at most ${node.maxLength} characters, received ${value.length}` });
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      problems.push({ field, message: `must list at least ${node.minItems} item(s)` });
    }
    if (isRecord(node.items)) {
      value.forEach((item, index) =>
        problems.push(...validate(node.items as SchemaNode, item, `${field}[${index}]`, rootSchema)),
      );
    }
    return problems;
  }

  if (isRecord(value)) {
    const properties = isRecord(node.properties) ? node.properties : {};
    for (const required of asArray(node.required).map(String)) {
      if (!(required in value)) problems.push({ field: join(field, required), message: "is required and missing" });
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (isRecord(childSchema)) {
        problems.push(...validate(childSchema, child, join(field, name), rootSchema));
      } else if (node.additionalProperties === false) {
        problems.push({ field: join(field, name), message: `is not declared by ${SCHEMA_FILE}` });
      }
    }
  }
  return problems;
}

function resolveRef(node: SchemaNode, rootSchema: SchemaNode): SchemaNode {
  if (typeof node.$ref !== "string") return node;
  const name = node.$ref.slice("#/$defs/".length);
  const defs = isRecord(rootSchema.$defs) ? rootSchema.$defs : {};
  const target = defs[name];
  if (!isRecord(target)) throw new Error(`${SCHEMA_FILE}: unresolved reference ${node.$ref}`);
  return target;
}

function matchesType(declared: string, value: unknown): boolean {
  if (declared === "null") return value === null;
  if (declared === "array") return Array.isArray(value);
  if (declared === "object") return isRecord(value);
  return typeof value === declared;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : JSON.stringify(value);
}

function join(field: string, name: string): string {
  return field ? `${field}.${name}` : name;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
