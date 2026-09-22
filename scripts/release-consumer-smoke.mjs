import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function workflowFileHashes(directory) {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filename = path.join(entry.parentPath, entry.name);
        return [
          path.relative(directory, filename).split(path.sep).join("/"),
          createHash("sha256").update(readFileSync(filename)).digest("hex"),
        ];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function verifyInstalledWorkflows(packageRoot, expected, projectRoot) {
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = piRequire("jiti");
  const jiti = createJiti(import.meta.url);
  const { packagedExamplesDir, packagedWorkflowNames, resolveWorkflowTarget } = await jiti.import(
    path.join(packageRoot, "extensions/workflows/runtime/workflow-discovery.ts"),
  );
  const { buildWorkflowCatalogModel } = await jiti.import(
    path.join(packageRoot, "extensions/workflows/catalog/workflow-catalog.ts"),
  );
  const { copyWorkflowNamespace } = await jiti.import(
    path.join(packageRoot, "extensions/workflows/catalog/workflow-copy.ts"),
  );
  const examplesRoot = path.join(packageRoot, "examples/workflows");
  assert.equal(packagedExamplesDir(), examplesRoot + path.sep, "Installed discovery must use root examples/workflows");
  assert.equal(
    existsSync(path.join(packageRoot, "extensions/workflows/examples")),
    false,
    "Old executable examples must be absent",
  );
  assert.deepEqual(
    packagedWorkflowNames().sort(),
    expected.workflows.map(({ name }) => name).sort(),
    "Installed workflow names differ from checked source",
  );
  assert.deepEqual(
    workflowFileHashes(examplesRoot),
    expected.workflowFiles,
    "Installed workflow bytes differ from checked source",
  );
  const catalog = buildWorkflowCatalogModel(projectRoot, projectRoot);
  assert.deepEqual(
    catalog.current.map(({ name }) => name).sort(),
    expected.workflows.map(({ name }) => name).sort(),
    "Installed catalog must expose every runnable workflow",
  );
  for (const { name, namespace } of expected.workflows) {
    const target = resolveWorkflowTarget({ name }, projectRoot, projectRoot);
    assert.equal(target.source, "package", name);
    assert.equal(target.path, path.join(examplesRoot, namespace, name.split("/").at(-1) + ".workflow.mjs"), name);
    const workflow = await import(pathToFileURL(target.path).href);
    assert.equal(typeof workflow.default, "function", name);
    assert.equal(workflow.meta.name, name);
  }
  for (const namespace of new Set(expected.workflows.map(({ namespace }) => namespace))) {
    const workflows = expected.workflows.filter((entry) => entry.namespace === namespace);
    const selectedName = workflows.at(-1).name;
    const namespaceFiles = workflowFileHashes(path.join(examplesRoot, namespace));
    for (const destination of ["project", "personal"]) {
      const copyProjectRoot = destination === "project" ? projectRoot : path.join(projectRoot, "user-copy-probe");
      mkdirSync(copyProjectRoot, { recursive: true });
      const selected = buildWorkflowCatalogModel(copyProjectRoot, copyProjectRoot).current.find(
        ({ name }) => name === selectedName,
      );
      assert.equal(selected.source, "package", "Copy must start from the installed Package namespace");
      const copied = copyWorkflowNamespace(selected, destination, copyProjectRoot, copyProjectRoot);
      assert.equal(copied.status, "copied", namespace + " -> " + destination);
      assert.deepEqual(
        workflowFileHashes(copied.destinationPath),
        namespaceFiles,
        "Namespace copy must preserve every file: " + namespace,
      );
      for (const { name } of workflows) {
        const target = resolveWorkflowTarget({ name }, copyProjectRoot, copyProjectRoot);
        assert.equal(target.source, destination, name);
        assert.equal(
          resolveWorkflowTarget({ name }, projectRoot, projectRoot).source,
          "project",
          "Project copy must retain precedence over User: " + name,
        );
        assert.equal(path.dirname(target.path), copied.destinationPath, name);
      }
      if (!workflows.some(({ name }) => name === namespace)) {
        assert.throws(
          () => resolveWorkflowTarget({ name: namespace }, copyProjectRoot, copyProjectRoot),
          /group-only/,
          "Copy must not invent a runnable root",
        );
      }
    }
  }
  console.log(
    "Verified " + expected.workflows.length + " installed workflows and complete Project/User namespace copies",
  );
}

function main() {
  const candidateDirectory = process.argv[2];
  if (!candidateDirectory) throw new Error("usage: node scripts/release-consumer-smoke.mjs <candidate-directory>");
  const evidence = JSON.parse(readFileSync(path.join(candidateDirectory, "candidate.json"), "utf8"));
  const tarball = path.resolve(candidateDirectory, evidence.filename);
  const repositoryManifest = JSON.parse(readFileSync("package.json", "utf8"));
  const expectedContract = {
    workflows: JSON.parse(readFileSync("dist/public-catalogs.json", "utf8")).workflows,
    workflowFiles: workflowFileHashes("examples/workflows"),
    extensions: repositoryManifest.pi.extensions,
    skillRoots: repositoryManifest.pi.skills,
    skills: repositoryManifest.pi.skills
      .flatMap((root) =>
        readdirSync(path.resolve(root), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(path.resolve(root, entry.name, "SKILL.md")))
          .map((entry) => entry.name),
      )
      .sort(),
  };
  const piPackages = [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ];
  const piPins = piPackages.map((name) => repositoryManifest.devDependencies[name]);
  if (!piPins[0] || piPins.some((pin) => pin !== piPins[0] || !/^\d+\.\d+\.\d+$/u.test(pin))) {
    throw new Error("Pi development dependencies must have one exact version");
  }
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-release-consumer-"));
  const consumerRoot = path.join(temporaryRoot, "consumer");
  const home = path.join(temporaryRoot, "home");
  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(?:TOKEN|AUTH|PASSWORD|SECRET|^npm_config_|^NODE_PATH$|^NODE_OPTIONS$)/iu.test(key),
    ),
  );
  Object.assign(safeEnv, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    NPM_CONFIG_USERCONFIG: path.join(temporaryRoot, "empty-npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(temporaryRoot, "empty-global-npmrc"),
    NPM_CONFIG_CACHE: path.join(temporaryRoot, "npm-cache"),
  });

  try {
    mkdirSync(consumerRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(consumerRoot, "package.json"), '{"private":true,"type":"module"}\n');
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        tarball,
        ...piPackages.map((name) => `${name}@${piPins[0]}`),
      ],
      { cwd: consumerRoot, env: safeEnv, stdio: "inherit" },
    );
    const probe = `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
const profile = process.argv[2];
const expectedContract = JSON.parse(process.argv[3]);
const packageRoot = path.join(process.cwd(), "node_modules", ...process.env.PACKAGE_NAME.split("/"));
const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
if (JSON.stringify(manifest.pi.extensions) !== JSON.stringify(expectedContract.extensions)) throw new Error("Installed extension manifest differs from checked source");
if (JSON.stringify(manifest.pi.skills) !== JSON.stringify(expectedContract.skillRoots)) throw new Error("Installed skill roots differ from checked source");
const entries = profile === "full" ? manifest.pi.extensions : ["./extensions/workflows/index.ts"];
const source = profile === "full" ? { source: packageRoot } : {
  source: packageRoot,
  extensions: entries.map((entry) => entry.replace(/^\\.\\//u, "")),
  ...(profile === "workflows-only" ? { skills: [] } : {}),
};
const settingsManager = SettingsManager.inMemory({ packages: [source] });
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: path.join(process.env.HOME, "agent"), settingsManager });
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const ids = loaded.extensions.map((entry) => path.basename(path.dirname(entry.path))).sort();
const expected = (profile === "full" ? expectedContract.extensions : ["./extensions/workflows/index.ts"])
  .map((entry) => entry.split("/")[2]).sort();
if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error("Wrong " + profile + " extensions: " + JSON.stringify(ids));
const installedSkills = manifest.pi.skills.flatMap((root) => readdirSync(path.join(packageRoot, root), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(packageRoot, root, entry.name, "SKILL.md")))
  .map((entry) => entry.name)).sort();
if (JSON.stringify(installedSkills) !== JSON.stringify(expectedContract.skills)) throw new Error("Installed skill tree differs from checked source");
const loadedSkills = loader.getSkills().skills
  .filter((skill) => skill.sourceInfo.origin === "package" && skill.sourceInfo.source === packageRoot)
  .map((skill) => skill.name).sort();
const expectedSkills = profile === "workflows-only" ? [] : expectedContract.skills;
if (JSON.stringify(loadedSkills) !== JSON.stringify(expectedSkills)) throw new Error("Wrong " + profile + " package skills: " + JSON.stringify(loadedSkills));
${workflowFileHashes.toString()}
${verifyInstalledWorkflows.toString()}
await verifyInstalledWorkflows(packageRoot, expectedContract, process.cwd());
rmSync(path.join(process.cwd(), ".locus-pi"), { recursive: true, force: true });
rmSync(path.join(process.env.HOME, ".locus-pi"), { recursive: true, force: true });
console.log("Pi " + VERSION + ": " + profile + " loaded " + ids.join(", ") + " with " + loadedSkills.length + " package skills");
`;
    writeFileSync(path.join(consumerRoot, "probe.mjs"), probe);
    safeEnv.PACKAGE_NAME = evidence.name;
    for (const profile of ["full", "workflows-only", "workflows-with-skills"]) {
      execFileSync(process.execPath, ["probe.mjs", profile, JSON.stringify(expectedContract)], {
        cwd: consumerRoot,
        env: safeEnv,
        stdio: "inherit",
      });
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
