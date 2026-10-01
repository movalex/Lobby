#!/usr/bin/env bash
# Spike B contracts step C0 (docs/EXCALIDRAW-MIGRATION.md §8.6.2 "Gate for C0"): one run of the gates.
#
#   INT_OUT=<log dir> bash docs/research/excalidraw/spike-b/scripts/integration-c0.sh <run number>
#
# Ports (the lead's range, §8.6.5): the spike A suite on SPIKE_WEB_PORT=7850 (its preview proxy names
# 7851/7852; the A7/A11 files server listens on 7851), the A8 browser probe on 7853. The spike B contract
# check in a browser binds no port (page.route). Logs go to $INT_OUT/run<n>.
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
unset VITE_LOBBY_ENGINE VITE_DRAFTROOM_DEV_AUTH LOBBY_HOST_REWRITE DRAFTROOM_ENGINE DRAFTROOM_TEST_HOOKS
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
n=${1:?run number}
OUT=${INT_OUT:-/tmp/int-c0}/run$n
mkdir -p "$OUT"
OUT_ABS=$( (command -v cygpath >/dev/null && cygpath -m "$OUT") || echo "$OUT")
cd "$ROOT" || exit 1
st() { if [ "$1" = 0 ]; then echo PASS; else echo "FAIL($1)"; fi; }
t_start=$(date +%s)

pnpm lint >"$OUT/lint.log" 2>&1; r_lint=$?
pnpm -r typecheck >"$OUT/typecheck.log" 2>&1; r_tc=$?
(cd apps/web && npx tsc -p test/engine-probe) >"$OUT/tsc-engine-probe.log" 2>&1; r_tcp=$?
pnpm exec tsc -p apps/sync/tsconfig.node-safe.json --noEmit >"$OUT/tsc-node-safe.log" 2>&1; r_ns=$?
# the whole default unit run (every project), then the spike A subset it contains, for the comparison
pnpm exec vitest run >"$OUT/unit.log" 2>&1; r_unit=$?
pnpm exec vitest run --project web --project canvas-schema --project engine-probe >"$OUT/unit-spike-a-subset.log" 2>&1; r_sub=$?
(cd apps/web && node --test build/excalidraw-host-rewrite.test.ts build/excalidraw-assets.test.ts) >"$OUT/plugin-unit.log" 2>&1; r_plug=$?
# hash.ts in a browser (the Node half is in the unit run)
(cd e2e && pnpm exec playwright test -c spike-b/contracts/playwright.config.ts --reporter=list) >"$OUT/contracts-browser.log" 2>&1; r_cb=$?
# the C0 arrow acceptance tests: EXPECTED to fail against the stubs; the counts are recorded
pnpm exec vitest run -c vitest.arrows.config.ts >"$OUT/arrows.log" 2>&1; r_arrows=$?

t0=$(date +%s)
(
  cd e2e &&
    PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT_ABS/spike.json" SPIKE_WEB_PORT=7850 \
      pnpm exec playwright test -c spike/playwright.config.ts --reporter=list,json
) >"$OUT/spike.log" 2>&1
r_spike=$?
t1=$(date +%s)
spike_mtime=$(stat -c %Y apps/web/dist/spike-7850/index.html)

node apps/web/test/engine-probe/a8/run-browser.ts --port=7853 >"$OUT/a8-browser.log" 2>&1; r_a8=$?

# Normal (tldraw) build: no VITE_LOBBY_ENGINE. It must carry no engine code (spike A's markers).
rm -rf apps/web/dist/int-c0-normal
(cd apps/web && pnpm exec vite build --outDir dist/int-c0-normal) >"$OUT/normal-build.log" 2>&1; r_build=$?
hits=0
: >"$OUT/normal-grep.txt"
for m in EXCALIDRAW_ASSET_PATH EXCALIDRAW_THROTTLE_RENDER excalidraw-assets excalidraw__canvas esm.sh __lobbySpike "@excalidraw/" excalidraw-room-persistence oss-collab.excalidraw Xiaolai spike-engine host-lab render-lab Excalifont spike-board-stub lobbyCanvas; do
  c=$(grep -rl -- "$m" apps/web/dist/int-c0-normal | wc -l); echo "$m $c" >>"$OUT/normal-grep.txt"; hits=$((hits + c))
done
[ -d apps/web/dist/int-c0-normal/excalidraw-assets ] && hits=$((hits + 1000))
# Engine flag WITHOUT the dev-auth guard: no spike route, no spike board page, no engine chunks or fonts.
rm -rf apps/web/dist/int-c0-noguard
(cd apps/web && VITE_LOBBY_ENGINE=excalidraw pnpm exec vite build --outDir dist/int-c0-noguard) >"$OUT/noguard-build.log" 2>&1; r_ng=$?
ng=0
: >"$OUT/noguard-grep.txt"
for m in __lobbySpike spike-engine spike-missing spike-board-stub excalidraw__canvas EXCALIDRAW_ASSET_PATH "@excalidraw/" excalidraw-assets; do
  c=$(grep -rl -- "$m" apps/web/dist/int-c0-noguard | wc -l); echo "$m $c" >>"$OUT/noguard-grep.txt"; ng=$((ng + c))
done
[ -d apps/web/dist/int-c0-noguard/excalidraw-assets ] && ng=$((ng + 1000))

echo "run $n: lint=$(st $r_lint) typecheck=$(st $r_tc) engine-probe-tsc=$(st $r_tcp) node-safe-tsc=$(st $r_ns)" \
  "unit=$(st $r_unit) [$(grep -E 'Tests +[0-9]' "$OUT/unit.log" | tr -s ' ')]" \
  "spike-A-subset=$(st $r_sub) [$(grep -E 'Tests +[0-9]' "$OUT/unit-spike-a-subset.log" | tr -s ' ')]" \
  "plugin-unit=$(st $r_plug) [$(grep -E ' (pass|fail) [0-9]+$' "$OUT/plugin-unit.log" | tr -s ' ' | tr '\n' ' ')]" \
  "contracts-browser=$(st $r_cb) [$(grep -E '^ +[0-9]+ (passed|failed)' "$OUT/contracts-browser.log" | tr -s ' ' | tr '\n' ' ')]" \
  "arrows(expected to fail at C0)=exit $r_arrows [$(grep -E 'Tests +[0-9]' "$OUT/arrows.log" | tr -s ' ')]" \
  "spike=$(st $r_spike) [$(grep -E '^ +[0-9]+ (passed|failed|skipped|flaky)' "$OUT/spike.log" | tr -s ' ' | tr '\n' ' ')in $((t1 - t0)) s, build $([ "$spike_mtime" -ge "$t0" ] && echo fresh || echo STALE)]" \
  "a8-browser=$(st $r_a8) normal-build=$(st $r_build) normal-grep-hits=$hits" \
  "noguard-build=$(st $r_ng) noguard-marker-files=$ng total $(($(date +%s) - t_start)) s" | tee -a "$OUT/../summary.txt"
