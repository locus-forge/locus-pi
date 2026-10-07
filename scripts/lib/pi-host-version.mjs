import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const piPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

export function readPiVersion(piBinary, repositoryRoot) {
  const cliOutput = execFileSync(piBinary, ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return extractVersion(cliOutput);
}

export function resolvePiBinary(repositoryRoot) {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  const local = path.join(repositoryRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  return existsSync(local) ? local : "pi";
}

function extractVersion(value) {
  const match = value.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:$|\s)/u);
  if (!match?.[1]) throw new Error(`Cannot parse Pi version from: ${JSON.stringify(value)}`);
  return match[1];
}

export function parseMinimumRange(value, packageName) {
  if (typeof value !== "string") throw new Error(`${packageName}: missing peer dependency range`);
  const match = /^>=\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(value.trim());
  if (!match?.[1]) throw new Error(`${packageName}: expected an open-ended minimum peer range, received ${value}`);
  return match[1];
}

// Preserve the existing numeric-core comparison; this is not prerelease semver ordering.
export function compareVersions(left, right) {
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

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
