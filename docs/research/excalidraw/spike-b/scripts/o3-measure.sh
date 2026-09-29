#!/usr/bin/env bash
# The §8.4 client, render and bundle numbers (docs/EXCALIDRAW-MIGRATION.md §8.4, §8.5), 3 runs each, IN THE
# LEAD'S QUIET WINDOW (no other stack, build or browser on the workstation), on the measurement stack 7885:
#   1. perf-open, perf-fps, perf-client, perf-bundle (Excalidraw, the spike board through the real stack);
#   2. spike A14's tldraw baseline spec (render-a14-tldraw, unchanged, same method), re-run in the same
#      window so both engines are measured in the same machine state: its perf stack on E2E_PORT_BASE=7885
#      (after the Excalidraw stack has stopped), spike A's web server on SPIKE_WEB_PORT=7898 with its
#      proxy targets pointed into O3's range.
# Tracing is off for every measured run: the perf-* specs say so themselves (test.use), and spike A's frozen
# baseline spec gets `--trace off` on the command line, so both engines run without Playwright's trace
# (its screencast and snapshots add main-thread work). Each run's output folder is copied into $LOGDIR
# (run_spec; spike A's A14 JSON is written outside its output folder, test-results/spike-7898-a14/).
#   bash o3-measure.sh [runs]
source "$(dirname "$0")/o3-lib.sh"
runs="${1:-3}"
check_free before
for r in $(seq 1 "$runs"); do
  for spec in perf-open perf-fps perf-client perf-bundle; do
    run_spec 7885 "$r" "tests/$spec.spec.ts" SPIKE_PERF=1 && log "$spec run $r: pass" || log "$spec run $r: FAIL (see log)"
  done
  check_free "after the Excalidraw run $r"
  log "tldraw baseline run $r"
  (cd "$REPO/e2e" && E2E_PORT_BASE=7885 SPIKE_WEB_PORT=7898 SPIKE_API_ORIGIN=http://127.0.0.1:7886 SPIKE_SYNC_ORIGIN=http://127.0.0.1:7885 \
    SPIKE_A14_TLDRAW=1 SPIKE_A14_RUN="$r" pnpm exec playwright test -c spike/playwright.config.ts --trace off render-a14-tldraw.spec.ts) \
    >"$LOGDIR/a14-tldraw-run$r.log" 2>&1 && log "tldraw baseline run $r: pass" || log "tldraw baseline run $r: FAIL (see log)"
  grep -h 'A14' "$LOGDIR/a14-tldraw-run$r.log" | tail -8 | tee -a "$LOGDIR/run.log" >&2 || true
  check_free "after the tldraw run $r"
done
log "logs: $LOGDIR; evidence JSON: e2e/test-results/spike-b-7887/o3/perf-*/ and e2e/test-results/spike-7898-a14/"
