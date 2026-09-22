/**
 * Workflow workspace identity, confinement, and file proofs.
 *
 * This module owns where a workflow workspace lives (the current and retired
 * named roots), its physical identity under the project root, and the evidence
 * proving that a workspace file or primary file is the same regular file that
 * was opened. Durable fenced state keyed by that identity is owned separately
 * by `workflow-workspace-state.ts`, which imports this module and never the
 * other way around.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  assertWorkflowRunId,
  WORKFLOW_PLANS_DIRNAME,
  WORKFLOW_ROOT_DIRNAME,
  WORKFLOW_WORKSPACES_DIRNAME,
} from "./workflow-run-layout.js";

const OUTPUT_COMPONENT_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]{0,199}";
const OUTPUT_COMPONENT = new RegExp(`^${OUTPUT_COMPONENT_SOURCE}$`, "u");
const WORKFLOW_LEGACY_WORKSPACES_RELATIVE_ROOT = [WORKFLOW_ROOT_DIRNAME, WORKFLOW_PLANS_DIRNAME].join("/");
const WORKFLOW_WORKSPACES_RELATIVE_ROOT = [WORKFLOW_ROOT_DIRNAME, WORKFLOW_WORKSPACES_DIRNAME].join("/");
/** Единственный задачный корень с ведущей точкой, открытый для `--output-dir`. */
const WORKFLOW_TASKS_RELATIVE_ROOT = ".tasks";
/**
 * TypeBox-compatible grammar for the same confined path accepted by the runtime.
 *
 * Разрешено: обычные видимые компоненты, workspace-корни `.locus-pi/{workspaces,plans}/<leaf>`
 * и произвольная глубина под единственным задачным корнем `.tasks/`.
 * Почему: ведущий якорь [A-Za-z0-9] появился как anti-traversal-защита от `.`/`..`
 * (см. isSimpleWorkflowRunId, 347cdd6), а не как политика скрытых каталогов;
 * `.tasks/<task>/artifacts` — легитимная пользовательская поверхность артефактов.
 * Остаётся запрещено: любой другой каталог с ведущей точкой (`.git`, `.ssh`, `.env`,
 * произвольные пути внутри `.locus-pi/`), `.`/`..` в любом компоненте, обратные слэши,
 * NUL, пустые компоненты. Confinement (isWorkflowPathWithinRoot), physical-realpath-обход
 * и запрет symlink (ensureDirectoryWithoutSymlinks) не ослабляются — грамматика их не заменяет.
 *
 * Паттерн и `assertWorkflowOutputDirPath` описывают одно множество путей; менять их врозь нельзя.
 */
export const WORKFLOW_OUTPUT_DIR_PATTERN =
  `^(?:(?:${OUTPUT_COMPONENT_SOURCE})(?:/(?:${OUTPUT_COMPONENT_SOURCE}))*|` +
  `\\${WORKFLOW_ROOT_DIRNAME}/(?:${WORKFLOW_WORKSPACES_DIRNAME}|${WORKFLOW_PLANS_DIRNAME})/` +
  `(?:${OUTPUT_COMPONENT_SOURCE})|` +
  `\\${WORKFLOW_TASKS_RELATIVE_ROOT}/(?:${OUTPUT_COMPONENT_SOURCE})(?:/(?:${OUTPUT_COMPONENT_SOURCE}))*)$`;
// No aggregate character bound on outputDir. Each component is still checked against
// the safe-component alphabet and the whole path must stay confined to the project, so
// what is left is the filesystem's own limit on a path — which the filesystem reports
// itself, in its own words, instead of this module inventing a number for it.
export const WORKFLOW_RUN_NAME_MAX_CHARS = 200;
export const WORKFLOW_RUN_NAME_PATTERN = `^${OUTPUT_COMPONENT_SOURCE}$`;

export interface WorkflowOutputDirectory {
  /** Project-relative path, with `/` separators. */
  relativePath: string;
  /** Absolute path exposed to filesystem-capable children. */
  absolutePath: string;
  /** Canonical physical target after confined creation. Host coordination only. */
  physicalPath: string;
  /** Canonical project-relative physical identity used for leases and checkpoints. */
  identity: string;
}

/** Host-only source workspace proof used by operator-handoff continuation. */
export interface WorkflowWorkspaceReuseBinding {
  relativePath: string;
  absolutePath: string;
  physicalPath: string;
  physicalIdentity: string;
  explicit: boolean;
}

