/**
 * The standard grammar and the owned-policy profile: which module surface,
 * statements, imports, expressions and identifier roots a `.workflow.mjs`
 * source may spell at all. Owned by `tool/workflow-source-shape.ts`, the
 * orchestration that runs these checks before any value is classified.
 */
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../../extensions/workflows/tool/workflow-source-shape.js";

function standardSource(run: string, declarations = ""): string {
  return [
    'export const meta = { name: "contract-test", profile: "standard", description: "Contract test." };',
    declarations,
    run,
  ]
    .filter(Boolean)
    .join("\n");
}

const STANDARD_DSL_RETURN_CASES = [
  { method: "agent", call: 'dsl.agent("x")', category: "opaque" },
  { method: "awaitOperator", call: 'dsl.awaitOperator({ reason: "stop" })', category: "void" },
  {
    method: "consumeTextArtifact",
    call: 'dsl.consumeTextArtifact({ path: "x", bytes: 1, sha256: "x" })',
    category: "opaque",
  },
  { method: "continuationArtifacts", call: "dsl.continuationArtifacts()", category: "list" },
  {
    method: "invokeWorkflow",
    call: 'dsl.invokeWorkflow({ child: "worker", key: "one", keys: ["one"], outputDir: dsl.outputDir() })',
    category: "status",
  },
  { method: "items", call: "dsl.items()", category: "list" },
  { method: "log", call: 'dsl.log("x")', category: "void" },
  { method: "now", call: "dsl.now()", category: "runtime" },
  { method: "outputDir", call: "dsl.outputDir()", category: "runtime" },
  { method: "parallel", call: 'dsl.parallel([() => dsl.agent("x")])', category: "list" },
  { method: "phase", call: 'dsl.phase("x")', category: "void" },
  { method: "pipeline", call: 'dsl.pipeline(["x"], (item) => dsl.agent(item))', category: "list" },
  { method: "projectRoot", call: "dsl.projectRoot()", category: "runtime" },
  { method: "promptFile", call: 'dsl.promptFile("x.prompt.md")', category: "opaque" },
  { method: "publishArtifact", call: 'dsl.publishArtifact("x.md", "x")', category: "runtime" },
  {
    method: "publishPrimaryArtifact",
    call: 'dsl.publishPrimaryArtifact("x.md", "x")',
    category: "runtime",
  },
  { method: "publishPrimaryFile", call: 'dsl.publishPrimaryFile("x.md")', category: "runtime" },
  { method: "random", call: "dsl.random()", category: "runtime" },
  { method: "workflow", call: 'dsl.workflow(() => dsl.agent("x"))', category: "opaque" },
  { method: "workspace", call: 'dsl.workspace("work", "HEAD")', category: "opaque" },
] as const;

