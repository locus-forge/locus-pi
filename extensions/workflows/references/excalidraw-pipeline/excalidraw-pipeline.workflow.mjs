// excalidraw-pipeline.workflow.mjs
//
// Turns a free-form diagram intent into a rendered Excalidraw diagram in two
// separate runs, because a workflow run has no way to stop and ask a human:
// `ask` refuses without a UI and child agent sessions are headless. The human
// gate is therefore a file the operator edits between the runs, exactly like
// `post-code-review` -> `implement`.
//
//   /workflows run <this file> draft <what the diagram should show>
//     One agent writes .tasks/excalidraw-pipeline/<run>/diagram-request.md.
//     The run stops there. The operator edits that file and sets `approved: yes`.
//
//   /workflows run <this file> build <path to diagram-request.md>
//     Refuses to start unless the request file parses and is approved. One agent
//     per section writes a restricted graph source; the workflow executes each
//     file, feeds hard errors back for a bounded number of repairs, then composes,
//     health-checks, and renders the diagram itself.
//
// Two rules shape the whole file:
//   - Agent text is never a protocol. The machine-checkable object is always a
//     file the agent wrote, which this workflow reads and validates.
//   - The workflow assigns every path and every coordinate. An agent that picks
//     its own output path is the specific failure this design closes.
//
// `identityCoverage: "entry-only"` is declared because this module reads
// `import.meta.url` to locate its sibling section host. That hash covers this
// entry file only.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  name: "excalidraw-pipeline",
  description: "Turns a diagram intent into an approved request file, then builds and renders an Excalidraw diagram.",
  identityCoverage: "entry-only",
};

/**
 * The acceptance TIER for the authoring stages.
 *
 * The claim behind this pipeline — a workflow whose stages are decomposed
 * correctly finishes on a weak model — is a claim about a RUN, and the run that
 * established it is recorded in the README together with the exact model it used.
 * Freezing that `provider/id` into the script never kept the claim honest; a
 * reader cannot re-derive a past run from a constant. What it did do is decide
 * which vendor a reader pays: a concrete selector is resolved through the host
 * registry before the child exists, so every operator without that provider got a
 * call refused by name instead of a pipeline.
 *
 * The tier keeps the routing deliberate and hands the choice back: `agent`
 * resolves to whatever `/model-roles` assigns, and unassigned it runs on the
 * session model with the degradation recorded in the run evidence. To reproduce
 * the recorded run rather than merely execute the pipeline, assign AGENT to the
 * model the README names.
 */
const AUTHOR_MODEL_ROLE = "agent";

/**
 * The draft stage is the cheap one, and it names the cheap tier rather than the
 * authoring one. Turning free-form intent into a structured request file is
 * bounded, mechanical work against a stated template, which is what makes it the
 * stage to buy cheaply.
 * `smol` resolves to whatever the operator's global `~/.pi/agent/model-roles/config.json` assigns;
 * unassigned, it runs on the session model and the run evidence records the
 * degradation.
 *
 * Explicitly NOT the reason: this stage's script-side `parseRequestFile` gate below.
 * That gate and its repair loop predate this choice and are the script-side debt
 * roadmap P0.2 owns (`references/patterns.md`, "What the script may check" — a shape
 * the script must branch on belongs in `agent({ schema })`, whose runtime retry is
 * the one correction loop the DSL gives for free). A cheap tier is not licensed by a
 * script that re-reads the answer, and this choice must not be read as endorsing one.
 */
const DRAFT_MODEL_ROLE = "smol";

/**
 * Bounded fan-out. A request that wants more sections is a different diagram. This is a
 * pre-request scope decision owned by THIS workflow — what it agrees to draw — not a cap
 * on anything a child answers; no size policy is applied to a returned section.
 */
const MAX_SECTIONS = 6;
/** Attempts after the first authoring attempt before a section is given up on. */
const MAX_SECTION_REPAIRS = 2;

/**
 * Two explicit declarations, and neither is about the size of an answer.
 *
 * `workspaceMode: "project"` is a CAPABILITY: every stage below delivers by writing a
 * section source file into the run directory and the script then executes that file, so
 * a stage confined away from the project checkout cannot do its job at all.
 *
 * `maxToolCalls: 80` is an explicit per-call SPEND budget, chosen for what one section
 * costs: read the prompt resources, write one file, and re-read it across at most two
 * repairs. A stage that passes 80 tool calls on one section is looping, not working, and
 * the run stops paying for it. Nothing here bounds how long the stage's reply may be —
 * the reply is not even the deliverable; the file it wrote is.
 */
