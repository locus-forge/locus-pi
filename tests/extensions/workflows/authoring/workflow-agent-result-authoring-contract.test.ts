/**
 * The agent-result boundary as public authoring guidance teaches it: an agent answers
 * with exact text, one choice, or explicitly schema-bound JSON. Plain text stays opaque;
 * file-backed work queues and removed-option refusals keep their contracts. These cases
 * own that teaching, not runtime validation or source admission.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../../extensions/workflows/tool/workflow-source-shape.js";

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/** Guidance a workflow author, or the agent building a workflow, copies from. */
const activeAuthoringGuides = [
  "skills/locus-pi-workflow-create/SKILL.md",
  "skills/locus-pi-workflow-create-detailed/SKILL.md",
  "skills/locus-pi-workflow-create-detailed/references/worked-decisions.md",
  ...readdirSync(path.join(root, "skills/locus-pi-workflow-create/references"))
    .filter((name) => name.endsWith(".md") && name !== "dsl.md")
    .map((name) => `skills/locus-pi-workflow-create/references/${name}`),
  ...readdirSync(path.join(root, "docs/workflows"))
    .filter((name) => name.endsWith(".md") && name !== "dsl.md")
    .map((name) => `docs/workflows/${name}`),
  "examples/workflows/README.md",
  "examples/workflows/task/README.md",
];

/*
 * The classifier reads the canonical prose these guides use, not arbitrary English: a model
 * subject, at most five words of its own predicate, a response verb, and an answer of at most
 * six words, with coordinated clauses and bounded asides as described below.
 */
const SUBJECT = String.raw`agents?|extractors?|owners?|reviewers?|composers?|workers?|stages?|models?|judges?|child(?:ren)?`;
/**
 * The one response vocabulary, by tense. A request uses the base form; only a past form can
 * be removal history, and `output` is both, so an explicit history marker decides its tense.
 */
const RESPONSE_BASE = String.raw`return|reply|respond|answer|output`;
const RESPONSE_PAST = String.raw`returned|replied|responded|answered|output(?:ted)?`;
const RESPONSE = String.raw`(?:${RESPONSE_BASE}|${RESPONSE_PAST}|returns|returning|replies|replying|responds|responding|answers|answering|outputs|outputting)\b`;
/** Coordinators that bound a clause, for a model subject's proposition, its answer, a refusal and history. */
const COORDINATOR = String.raw`but|and|or|while|whereas|yet|so`;
/** Determiners that open a noun phrase: before a model subject, or before a response noun ("its answer"). */
const DETERMINER = String.raw`the|an?|each|every|any|no|one|its|their`;
/** A response verb that continues the same predicate after a coordinator or comma ("and then returns"). */
const CONTINUED_RESPONSE = String.raw`(?:(?:then|also)\s+)?${RESPONSE}`;
/**
 * One word inside a model subject's own proposition, before its response verb. It is never
 * a response verb, so a subject cannot skip its own verb to claim a later one. A coordinator
 * or comma stays inside only while the subject's predicate continues ("reads the plan and then
 * returns", "reads the plan, then returns"); before any other word it opens a later
 * proposition with its own subject ("writes a file, and source returns", "When no agent
 * finishes, the owner returns"), whose verb this subject never claims.
 */
const SUBJECT_WORD = String.raw`\s+(?!${RESPONSE})(?!(?:${COORDINATOR})\s+(?!${CONTINUED_RESPONSE}))[^\s,]+(?:,(?=\s+${CONTINUED_RESPONSE}))?`;
/**
 * A model subject, with any request lead-in, determiner and modifier (never a coordinator),
 * through the end of its proposition before the verb.
 */
const MODEL_SUBJECT = String.raw`(?:\b(?:asks?|lets?|ha(?:ve|s)|makes?|tells?|instructs?|requires?)\s+)?(?:\b(?:${DETERMINER})\s+)?(?:\b(?!(?:${COORDINATOR})\b)[\w-]+\s+)?\b(?:${SUBJECT})\b(?:${SUBJECT_WORD}){0,5}?\s+`;
/**
 * A response verb of a later proposition: after a comma or coordinator, a subject of one to
 * three words ("and source outputs"), unless it is a continued predicate or a noun after a
 * determiner ("and its answer"). An answer never spans it. Only a determiner directly before
 * the noun marks it: in a compound object such as "returns text and a final answer as JSON",
 * `answer` reads as a later verb. That limit is intentional; inferring arbitrary noun phrases
 * would make this canonical-prose check more fragile, not more exact.
 */
