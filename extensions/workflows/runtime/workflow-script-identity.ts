import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import {
  exportedMetaObject,
  staticObjectKey,
  staticStringValue,
  unwrapParentheses,
} from "../source/workflow-source-literals.js";
import {
  chmodWorkflowRunFile,
  ensureWorkflowDirectoryNoSymlink,
  readWorkflowRunFile,
  writeWorkflowRunFile,
} from "./workflow-run-layout.js";

export const WORKFLOW_SCRIPT_IDENTITY_SCHEMA_VERSION = 2 as const;
export const WORKFLOW_IDENTITY_POLICY = "static-node-only-v1" as const;

export type WorkflowIdentityCoverage = "self-contained-static" | "entry-only" | "entry-only-legacy";

export type WorkflowExecutionSource = "snapshot" | "source";

/** Versioned source identity persisted privately in one workflow result. */
export interface WorkflowScriptIdentity {
  schemaVersion: typeof WORKFLOW_SCRIPT_IDENTITY_SCHEMA_VERSION;
  identityPolicy: typeof WORKFLOW_IDENTITY_POLICY;
  sourcePath: string;
  snapshotPath: string;
  scriptSha256: string;
  identityCoverage: Exclude<WorkflowIdentityCoverage, "entry-only-legacy">;
  executionSource: WorkflowExecutionSource;
  nodeVersion: string;
  platform: string;
  arch: string;
  builtinImports: string[];
  unboundDependencies: string[];
}

export interface WorkflowSourceIdentityAssessment {
  identityCoverage: WorkflowScriptIdentity["identityCoverage"];
  builtinImports: string[];
  unboundDependencies: string[];
}

/**
 * Whether a source is eligible to have its recorded agent calls REPLAYED on a
 * later `--resume`. `static-deterministic` means the AST found no direct clock
 * or randomness syntax; `unproven` means it did (or could not see the whole
 * module graph).
 */
export type WorkflowReplaySafety = "static-deterministic" | "unproven";

export interface WorkflowReplaySafetyAssessment {
  replaySafety: WorkflowReplaySafety;
  /** Sorted, de-duplicated syntactic evidence, e.g. `Date.now`, `new Date`. */
  nondeterministicCalls: string[];
}

/**
 * Direct clock/randomness syntax that makes a rerun's call sequence unreproducible.
 *
 * Deliberately over-broad: every `new Date(...)` form is flagged, including
 * `new Date("2020-01-01")` which is in fact deterministic. Replay-safety is a
 * fail-closed gate, so a false "unproven" costs a cache miss while a false
 * "deterministic" would let a run replay answers produced in a different world.
 */
const NONDETERMINISTIC_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Date", ["now"]],
  ["Math", ["random"]],
  ["performance", ["now", "timeOrigin"]],
  ["crypto", ["randomUUID", "getRandomValues"]],
  ["process", ["hrtime", "uptime"]],
]);

/**
 * Global objects a nondeterministic root can be reached through. Without these,
 * `globalThis.Date.now()` reads as an access on an object literally named
 * `"globalThis.Date"` and matches nothing.
 */
const GLOBAL_OBJECT_ROOTS: ReadonlySet<string> = new Set(["globalThis", "global", "self", "window"]);

/**
 * Nondeterministic bindings a Node builtin hands out by name.
 *
 * `node:` specifiers are exactly what keeps a script `self-contained-static`,
 * so an ESM import is the one bypass the identity gate actively invites:
 * `import { randomUUID } from "node:crypto"` reaches randomness through a bare
 * local identifier that no member scan can see. A default or namespace binding
 * renames the whole module, so those are flagged wholesale — losing the cache
 * on `import c from "node:crypto"` is the cheap side of this trade.
 */
const NONDETERMINISTIC_BUILTIN_EXPORTS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "node:crypto",
    ["randomUUID", "getRandomValues", "randomBytes", "randomInt", "randomFill", "randomFillSync", "webcrypto"],
  ],
  ["node:perf_hooks", ["performance", "monitorEventLoopDelay"]],
  ["node:process", ["hrtime", "uptime"]],
]);

/** A computed member of the global object: never foldable, always unproven. */
const UNRESOLVED_GLOBAL_MEMBER = "\0unresolved-global-member";

/**
 * Inspect exact entry bytes before evaluation.
 *
 * The default policy proves only that the declared module graph is static and
 * Node-builtin-only. It is deliberately not a sandbox or determinism claim.
 * Reviewed modular scripts can opt down to entry-only evidence through one
 * literal, hash-bound meta field.
 */
