import { describe, expect, it } from "vitest";
import {
  orchestrationOnlyWorkflowSourceShapeDiagnostics,
  standardWorkflowSourceShapeDiagnostics,
} from "../../../../extensions/workflows/tool/workflow-source-shape.js";
import { assessWorkflowStructuredReplayCoverage } from "../../../../extensions/workflows/runtime/workflow-script-identity.js";

const prefix = `export const meta = { name: "structured-map", profile: "standard" };
export default async function run({ agent, log, parallel, pipeline, workflow }) {
  const rows = await agent("Rows", {label:"rows",schema:{type:"array",items:{type:"string"}}});`;
const source = (body: string) => `${prefix}\n${body}\n}`;
const refusal =
  "structured array map callbacks return synchronous values or deferred branch functions, never pending Promises";

const pendingProjections = [
  ...[
    "true ? pending : pending",
    "true && pending",
    "pending || 'value'",
    "null ?? pending",
    "[true ? pending : null]",
    "({value: false || pending})",
  ].map((expression) => `const pending = agent('Next', {label:'next'}); return rows.map(row => ${expression});`),
  "const pending = agent('Next', {label:'next'}); const values = await (true ? [pending] : pending); return rows.map(row => values);",
  "const pending = agent('Next', {label:'next'}); return rows.map(row => [pending][0]);",
  "const pending = agent('Next', {label:'next'}); return rows.map(row => ({value:pending}).value);",
  "const pending = agent('Next', {label:'next'}); return rows.map(row => [pending].map(item => item));",
  "const pending = agent('Next', {label:'next'}); return parallel(rows.map(row => () => parallel([() => [pending]])));",
  "const pending = agent('Next', {label:'next'}); return parallel(rows.map(row => () => [pending]));",
  "const pending = agent('Next', {label:'next'}); for (const item of [pending]) return rows.map(row => item); return rows;",
  "const pending = agent('Next', {label:'next',choice:['yes','no']}); let carry = ''; for (let index=0; index<2; index++) { carry=pending; if(index===0) break; carry=await agent('Done', {label:'done',choice:['yes','no']}); } return rows.map(row => carry);",
  "return rows.map(async row => row);",
  "return await rows.map(async row => row);",
  "const mapped = rows.map(async row => row); const alias = mapped; return alias;",
  "const mapped = rows.map(async row => row); for (const value of mapped) log(value); return rows;",
  "return parallel(rows.map(async row => row));",
  "return { values: rows.map(async row => row) };",
  "return rows.map(row => agent(row, {label:'next'}));",
  "return rows.map(row => agent(row, {label:'next',schema:{type:'string'}}));",
  "const pending = agent('Next', {label:'next'}); return rows.map(row => pending);",
  "const pending = agent('Next', {label:'next',choice:['yes','no']}); return rows.map(row => pending);",
  "const pending = agent('Next', {label:'next',schema:{type:'string'}}); const alias = pending; return rows.map(row => alias);",
  "return rows.map(row => { const pending = agent(row, {label:'next'}); return pending; });",
  "const pending = agent('Next', {label:'next'}); const values = [pending]; return rows.map(row => values);",
  "const pending = agent('Next', {label:'next'}); const value = {pending}; return rows.map(row => value);",
  "return rows.map(row => [agent(row, {label:'next'})]);",
  "return rows.map(row => ({value: agent(row, {label:'next'})}));",
  "return rows.map(row => rows.map(async inner => inner));",
  "const pending = rows.map(async row => row); const stillPending = await pending; return rows.map(row => stillPending);",
];

