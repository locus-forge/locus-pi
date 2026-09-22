import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The internal-link rule for one published file set, shared by the `check:links`
 * gate and the package-boundary test so both answer to the same parser.
 *
 * Deliberately excluded: `http(s)` and every other scheme. Reaching them needs
 * the network, which no offline deterministic gate can own, and a link rotting
 * on somebody else's host is not a defect this repository can fix on demand.
 * What is checked is exactly what a published file set can be wrong about —
 * a relative path, and a heading anchor inside a file that ships with it.
 */

/**
 * One published surface: the repository-relative files a reader receives when
 * they consume this project that way. The npm tarball and the public repository
 * publish overlapping but different sets, and a relative link is only correct
 * against the surface the reader actually got.
 */
export interface PublishedSurface {
  /** Named in every finding, so a failure says which reader is stranded. */
  readonly name: string;
  /** Repository-relative POSIX paths this surface publishes. */
  readonly files: ReadonlySet<string>;
}

/** Every Markdown file this surface publishes, in stable order. */
export function surfaceMarkdownFiles(surface: PublishedSurface): string[] {
  return [...surface.files].filter((file) => file.endsWith(".md")).sort();
}

/**
 * Findings for links that resolve in this checkout and not inside `surface`.
 * `root` is the repository the surface is published from, and is read only to
 * explain a failure: whether the target is absent everywhere, is a directory,
 * or exists here and was left out of the surface are three different fixes.
 */
export function deadMarkdownLinks(root: string, surface: PublishedSurface): string[] {
  const anchorCache = new Map<string, ReadonlySet<string>>();
  const anchorsOf = (file: string): ReadonlySet<string> => {
    const cached = anchorCache.get(file);
    if (cached) return cached;
    const anchors = markdownAnchors(readFileSync(path.join(root, file), "utf8"));
    anchorCache.set(file, anchors);
    return anchors;
  };

  const dead: string[] = [];
  for (const file of surfaceMarkdownFiles(surface)) {
    const directory = path.posix.dirname(file);
    const lines = withoutFencedCode(readFileSync(path.join(root, file), "utf8")).split("\n");

    lines.forEach((line, index) => {
      for (const target of markdownLinkTargets(line)) {
        const problem = linkProblem({ root, surface, file, directory, target, anchorsOf });
        if (problem) dead.push(`${file}:${index + 1} -> ${target} (${problem})`);
      }
    });
  }
  return dead;
}

interface LinkContext {
  root: string;
  surface: PublishedSurface;
  /** The Markdown file the link was written in. */
  file: string;
  /** That file's directory, which relative targets resolve against. */
  directory: string;
  target: string;
  anchorsOf: (file: string) => ReadonlySet<string>;
}

function linkProblem({ root, surface, file, directory, target, anchorsOf }: LinkContext): string | undefined {
  // Anything carrying a scheme or an authority (`https:`, `mailto:`, `//host`)
  // leaves the surface, so no published file set can be wrong about it.
  if (target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(target)) return undefined;

  const hash = target.indexOf("#");
  const fragment = hash === -1 ? "" : decodeAnchor(target.slice(hash + 1));
  const linkPath = (hash === -1 ? target : target.slice(0, hash)).split("?")[0] ?? "";

  if (linkPath === "") {
    if (fragment === "") return undefined;
    return anchorsOf(file).has(fragment) ? undefined : `this file defines no anchor #${fragment}`;
  }
  if (linkPath.startsWith("/")) return "absolute path, resolvable nowhere";

  const resolved = path.posix.normalize(path.posix.join(directory, linkPath)).replace(/\/$/u, "");
  if (!surface.files.has(resolved)) {
    const absolute = path.join(root, resolved);
    const reason = !existsSync(absolute)
      ? "missing from the repository too"
      : statSync(absolute).isDirectory()
        ? "a directory, not a published file"
        : `in the repository but outside ${surface.name}`;
    return `${resolved} is ${reason}`;
  }

  // A fragment is only checkable against a document whose headings we can read.
  if (fragment === "" || !resolved.endsWith(".md")) return undefined;
  return anchorsOf(resolved).has(fragment) ? undefined : `${resolved} defines no anchor #${fragment}`;
}

function markdownLinkTargets(line: string): string[] {
  const targets: string[] = [];
  // Inline links and image embeds share one syntax; an optional title may follow
  // the destination, and the destination itself may be angle-bracketed.
  for (const match of line.matchAll(/\]\(\s*(<[^>]*>|[^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu))
    targets.push(match[1]!.replace(/^<|>$/gu, ""));
  // Reference definitions carry a destination the inline form never shows.
  const reference = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/u.exec(line);
  if (reference) targets.push(reference[1]!.replace(/^<|>$/gu, ""));
  return targets;
}

/** Blanks fenced code without moving any line, so reported line numbers stay true. */
function withoutFencedCode(source: string): string {
  let inside = false;
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/u.test(line)) {
        inside = !inside;
        return "";
      }
      return inside ? "" : line;
    })
    .join("\n");
}

/** Every anchor a renderer gives this document: one per heading, plus explicit HTML ids. */
function markdownAnchors(source: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const repeats = new Map<string, number>();

  for (const line of withoutFencedCode(source).split("\n")) {
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading) {
      const base = headingSlug(heading[2]!);
      const seen = repeats.get(base) ?? 0;
      repeats.set(base, seen + 1);
      anchors.add(normalizeAnchor(seen === 0 ? base : `${base}-${seen}`));
    }
    for (const attribute of line.matchAll(/\s(?:id|name)="([^"]+)"/gu)) anchors.add(normalizeAnchor(attribute[1]!));
  }
  return anchors;
}

// Everything a renderer drops from a heading before hyphenating it: ASCII
// punctuation plus the general and supplemental punctuation blocks (em dash,
// curly quotes). The space is absent on purpose — it becomes the hyphen. So are
// the hyphen and the underscore: a heading carries those into its anchor.
const SLUG_PUNCTUATION = /[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@\[\]^`{|}~]/gu;

function headingSlug(text: string): string {
  return (
    text
      // An inline link renders as its own text, so only that text reaches the slug.
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .toLowerCase()
      .replace(SLUG_PUNCTUATION, "")
      .replace(/ /gu, "-")
  );
}

/**
 * Renderers disagree about a hyphen produced by punctuation at either end of a
 * heading, so both sides are compared without their edge hyphens. The inside of
 * an anchor still has to match exactly: that is where the heading actually is.
 */
function normalizeAnchor(value: string): string {
  return value.replace(/^-+|-+$/gu, "");
}

function decodeAnchor(fragment: string): string {
  try {
    return normalizeAnchor(decodeURIComponent(fragment));
  } catch {
    return normalizeAnchor(fragment);
  }
}