const AGENT_DEFAULTS = Object.freeze({
  maxToolCalls: 80,
  workspaceMode: "project",
});

/** The section authoring and repair stages, on the acceptance tier. */
const AUTHOR_OPTIONS = Object.freeze({
  ...AGENT_DEFAULTS,
  modelRole: AUTHOR_MODEL_ROLE,
});

/** The draft stage, on the cheap tier. No stage names a concrete `provider/id`. */
const DRAFT_OPTIONS = Object.freeze({
  ...AGENT_DEFAULTS,
  modelRole: DRAFT_MODEL_ROLE,
});

const HOST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "excalidraw-pipeline.section-host.mjs");

/**
 * IDE-only type link: no runtime import is executed.
 * @param {import("../../runtime/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {unknown} input
 */
export default async function runWorkflow(dsl, input) {
  const { phase, log, projectRoot } = dsl;
  const invocation = readInvocation(typeof input === "string" ? input : "");
  if (invocation.reason !== undefined) {
    return refuse(invocation.reason, invocation.summary);
  }

  // Nothing here talks to a model. A missing generation package or renderer stops
  // the run before the first child session exists.
  phase("preflight");
  log("Checking the diagram generation package and the PNG renderer.");
  const preflight = await runPreflight();
  if (!preflight.ok) {
    return refuse(preflight.reason, preflight.summary);
  }
  log(`Generation package resolved; ${preflight.iconIds.length} icon ids available.`);

  return invocation.mode === "draft"
    ? runDraft(dsl, invocation, preflight, projectRoot())
    : runBuild(dsl, invocation, preflight, projectRoot());
}

// ---------------------------------------------------------------------------
// Run 1 — draft: free-form intent becomes one request file, then the run stops
// ---------------------------------------------------------------------------

async function runDraft(dsl, invocation, preflight, root) {
  const { agent, phase, log, promptFile } = dsl;
  const runDirectory = createRunDirectory(root, invocation.intent);
  const requestPath = path.join(runDirectory, "diagram-request.md");

  phase("draft-request");
  log(`Drafting the diagram request into ${path.relative(root, requestPath)}.`);

  let problems = [];
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const prompt = await promptFile("./resources/intent-to-draft.prompt.md", {
      OPERATOR_INTENT: invocation.intent,
      REQUEST_PATH: requestPath,
      MAX_SECTIONS: String(MAX_SECTIONS),
      ICON_IDS: preflight.iconIds.join(", "),
      PREVIOUS_PROBLEMS: problems.length === 0 ? "(first attempt — nothing to repair)" : problems.join("\n"),
    });
    await agent(prompt, { ...DRAFT_OPTIONS, label: `draft diagram request (attempt ${attempt + 1})` });

    const parsed = parseRequestFile(requestPath, { requireApproval: false });
    if (parsed.problems.length === 0) {
      log(`Request file accepted with ${parsed.request.sections.length} sections.`);
      return {
        ok: true,
        mode: "draft",
        requestPath,
        runDirectory,
        title: parsed.request.title,
        sections: parsed.request.sections.map((section) => section.id),
        summary: [
          `Diagram request written to ${requestPath}.`,
          "Edit it: change the sections, briefs, exports, and links until they describe the diagram you want.",
          'Then set `approved: yes` in that file and run this workflow again with `build "<that path>"`.',
        ].join(" "),
      };
    }
    problems = parsed.problems;
    log(`Request file rejected: ${problems.length} problems.`);
  }

  return refuse(
    "request-file-invalid",
    `The drafted request file at ${requestPath} still does not parse after a repair attempt: ${problems.join("; ")}`,
  );
}

// ---------------------------------------------------------------------------
// Run 2 — build: an approved request becomes section files, then one diagram
// ---------------------------------------------------------------------------

