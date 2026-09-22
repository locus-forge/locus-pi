/**
 * check-extension-layers.ts — the steady-state ownership guardrail for
 * `extensions/_shared` and selected cross-feature boundaries.
 *
 * The shared tree has five named layers. This gate keeps their current contract
 * explicit and mechanically enforced:
 *
 *   1. No upward import. Shared code may not import feature code.
 *   2. Layer order. A shared module may import only its own layer or a lower
 *      layer. `operator` is a leaf: it may reach only `host` and itself, and no
 *      other shared layer may import it.
 *   3. Complete ownership. Every shared TypeScript file appears exactly once in
 *      `SHARED_LAYER_MEMBERS` and sits in the matching layer directory.
 *   4. Registry ownership. Every `Symbol.for("locus-pi.…")` in executable
 *      extension source has exactly one declared owning module.
 *   5. Mutable module state. Named mutable bindings remain with their declared
 *      owner, and new mutable exported containers under `_shared` fail closed.
 *   6. Feature-internal facades. A declared feature-internal module may be
 *      imported from another feature only through its declared read facade.
 *   7. Pure modules. A declared pure module's transitive VALUE-import closure
 *      may not reach a host-bound Node builtin (`node:fs`, `node:path`, and the
 *      rest of `PURE_MODULE_FORBIDDEN_BUILTINS`).
 *
 * Registry and feature-import sweeps cover executable source under
 * `extensions/**`; tests are intentionally out of scope. Imports are read from
 * the TypeScript AST, including static imports, re-exports, import types, and
 * literal dynamic imports. Rules 1-3 and 6 enforce type-only edges too, because
 * a type-only edge still encodes ownership; rule 7 is the one rule that follows
 * value edges only, since it is about what actually loads at runtime. Type-only
 * is read per specifier, so `import { a, type B }` is a value edge while
 * `import { type A, type B }` is not.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Ledger: shared layers
// ---------------------------------------------------------------------------

type SharedLayer = "host" | "operator" | "runtime" | "model" | "agent-runtime";

/**
 * Rank is the only thing rule 2 compares, EXCEPT for `operator`, which is
 * narrowed by name in `layerImportAllowed` in both directions: it may reach only
 * `host` and itself, and no other layer may reach it. Operator UI is a leaf
 * consumer — a shared layer that depended on it would drag command registration
 * and rendering into foundational code.
 */
const LAYER_RANK: Record<SharedLayer, number> = {
  host: 0,
  operator: 1,
  runtime: 2,
  model: 2,
  "agent-runtime": 3,
};

const SHARED_LAYER_MEMBERS: Record<SharedLayer, readonly string[]> = {
  host: [
    "pi-api",
    "error-text",
    "error-journal",
    "files",
    "validation",
    "redaction",
    "render-profile",
    "render-scheduler",
    "safe-output",
  ],
  operator: [
    "command-ui",
    "widget-render",
    "operator-ui",
    "operator-status",
    "operator-input",
    "operator-interaction",
    "operator-keys",
    "operator-question",
    "operator-notify",
    "viewer-geometry",
  ],
  /** `runtime-capabilities` constructs and reports on the session store, so runtime owns it.
   *  `long-timer` is pure `setTimeout` arithmetic with no host binding at all, and both the
   *  agent host and the workflow runtime arm deadlines through it, so it sits at the lowest
   *  layer either of them can reach. */
  runtime: ["session-core", "artifacts", "event-bus", "runtime-capabilities", "long-timer"],
  model: ["model-settings", "live-model-display", "workflow-model-resolve", "session-tool-transport"],
  "agent-runtime": [
    "agents",
    "agent-context-extras",
    "agent-evidence-evaluator",
    "agent-execution-prompt",
    /** The closed failure-cause list is value-imported by workflow runtime; keep this module import-free. */
    "agent-failure-cause",
    "agent-live-panel",
    "agent-live-store",
    "agent-live-transcript",
    "agent-names",
    "agent-read-only-policy",
    "agent-runner",
    "agent-sdk-host",
    "agent-system-prompt",
    "fleet-menu",
  ],
};

// ---------------------------------------------------------------------------
// Feature-internal facade (rule 6)
// ---------------------------------------------------------------------------

const WORKFLOW_READ_FACADE = "extensions/workflows/run/run-read.ts";

// ---------------------------------------------------------------------------
// Feature-internal modules (rule 6)
// ---------------------------------------------------------------------------

