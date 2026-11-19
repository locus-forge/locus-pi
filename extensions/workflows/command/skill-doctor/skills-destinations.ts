import { lstatSync, readlinkSync, realpathSync } from "node:fs";
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

function sameLocation(a: ResolvedLocation, b: ResolvedLocation): boolean {
  if (a.identity.inode === "0" || a.identity.inode !== b.identity.inode || a.identity.device !== b.identity.device) {
    return false;
  }
  // A missing name cannot be probed without a write. Conservatively fold case in the tail.
  return (
    a.suffix.length === b.suffix.length &&
    a.suffix.every((name, index) => name.normalize().toLowerCase() === b.suffix[index]!.normalize().toLowerCase())
  );
}

export function resolveSkillDirectories(
  host: WorkflowSkillHost,
  scope: WorkflowSkillScope,
  userHome: string,
  projectRoot: string,
): Map<string, FileIdentity | undefined> {
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

  const project = resolveLocation(absolutePath(projectRoot));
  // Allow the personal layout when the project is HOME, without exempting any explicit Claude peer.
  const projectAtHome = scope === "user" && project && sameLocation(project, baseLocation);
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
    const resolved = resolveLocation(peer);
    if (resolved && sameLocation(selectedPeer, resolved)) {
      throw new Error(`Shared destination: ${selectedLogical} and ${peer} resolve to ${selected}`);
    }
  }
  return directories;
}