export interface WorkflowPrimaryFileReference {
  relativePath: string;
  absolutePath: string;
  sha256: string;
  bytes: number;
}

function defaultWorkflowOutputDir(
  projectRoot: string,
  workingDirectory: string,
  workflowName: string,
  runId: string | undefined,
): string {
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalWorkingDirectory = path.resolve(workingDirectory);
  if (!isWorkflowPathWithinRoot(lexicalRoot, lexicalWorkingDirectory)) {
    throw new Error("workflow working directory must be inside the project root");
  }
  let physicalRoot: string;
  let physicalWorkingDirectory: string;
  try {
    physicalRoot = realpathSync(lexicalRoot);
    physicalWorkingDirectory = realpathSync(lexicalWorkingDirectory);
  } catch (error) {
    throw new Error(`workflow working directory physical identity is unavailable: ${String(error)}`);
  }
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalWorkingDirectory)) {
    throw new Error("workflow working directory physical target escapes the project root");
  }
  const workspaceRunId = assertWorkflowRunId(runId);
  const workflowSlug = workflowName.replaceAll("/", "-");
  const readableLeaf = `${workspaceRunId}-${workflowSlug}`;
  const leaf = OUTPUT_COMPONENT.test(readableLeaf)
    ? readableLeaf
    : `${workspaceRunId}-workflow-${createHash("sha256").update(workflowName).digest("hex")}`;
  return `${WORKFLOW_WORKSPACES_RELATIVE_ROOT}/${leaf}`;
}

export interface WorkflowOutputDirectoryPath {
  /** Project-relative path, with `/` separators. */
  relativePath: string;
  /** Absolute lexical path under the project root. */
  absolutePath: string;
}

/** Resolve a confined project-relative output path without touching the filesystem. */
export function resolveWorkflowOutputDirectoryPath(
  projectRoot: string,
  requested: string | undefined,
  workflowName: string,
  workingDirectory: string,
  options: { runId?: string } = {},
): WorkflowOutputDirectoryPath {
  const relativePath =
    requested === undefined
      ? defaultWorkflowOutputDir(projectRoot, workingDirectory, workflowName, options.runId)
      : assertWorkflowOutputDirPath(normalizeRequestedOutputDir(projectRoot, workingDirectory, requested));
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  if (!isWorkflowPathWithinRoot(root, absolutePath)) throw new Error("workflow outputDir escapes the project root");
  return { relativePath, absolutePath };
}

function workflowWorkspaceLeaf(runName: unknown): string {
  if (typeof runName !== "string" || !OUTPUT_COMPONENT.test(runName)) {
    throw new Error("workflow runName must be one safe folder name");
  }
  return runName;
}

/**
 * Select one named workspace without moving its physical target.
 *
 * Existing legacy workspaces stay under `.locus-pi/plans/`, preserving the
 * physical identity that owns their checkpoint namespace. A name present in
 * both roots is ambiguous and fails before workflow code can run.
 */
export function resolveNamedWorkflowWorkspacePath(projectRoot: string, runName: unknown): string {
  const leaf = workflowWorkspaceLeaf(runName);
  const root = path.resolve(projectRoot);
  const currentRelativePath = `${WORKFLOW_WORKSPACES_RELATIVE_ROOT}/${leaf}`;
  const legacyRelativePath = `${WORKFLOW_LEGACY_WORKSPACES_RELATIVE_ROOT}/${leaf}`;
  const currentPath = path.resolve(root, ...currentRelativePath.split("/"));
  const legacyPath = path.resolve(root, ...legacyRelativePath.split("/"));
  const currentExists = lstatSync(currentPath, { throwIfNoEntry: false }) !== undefined;
  const legacyExists = lstatSync(legacyPath, { throwIfNoEntry: false }) !== undefined;
  if (currentExists && legacyExists) {
    throw new Error(
      `workflow runName ${JSON.stringify(leaf)} is ambiguous: both ${currentRelativePath} and ${legacyRelativePath} exist`,
    );
  }
  return legacyExists ? legacyRelativePath : currentRelativePath;
}

/** Validate one run name without selecting or touching either workspace root. */
export function assertWorkflowRunName(runName: unknown): string {
  return workflowWorkspaceLeaf(runName);
}

/** True only for the retired workspace namespace; callers must never create it. */
export function isLegacyWorkflowWorkspacePath(relativePath: string): boolean {
  return relativePath.startsWith(`${WORKFLOW_LEGACY_WORKSPACES_RELATIVE_ROOT}/`);
}