describe.each([
  ["standard", standardWorkflowSourceShapeDiagnostics],
  ["orchestration-only", orchestrationOnlyWorkflowSourceShapeDiagnostics],
] as const)("structured map Promise boundary in %s", (_mode, check) => {
  it.each(pendingProjections)("refuses pending projections: %s", (body) => {
    expect(check(source(body)).map((diagnostic) => diagnostic.message)).toContain(refusal);
    expect(assessWorkflowStructuredReplayCoverage(source(body))).toBe(false);
  });

  it.each([
    ...[
      "true ? (()=>row) : (()=>row)",
      "true && (()=>row)",
      "false || (()=>row)",
      "null ?? (()=>row)",
      "[true ? (()=>row) : null]",
      "({run: true && (()=>row)})",
      "[()=>row][0]",
      "({run:()=>row}).run",
      "[()=>row].map(fn=>fn)",
    ].map((expression) => `return rows.map(row => ${expression});`),
    "return rows.map(row => { for (const fn of [()=>row]) return fn; return row; });",
    "return parallel(rows.map(row => true ? (()=>row) : row));",
    "return parallel(rows.map(row => true ? (()=>row) : (()=>row)));",
    "return parallel(rows.map(row => () => parallel([() => () => row])));",
    "return parallel(rows.map(row => () => workflow(() => () => row)));",
    "return parallel(rows.map(row => () => pipeline([()=>row], item=>item)));",
    "return rows.map(row => () => row);",
    "return rows.map(row => [() => row]);",
    "return rows.map(row => ({ run: () => row }));",
    "const branches = rows.map(row => () => row); const alias = branches; return alias;",
    "const branches = rows.map(row => () => row); return { branches };",
    "return await rows.map(row => () => row);",
    "return parallel(rows.map(row => [() => row]));",
    "return parallel(rows.map(row => () => () => row));",
    "const branches = rows.map(row => () => row); return branches[0];",
    "const branches = rows.map(row => () => row); return branches.map(branch => branch);",
  ])("keeps callable projections out of JSON: %s", (body) => {
    expect(check(source(body)).map((diagnostic) => diagnostic.message)).toContain(
      "structured array map function projections are consumed only as direct parallel branches, never emitted as JSON",
    );
    expect(assessWorkflowStructuredReplayCoverage(source(body))).toBe(false);
  });

  it("preserves awaited bounded carry without promising numeric-loop replay", () => {
    const text = source(
      "let carry = ''; for (let index=0; index<2; index++) { carry=await agent('Done', {label:'done',choice:['yes','no']}); } return rows.map(row => carry);",
    );
    expect(check(text).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(text)).toBe(false);
  });

  it.each([
    "return rows.map(row => true ? 1 : 2);",
    "return rows.map(row => true && 'literal');",
    "return rows.map(row => null ?? { value: 'literal' });",
    "return rows.map(row => undefined);",
    "return parallel(rows.map(row => () => parallel([() => agent(row, {label:'next'})])));",
    "return rows.map(row => row);",
    "return rows.map(row => { const alias = row; return alias; });",
    "return rows.map(row => rows.map(inner => inner));",
    "for (const item of rows) log(item); return rows.map(row => row);",
    "return parallel(rows.map(row => () => agent(row, {label:'next'})));",
    "return parallel(rows.map(row => async () => await agent(row, {label:'next'})));",
    "const branches = rows.map(row => () => row); const alias = branches; return await parallel(alias);",
    "const pending = agent('Next', {label:'next',schema:{type:'string'}}); const settled = await pending; return rows.map(row => settled);",
  ])("preserves synchronous values and deferred branches: %s", (body) => {
    expect(check(source(body)).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(assessWorkflowStructuredReplayCoverage(source(body))).toBe(true);
  });
});

describe.each([
  ["standard", standardWorkflowSourceShapeDiagnostics],
  ["orchestration-only", orchestrationOnlyWorkflowSourceShapeDiagnostics],
] as const)("ordinary literal-map compatibility in %s", (_mode, check) => {
  const inventorySource = (body: string) => `export const meta={name:'literal-map',profile:'standard'};
export default async function run({agent}) {
  const records=[{name:'one'},{name:'two'}]; ${body}
}`;
  it("preserves authored record identity maps without a schema", () => {
    const text = inventorySource(
      "const copied=records.map(item=>item); for(const entry of copied){await agent(entry.name,{label:'use'});} return copied;",
    );
    expect(check(text).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });
  it.each([
    "const answer=await agent('Model',{label:'model'}); const copied=records.map(item=>answer);",
    "const answer=await agent('Model',{label:'model'}); const copied=records.map(item=>({name:answer}));",
    "const copied=records.map(item=>agent(item.name,{label:'model'}));",
  ])("keeps foreign values and edge captures opaque: %s", (body) => {
    const errors = check(
      inventorySource(`${body} for(const entry of copied){await agent(entry.name,{label:'use'});} return copied;`),
    ).filter((diagnostic) => diagnostic.severity === "error");
    expect(errors.some((diagnostic) => diagnostic.message.includes("opaque"))).toBe(true);
  });
});
