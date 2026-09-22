---
title: Workflow trust and source identity
type: guide
status: active
updated: "2026-09-13T00:12:21Z"
description: "Organize the installed workflow contract by reader task."
---

# Workflow trust and source identity

[Workflow documentation](index.md) · [Authoring guide](../locus-pi-workflows.md) · [Operator guide](../workflows.md)

## Source snapshot and identity coverage

Before module evaluation, the runner reads the resolved `.workflow.mjs` bytes,
AST-checks their declared dependency shape, computes SHA-256, and writes a
read-only `script-<sha256>.workflow.mjs` snapshot inside the run directory. A
source with no coverage declaration defaults to `self-contained-static`: only
literal static `node:` imports/re-exports are accepted, and the retained snapshot
is the imported module URL. Local/file/data/bare imports, non-`node:` re-exports,
direct dynamic `import()`, direct/parenthesized `require()` and `import.meta` fail
before evaluation. The AST policy does not infer `createRequire` aliases,
eval-generated imports or other indirect host-code loading; reviewed authors must
declare `entry-only` for those behaviors even though the analyzer cannot prove them.

A reviewed modular script may explicitly declare the literal top-level field
`meta.identityCoverage: "entry-only"`. That hash-bound downgrade keeps a
hash- and run-qualified source import, including relative-import and `import.meta` base,
but dependency bytes stay unbound. `scriptSha256` always means exact entry bytes;
it is never a full behavior/environment hash.

Each version-2 `result.json` identity also records the policy, coverage,
`executionSource`, Node version/platform/architecture, sorted builtin imports and
unbound dependency descriptions. Tool, command and `/workflows status` surfaces
show the safe target reference, coverage, execution source, dependency counts,
snapshot basename and short hash. This structured target/identity metadata never
exposes the absolute `sourcePath` or internal target path; an accepted absolute
in-project input is reduced to its basename there. Node loader/runtime error text
can still contain paths and is not a privacy-redacted channel. Only the old
unversioned three-field identity reads
as `entry-only-legacy`; unknown/future or inconsistent v2 records are omitted.
The snapshot is verified after module evaluation and again after JSON result
detachment immediately before synchronous persistence. An observed mismatch
forces `ok:false`; these point-in-time checks are not an atomic filesystem or
same-owner race guarantee. A per-run module URL prevents one entry-only import
from poisoning a later run's entry cache. Editing self-contained entry bytes
between launches executes the new snapshot without `/reload`.

`self-contained-static` describes only declared source-module edges. Node
builtins still allow filesystem, subprocess, network, dynamic code and other host
effects, including indirect loaders the AST policy cannot enumerate. Identity
coverage is not isolation, runtime dependency closure or determinism.

The model-callable `workflow` tool declares Pi `approval: "exec"`; its native
approval details warn that the selected file has full host Node.js/module access
and no sandbox. Approval records consent but does not constrain the module.
`/workflows run` is an explicit operator command and does not pass through the
tool-approval path; `locus-pi` adds no second launch prompt or `decision` entry.

## Approval / trust discipline

- **Permissions and tools:** every workflow child uses `permissionMode:
"inherit-parent"` and `tools: ["*"]`. Selecting a catalog role changes only
  prompt/model identity. Legacy `tools`, `readOnly`, and `permissionMode` call
  fields are ignored, so `write`, `edit`, `bash`, and all other available tools
  work without author-maintained allowlists.
- **Bounded repository checks:** `repository_check` accepts only
  a baseline `package.json` script name while the complete scripts map remains
  byte-for-byte equivalent to its pre-writer capture; added `pre`/`post` hooks,
  removals, and command changes are refused. It runs with host-owned argv in a
  disposable external Git worktree; it does not expose arguments or shell text.
  Initialized gitlinks are recursively overlaid with their current tracked and
  untracked source bytes, without copying submodule Git administrative metadata.
  Installed dependency roots — `node_modules` and `.venv` — are Git-ignored and
  therefore absent from that snapshot, so the snapshot borrows each one that
  exists as a symlink to the project's own directory; without them a declared
  check dies at startup (`sh: vitest: command not found`) and a verifier reads
  that as "the suite could not run". The borrowed link is unlinked before the
  snapshot is removed, so cleanup never deletes through it. A check that writes
  inside a borrowed dependency root writes to the project's real directory — the
  isolation guarantee covers the repository's own files, not a package manager's
  install tree.
  `git_read` accepts argv for
  allowlisted Git queries and rejects mutation, output-file, external-diff,
  textconv, pager, signature, and config options before launch.
- **Workspace:** `workspaceMode: "project"` keeps the child in the current project working directory. `workspaceMode: "worktree"` and `"temporary-worktree"` make the bridge create a retained git worktree under the selected execution's `runtime/worktrees/<call-id>/`, then pass that path as `AgentRunRequest.workingDirectory`. That execution is the group root at `.locus-pi/runs/<storageRootRunId>/` or a saved child/resume attempt in its fixed nested directory.
- **Deprecated alias:** `sandbox: "read-only"` maps to `workspaceMode: "project"`; `sandbox: "workspace-write"` maps to `workspaceMode: "worktree"`. It never changes the tool set. New workflows should use `workspaceMode`.
- Pi native approval policy owns whether the underlying write-tier calls are allowed, prompted, or denied.
  The worktree isolates file changes for diff UX purposes, but it is not a security boundary.

---

## Fail-closed behavior

When the Pi SDK host cannot spawn a child agent session:

1. `createAgentSdkSessionExecutor` returns `status: "blocked"` with `failureCause: "sdk-unavailable"`, and `diagnostics` containing `AGENT_SDK_UNAVAILABLE_DIAGNOSTIC` for a human reader.
2. `workflow-agent-bridge.ts` branches on that typed cause — never on the diagnostic text — and throws `WorkflowAgentUnavailableError`, carrying the same `failureCause` and the honest `AGENT_SDK_UNAVAILABLE_HINT` ("Pi SDK host") reason. Re-wording the diagnostic therefore cannot turn a run-ending failure into a blocked result a script might read as an answer.
3. A bare `agent()` call rejects (propagates the error to the script).
4. Inside `parallel()` / `pipeline()`, the branch is marked failed; scheduled siblings finish, then the group rejects `WorkflowGroupFailureError` instead of returning a normal `null` slot.
5. If the script does not deliberately catch that stable typed error, `runWorkflowScript` writes a JSON-safe group-failure `result`, persists outer `ok:false`, and returns the group error text. A deliberate typed catch must return an explicit failure outcome such as `partial:true`, `ok:false`, or a failure `status`; the shared classifier keeps each form non-success at the root.

**No fake success is ever reported.**
