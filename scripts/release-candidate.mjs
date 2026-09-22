import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [command, directory] = process.argv.slice(2);
if (!directory || !["pack", "verify"].includes(command)) {
  throw new Error("usage: node scripts/release-candidate.mjs <pack|verify> <candidate-directory>");
}

const candidateDirectory = path.resolve(directory);
const evidencePath = path.join(candidateDirectory, "candidate.json");

if (command === "pack") {
  mkdirSync(candidateDirectory, { recursive: true });
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", candidateDirectory], {
    encoding: "utf8",
  });
  const [packed] = JSON.parse(output);
  if (!packed || !/^[\w.+-]+\.tgz$/u.test(packed.filename))
    throw new Error("npm pack returned no safe tarball filename");
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    throw new Error("npm pack identity differs from package.json");
  }
  const tarball = path.join(candidateDirectory, packed.filename);
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== packed.integrity) throw new Error("npm pack integrity differs from tarball bytes");
  const evidence = {
    name: packed.name,
    version: packed.version,
    filename: packed.filename,
    integrity,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
if (evidence.name !== "@locus-forge/locus-pi" || !/^\d+\.\d+\.\d+$/u.test(evidence.version)) {
  throw new Error("candidate identity is invalid");
}
if (!/^[\w.+-]+\.tgz$/u.test(evidence.filename) || path.basename(evidence.filename) !== evidence.filename) {
  throw new Error("candidate filename is invalid");
}
const tarball = path.join(candidateDirectory, evidence.filename);
const bytes = readFileSync(tarball);
if (createHash("sha256").update(bytes).digest("hex") !== evidence.sha256) throw new Error("candidate SHA-256 mismatch");
if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== evidence.integrity) {
  throw new Error("candidate npm integrity mismatch");
}
const tarManifest = JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));
if (tarManifest.name !== evidence.name || tarManifest.version !== evidence.version) {
  throw new Error("candidate tarball package identity mismatch");
}
console.log(`Verified ${evidence.name}@${evidence.version}: ${tarball} (${evidence.sha256})`);
