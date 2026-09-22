import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { sessionJsonlPath } from "../host/files.js";
import {
  JsonlSessionStore,
  MemorySessionStore,
  type JsonlSessionStoreOptions,
  type MemorySessionStoreOptions,
} from "./session-core.js";

export type SessionStoreBackend = "memory" | "jsonl";

export interface SessionStoreFactoryOptions extends MemorySessionStoreOptions {
  projectRoot: string;
  backend?: SessionStoreBackend;
  filePath?: string;
}

export interface RuntimeCapabilityReport {
  sessionStoreBackend: SessionStoreBackend;
  durableSessionStore: boolean;
  sessionStorePath?: string;
  sessionStoreWritable: boolean;
  diagnostics: string[];
}

export type SessionStore = MemorySessionStore | JsonlSessionStore;

export function selectSessionStoreBackend(forced?: string): SessionStoreBackend {
  if (forced === "jsonl" || forced === "memory") return forced;
  const env = process.env.LOCUS_PI_SESSION_STORE;
  return env === "jsonl" ? "jsonl" : "memory";
}

export function createSessionStore(options: SessionStoreFactoryOptions): SessionStore {
  const backend = selectSessionStoreBackend(options.backend);
  if (backend === "jsonl") {
    const jsonlOptions: JsonlSessionStoreOptions = {
      filePath: options.filePath ?? sessionJsonlPath(options.projectRoot),
    };
    if (options.idFactory !== undefined) jsonlOptions.idFactory = options.idFactory;
    if (options.now !== undefined) jsonlOptions.now = options.now;
    return new JsonlSessionStore(jsonlOptions);
  }
  const memoryOptions: MemorySessionStoreOptions = {};
  if (options.idFactory !== undefined) memoryOptions.idFactory = options.idFactory;
  if (options.now !== undefined) memoryOptions.now = options.now;
  return new MemorySessionStore(memoryOptions);
}

export function getRuntimeCapabilityReport(projectRoot: string, forcedBackend?: string): RuntimeCapabilityReport {
  const backend = selectSessionStoreBackend(forcedBackend);
  const filePath = sessionJsonlPath(projectRoot);
  const diagnostics: string[] = [];
  const writable = canWriteSessionPath(filePath, diagnostics);
  return {
    sessionStoreBackend: backend,
    durableSessionStore: backend === "jsonl",
    sessionStorePath: filePath,
    sessionStoreWritable: writable,
    diagnostics,
  };
}

export function formatRuntimeCapabilityReport(report: RuntimeCapabilityReport): string[] {
  return [
    `sessionStore: ${report.sessionStoreBackend}`,
    `durableSessionStore: ${String(report.durableSessionStore)}`,
    ...(report.sessionStorePath === undefined ? [] : [`sessionStorePath: ${report.sessionStorePath}`]),
    `sessionStoreWritable: ${String(report.sessionStoreWritable)}`,
    ...(report.diagnostics.length === 0 ? [] : [`sessionStoreDiagnostics: ${report.diagnostics.join("; ")}`]),
  ];
}

function canWriteSessionPath(filePath: string, diagnostics: string[]): boolean {
  let candidate = dirname(filePath);
  while (!existsSync(candidate)) {
    const next = dirname(candidate);
    if (next === candidate) break;
    candidate = next;
  }
  try {
    accessSync(candidate, constants.W_OK);
    return true;
  } catch {
    diagnostics.push("session store parent directory is not writable");
    return false;
  }
}
