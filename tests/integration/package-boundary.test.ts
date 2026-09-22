import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { packagedWorkflowNames } from "../../extensions/workflows/runtime/workflow-discovery.js";
import { verifyInstalledWorkflowDocs } from "../docs/helpers/installed-workflow-docs.js";
import { deadMarkdownLinks } from "../../scripts/markdown-links.js";

interface PackageJson {
  name: string;
  files: string[];
  bin?: Record<string, string>;
  pi: { extensions: string[]; skills: string[] };
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;

function recursiveTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return recursiveTypeScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}
/**
 * The Package registry is the examples directory itself, so this list is not the
 * registry — it is the reviewed snapshot of what that directory currently holds.
 * A file added or removed there fails here on purpose: adding a Package workflow
 * is cheap, but it is still a public-surface change somebody has to look at.
 */
const EXPECTED_PACKAGE_WORKFLOW_NAMES = [
  "live-smoke",
  "task/draft",
  "task/plan",
  "post-code-review",
  "post-code-review/boundaries",
  "post-code-review/contracts",
  "post-code-review/necessity",
  "post-code-review/scope",
  "post-code-review/simplicity",
  "post-code-review/style",
  "post-code-review/synthesis",
  "stage-loop",
] as const;

const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;
const PACKAGE_WORKFLOW_PATHS = {
  "live-smoke": "extensions/workflows/examples/live-smoke/live-smoke.workflow.mjs",
  "task/draft": "extensions/workflows/examples/task/draft.workflow.mjs",
  "task/plan": "extensions/workflows/examples/task/plan.workflow.mjs",
  "post-code-review": "extensions/workflows/examples/post-code-review/post-code-review.workflow.mjs",
  "post-code-review/boundaries": "extensions/workflows/examples/post-code-review/boundaries.workflow.mjs",
  "post-code-review/contracts": "extensions/workflows/examples/post-code-review/contracts.workflow.mjs",
  "post-code-review/necessity": "extensions/workflows/examples/post-code-review/necessity.workflow.mjs",
  "post-code-review/scope": "extensions/workflows/examples/post-code-review/scope.workflow.mjs",
  "post-code-review/simplicity": "extensions/workflows/examples/post-code-review/simplicity.workflow.mjs",
  "post-code-review/style": "extensions/workflows/examples/post-code-review/style.workflow.mjs",
  "post-code-review/synthesis": "extensions/workflows/examples/post-code-review/synthesis.workflow.mjs",
  "stage-loop": "extensions/workflows/examples/stage-loop/stage-loop.workflow.mjs",
} as const;

function installedStandardSource(run: string, declarations = ""): string {
  return [
    'export const meta = { name: "installed-probe", profile: "standard", description: "Installed probe." };',
    declarations,
    run,
  ]
    .filter(Boolean)
    .join("\n");
}

