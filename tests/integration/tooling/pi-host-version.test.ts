import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// These subprocess fixtures use POSIX executable scripts; no real Pi or npm is invoked.
describe.skipIf(process.platform === "win32")("Pi baseline commands", () => {
  it.each(["0.84.3", "0.84.10", "0.85.0", "1.0.0"])("checks stable version %s without writing", (version) => {
    const fixture = createFixture(version);
    const before = readFileSync(path.join(fixture.root, "package.json"), "utf8");
    const result = fixture.run("check");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`CLI ${version}; SDK packages ${version}; peer policy >=0.84.3`);
    expect(readFileSync(path.join(fixture.root, "package.json"), "utf8")).toBe(before);
    expect(existsSync(fixture.npmReceipt)).toBe(false);
  });

  it("prefers PI_BIN, then the local binary, then PATH", () => {
    const fixture = createFixture();
    const local = path.join(fixture.root, "node_modules/.bin/pi");
    const override = path.join(fixture.root, "override-pi");
    fixture.pi(local, "2.0.0");
    fixture.pi(override, "1.0.0");
    expect(fixture.run("check", { PI_BIN: override }).status).toBe(0);
    expect(fixture.run("check").stderr).toContain("Pi CLI 2.0.0 does not match installed SDK 1.0.0");
    fixture.pi(local, "1.0.0");
    fixture.pi(fixture.pathPi, "2.0.0");
    expect(fixture.run("check").status).toBe(0);
    rmSync(local);
    expect(fixture.run("check").stderr).toContain("Pi CLI 2.0.0 does not match installed SDK 1.0.0");
    fixture.pi(fixture.pathPi, "1.0.0");
    expect(fixture.run("check").status).toBe(0);
  });

  it.each(["Pi v1.0.0", "1.0", "1.0.0+build"])("refuses malformed CLI output %s in both commands", (output) => {
    const fixture = createFixture();
    fixture.pi(fixture.pathPi, output);
    for (const command of ["check", "sync"] as const) {
      const result = fixture.run(command);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Cannot parse Pi version from:");
    }
    expect(existsSync(fixture.npmReceipt)).toBe(false);
  });

  it("accepts whitespace-delimited version output", () => {
    const fixture = createFixture();
    fixture.pi(fixture.pathPi, "Pi CLI 1.0.0 ready\n");
    expect(fixture.run("check").status).toBe(0);
  });

  it.each(["0.83.99", "0.84.2"])("refuses below-floor version %s before sync invokes npm", (version) => {
    const fixture = createFixture(version);
    expect(fixture.run("check").stderr).toContain(`installed ${version} is below peer floor >=0.84.3`);
    expect(fixture.run("sync").stderr).toContain(`Pi CLI ${version} is below the supported peer floor >=0.84.3`);
    expect(existsSync(fixture.npmReceipt)).toBe(false);
  });

  it.each([undefined, "^0.84.3", ">=0.84.3 <2"])("retains minimum peer-range validation for %s", (range) => {
    const fixture = createFixture();
    fixture.manifest.peerDependencies[packages[0]!] = range;
    fixture.saveManifest();
    for (const command of ["check", "sync"] as const) {
      const result = fixture.run(command);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        range === undefined ? "missing peer dependency range" : "expected an open-ended minimum peer range",
      );
    }
    expect(existsSync(fixture.npmReceipt)).toBe(false);
  });

  it("refuses missing packages, mismatched pins and packages that did not move together", () => {
    const fixture = createFixture();
    const packageName = packages[0]!;
    rmSync(fixture.packagePath(packageName));
    expect(fixture.run("check").stderr).toContain(`Missing installed Pi development package: ${packageName}`);
    fixture.installed(packageName, "1.0.1");
    expect(fixture.run("check").stderr).toContain("devDependency 1.0.0 does not match installed 1.0.1");
    fixture.manifest.devDependencies[packageName] = "1.0.1";
    fixture.saveManifest();
    expect(fixture.run("check").stderr).toContain("Pi development packages must move together:");
  });

  it("syncs exactly four pins through the npm stub and rechecks the selected CLI", () => {
    const fixture = createFixture();
    const override = path.join(fixture.root, "override-pi");
    fixture.pi(override, "1.0.0");
    fixture.pi(fixture.pathPi, "2.0.0");
    const result = fixture.run("sync", { PI_BIN: override });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(fixture.npmReceipt, "utf8"))).toEqual({
      args: ["install", "--save-dev", "--save-exact", ...packages.map((name) => `${name}@1.0.0`)],
      cwd: fixture.root,
    });
    expect(result.stdout).toContain("Pi host contract verified: CLI 1.0.0; SDK packages 1.0.0");
    expect(result.stdout).toContain("Pi development baseline is now 1.0.0.");
  });

  it("does not report sync success when the post-install check fails", () => {
    const fixture = createFixture();
    fixture.pi(fixture.pathPi, "1.0.1");
    const result = fixture.run("sync");
    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.npmReceipt)).toBe(true);
    expect(result.stderr).toContain("Pi CLI 1.0.1 does not match installed SDK 1.0.0");
    expect(result.stdout).not.toContain("Pi development baseline is now");
  });

  it("retains numeric-core floor comparison for prereleases without claiming semver ordering", () => {
    const fixture = createFixture("0.84.3-rc.1");
    expect(fixture.run("check").status).toBe(0);
    expect(fixture.run("sync").status).toBe(0);
    fixture.pi(fixture.pathPi, "0.84.3-rc.2");
    expect(fixture.run("check").stderr).toContain("does not match installed SDK 0.84.3-rc.1");
  });
});

function createFixture(version = "1.0.0") {
  const root = mkdtempSync(path.join(tmpdir(), "pi-baseline-"));
  roots.push(root);
  cpSync(path.resolve("scripts"), path.join(root, "scripts"), { recursive: true });
  const manifest = {
    devDependencies: Object.fromEntries(packages.map((name) => [name, version])),
    peerDependencies: Object.fromEntries(packages.map((name) => [name, ">=0.84.3"])) as Record<
      string,
      string | undefined
    >,
  };
  const saveManifest = () => writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  const packagePath = (name: string) => path.join(root, "node_modules", name, "package.json");
  const installed = (name: string, value: string) => {
    mkdirSync(path.dirname(packagePath(name)), { recursive: true });
    writeFileSync(packagePath(name), JSON.stringify({ version: value }));
  };
  const executable = (file: string, body: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  };
  const pi = (file: string, output: string) => executable(file, `console.log(${JSON.stringify(output)});`);
  const pathPi = path.join(root, "bin/pi");
  const npmReceipt = path.join(root, "npm-receipt.json");
  const npm = path.join(root, "mock-npm");
  executable(
    npm,
    `require("node:fs").writeFileSync(${JSON.stringify(npmReceipt)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
  );
  pi(pathPi, version);
  saveManifest();
  for (const name of packages) installed(name, version);
  return {
    root,
    manifest,
    saveManifest,
    packagePath,
    installed,
    pi,
    pathPi,
    npmReceipt,
    run(command: "check" | "sync", env: NodeJS.ProcessEnv = {}) {
      return spawnSync(process.execPath, [path.join(root, "scripts", `${command}-pi-host-version.mjs`)], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: path.dirname(pathPi), PI_BIN: "", NPM_BIN: npm, ...env },
      });
    },
  };
}
