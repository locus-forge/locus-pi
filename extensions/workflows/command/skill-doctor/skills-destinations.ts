import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import type { WorkflowSkillHost, WorkflowSkillScope } from "../skills.js";
import { readSkillEntry, type FileIdentity } from "./skills-fs.js";

const HOST_DIRECTORIES = { codex: ".agents", claude: ".claude" } as const;
export const WORKFLOW_SKILL_HOSTS: readonly WorkflowSkillHost[] = ["codex", "claude"];

function appendPath(base: string, tail: string): string {
  return `${base}${base.endsWith(path.sep) ? "" : path.sep}${tail}`;
}

function absolutePath(file: string, base = process.cwd()): string {
  return path.isAbsolute(file) ? file : appendPath(base, file);
}

export function workflowSkillDestination(host: WorkflowSkillHost, base: string): string {
  return appendPath(absolutePath(base), path.join(HOST_DIRECTORIES[host], "skills"));
}

export function claudeOverride(userHome: string): string | undefined {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (!configured) return undefined;
  const alternate = absolutePath(configured);
  return alternate === appendPath(absolutePath(userHome), ".claude") ? undefined : alternate;
}

interface ResolvedLocation {
  ancestor: string;
  identity: FileIdentity;
  suffix: string[];
}

function resolveLocation(destination: string, links = 0): ResolvedLocation | undefined {
  if (links >= 40) throw new Error(`Too many symlink redirects: ${destination}`);
  let ancestor: string;
  try {
    // Resolve existing prefixes using filesystem traversal, including ".." after a link.
    ancestor = realpathSync.native(destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") return undefined;
    if (code !== "ENOENT") throw error;
    const parent = path.dirname(destination);
    if (parent === destination) return undefined;
    const resolved = resolveLocation(parent, links);
    if (!resolved) return undefined;
    const entry = lstatSync(destination, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
      return resolveLocation(absolutePath(readlinkSync(destination), resolved.ancestor), links + 1);
    }
    const name = path.basename(destination);
    if (name === ".." || name === ".") {
      throw new Error(`Cannot resolve ${destination} through a missing path component`);
    }
    return { ...resolved, suffix: [...resolved.suffix, name] };
  }
  const entry = readSkillEntry(ancestor, false);
  return entry?.kind === "directory" ? { ancestor, identity: entry.identity, suffix: [] } : undefined;
}

function caseSensitive(directory: string): boolean | undefined {
  // Observe an existing name without writing a probe into a skills tree.
  const entries = readdirSync(directory);
  for (const name of entries) {
    const variant = name.replace(/[a-z]/iu, (letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
    );
    if (variant === name) continue;
    if (entries.includes(variant)) return true;
    return lstatSync(appendPath(directory, variant), { throwIfNoEntry: false }) === undefined;
  }
  return undefined;
}

function compareLocation(a: ResolvedLocation, b: ResolvedLocation): "shared" | "distinct" | "uncertain" {
  if (
    a.identity.inode === "0" ||
    a.identity.inode !== b.identity.inode ||
    a.identity.device !== b.identity.device ||
    a.suffix.length !== b.suffix.length
  )
    return "distinct";
  if (a.suffix.every((name, index) => name === b.suffix[index])) return "shared";
  if (a.suffix.some((name, index) => name.normalize().toLowerCase() !== b.suffix[index]!.normalize().toLowerCase())) {
    return "distinct";
  }
  const sensitive = caseSensitive(a.ancestor);
  return sensitive === undefined ? "uncertain" : sensitive ? "distinct" : "shared";
}

export function resolveSkillDirectories(
  host: WorkflowSkillHost,
  scope: WorkflowSkillScope,
  userHome: string,
  projectRoot: string,
): { directories: Map<string, FileIdentity | undefined>; peerBlock?: string } {
  const selectedBase = scope === "user" ? userHome : projectRoot;
  const baseLocation = resolveLocation(absolutePath(selectedBase));
  if (!baseLocation || baseLocation.suffix.length) throw new Error(`Cannot resolve destination base: ${selectedBase}`);
  const base = baseLocation.ancestor;
  const selected = workflowSkillDestination(host, base);
  const selectedLogical = workflowSkillDestination(host, selectedBase);
  const directories = new Map<string, FileIdentity | undefined>();
  for (const directory of [base, path.dirname(selected), selected]) {
    const entry = readSkillEntry(directory, false);
    if (entry?.kind === "link") {
      const peer = resolveLocation(directory);
      const target = peer ? path.join(peer.ancestor, ...peer.suffix) : entry.value;
      throw new Error(`Destination redirected: ${directory} → ${target}`);
    }
    if (entry && entry.kind !== "directory") throw new Error(`Destination is not a directory: ${directory}`);
    directories.set(directory, entry?.identity);
  }
  const selectedPeer = resolveLocation(selected);
  if (!selectedPeer) throw new Error(`Cannot resolve destination: ${selectedLogical}`);

  // Allow the personal layout when the project is HOME, without exempting any explicit Claude peer.
  let projectAtHome = false;
  if (scope === "user") {
    try {
      const project = resolveLocation(absolutePath(projectRoot));
      projectAtHome = project !== undefined && compareLocation(project, baseLocation) === "shared";
    } catch {
      // The peer check below reports the inaccessible project path.
    }
  }
  const peers = (
    [
      ["user", userHome],
      ["project", projectRoot],
    ] as const
  ).flatMap(([peerScope, root]) =>
    WORKFLOW_SKILL_HOSTS.filter(
      (peerHost) => peerHost !== host || (peerScope !== scope && !(peerScope === "project" && projectAtHome)),
    ).map((peerHost) => workflowSkillDestination(peerHost, root)),
  );
  const alternate = claudeOverride(userHome);
  if (alternate) peers.push(appendPath(alternate, "skills"));
  for (const peer of peers) {
    try {
      const resolved = resolveLocation(peer);
      if (!resolved) continue;
      const relation = compareLocation(selectedPeer, resolved);
      if (relation === "shared") {
        return { directories, peerBlock: `Shared destination: ${selectedLogical} and ${peer} resolve to ${selected}` };
      }
      if (relation === "uncertain") {
        return {
          directories,
          peerBlock: `Cannot determine whether ${selected} and ${peer} are shared: case rules for the missing path are unknown.`,
        };
      }
    } catch (error) {
      return { directories, peerBlock: `Cannot rule out a shared destination via ${peer}: ${String(error)}` };
    }
  }
  return { directories };
}
