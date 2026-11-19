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

// realpath cannot describe absent tails, including a dangling directory symlink.
function resolvePeer(destination: string, depth = 0): string | undefined {
  if (depth >= 40) return undefined;
  try {
    return realpathSync(destination);
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
      return resolvePeer(path.resolve(physicalParent, readlinkSync(destination)), depth + 1);
    }
    return path.join(physicalParent, path.basename(destination));
  }
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
      throw new Error(`Destination redirected: ${directory} → ${resolvePeer(directory) ?? entry.value}`);
    }
    if (entry && entry.kind !== "directory") throw new Error(`Destination is not a directory: ${directory}`);
    directories.set(directory, entry?.identity);
  }
  const peers = [userHome, projectRoot].flatMap((root) =>
    WORKFLOW_SKILL_HOSTS.map((peerHost) => workflowSkillDestination(peerHost, root)),
  );
  const alternate = claudeOverride(userHome);
  if (alternate) peers.push(path.join(alternate, "skills"));
  // User writes to the personal folder remain available when the project is HOME itself.
  const skip = scope === "user" && userHome === projectRoot ? peers.filter((peer) => peer !== selectedLogical) : peers;
  let skippedSelected = false;
  for (const peer of skip) {
    if (!skippedSelected && peer === selectedLogical) {
      skippedSelected = true;
      continue;
    }
    const physicalPeer = resolvePeer(peer);
    if (!physicalPeer) continue;
    const peerEntry = readSkillEntry(physicalPeer, false);
    const selectedIdentity = directories.get(selected);
    if (
      selected === physicalPeer ||
      (selectedIdentity && peerEntry?.kind === "directory" && sameObject(selectedIdentity, peerEntry.identity))
    ) {
      if (
        scope === "user" &&
        peer === workflowSkillDestination(host, projectRoot) &&
        realpathSync(projectRoot) === base
      )
        continue;
      throw new Error(`Shared destination: ${selectedLogical} and ${peer} resolve to ${selected}`);
    }
  }
  return directories;
}
