import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = readJson(path.join(root, "package.json"));
const piPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

const installedVersions = new Map();
for (const packageName of piPackages) {
  const packagePath = path.join(root, "node_modules", ...packageName.split("/"), "package.json");
  if (!existsSync(packagePath)) throw new Error(`Missing installed Pi development package: ${packageName}`);
  const installed = readJson(packagePath).version;
  const declared = packageJson.devDependencies?.[packageName];
  if (declared !== installed)
    throw new Error(`${packageName}: devDependency ${String(declared)} does not match installed ${installed}`);
  const peerRange = packageJson.peerDependencies?.[packageName];
  const floor = parseMinimumRange(peerRange, packageName);
  if (compareVersions(installed, floor) < 0)
    throw new Error(`${packageName}: installed ${installed} is below peer floor ${peerRange}`);
  installedVersions.set(packageName, installed);
}

const uniqueInstalledVersions = new Set(installedVersions.values());
if (uniqueInstalledVersions.size !== 1) {
  throw new Error(
    `Pi development packages must move together: ${JSON.stringify(Object.fromEntries(installedVersions))}`,
  );
}

const sdkVersion = installedVersions.get("@earendil-works/pi-coding-agent");
const piBinary = resolvePiBinary(root);
const cliOutput = execFileSync(piBinary, ["--version"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
const cliVersion = extractVersion(cliOutput);
if (cliVersion !== sdkVersion)
  throw new Error(`Pi CLI ${cliVersion} does not match installed SDK ${sdkVersion}; command: ${piBinary}`);

console.log(
  `Pi host contract verified: CLI ${cliVersion}; SDK packages ${sdkVersion}; peer policy ${packageJson.peerDependencies["@earendil-works/pi-coding-agent"]}.`,
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