function normalizeRequestedOutputDir(projectRoot: string, workingDirectory: string, requested: string): string {
  if (typeof requested !== "string") {
    throw new Error("workflow outputDir must be a non-empty trimmed path");
  }
  const project = path.resolve(projectRoot);
  let absolute: string | undefined;
  if (path.isAbsolute(requested) || path.win32.isAbsolute(requested)) {
    absolute = path.resolve(requested);
  } else if (requested === "." || requested.startsWith("./") || requested.startsWith("../")) {
    absolute = path.resolve(workingDirectory, requested);
  }
  if (absolute === undefined) return requested;
  if (!isWorkflowPathWithinRoot(project, absolute) || absolute === project) {
    throw new Error("workflow outputDir escapes the project root");
  }
  return path.relative(project, absolute).split(path.sep).join("/");
}

/** Resolve and create a confined project-relative output directory. */
export function resolveWorkflowOutputDirectory(
  projectRoot: string,
  requested: string | undefined,
  workflowName: string,
  workingDirectory: string,
  options: { create?: boolean; runId?: string } = {},
): WorkflowOutputDirectory {
  const { relativePath, absolutePath } = resolveWorkflowOutputDirectoryPath(
    projectRoot,
    requested,
    workflowName,
    workingDirectory,
    options.runId === undefined ? {} : { runId: options.runId },
  );
  const root = path.resolve(projectRoot);
  if (options.create === false) assertExistingDirectoryWithoutSymlinks(root, absolutePath);
  else ensureDirectoryWithoutSymlinks(root, absolutePath);
  let physicalRoot: string;
  let physicalPath: string;
  try {
    physicalRoot = realpathSync(root);
    physicalPath = realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`workflow outputDir physical identity is unavailable: ${String(error)}`);
  }
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalPath)) {
    throw new Error("workflow outputDir physical target escapes the project root");
  }
  const identity = path.relative(physicalRoot, physicalPath).split(path.sep).join("/");
  if (identity === "") throw new Error("workflow outputDir must not resolve to the project root");
  return { relativePath, absolutePath, physicalPath, identity };
}

/** Resolve a previously verified workspace without reclassifying it as public outputDir. */
export function resolveWorkflowOutputDirectoryForReuse(
  projectRoot: string,
  binding: WorkflowWorkspaceReuseBinding,
  options: { create?: boolean } = {},
): WorkflowOutputDirectory {
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, ...binding.relativePath.split("/"));
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  if (relativePath === "" || relativePath !== binding.relativePath || !isWorkflowPathWithinRoot(root, absolutePath)) {
    throw new Error("workflow reused workspace identity is not project-relative");
  }
  if (path.resolve(binding.absolutePath) !== absolutePath) {
    throw new Error("workflow reused workspace lexical identity changed");
  }
  if (options.create === false) assertExistingDirectoryWithoutSymlinks(root, absolutePath);
  else ensureDirectoryWithoutSymlinks(root, absolutePath);
  let physicalRoot: string;
  let physicalPath: string;
  try {
    physicalRoot = realpathSync(root);
    physicalPath = realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`workflow reused workspace physical identity is unavailable: ${String(error)}`);
  }
  const identity = path.relative(physicalRoot, physicalPath).split(path.sep).join("/");
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalPath) || identity !== binding.physicalIdentity) {
    throw new Error("workflow reused workspace physical identity changed");
  }
  if (physicalPath !== binding.physicalPath) {
    throw new Error("workflow reused workspace physical target changed");
  }
  return { relativePath, absolutePath, physicalPath, identity };
}

/** Preserve an existing regular workspace file or create it empty without following symlinks. */
export function ensureWorkflowWorkspaceFile(output: WorkflowOutputDirectory, relativeFile: string): string {
  const normalized = assertRelativeOutputPath(relativeFile, "workspace file");
  const absolutePath = path.resolve(output.absolutePath, ...normalized.split("/"));
  if (!isWorkflowPathWithinRoot(output.absolutePath, absolutePath)) {
    throw new Error("workflow workspace file escapes outputDir");
  }

  let fd: number;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    try {
      fd = openSync(
        absolutePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o666,
      );
    } catch (createError) {
      if (!isNodeError(createError, "EEXIST")) throw createError;
      fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
  }

  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`workflow workspace file is not a regular file: ${normalized}`);
    const physicalWorkspace = realpathSync(output.absolutePath);
    if (physicalWorkspace !== output.physicalPath) {
      throw new Error("workflow workspace changed while its input file was being opened");
    }
    const selected = lstatSync(absolutePath);
    const physicalFile = realpathSync(absolutePath);
    if (
      selected.isSymbolicLink() ||
      !selected.isFile() ||
      opened.dev !== selected.dev ||
      opened.ino !== selected.ino ||
      !isWorkflowPathWithinRoot(output.physicalPath, physicalFile)
    ) {
      throw new Error(`workflow workspace file changed while it was being opened: ${normalized}`);
    }
  } finally {
    closeSync(fd);
  }
  return absolutePath;
}

