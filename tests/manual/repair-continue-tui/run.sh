#!/usr/bin/env bash
# Manual live smoke: repair a stopped workflow in place, continue it, and prove the
# completed prefix was reused instead of re-asked.
#
# Driving happens through tmux send-keys on purpose. Computer use is granted terminals
# at a click-only tier, so it cannot type into the Pi TUI; it takes the screenshot that
# shows a human what the operator sees. This script produces that window plus the
# machine-checkable assertions below.
#
#   PROJECT=/tmp/repair-smoke tests/manual/repair-continue-tui/run.sh
#
# Environment:
#   PROJECT   scratch project root the run writes into (required)
#   PI_CMD    how to start Pi (default: this checkout's extensions)
#   SESSION   tmux session name (default cu-repair-smoke)
#   INPUT     semantic input passed to the workflow
#   KEEP      1 to leave the tmux session up for a screenshot (default 1)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PROJECT="${PROJECT:?PROJECT (scratch project root) is required}"
PI_CMD="${PI_CMD:-pi --no-extensions -e $REPO}"
SESSION="${SESSION:-cu-repair-smoke}"
INPUT="${INPUT:-catalog check}"
KEEP="${KEEP:-1}"
SOURCE="$PROJECT/.locus-pi/workflows/repair-smoke/repair-smoke.workflow.mjs"
OUT="$PROJECT/.smoke"

wait_pane() { # wait_pane <extended-regex> <seconds>
  local pattern="$1" limit="$2" waited=0
  while [ "$waited" -lt "$limit" ]; do
    if tmux capture-pane -p -t "$SESSION" | grep -qE "$pattern"; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# The run writes its own result.json when it reaches a terminal state, so waiting on the
# file is exact. Grepping the pane for words like "error" is not: the previous step's text
# is still on screen and would match immediately.
wait_result() { # wait_result <glob> <seconds>
  local glob="$1" limit="$2" waited=0
  while [ "$waited" -lt "$limit" ]; do
    if compgen -G "$glob" >/dev/null; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

snap() { # snap <name>
  tmux capture-pane -p -e -t "$SESSION" >"$OUT/$1.ansi.txt"
  tmux capture-pane -p -t "$SESSION" >"$OUT/$1.txt"
  echo "captured $OUT/$1.txt"
}

newest_run_id() { ls -t "$PROJECT/.locus-pi/runs" 2>/dev/null | head -1; }

mkdir -p "$(dirname "$SOURCE")" "$OUT"
cp "$HERE/repair-smoke.before.workflow.mjs" "$SOURCE"

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$PROJECT" "$PI_CMD"
wait_pane '\(pi:auto\)' 120 || { echo "FAIL: the Pi TUI did not come up"; exit 1; }
snap 01-ready

echo "step 1: run the broken source"
tmux send-keys -t "$SESSION" "/workflows run repair-smoke -- $INPUT" Enter
wait_result "$PROJECT/.locus-pi/runs/*/runtime/result.json" 900 || { snap 02-timeout; echo "FAIL: the first run never stopped"; exit 1; }
sleep 3
snap 02-stopped
FIRST="$(newest_run_id)"
[ -n "$FIRST" ] || { echo "FAIL: no run directory was written"; exit 1; }
echo "stopped run: $FIRST"

echo "step 2: repair the same file and continue"
cp "$HERE/repair-smoke.after.workflow.mjs" "$SOURCE"
tmux send-keys -t "$SESSION" "/workflows run repair-smoke --resume $FIRST -- $INPUT" Enter
wait_result "$PROJECT/.locus-pi/runs/$FIRST/attempts/*/runtime/result.json" 1200 || { snap 03-timeout; echo "FAIL: the continuation never finished"; exit 1; }
sleep 3
snap 03-continued

echo "step 3: assert the reuse"
PROJECT="$PROJECT" FIRST="$FIRST" node "$HERE/assert-reuse.mjs" | tee "$OUT/assertions.txt"
STATUS=${PIPESTATUS[0]}

if [ "$KEEP" = "1" ]; then
  echo "tmux session '$SESSION' left running for a screenshot"
else
  tmux kill-session -t "$SESSION" 2>/dev/null || true
fi
exit "$STATUS"