async function runBuild(dsl, invocation, preflight, root) {
  const { agent, phase, log, promptFile, pipeline } = dsl;

  phase("read-request");
  const requestPath = path.resolve(root, invocation.requestPath);
  if (!existsSync(requestPath)) {
    return refuse(
      "request-file-missing",
      `No diagram request file at ${requestPath}. Run this workflow in draft mode first, or pass the path it printed.`,
    );
  }
  const parsed = parseRequestFile(requestPath, { requireApproval: true });
  if (parsed.problems.length > 0) {
    return refuse(
      parsed.approved === false ? "request-not-approved" : "request-file-invalid",
      `The diagram request at ${requestPath} cannot start a build: ${parsed.problems.join("; ")}`,
    );
  }
  const request = parsed.request;
  const runDirectory = path.dirname(requestPath);
  const sectionsDirectory = path.join(runDirectory, "sections");
  const plansDirectory = path.join(runDirectory, "plans");
  mkdirSync(sectionsDirectory, { recursive: true });
  mkdirSync(plansDirectory, { recursive: true });
  log(`Approved request read: ${request.sections.length} sections, ${request.links.length} cross-section links.`);

  // Every path an agent will ever be told to write is decided here.
  const sections = request.sections.map((section) => ({
    ...section,
    sourcePath: path.join(sectionsDirectory, `${section.id}.section.mjs`),
    planPath: path.join(plansDirectory, `${section.id}.validate.json`),
  }));
  // A rebuild must not pass because an earlier run left a usable file behind:
  // "this run's agent wrote it" and "a file is there" are different claims.
  for (const section of sections) {
    rmSync(section.sourcePath, { force: true });
  }

  phase("author-sections");
  log(`Authoring ${sections.length} section sources, one agent session per section.`);

  const authorSection = async (section) => {
    const prompt = await promptFile("./resources/section-author.prompt.md", {
      DIAGRAM_TITLE: request.title,
      SECTION_ID: section.id,
      SECTION_TITLE: section.title,
      SECTION_BRIEF: section.brief,
      SECTION_EXPORTS: section.exports.join(", "),
      SECTION_PATH: section.sourcePath,
      ICON_IDS: preflight.iconIds.join(", "),
    });
    await agent(prompt, { ...AUTHOR_OPTIONS, label: `author section ${section.id}` });
    return section;
  };

  const validateSection = async (section) => {
    let problems = describeSectionFile(section) ?? (await runSectionValidation(section, preflight));
    for (let repair = 1; repair <= MAX_SECTION_REPAIRS && problems !== null; repair += 1) {
      log(`Section ${section.id} failed validation; repair ${repair} of ${MAX_SECTION_REPAIRS}.`);
      const prompt = await promptFile("./resources/section-repair.prompt.md", {
        SECTION_ID: section.id,
        SECTION_TITLE: section.title,
        SECTION_BRIEF: section.brief,
        SECTION_EXPORTS: section.exports.join(", "),
        SECTION_PATH: section.sourcePath,
        ICON_IDS: preflight.iconIds.join(", "),
        EXECUTION_ERRORS: problems.join("\n"),
      });
      await agent(prompt, { ...AUTHOR_OPTIONS, label: `repair section ${section.id} (${repair})` });
      problems = describeSectionFile(section) ?? (await runSectionValidation(section, preflight));
    }
    if (problems !== null) {
      // A thrown stage makes `pipeline()` reject after the barrier. The named
      // reason is preserved in the typed failure and reported below.
      throw new Error(`section ${section.id} still fails after ${MAX_SECTION_REPAIRS} repairs: ${problems.join("; ")}`);
    }
    log(`Section ${section.id} executes cleanly.`);
    return { id: section.id, sourcePath: section.sourcePath };
  };

  try {
    await pipeline(sections, authorSection, validateSection);
  } catch (error) {
    if (!error || error.code !== "WORKFLOW_GROUP_FAILURE") throw error;
    // Deliberate typed catch: turn the group envelope into a named reason. Both
    // `ok:false` and `partial:true` keep this a failed run.
    return {
      ok: false,
      partial: true,
      mode: "build",
      reason: "section-unrepairable",
      requestPath,
      summary: `${error.failed} of ${error.total} sections never produced an executable source file.`,
      failures: (error.failures ?? []).map((failure) => failure.message ?? String(failure)),
    };
  }

  phase("compose-render");
  log("Composing every section into one scene, checking diagram health, and rendering the PNG.");
  const excalidrawPath = path.join(runDirectory, "diagram.excalidraw");
  const pngPath = path.join(runDirectory, "diagram.png");
  const composePlanPath = path.join(plansDirectory, "compose.json");
  writeFileSync(
    composePlanPath,
    `${JSON.stringify(
      {
        mode: "compose",
        seed: 20260721,
        title: request.title,
        subtitle: request.subtitle,
        excalidrawPath,
        sections: sections.map((section) => ({
          id: section.id,
          title: section.title,
          sourcePath: section.sourcePath,
          exports: section.exports,
        })),
        links: request.links,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const composed = await runHost(composePlanPath, preflight);
  if (!composed.ok) {
    return {
      ok: false,
      mode: "build",
      reason: "diagram-rejected",
      requestPath,
      summary: `The composed diagram did not pass assertDiagramHealthy with zero warnings: ${composed.errors
        .map((entry) => entry.message)
        .join("; ")}`,
      errors: composed.errors,
    };
  }

  const rendered = await runProcess("excalidraw-render", ["--setup", excalidrawPath, pngPath], null);
  if (rendered.error !== undefined || rendered.status !== 0) {
    const detail = rendered.error?.message ?? (rendered.stderr || rendered.stdout || "").trim();
    return refuse("render-failed", `excalidraw-render did not produce a PNG: ${detail}`);
  }
  const pngBytes = existsSync(pngPath) ? statSync(pngPath).size : 0;
  if (pngBytes === 0) {
    return refuse("render-empty", `excalidraw-render reported success but ${pngPath} is missing or empty.`);
  }

  log(`Rendered ${pngBytes} bytes of PNG from ${composed.elements} elements.`);
  return {
    ok: true,
    mode: "build",
    requestPath,
    runDirectory,
    excalidrawPath,
    pngPath,
    pngBytes,
    elements: composed.elements,
    cards: composed.cards,
    edges: composed.edges,
    health: composed.health,
    sections: sections.map((section) => section.id),
    summary: `Diagram "${request.title}" built from ${sections.length} sections: ${excalidrawPath} and ${pngPath} (assertDiagramHealthy passed with zero warnings).`,
  };
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/** `draft <intent>` / `<intent>` start run 1; `build <path>` starts run 2. */
function readInvocation(raw) {
  const text = raw.trim();
  if (text === "") {
    return {
      reason: "empty-input",
      summary:
        "This workflow needs input: `draft <what the diagram should show>` or `build <path to diagram-request.md>`.",
    };
  }
  const [verb, ...rest] = text.split(/\s+/);
  const remainder = rest.join(" ").trim();
  if (verb.toLowerCase() === "build") {
    if (remainder === "") {
      return {
        reason: "build-without-request",
        summary: "`build` needs the path of the diagram request file the draft run wrote.",
      };
    }
    return { mode: "build", requestPath: stripQuotes(remainder) };
  }
  const intent = verb.toLowerCase() === "draft" ? remainder : text;
  if (intent === "") {
    return { reason: "draft-without-intent", summary: "`draft` needs one sentence describing the diagram." };
  }
  return { mode: "draft", intent };
}

function stripQuotes(value) {
  return value.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

function refuse(reason, summary) {
  return { ok: false, reason, summary };
}

// ---------------------------------------------------------------------------
// Preflight — deterministic, before any child agent session exists
// ---------------------------------------------------------------------------

/**
 * `@kroffske/excalidraw-diagrams` does not resolve inside this workspace and is
 * deliberately not a dependency of it. The preflight finds a module path where it
 * does resolve, proves it by asking the section host for the icon catalog, and
 * checks that the PNG renderer is on PATH.
 */
async function runPreflight() {
  const attempts = [];
  for (const nodePath of await nodePathCandidates()) {
    const probe = await runProcess(process.execPath, [HOST_PATH, "--icons"], nodePath);
    const result = readHostResult(probe);
    if (result?.ok === true && Array.isArray(result.iconIds) && result.iconIds.length > 0) {
      const renderer = await runProcess("excalidraw-render", ["--help"], null);
      if (renderer.error !== undefined || renderer.status !== 0) {
        return {
          ok: false,
          reason: "renderer-unavailable",
          summary:
            "`excalidraw-render` is not runnable on PATH, so no PNG could be produced. Install the excalidraw-diagrams package globally (`npm i -g @kroffske/excalidraw-diagrams`) and retry.",
        };
      }
      return { ok: true, nodePath, iconIds: result.iconIds };
    }
    attempts.push(`${nodePath ?? "(inherited NODE_PATH)"}: ${describeProbeFailure(probe, result)}`);
  }
  return {
    ok: false,
    reason: "generation-package-unavailable",
    summary: `@kroffske/excalidraw-diagrams could not be loaded from any candidate module path, so no diagram can be generated. Install it globally (\`npm i -g @kroffske/excalidraw-diagrams\`) and retry. Tried — ${attempts.join(" | ")}`,
  };
}

/** Ordered module roots to try: the inherited environment, then the global npm root. */
async function nodePathCandidates() {
  const candidates = [null];
  const globalRoot = await readGlobalNodeModules();
  if (globalRoot !== null) {
    candidates.push(process.env.NODE_PATH ? `${process.env.NODE_PATH}${path.delimiter}${globalRoot}` : globalRoot);
  }
  return candidates;
}

async function readGlobalNodeModules() {
  const probe = await runProcess("npm", ["root", "-g"], null);
  if (probe.error !== undefined || probe.status !== 0) return null;
  const root = probe.stdout.trim();
  return root !== "" && existsSync(root) ? root : null;
}

/**
 * Spawn one child and collect it without blocking the host event loop. The Pi host
 * is an interactive process; a synchronous spawn would freeze it for the seconds a
 * section execution or a PNG render takes.
 */
function runProcess(command, args, nodePath) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: nodePath === null ? process.env : { ...process.env, NODE_PATH: nodePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ error, status: null, stdout, stderr }));
    child.on("close", (status) => resolve({ error: undefined, status, stdout, stderr }));
  });
}

