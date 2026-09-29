#!/usr/bin/env bash
# O3's browser checks, 3 runs in a row (§8.6.8: every check 3 times, a fresh build each run), on the
# harness stack 7880 (§8.6.5). B1's races are timing-gated: run it only in the lead's quiet window.
#   bash o3-checks.sh b1|b10|b11|selftest [runs]
# Logs: $O3_LOGDIR/<utc>/ (outside the repo); per-run evidence JSON: e2e/test-results/spike-b-7882/o3/.
source "$(dirname "$0")/o3-lib.sh"
what="${1:?usage: o3-checks.sh b1|b10|b11|selftest [runs]}"
runs="${2:-3}"
check_free before
case "$what" in
  selftest)
    for r in $(seq 1 "$runs"); do
      (cd "$REPO/e2e" && SPIKE_B_PORT_BASE=7880 pnpm exec playwright test -c spike-b/support/selftest/playwright.config.ts) \
        >"$LOGDIR/selftest-run$r.log" 2>&1 && log "selftest run $r: pass" || log "selftest run $r: FAIL (see log)"
    done ;;
  b1) for r in $(seq 1 "$runs"); do run_spec 7880 "$r" tests/b1-concurrent-fields.spec.ts && log "b1 run $r: pass" || log "b1 run $r: FAIL"; done ;;
  b10) for r in $(seq 1 "$runs"); do run_spec 7880 "$r" tests/b10-echo.spec.ts && log "b10 run $r: pass" || log "b10 run $r: FAIL"; done
    node "$REPO/e2e/spike-b/support/b10-aggregate.ts" "$REPO/e2e/test-results/spike-b-7882" | tee "$LOGDIR/b10-aggregate.txt" || true ;;
  b11) for r in $(seq 1 "$runs"); do run_spec 7880 "$r" tests/b11-convergence.spec.ts SPIKE_B11=1 && log "b11 run $r: pass" || log "b11 run $r: FAIL"; done ;;
  *) log "unknown check $what"; exit 2 ;;
esac
check_free after
log "logs: $LOGDIR"