/** Validate a regular, non-empty, non-symlink file inside the workflow workspace. */
export function referenceWorkflowPrimaryFile(
  output: WorkflowOutputDirectory,
  relativeFile: string,
): WorkflowPrimaryFileReference {
  return readWorkflowPrimaryFile(output, relativeFile).reference;
}

/** Read once from the proven descriptor; callers check and retain these exact bytes. */
export function readWorkflowPrimaryFile(
  output: WorkflowOutputDirectory,
  relativeFile: string,
): { reference: WorkflowPrimaryFileReference; content: Buffer } {
  const normalized = assertRelativeOutputPath(relativeFile, "primary file");
  const absolutePath = path.resolve(output.absolutePath, ...normalized.split("/"));
  if (!isWorkflowPathWithinRoot(output.absolutePath, absolutePath)) {
    throw new Error("workflow primary file escapes outputDir");
  }
  assertExistingPathWithoutSymlinks(output.absolutePath, absolutePath);
  const fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assertOpenedPrimaryFileIdentity(output, absolutePath, stat);
    if (!stat.isFile()) throw new Error(`workflow primary file is not a regular file: ${normalized}`);
    if (stat.size < 1) throw new Error(`workflow primary file is empty: ${normalized}`);
    const bytes = readFileSync(fd);
    assertOpenedPrimaryFileIdentity(output, absolutePath, stat);
    return {
      content: bytes,
      reference: {
        relativePath: normalized,
        absolutePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      },
    };
  } finally {
    closeSync(fd);
  }
}

/** Re-read a checkpointed primary file and return a current safe reference. */
export function revalidateWorkflowPrimaryFile(
  output: WorkflowOutputDirectory,
  expected: WorkflowPrimaryFileReference,
): WorkflowPrimaryFileReference {
  const current = referenceWorkflowPrimaryFile(output, expected.relativePath);
  if (current.sha256 !== expected.sha256 || current.bytes !== expected.bytes) {
    throw new Error(`workflow primary file changed since checkpoint: ${expected.relativePath}`);
  }
  return current;
}

function resolveWorkflowOutputPhysicalPathWithoutCreation(
  projectRoot: string,
  physicalRoot: string,
  absolutePath: string,
): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("workflow outputDir escapes the project root");
  }
  let lexicalCurrent = projectRoot;
  let physicalCurrent = physicalRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    lexicalCurrent = path.join(lexicalCurrent, part);
    const stat = lstatSync(lexicalCurrent, { throwIfNoEntry: false });
    if (stat === undefined) {
      return path.join(physicalCurrent, path.basename(lexicalCurrent), path.relative(lexicalCurrent, absolutePath));
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`workflow outputDir is not a regular directory: ${lexicalCurrent}`);
    }
    physicalCurrent = realpathSync(lexicalCurrent);
    if (!isWorkflowPathWithinRoot(physicalRoot, physicalCurrent)) {
      throw new Error("workflow outputDir physical target escapes the project root");
    }
  }
  return physicalCurrent;
}

/**
 * Derive the project-relative physical identity of a lexical workspace candidate
 * that does not have to exist yet.
 *
 * Durable-state owners consume this identity; they never compute one themselves.
 */
export function resolveWorkflowOutputPhysicalIdentityWithoutCreation(
  projectRoot: string,
  absolutePath: string,
): string {
  const root = path.resolve(projectRoot);
  const physicalRoot = realpathSync(root);
  const physicalPath = resolveWorkflowOutputPhysicalPathWithoutCreation(root, physicalRoot, absolutePath);
  const identity = path.relative(physicalRoot, physicalPath).split(path.sep).join("/");
  if (identity === "" || identity.startsWith("../") || path.isAbsolute(identity)) {
    throw new Error("workflow outputDir physical target escapes the project root");
  }
  return identity;
}

