// excalidraw-pipeline.section-host.mjs
//
// Workflow-owned executor for agent-written diagram sections.
//
// The workflow never imports this file. It spawns it as a separate Node process
// (`node excalidraw-pipeline.section-host.mjs <plan.json>`) so that model-written
// section source never runs inside the Pi host process, and so the global-only
// resolution of `@kroffske/excalidraw-diagrams` can be supplied through NODE_PATH
// for this process alone. A child process is NOT a sandbox: it runs as the same
// user with the same filesystem. It isolates the module cache, the crash, and the
// host process — nothing more.
//
// Contract with the caller:
//   argv[2]   path to a JSON plan written by the workflow, or `--icons`
//   stdout    exactly one JSON object (the last line), never a partial result
//   exit 0    a result was produced (inspect `ok`); exit 1 means the host itself
//             could not produce a result
//
// `--icons` is the preflight probe: it proves the generation package resolves in
// this process and returns the only icon ids a section source may name.
//
// Contract with a section source file:
//   export default function buildSection({ layout, scene, title }) { ... }
//   - `layout` exposes only node/row/column/section/connect
//   - `scene` is passed to layout helpers and is never touched directly
//   - exactly one `layout.section(...)` call per file; the host owns its x/y/title
//   - the function returns { <exportName>: <block>, ... } for every declared export

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** The whole method surface a section source may use. */
const ALLOWED_LAYOUT_METHODS = ["node", "row", "column", "section", "connect"];