const CLOSED_GRAMMAR_PROBES = [
  {
    name: "named-process-outer-ambient",
    source: installedStandardSource(
      'export default async function run({ agent, parallel }) { await parallel(KNOWN.map(function process(item) { return () => agent(item); })); if (process.env.DEPLOY === "yes") return agent("Deploy"); return agent("Hold"); }',
      'const KNOWN = ["one"];',
    ),
  },
  {
    name: "named-buffer-outer-ambient",
    source: installedStandardSource(
      'export default async function run({ agent, parallel }) { await parallel(KNOWN.map(function Buffer(item) { return () => agent(item); })); if (Buffer.poolSize > 0) return agent("Deploy"); return agent("Hold"); }',
      'const KNOWN = ["one"];',
    ),
  },
  {
    name: "named-callback-inner-scope",
    source: installedStandardSource(
      "export default function run({ agent, parallel }) { return parallel(KNOWN.map(function process(item) { if (process) return () => agent(item); return () => agent(item); })); }",
      'const KNOWN = ["one"];',
    ),
  },
  {
    name: "sequence-opaque-scalar",
    source: installedStandardSource(
      'export default async function run({ agent }, input) { const answer = (0, await agent(input)); if (answer === "deploy") return agent("Deploy"); return agent("Hold"); }',
    ),
  },
  {
    name: "sequence-opaque-array",
    source: installedStandardSource(
      'export default async function run({ agent }, input) { const copied = [(0, await agent(input))]; if (copied[0] === "deploy") return agent("Deploy"); return agent("Hold"); }',
    ),
  },
  {
    name: "sequence-opaque-object",
    source: installedStandardSource(
      'export default async function run({ agent }, input) { const box = { value: (0, await agent(input)) }; if (box.value === "deploy") return agent("Deploy"); return agent("Hold"); }',
    ),
  },
  {
    name: "sequence-nested-composite",
    source: installedStandardSource(
      'export default async function run({ agent }, input) { const copied = ((["known"]), [await agent(input)]); if (copied[0] === "deploy") return agent("Deploy"); return agent("Hold"); }',
    ),
  },
  {
    name: "sequence-literals",
    source: installedStandardSource(
      'export default function run({ agent }) { const known = (1, 2); if (known === 2) return agent("Deploy"); return agent("Hold"); }',
    ),
  },
  {
    name: "error-opaque-scalar",
    source: installedStandardSource(
      "export default async function run({ agent }, input) { return new Error(await agent(input)); }",
    ),
  },
  {
    name: "error-message-inspection",
    source: installedStandardSource(
      'export default async function run({ agent }, input) { const answer = new Error(await agent(input)); if (answer.message === "deploy") return agent("Deploy"); return agent("Hold"); }',
    ),
  },
  {
    name: "error-array-spread",
    source: installedStandardSource(
      'export default function run({ items }) { throw new Error("stop", { cause: [...items()] }); }',
    ),
  },
  {
    name: "error-nested-options",
    source: installedStandardSource(
      'export default async function run({ agent }, input) { throw new Error("stop", { cause: { details: [await agent(input)] } }); }',
    ),
  },
  {
    name: "error-member-extraction",
    source: installedStandardSource(
      "export default async function run({ agent }, input) { const answer = await agent(input); throw new Error(answer.message); }",
    ),
  },
] as const;

const LITERAL_ERROR_PROBE = {
  name: "error-literal-control",
  source: installedStandardSource('export default function run() { throw new Error("stop"); }'),
} as const;

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
    call: 'dsl.invokeWorkflow({ name: "child", key: "one", keys: ["one"], outputDir: dsl.outputDir() })',
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

function installedDslReturnSource(call: string, body: string): string {
  return installedStandardSource(`export default async function run(dsl) {
  const value = await ${call};
  ${body}
}`);
}

const DSL_RETURN_PROVENANCE_PROBES = [
  ...STANDARD_DSL_RETURN_CASES.filter(({ category }) => category !== "void").flatMap(({ method, call }) => [
    { accepted: true, name: `dsl-${method}-whole-return`, source: installedDslReturnSource(call, "return value;") },
    {
      accepted: false,
      name: `dsl-${method}-branch`,
      source: installedDslReturnSource(call, 'if (value) return dsl.agent("yes"); return dsl.agent("no");'),
    },
    {
      accepted: false,
      name: `dsl-${method}-member`,
      source: installedDslReturnSource(call, "return value.detail;"),
    },
    {
      accepted: false,
      name: `dsl-${method}-error`,
      source: installedDslReturnSource(call, 'throw new Error("stop", { cause: [value] });'),
    },
  ]),
  ...STANDARD_DSL_RETURN_CASES.filter(({ category }) => category === "void").flatMap(({ method, call }) => [
    {
      accepted: true,
      name: `dsl-${method}-discarded`,
      source: installedStandardSource(`export default async function run(dsl) { await ${call}; return true; }`),
    },
    {
      accepted: false,
      name: `dsl-${method}-value`,
      source: installedDslReturnSource(call, "return value;"),
    },
  ]),
  ...STANDARD_DSL_RETURN_CASES.filter(({ category }) => category === "list").map(({ method, call }) => ({
    accepted: true,
    name: `dsl-${method}-length-control`,
    source: installedDslReturnSource(call, 'if (value.length === 0) dsl.log("empty"); return value;'),
  })),
  {
    accepted: true,
    name: "dsl-choice-status-controls",
    source: installedStandardSource(
      'export default async function run(dsl) { const route = await dsl.agent("route", { choice: ["yes", "no"] }); if (route === "yes") dsl.log(route); const child = await dsl.invokeWorkflow({ name: "child", key: "one", keys: ["one"], outputDir: dsl.outputDir() }); if (child.status === "completed") return route; return child.status; }',
    ),
  },
  {
    accepted: true,
    name: "dsl-bound-output-dir-scheduling",
    source: installedStandardSource(
      'export default async function run(dsl) { const stableOutputDir = dsl.outputDir(); return dsl.invokeWorkflow({ name: "child", key: "one", keys: ["one"], outputDir: stableOutputDir }); }',
    ),
  },
] as const;

