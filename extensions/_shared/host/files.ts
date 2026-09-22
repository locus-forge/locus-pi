import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

export async function expandPaths(inputs: string[], projectRoot: string, limit = 200): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    if (files.length >= limit) break;
    const resolved = path.resolve(projectRoot, input);
    try {
      const info = await stat(resolved);
      if (info.isFile()) files.push(resolved);
      else if (info.isDirectory()) await collectFiles(resolved, files, limit);
    } catch {
      // Minimal glob support: prefix before first wildcard.
      const wildcard = input.search(/[*?]/);
      if (wildcard >= 0) {
        const base = path.resolve(projectRoot, input.slice(0, wildcard).replace(/[/\\][^/\\]*$/, ""));
        await collectFiles(base, files, limit);
      }
    }
  }
  return [...new Set(files)].slice(0, limit);
}

export function runtimeStateDir(projectRoot: string): string {
  return path.join(projectRoot, ".locus", "runtime");
}

export function sessionJsonlPath(projectRoot: string): string {
  return path.join(runtimeStateDir(projectRoot), "session-state.jsonl");
}

export function artifactStoreDir(projectRoot: string): string {
  return path.join(runtimeStateDir(projectRoot), "artifacts");
}

async function collectFiles(dir: string, files: string[], limit: number): Promise<void> {
  if (files.length >= limit) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= limit) return;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(full, files, limit);
    else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
}
