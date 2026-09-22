import { pathToFileURL } from "node:url";

import { candidateFiles } from "./check-repository.js";
import { deadMarkdownLinks, surfaceMarkdownFiles } from "./markdown-links.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function main(): Promise<void> {
  const root = process.cwd();
  const surface = { name: "the repository", files: new Set(await candidateFiles(root)) };
  const failures = deadMarkdownLinks(root, surface);

  if (failures.length > 0) {
    console.error(`Dead links in ${surface.name}:\n${failures.map((line) => `  ${line}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Repository Markdown links verified: ${surfaceMarkdownFiles(surface).length}`);
}
