import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";

export interface ReadOnlyAgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface ReadOnlyAgentCustomTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ReadOnlyAgentToolResult> | ReadOnlyAgentToolResult;
}

export interface ReadOnlyAgentSessionCapabilities {
  tools: string[];
  excludeTools: string[];
  customTools?: ReadOnlyAgentCustomTool[];
}

export type RepositoryCheckScripts = Readonly<Record<string, string>>;

export interface ReadOnlyAgentSessionCapabilityOptions {
  /**
   * Exact package script commands captured before any workflow writer runs.
   * Undefined preserves direct-call compatibility by capturing at capability creation.
   */
  repositoryCheckScripts?: RepositoryCheckScripts;
}

/** The host's own answer to "can this child write?". Deliberately NOT exported: the workflow
 *  runtime keeps a copy because it may not import this module (fs + child_process), and the
 *  copy is held to this list by a source-level subset assertion rather than by widening the
 *  packaged surface for a test's convenience. */
const READ_ONLY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "git_read",
  "ast_index",
  "repository_check",
  "yield",
]);
const SAFE_TOOLS = READ_ONLY_SAFE_TOOLS;
// `ast-index` keeps its database in the user cache directory, outside the
// reviewed project. Query commands read it; `update`/`rebuild` refresh only
// that external cache. `clear` and `watch` are destructive or long-lived, so
// they stay unreachable from a read-only session.
const AST_INDEX_COMMANDS = new Set([
  "api",
  "call-tree",
  "callers",
  "changed",
  "class",
  "deps",
  "dependents",
  "explore",
  "file",
  "hierarchy",
  "implementations",
  "imports",
  "module",
  "outline",
  "rebuild",
  "refs",
  "search",
  "stats",
  "symbol",
  "update",
  "usages",
]);
const MAX_AST_INDEX_MILLISECONDS = 120_000;
const MAX_REPOSITORY_CHECK_MILLISECONDS = 5 * 60_000;
const GIT_QUERY_SUBCOMMANDS = new Set([
  "branch",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "grep",
  "log",
  "ls-files",
  "merge-base",
  "name-rev",
  "rev-parse",
  "show",
  "status",
]);
const GIT_DIFF_SUBCOMMANDS = new Set(["diff", "diff-files", "diff-index", "diff-tree", "log", "show"]);
const MAX_ARGS = 80;
const MAX_ARG_LENGTH = 4_096;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function createReadOnlyAgentSessionCapabilities(
  cwd: string,
  requestedTools: readonly string[],
  options: ReadOnlyAgentSessionCapabilityOptions = {},
): ReadOnlyAgentSessionCapabilities {
  const tools = requestedTools.includes("*")
    ? [...SAFE_TOOLS]
    : unique(requestedTools.filter((tool) => SAFE_TOOLS.has(tool)));
  const excludeTools = unique([
    "spawn_agent",
    "task",
    "workflow",
    "bash",
    "edit",
    "write",
    ...requestedTools.filter((tool) => tool !== "*" && !SAFE_TOOLS.has(tool)),
  ]);
  const customTools = [
    ...(tools.includes("git_read") ? [createGitReadTool(cwd)] : []),
    ...(tools.includes("ast_index") ? [createAstIndexTool(cwd)] : []),
    ...(tools.includes("repository_check")
      ? [createRepositoryCheckTool(cwd, options.repositoryCheckScripts ?? captureRepositoryCheckScripts(cwd))]
      : []),
  ];
  return {
    tools,
    excludeTools,
    ...(customTools.length > 0 ? { customTools } : {}),
  };
}

/** Capture the only package scripts a later repository_check may execute. */
export function captureRepositoryCheckScripts(cwd: string): RepositoryCheckScripts {
  const packageJson = readPackageJson(cwd);
  if (!packageJson.ok) return Object.freeze({});
  const scripts = packageScriptMap(packageJson.value);
  return Object.freeze(scripts.ok ? scripts.value : {});
}

