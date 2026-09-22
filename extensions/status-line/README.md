# status-line

`status-line` replaces the interactive Pi footer with a responsive Locus information rail. It leaves the editor unchanged.

The footer projects the working directory/worktree and branch on the left and context pressure, Pi compaction ownership, model, and effort on the right. It uses one row when both groups fit and two rows on overflow; narrower fallbacks shorten only the group that cannot fit.

`(pi:auto)` means Pi still owns compaction. During and immediately after compaction the footer reports the host state without implying a separate Locus compaction algorithm.

The extension performs no filesystem writes, subprocesses, network calls, or model calls. It reads Git metadata only to distinguish worktrees and ordinary checkouts.

## Implementation

- Entrypoint: `extensions/status-line/index.ts`
- Footer: `extensions/status-line/footer.ts`
- Hooks: `session_start`, `session_before_compact`, `session_compact`, `session_shutdown`
- Manifest: `extensions/status-line/manifest.json`
