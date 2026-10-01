#!/usr/bin/env bash
# O2's spike B checks, one after the other, each to its own log (B2, B3 except L8, B4 D1/D2/D5/D6, B5 R3).
#
#   docs/research/excalidraw/spike-b/scripts/o2-checks.sh <repo-root> <log-dir> [spec ...]
#
# Env: SPIKE_B_PORT_BASE (required: the stack's base; O2 uses 7870-7879), and the specs' repetition knobs
# (SPIKE_B2_REPS, SPIKE_B3_REPS, SPIKE_B3_ARROW_REPS, SPIKE_B3_GUARD_REPS, SPIKE_B3_L7_REPS,
# SPIKE_B3_CHORD_REPS, SPIKE_B4_REPS, SPIKE_B4_D1_FRESH_REPS, SPIKE_B4_D5_MS, SPIKE_B4_D2_ROUNDS,
# SPIKE_B5_REPS). Every stack runs with DRAFTROOM_BACKUP_STORE=off (the harness sets it). Headless Chromium
# only. Every spec invocation builds the web app afresh (the spike-b config's webServer).
#
# Playwright wipes its output folder (e2e/test-results/spike-b-<web port>) at every invocation, so each
# spec's output is copied to <log-dir>/<spec>.results after it runs. The listeners on the stack's three
# ports are listed before and after every spec (summary.txt); a leftover listener is recorded and its
# process stopped (the range is O2's).
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
unset VITE_LOBBY_ENGINE VITE_DRAFTROOM_DEV_AUTH LOBBY_HOST_REWRITE DRAFTROOM_ENGINE DRAFTROOM_TEST_HOOKS SPIKE_B8_DIR
root="${1:?repo root}"
logs="${2:?log dir}"
shift 2
: "${SPIKE_B_PORT_BASE:?set SPIKE_B_PORT_BASE}"
base=$SPIKE_B_PORT_BASE
web=$((base + 2))
specs=("$@")
if [ ${#specs[@]} -eq 0 ]; then
  specs=(b2-undo b3-l1-l5 b3-l7 b3-l9-l12 b3-l13-chords b3-l13-keys-k b3-l12-lease-l b3-l6-l10 b4-client b5-r3)
fi
mkdir -p "$logs"
listeners() {
  netstat -ano | grep -E "(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):($base|$((base + 1))|$web)\s" | grep LISTENING
}
cd "$root/e2e" || exit 2
echo "start $(date -u +%FT%TZ) head $(git -C "$root" rev-parse --short HEAD) base $base" | tee -a "$logs/summary.txt"
for s in "${specs[@]}"; do
  pre=$(listeners)
  [ -n "$pre" ] && echo "$s: listeners BEFORE: $pre" | tee -a "$logs/summary.txt"
  start=$(date +%s)
  pnpm exec playwright test -c spike-b/playwright.config.ts "$s" >"$logs/$s.log" 2>&1
  code=$?
  counts=$(grep -E '^\s+[0-9]+ (passed|failed|skipped|flaky|did not run|interrupted)' "$logs/$s.log" | tr -s ' ' | tr '\n' ' ')
  echo "$s exit=$code seconds=$(($(date +%s) - start)) [$counts]" | tee -a "$logs/summary.txt"
  out="$root/e2e/test-results/spike-b-$web"
  [ -d "$out" ] && rm -rf "$logs/$s.results" && cp -r "$out" "$logs/$s.results"
  post=$(listeners)
  if [ -n "$post" ]; then
    echo "$s: listeners AFTER: $post" | tee -a "$logs/summary.txt"
    for pid in $(echo "$post" | awk '{print $NF}' | sort -u); do taskkill //F //T //PID "$pid" >/dev/null 2>&1; done
  fi
done
echo "end $(date -u +%FT%TZ); listeners now: [$(listeners)]" | tee -a "$logs/summary.txt"
