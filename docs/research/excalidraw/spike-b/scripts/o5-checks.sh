#!/usr/bin/env bash
# O5's spike B checks (B5 R2, B7 on the fs blob store, B12 collapse, guard and phone), each spec in its own
# Playwright invocation (so each gets a fresh web build: the spike-b config builds per invocation), RUNS
# times in a row, every spec's log and its Playwright output kept per run (Playwright wipes outputDir on
# every invocation).
#
#   O5_OUT=<log dir> RUNS=3 bash docs/research/excalidraw/spike-b/scripts/o5-checks.sh [spec ...]
#
# Ports: O5's range only (§8.6.5): the stack on base 7910 (sync 7910, api 7911, web 7912). Listeners in
# 7910-7919 are listed before and after every spec; a leftover one is recorded and its process stopped
# (the range is O5's). Every stack runs with DRAFTROOM_BACKUP_STORE=off (the harness forces it); B7 uses
# the fs blob store (the stack's default), never R2. Headless Chromium only.
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
unset VITE_LOBBY_ENGINE VITE_DRAFTROOM_DEV_AUTH LOBBY_HOST_REWRITE DRAFTROOM_ENGINE DRAFTROOM_TEST_HOOKS SPIKE_B8_DIR
export SPIKE_B_PORT_BASE=7910
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
OUT=${O5_OUT:-/tmp/o5-checks}
RUNS=${RUNS:-3}
specs=("$@")
if [ ${#specs[@]} -eq 0 ]; then
  specs=(b5-r2-commenter b7-files b12-collapse b12-guard b12-phone)
fi
listeners() { netstat -ano | grep -E "(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):791[0-9]\s" | grep LISTENING; }
mkdir -p "$OUT"
cd "$ROOT/e2e" || exit 2
echo "start $(date -u +%FT%TZ) head $(git -C "$ROOT" rev-parse --short HEAD) runs=$RUNS" | tee -a "$OUT/summary.txt"
for run in $(seq 1 "$RUNS"); do
  for s in "${specs[@]}"; do
    pre=$(listeners)
    [ -n "$pre" ] && echo "run$run $s: listeners BEFORE: $pre" | tee -a "$OUT/summary.txt"
    t0=$(date +%s)
    pnpm exec playwright test -c spike-b/playwright.config.ts "$s" >"$OUT/run$run-$s.log" 2>&1
    code=$?
    counts=$(grep -E '^\s+[0-9]+ (passed|failed|skipped|flaky|did not run|interrupted)' "$OUT/run$run-$s.log" | tr -s ' ' | tr '\n' ' ')
    echo "run$run $s exit=$code seconds=$(($(date +%s) - t0)) [$counts] $(date -u +%T)Z" | tee -a "$OUT/summary.txt"
    [ -d "$ROOT/e2e/test-results/spike-b-7912" ] && cp -r "$ROOT/e2e/test-results/spike-b-7912" "$OUT/run$run-$s.results"
    post=$(listeners)
    if [ -n "$post" ]; then
      echo "run$run $s: listeners AFTER: $post" | tee -a "$OUT/summary.txt"
      for pid in $(echo "$post" | awk '{print $NF}' | sort -u); do taskkill //F //T //PID "$pid" >/dev/null 2>&1; done
    fi
  done
done
echo "end $(date -u +%FT%TZ); listeners 7910-7919 now: [$(listeners)]" | tee -a "$OUT/summary.txt"
