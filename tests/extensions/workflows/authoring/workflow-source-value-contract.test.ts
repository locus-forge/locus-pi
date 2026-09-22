/**
 * Provenance and permitted use: where each value came from, and where a model
 * answer, runtime list or host path may then go. The classification belongs to
 * `source/workflow-source-provenance.ts` and the rules to
 * `source/workflow-source-value-rules.ts`.
 */
import path from "node:path";
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

function dslReturnSource(call: string, body: string): string {
  return standardSource(`export default async function run(dsl) {
  const value = await ${call};
  ${body}
}`);
}

describe("standard workflow source provenance and value uses", () => {
  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category !== "void"))(
    "allows $method as one bound whole return",
    ({ call }) => {
      expect(standardWorkflowSourceShapeErrors(dslReturnSource(call, "return value;"))).toEqual([]);
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category !== "void"))(
    "rejects semantic branching on $method",
    ({ call }) => {
      expect(
        standardWorkflowSourceShapeErrors(
          dslReturnSource(call, 'if (value) return dsl.agent("yes"); return dsl.agent("no");'),
        ),
      ).not.toEqual([]);
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category !== "void"))(
    "rejects undocumented member inspection on $method",
    ({ call }) => {
      expect(standardWorkflowSourceShapeErrors(dslReturnSource(call, "return value.detail;"))).not.toEqual([]);
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category !== "void"))(
    "rejects $method inside nested Error arguments",
    ({ call }) => {
      expect(
        standardWorkflowSourceShapeErrors(dslReturnSource(call, 'throw new Error("stop", { cause: [value] });')),
      ).toContain("standard profile constructs Error only from author-known or literal values");
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category === "void"))(
    "allows discarded $method",
    ({ call }) => {
      expect(
        standardWorkflowSourceShapeErrors(
          standardSource(`export default async function run(dsl) {
  await ${call};
  return true;
}`),
        ),
      ).toEqual([]);
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category === "void"))(
    "rejects $method used as a value",
    ({ call }) => {
      expect(standardWorkflowSourceShapeErrors(dslReturnSource(call, "return value;"))).toContain(
        "standard profile does not use void DSL calls as values",
      );
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category === "list"))(
    "allows documented list-length control from $method",
    ({ call }) => {
      expect(
        standardWorkflowSourceShapeErrors(
          dslReturnSource(call, 'if (value.length === 0) dsl.log("empty"); return value;'),
        ),
      ).toEqual([]);
    },
  );

  it("allows exact choice identity and saved-child status controls", () => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  const route = await dsl.agent("route", { choice: ["yes", "no"] });
  if (route === "yes") dsl.log(route);
  const child = await dsl.invokeWorkflow({
    name: "child",
    key: "one",
    keys: ["one"],
    outputDir: dsl.outputDir(),
  });
  if (child.status === "completed") return route;
  return child.status;
}`),
      ),
    ).toEqual([]);
  });

  it("allows a bound outputDir only in the matching saved-child field", () => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  const stableOutputDir = dsl.outputDir();
  return dsl.invokeWorkflow({
    name: "child",
    key: "one",
    keys: ["one"],
    outputDir: stableOutputDir,
  });
}`),
      ),
    ).toEqual([]);
  });

  it.each([
    ["publishArtifact", 'dsl.publishArtifact("intent.md", "intent")'],
    ["publishPrimaryArtifact", 'dsl.publishPrimaryArtifact("intent.md", "intent")'],
    ["publishPrimaryFile", 'dsl.publishPrimaryFile("intent.md")'],
  ])("allows an unchanged %s ref in the exact operator handoff continuation array", (_method, call) => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  const artifactRef = ${call};
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: "Review",
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [artifactRef],
    },
  });
  return true;
}`),
      ),
    ).toEqual([]);
  });

  it("allows one published artifact ref as verified question detail and continuation input", () => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  const blockerRef = dsl.publishArtifact("planning-blocker.md", "# Question\\nChoose a policy.");
  dsl.awaitOperator({
    reason: "planning blocked",
    operatorHandoff: {
      title: "Planning blocker",
      questions: [{
        kind: "select",
        id: "decision",
        prompt: "How should planning proceed?",
        detailArtifactRef: blockerRef,
        options: [{ label: "Use an assumption" }],
        allowCustom: true,
      }],
      continuationArtifactRefs: [blockerRef],
    },
  });
  return true;
}`),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "unrelated runtime value",
      `const artifactRef = dsl.outputDir();
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: "Review",
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [artifactRef],
    },
  });`,
    ],
    [
      "unrelated operator handoff field",
      `const artifactRef = dsl.publishArtifact("intent.md", "intent");
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: artifactRef,
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [],
    },
  });`,
    ],
    [
      "nested continuation element",
      `const artifactRef = dsl.publishArtifact("intent.md", "intent");
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: "Review",
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [[artifactRef]],
    },
  });`,
    ],
    [
      "derived continuation element",
      `const artifactRef = dsl.publishArtifact("intent.md", "intent");
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: "Review",
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [\`\${artifactRef}\`],
    },
  });`,
    ],
  ])("rejects an invalid operator handoff artifact use: %s", (_label, body) => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  ${body}
  return true;
}`),
      ),
    ).toContain(
      "standard profile forwards opaque semantic, model, file, host, and runtime values only as whole values",
    );
  });

  it.each([
    [
      "plain agent text comparison",
      standardSource(`export default async function run({ agent }) {
  const answer = await agent("Return prose");
  if (answer === "approved") return agent("Take approved path");
}`),
    ],
    [
      "plain agent text length inspection",
      standardSource(`export default async function run({ agent, log }) {
  const answer = await agent("Return prose");
  if (answer.length > 80) log("long");
}`),
    ],
    [
      "semantic input branch",
      standardSource(
        'export default function run({ agent }, input) { return input === "deploy" ? agent("Deploy") : agent("Do not deploy"); }',
      ),
    ],
    [
      "opaque item renaming",
      standardSource("export default function run({ items }) { return items().map((item) => `task-${item}`); }"),
    ],
    [
      "plain agent text report rendering",
      standardSource(`export default async function run({ agent }) {
  const answer = await agent("Return findings");
  return { report: \`# Findings\\n\\n\${answer}\` };
}`),
    ],
    [
      "opaque for-of item destructuring",
      standardSource(`export default async function run({ agent, items }) {
  for (const { task } of items()) await agent(task);
  return true;
}`),
    ],
  ])("rejects opaque-value architecture violation: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "semantic input as author-known route subscript",
      standardSource(
        "export default function run({ agent }, input) { return agent(ROUTES[input]); }",
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "plain agent answer as author-known route subscript",
      standardSource(
        `export default async function run({ agent }) {
  const answer = await agent("Return prose.");
  return agent(NEXT[answer]);
}`,
        'const NEXT = { done: "Finish", revise: "Revise" };',
      ),
    ],
    [
      "semantic input as array index",
      standardSource(
        "export default function run({ agent }, input) { return agent(ROUTES[input]); }",
        'const ROUTES = ["Deploy", "Hold"];',
      ),
    ],
    [
      "semantic input hidden inside a nested template subscript",
      standardSource(
        "export default function run({ agent }, input) { return agent(`Please ${TONE[input]}.`); }",
        'const TONE = { calm: "stay calm" };',
      ),
    ],
  ])("rejects opaque sink intermediary: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "direct plain-agent result as route index",
      standardSource(
        "export default async function run({ agent }, input) { return agent(ROUTES[await agent(input)]); }",
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "direct caller item as route index",
      standardSource(
        "export default function run({ agent, items }) { return agent(ROUTES[items()[0]]); }",
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "direct consumed artifact as route index",
      standardSource(
        'export default function run({ agent, consumeTextArtifact }) { return agent(ROUTES[consumeTextArtifact("x")]); }',
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "direct opaque producer nested in template route",
      standardSource(
        "export default async function run({ agent }, input) { return agent(`Next: ${ROUTES[await agent(input)]}`); }",
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "direct opaque producer nested in concatenated route index",
      standardSource(
        'export default async function run({ agent }, input) { return agent(ROUTES["route-" + await agent(input)]); }',
        'const ROUTES = { "route-deploy": "Deploy", "route-hold": "Hold" };',
      ),
    ],
  ])("rejects opaque provenance anywhere in a subscript index: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "pipeline first-stage opaque branch",
      standardSource(`export default function run({ agent, items, pipeline }) {
  return pipeline(items(), (item) => agent(item === "deploy" ? "Deploy" : "Hold"));
}`),
    ],
    [
      "pipeline later-stage plain-text measurement",
      standardSource(`export default function run({ agent, pipeline }) {
  const plans = ["one"];
  return pipeline(
    plans,
    (plan) => agent(plan),
    (draft) => agent(draft.length > 100 ? "Shorten" : "Expand"),
  );
}`),
    ],
    [
      "opaque map whole-array parameter branch",
      standardSource(`export default function run({ agent, items, parallel }) {
  const list = items();
  return parallel(list.map((item, itemIndex, allItems) => () =>
    agent(allItems[0] === "deploy" ? item : \`Hold \${itemIndex}\`),
  ));
}`),
    ],
    [
      "opaque identity map laundering",
      standardSource(`export default function run({ agent, items }) {
  const clean = items().map((item) => { return item; });
  for (const candidate of clean) {
    if (candidate === "deploy") return agent("Deploy");
  }
  return agent("Hold");
}`),
    ],
    [
      "unclassified callback parameter",
      standardSource(`export default function run({ agent, parallel }) {
  return parallel([(hidden) => agent(hidden)]);
}`),
    ],
  ])("rejects unclassified or transformed callback values: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "direct opaque scalar",
      standardSource(`export default async function run({ agent }, input) {
  return new Error(await agent(input));
}`),
    ],
    [
      "Error message inspection",
      standardSource(`export default async function run({ agent }, input) {
  const answer = new Error(await agent(input));
  if (answer.message === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "opaque array spread",
      standardSource(`export default function run({ items }) {
  throw new Error("stop", { cause: [...items()] });
}`),
    ],
    [
      "nested cause and options",
      standardSource(`export default async function run({ agent }, input) {
  throw new Error("stop", { cause: { details: [await agent(input)] } });
}`),
    ],
    [
      "member extraction from opaque text",
      standardSource(`export default async function run({ agent }, input) {
  const answer = await agent(input);
  throw new Error(answer.message);
}`),
    ],
  ])("rejects runtime provenance inside Error arguments: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toContain(
      "standard profile constructs Error only from author-known or literal values",
    );
  });

  it.each([
    [
      "opaque list spread into a new array",
      standardSource(`export default function run({ agent, items }) {
  const copied = [...items()];
  for (const candidate of copied) if (candidate === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "direct plain-agent result in an array",
      standardSource(`export default async function run({ agent }, input) {
  const copied = [await agent(input)];
  if (copied[0] === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "direct plain-agent result in an object",
      standardSource(`export default async function run({ agent }, input) {
  const box = { value: await agent(input) };
  if (box.value === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "direct runtime choice laundered through an object",
      standardSource(`export default async function run({ agent }) {
  const box = { route: await agent("Route?", { choice: ["deploy", "hold"] }) };
  if (box.route === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "opaque producer nested through objects arrays and spread",
      standardSource(`export default async function run({ agent }, input) {
  const nested = { rows: [...[{ value: await agent(input) }]] };
  if (nested.rows[0].value === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
  ])("rejects composite provenance laundering: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "case literal shadow followed by outer opaque branch",
      standardSource(`export default function run({ agent, log }, input) {
  switch ("local") {
    case "local":
      const input = "local";
      if (input === "local") log(input);
      break;
    default:
      break;
  }
  if (input === "deploy") return agent("Deploy");
  return input;
}`),
    ],
    [
      "default literal shadow followed by outer opaque rendering",
      standardSource(`export default function run({ log }, input) {
  switch ("other") {
    case "local":
      break;
    default:
      const input = "local";
      log(input);
  }
  return \`semantic:\${input}\`;
}`),
    ],
  ])("rejects outer opaque use after switch-local literal: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "inner choice reuses semantic input",
      standardSource(`export default async function run({ agent }, input) {
  if (true) {
    const input = await agent("Choose.", { choice: ["deploy", "hold"] });
    await agent(ROUTES[input]);
  }
  if (input === "deploy") return agent("Deploy");
}`),
    ],
    [
      "loop counter reuses semantic input",
      standardSource(`export default function run({ agent }, input) {
  for (let input = 0; input < 1; input += 1) agent("Tick");
  if (input === "deploy") return agent("Deploy");
}`),
    ],
    [
      "handoff list reuses semantic input",
      standardSource(`export default async function run({ agent }, input) {
  if (true) {
    const input = await agent("Return units.", { handoffs: { maxItems: 2 } });
    await agent(\`Units: \${input.join("\\n")}\`);
  }
  if (input.length > 0) return agent("Deploy");
}`),
    ],
    [
      "saved-call status reuses semantic input",
      standardSource(`export default async function run({ agent, invokeWorkflow }, input) {
  if (true) {
    const input = await invokeWorkflow({ name: "worker", key: "one", keys: ["one"] });
    if (input.status === "completed") await agent("Done");
  }
  if (input.status === "completed") return agent("Deploy");
}`),
    ],
    [
      "map index reuses semantic input",
      standardSource(`export default function run({ agent }, input) {
  ["one"].map((item, input) => agent(\`\${input}: \${item}\`));
  if (input === "deploy") return agent("Deploy");
}`),
    ],
  ])("rejects duplicate value-bearing scope collision: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });
});
