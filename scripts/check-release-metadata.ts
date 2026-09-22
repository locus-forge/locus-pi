import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface ReleaseMetadataInput {
  version: string;
  changelog: string;
  tagName?: string;
}

export function hasReleaseHeading(changelog: string, version: string): boolean {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog);
}

export function evaluateReleaseMetadata(input: ReleaseMetadataInput): string[] {
  const errors: string[] = [];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) {
    errors.push(`package version is not valid semver: ${input.version}`);
  }
  if (!hasReleaseHeading(input.changelog, input.version)) {
    errors.push(`CHANGELOG.md has no dated release heading for ${input.version}`);
  }
  if (input.tagName && input.tagName !== `v${input.version}`) {
    errors.push(`tag ${input.tagName} does not match package version ${input.version}`);
  }
  return errors;
}

function main(): void {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const tagName = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  const errors = evaluateReleaseMetadata({
    version: packageJson.version,
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    ...(tagName ? { tagName } : {}),
  });
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Release metadata verified for ${packageJson.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