/** Static rejections applied before a section source is executed at all. */
const FORBIDDEN_SOURCE_PATTERNS = [
  { pattern: /\bimport\b/, reason: "a section source must not import anything; `layout` and `scene` are supplied" },
  { pattern: /\brequire\s*\(/, reason: "a section source must not call require()" },
  { pattern: /\bprocess\b/, reason: "a section source must not touch `process`" },
  { pattern: /\bglobalThis\b/, reason: "a section source must not touch `globalThis`" },
  { pattern: /\beval\s*\(/, reason: "a section source must not call eval()" },
  { pattern: /\bFunction\s*\(/, reason: "a section source must not build functions from strings" },
  { pattern: /\bfetch\s*\(/, reason: "a section source must not make network calls" },
  { pattern: /\bscene\s*\./, reason: "a section source must not call `scene` methods; use the `layout` helpers" },
  {
    pattern: /\[\s*\d+\s*\]/,
    reason: "a section source must not address children by numeric index; use the names you gave them",
  },
];

/** Left-to-right gap between two composed sections. */
const SECTION_GAP = 96;
/** Vertical room reserved for the diagram title and subtitle. */
const TITLE_BAND = 96;
/** Left/top origin of the first section. */
const ORIGIN_X = 40;
const ORIGIN_Y = TITLE_BAND + 40;

main();

function main() {
  const planPath = process.argv[2];
  if (typeof planPath !== "string" || planPath.trim() === "") {
    process.stderr.write("usage: node excalidraw-pipeline.section-host.mjs <plan.json>\n");
    process.exit(1);
  }

  let plan;
  if (planPath === "--icons") {
    plan = { mode: "icons" };
  } else {
    try {
      plan = JSON.parse(readFileSync(planPath, "utf8"));
    } catch (error) {
      process.stderr.write(`unreadable plan file ${planPath}: ${messageOf(error)}\n`);
      process.exit(1);
    }
  }

  let api;
  try {
    api = require("@kroffske/excalidraw-diagrams");
  } catch (error) {
    emit({
      ok: false,
      errors: [
        {
          section: null,
          code: "generation-package-unavailable",
          message: `@kroffske/excalidraw-diagrams could not be loaded: ${messageOf(error)}`,
        },
      ],
    });
    return;
  }

  if (plan.mode === "icons") {
    emit({ ok: true, mode: "icons", errors: [], iconIds: shortIconIds(api.AssetRegistry.bundled().ids()) });
    return;
  }

  run(plan, api)
    .then(emit)
    .catch((error) => {
      emit({
        ok: false,
        errors: [{ section: null, code: "host-failure", message: messageOf(error) }],
      });
    });
}

/**
 * Execute one plan.
 *
 * `mode: "validate"` runs a single section on a throwaway scene and reports every
 * hard error it raised. `mode: "compose"` runs every section on one scene, draws
 * the cross-section links the request declared, runs `assertDiagramHealthy`, and
 * writes the Excalidraw document.
 */
async function run(plan, api) {
  const { AssetRegistry, Bounds, Scene, assertDiagramHealthy, layout, validateDiagram } = api;
  const { resolveLabelCollisions } = layout;
  const sections = Array.isArray(plan.sections) ? plan.sections : [];
  if (sections.length === 0) {
    return { ok: false, errors: [{ section: null, code: "no-sections", message: "the plan carries no sections" }] };
  }

  const scene = new Scene({
    seed: typeof plan.seed === "number" ? plan.seed : 20260721,
    assetRegistry: AssetRegistry.bundled(),
    background: "#ffffff",
  });
  const iconIds = AssetRegistry.bundled().ids();

  const errors = [];
  const exported = new Map();
  const cards = [];
  const edges = [];
  // Every edge label the scene carries, fed to `resolveLabelCollisions` once the
  // whole diagram exists. A label is only judgeable against the finished scene.
  const labels = [];
  // Health checking ignores the blocks an arrow really connects, so every card
  // keeps the id it was recorded under.
  const blockIds = new Map();
  let cursorX = ORIGIN_X;

  for (const section of sections) {
    const outcome = await buildOneSection({
      section,
      scene,
      layout,
      iconIds,
      blockIds,
      x: cursorX,
      y: ORIGIN_Y,
    });
    if (outcome.errors.length > 0) {
      errors.push(...outcome.errors.map((message) => ({ section: section.id, code: "section-rejected", message })));
      continue;
    }
    cursorX = outcome.frameBounds.x + outcome.frameBounds.width + SECTION_GAP;
    cards.push(...outcome.cards);
    edges.push(...outcome.edges);
    labels.push(...outcome.labels);
    for (const [name, block] of outcome.exported) {
      exported.set(`${section.id}.${name}`, block);
    }
  }

  if (errors.length > 0 || plan.mode !== "compose") {
    return { ok: errors.length === 0, mode: plan.mode, errors };
  }

  if (typeof plan.title === "string" && plan.title.trim() !== "") {
    scene.text(ORIGIN_X, 24, plan.title.trim(), {
      size: 28,
      width: Math.max(cursorX - ORIGIN_X, 600),
      align: "center",
    });
  }
  if (typeof plan.subtitle === "string" && plan.subtitle.trim() !== "") {
    scene.text(ORIGIN_X, 64, plan.subtitle.trim(), {
      size: 14,
      color: "#475569",
      width: Math.max(cursorX - ORIGIN_X, 600),
      align: "center",
    });
  }

  for (const link of Array.isArray(plan.links) ? plan.links : []) {
    const source = exported.get(link.from);
    const target = exported.get(link.to);
    if (source === undefined || target === undefined) {
      errors.push({
        section: null,
        code: "link-endpoint-missing",
        message: `link ${link.from} -> ${link.to} names an export that no section produced`,
      });
      continue;
    }
    // A cross-section link is the long one: it spans the gap between two frames
    // and would cut straight through the cards in between. Routing it around
    // every placed card is composition's job, not the section author's.
    const connection = layout.connectRouted(scene, source, target, {
      ...(link.label ? { label: link.label } : {}),
      labelOnLine: true,
      obstacles: cards.map(({ block }) => block),
    });
    const id = `link-${edges.length}`;
    const points = connection.points ?? absolutePoints(connection.arrow);
    edges.push({
      id,
      from: blockIds.get(source),
      to: blockIds.get(target),
      points,
    });
    if (connection.label !== undefined) {
      labels.push({
        element: connection.label,
        points,
        ownerIds: [blockIds.get(source), blockIds.get(target)].filter((value) => value !== undefined),
      });
    }
  }
  if (errors.length > 0) {
    return { ok: false, mode: plan.mode, errors };
  }

  // Structural health says nothing about whether two labels landed on top of each
  // other, so labels are nudged off each other and off unrelated card text before
  // the diagram is judged. Deterministic and in place.
  if (labels.length > 0) {
    resolveLabelCollisions(labels, {
      cards: cards.map(({ id, block }) => ({
        id,
        bounds: block.bounds,
        textBounds: (block.elements ?? [])
          .filter((element) => element.type === "text")
          .map((element) => new Bounds(element.x, element.y, element.width, element.height)),
      })),
    });
  }

  const sceneBounds = scene.bounds();
  const healthInput = {
    blocks: cards.map(({ id, block }) => ({
      id,
      bounds: block.bounds,
      texts: (block.elements ?? []).filter((element) => element.type === "text"),
      padding: 0,
    })),
    edges,
    gap: 8,
    // Composition is dynamic, so the render frame is derived from the scene with a
    // margin. `output-clipped` is therefore not a load-bearing check here; overlap,
    // text overflow, and arrows crossing cards are.
    renderBounds: new Bounds(sceneBounds.x - 40, sceneBounds.y - 40, sceneBounds.width + 80, sceneBounds.height + 80),
    sceneBounds,
  };

  // `assertDiagramHealthy` is the acceptance gate: it throws on any error-severity
  // issue. A run is accepted only when it also reported zero warnings.
  let health;
  try {
    health = assertDiagramHealthy(healthInput);
  } catch (error) {
    const report = validateDiagram(healthInput);
    const issues = report.issues.length > 0 ? report.issues.map(describeIssue) : [messageOf(error)];
    return {
      ok: false,
      mode: plan.mode,
      errors: issues.map((message) => ({ section: null, code: "diagram-unhealthy", message })),
      health: { ok: false, errors: report.errors.length, warnings: report.warnings.length },
    };
  }
  if (health.warnings.length > 0) {
    return {
      ok: false,
      mode: plan.mode,
      errors: health.warnings.map((issue) => ({
        section: null,
        code: "diagram-unhealthy",
        message: describeIssue(issue),
      })),
      health: { ok: health.ok, errors: health.errors.length, warnings: health.warnings.length },
    };
  }

  scene.write(plan.excalidrawPath);
  const document = JSON.parse(readFileSync(plan.excalidrawPath, "utf8"));
  if (
    document.type !== "excalidraw" ||
    !Array.isArray(document.elements) ||
    document.elements.length === 0 ||
    typeof document.files !== "object" ||
    document.files === null ||
    Object.keys(document.files).length === 0
  ) {
    return {
      ok: false,
      mode: plan.mode,
      errors: [
        {
          section: null,
          code: "excalidraw-document-empty",
          message: `${plan.excalidrawPath} has no Excalidraw elements or no embedded assets`,
        },
      ],
    };
  }

  return {
    ok: true,
    mode: plan.mode,
    errors: [],
    excalidrawPath: plan.excalidrawPath,
    elements: document.elements.length,
    files: Object.keys(document.files).length,
    cards: cards.length,
    edges: edges.length,
    health: { ok: health.ok, errors: health.errors.length, warnings: health.warnings.length },
  };
}

/** Load one section source, run it against a restricted layout, and report hard errors. */
async function buildOneSection({ section, scene, layout, iconIds, blockIds, x, y }) {
  const empty = { errors: [], cards: [], edges: [], exported: [], frameBounds: { x, y, width: 0, height: 0 } };

  let source;
  try {
    source = readFileSync(section.sourcePath, "utf8");
  } catch (error) {
    return { ...empty, errors: [`the section file was not readable at ${section.sourcePath}: ${messageOf(error)}`] };
  }
  const staticErrors = staticRejections(source);
  if (staticErrors.length > 0) {
    return { ...empty, errors: staticErrors };
  }

  const recorded = { sectionCalls: 0, frame: null, cards: [], edges: [], labels: [] };
  const restricted = restrictLayout({ layout, scene, section, x, y, recorded, blockIds });

  let module;
  try {
    // The cache is busted on every attempt so a repaired file is really re-read.
    module = await import(`${pathToFileURL(section.sourcePath).href}?attempt=${Date.now()}-${Math.random()}`);
  } catch (error) {
    return { ...empty, errors: [`the section file did not load: ${messageOf(error)}`] };
  }
  const build = module.default;
  if (typeof build !== "function") {
    return { ...empty, errors: ["the section file must `export default function buildSection(context) { ... }`"] };
  }

  let returned;
  try {
    returned = build({ layout: restricted, scene, title: section.title, id: section.id });
  } catch (error) {
    return { ...empty, errors: [hintIconError(messageOf(error), iconIds)] };
  }

  if (recorded.sectionCalls !== 1) {
    return {
      ...empty,
      errors: [`the section file called layout.section ${recorded.sectionCalls} times; it must call it exactly once`],
    };
  }
  if (returned === null || typeof returned !== "object") {
    return {
      ...empty,
      errors: ["the section function must return an object mapping every declared export name to the block it names"],
    };
  }

  const declared = Array.isArray(section.exports) ? section.exports : [];
  const exportErrors = [];
  const exported = [];
  for (const name of declared) {
    const block = returned[name];
    if (block === undefined) {
      exportErrors.push(`the returned object is missing the declared export "${name}"`);
      continue;
    }
    if (block === null || typeof block !== "object" || !isBounds(block.bounds)) {
      exportErrors.push(`the declared export "${name}" is not a block produced by layout.node/row/column`);
      continue;
    }
    exported.push([name, block]);
  }
  const extra = Object.keys(returned).filter((name) => !declared.includes(name));
  if (extra.length > 0) {
    exportErrors.push(`the returned object exports ${extra.join(", ")}, which the request did not declare`);
  }
  if (exportErrors.length > 0) {
    return { ...empty, errors: exportErrors };
  }
  if (recorded.cards.length === 0) {
    return { ...empty, errors: ["the section file created no cards; every section needs at least one layout.node"] };
  }

  return {
    errors: [],
    cards: recorded.cards,
    edges: recorded.edges,
    labels: recorded.labels,
    exported,
    frameBounds: recorded.frame ?? { x, y, width: 0, height: 0 },
  };
}

/**
 * Build the only `layout` a section source ever sees.
 *
 * Placement and the section title stay workflow-owned: whatever x, y, or title the
 * source passes is replaced. Every card and every connector is recorded here, so
 * the health check sees the real geometry without the source keeping a bookkeeping
 * list it could get wrong.
 */
function restrictLayout({ layout, scene, section, x, y, recorded, blockIds }) {
  const allowed = {
    node(sceneArgument, options) {
      const block = layout.node(sceneArgument, options);
      // The block is kept, not its current bounds: `layout.section` moves its
      // children afterwards, and the health check must see the final geometry.
      const id = `${section.id}#${recorded.cards.length}`;
      recorded.cards.push({ id, block });
      blockIds.set(block, id);
      return block;
    },
    row: (children, options) => layout.row(children, options),
    column: (children, options) => layout.column(children, options),
    section(sceneArgument, options) {
      recorded.sectionCalls += 1;
      const placed = layout.section(sceneArgument, {
        padding: 24,
        titleHeight: 40,
        headerGap: 8,
        ...options,
        title: section.title,
        x,
        y,
      });
      recorded.frame = placed.bounds;
      return placed;
    },
    connect(sceneArgument, source, target, options) {
      if (recorded.sectionCalls === 0) {
        throw new Error(
          "layout.connect was called before layout.section; place the cards with layout.section first, then connect them",
        );
      }
      // The section source sees one `connect`, but composition routes it around
      // the cards already placed and keeps the label glued to its own line. The
      // scene-wide label pass in `run` needs the label element, which plain
      // `layout.connect` does not hand back.
      const connection = layout.connectRouted(sceneArgument, source, target, {
        ...options,
        labelOnLine: true,
        obstacles: recorded.cards.map(({ block }) => block),
      });
      const id = `${section.id}-edge-${recorded.edges.length}`;
      const points = connection.points ?? absolutePoints(connection.arrow);
      recorded.edges.push({
        id,
        from: blockIds.get(source),
        to: blockIds.get(target),
        points,
      });
      if (connection.label !== undefined) {
        recorded.labels.push({
          element: connection.label,
          points,
          ownerIds: [blockIds.get(source), blockIds.get(target)].filter((value) => value !== undefined),
        });
      }
      return connection.arrow;
    },
  };

  return new Proxy(allowed, {
    get(target, property) {
      if (typeof property === "string" && !ALLOWED_LAYOUT_METHODS.includes(property)) {
        throw new Error(
          `layout.${property} is not available in a section source; use only ${ALLOWED_LAYOUT_METHODS.map((name) => `layout.${name}`).join(", ")}`,
        );
      }
      return Reflect.get(target, property);
    },
  });
}

function staticRejections(source) {
  const rejections = [];
  if (source.trim() === "") {
    rejections.push("the section file is empty");
    return rejections;
  }
  // Card titles and bullets are prose: "import the ledger" or "process orders"
  // must not trip a code rule, so the rules only ever see code.
  const code = stripTextAndComments(source);
  if (!/export\s+default\s/.test(code)) {
    rejections.push("the section file has no `export default` function");
  }
  for (const { pattern, reason } of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(code)) rejections.push(reason);
  }
  for (const match of code.matchAll(/\blayout\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const method = match[1];
    if (!ALLOWED_LAYOUT_METHODS.includes(method)) {
      rejections.push(
        `layout.${method} is not part of the section contract; use only ${ALLOWED_LAYOUT_METHODS.map((name) => `layout.${name}`).join(", ")}`,
      );
    }
  }
  return [...new Set(rejections)];
}

/**
 * Replace every string literal and comment with a same-shaped blank so the static
 * rules read code only. This is a lexer good enough for the restricted section
 * grammar, not a JavaScript parser; the executing proxy is the real enforcement.
 */
function stripTextAndComments(source) {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let scan = index; scan < stop; scan += 1) output += source[scan] === "\n" ? "\n" : " ";
      index = stop;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      output += " ";
      index += 1;
      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") index += 1;
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      output += " ";
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/** `layout.connect` returns an arrow whose points are relative to its own origin. */
function absolutePoints(arrow) {
  const points = Array.isArray(arrow?.points) ? arrow.points : [];
  const originX = typeof arrow?.x === "number" ? arrow.x : 0;
  const originY = typeof arrow?.y === "number" ? arrow.y : 0;
  return points.map(([pointX, pointY]) => [originX + pointX, originY + pointY]);
}

function isBounds(bounds) {
  return (
    bounds !== null &&
    typeof bounds === "object" &&
    typeof bounds.x === "number" &&
    typeof bounds.y === "number" &&
    typeof bounds.width === "number" &&
    typeof bounds.height === "number"
  );
}

/** The registry lists pack-qualified ids; section sources use the short alias. */
function shortIconIds(iconIds) {
  return iconIds.map((id) => id.replace(/^[a-z]+_/, "").replace(/_\d+-\d+$/, ""));
}

/** Unknown icon ids already throw; restate the allowed set in the short form. */
function hintIconError(message, iconIds) {
  if (!/Unknown asset id/i.test(message)) return message;
  return `${message.split("Known ids:")[0].trim()} Allowed icon ids: ${shortIconIds(iconIds).join(", ")}`;
}

/** Health issues arrive as `{ code, severity, message, ids }`. */
function describeIssue(issue) {
  const code = issue?.code ?? "issue";
  const detail = issue?.message ?? JSON.stringify(issue);
  const ids = Array.isArray(issue?.ids) && issue.ids.length > 0 ? ` (${issue.ids.join(", ")})` : "";
  return `[${code}] ${detail}${ids}`;
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
