#!/usr/bin/env bash
# Spike A fixes after the independent verification (A6: every chord inside the text editor; A16: editors
# opened while a lease request is pending; the assets plugin gate). Usage, from the repo root:
#
#   FIX_OUT=<log dir> bash docs/research/excalidraw/spike-a/scripts/fix-run.sh gates
#   FIX_OUT=<log dir> bash docs/research/excalidraw/spike-a/scripts/fix-run.sh a6a16 <run number>
#   FIX_OUT=<log dir> bash docs/research/excalidraw/spike-a/scripts/fix-run.sh suite
#
# gates: pnpm lint, pnpm -r typecheck, the engine-probe tsc, vitest web + engine-probe, the two plugin
#        node tests, and the engine-flag build WITHOUT the dev-auth guard grepped over its whole dist.
# a6a16: one Playwright invocation (fresh build) of the old and new A6 and A16 specs, into
#        $FIX_OUT/run<n>/spike.json (integration-summary.mjs reads it).
# suite: the whole spike suite once, into $FIX_OUT/suite/spike.json.
# Ports: SPIKE_WEB_PORT 7770 (the preview proxy names 7771/7772; nothing listens there).
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
unset VITE_LOBBY_ENGINE VITE_DRAFTROOM_DEV_AUTH LOBBY_HOST_REWRITE
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
mode=${1:?gates, a6a16 or suite}
BASE=${FIX_OUT:-/tmp/fix-runs}
cd "$ROOT" || exit 1
st() { if [ "$1" = 0 ]; then echo PASS; else echo "FAIL($1)"; fi; }
abs() { (command -v cygpath >/dev/null && cygpath -m "$1") || echo "$1"; }
t_start=$(date +%s)

case "$mode" in
gates)
  OUT=$BASE/gates
  mkdir -p "$OUT"
  pnpm lint >"$OUT/lint.log" 2>&1; r_lint=$?
  pnpm -r typecheck >"$OUT/typecheck.log" 2>&1; r_tc=$?
  (cd apps/web && npx tsc -p test/engine-probe) >"$OUT/tsc-engine-probe.log" 2>&1; r_tcp=$?
  pnpm exec vitest run --project web --project engine-probe >"$OUT/unit.log" 2>&1; r_unit=$?
  (cd apps/web && node --test build/excalidraw-host-rewrite.test.ts build/excalidraw-assets.test.ts) >"$OUT/plugin-unit.log" 2>&1
  r_plug=$?
  rm -rf apps/web/dist/fix-noguard
  (cd apps/web && VITE_LOBBY_ENGINE=excalidraw pnpm exec vite build --outDir dist/fix-noguard) >"$OUT/noguard-build.log" 2>&1
  r_ng=$?
  ng=0
  : >"$OUT/noguard-grep.txt"
  for m in __lobbySpike spike-engine spike-missing excalidraw__canvas EXCALIDRAW_ASSET_PATH "@excalidraw/" excalidraw-assets; do
    c=$(grep -rl -- "$m" apps/web/dist/fix-noguard | wc -l); echo "$m $c" >>"$OUT/noguard-grep.txt"; ng=$((ng + c))
  done
  [ -d apps/web/dist/fix-noguard/excalidraw-assets ] && ng=$((ng + 1000))
  files=$(find apps/web/dist/fix-noguard -type f | wc -l)
  rm -rf apps/web/dist/fix-noguard
  echo "gates: lint=$(st $r_lint) typecheck=$(st $r_tc) engine-probe-tsc=$(st $r_tcp)" \
    "unit=$(st $r_unit) [$(grep -E 'Tests +[0-9]' "$OUT/unit.log" | tr -s ' ')]" \
    "plugin-unit=$(st $r_plug) [$(grep -E ' (pass|fail) [0-9]+$' "$OUT/plugin-unit.log" | tr -s ' ' | tr '\n' ' ')]" \
    "noguard-build=$(st $r_ng) noguard-marker-files=$ng noguard-files=$files total $(($(date +%s) - t_start)) s" |
    tee -a "$BASE/summary.txt"
  ;;
a6a16 | suite)
  if [ "$mode" = a6a16 ]; then
    n=${2:?run number}
    OUT=$BASE/run$n
    specs="spike/tests/host-a6.spec.ts spike/tests/host-a6-editor.spec.ts spike/tests/host-a16.spec.ts spike/tests/host-a16-pending.spec.ts"
  else
    OUT=$BASE/suite
    specs=""
  fi
  mkdir -p "$OUT"
  t0=$(date +%s)
  # shellcheck disable=SC2086
  (
    cd e2e &&
      PLAYWRIGHT_JSON_OUTPUT_NAME="$(abs "$OUT")/spike.json" SPIKE_WEB_PORT=7770 \
        pnpm exec playwright test -c spike/playwright.config.ts $specs --reporter=list,json
  ) >"$OUT/spike.log" 2>&1
  r=$?
  t1=$(date +%s)
  mtime=$(stat -c %Y apps/web/dist/spike-7770/index.html)
  echo "$mode ${2:-}: spike=$(st $r) [$(grep -E '^ +[0-9]+ (passed|failed|skipped|flaky)' "$OUT/spike.log" | tr -s ' ' | tr '\n' ' ')in $((t1 - t0)) s, build $([ "$mtime" -ge "$t0" ] && echo fresh || echo STALE)]" |
    tee -a "$BASE/summary.txt"
  ;;
*)
  echo "unknown mode $mode" >&2
  exit 2
  ;;
esac
