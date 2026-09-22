# Environment variables

`locus-pi` keeps operator environment controls narrow. Set these before starting
Pi; restart the Pi process after changing them.

## `LOCUS_PI_HTML_TRANSCRIPTS`

Controls automatic readable HTML renders for child-agent transcripts created by
the `agents` and `workflows` extensions.

- Unset or `0`: disabled (default). The required Pi session JSONL is still saved.
- `1`: after JSONL export, also render a sibling `.html` file and record its
  verified `htmlPath` in child evidence.

```bash
LOCUS_PI_HTML_TRANSCRIPTS=1 pi
```

Disabling HTML is silent and does not change run status. When enabled, a real
renderer failure remains a warning in the child diagnostics; JSONL evidence is
retained. This setting does not change Pi's built-in manual export commands or
retroactively render existing sessions.