function createAstIndexTool(cwd: string): ReadOnlyAgentCustomTool {
  return {
    name: "ast_index",
    label: "AST Index",
    description:
      'Run one allowlisted `ast-index` navigation command in the current project. Pass argv without the leading `ast-index`, for example {"args":["callers","runWorkflow"]}. Query commands read the external index; `update` and `rebuild` refresh only the user-cache database. `clear`, `watch`, shell syntax, and output files are rejected. When the binary or index is unavailable, fall back to grep/find and record the gap.',
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["args"],
      properties: {
        args: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ARGS,
          items: { type: "string", maxLength: MAX_ARG_LENGTH },
        },
      },
    },
    async execute(_toolCallId, input, signal) {
      const validation = validateAstIndexInput(input);
      if (!validation.ok) return blocked(validation.reason);
      return executeArgv("ast-index", cwd, validation.args, validation.args, signal, MAX_AST_INDEX_MILLISECONDS);
    },
  };
}

type ArgvValidation = { ok: true; args: string[] } | { ok: false; reason: string };

function validateAstIndexInput(input: unknown): ArgvValidation {
  const parsed = parseArgvInput(input, "ast_index");
  if (!parsed.ok) return parsed;
  const command = parsed.args[0]!;
  if (!AST_INDEX_COMMANDS.has(command)) {
    return { ok: false, reason: `ast_index blocks destructive or unsupported command: ${command}` };
  }
  if (parsed.args.slice(1).some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="))) {
    return { ok: false, reason: "ast_index blocks output-file options." };
  }
  return parsed;
}

function parseArgvInput(input: unknown, toolName: string): ArgvValidation {
  if (!isRecord(input) || !Array.isArray(input.args)) {
    return { ok: false, reason: `${toolName} requires one \`args\` string array.` };
  }
  if (input.args.length === 0 || input.args.length > MAX_ARGS) {
    return { ok: false, reason: `${toolName} accepts 1-${MAX_ARGS} arguments.` };
  }
  if (
    input.args.some(
      (arg) => typeof arg !== "string" || arg.length === 0 || arg.length > MAX_ARG_LENGTH || arg.includes("\0"),
    )
  ) {
    return {
      ok: false,
      reason: `Every ${toolName} argument must be a non-empty string up to ${MAX_ARG_LENGTH} characters.`,
    };
  }
  return { ok: true, args: [...(input.args as string[])] };
}

