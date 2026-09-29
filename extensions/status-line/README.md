# status-line

`status-line` replaces the interactive Pi footer with a responsive Locus information rail. It leaves the editor unchanged.

The footer projects the working directory/worktree and branch on the left and context pressure, Pi compaction ownership, model, and effort on the right. It also keeps Pi's default exit and suspend controls visible: `Ctrl+D exit (empty)` and, outside Windows, `Ctrl+Z suspend`. It uses one row when everything fits, two rows when the controls and compact status fit together, and three rows only when a narrow terminal requires each group to remain separate.

The control labels mirror Pi's default bindings. Pi's custom-footer API does not expose the effective application keymap, so user-remapped bindings remain authoritative even when these default labels are shown.

`(pi:auto)` means Pi still owns compaction. During and immediately after compaction the footer reports the host state without implying a separate Locus compaction algorithm.

The extension performs no filesystem writes, subprocesses, network calls, or model calls. It reads Git metadata only to distinguish worktrees and ordinary checkouts.

## Implementation

- Entrypoint: `extensions/status-line/index.ts`
- Footer: `extensions/status-line/footer.ts`
- Hooks: `session_start`, `session_before_compact`, `session_compact`, `session_shutdown`
- Manifest: `extensions/status-line/manifest.json`