export function assessWorkflowSourceIdentity(source: string): WorkflowSourceIdentityAssessment {
  return assessSourceIdentity(parseWorkflowSource(source));
}

/** One parse shared by every static assessment of the same exact bytes. */
function parseWorkflowSource(source: string): SgNode {
  let root: SgNode;
  try {
    root = parse(Lang.JavaScript, source).root();
  } catch (error) {
    throw new Error(`Workflow source parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parseErrors = root.findAll({ rule: { kind: "ERROR" } });
  if (parseErrors.length > 0) {
    throw new Error(`Workflow source parse failed: ${oneLine(parseErrors[0]!.text())}`);
  }
  return root;
}

function assessReplaySafety(root: SgNode): WorkflowReplaySafetyAssessment {
  const found = new Set<string>();

  // Dotted access, including through the global object:
  // `Date.now`, `globalThis.Date.now`, `globalThis["Date"].now`.
  for (const member of root.findAll({ rule: { kind: "member_expression" } })) {
    recordRootUse(found, member.field("object"), member.field("property")?.text());
  }

  // `Date["now"]` and friends: the property is computed, so record the root as
  // touched rather than trying to constant-fold the subscript.
  for (const subscript of root.findAll({ rule: { kind: "subscript_expression" } })) {
    recordRootUse(found, subscript.field("object"), undefined);
  }

  // `new Date()`, `new (Date)()`, `new globalThis.Date()`.
  for (const expression of root.findAll({ rule: { kind: "new_expression" } })) {
    const constructed = staticBuiltinRoot(expression.field("constructor"));
    if (constructed === UNRESOLVED_GLOBAL_MEMBER) found.add("globalThis[…]");
    else if (constructed === "Date") found.add("new Date");
  }

  // Bindings that carry a root out of this scan's sight under a fresh name:
  // `const d = Date`, `const { random } = Math`, `d = Math`.
  for (const declarator of root.findAll({ rule: { kind: "variable_declarator" } })) {
    recordRootBinding(found, declarator.field("name"), declarator.field("value"));
  }
  for (const assignment of root.findAll({ rule: { kind: "assignment_expression" } })) {
    recordRootBinding(found, assignment.field("left"), assignment.field("right"));
  }

  // Named/default/namespace imports of nondeterministic Node builtins.
  for (const statement of root.findAll({ rule: { kind: "import_statement" } })) {
    recordBuiltinBindingImport(found, statement);
  }
  for (const statement of root.findAll({ rule: { kind: "export_statement" } })) {
    if (statement.children().some((child) => child.kind() === "from")) recordBuiltinBindingImport(found, statement);
  }

  const nondeterministicCalls = [...found].sort();
  return {
    replaySafety: nondeterministicCalls.length === 0 ? "static-deterministic" : "unproven",
    nondeterministicCalls,
  };
}

/**
 * The builtin root a node denotes, when that is statically decidable:
 * `Date` and `globalThis.Date` and `globalThis["Date"]` all fold to `"Date"`.
 * Returns `UNRESOLVED_GLOBAL_MEMBER` for a computed member of the global object
 * (unfoldable, so unprovable) and `undefined` for anything else.
 */
function staticBuiltinRoot(node: SgNode | null | undefined): string | undefined {
  const target = unwrapParentheses(node ?? undefined);
  switch (target?.kind()) {
    case "identifier":
      return target.text();
    case "member_expression": {
      const objectRoot = staticBuiltinRoot(target.field("object"));
      return objectRoot !== undefined && GLOBAL_OBJECT_ROOTS.has(objectRoot)
        ? target.field("property")?.text()
        : undefined;
    }
    case "subscript_expression": {
      const objectRoot = staticBuiltinRoot(target.field("object"));
      if (objectRoot === undefined || !GLOBAL_OBJECT_ROOTS.has(objectRoot)) return undefined;
      return staticStringValue(target.field("index")) ?? UNRESOLVED_GLOBAL_MEMBER;
    }
    default:
      return undefined;
  }
}

/** Record an access on `object`; `property === undefined` means computed. */
function recordRootUse(found: Set<string>, object: SgNode | null | undefined, property: string | undefined): void {
  const rootName = staticBuiltinRoot(object);
  if (rootName === undefined) return;
  if (rootName === UNRESOLVED_GLOBAL_MEMBER) {
    found.add("globalThis[…]");
    return;
  }
  const members = NONDETERMINISTIC_MEMBERS.get(rootName);
  if (members === undefined) return;
  if (property === undefined) found.add(`${rootName}[…]`);
  else if (members.includes(property)) found.add(`${rootName}.${property}`);
}

/**
 * Record a binding whose value is a nondeterministic root. Destructuring names
 * the member directly; any other pattern aliases the whole root, and this scan
 * cannot follow the new name, so the alias itself is the evidence.
 */
function recordRootBinding(
  found: Set<string>,
  name: SgNode | null | undefined,
  value: SgNode | null | undefined,
): void {
  const rootName = staticBuiltinRoot(value);
  if (rootName === undefined) return;
  if (rootName === UNRESOLVED_GLOBAL_MEMBER) {
    found.add("globalThis[…]");
    return;
  }
  const members = NONDETERMINISTIC_MEMBERS.get(rootName);
  const pattern = unwrapParentheses(name ?? undefined);
  if (members === undefined) return;
  if (pattern?.kind() !== "object_pattern") {
    found.add(`alias:${rootName}`);
    return;
  }
  for (const child of pattern.children()) {
    if (child.kind() === "shorthand_property_identifier_pattern") {
      if (members.includes(child.text())) found.add(`${rootName}.${child.text()}`);
    } else if (child.kind() === "pair_pattern") {
      const key = staticObjectKey(child.field("key"));
      if (key === undefined || members.includes(key)) found.add(`${rootName}.${key ?? "…"}`);
    } else if (child.kind() === "rest_pattern") {
      found.add(`alias:${rootName}`);
    }
  }
}

/** Record a nondeterministic binding imported from a Node builtin. */
function recordBuiltinBindingImport(found: Set<string>, statement: SgNode): void {
  const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
  const exported = specifier === undefined ? undefined : NONDETERMINISTIC_BUILTIN_EXPORTS.get(specifier);
  if (specifier === undefined || exported === undefined) return;

  let named = false;
  for (const kind of ["import_specifier", "export_specifier"] as const) {
    for (const entry of statement.findAll({ rule: { kind } })) {
      named = true;
      const name = entry.field("name")?.text();
      if (name !== undefined && exported.includes(name)) found.add(`${specifier}:${name}`);
    }
  }
  // No named list means a default, namespace, or bare import: the module keeps
  // every nondeterministic member behind a name this scan cannot follow.
  if (!named) found.add(`${specifier}:*`);
}

function assessSourceIdentity(root: SgNode): WorkflowSourceIdentityAssessment {
  const declaredCoverage = readDeclaredIdentityCoverage(root);
  const builtinImports = new Set<string>();
  const unboundDependencies = new Set<string>();

  for (const statement of root.findAll({ rule: { kind: "import_statement" } })) {
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    recordStaticDependency("import", specifier, builtinImports, unboundDependencies);
  }

  for (const statement of root.findAll({ rule: { kind: "export_statement" } })) {
    if (!statement.children().some((child) => child.kind() === "from")) continue;
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    recordStaticDependency("re-export", specifier, builtinImports, unboundDependencies);
  }

  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapParentheses(call.children().find((child) => child.kind() !== "comment"));
    if (callee?.kind() === "import") {
      unboundDependencies.add(`dynamic-import:${callArgumentLabel(call)}`);
    } else if (callee?.kind() === "identifier" && callee.text() === "require") {
      unboundDependencies.add(`require:${callArgumentLabel(call)}`);
    }
  }

  for (const meta of root.findAll({ rule: { kind: "meta_property" } })) {
    if (meta.text().replace(/\s+/gu, "") === "import.meta") unboundDependencies.add("import.meta");
  }

  const sortedBuiltins = [...builtinImports].sort();
  const sortedUnbound = [...unboundDependencies].sort();
  if (declaredCoverage !== "entry-only" && sortedUnbound.length > 0) {
    const preview = sortedUnbound.slice(0, 3).join(", ");
    const suffix = sortedUnbound.length > 3 ? ` (+${sortedUnbound.length - 3} more)` : "";
    throw new Error(
      "Workflow source has dependencies outside self-contained-static identity: " +
        `${preview}${suffix}. Add literal meta.identityCoverage = \"entry-only\" to acknowledge unbound dependencies.`,
    );
  }

  return {
    identityCoverage: declaredCoverage ?? "self-contained-static",
    builtinImports: sortedBuiltins,
    unboundDependencies: sortedUnbound,
  };
}

