import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  chmodWorkflowRunFile,
  ensureWorkflowDirectoryNoSymlink,
  readWorkflowRunFile,
  writeWorkflowRunFile,
} from "./workflow-run-layout.js";

export type WorkflowResourceKind = "prompt";

export interface WorkflowResourceEvidence {
  kind: WorkflowResourceKind;
  requestedPath: string;
  sourcePath: string;
  snapshotPath: string;
  sha256: string;
  sizeBytes: number;
}

export interface WorkflowResourceLoader {
  renderPrompt(requestedPath: string, variables?: Record<string, string>): string;
  evidence(): WorkflowResourceEvidence[];
}

export interface WorkflowResourceLoaderOptions {
  workflowSourcePath: string;
  runDir: string;
}

interface LoadedResource {
  bytes: Buffer;
  text: string;
  evidence: WorkflowResourceEvidence;
}

export function createWorkflowResourceLoader(options: WorkflowResourceLoaderOptions): WorkflowResourceLoader {
  const workflowDirectory = path.dirname(path.resolve(options.workflowSourcePath));
  const physicalWorkflowDirectory = realpathSync(workflowDirectory);
  const snapshotDirectory = path.join(options.runDir, "resources");
  const loadedBySourcePath = new Map<string, LoadedResource>();

  function load(requestedPath: string): LoadedResource {
    const kind: WorkflowResourceKind = "prompt";
    const suffix = ".prompt.md";
    if (requestedPath.trim() === "") {
      throw new Error("Workflow prompt resource path is empty.");
    }
    if (path.isAbsolute(requestedPath)) {
      throw new Error(`Workflow prompt resource path must be relative to ${workflowDirectory}: ${requestedPath}`);
    }
    if (!requestedPath.endsWith(suffix)) {
      throw new Error(`Workflow prompt resource must use ${suffix}: ${requestedPath}`);
    }

    const lexicalPath = path.resolve(workflowDirectory, requestedPath);
    if (!isPathWithinRoot(workflowDirectory, lexicalPath)) {
      throw new Error(`Workflow prompt resource escapes ${workflowDirectory}: ${requestedPath} -> ${lexicalPath}`);
    }
    if (!existsSync(lexicalPath)) {
      throw new Error(`Workflow prompt resource does not exist: ${requestedPath} -> ${lexicalPath}`);
    }
    const physicalPath = realpathSync(lexicalPath);
    if (!isPathWithinRoot(physicalWorkflowDirectory, physicalPath)) {
      throw new Error(
        `Workflow prompt resource escapes ${workflowDirectory} through a symlink: ${requestedPath} -> ${physicalPath}`,
      );
    }
    if (!statSync(physicalPath).isFile()) {
      throw new Error(`Workflow prompt resource is not a file: ${requestedPath} -> ${physicalPath}`);
    }

    const cached = loadedBySourcePath.get(physicalPath);
    if (cached !== undefined) {
      return cached;
    }

    const bytes = readFileSync(physicalPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    ensureWorkflowDirectoryNoSymlink(options.runDir, snapshotDirectory);
    const snapshotPath = path.join(snapshotDirectory, `${sha256}-${path.basename(physicalPath)}`);
    if (!existsSync(snapshotPath)) {
      writeWorkflowRunFile(options.runDir, snapshotPath, bytes, { exclusive: true });
      chmodWorkflowRunFile(options.runDir, snapshotPath, 0o444);
    } else {
      const retainedSha256 = createHash("sha256")
        .update(readWorkflowRunFile(options.runDir, snapshotPath))
        .digest("hex");
      if (retainedSha256 !== sha256) {
        throw new Error(`Workflow resource snapshot hash mismatch: ${snapshotPath}`);
      }
    }
    const loaded: LoadedResource = {
      bytes,
      text: bytes.toString("utf8"),
      evidence: {
        kind,
        requestedPath,
        sourcePath: physicalPath,
        snapshotPath,
        sha256,
        sizeBytes: bytes.byteLength,
      },
    };
    loadedBySourcePath.set(physicalPath, loaded);
    return loaded;
  }

  return {
    renderPrompt(requestedPath, variables = {}) {
      const loaded = load(requestedPath);
      if (loaded.text.trim() === "") {
        throw new Error(`Workflow prompt resource is empty: ${requestedPath} -> ${loaded.evidence.sourcePath}`);
      }
      const referenced = new Set<string>();
      const rendered = loaded.text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_match, name: string) => {
        referenced.add(name);
        if (!(name in variables)) {
          throw new Error(
            `Workflow prompt variable ${name} is missing: ${requestedPath} -> ${loaded.evidence.sourcePath}`,
          );
        }
        return variables[name]!;
      });
      const unused = Object.keys(variables).filter((name) => !referenced.has(name));
      if (unused.length > 0) {
        throw new Error(
          `Workflow prompt variables are unused (${unused.join(", ")}): ${requestedPath} -> ${loaded.evidence.sourcePath}`,
        );
      }
      if (rendered.trim() === "") {
        throw new Error(`Rendered workflow prompt is empty: ${requestedPath} -> ${loaded.evidence.sourcePath}`);
      }
      return rendered;
    },
    evidence() {
      return [...loadedBySourcePath.values()].map((resource) => ({ ...resource.evidence }));
    },
  };
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