const LATER_RESPONSE = String.raw`(?<=(?:,|\b(?:${COORDINATOR}))\s+(?!(?:${COORDINATOR})\b)(?!${CONTINUED_RESPONSE})\S+(?:\s+\S+){0,2}\s+)(?<!\b(?:${DETERMINER})\s+)${RESPONSE}`;
/** One answer word that is not a later proposition's response verb. */
const WORD = String.raw`\s+(?!${LATER_RESPONSE})\S+`;
const COLLECTION = String.raw`(?:lists?|arrays?|JSON|objects?)(?![-\w])`;
/** The answer after a response verb: an ordinary compound object ("the summary and a list") still counts. */
const ANSWER = String.raw`(?:${WORD}){0,6}?\s+${COLLECTION}`;
/**
 * A comma-bounded aside inside one proposition ("Each worker, in parallel, returns"; "reads
 * the plan and, in turn, returns"): one to four words, none a response verb, coordinator or
 * collection word, followed by more of that proposition rather than a determiner or model
 * subject that opens a later one. Every sentence is read without its asides, so an aside never
 * lengthens a proposition, and a negation or history word inside it ("not the owner",
 * "formerly a reviewer") never refuses or historicizes the return.
 */
const ASIDE = new RegExp(
  String.raw`,(?:\s+(?!${RESPONSE}|(?:${COORDINATOR})\b|${COLLECTION})[^\s,]+){1,4},(?=\s+(?!(?:${DETERMINER}|${SUBJECT})\b))`,
  "giu",
);
/** A standalone negation; a hyphenated modifier such as "no-code" is not one. */
const NEGATION =
  /\b(?:not(?!\s+only\b)|never|no|nor|cannot|without)\b(?!-)|n['’]t\b|\binstead\s+of\b|\brather\s+than\b/iu;
const HISTORY = /\b(?:removed|previously|formerly|no\s+longer|before\s+this\s+release|earlier\s+releases?)\b/iu;

/**
 * One row per way instruction text makes a model-returned collection the input source
 * consumes. Prose rows apply everywhere; the prompt row reads imperative requests,
 * which in prose describe what workflow source itself returns.
 */
const collectionReturnRules: ReadonlyArray<{ rule: string; prose: boolean; pattern: RegExp }> = [
  {
    rule: "a model role returns, replies, responds, answers or outputs a list, array, JSON or object",
    prose: true,
    pattern: new RegExp(String.raw`${MODEL_SUBJECT}(?<verb>${RESPONSE})${ANSWER}`, "giu"),
  },
  {
    rule: "a returned list, array, JSON, member, item or entry",
    prose: true,
    pattern: /\b(?<verb>returned)\s+(?:lists?|arrays?|JSON|members?|items?|entries|entry)(?![-\w])/giu,
  },
  {
    // A model subject in the request's own proposition starts the match, so the request is
    // read once from that subject and a refusal before it ("Do not ask an agent to return
    // JSON") governs the whole proposition.
    rule: "a request for a list, array, JSON or object answer",
    prose: false,
    pattern: new RegExp(String.raw`(?:${MODEL_SUBJECT})?\b(?<verb>${RESPONSE_BASE})\b${ANSWER}`, "giu"),
  },
];

function words(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

/** A coordinated clause bounds history; a refusal is bounded more tightly, by punctuation too. */
const COORDINATED_CLAUSE = new RegExp(String.raw`\b(?:${COORDINATOR})\b`, "iu");
const REFUSAL_CLAUSE = new RegExp(String.raw`[,;—|]|${COORDINATED_CLAUSE.source}`, "iu");
const PAST_RESPONSE = new RegExp(String.raw`^(?:${RESPONSE_PAST})$`, "iu");

/**
 * A refusal negates the matched proposition itself: inside it ("never returns", "no
 * agent", "not a returned list") or in the two words before it within the same clause
 * ("Do not ask an agent to return JSON"). An earlier clause's negation does not count.
 */
function refused(sentence: string, match: RegExpExecArray): boolean {
  const clause = sentence.slice(0, match.index).split(REFUSAL_CLAUSE).at(-1) ?? "";
  return NEGATION.test(match[0]) || NEGATION.test(words(clause).slice(-2).join(" "));
}

/**
 * History is a past-tense response with an explicit removal or release marker within five
 * words before or four words after it, inside its own coordinated clause. Present-tense
 * guidance is never history, and an earlier clause's marker does not historicize it.
 */
function historical(sentence: string, match: RegExpExecArray): boolean {
  if (!PAST_RESPONSE.test(match.groups?.verb ?? "")) return false;
  const before = words(sentence.slice(0, match.index).split(COORDINATED_CLAUSE).at(-1) ?? "").slice(-5);
  const after = words(sentence.slice(match.index + match[0].length).split(COORDINATED_CLAUSE)[0] ?? "").slice(0, 4);
  return HISTORY.test([...before, match[0], ...after].join(" "));
}

/** Sentences as every rule reads them: whitespace collapsed and bounded asides removed. */
function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)|[.;:!?](?=\s|$)/u)
    .map((sentence) => sentence.replace(/\s+/gu, " ").replace(ASIDE, "").trim())
    .filter(Boolean);
}