/**
 * Machine-check whether a workflow source may have its recorded calls replayed.
 *
 * This is the SAME kind of static evidence the identity scan produces for import
 * edges, applied to the other precondition of a sound replay: that the script's
 * call sequence does not depend on values the runtime never recorded. Authors
 * reach a replayable clock/randomness through `dsl.now()` / `dsl.random()`,
 * which the run journal records; a direct `Date.now()` is not forbidden, it
 * simply makes the script unproven and therefore never replayed.
 *
 * Limits, stated plainly: this reads syntax, not behavior, and it is a filter
 * rather than a proof. It folds only what is decidable from the text — a root
 * reached through `globalThis`/`global`, a parenthesised constructor, a
 * destructured or aliased root, a named import of a nondeterministic `node:`
 * export. What it cannot see: access assembled at runtime
 * (`globalThis[key]` where `key` is computed elsewhere, `Reflect.get`, a root
 * threaded through a function parameter or property bag), a value smuggled in
 * through `process.env` or `argv`, and any nondeterminism inside an imported
 * module — which is exactly why `entry-only` coverage is treated as unproven by
 * the caller. The gate that actually prevents a wrong replay is the per-call
 * request key plus the prefix latch in the replay controller; this scan narrows
 * how often that gate is the only thing standing.
 */
