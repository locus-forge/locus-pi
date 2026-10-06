import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkflowSourceText } from "../../../../../extensions/workflows/tool/workflow-source-check-tool.js";
import { staticWorkflowMeta } from "../../../../../extensions/workflows/catalog/workflow-meta.js";
import { assessWorkflowStructuredReplayCoverage } from "../../../../../extensions/workflows/runtime/workflow-script-identity.js";
import { loadWorkflowScript } from "../../../../../extensions/workflows/runtime/workflow-runner.js";

const doc = readFileSync("docs/workflows/source-shape.md", "utf8").split("## Checked dataflow-v1")[1]!;
const examples = [...doc.matchAll(/```js\n([\s\S]*?)\n```/gu)].map((match) => match[1]!);
const check = (source: string) => checkWorkflowSourceText(source, "dataflow-v1");
const source = (body: string, helpers = "") =>
  `export const meta = { profile: "dataflow-v1" };\n${helpers}\nexport default async function run({agent,parallel,log,phase,publishPrimaryArtifact}, input) { ${body} }`;

describe("checked dataflow-v1 source, distinct from replay coverage", () => {
  it("retains both exact accepted documentation witnesses", () => {
    expect(examples.map((value) => createHash("sha256").update(value).digest("hex"))).toEqual([
      "18b8a17f8f03cc50f564e8d1aa87615bb994a2a75e341fe3fad18d799fc8243e",
      "a6ba9a59ccad246755a31c1ca0cb9f9a675a00276b7dc82bcd0b905692281c66",
    ]);
  });
  it.each([0, 1])("admits exact example %s and separately proves its callable coverage", (index) => {
    expect(staticWorkflowMeta(examples[index]!).profile).toBe("dataflow-v1");
    expect(check(examples[index]!).filter((value) => value.severity === "error")).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(examples[index]!)).toBe(true);
    expect(
      checkWorkflowSourceText(examples[index]!, "compatibility").some((value) => value.code === "WF_META_PROFILE"),
    ).toBe(true);
  });
  it.each([
    ["return ([1].map)(value => value + 1);", "", true, true],
    ["return (JSON.parse)(input).message;", "", true, true],
    ["return (String)(input);", "", true, true],
    ["return (pick)(input);", "function pick(value){return value;}", true, true],
    ["return [1].map((pick));", "function pick(value){return value + 1;}", true, true],
    ['const record={map:"data",trim:"text"};const alias=record;return alias.map;', "", true, true],
    ['{const input={trim:"data"};return input.trim;}', "", true, true],
    ['return pick(["x"]);', "function pick(value){return value.flat;}", true, false],
    ['return pick(["x"]);', "function pick(value){return value.push;}", true, false],
    ['return pick(["x"]);', "function pick(value){return value.toString;}", true, false],
    ['return pick("x");', "function pick(value){return value.charAt;}", true, false],
    ['return pick("x");', "function pick(value){return value.replace;}", true, false],
    ['return pick(["x"]);', 'function pick(value){return value["flat"];} ', true, false],
    ['return pick("x");', 'function pick(value){return value["replace"];} ', true, false],
    [
      'const data={flat:"data",push:"data",toString:"text",charAt:"data",replace:"text"}; return data.toString;',
      "",
      true,
      true,
    ],
    ['const data={flat:"data",replace:"text"};return data["flat"] + data.replace;', "", true, true],
    ["return (input.trim)();", "", true, true],
    [String.raw`return ["x"].fl\u0061t;`, "", false, false],
    [String.raw`return pick(["x"]);`, String.raw`function pick(value){return value.fl\u0061t;}`, true, false],
    [String.raw`const data={fl\u0061t:"data"};return data.fl\u0061t;`, "", true, true],
    [String.raw`return input.constr\u0075ctor;`, "", false, false],
    [String.raw`return {"prototype":"data"};`, "", false, false],

    ['return ["x"].flat;', "", false, false],
    ["return input.charAt;", "", false, false],
    ["return String(JSON.parse);", "", false, false],
    ['return pick(["x"]);', "function pick(value){return value.map;}", true, false],
    ['return pick({trim:"data"});', "function pick(input){return input.trim;}", true, false],
    ['return pick({map:"data"});', 'function pick(value){return value["map"];} ', true, false],
  ])("Q003 callee/data role and receiver-specific coverage: %s", (body, helpers, admitted, covered) => {
    const value = source(body as string, helpers as string);
    expect(check(value).filter((row) => row.severity === "error").length === 0).toBe(admitted);
    if (admitted) expect(assessWorkflowStructuredReplayCoverage(value)).toBe(covered);
  });
  it("requires an explicitly matching profile and mode", () => {
    expect(
      check(source('return "x";').replace("dataflow-v1", "standard")).some((value) => value.code === "WF_META_PROFILE"),
    ).toBe(true);
  });
  it.each([
    'return await workflow(async () => agent(input,{label:"nested-review"}),input);',
    'return await workflow(async ({agent}, request) => agent(request, {label:"nested-review"}), input);',
    'return await workflow(async (dsl, request) => await dsl.agent(request, {label:"nested-review"}), input);',
    "return await workflow(({log}, request) => {log(request); return request;}, input);",
    'return await workflow(async (dsl, request) => {const {agent}=dsl; return agent(request, {label:"nested-review"});}, input);',
    "return await workflow(({workflow}, request) => workflow(({log}, nested) => {log(nested); return nested;}, request), input);",
  ])("admits documented lexical DSL parameters of workflow-owned callbacks: %s", (body) => {
    const value = source(body).replace("{agent,parallel,log,phase,publishPrimaryArtifact}", "{workflow,agent}");
    expect(check(value).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(value)).toBe(true);
  });
  it.each([
    'return await workflow(({agent:dispatch}, request) => dispatch(request, {label:"nested-review"}), input);',
    'return await workflow(({agent = input}, request) => agent(request, {label:"nested-review"}), input);',
    'return await workflow((dsl, request) => {const dispatch=dsl.agent; return dispatch(request, {label:"nested-review"});}, input);',
    'return [input].map(({agent}) => agent("hidden", {label:"nested-review"}));',
  ])("keeps nested DSL aliasing and ordinary data callbacks refused: %s", (body) => {
    const value = source(body).replace("{agent,parallel,log,phase,publishPrimaryArtifact}", "{workflow}");
    expect(check(value).filter((diagnostic) => diagnostic.severity === "error").length).toBeGreaterThan(0);
  });
  it.each([
    ['const ids = ["a"]; return ids.map(id => id.toUpperCase()).join(",");', ""],
    [
      "return select([1,2], [2]);",
      "function select(rows, allowed) { return rows.filter(row => allowed.includes(row)); }",
    ],
    [
      "return read(input);",
      "function read(text) { try { return JSON.parse(text).items; } catch (problem) { return [String(problem)]; } }",
    ],
    ['return unwrap(["a"]);', "const unwrap = value => value.at(0);"],
    ["return JSON.parse(input).message;", ""],
    ['return {map:"ordinary data"}.map;', ""],
    ['const object={trim:"ordinary data"}; return object.trim;', ""],
    ['return ["x"].map(value=>value.trim());', ""],
    ['phase("work"); log("work"); publishPrimaryArtifact("x.md", "x"); return "x";', ""],
    ['return await parallel([() => agent("a", {label:"a"}), () => agent("b", {label:"b"})]);', ""],
    ['const JSON = {id:"local"}; return read(input);', "function read(text) { return JSON.parse(text); }"],
  ])("admits checked data/lexical captures and owned graph: %s", (body, helpers) => {
    expect(check(source(body, helpers)).filter((value) => value.severity === "error")).toEqual([]);
  });
  it.each([
    ['agent("x", {label:"x"}); return "x";', ""],
    ['const pending = agent("x", {label:"x"}); return await pending;', ""],
    ['const thunks = [() => agent("x", {label:"x"})]; return await parallel(thunks);', ""],
    ['return await parallel([1].map(id => agent(String(id), {label:"x"})));', ""],
    ['return [1].map(id => agent(String(id), {label:"x"}));', ""],
    ['[1].forEach(async id => await agent(String(id), {label:"x"})); return "x";', ""],
    ['return await Promise.all([agent("x", {label:"x"})]);', ""],
    ['const work = agent; return work("x", {label:"x"});', ""],
    ['return await agent("x", {label:"x", schema:{type:"string"}, validate:input});', ""],
    ['return await agent("x", {...input,label:"x"});', ""],
    ['return await agent("x", {label:"x", schema:{type:"null"},choice:["A","B"]});', ""],
    ['return await agent("x", {label:"x", schema:{type:"string"},repair:{unknown:true}});', ""],
    ['try { return await agent("x", {label:"x"}); } catch (error) { return "ignored"; }', ""],
    ['try { return await agent("x", {label:"x"}); } finally { return "override"; }', ""],
    ['return apply(input, "x");', "function apply(callback, value) { return callback(value); }"],
    [
      'return hide("x");',
      "function hide(value) { return more(value); } function more(value) { return globalThis.external(value); }",
    ],
    [
      'return cyclic("x");',
      "function cyclic(value) { return second(value); } function second(value) { return cyclic(value); }",
    ],
    ['return recurse("x");', "function recurse(value) { return recurse(value); }"],
    ["return later(input);", "async function later(value) { return value; }"],
    ["return change(input);", 'function change(value) { value.id = "changed"; return value; }'],
    ["return make(input);", "function make(value) { return () => value; }"],
    ["const data = {check:local}; return data;", "function local(value) { return value; }"],
    ["return apply(agent);", "function apply(value) { return String(value); }"],
    ["let value = input; return value;", ""],
    ["return process.env.ID;", ""],
    ["return eval(input);", ""],
    ['return input.constructor("return 1")();', ""],
    ['return input["__proto__"];', ""],
    ['return await parallel([1].map(id => () => agent(String(id), {label:"x"})));', ""],
    ['const parallel = input; return parallel([1].map(id => () => agent(String(id), {label:"x"})));', ""],
    ["const local = unique; return local(input);", "function unique(value) { return value; }"],
    ["return JSON.parse;", ""],
    ['return {fn:["x"].map};', ""],
    ["const rows=[1]; return rows.map;", ""],
    ["return input.trim;", ""],
    ['return [1]["map"];', ""],
    ['return input["trim"];', ""],
    ["const rows=[input]; const alias=rows; return alias.map;", ""],
    ['return {fn:"x".trim};', ""],
    ["const rows=[input]; return rows.filter;", ""],
    ["return {fn:JSON.parse};", ""],
    ["const parse=JSON.parse; return parse;", ""],
    ["return expose(input);", "function expose(value){return JSON.parse;}"],
    ['return await agent("x", {label:"same"}); return await agent("y", {label:"same"});', ""],
  ])("refuses hidden effects or unproven callable data: %s", (body, helpers) => {
    const errors = check(source(body, helpers)).filter((value) => value.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((value) => value.line > 0 && value.column > 0 && value.code.startsWith("WF_"))).toBe(true);
  });
  it.each([
    'const PROFILE="dataflow-v1"; export const meta={profile:PROFILE};',
    'const DECLARATION={profile:"dataflow-v1"}; export const meta=DECLARATION;',
    'export let meta={profile:"dataflow-v1"};',
    'const declared={profile:"dataflow-v1"}; export {declared as meta};',
    'export const meta={...{profile:"dataflow-v1"}};',
    'export const meta={profile:true ? "dataflow-v1" : "legacy"};',
    'export const meta={profile:"dataflow-" + "v1"};',
    'const profile=()=>"dataflow-v1"; export const meta={profile:profile()};',
    'const profile="dataflow-" + "v1"; export const meta={profile};',
    'export const meta={profile(){return "dataflow-v1";}};',
    'let profile="legacy"; profile="dataflow-v1"; export const meta={profile};',
    'var profile="legacy"; profile="dataflow-v1"; export const meta={profile:profile};',
  ])("refuses a nonliteral/ambiguous opt-in before importing %s", async (declaration) => {
    const root = mkdtempSync(path.join(tmpdir(), "dataflow-optin-"));
    try {
      const file = path.join(root, "source.workflow.mjs");
      const sentinel = path.join(root, "sentinel");
      writeFileSync(
        file,
        `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(sentinel)},"ran"); ` +
          declaration +
          ' export default function run() {return "x";}',
      );
      await expect(loadWorkflowScript(file)).rejects.toThrow(/dataflow-v1/u);
      expect(() => readFileSync(sentinel)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    'export const meta={profile:"legacy", details:{profile:"dataflow-v1"}};',
    'const PROFILE="legacy"; export const meta={profile:PROFILE,details:{profile:"dataflow-v1"}};',
    'const profile="legacy"; export const meta={profile,details:{profile:"dataflow-v1"}};',
  ])("preserves unrelated nested metadata and legacy author code: %s", async (declaration) => {
    const root = mkdtempSync(path.join(tmpdir(), "dataflow-legacy-"));
    try {
      const file = path.join(root, "source.workflow.mjs");
      writeFileSync(file, declaration + ' export default function run() { return "legacy"; }');
      const module = await loadWorkflowScript(file);
      expect(module.meta?.profile).toBe("legacy");
      writeFileSync(
        file,
        'export default async function run({log}) { const meta={profile:"dataflow-v1"}; return meta.profile; }',
      );
      await expect(loadWorkflowScript(file)).resolves.toHaveProperty("default");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("checks duplicate and computed opt-ins before evaluation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dataflow-profile-"));
    try {
      for (const meta of [
        '{profile:"legacy",profile:"dataflow-v1"}',
        '{profile:"dataflow-v1",profile:"legacy"}',
        '{["profile"]:"dataflow-v1"}',
      ]) {
        const filename = path.join(root, "invalid.workflow.mjs");
        writeFileSync(filename, source('return "x";').replace('{ profile: "dataflow-v1" }', meta));
        await expect(loadWorkflowScript(filename)).rejects.toThrow(/dataflow-v1/u);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    source('const {agent:dispatch}=dsl; ["Review"].map(dispatch); return "completed";').replace(
      "run({agent,parallel,log,phase,publishPrimaryArtifact}, input)",
      "run(dsl, input)",
    ),
    source('return strip({id:"A"});', "function strip(value) { delete value.id; return value; }"),
    source("return [input].map(value => { delete value.id; return value; });"),
    source('return apply(input, ["A"]);', "function apply(callback, values) {return values.map(callback);}"),
  ])("refuses independently reproduced callable aliases and deletion: %s", (value) => {
    expect(check(value).filter((value) => value.severity === "error").length).toBeGreaterThan(0);
  });
  it.each(['({profile:"dataflow-v1"})', '{profile:("dataflow-v1")}'])(
    "detects parenthesized opt-in before sentinel %s",
    async (meta) => {
      const root = mkdtempSync(path.join(tmpdir(), "dataflow-parens-"));
      const sentinel = path.join(root, "sentinel");
      try {
        const file = path.join(root, "source.workflow.mjs");
        writeFileSync(
          file,
          `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)},'ran'); export const meta=${meta}; export default function run(){return "x";}`,
        );
        await expect(loadWorkflowScript(file)).rejects.toThrow(/dataflow-v1/u);
        expect(() => readFileSync(sentinel)).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each(["[KEY]", "[`profile`]", '[("profile")]'])(
    "detects computed literal profile keys before evaluation: %s",
    async (key) => {
      const root = mkdtempSync(path.join(tmpdir(), "dataflow-computed-"));
      const sentinel = path.join(root, "sentinel");
      try {
        const file = path.join(root, "source.workflow.mjs");
        writeFileSync(
          file,
          `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(sentinel)},"ran"); const KEY="profile"; export const meta={${key}:"dataflow-v1"}; export default function run(){return "x";}`,
        );
        await expect(loadWorkflowScript(file)).rejects.toThrow(/dataflow-v1/u);
        expect(() => readFileSync(sentinel)).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("refuses a weakened snapshot identity declaration before fresh effects", () => {
    expect(
      check(
        source('return "x";').replace(
          'profile: "dataflow-v1"',
          'profile: "dataflow-v1", identityCoverage:"entry-only"',
        ),
      ).some((diagnostic) => diagnostic.message.includes("retained snapshot")),
    ).toBe(true);
  });
  it("keeps valid dynamic data access visibly unproven for replay", () => {
    const value = source('const ids = ["A", "B"]; return ids[input];');
    expect(check(value).filter((value) => value.severity === "error")).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(value)).toBe(false);
  });
  it("rejects invalid opted-in bytes before a top-level sentinel evaluates", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dataflow-admission-"));
    const sentinel = path.join(root, "sentinel");
    const filename = path.join(root, "invalid.workflow.mjs");
    // The forbidden top-level operation must never be imported, even when the
    // dataflow declaration appears after the catalog's bounded prefix.
    writeFileSync(
      filename,
      `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'evaluated');\n${"// padding\n".repeat(7000)}\n${source('return "x";')}`,
    );
    try {
      await expect(loadWorkflowScript(filename)).rejects.toThrow(/dataflow-v1/u);
      expect(() => readFileSync(sentinel)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("binds accepted loading to the independently hashed retained bytes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dataflow-snapshot-"));
    try {
      const file = path.join(root, "source.workflow.mjs");
      const accepted = source('return "original";');
      const hash = createHash("sha256").update(accepted).digest("hex");
      writeFileSync(file, accepted);
      await expect(loadWorkflowScript(file)).rejects.toThrow("independently hashed retained snapshot");
      await expect(loadWorkflowScript(file, hash, "source")).rejects.toThrow("independently hashed retained snapshot");
      await expect(loadWorkflowScript(file, hash, "snapshot")).resolves.toHaveProperty("default");
      writeFileSync(file, accepted.replace('"original"', '"changed"'));
      await expect(loadWorkflowScript(file, hash, "snapshot")).rejects.toThrow("snapshot hash mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("inherits numeric/escaped schema literal facts without widening standard reference admission", () => {
  const value = source(
    'return await agent(input, {label:"x", schema:S});',
    String.raw`const LOW=-(0xF);const S={t\u0079pe:"number",minimum:LOW,maximum:+(0x10)};`,
  );
  expect(check(value).filter((row) => row.severity === "error")).toEqual([]);
  expect(
    check(source('return await agent(input,{label:"x",schema:A});', "const A=B;const B=A;")).some(
      (row) => row.severity === "error",
    ),
  ).toBe(true);
  const escaped = source(String.raw`return a\u0067ent(input,{label:"x"});`);
  expect(check(escaped).some((row) => row.message.includes("without Unicode escapes"))).toBe(true);
  expect(assessWorkflowStructuredReplayCoverage(escaped)).toBe(false);
});

describe.each(["standard", "orchestration-only", "dataflow-v1"] as const)("typed optional host context: %s", (mode) => {
  const typed = (body: string, parameters = "context") =>
    `export const meta={profile:${JSON.stringify(mode === "orchestration-only" ? "standard" : mode)},inputSchema:{type:"string"}};
export default async function run({agent}, input, ${parameters}) { ${body} }`;
  const diagnostics = (value: string) =>
    checkWorkflowSourceText(value, mode === "standard" ? "compatibility" : mode).filter(
      (row) => row.severity === "error",
    );
  it.each([
    'if(context !== undefined) return await agent(context.operatorAnswer,{label:"x"}); return input;',
    'if(context === undefined) return input; return await agent(context.operatorAnswer,{label:"x"});',
    'if(context === undefined) return input; else return await agent(context.operatorAnswer,{label:"x"});',
    'if(context !== undefined) {const answer=context.operatorAnswer; return await agent(answer,{label:"x"});} return input;',
    'return context !== undefined ? context.operatorAnswer : "absent";',
    'if(context !== undefined) {const context={operatorAnswer:"local"}; return await agent(context.operatorAnswer,{label:"x"});} return input;',
  ])("proves the exact present arm without treating the answer as author data: %s", (body) => {
    const value = typed(body);
    expect(diagnostics(value)).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(value)).toBe(true);
  });
  it.each([
    ['return await agent(context.operatorAnswer,{label:"x"});', "context"],
    ['if(context === undefined) return await agent(context.operatorAnswer,{label:"x"}); return input;', "context"],
    ['if(context !== undefined) {return input;} return await agent(context.operatorAnswer,{label:"x"});', "context"],
    ["if(context !== undefined) return context.unknown; return input;", "context"],
    ["if(context !== undefined) return {context}; return input;", "context"],
    ["if(context !== undefined) {const alias=context; return alias;} return input;", "context"],
    ["if(context !== undefined) {const {operatorAnswer}=context; return operatorAnswer;} return input;", "context"],
    ['if(context !== undefined) return context["operatorAnswer"]; return input;', "context"],
    ['const undefined="forged"; if(context !== undefined) return context.operatorAnswer; return input;', "context"],
    ["return input;", "{operatorAnswer}"],
    ["return input;", "context, extra"],
    ["return input;", "context, undefined"],
    [
      "try{return input;}catch(undefined){if(context !== undefined)return context.operatorAnswer;return input;}",
      "context",
    ],
    ['if(context !== undefined)context.operatorAnswer="changed";return input;', "context"],
  ])("refuses unsupported context proof: %s", (body, parameters) => {
    const value = typed(body, parameters);
    expect(diagnostics(value).length).toBeGreaterThan(0);
    expect(assessWorkflowStructuredReplayCoverage(value)).toBe(false);
  });
  if (mode !== "dataflow-v1")
    it.each([
      'if(context !== undefined && context.operatorAnswer === "deploy") return input; return input;',
      'if(context !== undefined) {const answer=context.operatorAnswer; if(answer === "deploy") return input;} return input;',
    ])("preserves ordinary answer opacity in content routing: %s", (body) => {
      expect(diagnostics(typed(body)).length).toBeGreaterThan(0);
    });
});
