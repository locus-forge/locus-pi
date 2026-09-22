import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { artifactStoreDir } from "../host/files.js";

export type RuntimeArtifactKind = "prepared-task-draft" | "markdown" | "json" | "text";

export interface RuntimeArtifact {
  id: string;
  path: string;
  kind: RuntimeArtifactKind;
  content: string;
  createdAt: string;
  sessionId?: string;
  draftId?: string;
  title?: string;
  metadata: Record<string, unknown>;
}

export interface RuntimeArtifactWriteInput {
  id?: string;
  path?: string;
  kind: RuntimeArtifactKind;
  content: string;
  sessionId?: string;
  draftId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeArtifactStore {
  writeArtifact(input: RuntimeArtifactWriteInput): RuntimeArtifact;
  readArtifact(ref: string): RuntimeArtifact | undefined;
}

export interface RuntimeArtifactStoreOptions {
  now?: () => string;
}

export interface FileRuntimeArtifactStoreOptions extends RuntimeArtifactStoreOptions {
  rootDir: string;
}

export class MemoryRuntimeArtifactStore implements RuntimeArtifactStore {
  protected readonly artifacts = new Map<string, RuntimeArtifact>();
  protected readonly pathIndex = new Map<string, string>();
  protected readonly now: () => string;
  protected sequence = 0;

  constructor(options: RuntimeArtifactStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  writeArtifact(input: RuntimeArtifactWriteInput): RuntimeArtifact {
    const id = input.id ?? this.nextArtifactId(input.kind);
    const artifactPath = input.path ?? id;
    const artifact = buildArtifact(input, id, artifactPath, this.now());
    this.persistArtifact(artifact);
    this.artifacts.set(artifact.id, cloneArtifact(artifact));
    this.pathIndex.set(artifact.path, artifact.id);
    return cloneArtifact(artifact);
  }

  readArtifact(ref: string): RuntimeArtifact | undefined {
    const id = this.pathIndex.get(ref) ?? ref;
    const artifact = this.artifacts.get(id);
    return artifact === undefined ? undefined : cloneArtifact(artifact);
  }

  protected nextArtifactId(kind: RuntimeArtifactKind): string {
    this.sequence += 1;
    return `${kind}-${this.sequence}`;
  }

  protected persistArtifact(_artifact: RuntimeArtifact): void {
    return;
  }
}

export class FileRuntimeArtifactStore extends MemoryRuntimeArtifactStore {
  readonly rootDir: string;

  constructor(options: FileRuntimeArtifactStoreOptions) {
    super(options);
    this.rootDir = options.rootDir;
  }

  override writeArtifact(input: RuntimeArtifactWriteInput): RuntimeArtifact {
    const id = input.id ?? this.nextArtifactId(input.kind);
    const artifactPath = input.path ?? this.pathForArtifactId(id);
    const artifact = buildArtifact(input, id, artifactPath, this.now());
    this.persistArtifact(artifact);
    this.artifacts.set(artifact.id, cloneArtifact(artifact));
    this.pathIndex.set(artifact.path, artifact.id);
    return cloneArtifact(artifact);
  }

  override readArtifact(ref: string): RuntimeArtifact | undefined {
    const memoryArtifact = super.readArtifact(ref);
    if (memoryArtifact !== undefined) return memoryArtifact;

    const candidatePath = path.isAbsolute(ref) ? ref : this.pathForArtifactId(ref);
    if (!existsSync(candidatePath)) return undefined;
    const parsed = JSON.parse(readFileSync(candidatePath, "utf8")) as unknown;
    const artifact = parseRuntimeArtifact(parsed);
    if (artifact === undefined) return undefined;
    this.artifacts.set(artifact.id, cloneArtifact(artifact));
    this.pathIndex.set(artifact.path, artifact.id);
    return cloneArtifact(artifact);
  }

  protected override persistArtifact(artifact: RuntimeArtifact): void {
    mkdirSync(path.dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, `${JSON.stringify(artifact, null, 2)}\n`);
  }

  private pathForArtifactId(id: string): string {
    return path.join(this.rootDir, `${sanitizeArtifactId(id)}.json`);
  }
}

export function createRuntimeArtifactStore(
  projectRoot: string,
  options: RuntimeArtifactStoreOptions = {},
): RuntimeArtifactStore {
  return new FileRuntimeArtifactStore({ rootDir: artifactStoreDir(projectRoot), ...options });
}

function buildArtifact(
  input: RuntimeArtifactWriteInput,
  id: string,
  artifactPath: string,
  createdAt: string,
): RuntimeArtifact {
  const artifact: RuntimeArtifact = {
    id,
    path: artifactPath,
    kind: input.kind,
    content: input.content,
    createdAt,
    metadata: input.metadata ?? {},
  };
  if (input.sessionId !== undefined) artifact.sessionId = input.sessionId;
  if (input.draftId !== undefined) artifact.draftId = input.draftId;
  if (input.title !== undefined) artifact.title = input.title;
  return artifact;
}

function parseRuntimeArtifact(value: unknown): RuntimeArtifact | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.path !== "string" || typeof value.content !== "string")
    return undefined;
  if (typeof value.createdAt !== "string" || !isRuntimeArtifactKind(value.kind)) return undefined;
  if (!isRecord(value.metadata)) return undefined;
  const artifact: RuntimeArtifact = {
    id: value.id,
    path: value.path,
    kind: value.kind,
    content: value.content,
    createdAt: value.createdAt,
    metadata: value.metadata,
  };
  if (typeof value.sessionId === "string") artifact.sessionId = value.sessionId;
  if (typeof value.draftId === "string") artifact.draftId = value.draftId;
  if (typeof value.title === "string") artifact.title = value.title;
  return artifact;
}

function isRuntimeArtifactKind(value: unknown): value is RuntimeArtifactKind {
  return value === "prepared-task-draft" || value === "markdown" || value === "json" || value === "text";
}

function cloneArtifact(artifact: RuntimeArtifact): RuntimeArtifact {
  return {
    ...artifact,
    metadata: { ...artifact.metadata },
  };
}

function sanitizeArtifactId(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "") || "artifact"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
