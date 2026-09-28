#!/usr/bin/env bash
# Spike A, host and input owner: runs checks A1 A2 A4 A5 A6 A16 A17 N times in a row (default 3).
# Each run: the canvas unit tests (vitest, web project, apps/web/src/canvas) and one Playwright
# invocation of spike/tests/smoke.spec.ts + spike/tests/host-*.spec.ts, with a fresh build of the
# engine app (the spike config builds apps/web into dist/spike-<port> and serves it with vite preview).
#
#   bash docs/research/excalidraw/spike-a/scripts/host-run.sh [runs]
#
# Env: SPIKE_WEB_PORT (default 7710; the preview proxy also names port+1 and port+2, never started),
#      HOST_OUT (log folder, default /tmp/host-runs). Logs: unit-<n>.log, e2e-<n>.log, e2e-<n>.json.
# Summarise with: node docs/research/excalidraw/spike-a/scripts/host-summary.mjs "$HOST_OUT"
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
RUNS=${1:-3}
OUT=${HOST_OUT:-/tmp/host-runs}
PORT=${SPIKE_WEB_PORT:-7710}
mkdir -p "$OUT"
OUT_ABS=$( (command -v cygpath >/dev/null && cygpath -m "$OUT") || echo "$OUT")
cd "$ROOT" || exit 1
for r in $(seq 1 "$RUNS"); do
  start=$(date +%s)
  npx vitest run --project web apps/web/src/canvas >"$OUT/unit-$r.log" 2>&1
  unit=$?
  (
    cd e2e &&
      PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT_ABS/e2e-$r.json" SPIKE_WEB_PORT=$PORT \
        pnpm exec playwright test -c spike/playwright.config.ts --reporter=list,json \
        spike/tests/smoke.spec.ts spike/tests/host-
  ) >"$OUT/e2e-$r.log" 2>&1
  e2e=$?
  echo "run $r: unit exit $unit, e2e exit $e2e, $(($(date +%s) - start)) s"
done
