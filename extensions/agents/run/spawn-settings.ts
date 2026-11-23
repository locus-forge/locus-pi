import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, TomlError } from "smol-toml";
import { errorMessage } from "../../_shared/host/error-text.js";
import { workflowRootDir } from "../../workflows/runtime/workflow-output.js";

const DEFAULT_SPAWN_CONCURRENCY = 4;

export function loadSpawnConcurrency(projectRoot: string): number {
  const file = join(workflowRootDir(projectRoot), "config.toml");
  let source: string;
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Expected a regular file.");
      source = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SPAWN_CONCURRENCY;
    throw new Error(`Cannot read ${file}: ${errorMessage(error)}`);
  }

  let config;
  try {
    config = parse(source, { integersAsBigInt: true });
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    throw new Error(`${file}: invalid TOML at line ${error.line}, column ${error.column}.`);
  }

  const agents = config.agents;
  if (agents === undefined) return DEFAULT_SPAWN_CONCURRENCY;
  if (typeof agents !== "object" || agents === null || Array.isArray(agents) || agents instanceof Date) {
    throw new Error(`${file}: agents must be a TOML table.`);
  }
  const concurrency = agents.concurrency;
  if (concurrency === undefined) return DEFAULT_SPAWN_CONCURRENCY;
  if (typeof concurrency !== "bigint" || concurrency < 1n || concurrency > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${file}: agents.concurrency must be a positive integer no greater than ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return Number(concurrency);
}
