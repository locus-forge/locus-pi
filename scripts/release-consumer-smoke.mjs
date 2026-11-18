import { verifyConsumerGlobs } from "./lib/release-consumer-globs.mjs";
import { verifyConsumerTransport } from "./lib/release-consumer-transport.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
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

async function main() {
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
  const home = path.join(temporaryRoot, "home");
  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(?:TOKEN|AUTH|PASSWORD|SECRET|API_KEY|^PI_|^npm_config_|^NODE_PATH$|^NODE_OPTIONS$)/iu.test(key),
    ),
  );
  Object.assign(safeEnv, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    NPM_CONFIG_USERCONFIG: path.join(temporaryRoot, "empty-npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(temporaryRoot, "empty-global-npmrc"),
    NPM_CONFIG_CACHE: path.join(temporaryRoot, "npm-cache"),
  });

  let graphState = {};
  const recordGraph = (update) => {
    Object.assign(graphState, update);
    writeFileSync(
      path.join(candidateDirectory, `consumer-${graphState.graph}.json`),
      JSON.stringify(graphState, null, 2) + "\n",
    );
  };
  const recordCommand = (label, result) => {
    const prefix = path.join(candidateDirectory, `${graphState.graph}-${label}`);
    writeFileSync(prefix + ".stdout", result.stdout ?? "");
    writeFileSync(prefix + ".stderr", result.stderr ?? "");
    writeFileSync(
      prefix + ".json",
      JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message ?? null }, null, 2) +
        "\n",
    );
  };
  try {
    for (const graph of ["standard", "root-overrides"]) {
      graphState = { graph, bundledCli: "unfixed upstream; root overrides do not rewrite embedded code" };
      recordGraph({ phase: "install", status: "running" });
      const consumerRoot = path.join(temporaryRoot, graph);
      mkdirSync(consumerRoot, { recursive: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(
        path.join(consumerRoot, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          ...(graph === "root-overrides" ? { overrides: repositoryManifest.overrides } : {}),
        }),
      );
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
      recordGraph({ phase: "full-audit" });
      const auditProcess = spawnSync("npm", ["audit", "--json"], { cwd: consumerRoot, env: safeEnv, encoding: "utf8" });
      recordCommand("audit-full", auditProcess);
      if (auditProcess.error) throw auditProcess.error;
      const audit = JSON.parse(auditProcess.stdout);
      if (audit.error) throw new Error(JSON.stringify(audit.error));
      recordGraph({ audit });
      const vulnerabilities = audit.vulnerabilities ?? {};
      if (graph === "root-overrides")
        assert.equal(audit.metadata.vulnerabilities.total, 0, "Configured consumer graph must have audit 0");
      else {
        assert(vulnerabilities.undici, "Standard Pi graph must expose its unresolved undici dependency");
        assert(vulnerabilities.minimatch, "Standard Pi graph must expose its unresolved minimatch dependency");
        for (const [name, finding] of Object.entries(vulnerabilities)) {
          assert(
            name === "undici" ||
              name === "minimatch" ||
              name === "openai" ||
              ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"].includes(
                name,
              ) ||
              name === "@locus-forge/locus-pi",
            `Unclassified audit package: ${name}`,
          );
          for (const via of finding.via)
            if (typeof via !== "string")
              assert(
                [
                  "https://github.com/advisories/GHSA-2m5v-pch6-74hx",
                  "https://github.com/advisories/GHSA-g3hv-75wg-m249",
                  "https://github.com/advisories/GHSA-4qv8-2p9j-2685",
                  "https://github.com/advisories/GHSA-f72v-6w45-q472",
                  "https://github.com/advisories/GHSA-xjj6-f33q-929c",
                  "https://github.com/advisories/GHSA-4w7w-5xrc-9h26",
                  "https://github.com/advisories/GHSA-qrxm-fqhp-jwvm",
                  "https://github.com/advisories/GHSA-9fm3-97px-rjf6",
                  "https://github.com/advisories/GHSA-55wc-3pg8-jfw6",
                ].includes(via.url),
                `New advisory requires review: ${via.url}`,
              );
        }
      }
      recordGraph({ phase: "production-audit" });
      const productionAuditProcess = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
        cwd: consumerRoot,
        env: safeEnv,
        encoding: "utf8",
      });
      recordCommand("audit-production", productionAuditProcess);
      if (productionAuditProcess.error) throw productionAuditProcess.error;
      const productionAudit = JSON.parse(productionAuditProcess.stdout);
      if (productionAudit.error) throw new Error(JSON.stringify(productionAudit.error));
      recordGraph({ productionAudit });
      assert.deepEqual(
        productionAudit.vulnerabilities,
        audit.vulnerabilities,
        "Consumer dependencies are production dependencies; audit graphs must agree",
      );
      assert.equal(auditProcess.status, graph === "root-overrides" ? 0 : 1);
      assert.equal(productionAuditProcess.status, auditProcess.status);
      recordGraph({ phase: "dependency-tree" });
      const explanations = execFileSync("npm", ["explain", "undici", "minimatch"], {
        cwd: consumerRoot,
        env: safeEnv,
        encoding: "utf8",
      });
      const tree = execFileSync("npm", ["ls", "undici", "minimatch", "--all", "--json"], {
        cwd: consumerRoot,
        env: safeEnv,
        encoding: "utf8",
      });
      const resolvedTree = JSON.parse(tree);
      recordGraph({ tree: resolvedTree, explanations });
      const expectedLeaves =
        graph === "root-overrides"
          ? { undici: "8.12.2", minimatch: "11.0.1" }
          : { undici: "8.10.2", minimatch: "10.2.6" };
      const found = new Set();
      function checkLeaves(node) {
        for (const [name, child] of Object.entries(node.dependencies ?? {})) {
          if (name in expectedLeaves) {
            assert.equal(child.version, expectedLeaves[name], `${graph}/${name}`);
            found.add(name);
          }
          checkLeaves(child);
        }
      }
      checkLeaves(resolvedTree);
      assert.equal(found.size, 2, "Both target leaves must be present");
      recordGraph({ phase: "glob-contracts" });
      const globs = await verifyConsumerGlobs(consumerRoot);
      recordGraph({ globs, phase: "http-transport" });
      const transport = await verifyConsumerTransport(consumerRoot, safeEnv, graph, path.resolve(candidateDirectory));
      recordGraph({ transport, phase: "loading-profiles" });
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
      recordGraph({ phase: "complete", status: "passed" });
    }
  } catch (error) {
    recordGraph({ status: "failed", error: String(error.stack ?? error) });
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
