import { execFileSync } from "node:child_process";
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
const packageJsonPath = path.join(root, "package.json");
const packageJson = readJson(packageJsonPath);

const piBinary = resolvePiBinary(root);
const targetVersion = readPiVersion(piBinary, root);

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