export function assessWorkflowReplaySafety(source: string): WorkflowReplaySafetyAssessment {
  return assessReplaySafety(parseWorkflowSource(source));
}

export function createWorkflowScriptSnapshot(sourcePath: string, runDir: string): WorkflowScriptIdentity {
  const sourceBytes = readFileSync(sourcePath);
  const assessment = assessWorkflowSourceIdentity(sourceBytes.toString("utf8"));
  const scriptSha256 = sha256WorkflowBytes(sourceBytes);
  const snapshotPath = path.join(runDir, `script-${scriptSha256}.workflow.mjs`);
  ensureWorkflowDirectoryNoSymlink(runDir, runDir);
  writeWorkflowRunFile(runDir, snapshotPath, sourceBytes, { exclusive: true });
  chmodWorkflowRunFile(runDir, snapshotPath, 0o444);

  const identity: WorkflowScriptIdentity = {
    schemaVersion: WORKFLOW_SCRIPT_IDENTITY_SCHEMA_VERSION,
    identityPolicy: WORKFLOW_IDENTITY_POLICY,
    sourcePath,
    snapshotPath,
    scriptSha256,
    identityCoverage: assessment.identityCoverage,
    executionSource: assessment.identityCoverage === "self-contained-static" ? "snapshot" : "source",
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    builtinImports: assessment.builtinImports,
    unboundDependencies: assessment.unboundDependencies,
  };
  verifyWorkflowScriptSnapshot(identity);
  return identity;
}

export function workflowScriptExecutionPath(identity: WorkflowScriptIdentity): string {
  return identity.executionSource === "snapshot" ? identity.snapshotPath : identity.sourcePath;
}

export function verifyWorkflowScriptSnapshot(
  identity: Pick<WorkflowScriptIdentity, "snapshotPath" | "scriptSha256">,
): void {
  const snapshotSha256 = sha256WorkflowBytes(
    readWorkflowRunFile(path.dirname(identity.snapshotPath), identity.snapshotPath),
  );
  if (snapshotSha256 !== identity.scriptSha256) {
    throw new Error(`Workflow script snapshot hash mismatch: expected ${identity.scriptSha256}, got ${snapshotSha256}`);
  }
}

export function sha256WorkflowBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readDeclaredIdentityCoverage(root: SgNode): WorkflowScriptIdentity["identityCoverage"] | undefined {
  const values: Array<SgNode | null> = [];
  for (const statement of root.findAll("export const meta = $META")) {
    const meta = exportedMetaObject(statement);
    if (meta === undefined) continue;
    for (const pair of meta.children()) {
      if (pair.kind() !== "pair" || staticObjectKey(pair.field("key")) !== "identityCoverage") continue;
      values.push(pair.field("value"));
    }
  }
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error("Workflow meta.identityCoverage must be declared exactly once");
  const value = staticStringValue(values[0]);
  if (value !== "self-contained-static" && value !== "entry-only") {
    throw new Error('Workflow meta.identityCoverage must be the literal "self-contained-static" or "entry-only"');
  }
  return value;
}

function recordStaticDependency(
  kind: "import" | "re-export",
  specifier: string | undefined,
  builtinImports: Set<string>,
  unboundDependencies: Set<string>,
): void {
  if (specifier?.startsWith("node:") === true) {
    builtinImports.add(specifier);
    return;
  }
  unboundDependencies.add(`${kind}:${boundedLabel(specifier ?? "<non-literal>")}`);
}

function callArgumentLabel(call: SgNode): string {
  const args = call.children().find((child) => child.kind() === "arguments");
  const literal = staticStringValue(args?.children().find((child) => child.kind() === "string"));
  return boundedLabel(literal ?? "<dynamic>");
}

function boundedLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 256);
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 160);
}