interface FeatureInternalEntry {
  readonly module: string;
  readonly owner: string;
  readonly facade: string;
  readonly reason: string;
}

const FEATURE_INTERNAL_MODULES: readonly FeatureInternalEntry[] = [
  {
    module: "extensions/workflows/runtime/workflow-journal.ts",
    owner: "extensions/workflows",
    facade: WORKFLOW_READ_FACADE,
    reason:
      "the journal owns run layout and append/write operations; outside consumers receive only the read operations exposed by the workflow facade.",
  },
  {
    module: "extensions/workflows/runtime/workflow-journal-format.ts",
    owner: "extensions/workflows",
    facade: WORKFLOW_READ_FACADE,
    reason:
      "the strict line codec decides what counts as readable run evidence, so validating a persisted line outside the feature reads a run around the facade; the line TYPES stay reachable through workflow-runtime.ts, which re-exports them.",
  },
  {
    module: "extensions/workflows/runtime/workflow-result.ts",
    owner: "extensions/workflows",
    facade: WORKFLOW_READ_FACADE,
    reason:
      "this module both writes the persisted result envelope and decides, on readback, which stored fields still count as readable run evidence; the run-local result PATH stays reachable through the workflow facade.",
  },
  {
    module: "extensions/workflows/runtime/workflow-run-snapshot.ts",
    owner: "extensions/workflows",
    facade: WORKFLOW_READ_FACADE,
    reason:
      "this module decides whether the bytes a run actually executed are still provable (ready/legacy/missing/unreadable/invalid/tampered), so verifying a snapshot outside the feature reads a run around the facade.",
  },
  {
    module: "extensions/workflows/runtime/workflow-run-resume.ts",
    owner: "extensions/workflows",
    facade: WORKFLOW_READ_FACADE,
    reason:
      "this module reads a stopped run's persisted authority — result envelope, launch binding, retained snapshot, replay log — and decides whether it may be continued, so resuming a run from outside the feature would judge that evidence around the facade.",
  },
  {
    module: "extensions/workflows/runtime/workflow-run-admission.ts",
    owner: "extensions/workflows",
    facade: WORKFLOW_READ_FACADE,
    reason:
      "the ordered admission reads the same persisted authority to decide which workspace a launch may write and then WRITES the launch binding a later resume trusts, so admitting a run from outside the feature would mint that authority around the facade.",
  },
  {
    module: "extensions/workflows/runtime/workflow-live.ts",
    owner: "extensions/workflows",
    facade: WORKFLOW_READ_FACADE,
    reason:
      "this module owns the process-global live-executions registry and the journal-to-live-row projection; outside consumers get only row-id reads through the workflow facade.",
  },
];

// ---------------------------------------------------------------------------
// Pure modules (rule 7)
// ---------------------------------------------------------------------------

interface PureModuleEntry {
  readonly module: string;
  readonly reason: string;
}

/** Host-bound builtins a declared pure module may not reach through value imports. */
const PURE_MODULE_FORBIDDEN_BUILTINS: ReadonlySet<string> = new Set([
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "node:path",
  "node:os",
  "node:process",
]);

