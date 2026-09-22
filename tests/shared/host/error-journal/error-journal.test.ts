import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendProjectError, projectErrorJournalPath } from "../../../../extensions/_shared/host/error-journal.js";
const roots: string[] = [];
function project() {
  const root = mkdtempSync(path.join(tmpdir(), "project-errors-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const facts = {
  ts: "2026-09-11T00:00:00Z",
  source: "agent",
  event: "agent_result",
  message: "provider refused",
} as const;
function rows(root: string) {
  return readFileSync(projectErrorJournalPath(root), "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
}

describe("bounded project error pointers", () => {
  it("preserves identities and paths without inventing unknown facts or copying multiline text", () => {
    const root = project();
    const receipt = appendProjectError(root, {
      ...facts,
      message: "provider refused\napi_key=" + "a".repeat(40),
      callId: "call-2",
      attempt: 2,
      resultPath: "/real result/file.json",
    });
    expect(receipt.warning).toBeUndefined();
    expect(rows(root)[0]).toMatchObject({
      schema: "locus.error.v1",
      id: receipt.id,
      callId: "call-2",
      attempt: 2,
      resultPath: "/real result/file.json",
    });
    expect(rows(root)[0].message).toContain("REDACTED");
    expect(rows(root)[0]).not.toHaveProperty("agent");
    expect(rows(root)[0]).not.toHaveProperty("cause");
    expect(statSync(receipt.path).mode & 0o777).toBe(0o600);
  });
  it("bounds and redacts display text without discarding the error pointer", () => {
    const root = project();
    expect(
      appendProjectError(root, {
        ...facts,
        title: "a".repeat(40000),
        label: "api_key=" + "b".repeat(40),
        displayName: "name\nline",
      }).warning,
    ).toBeUndefined();
    const row = rows(root)[0];
    expect(row.title).toHaveLength(1000);
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.label).toContain("REDACTED");
    expect(row.displayName).toBe("name line");
  });
  it("bounds current and previous logs while retaining the newest complete events", () => {
    const root = project();
    const current = projectErrorJournalPath(root),
      previous = path.join(path.dirname(current), "errors.1.jsonl");
    appendProjectError(root, { ...facts, callId: "seed", message: "x".repeat(1000) });
    for (const callId of ["first", "second"]) {
      const seed = readFileSync(current, "utf8");
      // Fill with complete fixture rows to exercise both rotations without thousands of fs locks.
      writeFileSync(current, seed.repeat(Math.floor((1024 * 1024) / Buffer.byteLength(seed))));
      expect(appendProjectError(root, { ...facts, callId, message: "x".repeat(1000) }).warning).toBeUndefined();
      expect(statSync(current).size).toBeLessThanOrEqual(1024 * 1024);
      expect(statSync(previous).size).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(rows(root).at(-1).callId).toBe("second");
    expect(JSON.parse(readFileSync(previous, "utf8").split("\n")[0]!).callId).toBe("first");
    for (const line of readFileSync(previous, "utf8").trim().split("\n"))
      expect(JSON.parse(line).schema).toBe("locus.error.v1");
  });
  it("serializes independent processes without torn or lost records", async () => {
    const root = project();
    const modulePath = path.resolve("extensions/_shared/host/error-journal.ts");
    const script = `import { appendProjectError } from ${JSON.stringify(modulePath)}; for (let i=0;i<60;i++) { const r=appendProjectError(process.argv[1], { ts:new Date().toISOString(), source:'agent', event:'agent_result', message:'bad', callId:process.argv[2]+'-'+i }); if(r.warning) throw new Error(r.warning); }`;
    await Promise.all(
      Array.from(
        { length: 6 },
        (_, i) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["--import", "tsx", "--input-type=module", "-e", script, root, String(i)],
              { stdio: ["ignore", "ignore", "pipe"] },
            );
            let stderr = "";
            child.stderr.on("data", (s) => (stderr += s));
            child.on("error", reject);
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
          }),
      ),
    );
    expect(rows(root)).toHaveLength(360);
    expect(new Set(rows(root).map((r) => r.callId)).size).toBe(360);
    expect(new Set(rows(root).map((r) => r.id)).size).toBe(360);
  });
  it("reports a busy lock without deleting another writer's lock or changing the original message", () => {
    const root = project(),
      log = projectErrorJournalPath(root);
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(log + ".lock", "other owner");
    const receipt = appendProjectError(root, facts);
    expect(receipt.warning).toContain("busy");
    expect(receipt.id).toBeUndefined();
    expect(readFileSync(log + ".lock", "utf8")).toBe("other owner");
    expect(facts.message).toBe("provider refused");
  });
  it("refuses an incomplete crash tail without appending another record to it", () => {
    const root = project(),
      log = projectErrorJournalPath(root);
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(log, '{"incomplete":');
    expect(appendProjectError(root, facts).warning).toContain("incomplete last record");
    expect(readFileSync(log, "utf8")).toBe('{"incomplete":');
  });
  it("does not follow symlinks in its directory or file", () => {
    for (const target of ["directory", "file"]) {
      const root = project(),
        outside = project(),
        log = projectErrorJournalPath(root);
      mkdirSync(path.join(root, ".locus-pi"));
      if (target === "directory") symlinkSync(outside, path.dirname(log));
      else {
        mkdirSync(path.dirname(log));
        writeFileSync(path.join(outside, "kept"), "unchanged");
        symlinkSync(path.join(outside, "kept"), log);
      }
      expect(appendProjectError(root, facts).warning).toContain("unsafe");
      expect(existsSync(path.join(outside, "errors.jsonl"))).toBe(false);
      if (target === "file") expect(readFileSync(path.join(outside, "kept"), "utf8")).toBe("unchanged");
    }
  });
});
