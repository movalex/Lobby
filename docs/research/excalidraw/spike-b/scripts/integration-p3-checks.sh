#!/usr/bin/env bash
# Spike B, the lead's part-3 integration (docs/EXCALIDRAW-MIGRATION.md §8.6.4, §8.6.8): EVERY spec in
# e2e/spike-b/tests ONCE on the integrated tree, one after the other, each with a fresh build and its own
# log, except B8's staging rows (b8-staging-*, O4 only, §8.6.7) and B9's NAS half (scripts/nas-*, O3).
# Unlike integration-m3-checks.sh this also runs B8's generated two-browser rows and drill, B9's workstation
# half (SPIKE_B9_WS=1), the perf-* specs (SPIKE_PERF=1) and O3's pan probe. It is NOT a quiet window, so
# every timing number is informational (§8.6.4).
# After the checks: the owner probes b7-probe-lost-create (O5), b9-probe-lost-edit and perf-probe-pan (O3,
# SPIKE_B_PROBES=1), and the harness's guest sign-in self-test (O3, `selftest-guest`).
#
#   INT_OUT=<log dir> bash docs/research/excalidraw/spike-b/scripts/integration-p3-checks.sh [spec ...]
#
# Ports: the lead's range only (§8.6.5): the stack on base 7850 (sync 7850, api 7851, web 7852); B8's
# stand-in and corpus sync on 7858 (SPIKE_B8_STANDIN_PORT). Listeners in 7850-7859 are listed before and
# after every spec; a leftover listener is recorded (and its process stopped, since the range is the lead's).
# Every stack runs with DRAFTROOM_BACKUP_STORE=off (the harness forces it). Headless Chromium only.
# b3-l6-l10-arrows runs with NODE_OPTIONS=--max-old-space-size=16384: O2 saw Playwright's own runner run out
# of its default heap after about an hour of L6 1-2 on old and new code alike (O2-part3.md).
# Playwright wipes its outputDir per invocation, so each spec's output folder is copied next to its log.
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
unset VITE_LOBBY_ENGINE VITE_DRAFTROOM_DEV_AUTH VITE_LOBBY_BOARD_PAGE LOBBY_HOST_REWRITE DRAFTROOM_ENGINE \
  DRAFTROOM_TEST_HOOKS SPIKE_B8_DIR SPIKE_B9_WS SPIKE_PERF SPIKE_B_QUIET SPIKE_REPS NODE_OPTIONS
export SPIKE_B_PORT_BASE=7850 SPIKE_B8_STANDIN_PORT=7858 SPIKE_B11=1 SPIKE_B_PROBES=1 DRAFTROOM_BACKUP_STORE=off
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
OUT=${INT_OUT:-/tmp/int-p3}
mkdir -p "$OUT"
specs=("$@")
if [ ${#specs[@]} -eq 0 ]; then
  specs=(m1-walking-skeleton b1-concurrent-fields b2-undo b3-l1-l5-lease b3-l6-l10-arrows b3-l7-offline
    b3-l8-leased-forged b3-l9-l12-guard b3-l12-lease-l b3-l13-chords b3-l13-keys-k b4-client-durability
    b4-server-d3-sigkill b4-server-d4-commit b5-r1-readonly-forged b5-r2-commenter b5-r3-keys b5-r4-downgrade
    b6-forged b7-files b8-restore b8-screens b8-two-browsers b8-drill b9-visibility b10-echo b11-convergence
    b12-collapse b12-guard b12-phone perf-bundle perf-client perf-fps perf-open
    b7-probe-lost-create b9-probe-lost-edit perf-probe-pan selftest-guest)
fi
# per-spec environment (opt-in gates and the runner heap)
spec_env() {
  case "$1" in
    b9-visibility) echo "SPIKE_B9_WS=1" ;;
    perf-bundle | perf-client | perf-fps | perf-open) echo "SPIKE_PERF=1" ;;
    b3-l6-l10-arrows) echo "NODE_OPTIONS=--max-old-space-size=16384" ;;
    *) echo "" ;;
  esac
}
listeners() { netstat -ano | grep -E "(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):785[0-9]\s" | grep LISTENING; }
cd "$ROOT/e2e" || exit 2
echo "start $(date -u +%FT%TZ) head $(git -C "$ROOT" rev-parse --short HEAD)" | tee -a "$OUT/summary.txt"
for s in "${specs[@]}"; do
  pre=$(listeners)
  [ -n "$pre" ] && echo "$s: listeners BEFORE: $pre" | tee -a "$OUT/summary.txt"
  t0=$(date +%s)
  extra=$(spec_env "$s")
  if [ "$s" = selftest-guest ]; then
    res="$ROOT/e2e/test-results/spike-b-7852-selftest"
    pnpm exec playwright test -c spike-b/support/selftest/playwright.config.ts guest.spec.ts >"$OUT/$s.log" 2>&1
  else
    res="$ROOT/e2e/test-results/spike-b-7852"
    # shellcheck disable=SC2086
    env $extra pnpm exec playwright test -c spike-b/playwright.config.ts "$s" >"$OUT/$s.log" 2>&1
  fi
  code=$?
  counts=$(grep -E '^\s+[0-9]+ (passed|failed|skipped|flaky|did not run|interrupted)' "$OUT/$s.log" | tr -s ' ' | tr '\n' ' ')
  echo "$s exit=$code seconds=$(($(date +%s) - t0)) ${extra:+($extra) }[$counts]" | tee -a "$OUT/summary.txt"
  # the next invocation wipes the output folder: keep this spec's evidence, traces and screenshots
  [ -d "$res" ] && cp -r "$res" "$OUT/$s.results"
  post=$(listeners)
  if [ -n "$post" ]; then
    echo "$s: listeners AFTER: $post" | tee -a "$OUT/summary.txt"
    for pid in $(echo "$post" | awk '{print $NF}' | sort -u); do taskkill //F //T //PID "$pid" >/dev/null 2>&1; done
  fi
done
echo "end $(date -u +%FT%TZ); listeners 7850-7859 now: [$(listeners)]" | tee -a "$OUT/summary.txt"
