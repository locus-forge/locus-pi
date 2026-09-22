import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const forbiddenPaths = [
  /^\.(locus|tasks|planning|pi|publication)\//,
  /^\.agents\/(skills|workflows)\//,
  /^(artifacts|benchmarks|eval|evaluation|evaluations|output|reports|transcripts)\//,
  /^docs\/(adr|decisions|prd|source-audit|internal|archive|_archive|drafts|notes|research|proposals|specs|system-design|extension-gallery|reports|runtime|extensions)\//,
  /^docs\/(?:milestones|roadmap).*\.md$/iu,
  /^(?:EXPORT_MANIFEST\.(?:md|json)|PUBLICATION_PLAN\.md|PUBLICATION_REMOVALS\.txt|VALIDATION_REPORT\.md)$/u,
  /^extensions\/beta\//,
];

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  const problems = await repositoryProblems(process.cwd());
  if (problems.length > 0) {
    console.error(problems.map((problem) => `- ${problem}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Repository hygiene verified: ${(await candidateFiles(process.cwd())).length} files`);
  }
}

/** Inspect every tracked or visible untracked file that would become public with this Git repository. */
export async function repositoryProblems(root: string): Promise<string[]> {
  const files = (await candidateFiles(root)).sort();
  const problems: string[] = [];

  for (const relativePath of files) {
    if (forbiddenPaths.some((pattern) => pattern.test(relativePath))) {
      problems.push(`forbidden repository path: ${relativePath}`);
      continue;
    }

    const absolutePath = path.join(root, relativePath);
    const entry = await lstat(absolutePath);
    if (entry.isSymbolicLink()) {
      problems.push(`symlink is not allowed: ${relativePath}`);
      continue;
    }
    if (!entry.isFile()) {
      problems.push(`repository entry is not a file: ${relativePath}`);
      continue;
    }

    const bytes = await readFile(absolutePath);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (/\/Users\/[A-Za-z0-9._-]+\//u.test(text)) problems.push(`absolute workstation path found: ${relativePath}`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) {
      problems.push(`private key material found: ${relativePath}`);
    }
    if (/registry\.npmjs\.org\/.*:_authToken\s*=/u.test(text)) {
      problems.push(`npm auth configuration found: ${relativePath}`);
    }
  }

  return problems;
}

/** Git owns the repository inventory. A non-Git fixture falls back to a confined filesystem walk. */
export async function candidateFiles(directory: string): Promise<string[]> {
  try {
    const { stdout: topLevel } = await execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if ((await realpath(topLevel.trim())) !== (await realpath(directory))) return walk(directory, directory);

    const [{ stdout }, { stdout: deletedStdout }] = await Promise.all([
      execFileAsync("git", ["-C", directory, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
      execFileAsync("git", ["-C", directory, "ls-files", "--deleted", "-z"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);
    const deleted = new Set(deletedStdout.split("\0").filter(Boolean));
    return stdout.split("\0").filter((file) => file.length > 0 && !deleted.has(file));
  } catch {
    return walk(directory, directory);
  }
}

async function walk(directory: string, root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && (entry.name === ".git" || entry.name === "node_modules")) continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) files.push(relativePath);
    else if (stats.isDirectory()) files.push(...(await walk(absolutePath, root)));
    else if (stats.isFile()) files.push(relativePath);
  }
  return files;
}
