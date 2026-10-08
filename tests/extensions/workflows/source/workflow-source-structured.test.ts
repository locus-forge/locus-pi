import { dataflowWorkflowSourceDiagnostics } from "../../../../extensions/workflows/source/profiles/workflow-source-dataflow.js";
import { describe, expect, it } from "vitest";
import { Lang, parse } from "@ast-grep/napi";
import {
  standardStructuredDeclarations,
  workflowInputBindings,
} from "../../../../extensions/workflows/source/workflow-source-structured.js";
import {
  orchestrationOnlyWorkflowSourceShapeDiagnostics,
  standardWorkflowSourceShapeDiagnostics,
} from "../../../../extensions/workflows/tool/workflow-source-shape.js";
import { assessWorkflowStructuredReplayCoverage } from "../../../../extensions/workflows/runtime/workflow-script-identity.js";

const schema = `{ type: "object", properties: {
  verdict: { type: "string", enum: ["accept", "revise"] },
  text: { type: "string" }, optional: { type: "string" },
  findings: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
}, required: ["verdict", "text", "findings"], additionalProperties: false }`;
const wrap = (body: string, declarations = "") => `export const meta = { name: "structured", profile: "standard" };
${declarations}
export default async function run({ agent, log, parallel, publishArtifact }) { ${body} }`;
const result = `const review = await agent("Review", { label: "review", schema: ${schema} });`;
const messages = (source: string, strict = true) =>
  (strict ? orchestrationOnlyWorkflowSourceShapeDiagnostics(source) : standardWorkflowSourceShapeDiagnostics(source))
    .filter((item) => item.severity === "error")
    .map((item) => item.message);