describe("standard workflow source grammar and policy", () => {
  it("classifies every allowed standard DSL method exactly once", () => {
    expect(STANDARD_DSL_RETURN_CASES.map(({ method }) => method)).toEqual([
      "agent",
      "awaitOperator",
      "consumeTextArtifact",
      "continuationArtifacts",
      "invokeWorkflow",
      "items",
      "log",
      "now",
      "outputDir",
      "parallel",
      "phase",
      "pipeline",
      "projectRoot",
      "promptFile",
      "publishArtifact",
      "publishPrimaryArtifact",
      "publishPrimaryFile",
      "random",
      "workflow",
      "workspace",
    ]);
  });

  it("rejects the removed runWorkspaceDir from standard source", () => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource("export default function run(dsl) { return dsl.runWorkspaceDir(); }"),
      ),
    ).toContain("standard profile calls only direct DSL primitives and visible map/prompt-join operations");
  });

  it.each([
    [
      "named function entry",
      standardSource(`export default async function runWorkflow(dsl, input) {
  const topic = typeof input === "string" && input.trim() ? input.trim() : "default topic";
  const answer = await dsl.agent(\`Topic: \${topic}. Choose the route.\`, { choice: ["DONE", "BLOCKED"] });
  if (answer === "DONE") dsl.log(answer);
  return { topic, answer };
}`),
    ],
    [
      "arrow entry with visible inline edges",
      standardSource(`export default async (dsl) => {
  const { agent, parallel } = dsl;
  const items = ["one", "two"];
  return parallel(items.map((item) => () => agent(\`Handle \${item}\`)));
};`),
    ],
    [
      "author-known top-level collection",
      standardSource(
        `export default async function run({ agent, parallel }) {
  return parallel(ITEMS.map((item) => () => agent(\`Handle \${item}\`)));
}`,
        'const ITEMS = ["one", "two"];',
      ),
    ],
    [
      "prompt-only collection join",
      standardSource(`export default async function run({ agent, parallel }) {
  const findings = await parallel([() => agent("Inspect one"), () => agent("Inspect two")]);
  return agent(\`Compose these exact findings:\n\${findings.join("\\n\\n")}\`);
}`),
    ],
    [
      "durable item loop with unshadowed Error",
      standardSource(`export default async function runWorkflow(dsl) {
  const items = dsl.items();
  if (items.length === 0) throw new Error("items required");
  const keys = items.map((_, itemIndex) => \`item-\${itemIndex + 1}\`);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await dsl.invokeWorkflow({
      name: "worker",
      key: keys[index],
      keys,
      input: item,
      items: [item],
      outputDir: dsl.outputDir(),
    });
  }
  return dsl.publishPrimaryFile("report.md");
}`),
    ],
    ["literal Error construction", standardSource('export default function run() { throw new Error("stop"); }')],
    ["ordinary acknowledgement result", standardSource('export default () => "WRITTEN";')],
    ["bare DSL arrow parameter", standardSource('export default dsl => dsl.agent("x");')],
    [
      "literal binding names without substring policy",
      standardSource("export default function run() { const checkpointLedger = []; return checkpointLedger; }"),
    ],
    [
      "whole opaque values forwarded to prompts and publication",
      standardSource(`export default async function run({ agent, publishPrimaryArtifact }, input) {
  const answer = await agent(\`Review this exact request: \${input}\`);
  return publishPrimaryArtifact("review.md", answer);
}`),
    ],
    [
      "opaque whole value scheduled inside explicit input and items fields",
      standardSource(`export default async function run({ agent, invokeWorkflow, outputDir }, input) {
  const answer = await agent(input);
  await invokeWorkflow({
    name: "worker",
    key: "one",
    keys: ["one"],
    input: answer,
    items: [answer],
    outputDir: outputDir(),
  });
  return answer;
}`),
    ],
    [
      "direct opaque producer scheduled as an explicit whole input",
      standardSource(`export default async function run({ agent, invokeWorkflow, outputDir }, input) {
  return invokeWorkflow({
    name: "worker",
    key: "one",
    keys: ["one"],
    input: await agent(input),
    items: [input],
    outputDir: outputDir(),
  });
}`),
    ],
    [
      "runtime-owned choice controls a branch",
      standardSource(`export default async function run({ agent }) {
  const route = await agent("Choose a route.", {
    choice: ["accept", "revise"],
    choiceFallback: "revise",
  });
  if (route === "accept") return agent("Handle the accepted route.");
  return agent("Handle the revision route.");
}`),
    ],
    [
      "runtime-owned choice indexes author-known routes",
      standardSource(
        `export default async function run({ agent }) {
  const route = await agent("Choose a route.", { choice: ["deploy", "hold"] });
  return agent(ROUTES[route]);
}`,
        'const ROUTES = { deploy: "Deploy the approved release.", hold: "Hold the release." };',
      ),
    ],
    [
      "inline runtime-owned choice indexes author-known routes",
      standardSource(
        `export default async function run({ agent }) {
  return agent(ROUTES[await agent("Choose a route.", { choice: ["deploy", "hold"] })]);
}`,
        'const ROUTES = { deploy: "Deploy the approved release.", hold: "Hold the release." };',
      ),
    ],
    [
      "nested literal can reuse the semantic input spelling without changing its provenance",
      standardSource(`export default async function run({ agent, log }, input) {
  if (true) {
    const input = "local";
    if (input === "local") log(input);
  }
  return agent(\`Handle this exact request: \${input}\`);
}`),
    ],
    [
      "case-local literal shadow does not mask the outer semantic input",
      standardSource(`export default function run({ agent, log }, input) {
  switch ("local") {
    case "local":
      const input = "local";
      if (input === "local") log(input);
      break;
    default:
      break;
  }
  return agent(input);
}`),
    ],
    [
      "default-local literal shadow does not mask the outer semantic input",
      standardSource(`export default function run({ agent, log }, input) {
  switch ("other") {
    case "local":
      break;
    default:
      const input = "local";
      log(input);
  }
  return agent(input);
}`),
    ],
    [
      "runtime-owned list identity and unchanged map items",
      standardSource(`export default async function run({ agent, parallel }) {
  const units = await agent("Return work units.", { handoffs: { maxItems: 8 } });
  if (units.length === 0) return [];
  return parallel(units.map((item) => () => agent(\`Handle this exact item: \${item}\`)));
}`),
    ],
    [
      "pipeline stages forward opaque values and use runtime indexes",
      standardSource(`export default async function run({ agent, pipeline }) {
  const plans = ["one", "two"];
  return pipeline(
    plans,
    (plan, planIndex) => agent(\`Draft \${planIndex}: \${plan}\`),
    (draft, reviewIndex) => agent(\`Review \${reviewIndex}: \${draft}\`),
  );
}`),
    ],
    [
      "known collection map classifies item index and whole array",
      standardSource(`export default async function run({ agent, parallel }) {
  const plans = ["one", "two"];
  return parallel(plans.map((plan, planIndex, allPlans) => () =>
    agent(\`Plan \${planIndex + 1} of \${allPlans.length}: \${plan}\`),
  ));
}`),
    ],
    [
      "runtime-owned saved-call status controls a branch",
      standardSource(`export default async function run({ agent, invokeWorkflow }) {
  const child = await invokeWorkflow({ name: "worker", key: "item-1", keys: ["item-1"] });
  if (child.status === "completed") return agent("Continue after the completed child.");
  return agent("Report the non-completed child status.");
}`),
    ],
    [
      "opaque for-of item forwarded unchanged",
      standardSource(`export default async function run({ agent, items }) {
  for (const item of items()) await agent(\`Handle this exact item: \${item}\`);
  return true;
}`),
    ],
    [
      "bound opaque for-of list stays structural while each item remains opaque",
      standardSource(`export default async function run({ agent, items }) {
  const workItems = items();
  for (const workItem of workItems) await agent(\`Handle this exact item: \${workItem}\`);
  return true;
}`),
    ],
    [
      "declared literal roots and object property names remain available",
      standardSource(
        `export default function run({ agent }) {
  const box = { route: "deploy" };
  if (box.route === ROUTES.deploy) return agent("Deploy");
  return agent("Hold");
}`,
        'const ROUTES = { deploy: "deploy" };',
      ),
    ],
    [
      "first run parameter supplies DSL trust",
      standardSource("export default function run({ log }, input) { log(input); }"),
    ],
    [
      "discarded acknowledgement prompt remains structural JavaScript",
      standardSource(
        'export default async function run({ agent }) { await agent("Reply exactly DONE"); return true; }',
      ),
    ],
  ])("accepts %s in the standard source grammar", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toEqual([]);
  });

  it.each([
    [
      "unlisted semantic method",
      standardSource("export default function run(dsl, input) { return input.toUpperCase(); }"),
    ],
    [
      "function-valued IIFE",
      standardSource('export default function run(dsl, input) { return (() => input.replaceAll("old", "new"))(); }'),
    ],
    [
      "global report renderer",
      standardSource("export default function run(dsl, input) { return JSON.stringify({ report: input }); }"),
    ],
    [
      "unknown global call",
      standardSource("export default function run(dsl, input) { return encodeURIComponent(input); }"),
    ],
    ["unbound DSL-shaped global", standardSource('export default function run() { return dsl.agent("x"); }')],
    [
      "manual parser/renderer loop",
      standardSource(`export default function run(dsl, input) {
  const characters = [];
  for (const character of input) characters.push(character);
  return characters.join("");
}`),
    ],
    [
      "bound agent alias",
      standardSource(
        'export default function run(dsl) { const callWorker = dsl.agent.bind(dsl); return callWorker("x"); }',
      ),
    ],
  ])("rejects reviewer false-green: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "run semantic input through arguments",
      standardSource(`export default function run({ agent }, input) {
  if (arguments[1] === "deploy") return agent("Deploy");
  return agent(input);
}`),
    ],
    [
      "map item through arguments",
      standardSource(`export default function run({ agent, items, parallel }) {
  return parallel(items().map(function () {
    return () => agent(arguments[0] === "deploy" ? "Deploy" : "Hold");
  }));
}`),
    ],
    [
      "map index through arguments",
      standardSource(`export default function run({ agent, items, parallel }) {
  return parallel(items().map(function () {
    return () => agent(arguments[1] > 0 ? "Later" : "First");
  }));
}`),
    ],
    [
      "map whole array through arguments",
      standardSource(`export default function run({ agent, items, parallel }) {
  return parallel(items().map(function () {
    return () => agent(arguments[2][0] === "deploy" ? "Deploy" : "Hold");
  }));
}`),
    ],
    [
      "pipeline value through arguments",
      standardSource(`export default function run({ agent, items, pipeline }) {
  return pipeline(items(), function () {
    return agent(arguments[0] === "deploy" ? "Deploy" : "Hold");
  });
}`),
    ],
  ])("rejects implicit arguments channel: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toContain(
      "standard profile does not use the implicit arguments object",
    );
  });

  it.each([
    [
      "opaque scalar",
      standardSource(`export default async function run({ agent }, input) {
  const answer = (0, await agent(input));
  if (answer === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "opaque value inside an array",
      standardSource(`export default async function run({ agent }, input) {
  const copied = [(0, await agent(input))];
  if (copied[0] === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "opaque value inside an object",
      standardSource(`export default async function run({ agent }, input) {
  const box = { value: (0, await agent(input)) };
  if (box.value === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "nested composite result",
      standardSource(`export default async function run({ agent }, input) {
  const copied = ((["known"]), [await agent(input)]);
  if (copied[0] === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "literal-only sequence",
      standardSource(`export default function run({ agent }) {
  const known = (1, 2);
  if (known === 2) return agent("Deploy");
  return agent("Hold");
}`),
    ],
  ])("rejects every sequence expression: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toContain("standard profile uses no sequence expressions");
  });

  it.each([
    [
      "process environment",
      standardSource(`export default function run({ agent }) {
  if (process.env.DEPLOY === "yes") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "globalThis computed process",
      standardSource(`export default function run({ agent }) {
  if (globalThis["process"]["env"]["DEPLOY"] === "yes") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "Buffer ambient value",
      standardSource(
        'export default function run({ agent }) { return agent(Buffer.byteLength("deploy") ? "Deploy" : "Hold"); }',
      ),
    ],
    [
      "arbitrary undeclared value",
      standardSource(
        'export default function run({ agent }) { return mystery === "deploy" ? agent("Deploy") : agent("Hold"); }',
      ),
    ],
    [
      "undeclared shorthand object value",
      standardSource("export default function run({ agent }) { const box = { mystery }; return agent(box); }"),
    ],
    [
      "implicit this value root",
      standardSource(
        'export default function run({ agent }) { return this?.deploy ? agent("Deploy") : agent("Hold"); }',
      ),
    ],
  ])("rejects undeclared ambient value root: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toContain(
      "standard profile reads values only from declared lexical bindings and approved language roots",
    );
  });

  it.each([
    [
      "mutable profile metadata",
      'export let meta = { name: "contract-test", profile: "standard", description: "Contract test." };\nexport default function run() {}',
    ],
    ["Node imports", standardSource("export default function run() {}", 'import fs from "node:fs";')],
    ["Node re-exports", standardSource("export default function run() {}", 'export { readFile } from "node:fs";')],
    ["dynamic imports", standardSource('export default function run() { return import("node:fs"); }')],
    ["semantic split", standardSource('export default function run(dsl, input) { return input.split("\\n"); }')],
    ["semantic trim", standardSource("export default function run(dsl, input) { return input.trim(); }")],
    [
      "aliased transform",
      standardSource("export default function run(dsl, input) { const clean = input.trim; return clean(); }"),
    ],
    ["computed transform", standardSource('export default function run(dsl, input) { return input["trim"](); }')],
    ["domain schemas", standardSource('export default function run(dsl) { return dsl.agent("x", { schema: {} }); }')],
    [
      "nested wrappers",
      standardSource(
        'export default function run(dsl) { function callWorker() { return dsl.agent("x"); } return callWorker(); }',
      ),
    ],
    [
      "variable wrappers",
      standardSource(
        'export default function run(dsl) { const callWorker = () => dsl.agent("x"); return callWorker(); }',
      ),
    ],
    [
      "object wrappers",
      standardSource(
        'export default function run(dsl) { const workers = { call: () => dsl.agent("x") }; return workers.call(); }',
      ),
    ],
    [
      "class wrappers",
      standardSource(
        'export default function run(dsl) { class Worker { call() { return dsl.agent("x"); } } return new Worker().call(); }',
      ),
    ],
    [
      "aliased agent calls",
      standardSource('export default function run(dsl) { const callWorker = dsl.agent; return callWorker("x"); }'),
    ],
    ["computed agent calls", standardSource('export default function run(dsl) { return dsl["agent"]("x"); }')],
    [
      "custom recovery",
      standardSource(
        'export default async function run(dsl) { try { return await dsl.agent("x"); } catch { return "fallback"; } }',
      ),
    ],
  ])("rejects %s from the standard source grammar", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });
});