function createRepositoryCheckTool(cwd: string, frozenScripts: RepositoryCheckScripts): ReadOnlyAgentCustomTool {
  return {
    name: "repository_check",
    label: "Repository Check",
    description:
      'Run one existing package.json script in a host-created disposable Git worktree containing the current tracked and untracked source bytes. Pass only the script name, for example {"script":"test"}. The host supplies the package manager, argv, cwd, timeout, output bound, snapshot, and cleanup; arbitrary shell text and arguments are impossible. The operator checkout is never the command cwd. Installed dependency roots (node_modules, .venv) are borrowed from the checkout by symlink so a declared check actually starts; everything the check writes lands in the disposable copy, except writes made inside a dependency root itself.',
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["script"],
      properties: {
        script: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]*$" },
      },
    },
    async execute(_toolCallId, input, signal) {
      const validation = validateRepositoryCheckInput(cwd, input, frozenScripts);
      if (!validation.ok) return blocked(validation.reason);
      let snapshot: RepositoryCheckSnapshot | undefined;
      try {
        snapshot = materializeRepositoryCheckSnapshot(cwd);
        const snapshotValidation = validateRepositoryCheckInput(snapshot.cwd, input, frozenScripts);
        if (!snapshotValidation.ok) return blocked(snapshotValidation.reason);
        const packageManager = resolvePackageManager(snapshot.cwd);
        const result = await executeArgv(
          packageManager,
          snapshot.cwd,
          ["run", validation.script],
          ["run", validation.script],
          signal,
          MAX_REPOSITORY_CHECK_MILLISECONDS,
          {
            CI: "1",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_PAGER: "",
            NODE_PATH: path.join(cwd, "node_modules"),
            PAGER: "",
            PATH: `${path.join(cwd, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        );
        return {
          ...result,
          details: {
            ...result.details,
            script: validation.script,
            packageManager,
            isolatedSnapshot: true,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { script: validation.script, isolatedSnapshot: snapshot !== undefined },
          isError: true,
        };
      } finally {
        if (snapshot !== undefined) removeRepositoryCheckSnapshot(snapshot);
      }
    },
  };
}

type RepositoryCheckValidation = { ok: true; script: string } | { ok: false; reason: string };

function validateRepositoryCheckInput(
  cwd: string,
  input: unknown,
  frozenScripts: RepositoryCheckScripts,
): RepositoryCheckValidation {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "script") || typeof input.script !== "string") {
    return { ok: false, reason: "repository_check requires exactly one `script` string." };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(input.script)) {
    return { ok: false, reason: "repository_check script name is invalid." };
  }
  if (!Object.hasOwn(frozenScripts, input.script) || typeof frozenScripts[input.script] !== "string") {
    return { ok: false, reason: `repository_check script was not present in the frozen baseline: ${input.script}` };
  }
  const packageJson = readPackageJson(cwd);
  if (!packageJson.ok) {
    return {
      ok: false,
      reason: `repository_check cannot read package.json: ${packageJson.reason}`,
    };
  }
  const currentScripts = packageScriptMap(packageJson.value);
  if (!currentScripts.ok) {
    return {
      ok: false,
      reason: `repository_check cannot validate package.json scripts: ${currentScripts.reason}`,
    };
  }
  if (!sameScriptMap(currentScripts.value, frozenScripts)) {
    return { ok: false, reason: "repository_check package.json scripts changed after the frozen baseline." };
  }
  return { ok: true, script: input.script };
}

type PackageScriptMapRead = { ok: true; value: Record<string, string> } | { ok: false; reason: string };

function packageScriptMap(packageJson: Record<string, unknown>): PackageScriptMapRead {
  if (packageJson.scripts === undefined) return { ok: true, value: {} };
  if (!isRecord(packageJson.scripts)) return { ok: false, reason: "scripts is not an object" };
  const entries = Object.entries(packageJson.scripts);
  const invalid = entries.find((entry) => typeof entry[1] !== "string");
  if (invalid !== undefined) return { ok: false, reason: `script command is not a string: ${invalid[0]}` };
  return { ok: true, value: Object.fromEntries(entries) as Record<string, string> };
}

function sameScriptMap(current: RepositoryCheckScripts, frozen: RepositoryCheckScripts): boolean {
  const currentNames = Object.keys(current).sort();
  const frozenNames = Object.keys(frozen).sort();
  return (
    currentNames.length === frozenNames.length &&
    currentNames.every((name, index) => name === frozenNames[index] && current[name] === frozen[name])
  );
}

type PackageJsonRead = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

function readPackageJson(cwd: string): PackageJsonRead {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, reason: "package.json is not an object" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

interface RepositoryCheckSnapshot {
  repoRoot: string;
  path: string;
  cwd: string;
  /** Absolute paths of the dependency symlinks this snapshot created, newest last. */
  dependencyLinks: string[];
}

/**
 * Installed dependencies are git-ignored, so the snapshot never contains them and
 * a declared check dies at startup — `sh: vitest: command not found` — which reads
 * to a verifier as "the suite could not run", not as evidence. The snapshot
 * borrows these roots by symlink instead of copying them: resolution then behaves
 * exactly as it does in the operator's checkout, while the command's cwd stays the
 * disposable copy, so build output, coverage, and updated snapshot files land
 * there and are discarded with it.
 *
 * The residual write path is narrow and deliberate: a check that writes *inside* a
 * dependency root (a bundler cache under `node_modules/`, a byte-compiled module
 * under `.venv/`) touches the operator's real directory. That is the price of
 * running the check at all, and it is documented on the tool.
 */
const REPOSITORY_CHECK_DEPENDENCY_ROOTS = ["node_modules", ".venv"] as const;

function materializeRepositoryCheckSnapshot(cwd: string): RepositoryCheckSnapshot {
  const repoRoot = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const checksRoot = path.join(tmpdir(), "locus-repository-checks");
  mkdirSync(checksRoot, { recursive: true });
  const target = path.join(checksRoot, `check-${randomUUID()}`);
  execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", target, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const dependencyLinks: string[] = [];
  try {
    overlayCurrentSource(repoRoot, target);
    const relativeCwd = path.relative(repoRoot, realpathSync(cwd));
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error("repository_check cwd escapes its Git repository.");
    }
    const snapshotCwd = path.join(target, relativeCwd);
    if (!existsSync(path.join(snapshotCwd, "package.json"))) {
      throw new Error("repository_check snapshot has no package.json at the project cwd.");
    }
    dependencyLinks.push(...linkDependencyRoots(repoRoot, target), ...linkDependencyRoots(cwd, snapshotCwd));
    return { repoRoot, path: target, cwd: snapshotCwd, dependencyLinks };
  } catch (error) {
    removeRepositoryCheckSnapshot({ repoRoot, path: target, cwd: target, dependencyLinks });
    throw error;
  }
}

/**
 * Symlink each installed dependency root that exists in `sourceDir` and is absent
 * from `targetDir`. Absent roots are skipped silently: a project without one is
 * not an error, and a snapshot that somehow already carries one is left alone
 * rather than replaced.
 */
function linkDependencyRoots(sourceDir: string, targetDir: string): string[] {
  const created: string[] = [];
  for (const name of REPOSITORY_CHECK_DEPENDENCY_ROOTS) {
    const source = path.join(sourceDir, name);
    const destination = path.join(targetDir, name);
    if (lstatIfPresent(source)?.isDirectory() !== true) continue;
    if (lstatIfPresent(destination) !== undefined) continue;
    symlinkSync(realpathSync(source), destination);
    created.push(destination);
  }
  return created;
}

function overlayCurrentSource(repoRoot: string, target: string): void {
  overlayGitSource(repoRoot, target);
}

function overlayGitSource(sourceRoot: string, target: string): void {
  const paths = nulSeparated(
    execFileSync("git", ["-C", sourceRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "buffer",
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  for (const relativePath of paths) {
    assertSnapshotPath(relativePath);
    const source = path.join(sourceRoot, relativePath);
    const destination = path.join(target, relativePath);
    const sourceStat = lstatIfPresent(source);
    if (sourceStat === undefined) {
      rmSync(destination, { force: true, recursive: true });
      continue;
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    if (sourceStat.isSymbolicLink()) {
      const link = readlinkSync(source);
      const resolved = path.resolve(path.dirname(source), link);
      if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}${path.sep}`)) {
        throw new Error(`repository_check refuses a source symlink outside the repository: ${relativePath}`);
      }
      rmSync(destination, { force: true, recursive: true });
      symlinkSync(link, destination);
      continue;
    }
    if (sourceStat.isDirectory() && isGitlinkPath(sourceRoot, relativePath)) {
      rmSync(destination, { force: true, recursive: true });
      mkdirSync(destination, { recursive: true });
      overlayGitSource(source, destination);
      continue;
    }
    if (!sourceStat.isFile()) {
      throw new Error(`repository_check cannot snapshot non-file source: ${relativePath}`);
    }
    rmSync(destination, { force: true, recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, sourceStat.mode);
  }
}