/**
 * Modules whose purity claim is load-bearing, and the reason it is.
 *
 * `workflow-journal-format.ts` is deliberately absent: its codec checks run ids and artifact
 * names against `workflow-run-layout.ts`, which reaches `node:fs`, exactly as
 * `workflow-artifact-format.ts` does. Every specifier the DSL core imports from it is
 * type-only, so the `workflow-runtime.ts` entry below still proves the core's value closure.
 *
 * `workflow-execution-state.ts` (the run's one counter, leaf gate and deadline) and
 * `workflow-groups.ts` (`parallel()`/`pipeline()`) are likewise absent and need no entry of
 * their own: the core value-imports both, and rule 7 walks the closure transitively, so the
 * `workflow-runtime.ts` entry already holds them to the same `node:fs`-free proof.
 *
 * The four owners of ONE agent call are in that same closure for the same reason:
 * `workflow-agent-contract.ts` (the shared request/result/options vocabulary and the typed
 * refusals), `workflow-agent-call.ts` (the logical call — ordinal, slot claim, canonical
 * key, replay envelope, transport retry), `workflow-agent-attempt.ts` (ONE physical
 * child — invocation charge, `callId`, leaf permit, journal pair, evidence adoption) and
 * `workflow-agent-output.ts` (the shaped half — `choice`/`handoffs`/`schema`/`output`/
 * `validate` dispatch, acceptance from the confirmed `workflow_return` receipt, the choice
 * decision projection). The core value-imports the call, the attempt and the output owner;
 * all three value-import the contract, and the output owner reaches `workflow-return.ts`
 * and `workflow-schema.ts`, both of which are already fs-free. `workflow-agent-bridge.ts`
 * reads the contract directly rather than the core — so the host side of a call never
 * pulls the DSL composition root in behind it.
 *
 * `workflow-fusion.ts` is in that same closure and needs no entry of its own for the same
 * reason: the core value-imports it, and rule 7 walks the closure transitively. A Fusion
 * panel is a COMPOSITION of ordinary `agent()` calls — it value-imports the contract, the
 * shaped-output owner and `workflow-execution-state.ts`, all already proven fs-free here,
 * and it reaches the artifact store, the replay controller and the group scheduler only as
 * types or as injected ports, so nothing durable enters behind it. The host `/fusion`
 * surface is the other direction: `fusion/config.ts` and `fusion/runner.ts` read the Fusion
 * vocabulary from that module and the run machinery from their own fs-bound imports, so the
 * DSL owner never pulls a host module in behind it. Nothing outside `extensions/workflows/`
 * reaches it, so no cross-feature facade rule applies.
 */
const PURE_MODULES: readonly PureModuleEntry[] = [
  {
    module: "extensions/workflows/runtime/workflow-runtime.ts",
    reason:
      "the DSL core reaches agents only through an injected runner, so it stays host-agnostic and unit-testable in isolation.",
  },
  {
    module: "extensions/workflows/runtime/workflow-handoff-contract.ts",
    reason:
      "operator handoff declarations are normalized inside that core, so the declaration half stays separable from the durable envelope and claim sidecar in workflow-handoff.ts.",
  },
  {
    module: "extensions/workflows/operator/progress-render.ts",
    reason:
      "the read-only half of the progress surface — layout, rail, stage frontier, roster clamping — is decided from plain inputs, so it stays separable from the subscriptions, timers and viewport reservation in progress-widget.ts.",
  },
  {
    module: "extensions/workflows/runtime/workflow-outcome.ts",
    reason:
      "what a result means — JSON detachment, disposition and classification — is decided inside that core, so it stays separable from result.json persistence in workflow-result.ts.",
  },
];

// ---------------------------------------------------------------------------
// Process-global registries (rule 4)
// ---------------------------------------------------------------------------

interface RegistryEntry {
  readonly symbol: string;
  readonly owner: string;
}

/** Symbol string -> the one executable module allowed to name it. */
const REGISTRIES: readonly RegistryEntry[] = [
  { symbol: "locus-pi.agent-live-store.v5", owner: "extensions/_shared/agent-runtime/agent-live-store.ts" },
  { symbol: "locus-pi.workflow-live-executions.v1", owner: "extensions/workflows/runtime/workflow-live.ts" },
  { symbol: "locus-pi.fleet-menu-state.v3", owner: "extensions/_shared/agent-runtime/fleet-menu.ts" },
  { symbol: "locus-pi.fleet-viewed-row.v1", owner: "extensions/_shared/agent-runtime/fleet-menu.ts" },
  { symbol: "locus-pi.command-ui-lifecycle.v2", owner: "extensions/_shared/operator/command-ui.ts" },
  { symbol: "locus-pi.operator-status.v1", owner: "extensions/_shared/operator/operator-status.ts" },
  { symbol: "locus-pi.workflow-background-runs.v1", owner: "extensions/workflows/run/background-run-registry.ts" },
  { symbol: "locus-pi.active-agent-session-viewers.v1", owner: "extensions/agents/fleet/session-viewer.ts" },
  { symbol: "locus-pi.viewer-external-rows.v1", owner: "extensions/_shared/operator/viewer-geometry.ts" },
];

// ---------------------------------------------------------------------------
// Non-symbol mutable module state (rule 5)
// ---------------------------------------------------------------------------

interface MutableStateEntry {
  readonly file: string;
  readonly binding: string;
  readonly note: string;
}

