import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const candidateDirectory = process.argv[2];
if (!candidateDirectory) throw new Error("usage: node scripts/release-consumer-smoke.mjs <candidate-directory>");
const evidence = JSON.parse(readFileSync(path.join(candidateDirectory, "candidate.json"), "utf8"));
const tarball = path.resolve(candidateDirectory, evidence.filename);
const repositoryManifest = JSON.parse(readFileSync("package.json", "utf8"));
const expectedContract = {
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
  const probe = `import { existsSync, readFileSync, readdirSync } from "node:fs";
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
