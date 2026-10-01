#!/usr/bin/env bash
# Spike B, O1's checks (docs/EXCALIDRAW-MIGRATION.md §8.6.3, §8.6.8): B3 L8, B4 D3 and D4, B5 R1 and R4, B6,
# RUNS times in a row (default 3), each spec with a fresh build (the spike-b config builds per invocation)
# and its own log; then the server half of L6/L10 (the room's protocol suites and the arrow acceptance
# tests) RUNS times.
#
#   O1_OUT=<log dir> RUNS=3 bash docs/research/excalidraw/spike-b/scripts/o1-checks.sh [spec ...]
#
# Ports: O1's range only (§8.6.5): the stack on base 7860 (sync 7860, api 7861, web 7862). Listeners in
# 7860-7869 are listed before and after every spec; a leftover listener is recorded and its process stopped
# (the range is O1's). Every stack runs with DRAFTROOM_BACKUP_STORE=off (the harness forces it). Headless
# Chromium only. Playwright wipes its output folder per invocation, so each spec's folder is copied.
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
unset VITE_LOBBY_ENGINE VITE_DRAFTROOM_DEV_AUTH LOBBY_HOST_REWRITE DRAFTROOM_ENGINE DRAFTROOM_TEST_HOOKS SPIKE_B8_DIR
export SPIKE_B_PORT_BASE=7860
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
OUT=${O1_OUT:-/tmp/o1-checks}
RUNS=${RUNS:-3}
mkdir -p "$OUT"
specs=("$@")
if [ ${#specs[@]} -eq 0 ]; then
  specs=(b3-l8-leased-forged b4-server-d3-sigkill b4-server-d4-commit b5-r1-readonly-forged b5-r4-downgrade
    b6-forged)
fi
listeners() { netstat -ano | grep -E "(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):786[0-9]\s" | grep LISTENING; }
echo "start $(date -u +%FT%TZ) head $(git -C "$ROOT" rev-parse --short HEAD) runs $RUNS" | tee -a "$OUT/summary.txt"
for run in $(seq 1 "$RUNS"); do
  cd "$ROOT/e2e" || exit 2
  for s in "${specs[@]}"; do
    pre=$(listeners)
    [ -n "$pre" ] && echo "run $run $s: listeners BEFORE: $pre" | tee -a "$OUT/summary.txt"
    t0=$(date +%s)
    pnpm exec playwright test -c spike-b/playwright.config.ts "$s" >"$OUT/run$run-$s.log" 2>&1
    code=$?
    counts=$(grep -E '^\s+[0-9]+ (passed|failed|skipped|flaky|did not run|interrupted)' "$OUT/run$run-$s.log" | tr -s ' ' | tr '\n' ' ')
    echo "run $run $s exit=$code seconds=$(($(date +%s) - t0)) [$counts]" | tee -a "$OUT/summary.txt"
    [ -d "$ROOT/e2e/test-results/spike-b-7862" ] && cp -r "$ROOT/e2e/test-results/spike-b-7862" "$OUT/run$run-$s.results"
    post=$(listeners)
    if [ -n "$post" ]; then
      echo "run $run $s: listeners AFTER: $post" | tee -a "$OUT/summary.txt"
      for pid in $(echo "$post" | awk '{print $NF}' | sort -u); do taskkill //F //T //PID "$pid" >/dev/null 2>&1; done
    fi
  done
  # the server half of L6/L10 and the room's suites (port 0), and the C0 arrow acceptance tests
  cd "$ROOT" || exit 2
  t0=$(date +%s)
  pnpm exec vitest run apps/sync/test/element-room packages/canvas-schema/src/engine packages/canvas-schema/src/invariants.test.ts >"$OUT/run$run-room-suites.log" 2>&1
  code=$?
  counts=$(grep -E '^\s+(Test Files|Tests) ' "$OUT/run$run-room-suites.log" | tr -s ' ' | tr '\n' ' ')
  echo "run $run room-suites exit=$code seconds=$(($(date +%s) - t0)) [$counts]" | tee -a "$OUT/summary.txt"
  t0=$(date +%s)
  pnpm test:arrows >"$OUT/run$run-arrows.log" 2>&1
  code=$?
  counts=$(grep -E '^\s+(Test Files|Tests) ' "$OUT/run$run-arrows.log" | tr -s ' ' | tr '\n' ' ')
  echo "run $run arrows exit=$code seconds=$(($(date +%s) - t0)) [$counts]" | tee -a "$OUT/summary.txt"
done
echo "end $(date -u +%FT%TZ); listeners 7860-7869 now: [$(listeners)]" | tee -a "$OUT/summary.txt"