/** Plain mutable module bindings whose process semantics require an explicit owner. */
const MUTABLE_MODULE_STATE: readonly MutableStateEntry[] = [
  {
    file: "extensions/agents/catalog/catalog.ts",
    binding: "agentCatalog",
    note: "the resolved agent catalog; agents/catalog/catalog.ts#refreshAgents is the only writer and rebuilds it from disk on every discovery pass.",
  },
  {
    file: "extensions/ast-structural-edit/ast-engine.ts",
    binding: "pythonRegistered",
    note: "a module-level guard for one-shot ast-grep dynamic language registration.",
  },
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const SHARED_DIR = "extensions/_shared";
const EXTENSIONS_DIR = "extensions";
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".mjs", ".js"]);

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await checkExtensionLayers(process.cwd());
}

interface Classification {
  readonly layer: SharedLayer;
}

interface ImportEdge {
  readonly line: number;
  readonly specifier: string;
  readonly typeOnly: boolean;
}

export async function checkExtensionLayers(root: string): Promise<void> {
  const failures: string[] = [];
  const ledger = buildLedger(failures);
  const sharedFiles = await listFiles(path.join(root, SHARED_DIR), root);
  const sharedSources = sharedFiles.filter((file) => file.endsWith(".ts"));

  const byBasename = new Map<string, string>();
  for (const file of sharedSources) {
    const name = path.basename(file, ".ts");
    const previous = byBasename.get(name);
    if (previous) {
      failures.push(
        `ambiguous ledger key: ${previous} and ${file} share the basename "${name}"; ` +
          `the shared ledger is keyed by basename, so two modules may not share one.`,
      );
      continue;
    }
    byBasename.set(name, file);
  }

  // Rule 3: every shared file is declared, and every declaration resolves to one file.
  for (const [name, file] of byBasename) {
    if (ledger.has(name)) continue;
    failures.push(
      `rule 3 (complete ownership): ${file} has no shared-layer declaration. ` +
        `Add "${name}" to exactly one SHARED_LAYER_MEMBERS entry.`,
    );
  }
  for (const [name, classification] of ledger) {
    const expected = `${SHARED_DIR}/${classification.layer}/${name}.ts`;
    const actual = byBasename.get(name);
    if (actual === undefined) {
      failures.push(
        `rule 3 (complete ownership): shared:${classification.layer} declares "${name}" at ${expected}, but the file does not exist. Remove the stale entry or restore the owned module.`,
      );
    } else if (actual !== expected) {
      failures.push(
        `rule 3 (complete ownership): ${actual} is declared shared:${classification.layer}; its path must be ${expected}.`,
      );
    }
  }

  for (const file of sharedSources) {
    const name = path.basename(file, ".ts");
    const classification = ledger.get(name);
    const text = await readFile(path.join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));

    for (const edge of collectImportEdges(source)) {
      if (!edge.specifier.startsWith(".")) continue;
      const resolved = resolveSpecifier(file, edge.specifier);
      const kindLabel = edge.typeOnly ? "type-only import" : "value import";

      if (!isInside(resolved, SHARED_DIR)) {
        failures.push(
          `rule 1 (no upward import): ${file}:${edge.line} ${kindLabel} of "${edge.specifier}" escapes ` +
            `${SHARED_DIR}/ and resolves to ${resolved}. Shared code may not import a feature directory.`,
        );
        continue;
      }
      if (!classification) continue; // Rule 3 already reports the source.

      const targetName = path.basename(resolved).replace(/\.(?:js|ts)$/, "");
      const target = ledger.get(targetName);
      if (!target) continue; // Rule 3 reports the target.
      if (layerImportAllowed(classification.layer, target.layer)) continue;
      failures.push(
        `rule 2 (layer order): ${file}:${edge.line} is shared:${classification.layer} and ${kindLabel}s ` +
          `"${edge.specifier}", which is shared:${target.layer}. ${describeAllowedTargets(classification.layer)} ` +
          `A type-only edge still encodes ownership.`,
      );
    }

    for (const binding of collectMutableExports(source)) {
      const declared = MUTABLE_MODULE_STATE.some((entry) => entry.file === file && entry.binding === binding.name);
      if (declared) continue;
      failures.push(
        `rule 5 (mutable module state): ${file}:${binding.line} exports mutable module-level binding ` +
          `"${binding.name}" (${binding.reason}), which is not declared. Make it immutable, promote it to a ` +
          `declared versioned registry, or add its exact owner to MUTABLE_MODULE_STATE.`,
      );
    }
  }

  for (const entry of MUTABLE_MODULE_STATE) {
    if (await locateBinding(root, entry)) continue;
    failures.push(
      `rule 5 (mutable module state): declared binding "${entry.binding}" was not found in ${entry.file}. ` +
        `${entry.note} Update MUTABLE_MODULE_STATE in the same change that moves, renames, or removes it.`,
    );
  }

  failures.push(...(await checkRegistries(root)));
  failures.push(...(await checkFeatureInternalModules(root)));
  failures.push(...(await checkPureModules(root)));

  if (failures.length > 0) {
    console.error(`Extension layer check failed with ${failures.length} violation(s):\n\n${failures.join("\n\n")}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Extension layers verified: ${sharedSources.length} shared source(s) across ${Object.keys(SHARED_LAYER_MEMBERS).length} declared layer(s), ` +
      `${REGISTRIES.length} process-global registries, ${MUTABLE_MODULE_STATE.length} mutable module bindings, ` +
      `${FEATURE_INTERNAL_MODULES.length} feature-internal module(s) behind a facade, ` +
      `${PURE_MODULES.length} pure module(s) free of host-bound builtins.`,
  );
}