const forbiddenPackedPaths = [
  /^\.agents\/(skills|workflows)\//,
  /^\.(locus|tasks|planning|pi)\//,
  /^(artifacts|benchmarks|catalog|eval|evaluation|evaluations|output|scripts|tests)\//,
  /^docs\/(archive|extension-gallery|reports|system-design)\//,
  /^docs\/source-audit\//,
  /^extensions\/beta\//,
  /^bin\/pi-live-terminal$/,
  /^STATUS\.md$/,
];

let dryRun: PackResult;

beforeAll(() => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  });
  const [result] = JSON.parse(output) as PackResult[];
  if (!result) throw new Error("npm pack --dry-run returned no package result");
  dryRun = result;
});

describe("npm public package boundary", () => {
  it("keeps the .locus-pi storage prefix owned by workflow-run-layout", () => {
    const owner = path.join(root, "extensions", "workflows", "runtime", "workflow-run-layout.ts");
    const presentation = path.join(root, "extensions", "workflows", "tool", "workflow-tool.ts");
    const violations: string[] = [];
    for (const file of recursiveTypeScriptFiles(path.join(root, "extensions"))) {
      if (file === owner || file === presentation) continue;
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        const ownsPrefix =
          (ts.isStringLiteralLike(node) && node.text.includes(".locus-pi/")) ||
          (ts.isTemplateExpression(node) && node.getText(sourceFile).includes(".locus-pi/"));
        if (ownsPrefix) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${path.relative(root, file)}:${line}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(violations).toEqual([]);
  });

  it("keeps an open Pi peer floor and one exact tested development baseline", () => {
    const testedVersions = new Set(PI_PACKAGES.map((packageName) => pkg.devDependencies[packageName]));
    expect(testedVersions.size).toBe(1);
    const testedVersion = [...testedVersions][0]!;
    expect(testedVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    for (const packageName of PI_PACKAGES) {
      const peerRange = pkg.peerDependencies[packageName]!;
      expect(peerRange, `${packageName} peer floor`).toBe(">=0.83.0");
      expect(pkg.devDependencies[packageName], `${packageName} development pin`).toBe(testedVersion);
      expect(supportsPiVersion(peerRange, testedVersion)).toBe(true);
      expect(supportsPiVersion(peerRange, "999.0.0")).toBe(true);
      expect(supportsPiVersion(peerRange, "0.82.999")).toBe(false);
    }
  });

  it("keeps the package allowlist directory-owned and compact", () => {
    expect(pkg.files).toEqual([
      "dist/public-catalogs.json",
      "docs/",
      "extensions/",
      "!extensions/workflows/references/consilium/",
      "!extensions/workflows/references/excalidraw-pipeline/",
      "schemas/extension-manifest.schema.json",
      "skills/",
    ]);
    // Directory-owned means the dotfiles inside a listed directory ship with it:
    // `skills/.ignore` rides along under `skills/` and is counted here.
    expect(dryRun.files).toHaveLength(258);
  });

  it("ships every prompt resource a curated workflow renders", () => {
    const packedPaths = new Set(dryRun.files.map((file) => file.path));

    for (const [name, workflowPath] of Object.entries(PACKAGE_WORKFLOW_PATHS)) {
      const source = readFileSync(path.join(root, workflowPath), "utf8");
      const directory = path.posix.dirname(workflowPath);
      for (const match of source.matchAll(/promptFile\(\s*"(\.\/[^"]+\.prompt\.md)"/gu)) {
        const resource = path.posix.normalize(path.posix.join(directory, match[1]!));
        expect(existsSync(path.join(root, resource)), `${name} renders a missing prompt: ${resource}`).toBe(true);
        expect(packedPaths.has(resource), `${name} renders an unpacked prompt: ${resource}`).toBe(true);
      }
    }
  });

  it("ships six active entrypoints, their manifests, and complete local imports", () => {
    const packedPaths = new Set(dryRun.files.map((file) => file.path));
    expect(pkg.pi.extensions).toHaveLength(6);

    for (const entrypoint of pkg.pi.extensions) {
      const normalizedEntrypoint = entrypoint.replace(/^\.\//, "");
      const manifest = path.posix.join(path.posix.dirname(normalizedEntrypoint), "manifest.json");
      expect(packedPaths.has(normalizedEntrypoint), `missing active entrypoint: ${normalizedEntrypoint}`).toBe(true);
      expect(packedPaths.has(manifest), `missing active manifest: ${manifest}`).toBe(true);
    }

    for (const localImport of localImportClosure(pkg.pi.extensions)) {
      expect(packedPaths.has(localImport), `missing transitive local import: ${localImport}`).toBe(true);
    }
  });

  it("packs exactly the workflows the examples directory resolves, and no forbidden paths", () => {
    const packedPaths = dryRun.files.map((file) => file.path);
    const packedWorkflowNames = packedPaths
      .filter((file) => file.startsWith("extensions/workflows/examples/") && file.endsWith(".workflow.mjs"))
      .map((file) => {
        const stem = path.basename(file, ".workflow.mjs");
        const rootName = path.basename(path.dirname(file));
        return stem === rootName ? rootName : `${rootName}/${stem}`;
      })
      .sort();

    // The load-bearing assertion of the scanned registry: what a checkout
    // resolves by name and what an install ships must be the same set. A
    // workflow present here and missing from `package.json#files` would work in
    // this repository and be gone after `npm i`, which is the one way "the
    // folder is the registry" could lie to an operator.
    expect(packedWorkflowNames).toEqual(packagedWorkflowNames().sort());
    expect(packagedWorkflowNames().sort()).toEqual([...EXPECTED_PACKAGE_WORKFLOW_NAMES].sort());
    expect(packedPaths.filter((file) => forbiddenPackedPaths.some((pattern) => pattern.test(file)))).toEqual([]);
    expect(pkg.bin).toBeUndefined();
  });

  it("keeps every pattern-catalog link resolvable inside the installed package", () => {
    // The catalog is the one `references/` file an install ships (OD3, T-130: the
    // consilium reference stays tracked in this repository and runs by path, exactly like
    // `excalidraw-pipeline`). So a relative link from the catalog into a sibling under
    // `references/` renders as a link in the npm tarball and resolves to nothing — for a
    // reader who has only the tarball, which is the audience the catalog exists for.
    // Naming the repository path in prose is the shape that stays honest in both places.
    const packedPaths = new Set(dryRun.files.map((file) => file.path));
    const catalog = "extensions/workflows/references/patterns.md";
    expect(packedPaths.has(catalog)).toBe(true);
    const directory = path.posix.dirname(catalog);
    const unresolvable: string[] = [];
    for (const match of readFileSync(path.join(root, catalog), "utf8").matchAll(/\]\((\.[^)\s#]+)\)/gu)) {
      const target = path.posix.normalize(path.posix.join(directory, match[1]!));
      if (!packedPaths.has(target)) unresolvable.push(`${match[1]!} → ${target}`);
    }
    expect(unresolvable).toEqual([]);
  });

  it("ships every declared skill, and every document a skill sends the reader to", () => {
    const packedPaths = new Set(dryRun.files.map((file) => file.path));

    // Pi discovers package skills from `pi.skills`, so an install that ships the
    // file without the declaration teaches nobody anything, and a declaration
    // without the file is an empty promise in the system prompt.
    expect(pkg.pi.skills).toEqual(["./skills"]);

    // The host loads root `.md` files under a skills directory as skills too, and
    // honours `.gitignore`/`.ignore`/`.fdignore` while scanning. `skills/README.md`
    // is documentation with no frontmatter, so without this file shipping, every
    // install warns about an invalid skill at startup.
    expect(packedPaths.has("skills/.ignore"), "the skills-scan ignore file is unpacked").toBe(true);
    expect(readFileSync(path.join(root, "skills", ".ignore"), "utf8").trim()).toBe("README.md");

    const skillEntries = readdirSync(path.join(root, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `skills/${entry.name}/SKILL.md`)
      .sort();
    expect(skillEntries).toHaveLength(3);

    for (const skillPath of skillEntries) {
      expect(existsSync(path.join(root, skillPath)), `declared skill is missing: ${skillPath}`).toBe(true);
      expect(packedPaths.has(skillPath), `unpacked skill: ${skillPath}`).toBe(true);

      const source = readFileSync(path.join(root, skillPath), "utf8");
      expect(source.startsWith("---\n"), `${skillPath} has no frontmatter`).toBe(true);
      const frontmatter = source.slice(4, source.indexOf("\n---\n", 3));
      expect(/^name:\s*\S+/mu.test(frontmatter), `${skillPath} declares no name`).toBe(true);
      expect(/^description:\s*\S+/mu.test(frontmatter), `${skillPath} declares no description`).toBe(true);

      // A skill is read from inside the installed package, so a pointer that
      // resolves in this checkout and not in the tarball sends the reader —
      // usually a weak model that came here precisely because it was lost — to
      // a file that does not exist on their machine.
      const directory = path.posix.dirname(skillPath);
      for (const match of source.matchAll(/`(\.\.\/[^`\s]+\.md)`/gu)) {
        const target = path.posix.normalize(path.posix.join(directory, match[1]!));
        expect(existsSync(path.join(root, target)), `${skillPath} points at a missing file: ${target}`).toBe(true);
        expect(packedPaths.has(target), `${skillPath} points at an unpacked file: ${target}`).toBe(true);
      }
    }
  });

  it("ships the editable draft to concrete workflow.mjs protocol", () => {
    const packedPaths = new Set(dryRun.files.map((file) => file.path));
    const draftPath = "extensions/workflows/examples/task/draft.workflow.mjs";
    const planPath = "extensions/workflows/examples/task/plan.workflow.mjs";
    const draft = readFileSync(path.join(root, draftPath), "utf8");
    const plan = readFileSync(path.join(root, planPath), "utf8");

    expect(packedPaths.has(draftPath)).toBe(true);
    expect(packedPaths.has(planPath)).toBe(true);
    expect(draft).toContain("Workflow direction:");
    expect(draft).toContain("Reflection/review:");
    expect(plan).toContain('publishPrimaryFile("workflow.mjs")');
    expect(plan).toContain('reason: "queue_conflict"');
    expect(plan).not.toContain('publishPrimaryArtifact("workflow.mjs"');
    expect(packedPaths.has("skills/locus-pi-workflow-implement-task/SKILL.md")).toBe(false);
  });

  it("ships the public environment-variable reference", () => {
    const packedPaths = new Set(dryRun.files.map((file) => file.path));
    expect(packedPaths.has("docs/environment-variables.md")).toBe(true);
  });

  it("keeps every relative link in a packed Markdown file resolvable inside the installed package", () => {
    const packedPaths = new Set(dryRun.files.map((file) => file.path));

    // Packed documentation is read from inside `node_modules`, where the
    // repository around it does not exist. A relative link that resolves in this
    // checkout and not in the tarball is dead for everyone who installed the
    // package, and they cannot tell a broken link from a document we forgot to
    // ship. A link to a directory counts as dead too: the packed result contains
    // files, and a folder is not a document a reader can open.
    //
    // Three fixes are legitimate: retarget the link at a file that is already
    // packed, demote it to a backticked repository path that admits the target
    // is repository-only, or drop it. Adding the target to `package.json#files`
    // is an owner decision about public surface, not a way to quiet this test.
    //
    // The parser is `scripts/markdown-links.ts`. This test reads the npm surface
    // off a real pack, so the two disagree exactly when the allowlist lies.
    expect(deadMarkdownLinks(root, { name: "the npm package", files: packedPaths })).toEqual([]);
  });

  it("loads every declared entrypoint and workflow documentation from an unpacked real tarball", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-pack-boundary-"));
    try {
      const packOutput = execFileSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot],
        { cwd: root, encoding: "utf8" },
      );
      const [packed] = JSON.parse(packOutput) as PackResult[];
      if (!packed) throw new Error("npm pack returned no package result");
      const unpackRoot = path.join(temporaryRoot, "unpacked");
      mkdirSync(unpackRoot);
      execFileSync("tar", ["-xzf", path.join(temporaryRoot, packed.filename), "-C", unpackRoot]);

      const packageRoot = path.join(unpackRoot, "package");
      verifyInstalledWorkflowDocs(
        packageRoot,
        temporaryRoot,
        packed.files.map((file) => file.path),
      );
      symlinkSync(path.join(root, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
      const entrypointUrls = pkg.pi.extensions.map(
        (entrypoint) => pathToFileURL(path.join(packageRoot, entrypoint)).href,
      );
      const workflowUrls = EXPECTED_PACKAGE_WORKFLOW_NAMES.map((name) => ({
        name,
        url: pathToFileURL(path.join(packageRoot, PACKAGE_WORKFLOW_PATHS[name])).href,
      }));
      const loadScript = `for (const url of ${JSON.stringify(entrypointUrls)}) {
        const loaded = await import(url);
        if (typeof loaded.default !== "function") throw new Error(\`Missing default extension export: \${url}\`);
      }
      for (const workflow of ${JSON.stringify(workflowUrls)}) {
        const loaded = await import(workflow.url);
        if (typeof loaded.default !== "function") throw new Error(\`Missing workflow export: \${workflow.url}\`);
        if (loaded.meta?.name !== workflow.name) throw new Error(\`Wrong workflow name: \${workflow.url}\`);
      }`;

      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", loadScript], {
        cwd: packageRoot,
        encoding: "utf8",
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs the Pi-native source checker from a real consumer install", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-installed-checker-"));
    try {
      const packOutput = execFileSync("npm", ["pack", "--silent", "--json", "--pack-destination", temporaryRoot], {
        cwd: root,
        encoding: "utf8",
      });
      const [packed] = JSON.parse(packOutput) as PackResult[];
      if (!packed) throw new Error("npm pack returned no package result");

      const consumerRoot = path.join(temporaryRoot, "consumer-project");
      const workflowDirectory = path.join(consumerRoot, ".locus-pi", "workflows");
      mkdirSync(workflowDirectory, { recursive: true });
      writeFileSync(path.join(consumerRoot, "package.json"), '{"private":true,"type":"module"}\n');
      writeFileSync(
        path.join(workflowDirectory, "consumer.workflow.mjs"),
        readFileSync(path.join(root, PACKAGE_WORKFLOW_PATHS["live-smoke"]), "utf8"),
      );
      execFileSync(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--legacy-peer-deps",
          path.join(temporaryRoot, packed.filename),
        ],
        { cwd: consumerRoot, encoding: "utf8" },
      );
      const installedMatrix = [
        {
          accepted: true,
          name: "runtime-choice-index",
          source: installedStandardSource(
            'export default async function run({ agent }) { return agent(ROUTES[await agent("Route?", { choice: ["deploy", "hold"] })]); }',
            'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
          ),
        },
        {
          accepted: true,
          name: "pipeline-forwarding",
          source: installedStandardSource(
            'export default function run({ agent, pipeline }) { return pipeline(["one"], (item, itemIndex) => agent(`${itemIndex}: ${item}`)); }',
          ),
        },
        {
          accepted: true,
          name: "bound-opaque-for-of-forwarding",
          source: installedStandardSource(
            "export default async function run({ agent, items }) { const workItems = items(); for (const workItem of workItems) await agent(`Handle: ${workItem}`); return true; }",
          ),
        },
        { ...LITERAL_ERROR_PROBE, accepted: true as const },
        {
          accepted: false,
          name: "pipeline-item-branch",
          source: installedStandardSource(
            'export default function run({ agent, items, pipeline }) { return pipeline(items(), (item) => agent(item === "deploy" ? "Deploy" : "Hold")); }',
          ),
        },
        {
          accepted: false,
          name: "pipeline-later-stage-measurement",
          source: installedStandardSource(
            'export default function run({ agent, pipeline }) { return pipeline(["one"], (item) => agent(item), (draft) => agent(draft.length > 10 ? "short" : "long")); }',
          ),
        },
        {
          accepted: false,
          name: "map-whole-array-branch",
          source: installedStandardSource(
            'export default function run({ agent, items, parallel }) { const list = items(); return parallel(list.map((item, itemIndex, allItems) => () => agent(allItems[0] === "deploy" ? item : `${itemIndex}`))); }',
          ),
        },
        {
          accepted: false,
          name: "identity-map-laundering",
          source: installedStandardSource(
            'export default function run({ agent, items }) { const clean = items().map((item) => { return item; }); for (const candidate of clean) { if (candidate === "deploy") return agent("Deploy"); } return agent("Hold"); }',
          ),
        },
        {
          accepted: false,
          name: "direct-opaque-index",
          source: installedStandardSource(
            "export default async function run({ agent }, input) { return agent(ROUTES[await agent(input)]); }",
            'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
          ),
        },
        {
          accepted: false,
          name: "switch-outer-opaque",
          source: installedStandardSource(
            'export default function run({ agent, log }, input) { switch ("local") { case "local": const input = "local"; log(input); break; default: break; } if (input === "deploy") return agent("Deploy"); return input; }',
          ),
        },
        {
          accepted: false,
          name: "arguments-run-input",
          source: installedStandardSource(
            'export default function run({ agent }, input) { if (arguments[1] === "deploy") return agent("Deploy"); return agent(input); }',
          ),
        },
        {
          accepted: false,
          name: "arguments-map-item",
          source: installedStandardSource(
            'export default function run({ agent, items, parallel }) { return parallel(items().map(function () { return () => agent(arguments[0] === "deploy" ? "Deploy" : "Hold"); })); }',
          ),
        },
        {
          accepted: false,
          name: "arguments-map-index",
          source: installedStandardSource(
            'export default function run({ agent, items, parallel }) { return parallel(items().map(function () { return () => agent(arguments[1] > 0 ? "Later" : "First"); })); }',
          ),
        },
        {
          accepted: false,
          name: "arguments-map-array",
          source: installedStandardSource(
            'export default function run({ agent, items, parallel }) { return parallel(items().map(function () { return () => agent(arguments[2][0] === "deploy" ? "Deploy" : "Hold"); })); }',
          ),
        },
        {
          accepted: false,
          name: "arguments-pipeline-value",
          source: installedStandardSource(
            'export default function run({ agent, items, pipeline }) { return pipeline(items(), function () { return agent(arguments[0] === "deploy" ? "Deploy" : "Hold"); }); }',
          ),
        },
        {
          accepted: false,
          name: "composite-spread-laundering",
          source: installedStandardSource(
            'export default function run({ agent, items }) { const copied = [...items()]; for (const candidate of copied) if (candidate === "deploy") return agent("Deploy"); return agent("Hold"); }',
          ),
        },
        {
          accepted: false,
          name: "composite-object-laundering",
          source: installedStandardSource(
            'export default async function run({ agent }, input) { const box = { value: await agent(input) }; if (box.value === "deploy") return agent("Deploy"); return agent("Hold"); }',
          ),
        },
        {
          accepted: false,
          name: "ambient-process",
          source: installedStandardSource(
            'export default function run({ agent }) { if (process.env.DEPLOY === "yes") return agent("Deploy"); return agent("Hold"); }',
          ),
        },
        {
          accepted: false,
          name: "ambient-arbitrary",
          source: installedStandardSource(
            'export default function run({ agent }) { return mystery === "deploy" ? agent("Deploy") : agent("Hold"); }',
          ),
        },
        ...CLOSED_GRAMMAR_PROBES.map((probe) => ({ ...probe, accepted: false as const })),
        ...DSL_RETURN_PROVENANCE_PROBES,
      ] as const;
      const checks = installedMatrix.map((probe) => {
        const probePath = path.join(workflowDirectory, `${probe.name}.workflow.mjs`);
        writeFileSync(probePath, probe.source);
        return { name: probe.name, path: path.relative(consumerRoot, probePath), accepted: probe.accepted };
      });
      checks.unshift({ name: "consumer", path: ".locus-pi/workflows/consumer.workflow.mjs", accepted: true });

      const toolUrl = pathToFileURL(
        path.join(
          consumerRoot,
          "node_modules",
          ...pkg.name.split("/"),
          "extensions",
          "workflows",
          "tool",
          "workflow-source-check-tool.ts",
        ),
      ).href;
      const probeScript = `
        const { registerWorkflowSourceCheckTool } = await import(${JSON.stringify(toolUrl)});
        let tool;
        registerWorkflowSourceCheckTool({ registerTool(value) { tool = value; }, on() {} });
        if (!tool) throw new Error("workflow_check_source was not registered");
        const ctx = {
          cwd: ${JSON.stringify(consumerRoot)},
          session: { projectRoot: ${JSON.stringify(consumerRoot)}, workingDirectory: ${JSON.stringify(consumerRoot)} },
        };
        const results = [];
        for (const check of ${JSON.stringify(checks)}) {
          const result = await tool.execute("installed-probe", { path: check.path }, new AbortController().signal, () => {}, ctx);
          results.push({ name: check.name, accepted: check.accepted, passed: result.isError !== true });
        }
        process.stdout.write(JSON.stringify(results));
      `;
      const results = JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", probeScript], {
          cwd: root,
          encoding: "utf8",
        }),
      ) as Array<{ name: string; accepted: boolean; passed: boolean }>;
      for (const result of results) expect(result.passed, result.name).toBe(result.accepted);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

function supportsPiVersion(range: string, version: string): boolean {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(range);
  if (match === null) return false;
  const floor = match.slice(1).map((part) => Number(part));
  const candidate = version
    .split("-", 1)[0]!
    .split(".")
    .map((part) => Number(part));
  if (floor.length !== 3 || candidate.length !== 3 || candidate.some((part) => !Number.isSafeInteger(part)))
    return false;
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index]! > floor[index]!) return true;
    if (candidate[index]! < floor[index]!) return false;
  }
  return true;
}

function localImportClosure(entrypoints: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = entrypoints.map((entrypoint) => path.resolve(root, entrypoint));

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, "utf8");
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (!imported.fileName.startsWith(".")) continue;
      const resolved = resolveLocalImport(file, imported.fileName);
      if (!resolved) throw new Error(`Unresolved local import from ${path.relative(root, file)}: ${imported.fileName}`);
      if (!seen.has(resolved)) pending.push(resolved);
    }
  }

  return [...seen].map((file) => path.relative(root, file).split(path.sep).join("/")).sort();
}

function resolveLocalImport(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.mjs$/, ".mts"),
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
