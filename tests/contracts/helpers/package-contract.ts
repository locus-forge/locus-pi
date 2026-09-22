import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface PackageJson {
  name: string;
  files: string[];
  license: string;
  homepage: string;
  bugs: { url: string };
  pi: { extensions: string[] };
  repository: { url: string };
}

/**
 * The manifest shape schemas/extension-manifest.schema.json declares. Tests read manifests through
 * `readExtensionManifest` below rather than re-typing this per file, so a schema change lands
 * in one place; scripts/check-extension-manifests.ts owns the validation itself.
 */
export interface ExtensionManifest {
  id: string;
  agent: { name: string; description: string };
  runtimeRequirements: string[];
  stateUsed: string[];
  provides: { tools: string[]; commands: string[]; hooks: string[]; shortcuts?: string[] };
  uiLifecycle?: {
    commands?: Array<{ name: string; taxonomy: string[]; transient?: string[]; persistent: string[] }>;
    tools?: Array<{ name: string; taxonomy: string[]; transient?: string[]; persistent: string[] }>;
  };
  permissions: {
    filesystem: { read: string[]; write: string[] };
    subprocess: string[];
    network: string[];
    browser: boolean;
    models: boolean;
    ui: string[];
  };
  risk: string;
  docsPath: string;
  tests: string[];
}

/**
 * The committed artifact `npm run build:catalogs` writes. Contract tests compare the working tree
 * against it, so the two public catalogs are asserted from one machine-owned source instead of a list
 * re-typed per test; `npm run check:generated` owns the other half, artifact against documentation.
 */
export interface PublicCatalogs {
  extensions: Array<{
    id: string;
    tools: string[];
    commands: string[];
    hooks: string[];
    risk: string;
  }>;
  workflows: Array<{ name: string; namespace: string }>;
}

export const root = process.cwd();
export const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
export const publicCatalogs = JSON.parse(
  readFileSync(path.join(root, "dist/public-catalogs.json"), "utf8"),
) as PublicCatalogs;
export const extensionDocs = readFileSync(path.join(root, "docs/extensions.md"), "utf8");
export const workflowDocs = readFileSync(path.join(root, "docs/workflows.md"), "utf8");
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

export function extensionIdFromEntrypoint(entrypoint: string): string {
  const match = /^\.\/extensions\/([^/]+)\/index\.ts$/u.exec(entrypoint);
  if (!match?.[1]) throw new Error(`invalid default extension entrypoint: ${entrypoint}`);
  return match[1];
}

export function extensionManifestPath(id: string, packageRoot: string = root): string {
  return path.join(packageRoot, "extensions", id, "manifest.json");
}

export function readExtensionManifest(id: string, packageRoot: string = root): ExtensionManifest {
  return JSON.parse(readFileSync(extensionManifestPath(id, packageRoot), "utf8")) as ExtensionManifest;
}

/** Every manifest package.json#pi.extensions declares, in declaration order. */
export function defaultExtensionManifests(
  packageRoot: string = root,
): Array<{ id: string; manifestPath: string; manifest: ExtensionManifest }> {
  return pkg.pi.extensions.map(extensionIdFromEntrypoint).map((id) => ({
    id,
    manifestPath: extensionManifestPath(id, packageRoot),
    manifest: readExtensionManifest(id, packageRoot),
  }));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

function importedSpecifiers(filePath: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (node.arguments.length === 1 && argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      specifiers.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

export function featureDependencyGraph(extensionIds: string[]): Map<string, string[]> {
  return new Map(
    extensionIds.map((sourceId) => {
      const dependencies = new Set<string>();
      for (const filePath of sourceFiles(path.join(root, "extensions", sourceId))) {
        for (const specifier of importedSpecifiers(filePath)) {
          if (!specifier.startsWith(".")) continue;
          const [topLevel, targetId] = path
            .relative(root, path.resolve(path.dirname(filePath), specifier))
            .split(path.sep);
          if (topLevel === "extensions" && targetId && targetId !== "_shared" && targetId !== sourceId)
            dependencies.add(targetId);
        }
      }
      return [sourceId, [...dependencies].sort()] as const;
    }),
  );
}

export function topLevelCommands(commands: string[]): string[] {
  return [...new Set(commands.map((command) => command.trim().split(/\s+/u)[0]!).filter(Boolean))].sort();
}
