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

# Listeners on 7880-7899 (Windows netstat): prints "port pid" lines, nothing when the range is free.
o3_listeners() {
  netstat -ano -p tcp 2>/dev/null | awk '$4 == "LISTENING" {n = split($2, a, ":"); p = a[n] + 0; if (p >= 7880 && p <= 7899) print p, $5}' | sort -u
}
check_free() {
  local l
  l="$(o3_listeners)"
  if [[ -n "$l" ]]; then log "listeners in 7880-7899 ($1):"; printf '%s\n' "$l" | tee -a "$LOGDIR/run.log" >&2; return 1; fi
  log "7880-7899 free ($1)"
}

# Runs one spike B Playwright spec file on a base, as run $2 (a fresh web build per invocation).
run_spec() {
  local base="$1" run="$2" spec="$3"
  shift 3
  log "run $run: $spec on $base $*"
  (cd "$REPO/e2e" && env SPIKE_B_PORT_BASE="$base" SPIKE_B_RUN="$run" "$@" pnpm exec playwright test -c spike-b/playwright.config.ts "$spec") \
    >"$LOGDIR/$(basename "$spec" .spec.ts)-run$run.log" 2>&1
}
