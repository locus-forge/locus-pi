import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(root, "package.json");
const packageJson = readJson(packageJsonPath);
const piPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

const piBinary = resolvePiBinary(root);
const cliOutput = execFileSync(piBinary, ["--version"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
const targetVersion = extractVersion(cliOutput);

for (const packageName of piPackages) {
  const peerRange = packageJson.peerDependencies?.[packageName];
  const floor = parseMinimumRange(peerRange, packageName);
  if (compareVersions(targetVersion, floor) < 0)
    throw new Error(`${packageName}: Pi CLI ${targetVersion} is below the supported peer floor ${peerRange}`);
}

const npmBinary = process.env.NPM_BIN || (process.platform === "win32" ? "npm.cmd" : "npm");
const packageSpecs = piPackages.map((packageName) => `${packageName}@${targetVersion}`);
console.log(`Synchronizing Pi development baseline to CLI ${targetVersion} (${piBinary})...`);
execFileSync(npmBinary, ["install", "--save-dev", "--save-exact", ...packageSpecs], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts", "check-pi-host-version.mjs")], {
  cwd: root,
  env: { ...process.env, PI_BIN: piBinary },
  stdio: "inherit",
});
console.log(
  `Pi development baseline is now ${targetVersion}. Run npm run check before committing package.json and package-lock.json.`,
);

function resolvePiBinary(repositoryRoot) {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  const local = path.join(repositoryRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  return existsSync(local) ? local : "pi";
}

function extractVersion(value) {
  const match = value.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:$|\s)/u);
  if (!match?.[1]) throw new Error(`Cannot parse Pi version from: ${JSON.stringify(value)}`);
  return match[1];
}

function parseMinimumRange(value, packageName) {
  if (typeof value !== "string") throw new Error(`${packageName}: missing peer dependency range`);
  const match = /^>=\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(value.trim());
  if (!match?.[1]) throw new Error(`${packageName}: expected an open-ended minimum peer range, received ${value}`);
  return match[1];
}

function compareVersions(left, right) {
  const parse = (value) =>
    value
      .split("-", 1)[0]
      .split(".")
      .map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
