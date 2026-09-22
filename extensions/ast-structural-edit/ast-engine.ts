import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Lang, parse, registerDynamicLanguage } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import pythonLanguage from "@ast-grep/lang-python";

export const AST_LANGUAGES = ["auto", "javascript", "typescript", "tsx", "python"] as const;
export type AstLanguage = (typeof AST_LANGUAGES)[number];

export interface AstMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  captures: Record<string, string>;
}
export interface Replacement {
  file: string;
  before: string;
  after: string;
  replacements: number;
  beforeHash: string;
}
export interface Preview {
  id: string;
  createdAt: string;
  replacements: Replacement[];
}

const previews = new Map<string, Preview>();
let pythonRegistered = false;

export async function astSearch(pattern: string, files: string[], language: AstLanguage = "auto"): Promise<AstMatch[]> {
  const captureNames = extractCaptureNames(pattern);
  const matches: AstMatch[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const root = parseFile(file, text, language);
    for (const node of findAllMatches(file, root.root(), pattern)) {
      const range = node.range();
      matches.push({
        file,
        line: range.start.line + 1,
        column: range.start.column + 1,
        text: node.text(),
        captures: getCaptures(node, captureNames),
      });
    }
  }
  return matches;
}

export async function astPreview(
  ops: Array<{ pat: string; out: string }>,
  files: string[],
  language: AstLanguage = "auto",
): Promise<Preview> {
  const replacements: Replacement[] = [];
  for (const file of files) {
    let before = await readFile(file, "utf8");
    let after = before;
    let count = 0;
    for (const op of ops) {
      const captureNames = extractCaptureNames(op.pat);
      const root = parseFile(file, after, language);
      const edits = findAllMatches(file, root.root(), op.pat).map((node) =>
        node.replace(renderReplacement(op.out, node, captureNames)),
      );
      if (edits.length === 0) continue;
      after = root.root().commitEdits(edits);
      count += edits.length;
    }
    if (count > 0) replacements.push({ file, before, after, replacements: count, beforeHash: sha256(before) });
  }
  const id = `ast_${Date.now().toString(36)}_${createHash("sha1")
    .update(JSON.stringify(replacements.map((r) => [r.file, r.beforeHash, r.replacements])))
    .digest("hex")
    .slice(0, 8)}`;
  const preview = { id, createdAt: new Date().toISOString(), replacements };
  previews.set(id, preview);
  return preview;
}

export function getPreview(id: string): Preview | undefined {
  return previews.get(id);
}

export function getLatestPendingPreview(projectRoot: string): Preview | undefined {
  const root = path.resolve(projectRoot);
  return [...previews.values()]
    .reverse()
    .find(
      (preview) =>
        preview.replacements.length > 0 &&
        preview.replacements.every((replacement) => isWithin(path.resolve(replacement.file), root)),
    );
}

export function discardPreview(id: string): boolean {
  return previews.delete(id);
}

export async function applyPreview(id: string, projectRoot: string): Promise<{ applied: number; stale: string[] }> {
  const preview = previews.get(id);
  if (!preview) throw new Error(`Unknown preview: ${id}`);
  const stale: string[] = [];
  for (const replacement of preview.replacements) {
    const resolved = path.resolve(replacement.file);
    if (!isWithin(resolved, path.resolve(projectRoot)))
      throw new Error(`Refusing to write outside project root: ${replacement.file}`);
    const live = await readFile(replacement.file, "utf8");
    if (sha256(live) !== replacement.beforeHash) stale.push(replacement.file);
  }
  if (stale.length) return { applied: 0, stale };
  for (const replacement of preview.replacements) await writeFile(replacement.file, replacement.after, "utf8");
  previews.delete(id);
  return { applied: preview.replacements.length, stale: [] };
}

export function astErrorMessage(error: unknown): string {
  return error instanceof AstEngineError
    ? error.message
    : `AST operation failed: ${String(error instanceof Error ? error.message : error)}`;
}

function parseFile(file: string, text: string, language: AstLanguage) {
  const lang = resolveLanguage(file, language);
  try {
    return parse(lang, text);
  } catch (error) {
    throw new AstEngineError(
      `Failed to parse ${file} as ${languageLabel(lang)}: ${String(error instanceof Error ? error.message : error)}`,
    );
  }
}

function resolveLanguage(file: string, language: AstLanguage): Lang | "python" {
  if (language !== "auto") {
    if (language === "python") registerPython();
    return languageToAstGrep(language);
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === ".ts") return Lang.TypeScript;
  if (ext === ".tsx" || ext === ".jsx") return Lang.Tsx;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return Lang.JavaScript;
  if (ext === ".py") {
    registerPython();
    return "python";
  }
  throw new AstEngineError(
    `Unsupported AST language for ${file}. Use one of: .js, .jsx, .mjs, .cjs, .ts, .tsx, .py, or pass a language override.`,
  );
}

function languageToAstGrep(language: Exclude<AstLanguage, "auto">): Lang | "python" {
  switch (language) {
    case "javascript":
      return Lang.JavaScript;
    case "typescript":
      return Lang.TypeScript;
    case "tsx":
      return Lang.Tsx;
    case "python":
      return "python";
  }
}

function registerPython(): void {
  if (pythonRegistered) return;
  registerDynamicLanguage({ python: pythonLanguage });
  pythonRegistered = true;
}

function languageLabel(language: Lang | "python"): string {
  return language === "python" ? "python" : language;
}

function renderReplacement(template: string, node: SgNode, captureNames: string[]): string {
  let output = template;
  for (const name of [...captureNames].sort((a, b) => b.length - a.length)) {
    const multiple = node
      .getMultipleMatches(name)
      .map((match) => match.text())
      .join("");
    const single = node.getMatch(name)?.text() ?? multiple;
    output = output.replaceAll(`$$$${name}`, multiple || single);
    output = output.replaceAll(`$${name}`, single);
  }
  return output;
}

function getCaptures(node: SgNode, captureNames: string[]): Record<string, string> {
  const captures: Record<string, string> = {};
  for (const name of captureNames) {
    const multiple = node.getMultipleMatches(name);
    captures[name] =
      multiple.length > 1
        ? multiple.map((match) => match.text()).join("")
        : (node.getMatch(name)?.text() ?? multiple[0]?.text() ?? "");
  }
  return captures;
}

function extractCaptureNames(pattern: string): string[] {
  const names = new Set<string>();
  for (const match of pattern.matchAll(/\${1,3}([A-Z][A-Z0-9_]*)/g)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}

function findAllMatches(file: string, node: SgNode, pattern: string): SgNode[] {
  try {
    return node.findAll(pattern);
  } catch (error) {
    throw new AstEngineError(
      `Invalid AST pattern for ${file}: ${String(error instanceof Error ? error.message : error)}`,
    );
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

class AstEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AstEngineError";
  }
}
