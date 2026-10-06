import { describe, expect, it } from "vitest";
import { assessWorkflowStructuredReplayCoverage } from "../../../../../extensions/workflows/runtime/workflow-script-identity.js";
const workflow = (declaration: string, callback: string) => `${declaration}
export default async function run({agent, input, items}) { const check = ${callback}; await agent('inspect', {schema:{type:'string'}}); return check(input); }`;
describe("conservative v4 closure coverage, separate from legacy source grammar", () => {
  it.each([
    workflow("", 'value => value === input ? [] : ["Wrong input id"]'),
    workflow("", 'value => items().includes(value) ? [] : ["Wrong input id"]'),
    workflow("", 'value => Number.isInteger(value) ? [] : ["Not integral"]'),
    workflow('function local(value) { return value === "known" ? [] : ["Wrong id"]; } const alias = local;', "alias"),
    workflow('const known = new Set(["known"]);', 'value => known.has(value) ? [] : ["Wrong id"]'),
    workflow(
      'const helpers = { check: value => value === "known" ? [] : ["Wrong id"] };',
      "value => helpers.check(value)",
    ),
    workflow("function local(value) { return []; } const first = local; const second = first;", "second"),
    workflow("", 'value => JSON.parse(input).ids.includes(value) ? [] : ["Wrong input id"]'),
  ])("covers local/source-declared callback and bound inputs: %s", (source) => {
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(true);
  });
  it("refuses callback accessors", () => {
    const source =
      'export default async function run(dsl) { return dsl.agent("inspect", {schema:{type:"null"}, get schema(){ return [].externalWorkflowValidator; }}); }';
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(false);
  });
  it("refuses opaque options instead of assuming their callback belongs to source", () => {
    const source =
      'const opts = [].externalOptions; export default async function run(dsl) { return dsl.agent("inspect",opts); }';
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(false);
    expect(
      assessWorkflowStructuredReplayCoverage(
        source.replace("const opts = [].externalOptions", 'const opts = {schema:{type:"null"}}'),
      ),
    ).toBe(true);
  });
  it.each(["validate", "repair", "outputTransport"])("refuses removed %s declarations", (option) => {
    const source = `const ${option} = undefined; export default async function run({agent}) { return agent("inspect", {schema:{type:"null"},${option}}); }`;
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(false);
  });
  it.each([
    workflow("", "globalThis.externalWorkflowValidator"),
    workflow(
      'const JSON = {parse:()=>({includes:[].externalWorkflowValidator})}; const known = JSON.parse("x");',
      "value => known.includes(value)",
    ),
    workflow(
      "const local = {map:()=>({includes:[].externalWorkflowValidator})}; const known = local.map();",
      "value => known.includes(value)",
    ),
    workflow(
      "function items() { return {includes:[].externalWorkflowValidator}; } const known = items();",
      "value => known.includes(value)",
    ),
    workflow(
      "function helper(data, value) { return data.includes(value); }",
      "value => helper({includes:[].externalWorkflowValidator},value)",
    ),
    workflow("const data = [{includes:[].externalWorkflowValidator}];", "value => data[0].includes(value)"),
    workflow(
      "function Map() { return { has: [].externalWorkflowValidator }; } const known = new Map();",
      "value => known.has(value)",
    ),
    workflow(
      "function make() { return { includes: [].externalWorkflowValidator }; } const known = make();",
      "value => known.includes(value)",
    ),
    workflow("var local = value => []; var local = [].externalWorkflowValidator;", "local"),
    workflow("", "value => [].has(value)"),
    workflow("", "value => ({}).includes(value)"),
    workflow("let local = value => []; local = [].externalWorkflowValidator;", "local"),
    workflow("const local = { check: value => [], ...[].externalMethods };", "local.check"),
    workflow("", "value => [].externalWorkflowValidator(value)"),
    workflow("const data = [];", "value => data.externalWorkflowValidator(value)"),
    workflow("const data = {};", "value => data.externalWorkflowValidator(value)"),
    workflow("const inherited = [].externalWorkflowValidator;", "inherited"),
    workflow("const data = {}; const inherited = data.externalWorkflowValidator;", "inherited"),
    workflow("const decoy = { externalWorkflowValidator: null };", "value => [].externalWorkflowValidator(value)"),
    workflow("", "value => [].map([].externalWorkflowValidator)"),
    workflow("const callback = [].externalWorkflowValidator;", "value => [].map(callback)"),
    workflow("function apply(callback, value) { return callback(value); }", "value => apply(() => [], value)"),
    workflow("function make() { return () => []; }", "value => make()(value)"),
    workflow("const C = [].externalWorkflowValidator;", "value => new C(value)"),
    workflow("const from = Array.from;", "value => from(value, [].externalWorkflowValidator)"),
    workflow("", 'value => []["__proto__"]["externalWorkflowValidator"](value)'),
    workflow("", 'value => ([]["__proto__"]).externalWorkflowValidator(value)'),
    workflow("", 'value => []["prototype"]["externalWorkflowValidator"](value)'),
    workflow("", "value => globalThis.externalWorkflowValidator(value)"),
    workflow("const root = globalThis; const local = root.externalWorkflowValidator;", "local"),
    workflow("", "externalWorkflowValidator"),
    workflow("", 'value => process.env.ID === value ? [] : ["Wrong id"]'),
    workflow('import local from "./external.mjs";', "local"),
    workflow("", 'value => Reflect.get(globalThis, "validator")(value)'),
    workflow('const local = (()=>{}).constructor("value", "return []");', "local"),
    workflow('const local = Array["constructor"]("return []");', "local"),
    workflow('const method = "constructor"; const local = (()=>{})[method]("return []");', "local"),
    workflow("const ambient = Object.getPrototypeOf(()=>{});", "value => ambient(value)"),
  ])("refuses uncovered ambient/callback/reflection dependencies: %s", (source) => {
    expect(assessWorkflowStructuredReplayCoverage(source)).toBe(false);
  });
});