function describeProbeFailure(probe, result) {
  if (probe.error !== undefined) return probe.error.message;
  if (result === null) return (probe.stderr || probe.stdout || "no output").trim().split("\n").slice(-1)[0];
  return (result.errors ?? []).map((entry) => entry.message).join("; ") || "unknown failure";
}

// ---------------------------------------------------------------------------
// Section execution
// ---------------------------------------------------------------------------

/** Reports why the assigned file cannot be executed at all, or null when it can. */
function describeSectionFile(section) {
  if (!existsSync(section.sourcePath)) {
    return [`no file was written at ${section.sourcePath}; that exact path is the only accepted output`];
  }
  if (statSync(section.sourcePath).size === 0) {
    return [`the file at ${section.sourcePath} is empty`];
  }
  return null;
}

/** Executes one section on a throwaway scene and returns its hard errors, or null. */
async function runSectionValidation(section, preflight) {
  writeFileSync(
    section.planPath,
    `${JSON.stringify(
      {
        mode: "validate",
        sections: [{ id: section.id, title: section.title, sourcePath: section.sourcePath, exports: section.exports }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const result = await runHost(section.planPath, preflight);
  if (result.ok) return null;
  return result.errors.map((entry) => entry.message);
}

/** Runs the sibling section host as a separate process and reads its one JSON line. */
async function runHost(planPath, preflight) {
  const executed = await runProcess(process.execPath, [HOST_PATH, planPath], preflight.nodePath);
  const result = readHostResult(executed);
  if (result === null) {
    return {
      ok: false,
      errors: [
        {
          section: null,
          code: "host-unreadable",
          message: `the section host produced no result for ${planPath}: ${(executed.stderr || executed.stdout || "no output").trim()}`,
        },
      ],
    };
  }
  return { errors: [], ...result };
}

function readHostResult(child) {
  if (child.error !== undefined) return null;
  const lines = String(child.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run folder
// ---------------------------------------------------------------------------

/** One folder per draft run under the ignored `.tasks/` tree. */
function createRunDirectory(root, intent) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  const slug =
    intent
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "diagram";
  const directory = path.join(root, ".tasks", "excalidraw-pipeline", `${stamp}-${slug}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

// ---------------------------------------------------------------------------
// The request file — the contract between the two runs
// ---------------------------------------------------------------------------

const SECTION_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const EXPORT_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

/**
 * Reads and validates the human-editable request file. Everything it reports is a
 * named problem with the line that caused it; nothing here trusts a model's word
 * for the file being right.
 */
function parseRequestFile(requestPath, { requireApproval }) {
  const problems = [];
  let text;
  try {
    text = readFileSync(requestPath, "utf8");
  } catch (error) {
    return { problems: [`the request file could not be read: ${error instanceof Error ? error.message : error}`] };
  }
  if (text.trim() === "") {
    return { problems: ["the request file is empty"] };
  }

  const header = {};
  const sections = [];
  const links = [];
  let approved = false;
  let current = null;
  let mode = "header";

  const lines = text.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.replace(/^\s*[-*]\s+/, "").trim();
    if (line === "" || line === "# Diagram request" || line.startsWith("<!--")) continue;

    const sectionHeading = /^##\s+section\s+(.+)$/i.exec(line);
    if (sectionHeading) {
      const [id, ...titleParts] = sectionHeading[1].split(/\s*(?:—|--|–|:|\|)\s*/);
      current = {
        id: id.trim().toLowerCase(),
        title: titleParts.join(" ").trim(),
        exports: [],
        brief: "",
        line: lineNumber,
      };
      sections.push(current);
      mode = "section";
      continue;
    }
    if (/^##\s+links\s*$/i.test(line)) {
      current = null;
      mode = "links";
      continue;
    }
    if (line.startsWith("#")) continue;

    if (mode === "links") {
      const link = /^(\S+)\s*->\s*([^:]+?)(?:\s*:\s*(.*))?$/.exec(line);
      if (!link) {
        problems.push(`line ${lineNumber}: a link must read \`section.export -> section.export : label\``);
        continue;
      }
      links.push({ from: link[1].trim(), to: link[2].trim(), label: (link[3] ?? "").trim(), line: lineNumber });
      continue;
    }

    const field = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/.exec(line);
    if (mode === "header") {
      if (!field) continue;
      header[field[1].toLowerCase()] = field[2].trim();
      continue;
    }
    if (field && ["title", "exports", "brief"].includes(field[1].toLowerCase())) {
      const key = field[1].toLowerCase();
      if (key === "title") current.title = field[2].trim();
      if (key === "exports") current.exports = splitList(field[2]);
      if (key === "brief") current.brief = field[2].trim();
      continue;
    }
    // Any other prose inside a section belongs to its brief.
    current.brief = current.brief === "" ? line : `${current.brief} ${line}`;
  }

  const approvalValue = (header.approved ?? "").toLowerCase();
  approved = approvalValue === "yes" || approvalValue === "true" || approvalValue === "approved";
  if (requireApproval && !approved) {
    problems.push(
      approvalValue === ""
        ? "the file carries no `approved:` line, so it was never reviewed by a human"
        : `the file says \`approved: ${approvalValue}\`; set it to \`approved: yes\` once the request is right`,
    );
  }
  if ((header.title ?? "") === "") problems.push("the file carries no `title:` line");
  if (sections.length === 0) problems.push("the file declares no `## Section <id> — <title>` block");
  if (sections.length > MAX_SECTIONS) {
    problems.push(`the file declares ${sections.length} sections; this pipeline builds at most ${MAX_SECTIONS}`);
  }

  const seen = new Set();
  for (const section of sections) {
    if (!SECTION_ID_PATTERN.test(section.id)) {
      problems.push(`line ${section.line}: section id "${section.id}" must be lowercase letters, digits, and dashes`);
    }
    if (seen.has(section.id)) problems.push(`line ${section.line}: section id "${section.id}" is declared twice`);
    seen.add(section.id);
    if (section.title === "") problems.push(`line ${section.line}: section "${section.id}" has no title`);
    if (section.brief === "") problems.push(`line ${section.line}: section "${section.id}" has no brief`);
    if (section.exports.length === 0) {
      problems.push(`line ${section.line}: section "${section.id}" declares no exports`);
    }
    for (const name of section.exports) {
      if (!EXPORT_NAME_PATTERN.test(name)) {
        problems.push(`line ${section.line}: export "${name}" in "${section.id}" must be a lowerCamelCase name`);
      }
    }
  }

  const exportKeys = new Set(sections.flatMap((section) => section.exports.map((name) => `${section.id}.${name}`)));
  for (const link of links) {
    for (const endpoint of [link.from, link.to]) {
      if (!exportKeys.has(endpoint)) {
        problems.push(`line ${link.line}: link endpoint "${endpoint}" is not an export any section declares`);
      }
    }
  }

  return {
    problems,
    approved,
    request: {
      title: header.title ?? "",
      subtitle: header.subtitle ?? "",
      sections: sections.map(({ id, title, exports, brief }) => ({ id, title, exports, brief })),
      links: links.map(({ from, to, label }) => ({ from, to, label })),
    },
  };
}

function splitList(value) {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