/** Only a checked agent call's own prompt receives the declared-schema exemption. */
function withoutSchemaBoundPrompts(code: string): string {
  const workflow = /\bexport\s+default\b/u.test(code)
    ? code
    : `export const meta = { name: "prompt-contract", profile: "standard" };
export default async function run({ agent }, input) { ${code} }`;
  if (standardWorkflowSourceShapeErrors(workflow).length > 0) return code;
  const file = ts.createSourceFile("example.mjs", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const ranges: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ["agent", "dsl.agent"].includes(node.expression.getText(file))) {
      const [prompt, options] = node.arguments;
      if (
        prompt &&
        options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) && property.name.getText(file).replace(/["']/gu, "") === "schema",
        )
      )
        ranges.push([prompt.getStart(file), prompt.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const [start, end] of ranges.sort((left, right) => right[0] - left[0]))
    code = `${code.slice(0, start)}""${code.slice(end)}`;
  return code;
}

function stringLiterals(code: string): string[] {
  return [...code.matchAll(/`((?:[^`\\]|\\.)*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

/**
 * Instruction text in one guide: prose between fences, whole text/markdown fences, and
 * the string literals (agent prompts) of JavaScript fences. JavaScript code and comments,
 * and command, data and diagram fences, carry no result instruction and are not read.
 */
function instructionText(markdown: string): { prose: string[]; prompts: string[] } {
  const prose: string[] = [""];
  const prompts: string[] = [];
  let fence: { info: string; lines: string[] } | undefined;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*```\s*(\S*)/u.exec(line);
    if (marker && fence === undefined) fence = { info: marker[1] ?? "", lines: [] };
    else if (marker && fence !== undefined) {
      const body = fence.lines.join("\n");
      if (/^(?:js|javascript|mjs)$/u.test(fence.info)) prompts.push(...stringLiterals(withoutSchemaBoundPrompts(body)));
      else if (/^(?:text|markdown|md)$/u.test(fence.info)) prompts.push(body);
      prose.push("");
      fence = undefined;
    } else if (fence !== undefined) fence.lines.push(line);
    else prose[prose.length - 1] += `${line}\n`;
  }
  return { prose, prompts };
}

/** A schema qualification belongs to this proposition, never an unrelated earlier clause. */
function schemaBound(sentence: string, match: RegExpExecArray): boolean {
  const before = sentence.slice(0, match.index).split(COORDINATED_CLAUSE).at(-1) ?? "";
  const after = sentence.slice(match.index + match[0].length).split(COORDINATED_CLAUSE)[0] ?? "";
  return /\bschema-(?:bound|proven)\b|\b(?:with|through|using)\s+(?:an?\s+)?literal\s+`?schema\b/iu.test(
    `${before}${match[0]}${after}`,
  );
}

/** Sentences that ask for or rely on an unqualified model-returned collection. */
function modelCollectionReturns(markdown: string): string[] {
  const { prose, prompts } = instructionText(markdown);
  const violating = (text: string, rules: typeof collectionReturnRules, allowSchemaQualification = false) =>
    sentences(text).filter((sentence) =>
      rules.some(({ pattern }) =>
        [...sentence.matchAll(pattern)].some(
          (match) =>
            !refused(sentence, match) &&
            !historical(sentence, match) &&
            !(allowSchemaQualification && schemaBound(sentence, match)),
        ),
      ),
    );
  return [
    ...prose.flatMap((text) =>
      violating(
        text,
        collectionReturnRules.filter((row) => row.prose),
        true,
      ),
    ),
    ...prompts.flatMap((text) => violating(text, collectionReturnRules)),
  ];
}

const codeExample = (...lines: string[]) => ["```js", ...lines, "```"].join("\n");
const js = (prompt: string) => codeExample(`const answer = await agent(${JSON.stringify(prompt)});`);

/** Each case is one sentence; `true` means the contract rejects it. */
const resultContractCases: ReadonlyArray<[string, boolean]> = [
  // The three stale formulations QA found in the two repaired guides.
  ["- an extraction agent returns the complete textual finding or list;", true],
  ["The returned list itself is authoritative.", true],
  ["Independent recheck examines the actual returned members before editing.", true],
  // An earlier, unrelated clause neither refuses nor historicizes a later return.
  ["Do not parse output in source, but the agent returns JSON.", true],
  ["An agent never returns text, but the owner returns a list.", true],
  ["Do not use the removed option, but the agent returns JSON.", true],
  ["Do not use the removed option, but the agent returned JSON.", true],
  ["Do not use the removed option, but agents output JSON.", true],
  ["The reviewer returns an array of findings and source loops over it.", true],
  ["Each worker returns a JSON object.", true],
  ["Each worker, in parallel, returns a JSON object.", true],
  ["Each worker, not the owner, returns a JSON object.", true],
  // A bounded aside anywhere before the verb neither refuses nor historicizes the return,
  // and a hyphenated modifier is not the determiner "No".
  ["The agent reads the plan and, in turn, returns a JSON object.", true],
  ["Each worker, formerly a reviewer, returned a JSON object.", true],
  ["A no-code agent returns a JSON object.", true],
  // A comma that opens a later proposition bounds the earlier subject; an aside before it
  // is not removed, and a collection word is never an aside.
  ["When no agent finishes, the owner returns a list.", true],
  ["Although no agent finishes, in practice, the owner returns a list.", true],
  ["The reviewer returns a summary, a list, and a verdict.", true],
  ["The agent reads the plan, then returns a JSON list.", true],
  ["The composer returns the summary and a list of open items.", true],
  ["The composer returns its answer as a JSON object.", true],
  ["The composer returns the final answer and a list of open items.", true],
  ["The agent reads the plan and then returns a JSON list.", true],
  ["The agent responds with text and then returns a JSON list.", true],
  ["Ask the extraction agent to return JSON.", true],
  ["Ask an agent to reply with JSON.", true],
  ["Tell the reviewer to respond with a list.", true],
  ["The agent returns not only text but also a JSON list.", true],
  ["Source reads the returned items and the returned entries.", true],
  // Past tense alone is not history.
  ["The owner returned a list of slices.", true],
  ["Workers output a list of slices.", true],
  [js("Return the findings as a JSON array."), true],
  [js("Reply with a list of risks."), true],
  [["```text", "Create a workflow whose reviewer returns a list of risks.", "```"].join("\n"), true],
  // Schema-bound JSON is explicit; a nearby schema mention does not excuse plain text.
  ["A schema-bound agent returns JSON.", false],
  ["With a literal schema, the agent returns JSON.", false],
  ["The agent returns JSON through a literal schema.", false],
  ["A schema is documented, but the agent returns JSON.", true],
  ["A schema-bound agent returns JSON, but a plain agent returns JSON.", true],
  ["The agent returns JSON without a schema.", true],
  [codeExample('const value = await agent("Return JSON.", { label: "record", schema: { type: "object" } });'), false],
  [
    codeExample(
      'const value = await agent("Return JSON.", { label: "record", schema: { type: "object" } });',
      'const text = await agent("Return JSON.", { label: "plain" });',
    ),
    true,
  ],
  [
    codeExample('const value = await agent("Return JSON.", { label: "record", schema: { type: "unsupported" } });'),
    true,
  ],
  [
    codeExample(
      'const value = await agent("Return JSON.", { label: "record", schema: { type: "object" }, validate: () => [] });',
    ),
    true,
  ],
  [js("Return JSON through a literal schema."), true],
  [
    codeExample(
      'const value = await agent("Return JSON.", { label: "record", schema: { type: "object" }, repair: { maxAttempts: 2 } });',
    ),
    true,
  ],
  [
    codeExample(
      'const value = await agent("Return JSON.", { label: "record", schema: { type: "object" }, outputTransport: "tool" });',
    ),
    true,
  ],
  [codeExample('const value = await agent("Return JSON.", { label: "record", schema: makeSchema() });'), true],
  [
    codeExample(
      'const value = await agent("Return JSON.", { label: "record", schema: { type: "string" } });',
      "return JSON.parse(value);",
    ),
    true,
  ],
  [
    codeExample(
      'export const meta = { name: "schema-example", profile: "standard" };',
      'const RESULT_SCHEMA = { type: "object" };',
      'export default async function run({ agent }) { return agent("Return JSON.", { label: "record", schema: RESULT_SCHEMA }); }',
    ),
    false,
  ],
  [
    codeExample(
      'export const meta = { name: "schema-example", profile: "standard" };',
      'export default async function run(dsl) { return dsl.agent("Return JSON.", { label: "record", schema: { type: "object" } }); }',
    ),
    false,
  ],
  // Local refusals.
  ["An agent never returns a list.", false],
  ["An agent never returns a list or JSON for source to consume.", false],
  ["An agent does not return JSON, an object, a list, or a value the source parses.", false],
  ["No agent returns a list.", false],
  ["Do not ask an agent to return JSON.", false],
  ["Never let the extraction agent return a list.", false],
  ["The agent returns readable text, not JSON.", false],
  ["The agent returns a file path instead of a list.", false],
  ["A queue is a loop over a workspace file, not a returned list.", false],
  [js("Do not return JSON; write the findings to `findings.md`."), false],
  [["```text", "Do not ask an agent to return JSON.", "```"].join("\n"), false],
  // Caller-owned input and ordinary list vocabulary.
  ["`items()` receives a caller-supplied list of stable keys.", false],
  ["`items()` returns the caller's list unchanged.", false],
  ["One agent lists the cwd and returns readable text.", false],
  // Imperative prose instructs workflow source, which may return an object.
  ["Catch the stable code and return a result object with `partial:true`.", false],
  ["The agent writes a file, and source returns a result object.", false],
  ["The agent writes a file and source returns a result object.", false],
  ["The agent responds with text and source outputs a JSON object.", false],
  ["The agent returns readable text and the workflow returns an object.", false],
  ["The agent, in turn, writes a file and source returns a result object.", false],
  ["Source, not the agent, returns a result object.", false],
  // Explicit removal history.
  ["The agent returned JSON through the removed option.", false],
  ["Before this release an agent returned a list through the removed `handoffs` option.", false],
  ["Previously, reviewers returned arrays of findings.", false],
  ["Previously, reviewers replied with arrays of findings.", false],
  ["Previously, the agent output JSON through the removed option.", false],
  ["The removed `handoffs` option validated each returned item.", false],
  // Command and data fences are not instruction text.
  [["```bash", "echo 'the agent returns JSON'", "```"].join("\n"), false],
];

describe("agent result authoring contract", () => {
  it.each(resultContractCases)("classifies %j (rejected: %s)", (text, rejected) => {
    expect(modelCollectionReturns(text)).toHaveLength(rejected ? 1 : 0);
  });

  it("requires an explicit schema contract for model-returned collections source consumes", () => {
    // Plain text remains opaque; only declared schema shape admits bounded source consumption.
    // A revisable work queue can still live in a named file later agents read.
    expect(activeAuthoringGuides).toEqual(
      expect.arrayContaining([
        "skills/locus-pi-workflow-create/references/source-boundary.md",
        "examples/workflows/task/README.md",
      ]),
    );
    for (const relativePath of activeAuthoringGuides)
      expect(modelCollectionReturns(source(relativePath)), relativePath).toEqual([]);

    const boundary = source("skills/locus-pi-workflow-create/references/source-boundary.md").replace(/\s+/gu, " ");
    expect(boundary).toContain("a literal-schema result for bounded source consumption");
    expect(boundary).toContain("findings in an exact caller-assigned file");
    expect(boundary).toContain("source never parses a list out of plain model text");
    expect(boundary).toContain("`validate`, `repair` and `outputTransport` stay outside ordinary authoring");

    // The task guide names the queue files the checked-in workflow actually writes and reads.
    const task = source("examples/workflows/task/README.md").replace(/\s+/gu, " ");
    const planLight = source("examples/workflows/task/plan-light.workflow.mjs");
    for (const file of ["workflow-source-queue.md", "workflow-source-queue-prior.md"]) {
      expect(task).toContain(`\`${file}\``);
      expect(planLight).toContain(file);
    }
    expect(task).toContain("The named caller-assigned queue file is authoritative; the owner's report is not.");
    expect(task).toContain("Independent assessment and recheck read that exact file and examine each numbered item");
    expect(task).toContain("The workflow script never reads the queue file");
  });

  it("keeps removed options and trusted-runtime-only hooks outside generated source guidance", () => {
    // A generated workflow copies what these guides recommend. Each sentence that names a
    // removed option must say it is removed or
    // refused; a list item inherits that label from a lead-in such as "Do not generate:".
    const guides = [
      "docs/workflows/create.md",
      "skills/locus-pi-workflow-create/SKILL.md",
      "skills/locus-pi-workflow-create-detailed/SKILL.md",
      "skills/locus-pi-workflow-create-detailed/references/worked-decisions.md",
      ...readdirSync(path.join(root, "skills/locus-pi-workflow-create/references"))
        .filter((name) => name.endsWith(".md") && name !== "dsl.md")
        .map((name) => `skills/locus-pi-workflow-create/references/${name}`),
    ];
    // The generated full DSL reference also documents runtime-only Fusion options; its API coverage has its own suite.
    const removedMention =
      /`(?:handoffs|output|returnVia|maxAnswerChars|schemaMaxLength|maxItemChars)(?![-\w])[^`]*`/iu;
    const runtimeOnlyMention = /`(?:validate|repair|outputTransport)(?![-\w])[^`]*`/iu;
    const removalLabel = /\b(?:removed|refuse[sd]?|refusal|do not|never|no source carries)\b/iu;
    const runtimeOnlyLabel = /\b(?:outside|forbidden|trusted-runtime-only|runtime.only)\b/iu;
    for (const relativePath of guides) {
      const blocks = source(relativePath)
        .replace(/```[\s\S]*?```/gu, "")
        .split(/\n\s*\n/u);
      blocks.forEach((block, index) => {
        const leadIn = blocks[index - 1] ?? "";
        const inherited = /^\s*-/u.test(block) && /:\s*$/u.test(leadIn) && removalLabel.test(leadIn);
        for (const sentence of block.split(/(?<=[.;!?])\s+(?=[A-Z`(-])|\n(?=\s*-)/u)) {
          if (removedMention.test(sentence) && !inherited) expect(sentence, relativePath).toMatch(removalLabel);
          if (runtimeOnlyMention.test(sentence) && !inherited && !removalLabel.test(sentence))
            expect(sentence, relativePath).toMatch(runtimeOnlyLabel);
        }
      });
    }
    // The adaptive queue lives in a workspace file the queue owner rewrites; source holds no
    // JavaScript copy of it and declares no list result for it.
    const adaptive = source("skills/locus-pi-workflow-create/references/agentic-approaches.md")
      .split("\n## Adaptive slices\n")[1]
      ?.split("\n## ")[0];
    expect(adaptive).toBeDefined();
    for (const sentence of adaptive!.split(/(?<=[.;!?])\s+/u)) {
      if (/\bqueue\b/iu.test(sentence)) expect(sentence).not.toMatch(/`let`|`\[\]`|handoffs/u);
    }
  });
});