describe.each([true, false])("bounded structured source, orchestration-only=%s", (strict) => {
  it.each([
    "return review;",
    "return review.text;",
    "const alias = review; const text = alias.text; log(text); return alias;",
    'const verdict = review.verdict; if (verdict === "accept") log("accepted"); return verdict;',
    'if (review.verdict !== "revise") log("accepted"); return review;',
    'switch (review.verdict === "accept") { case true: return review; default: return review; }',
    'return agent(`Review: ${review.text}`, { label: "followup" });',
    'publishArtifact("review.txt", review.text); return review;',
    "for (const finding of review.findings) log(finding.text); return review;",
    "const findings = review.findings; return findings.map(finding => finding.text);",
    "return review.findings.map((finding, index, all) => { if (all.length > 0) log(finding.text); return index; });",
    'return parallel(review.findings.map(finding => () => agent(finding.text, { label: "finding" })));',
    "const wrapper = { review }; return wrapper;",
  ])("accepts proven fields and unchanged values: %s", (body) => {
    expect(messages(wrap(result + body), strict)).toEqual([]);
  });

  it.each([
    "return review.optional;",
    "return review.unknown;",
    "return review.findings[0].text;",
    "const index = 0; return review.findings[index];",
    'return review["text"];',
    'if (review.text === "accept") return review;',
    "if (review.verdict) return review;",
    'if (review.verdict === "invented") return review;',
    "return review.text.length;",
    "return review.text.trim();",
    'return review.text + "!";',
    "return { text: review.text.toUpperCase() };",
    'return agent(review, { label: "wrong-prompt" });',
    'return agent(`${review}`, { label: "wrong-template" });',
    'review.text = "fabricated"; return review;',
    "delete review.text; return review;",
    'const alias = review; alias.text = "fabricated"; return alias;',
    'review.findings.push({text:"fabricated"}); return review;',
    "const { text } = review; return text;",
    "const wrapper = { review }; return wrapper.review.text;",
    "const values = [review]; return values[0].text;",
    "const changed = review.findings.map(finding => finding); return changed[0].text;",
    "for (const index in review.findings) log(index); return review;",
    "const method = review.findings.map; return method;",
    "return review.constructor;",
    "return review.__proto__;",
    "return review.findings.map((finding, index, all) => { all[0] = finding; return finding; });",
    "return review.findings.map(finding => { const review = finding; return review.text; });",
  ])("rejects unproven access, mutation and laundering: %s", (body) => {
    expect(messages(wrap(result + body), strict).length).toBeGreaterThan(0);
  });

  it.each([
    'const pending = agent("Review", { label: "review", schema: {type:"string"} }); return pending.length;',
    'const pending = agent("Review", { label: "review", schema: {type:"object"} }); return pending.text;',
    'const pending = agent("Review", { label: "review", schema: {type:"array"} }); return pending.map(item=>item);',
    'const pending = agent("Review", { label: "review", schema: {type:"string"} }); return { pending };',
    'const pending = agent("Review", { label: "review", schema: {type:"string"} }); return agent(pending, { label:"next" });',
  ])("keeps Promises distinct from JSON: %s", (body) => {
    expect(messages(wrap(body), strict).join(" ")).toContain("awaits a structured agent result");
  });

  it("resolves a pending alias only at await and permits whole promise return", () => {
    expect(
      messages(
        wrap(
          'const pending = agent("x", {label:"x",schema:{type:"string"}}); const text = await pending; return text;',
        ),
        strict,
      ),
    ).toEqual([]);
    expect(messages(wrap('return agent("x", {label:"x",schema:{type:"string"}});'), strict)).toEqual([]);
    expect(
      messages(
        wrap(
          'return (await agent("x", {label:"x",schema:{type:"object",properties:{text:{type:"string"}},required:["text"]}})).text;',
        ),
        strict,
      ),
    ).toEqual([]);
  });

  it("preserves optional/open-object and untyped-array dialect without inventing field proof", () => {
    for (const declaration of [
      '{type:"object"}',
      '{type:"object",additionalProperties:true}',
      '{type:"array"}',
      '{type:"null"}',
      '{type:"number"}',
    ])
      expect(messages(wrap(`return agent("x", {label:"x",schema:${declaration}});`), strict)).toEqual([]);
    expect(
      messages(
        wrap('const rows = await agent("x",{label:"x",schema:{type:"array"}}); return rows.map(row=>row.text);'),
        strict,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("reads one unshadowed literal const and decodes escaped/numeric property keys", () => {
    expect(
      messages(
        wrap(
          'const review = await agent("x", {label:"x",schema: REVIEW}); return review.text;',
          `const REVIEW=${schema};`,
        ),
        strict,
      ),
    ).toEqual([]);
    const escaped =
      '{ t\\u0079pe: "object", properties: { "t\\u0065xt": {type:"string"}, 1e1: {type:"string"} }, required:["text","10"] }';
    expect(
      messages(
        wrap(`const review = await agent("x", {label:"x", "sch\\u0065ma": (${escaped})}); return review.text;`),
        strict,
      ),
    ).toEqual([]);
    expect(
      messages(
        wrap(
          'const record = await agent("x",{label:"x",schema:{type:"object",properties:{schema:{type:"string"},validate:{type:"string"}},required:["schema","validate"]}});return record.schema;',
        ),
        strict,
      ),
    ).toEqual([]);
  });

  it.each(["outputDir", "workspaceDir", "workflowSource", "schema", "validate"])(
    "keeps %s property names inside validated schema data",
    (key) => {
      const declaration = `{type:"object",properties:{
        ${key}:{type:"string"},
        rows:{type:"array",items:{type:"object",properties:{${key}:{type:"string"}},required:["${key}"]}}
      },required:["${key}","rows"],additionalProperties:false}`;
      for (const named of [false, true]) {
        const source = wrap(
          `const record=await agent("x",{label:"x",schema:${named ? "SCHEMA" : declaration}});
          log(record.${key}); return record.rows.map(row=>row.${key});`,
          named ? `const SCHEMA=${declaration};` : "",
        );
        expect(messages(source, strict)).toEqual([]);
      }
    },
  );

  it("accepts a closed object with a required outputDir field inline or by const", () => {
    const declaration =
      '{type:"object",properties:{outputDir:{type:"string"}},required:["outputDir"],additionalProperties:false}';
    for (const named of [false, true])
      expect(
        messages(
          wrap(
            `return agent("x",{label:"x",schema:${named ? "SCHEMA" : declaration}});`,
            named ? `const SCHEMA=${declaration};` : "",
          ),
          strict,
        ),
      ).toEqual([]);
  });

  it.each(['{type:"object",properties:{outputDir:{type:"bogus"}}}', '{type:"object",outputDir:{type:"string"}}'])(
    "does not exempt invalid schema data from removed-option policy: %s",
    (declaration) => {
      const source = wrap(`return agent("x",{label:"x",schema:${declaration}});`);
      expect(messages(source, strict)).toContain(
        "outputDir was removed: assign exact file destinations in agent prompts",
      );
    },
  );

  it("does not exempt an undecoded dynamic schema", () => {
    const source = wrap(
      'return agent("x",{label:"x",schema:{type:"object",properties:{outputDir:{type:TYPE}}}});',
      'const TYPE="string";',
    );
    expect(messages(source, strict)).toContain(
      "agent schema requires literal JSON data; dynamic expressions are runtime-only",
    );
    expect(messages(source, strict)).toContain(
      "outputDir was removed: assign exact file destinations in agent prompts",
    );
  });

  it.each([
    [
      'return agent("x",{label:"x",schema:SCHEMA,outputDir:"out"});',
      "agent",
      "outputDir was removed: assign exact file destinations in agent prompts",
    ],
    [
      'return invokeWorkflow({workspaceDir:"out"});',
      "agent,invokeWorkflow",
      "invokeWorkflow accepts no workspaceDir field; saved children inherit root locations",
    ],
    [
      'return invokeWorkflow({outputDir:"out"});',
      "agent,invokeWorkflow",
      "invokeWorkflow accepts no outputDir field; saved children inherit root locations",
    ],
    [
      'return publishPrimaryArtifact({workflowSource:"source"});',
      "agent,publishPrimaryArtifact",
      "publishPrimaryArtifact's workflowSource overload was removed; agents write and consumers check the same explicit file",
    ],
  ])("retains removed call option policy beside valid schema data: %s", (body, bindings, diagnostic) => {
    const source = `export const meta={name:"options",profile:"standard"};
      const SCHEMA={type:"object",properties:{outputDir:{type:"string"}}};
      export default async function run({${bindings}}) {
        await agent("schema",{label:"schema",schema:SCHEMA}); ${body}
      }`;
    expect(messages(source, strict)).toContain(diagnostic);
  });

  it("retains removed meta option policy beside valid schema data", () => {
    const source = wrap(
      'return agent("x",{label:"x",schema:{type:"object",properties:{outputDir:{type:"string"}}}});',
    ).replace('profile: "standard"', 'profile: "standard", outputDir: "out"');
    expect(messages(source, strict)).toContain(
      "outputDir was removed: assign exact file destinations in agent prompts",
    );
  });

  it.each([
    ['{label:"x",schema:{type:"object",properties:{__proto__:{type:"string"}}}}', ""],
    ['{label:"x",schema:{type:"object",properties:{"__pro\\u0074o__":{type:"string"}}}}', ""],
    ['{label:"x",schema:{type:"string",enum:[,"yes"]}}', ""],
    ['{label:"x",schema:{type:"string",enum:["yes",,"no"]}}', ""],
    ['{label:"x",schema:{type:"string",type:"number"}}', ""],
    ['{label:"x",schema:{type:"string"},schema:{type:"number"}}', ""],
    ['{label:"x",schema:{type:"string"},...OTHER}', "const OTHER={};"],
    ['{label:"x",schema:OTHER}', 'const OTHER={...{type:"string"}};'],
    ['{label:"x",schema}', 'const schema={type:"string"};'],
    ['{label:"x",schema:ALIAS}', 'const ORIGINAL={type:"string"}; const ALIAS=ORIGINAL;'],
    ['{label:"x",schema:{type:"number",minimum:1e400}}', ""],
    ['{label:"x",schema:{type:"string",pattern:"x"}}', ""],
    ['{label:"x",schema:{type:"array",items:{type:"bogus"}}}', ""],
    ['{label:"x",schema:{type:"string"},choice:["yes","no"]}', ""],
    ['{label:"x",schema:{type:"string"},choiceFallback:"yes"}', ""],
    ['{label:"x",schema:{type:"string"},result:"report"}', ""],
    ['{label:"x",schema:{type:"string"},repair:{maxAttempts:2}}', ""],
    ['{label:"x",schema:{type:"string"},validate:value=>[]}', ""],
    ['{label:"x",schema:{type:"string"},outputTransport:"native"}', ""],
  ])("rejects unsupported declaration %s", (options, declarations) => {
    expect(messages(wrap(`return agent("x",${options});`, declarations), strict).length).toBeGreaterThan(0);
  });

  it("refuses shadowed/mutable schemas and unchanged plain text stays opaque", () => {
    expect(
      messages(
        wrap(
          'if(true){const REVIEW={type:"string"};return agent("x",{label:"x",schema:REVIEW});}',
          `const REVIEW=${schema};`,
        ),
        strict,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      messages(
        wrap('REVIEW.type="string";return agent("x",{label:"x",schema:REVIEW});', `const REVIEW=${schema};`),
        strict,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      messages(wrap('const text=await agent("x",{label:"x"}); return text.verdict;'), strict).length,
    ).toBeGreaterThan(0);
  });
});

describe("structured source replay coverage follows supported syntax", () => {
  it.each([
    'export default async function run({agent}) {const rows=await agent("x",{label:"x",schema:{type:"array",items:{type:"string"}}});return rows.map(row=>row);}',
    'export default async ({agent})=>agent("x",{label:"x",schema:{type:"null"}});',
    'export default async function run(dsl){const {agent}=dsl;return agent("x",{label:"x",schema:{type:"null"}});}',
  ])("covers standard entry/DSL bindings without ambient dependency claims: %s", (entry) => {
    const source = 'export const meta={name:"replay",profile:"standard"};' + entry;
    expect(messages(source)).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(true);
  });
  it("covers nested declared JSON array mapping and leaves an unknown method uncovered", () => {
    expect(
      assessWorkflowStructuredReplayCoverage(wrap(result + "return review.findings.map(finding=>finding.text);")),
    ).toBe(true);
    expect(assessWorkflowStructuredReplayCoverage(wrap(result + "return review.findings.externalMethod();"))).toBe(
      false,
    );
  });
});

describe("static schema literal parity without source evaluation", () => {
  it.each([
    ['{type:"number",minimum: - /* bound */ 0xF,maximum: +0x10}', { type: "number", minimum: -15, maximum: 16 }],
    ['{type:"number",minimum:1_000,maximum:1e4}', { type: "number", minimum: 1000, maximum: 10000 }],
    ['{type:"string",enum:["a\\\rb"]}', { type: "string", enum: ["ab"] }],
    ['{type:"string",enum:[`a\r\nb`]}', { type: "string", enum: ["a\nb"] }],
    [
      '{type:"object",properties:{1e1:{type:"string"}},required:["10"]}',
      { type: "object", properties: { "10": { type: "string" } }, required: ["10"] },
    ],
  ])("decodes %s to the same literal schema value", (literal, expected) => {
    const root = parse(Lang.JavaScript, wrap(`return agent("x",{label:"x",schema:${literal}});`)).root();
    const entry = root.findAll({ rule: { kind: "function_declaration" } })[0];
    const errors: string[] = [];
    const declarations = standardStructuredDeclarations(root, entry, {
      add(message) {
        errors.push(message);
      },
    });
    expect(errors).toEqual([]);
    expect([...declarations.calls.values()]).toEqual([expected]);
    for (const strict of [true, false])
      expect(
        messages(wrap('return agent("x",{label:"x",schema:SCHEMA});', `const SCHEMA = (${literal});`), strict),
      ).toEqual([]);
  });
});

it.each([
  String.raw`export default async function run({agent,log}) { const decision=await agent("x",{label:"x",schema:{type:"string",enum:["accept","reject"]}}); if(true){ const dec\u0069sion=await agent("y",{label:"y"}); if(decision==="accept") log("accepted"); return decision; } }`,
  String.raw`const S={type:"object",properties:{text:{type:"string"}},required:["text"]}; export default async function run({agent,log}){const \u0053={type:"number"};const review=await agent("x",{label:"x",schema:S});log(review.text);return review;}`,
  String.raw`export default async function run({agent,log}) { const review=await agent("x",{label:"x",schema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}); if(true){ const rev\u0069ew=1; log(review.text); } return review; }`,
  String.raw`export default async function run({a\u0067ent}) { return agent("x",{label:"x",schema:{type:"string"}}); }`,
])("rejects escaped lexical identity without rejecting escaped literal data: %s", (body) => {
  const source = 'export const meta={name:"escape",profile:"standard"};' + body;
  for (const strict of [true, false])
    expect(messages(source, strict)).toContain("standard profile spells lexical identifiers without Unicode escapes");
  expect(assessWorkflowStructuredReplayCoverage(source)).toBe(false);
});

it.each([
  'const {items:SCHEMA}={type:"array",items:{type:"string"}};',
  'const {type:SCHEMA}={type:"string"};',
  'const {items:SCHEMA={type:"string"}}={type:"array",items:{type:"string"}};',
  'const [SCHEMA]=[{type:"array",items:{type:"string"}}];',
])("does not mistake a destructuring initializer for its schema binding: %s", (declaration) => {
  const source = wrap(
    'const result=await agent("x",{label:"x",schema:SCHEMA});if(result.length>0)log("route");return result;',
    declaration,
  );
  for (const strict of [true, false])
    expect(messages(source, strict)).toContain(
      "agent schema must be literal data or one unshadowed top-level literal const",
    );
});

const nestedArrays = '{type:"array",items:{type:"array",items:{type:"string"}}}';
const rowsSource = (body: string, schema = nestedArrays) =>
  wrap(`const rows=await agent("rows",{label:"rows",schema:${schema}});${body}`);

describe("composed proven arrays keep source and replay facts aligned", () => {
  it.each([
    "return rows.map(row=>row.map(value=>value));",
    "for(const row of rows) row.map(value=>value); return rows;",
    "const alias=rows; for(const row of alias){const inner=row;inner.map(value=>value);} return rows;",
    "return rows.map((row,index,all)=>all.map(other=>other.map(value=>value)));",
  ])("preserves declared item schemas: %s", (body) => {
    const source = rowsSource(body);
    for (const strict of [true, false]) expect(messages(source, strict)).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(true);
  });
  it("converges loop and mapper facts even without any variable declaration", () => {
    const source = wrap(
      `for(const row of await agent("rows",{label:"rows",schema:${nestedArrays}})) row.map(value=>value); return true;`,
    );
    expect(messages(source)).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(true);
  });
  it("preserves required nested array fields through mapper parameters", () => {
    const source = rowsSource(
      "return rows.map(row=>row.items.map(value=>value));",
      '{type:"array",items:{type:"object",properties:{items:{type:"array",items:{type:"string"}}},required:["items"]}}',
    );
    expect(messages(source)).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(true);
  });
  it("converges interleaved mapper and loop item bindings", () => {
    const source = rowsSource(
      "for(const row of rows){row.map(part=>{for(const value of part) log(value); return part;});} return rows;",
      '{type:"array",items:{type:"array",items:{type:"array",items:{type:"string"}}}}',
    );
    expect(messages(source)).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(true);
  });
  it.each([
    ["return rows.map(row=>row.map(value=>value));", '{type:"array"}'],
    ["for(const row of rows) row.map(value=>value); return rows;", '{type:"array"}'],
    ["return rows.map(row=>row.external(value=>value));", nestedArrays],
    ["const alias=rows;alias=[];return alias.map(row=>row.map(value=>value));", nestedArrays],
    ["return rows.map(row=>{const alias=row;alias=[];return alias.map(value=>value);});", nestedArrays],
  ])("keeps unknown items, unowned methods and mutable aliases unproven: %s", (body, schema) => {
    const source = rowsSource(body, schema);
    expect(messages(source).length).toBeGreaterThan(0);
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(false);
  });
  it("does not borrow a mapper parameter's shape across a literal shadow", () => {
    const source = rowsSource(
      'return rows.map(row=>{if(true){const row="plain";return row.map(value=>value);}return row;});',
    );
    expect(messages(source).length).toBeGreaterThan(0);
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(false);
  });
});

// Sharing lexical decoding must preserve the existing profile's literal capability and diagnostics.
it.each([false, true])("preserves inherited schema literal boundaries in strict=%s", (strict) => {
  const keys =
    '{type:"object",properties:{constructor:{type:"string"},prototype:{type:"string"}},required:["constructor","prototype"]}';
  expect(messages(wrap(`return agent("x",{label:"x",schema:${keys}});`), strict)).toEqual([]);
  for (const [literal, diagnostic] of [
    ['{type:"number",minimum:1e999}', "requires literal finite JSON numbers"],
    ['{type:"number",minimum:!1}', "requires literal finite JSON numbers"],
    ['{type:"string",enum:[,"a"]}', "requires dense literal arrays"],
    [
      '{type:"string",type:"number"}',
      "requires distinct literal data properties; no __proto__, spreads, methods or computed keys",
    ],
    [
      '{type:"object",properties:{["x"]:{type:"string"}}}',
      "requires distinct literal data properties; no __proto__, spreads, methods or computed keys",
    ],
  ])
    expect(messages(wrap(`return agent("x",{label:"x",schema:${literal}});`), strict)).toContain(
      `agent schema ${diagnostic}`,
    );
});

describe("schema-proven root and inline inputs", () => {
  it.each(["standard", "orchestration-only", "dataflow-v1"])("retains required JSON fields under %s", (profile) => {
    const source = `const schema = {type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false};
export const meta = {profile:${JSON.stringify(profile === "orchestration-only" ? "standard" : profile)},inputSchema:schema};
export default async function run(dsl,input) { return input.text; }`;
    expect(
      profile === "dataflow-v1"
        ? dataflowWorkflowSourceDiagnostics(source)
            .filter((item) => item.severity === "error")
            .map((item) => item.message)
        : messages(source, profile === "orchestration-only"),
    ).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(true);
  });
  it("admits the existing inline typed descriptor and its schema-proven field", () => {
    const source = `export const meta = {profile:"standard"};
export default async function run(dsl) { return dsl.workflow(async ({},value) => value.text,
{inputValue:{text:"hello"},inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}); }`;
    expect(messages(source)).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(true);
  });
});

describe("inline input schema ownership", () => {
  it.each(["const local={workflow:()=>null}; return local.workflow", "const workflow=()=>null; return workflow"])(
    "does not seed schemas for local names: %s",
    (prefix) => {
      const source = `export default function run(dsl){${prefix}((inner,values)=>values.map(value=>value),{inputValue:[1],inputSchema:{type:"array",items:{type:"number"}}});}`;
      const root = parse(Lang.JavaScript, source).root();
      const entry = root.findAll({ rule: { kind: "function_declaration" } })[0];
      expect(workflowInputBindings(root, entry).some((binding) => binding.name === "values")).toBe(false);
      expect(assessWorkflowStructuredReplayCoverage(source)).toBe(false);
    },
  );
  it.each(["dsl.workflow", "workflow"])("retains owned DSL inputs: %s", (callee) => {
    const source = `export default function run(${callee === "workflow" ? "{workflow}" : "dsl"}){return ${callee}((dsl,values)=>values.map(value=>value),{inputValue:[1],inputSchema:{type:"array",items:{type:"number"}}});}`;
    const root = parse(Lang.JavaScript, source).root();
    const entry = root.findAll({ rule: { kind: "function_declaration" } })[0];
    expect(workflowInputBindings(root, entry).find((binding) => binding.name === "values")?.schema?.type).toBe("array");
  });
});
