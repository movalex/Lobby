#!/usr/bin/env bash
# Spike B, the lead's M1/M2 integration (docs/EXCALIDRAW-MIGRATION.md §8.6.4, §8.6.8): every B-check spec
# ONCE on the integrated tree, one after the other, each with a fresh build (the spike-b config builds per
# invocation) and its own log. B8's staging rows (O4 only, §8.6.7) and B9's NAS half (O3) are not run
# here; the perf-* specs (§8.4 numbers, O3, quiet window) neither.
#
#   INT_OUT=<log dir> bash docs/research/excalidraw/spike-b/scripts/integration-m1m2-checks.sh [spec ...]
#
# Ports: the lead's range only (§8.6.5): the stack on base 7850 (sync 7850, api 7851, web 7852); B8's
# stand-in and corpus sync on 7858 (SPIKE_B8_STANDIN_PORT). Listeners in 7850-7859 are listed before and
# after every spec; a leftover listener is recorded (and its process stopped, since the range is the lead's).
# Every stack runs with DRAFTROOM_BACKUP_STORE=off (the harness forces it). Headless Chromium only.
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
unset VITE_LOBBY_ENGINE VITE_DRAFTROOM_DEV_AUTH LOBBY_HOST_REWRITE DRAFTROOM_ENGINE DRAFTROOM_TEST_HOOKS SPIKE_B8_DIR
export SPIKE_B_PORT_BASE=7850 SPIKE_B8_STANDIN_PORT=7858 SPIKE_B11=1 SPIKE_B9_WS=1
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
OUT=${INT_OUT:-/tmp/int-m1m2}
mkdir -p "$OUT"
specs=("$@")
if [ ${#specs[@]} -eq 0 ]; then
  specs=(m1-walking-skeleton b1-concurrent-fields b2-undo b3-l1-l5-lease b3-l6-l10-arrows b3-l7-offline
    b3-l8-leased-forged b3-l9-l12-guard b3-l12-lease-l b3-l13-chords b3-l13-keys-k b4-client-durability
    b4-server-d3-sigkill b4-server-d4-commit b5-r1-readonly-forged b5-r2-commenter b5-r3-keys b5-r4-downgrade
    b6-forged b7-files b8-restore b8-screens b8-two-browsers b8-drill b10-echo b11-convergence b12-collapse
    b12-guard b12-phone b9-visibility)
fi
listeners() { netstat -ano | grep -E "(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):785[0-9]\s" | grep LISTENING; }
cd "$ROOT/e2e" || exit 2
echo "start $(date -u +%FT%TZ) head $(git -C "$ROOT" rev-parse --short HEAD)" | tee -a "$OUT/summary.txt"
for s in "${specs[@]}"; do
  pre=$(listeners)
  [ -n "$pre" ] && echo "$s: listeners BEFORE: $pre" | tee -a "$OUT/summary.txt"
  t0=$(date +%s)
  pnpm exec playwright test -c spike-b/playwright.config.ts "$s" >"$OUT/$s.log" 2>&1
  code=$?
  counts=$(grep -E '^\s+[0-9]+ (passed|failed|skipped|flaky|did not run|interrupted)' "$OUT/$s.log" | tr -s ' ' | tr '\n' ' ')
  echo "$s exit=$code seconds=$(($(date +%s) - t0)) [$counts]" | tee -a "$OUT/summary.txt"
  # the next invocation wipes the output folder: keep this spec's evidence, traces and screenshots
  [ -d "$ROOT/e2e/test-results/spike-b-7852" ] && cp -r "$ROOT/e2e/test-results/spike-b-7852" "$OUT/$s.results"
  post=$(listeners)
  if [ -n "$post" ]; then
    echo "$s: listeners AFTER: $post" | tee -a "$OUT/summary.txt"
    for pid in $(echo "$post" | awk '{print $NF}' | sort -u); do taskkill //F //T //PID "$pid" >/dev/null 2>&1; done
  fi
done
echo "end $(date -u +%FT%TZ); listeners 7850-7859 now: [$(listeners)]" | tee -a "$OUT/summary.txt"
