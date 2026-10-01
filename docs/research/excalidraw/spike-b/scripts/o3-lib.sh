#!/usr/bin/env bash
# Shared bits of O3's workstation run scripts (docs/EXCALIDRAW-MIGRATION.md §8.6.5, §8.6.8): Node on PATH,
# the repo root, a log folder outside the repo, and the listener check of O3's port range 7880–7899
# before and after every run (O3 leaves nothing listening). Sourced by o3-*.sh.
set -euo pipefail
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
LOGDIR="${O3_LOGDIR:-${TMPDIR:-/tmp}/o3-runs}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$LOGDIR"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOGDIR/run.log" >&2; }

# Listeners in O3's range (Windows netstat): prints "port pid" lines, nothing when it is free. The range is
# 7880-7899; O3_CHECK_RANGE=<lo>-<hi> narrows it to one stack's ports when O3 runs two of its own stacks
# side by side (e.g. O3_CHECK_RANGE=7880-7882 for o3-checks.sh while a measurement stack runs on 7885).
CHECK_RANGE="${O3_CHECK_RANGE:-7880-7899}"
CHECK_LO="${CHECK_RANGE%-*}"
CHECK_HI="${CHECK_RANGE#*-}"
if (( CHECK_LO < 7880 || CHECK_HI > 7899 || CHECK_LO > CHECK_HI )); then echo "O3_CHECK_RANGE outside 7880-7899" >&2; exit 2; fi
o3_listeners() {
  netstat -ano -p tcp 2>/dev/null | awk -v lo="$CHECK_LO" -v hi="$CHECK_HI" '$4 == "LISTENING" {n = split($2, a, ":"); p = a[n] + 0; if (p >= lo && p <= hi) print p, $5}' | sort -u
}
check_free() {
  local l
  l="$(o3_listeners)"
  if [[ -n "$l" ]]; then log "listeners in $CHECK_LO-$CHECK_HI ($1):"; printf '%s\n' "$l" | tee -a "$LOGDIR/run.log" >&2; return 1; fi
  log "$CHECK_LO-$CHECK_HI free ($1)"
}

# Runs one spike B Playwright spec file on a base, as run $2 (a fresh web build per invocation). Playwright
# wipes its output folder (e2e/test-results/spike-b-<web port>) on every invocation, so the run's folder
# (evidence JSON, traces, screenshots) is copied to $LOGDIR/<spec>-run<n>.results right after it.
run_spec() {
  local base="$1" run="$2" spec="$3" code=0
  shift 3
  local name out
  name="$(basename "$spec" .spec.ts)"
  out="$REPO/e2e/test-results/spike-b-$((base + 2))"
  log "run $run: $spec on $base $*"
  (cd "$REPO/e2e" && env SPIKE_B_PORT_BASE="$base" SPIKE_B_RUN="$run" "$@" pnpm exec playwright test -c spike-b/playwright.config.ts "$spec") \
    >"$LOGDIR/$name-run$run.log" 2>&1 || code=$?
  if [[ -d "$out" ]]; then rm -rf "$LOGDIR/$name-run$run.results"; cp -r "$out" "$LOGDIR/$name-run$run.results"; fi
  grep -hE '^\s+[0-9]+ (passed|failed|skipped|flaky|did not run|interrupted)' "$LOGDIR/$name-run$run.log" | tr -s ' ' | tr '\n' ' ' | sed "s/^/$name run $run: /" | tee -a "$LOGDIR/run.log" >&2 || true
  printf '\n' >&2
  return "$code"
}
