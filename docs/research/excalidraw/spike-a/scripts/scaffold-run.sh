#!/usr/bin/env bash
# One SCAFFOLD run: lint, typecheck, web unit tests, spike smoke, normal build + grep. Usage: scaffold-run.sh <n>
set -u
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
unset VITE_LOBBY_ENGINE
cd /c/Users/Chase/Documents/GitHub/Draftroom-spike
n=$1
out=${SCAFFOLD_OUT:-/tmp/scaffold-runs}/run$n
mkdir -p $out
st() { if [ "$1" = 0 ]; then echo PASS; else echo "FAIL($1)"; fi; }
pnpm lint > $out/lint.log 2>&1; r_lint=$?
pnpm -r typecheck > $out/typecheck.log 2>&1; r_tc=$?
pnpm exec vitest run --project web > $out/unit.log 2>&1; r_unit=$?
t0=$(date +%s)
pnpm --filter @draftroom/e2e spike > $out/spike.log 2>&1; r_spike=$?
t1=$(date +%s)
spike_mtime=$(stat -c %Y apps/web/dist/spike-7740/index.html)
rm -rf apps/web/dist/normal-check
(cd apps/web && pnpm exec vite build --outDir dist/normal-check) > $out/normal-build.log 2>&1; r_build=$?
hits=0
for m in EXCALIDRAW_ASSET_PATH EXCALIDRAW_THROTTLE_RENDER excalidraw-assets excalidraw__canvas esm.sh __lobbySpike "@excalidraw/" excalidraw-room-persistence oss-collab.excalidraw Xiaolai spike-engine; do
  c=$(grep -rl -- "$m" apps/web/dist/normal-check | wc -l); echo "$m $c" >> $out/normal-grep.txt; hits=$((hits + c))
done
[ -d apps/web/dist/normal-check/excalidraw-assets ] && hits=$((hits + 1000))
rm -rf apps/web/dist/noguard-check
(cd apps/web && VITE_LOBBY_ENGINE=excalidraw pnpm exec vite build --outDir dist/noguard-check) > $out/noguard-build.log 2>&1; r_ng=$?
ng=0
for m in __lobbySpike spike-engine spike-missing excalidraw__canvas EXCALIDRAW_ASSET_PATH "@excalidraw/"; do ng=$((ng + $(grep -rl -- "$m" apps/web/dist/noguard-check/assets | wc -l))); done
echo "run $n: lint=$(st $r_lint) typecheck=$(st $r_tc) unit=$(st $r_unit) [$(grep -E 'Tests +[0-9]' $out/unit.log | tr -s ' ')] spike=$(st $r_spike) [$(grep -E '[0-9]+ (passed|failed)' $out/spike.log | tr -s ' ' | tr '\n' ' ')in $((t1 - t0))s, build mtime $spike_mtime >= start $t0: $([ $spike_mtime -ge $t0 ] && echo fresh || echo STALE)] normal-build=$(st $r_build) grep-hits=$hits assets=$(ls apps/web/dist/normal-check/assets | wc -l) engine-only-build=$(st $r_ng) engine-only-marker-files=$ng"
grep SCAFFOLD-METRICS $out/spike.log
