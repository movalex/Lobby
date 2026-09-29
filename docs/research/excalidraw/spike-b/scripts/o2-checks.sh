#!/usr/bin/env bash
# O2's spike B checks, one after the other, each to its own log (B2, B3 except L8, B4 D1/D2/D5/D6, B5 R3).
#
#   docs/research/excalidraw/spike-b/scripts/o2-checks.sh <repo-root> <log-dir> [spec ...]
#
# Env: SPIKE_B_PORT_BASE (required: the stack's base; O2 uses 7870-7879), and the specs' repetition knobs
# (SPIKE_B2_REPS, SPIKE_B3_REPS, SPIKE_B3_ARROW_REPS, SPIKE_B3_GUARD_REPS, SPIKE_B3_L7_REPS,
# SPIKE_B3_CHORD_REPS, SPIKE_B4_REPS, SPIKE_B4_D5_MS, SPIKE_B4_D2_ROUNDS, SPIKE_B5_REPS). Every stack runs
# with DRAFTROOM_BACKUP_STORE=off (the harness sets it). Headless Chromium only.
set -u
root="${1:?repo root}"
logs="${2:?log dir}"
shift 2
: "${SPIKE_B_PORT_BASE:?set SPIKE_B_PORT_BASE}"
specs=("$@")
if [ ${#specs[@]} -eq 0 ]; then
  specs=(b2-undo b3-l1-l5 b3-l7 b3-l9-l12 b3-l13-chords b3-l13-keys-k b3-l12-lease-l b3-l6-l10 b4-client b5-r3)
fi
mkdir -p "$logs"
cd "$root/e2e" || exit 2
for s in "${specs[@]}"; do
  start=$(date +%s)
  pnpm exec playwright test -c spike-b/playwright.config.ts "$s" >"$logs/$s.log" 2>&1
  code=$?
  echo "$s exit=$code seconds=$(( $(date +%s) - start ))" | tee -a "$logs/summary.txt"
done
