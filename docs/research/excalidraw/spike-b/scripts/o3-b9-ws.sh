#!/usr/bin/env bash
# B9's workstation half (docs/EXCALIDRAW-MIGRATION.md §8.3 B9): two browsers' A→B edit visibility at 100% and
# at fit while a local L2 runs, 3 runs, IN THE LEAD'S QUIET WINDOW, on stack 7895 (§8.6.5).
#   bash o3-b9-ws.sh [runs]
source "$(dirname "$0")/o3-lib.sh"
runs="${1:-3}"
check_free before
for r in $(seq 1 "$runs"); do
  run_spec 7895 "$r" tests/b9-visibility.spec.ts SPIKE_B9_WS=1 && log "b9 workstation run $r: pass" || log "b9 workstation run $r: FAIL (see log)"
  check_free "after run $r"
done
log "logs: $LOGDIR; evidence JSON: e2e/test-results/spike-b-7897/o3/B9-workstation/ and o3/b9-ws/load-*.json"