function assertRelativeOutputPath(value: unknown, label = "outputDir"): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new Error(`workflow ${label} must be a non-empty trimmed path`);
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`workflow ${label} must be project-relative`);
  }
  if (value.includes("\\")) throw new Error(`workflow ${label} must use forward-slash separators`);
  const parts = value.split("/");
  if (parts.some((part) => !OUTPUT_COMPONENT.test(part))) {
    throw new Error(`workflow ${label} contains an unsafe path component: ${JSON.stringify(value)}`);
  }
  return parts.join("/");
}

/** Validate the complete public outputDir value contract before filesystem access. */
export function assertWorkflowOutputDirPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("workflow outputDir must be a non-empty trimmed path");
  }
  const workspaceRoot = [WORKFLOW_WORKSPACES_RELATIVE_ROOT, WORKFLOW_LEGACY_WORKSPACES_RELATIVE_ROOT].find(
    (candidate) => value.startsWith(`${candidate}/`),
  );
  if (workspaceRoot !== undefined) {
    const workspaceName = value.slice(workspaceRoot.length + 1);
    if (!OUTPUT_COMPONENT.test(workspaceName)) {
      throw new Error(`workflow outputDir contains an unsafe workspace path component: ${JSON.stringify(value)}`);
    }
    return value;
  }
  if (value === WORKFLOW_TASKS_RELATIVE_ROOT || value.startsWith(`${WORKFLOW_TASKS_RELATIVE_ROOT}/`)) {
    const rest = value.slice(WORKFLOW_TASKS_RELATIVE_ROOT.length + 1);
    if (rest === "") {
      throw new Error(`workflow outputDir must name a directory under ${WORKFLOW_TASKS_RELATIVE_ROOT}`);
    }
    assertRelativeOutputPath(rest);
    return value;
  }
  return assertRelativeOutputPath(value);
}

/**
 * Validate a physical workspace identity persisted by the runtime.
 *
 * This is deliberately separate from the public `outputDir` grammar: default
 * workspaces inherit verified working-directory components, which may contain
 * spaces or exceed the caller-facing 400-character bound. Physical
 * containment is proved by the resolver before persistence and again by
 * resume/continuation code; this parser only preserves the project-relative
 * representation and rejects path syntax that could escape that proof.
 */
export function assertWorkflowPhysicalWorkspaceIdentity(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error("workflow workspace physical identity must be a non-empty project-relative path");
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("workflow workspace physical identity must be project-relative");
  }
  if (value.includes("\\") || value.includes("\0")) {
    throw new Error("workflow workspace physical identity contains an unsafe path component");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`workflow workspace physical identity contains an unsafe path component: ${JSON.stringify(value)}`);
  }
  return parts.join("/");
}

/** Create every missing component of a confined path, refusing any symlink on the way. */
export function ensureDirectoryWithoutSymlinks(root: string, target: string): void {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`workflow output path contains a symlink: ${current}`);
      if (!stat.isDirectory()) throw new Error(`workflow output path component is not a directory: ${current}`);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        mkdirSync(current);
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error(`workflow output path contains a symlink: ${current}`);
        if (!stat.isDirectory()) throw new Error(`workflow output path component is not a directory: ${current}`);
      }
    }
  }
}

function assertExistingPathWithoutSymlinks(root: string, target: string): void {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`workflow primary file path contains a symlink: ${current}`);
  }
}

function assertExistingDirectoryWithoutSymlinks(root: string, target: string): void {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) throw new Error(`workflow outputDir physical identity is unavailable: ${current}`);
    if (stat.isSymbolicLink()) throw new Error(`workflow output path contains a symlink: ${current}`);
    if (!stat.isDirectory()) throw new Error(`workflow output path component is not a directory: ${current}`);
  }
}

function assertOpenedPrimaryFileIdentity(
  output: WorkflowOutputDirectory,
  absolutePath: string,
  opened: ReturnType<typeof fstatSync>,
): void {
  const physicalWorkspace = realpathSync(output.absolutePath);
  if (physicalWorkspace !== output.physicalPath) {
    throw new Error("workflow primary file workspace changed while it was being opened");
  }
  const physicalFile = realpathSync(absolutePath);
  if (!isWorkflowPathWithinRoot(output.physicalPath, physicalFile)) {
    throw new Error("workflow primary file escapes the physical outputDir");
  }
  const selected = lstatSync(absolutePath);
  if (selected.isSymbolicLink() || !selected.isFile() || opened.dev !== selected.dev || opened.ino !== selected.ino) {
    throw new Error(`workflow primary file changed while it was being opened: ${absolutePath}`);
  }
}

export function isWorkflowPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Narrow a thrown value to one errno-coded filesystem failure. */
export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
