import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  parseMinimumRange,
  piPackages,
  readJson,
  readPiVersion,
  resolvePiBinary,
} from "./lib/pi-host-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = readJson(path.join(root, "package.json"));

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
const cliVersion = readPiVersion(piBinary, root);
if (cliVersion !== sdkVersion)
  throw new Error(`Pi CLI ${cliVersion} does not match installed SDK ${sdkVersion}; command: ${piBinary}`);

console.log(
  `Pi host contract verified: CLI ${cliVersion}; SDK packages ${sdkVersion}; peer policy ${packageJson.peerDependencies["@earendil-works/pi-coding-agent"]}.`,
);
