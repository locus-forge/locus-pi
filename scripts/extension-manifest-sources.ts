/**
 * scripts/extension-manifest-sources.ts — the one reader of the active extension manifest set.
 *
 * "Active" means exactly what `package.json#pi.extensions` declares: one `./extensions/<id>/index.ts`
 * entrypoint per extension, whose sibling `manifest.json` is that extension's declaration. Two gates
 * consume the same set and must never disagree about which files it contains:
 *
 *   scripts/check-extension-manifests.ts   validates each manifest against schemas/extension-manifest.schema.json
 *   scripts/build-public-catalogs.ts       renders the public extension catalog from the same manifests
 *
 * The two want opposite failure behavior — the checker reports every finding, the generator stops at the
 * first unreadable file — so this module resolves the set and classifies each entry without deciding what
 * a failure means. `extensionManifestSources` is the shared reader; `loadedExtensionManifests` is the
 * fail-fast projection for callers that cannot proceed on a partial set.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The only entrypoint spelling `package.json#pi.extensions` accepts. Group 1 is the directory. */
export const EXTENSION_ENTRYPOINT_PATTERN = /^\.\/extensions\/([^/]+)\/index\.ts$/u;

/** One declared entrypoint, resolved as far as it goes. `index` is its position in `pi.extensions`. */
export type ExtensionManifestSource =
  | { state: "loaded"; index: number; directory: string; file: string; manifest: Record<string, unknown> }
  | { state: "invalid-entrypoint"; index: number; entrypoint: unknown }
  | { state: "missing"; index: number; directory: string; file: string }
  | { state: "unreadable"; index: number; directory: string; file: string; reason: string };

export interface ExtensionManifestSet {
  /** `package.json#files` patterns, empty when absent. */
  packageFiles: string[];
  /** Set when `pi.extensions` is not an array at all, in which case `sources` is empty. */
  declarationProblem?: string;
  sources: ExtensionManifestSource[];
}

/** One loaded manifest, with the repository-relative path that names it in a diagnostic. */
export interface LoadedExtensionManifest {
  directory: string;
  file: string;
  manifest: Record<string, unknown>;
}

/** The repository-relative manifest path for one extension directory. */
export function extensionManifestFile(directory: string): string {
  return `extensions/${directory}/manifest.json`;
}

/** The extension directory one entrypoint names, or undefined when the entrypoint is not the accepted shape. */
export function extensionDirectoryFromEntrypoint(entrypoint: unknown): string | undefined {
  if (typeof entrypoint !== "string") return undefined;
  return EXTENSION_ENTRYPOINT_PATTERN.exec(entrypoint)?.[1];
}

/**
 * Resolve the active manifest set under `root` in declaration order. Every entry is classified rather
 * than thrown on, so a caller that reports findings can report all of them in one run.
 */
export function extensionManifestSources(root: string): ExtensionManifestSet {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
  const packageFiles =
    Array.isArray(packageJson.files) && packageJson.files.every((entry) => typeof entry === "string")
      ? (packageJson.files as string[])
      : [];
  const pi = packageJson.pi;
  const entrypoints = typeof pi === "object" && pi !== null ? (pi as Record<string, unknown>).extensions : undefined;
  if (!Array.isArray(entrypoints)) {
    return { packageFiles, declarationProblem: "must be an array of extension entrypoints", sources: [] };
  }

  const sources = entrypoints.map((entrypoint, index): ExtensionManifestSource => {
    const directory = extensionDirectoryFromEntrypoint(entrypoint);
    if (directory === undefined) return { state: "invalid-entrypoint", index, entrypoint };
    const file = extensionManifestFile(directory);
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) return { state: "missing", index, directory, file };
    try {
      const manifest = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
      if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
        return { state: "unreadable", index, directory, file, reason: "is not a JSON object" };
      }
      return { state: "loaded", index, directory, file, manifest: manifest as Record<string, unknown> };
    } catch (error) {
      return { state: "unreadable", index, directory, file, reason: (error as Error).message };
    }
  });
  return { packageFiles, sources };
}

/**
 * The same set, in declaration order, for a caller that cannot produce a correct result from a partial
 * one. Throws on the first entry that did not load, naming the file and the gate that explains it:
 * `npm run check:manifests` owns the manifest contract and is not re-implemented here.
 */
export function loadedExtensionManifests(root: string): LoadedExtensionManifest[] {
  const set = extensionManifestSources(root);
  if (set.declarationProblem) {
    throw new Error(`package.json: pi.extensions ${set.declarationProblem}; run \`npm run check:manifests\``);
  }
  return set.sources.map((source) => {
    switch (source.state) {
      case "loaded":
        return { directory: source.directory, file: source.file, manifest: source.manifest };
      case "invalid-entrypoint":
        throw new Error(
          `package.json: pi.extensions[${source.index}] is not an ./extensions/<id>/index.ts entrypoint: ` +
            `${String(source.entrypoint)}; run \`npm run check:manifests\``,
        );
      case "missing":
        throw new Error(
          `${source.file}: declared by package.json#pi.extensions but missing; run \`npm run check:manifests\``,
        );
      case "unreadable":
        throw new Error(`${source.file}: ${source.reason}; run \`npm run check:manifests\``);
    }
  });
}
