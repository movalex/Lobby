#!/usr/bin/env bash
# Spike A integration (branch spike/excalidraw after merging spike/a-node, spike/a-host, spike/a-render):
# one run of the repo gates, the unit suites, the whole spike Playwright suite, the A8 browser probe and
# the normal (tldraw) build grep. Usage:
#
#   INT_OUT=<log dir> bash docs/research/excalidraw/spike-a/scripts/integration-run.sh <run number>
#
# Ports (integration owner): SPIKE_WEB_PORT 7730 (the preview proxy also names 7731/7732; the A7/A11
# files server listens on 7731), A8 probe page 7733. Logs and JSON reports go to $INT_OUT.
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
unset VITE_LOBBY_ENGINE VITE_DRAFTROOM_DEV_AUTH LOBBY_HOST_REWRITE
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
n=${1:?run number}
OUT=${INT_OUT:-/tmp/int-runs}/run$n
mkdir -p "$OUT"
OUT_ABS=$( (command -v cygpath >/dev/null && cygpath -m "$OUT") || echo "$OUT")
cd "$ROOT" || exit 1
st() { if [ "$1" = 0 ]; then echo PASS; else echo "FAIL($1)"; fi; }
t_start=$(date +%s)

pnpm lint >"$OUT/lint.log" 2>&1; r_lint=$?
pnpm -r typecheck >"$OUT/typecheck.log" 2>&1; r_tc=$?
(cd apps/web && npx tsc -p test/engine-probe) >"$OUT/tsc-engine-probe.log" 2>&1; r_tcp=$?
pnpm exec vitest run --project web --project canvas-schema --project engine-probe >"$OUT/unit.log" 2>&1; r_unit=$?
(cd apps/web && node --test build/excalidraw-host-rewrite.test.ts build/excalidraw-assets.test.ts) >"$OUT/plugin-unit.log" 2>&1; r_plug=$?

t0=$(date +%s)
(
  cd e2e &&
    PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT_ABS/spike.json" SPIKE_WEB_PORT=7730 \
      pnpm exec playwright test -c spike/playwright.config.ts --reporter=list,json
) >"$OUT/spike.log" 2>&1
r_spike=$?
t1=$(date +%s)
spike_mtime=$(stat -c %Y apps/web/dist/spike-7730/index.html)

node apps/web/test/engine-probe/a8/run-browser.ts --port=7733 >"$OUT/a8-browser.log" 2>&1; r_a8=$?
cp test-results/engine-probe/a8-browser.json "$OUT/a8-browser.json" 2>/dev/null

# Normal (tldraw) build: no VITE_LOBBY_ENGINE. It must carry no engine code (scaffold markers).
rm -rf apps/web/dist/int-normal
(cd apps/web && pnpm exec vite build --outDir dist/int-normal) >"$OUT/normal-build.log" 2>&1; r_build=$?
hits=0
: >"$OUT/normal-grep.txt"
for m in EXCALIDRAW_ASSET_PATH EXCALIDRAW_THROTTLE_RENDER excalidraw-assets excalidraw__canvas esm.sh __lobbySpike "@excalidraw/" excalidraw-room-persistence oss-collab.excalidraw Xiaolai spike-engine host-lab render-lab Excalifont; do
  c=$(grep -rl -- "$m" apps/web/dist/int-normal | wc -l); echo "$m $c" >>"$OUT/normal-grep.txt"; hits=$((hits + c))
done
[ -d apps/web/dist/int-normal/excalidraw-assets ] && hits=$((hits + 1000))
# Engine flag WITHOUT the dev-auth guard: the spike route, its chunks and the engine fonts must be absent.
# The WHOLE dist is searched (the first version searched assets/ only and missed a 14 MB
# excalidraw-assets/ folder of fonts; the assets plugin now follows the route's gate).
rm -rf apps/web/dist/int-noguard
(cd apps/web && VITE_LOBBY_ENGINE=excalidraw pnpm exec vite build --outDir dist/int-noguard) >"$OUT/noguard-build.log" 2>&1; r_ng=$?
ng=0
: >"$OUT/noguard-grep.txt"
for m in __lobbySpike spike-engine spike-missing excalidraw__canvas EXCALIDRAW_ASSET_PATH "@excalidraw/" excalidraw-assets; do
  c=$(grep -rl -- "$m" apps/web/dist/int-noguard | wc -l); echo "$m $c" >>"$OUT/noguard-grep.txt"; ng=$((ng + c))
done
[ -d apps/web/dist/int-noguard/excalidraw-assets ] && ng=$((ng + 1000))
echo "files $(find apps/web/dist/int-noguard -type f | wc -l)" >>"$OUT/noguard-grep.txt"

echo "run $n: lint=$(st $r_lint) typecheck=$(st $r_tc) engine-probe-tsc=$(st $r_tcp)" \
  "unit=$(st $r_unit) [$(grep -E 'Tests +[0-9]' "$OUT/unit.log" | tr -s ' ')]" \
  "plugin-unit=$(st $r_plug) [$(grep -E ' (pass|fail) [0-9]+$' "$OUT/plugin-unit.log" | tr -s ' ' | tr '\n' ' ')]" \
  "spike=$(st $r_spike) [$(grep -E '^ +[0-9]+ (passed|failed|skipped|flaky)' "$OUT/spike.log" | tr -s ' ' | tr '\n' ' ')in $((t1 - t0)) s, build $([ "$spike_mtime" -ge "$t0" ] && echo fresh || echo STALE)]" \
  "a8-browser=$(st $r_a8) normal-build=$(st $r_build) normal-grep-hits=$hits" \
  "noguard-build=$(st $r_ng) noguard-marker-files=$ng total $(($(date +%s) - t_start)) s" | tee -a "$OUT/../summary.txt"
