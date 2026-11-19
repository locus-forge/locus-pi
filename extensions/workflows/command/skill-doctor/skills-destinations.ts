import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import type { WorkflowSkillHost, WorkflowSkillScope } from "../skills.js";
import { readSkillEntry, sameObject, type FileIdentity } from "./skills-fs.js";

const HOST_DIRECTORIES = { codex: ".agents", claude: ".claude" } as const;
export const WORKFLOW_SKILL_HOSTS: readonly WorkflowSkillHost[] = ["codex", "claude"];

export function workflowSkillDestination(host: WorkflowSkillHost, base: string): string {
  return path.join(base, HOST_DIRECTORIES[host], "skills");
}

export function claudeOverride(userHome: string): string | undefined {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return configured && path.resolve(configured) !== path.join(userHome, ".claude")
    ? path.resolve(configured)
    : undefined;
}

interface ResolvedPeer {
  ancestor: string;
  suffix: string[];
}

// Keep the existing ancestor so equivalent spellings can match even before the skills directory exists.
function resolvePeer(destination: string, depth = 0): ResolvedPeer | undefined {
  if (depth >= 40) return undefined;
  try {
    return { ancestor: realpathSync(destination), suffix: [] };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") return undefined;
    if (code !== "ENOENT") throw error;
    const parent = path.dirname(destination);
    if (parent === destination) return undefined;
    const physicalParent = resolvePeer(parent, depth + 1);
    if (!physicalParent) return undefined;
    const entry = lstatSync(destination, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
      return resolvePeer(
        path.resolve(physicalParent.ancestor, ...physicalParent.suffix, readlinkSync(destination)),
        depth + 1,
      );
    }
    return { ...physicalParent, suffix: [...physicalParent.suffix, path.basename(destination)] };
  }
}

function sameDirectory(first: string, second: string): boolean {
  if (first === second) return true;
  const a = readSkillEntry(first, false);
  const b = readSkillEntry(second, false);
  return a?.kind === "directory" && b?.kind === "directory" && sameObject(a.identity, b.identity);
}

export function resolveSkillDirectories(
  host: WorkflowSkillHost,
  scope: WorkflowSkillScope,
  userHome: string,
  projectRoot: string,
): Map<string, FileIdentity | undefined> {
  const selectedBase = scope === "user" ? userHome : projectRoot;
  const base = realpathSync(selectedBase);
  const selected = workflowSkillDestination(host, base);
  const selectedLogical = workflowSkillDestination(host, selectedBase);
  const directories = new Map<string, FileIdentity | undefined>();
  for (const directory of [base, path.dirname(selected), selected]) {
    const entry = readSkillEntry(directory, false);
    if (entry?.kind === "link") {
      const peer = resolvePeer(directory);
      const target = peer ? path.join(peer.ancestor, ...peer.suffix) : entry.value;
      throw new Error(`Destination redirected: ${directory} → ${target}`);
    }
    if (entry && entry.kind !== "directory") throw new Error(`Destination is not a directory: ${directory}`);
    directories.set(directory, entry?.identity);
  }
  const selectedPeer = resolvePeer(selected);
  if (!selectedPeer) throw new Error(`Cannot resolve destination: ${selectedLogical}`);

  const project = resolvePeer(projectRoot);
  // Allow the personal layout when the project is HOME, without exempting any explicit Claude peer.
  const projectAtHome =
    scope === "user" && project && project.suffix.length === 0 && sameDirectory(project.ancestor, base);
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
  if (alternate) peers.push(path.join(alternate, "skills"));
  for (const peer of peers) {
    const resolved = resolvePeer(peer);
    if (
      resolved &&
      path.join(...resolved.suffix) === path.join(...selectedPeer.suffix) &&
      sameDirectory(selectedPeer.ancestor, resolved.ancestor)
    ) {
      throw new Error(`Shared destination: ${selectedLogical} and ${peer} resolve to ${selected}`);
    }
  }
  return directories;
}