function isGitlinkPath(repoRoot: string, relativePath: string): boolean {
  const staged = execFileSync("git", ["-C", repoRoot, "ls-files", "--stage", "-z", "--", relativePath], {
    encoding: "buffer",
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
  return staged.startsWith("160000 ");
}

function removeRepositoryCheckSnapshot(snapshot: RepositoryCheckSnapshot): void {
  // Drop the borrowed dependency links FIRST. Both removal paths below unlink a
  // symlink rather than following it, but this snapshot points at the operator's
  // real `node_modules`, and that is not a place to rely on a subtlety.
  for (const link of snapshot.dependencyLinks) {
    try {
      unlinkSync(link);
    } catch {
      // Already gone, or never created: the removal below still owns the directory.
    }
  }
  try {
    execFileSync("git", ["-C", snapshot.repoRoot, "worktree", "remove", "--force", snapshot.path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    rmSync(snapshot.path, { force: true, recursive: true });
    try {
      execFileSync("git", ["-C", snapshot.repoRoot, "worktree", "prune"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // The check result remains valid; a future Git prune can remove stale administrative metadata.
    }
  }
}

function resolvePackageManager(cwd: string): string {
  const packageJson = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as unknown;
  if (isRecord(packageJson) && typeof packageJson.packageManager === "string") {
    const name = /^([a-z]+)@/u.exec(packageJson.packageManager)?.[1];
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return name;
  }
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "bun.lock")) || existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function nulSeparated(bytes: Buffer): string[] {
  const values = bytes.toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

function assertSnapshotPath(relativePath: string): void {
  if (relativePath === "" || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
    throw new Error(`repository_check received an unsafe Git path: ${relativePath}`);
  }
}

function lstatIfPresent(filePath: string): Stats | undefined {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function createGitReadTool(cwd: string): ReadOnlyAgentCustomTool {
  return {
    name: "git_read",
    label: "Git Read",
    description:
      'Run one allowlisted read-only Git query in the current project. Pass argv without the leading `git`, for example {"args":["diff","--stat","BASE...HEAD"]}. Mutation commands, shell syntax, output files, external diff, and textconv are rejected.',
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["args"],
      properties: {
        args: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ARGS,
          items: { type: "string", maxLength: MAX_ARG_LENGTH },
        },
      },
    },
    async execute(_toolCallId, input, signal) {
      const validation = validateGitReadInput(input);
      if (!validation.ok) return blocked(validation.reason);
      const [subcommand, ...rest] = validation.args;
      const hardenedArgs = [
        "--no-optional-locks",
        "-c",
        "core.pager=",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        subcommand!,
        ...(GIT_DIFF_SUBCOMMANDS.has(subcommand!) ? ["--no-ext-diff", "--no-textconv"] : []),
        ...rest,
      ];
      return executeGit(cwd, hardenedArgs, validation.args, signal);
    },
  };
}

function validateGitReadInput(input: unknown): ArgvValidation {
  const parsed = parseArgvInput(input, "git_read");
  if (!parsed.ok) return parsed;
  const args = parsed.args;
  const subcommand = args[0]!;
  if (!GIT_QUERY_SUBCOMMANDS.has(subcommand)) {
    return {
      ok: false,
      reason: `git_read blocks mutating or unsupported subcommand: ${subcommand}`,
    };
  }
  if (args.slice(1).some(blockedOption)) {
    return {
      ok: false,
      reason: "git_read blocks output, configuration, pager, signature, and external-process options.",
    };
  }
  if (subcommand === "branch" && !(args.length === 2 && args[1] === "--show-current")) {
    return { ok: false, reason: "git_read allows `branch` only for showing the current branch." };
  }
  return parsed;
}

function blockedOption(arg: string): boolean {
  return (
    arg === "--ext-diff" ||
    arg === "--textconv" ||
    arg === "--show-signature" ||
    arg === "--paginate" ||
    arg === "--config-env" ||
    arg === "-c" ||
    arg === "-O" ||
    arg === "--output" ||
    arg.startsWith("--output=") ||
    arg === "--open-files-in-pager" ||
    arg.startsWith("--open-files-in-pager=") ||
    arg.includes("%G")
  );
}

function executeGit(
  cwd: string,
  hardenedArgs: string[],
  requestedArgs: string[],
  signal: AbortSignal,
): Promise<ReadOnlyAgentToolResult> {
  return executeArgv("git", cwd, hardenedArgs, requestedArgs, signal, undefined, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    PAGER: "",
  });
}

function executeArgv(
  binary: string,
  cwd: string,
  execArgs: string[],
  requestedArgs: string[],
  signal: AbortSignal,
  timeout?: number,
  extraEnv?: Record<string, string>,
): Promise<ReadOnlyAgentToolResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      execArgs,
      {
        cwd,
        env: { ...process.env, ...extraEnv },
        maxBuffer: MAX_OUTPUT_BYTES,
        ...(timeout === undefined ? {} : { timeout }),
        signal,
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr]
          .filter((value) => value !== "")
          .join(stderr !== "" && stdout !== "" ? "\n" : "");
        if (error !== null) {
          resolve({
            content: [{ type: "text", text: output || error.message }],
            details: { args: requestedArgs, exitCode: typeof error.code === "number" ? error.code : undefined },
            isError: true,
          });
          return;
        }
        resolve({
          content: [{ type: "text", text: output }],
          details: { args: requestedArgs, exitCode: 0 },
        });
      },
    );
  });
}

function blocked(reason: string): ReadOnlyAgentToolResult {
  return {
    content: [{ type: "text", text: reason }],
    details: { blocked: true },
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