function buildLedger(failures: string[]): Map<string, Classification> {
  const ledger = new Map<string, Classification>();
  for (const [layer, members] of Object.entries(SHARED_LAYER_MEMBERS) as [SharedLayer, readonly string[]][]) {
    for (const name of members) {
      const previous = ledger.get(name);
      if (previous) {
        failures.push(
          `ledger conflict: "${name}" is declared in both shared:${previous.layer} and shared:${layer}. A module has exactly one owner.`,
        );
        continue;
      }
      ledger.set(name, { layer });
    }
  }
  return ledger;
}

function layerImportAllowed(from: SharedLayer, to: SharedLayer): boolean {
  if (from === "operator") return to === "host" || to === "operator";
  if (to === "operator") return false;
  return LAYER_RANK[to] <= LAYER_RANK[from];
}

function describeAllowedTargets(from: SharedLayer): string {
  if (from === "operator") {
    return "The operator layer may import only the host layer and itself, by declared contract.";
  }
  const allowed = (Object.keys(LAYER_RANK) as SharedLayer[])
    .filter((layer) => layerImportAllowed(from, layer))
    .sort((a, b) => LAYER_RANK[a] - LAYER_RANK[b] || a.localeCompare(b));
  return `shared:${from} may import only: ${allowed.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Source analysis
// ---------------------------------------------------------------------------

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".mjs" || extension === ".js") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function collectImportEdges(source: ts.SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({
        line: lineOf(source, node),
        specifier: node.moduleSpecifier.text,
        typeOnly: importDeclarationTypeOnly(node),
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({
        line: lineOf(source, node),
        specifier: node.moduleSpecifier.text,
        typeOnly: exportDeclarationTypeOnly(node),
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      edges.push({ line: lineOf(source, node), specifier: node.argument.literal.text, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) {
        edges.push({ line: lineOf(source, node), specifier: argument.text, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return edges;
}

/**
 * Type-only per SPECIFIER, not per clause. `import { a, type B }` still loads
 * the module at runtime and is a value edge; `import { type A, type B }` does
 * not and is type-only. A bare `import "x"` and a default or namespace import
 * are always value edges.
 */
function importDeclarationTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
  if (bindings.elements.length === 0) return false;
  return bindings.elements.every((element) => element.isTypeOnly);
}

/** The re-export mirror of `importDeclarationTypeOnly`. */
function exportDeclarationTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return false;
  if (clause.elements.length === 0) return false;
  return clause.elements.every((element) => element.isTypeOnly);
}

interface MutableBinding {
  readonly name: string;
  readonly line: number;
  readonly reason: string;
}

function collectMutableExports(source: ts.SourceFile): MutableBinding[] {
  const bindings: MutableBinding[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!exported) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      const line = lineOf(source, declaration);
      if (!isConst) {
        bindings.push({ name, line, reason: "`export let`/`export var` is rebindable by its own module" });
        continue;
      }
      const initializer = declaration.initializer;
      if (!initializer) continue;
      if (!isMutableContainerInitializer(initializer)) continue;
      if (declaration.type && isReadonlyTypeNode(declaration.type)) continue;
      bindings.push({
        name,
        line,
        reason:
          "`export const` of a mutable object, array, Map, Set, WeakMap, or WeakSet with no immutable wrapper or readonly annotation",
      });
    }
  }
  return bindings;
}

function isMutableContainerInitializer(node: ts.Expression): boolean {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return false;
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) return true;
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    new Set(["Map", "Set", "WeakMap", "WeakSet"]).has(node.expression.text)
  );
}

function isReadonlyTypeNode(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.ReadonlyKeyword) return true;
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return true;
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const typeName = node.typeName.text;
    if (
      typeName === "Readonly" ||
      typeName === "ReadonlyArray" ||
      typeName === "ReadonlyMap" ||
      typeName === "ReadonlySet"
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Registries and mutable state
// ---------------------------------------------------------------------------

async function checkRegistries(root: string): Promise<string[]> {
  const failures: string[] = [];
  const files = (await listFiles(path.join(root, EXTENSIONS_DIR), root)).filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file)),
  );
  const found = new Map<string, { file: string; line: number }[]>();

  for (const file of files) {
    const text = await readFile(path.join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Symbol" &&
        node.expression.name.text === "for" &&
        node.arguments.length === 1
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument) && argument.text.startsWith("locus-pi.")) {
          found.set(argument.text, [...(found.get(argument.text) ?? []), { file, line: lineOf(source, node) }]);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  for (const [symbol, sites] of found) {
    const declared = REGISTRIES.find((entry) => entry.symbol === symbol);
    if (!declared) {
      failures.push(
        `rule 4 (registry ownership): undeclared process-global registry Symbol.for("${symbol}") at ` +
          `${sites.map((site) => `${site.file}:${site.line}`).join(", ")}. Declare exactly one owning module in REGISTRIES.`,
      );
      continue;
    }
    const strays = sites.filter((site) => site.file !== declared.owner);
    if (strays.length > 0) {
      failures.push(
        `rule 4 (registry ownership): Symbol.for("${symbol}") is owned by ${declared.owner} but is also named at ` +
          `${strays.map((site) => `${site.file}:${site.line}`).join(", ")}. Keep exactly one owner.`,
      );
    }
  }

  for (const entry of REGISTRIES) {
    const sites = found.get(entry.symbol) ?? [];
    if (sites.some((site) => site.file === entry.owner)) continue;
    failures.push(
      `rule 4 (registry ownership): declared registry Symbol.for("${entry.symbol}") was not found at its owner ${entry.owner}. Update the declaration in the same change that moves, renames, or removes the registry.`,
    );
  }

  return failures;
}

async function checkFeatureInternalModules(root: string): Promise<string[]> {
  const failures: string[] = [];
  if (FEATURE_INTERNAL_MODULES.length === 0) return failures;

  const sources = (await listFiles(path.join(root, EXTENSIONS_DIR), root)).filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file)),
  );
  const active: FeatureInternalEntry[] = [];

  for (const entry of FEATURE_INTERNAL_MODULES) {
    if (!(await fileExists(path.join(root, entry.module)))) {
      failures.push(
        `rule 6 (feature-internal facade): declared internal module ${entry.module} does not exist. Update FEATURE_INTERNAL_MODULES in the same change that moves, renames, or removes it.`,
      );
      continue;
    }
    if (!(await fileExists(path.join(root, entry.facade)))) {
      failures.push(
        `rule 6 (feature-internal facade): ${entry.module} is internal to ${entry.owner}/ but its facade ${entry.facade} does not exist.`,
      );
      continue;
    }
    active.push(entry);
  }

  for (const file of sources) {
    if (isInside(file, SHARED_DIR)) continue; // Shared edges are governed by rules 1-3.
    const text = await readFile(path.join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    for (const edge of collectImportEdges(source)) {
      if (!edge.specifier.startsWith(".")) continue;
      const resolved = resolveSpecifier(file, edge.specifier);
      for (const entry of active) {
        if (!sameModule(resolved, entry.module)) continue;
        if (isInside(file, entry.owner) || file === entry.facade) continue;
        failures.push(
          `rule 6 (feature-internal facade): ${file}:${edge.line} ${edge.typeOnly ? "type-only import" : "value import"} ` +
            `of "${edge.specifier}" resolves to ${entry.module}, which is internal to ${entry.owner}/. ` +
            `Import ${entry.facade} instead — ${entry.reason}`,
        );
      }
    }
  }

  return failures;
}

/** Compare an import target with a source path, ignoring the ESM `.js`-for-`.ts` spelling. */
function sameModule(resolved: string, modulePath: string): boolean {
  return stripSourceExtension(resolved) === stripSourceExtension(modulePath);
}

function stripSourceExtension(value: string): string {
  return value.replace(/\.(?:mts|mjs|ts|js)$/, "");
}

async function locateBinding(root: string, entry: MutableStateEntry): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path.join(root, entry.file), "utf8");
  } catch {
    return false;
  }
  const source = ts.createSourceFile(entry.file, text, ts.ScriptTarget.Latest, true, scriptKindFor(entry.file));
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === entry.binding) found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/**
 * Rule 7: a declared pure module's transitive VALUE-import closure must not
 * reach a host-bound builtin. Only value edges are followed, because the claim
 * is about what actually loads at runtime; a type-only edge erases at compile
 * time and is therefore allowed to cross into a durable module.
 */
async function checkPureModules(root: string): Promise<string[]> {
  const failures: string[] = [];
  const edgeCache = new Map<string, readonly ImportEdge[] | undefined>();

  const readEdges = async (file: string): Promise<readonly ImportEdge[] | undefined> => {
    const cached = edgeCache.get(file);
    if (cached !== undefined || edgeCache.has(file)) return cached;
    let text: string;
    try {
      text = await readFile(path.join(root, file), "utf8");
    } catch {
      edgeCache.set(file, undefined);
      return undefined;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const edges = collectImportEdges(source);
    edgeCache.set(file, edges);
    return edges;
  };

  for (const entry of PURE_MODULES) {
    if (!(await fileExists(path.join(root, entry.module)))) {
      failures.push(
        `rule 7 (pure modules): declared pure module ${entry.module} does not exist. Update PURE_MODULES in the same change that moves, renames, or removes it.`,
      );
      continue;
    }
    const chain = await findHostBoundImport(root, entry.module, readEdges);
    if (chain === undefined) continue;
    failures.push(
      `rule 7 (pure modules): ${entry.module} reaches ${chain[chain.length - 1]} through value imports ` +
        `(${chain.join(" -> ")}). ${entry.reason} Keep the host-bound half in its durable counterpart and ` +
        `import it type-only, or move the pure half it needs into a module that has no host dependency.`,
    );
  }

  return failures;
}

/** Breadth-first, so the reported chain is the shortest value path to the builtin. */
async function findHostBoundImport(
  root: string,
  entryModule: string,
  readEdges: (file: string) => Promise<readonly ImportEdge[] | undefined>,
): Promise<string[] | undefined> {
  const parents = new Map<string, string>();
  const visited = new Set<string>([entryModule]);
  const queue: string[] = [entryModule];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const edges = await readEdges(file);
    if (edges === undefined) continue;
    for (const edge of edges) {
      if (edge.typeOnly) continue;
      if (PURE_MODULE_FORBIDDEN_BUILTINS.has(edge.specifier)) {
        return [...pathFromEntry(file, parents), edge.specifier];
      }
      if (!edge.specifier.startsWith(".")) continue; // Bare packages other than node:* are out of scope.
      const target = await resolveSourceFile(root, resolveSpecifier(file, edge.specifier));
      if (target === undefined || visited.has(target)) continue;
      visited.add(target);
      parents.set(target, file);
      queue.push(target);
    }
  }

  return undefined;
}

function pathFromEntry(file: string, parents: ReadonlyMap<string, string>): string[] {
  const chain = [file];
  let cursor = file;
  for (;;) {
    const parent = parents.get(cursor);
    if (parent === undefined) return chain;
    chain.unshift(parent);
    cursor = parent;
  }
}

/** Map one resolved ESM specifier onto the source file that actually holds it. */
async function resolveSourceFile(root: string, resolved: string): Promise<string | undefined> {
  const candidates = [resolved.replace(/\.(?:mjs|js)$/, ".ts"), resolved, `${resolved}.ts`, `${resolved}/index.ts`];
  for (const candidate of candidates) {
    if (await fileExists(path.join(root, candidate))) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveSpecifier(fromFile: string, specifier: string): string {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(fromFile)), specifier));
  return resolved;
}

function isInside(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    const entryStat = await stat(absolutePath);
    return entryStat.isFile();
  } catch {
    return false;
  }
}

async function listFiles(absoluteDirectory: string, root: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolutePath, root)));
    else if (entry.isFile()) files.push(toPosix(path.relative(root, absolutePath)));
  }
  return files.sort();
}
