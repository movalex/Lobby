#!/usr/bin/env bash
# O4's B8 rows that need no conversion on open (docs/EXCALIDRAW-MIGRATION.md §8.3 B8, §8.6.7, §8.6.8),
# 3 runs each (RUNS), one after the other:
#   generated  the converter and migrate unit tests; the corpus (tour, multi-page, heavy, 8 fixtures) made
#              on the R0 stand-in (7900); the conversions in the capped worker (conversion, semantic diff,
#              limits, local mode, invariants, the stored rows, byte identity, digests); the restoreElements
#              fixed point in Chromium (a fresh web build of base 7905 per run, web 7907);
#   staging    (with --staging) the same conversion rows and fixed point on copies of the restored staging
#              boards, every data dir, TEMP/TMP, log, report and Playwright output inside SPIKE_B8_DIR
#              (project b8-staging: traces, videos and screenshots off), then the leak check (a count only).
# NOT here: the "open in two browsers" row and the drill (they need conversion on open): o4-b8-open.sh.
#
#   bash docs/research/excalidraw/spike-b/scripts/o4-b8-rows.sh <repo-root> <out-dir> [--staging]
#
# <out-dir> holds the generated runs (no staging data ever goes there). Env: SPIKE_B8_DIR (with --staging),
# RUNS (default 3). Prints exit codes, pass counts and the summaries of e2e/spike-b/b8/summarize.ts (ids,
# counts, codes, timings, bytes, hashes); staging logs stay inside SPIKE_B8_DIR and are never printed.
set -u
# Ports: B8_BASE (default 7900, O4's range): the R0 stand-in on B8_BASE, the Excalidraw stack on B8_BASE + 5
# (sync), + 6 (api) and + 7 (web). 2B runs it with B8_BASE=6470 (its range 6440-6479, wave 5).
b8base="${B8_BASE:-7900}"
export SPIKE_B8_STANDIN_PORT="$b8base"
xbase=$((b8base + 5))
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
root="${1:?repo root}"
out="${2:?out dir}"
staging="${3:-}"
runs="${RUNS:-3}"
cd "$root" || exit 2
if env | grep -qE '^(R2_|DRAFTROOM_BACKUP_R2_)'; then
  echo "refusing: an R2 variable is set"
  exit 2
fi
export DRAFTROOM_BACKUP_STORE=off
listeners() { netstat -ano | grep LISTENING | grep -cE ":($(seq -s "|" "$b8base" $((b8base + 9)))) "; }
echo "commit $(git rev-parse --short HEAD) dirty $(git status --porcelain | wc -l) listeners $b8base-$((b8base + 9)) before: $(listeners)"
fail=0
mkdir -p "$out"

# ---- generated ----
for i in $(seq 1 "$runs"); do
  pnpm exec vitest run packages/tldraw-import apps/sync/test/migrate >"$out/unit-run$i.log" 2>&1
  c=$?
  [ $c -eq 0 ] || fail=1
  echo "unit run$i exit=$c $(grep -E '^ +Tests ' "$out/unit-run$i.log" | tr -s ' ')"
done
node e2e/spike-b/b8/corpus.ts --out "$out/corpus" >"$out/corpus.log" 2>&1 || { echo "corpus failed"; exit 1; }
echo "$(tail -1 "$out/corpus.log")"
for i in $(seq 1 "$runs"); do
  node e2e/spike-b/b8/convert-corpus.ts --corpus "$out/corpus" --work "$out/work-run$i" \
    --out "$out/results-run$i.json" --anchors "$out/corpus/corpus.json" >"$out/convert-run$i.log" 2>&1
  c=$?
  [ $c -eq 0 ] || fail=1
  echo "generated convert run$i exit=$c $(tail -1 "$out/convert-run$i.log")"
done
node e2e/spike-b/b8/summarize.ts convert "$out"/results-run*.json || fail=1
for i in $(seq 1 "$runs"); do
  (unset SPIKE_B8_DIR; SPIKE_B_PORT_BASE=$xbase pnpm --filter @draftroom/e2e spike-b --project=chromium b8-restore \
    >"$out/restore-run$i.log" 2>&1)
  c=$?
  [ $c -eq 0 ] || fail=1
  # Playwright wipes its output folder per invocation: keep each run's report
  cp e2e/test-results/spike-b-$((b8base + 7))/b8-restore-*/b8-restore.json "$out/restore-run$i.json" 2>/dev/null
  echo "generated restore run$i exit=$c $(grep -oE '[0-9]+ (passed|failed|flaky|skipped)' "$out/restore-run$i.log" | tr '\n' ' ')"
done
node e2e/spike-b/b8/summarize.ts restore "$out"/restore-run*.json || fail=1

# ---- staging (§8.6.7) ----
if [ "$staging" = "--staging" ]; then
  : "${SPIKE_B8_DIR:?set SPIKE_B8_DIR}"
  B8="$SPIKE_B8_DIR"
  src=$(ls -d "$B8"/tmp/dr-restore-drill-* | head -1)
  tag="p$(date +%H%M%S)"
  logs="$B8/logs-$tag"
  mkdir -p "$logs" "$B8/tmp-$tag"
  export TEMP="$B8/tmp-$tag" TMP="$B8/tmp-$tag" TMPDIR="$B8/tmp-$tag"
  for i in $(seq 1 "$runs"); do
    node e2e/spike-b/b8/convert-corpus.ts --staging --corpus "$src/rooms" --backups "$src/downloads" \
      --work "$B8/work/$tag-convert-run$i" --out "$B8/reports/b8-staging-$tag-convert-run$i.json" \
      >"$logs/convert-run$i.log" 2>&1
    c=$?
    [ $c -eq 0 ] || fail=1
    echo "staging convert run$i exit=$c $(grep -oE '^convert-corpus: [0-9]+/[0-9]+ boards passed$' "$logs/convert-run$i.log")"
  done
  node e2e/spike-b/b8/summarize.ts convert "$B8"/reports/b8-staging-$tag-convert-run*.json || fail=1
  for i in $(seq 1 "$runs"); do
    SPIKE_B_PORT_BASE=$xbase B8_STAGING_ROOMS="$B8/work/$tag-convert-run$i/rooms" \
      B8_STAGING_REPORT="$B8/reports/b8-staging-$tag-restore-run$i.json" \
      pnpm --filter @draftroom/e2e spike-b --project=b8-staging b8-staging-restore >"$logs/restore-run$i.log" 2>&1
    c=$?
    [ $c -eq 0 ] || fail=1
    echo "staging restore run$i exit=$c $(grep -oE '[0-9]+ (passed|failed|flaky|skipped)' "$logs/restore-run$i.log" | tr '\n' ' ')"
  done
  node e2e/spike-b/b8/summarize.ts restore "$B8"/reports/b8-staging-$tag-restore-run*.json || fail=1
  node e2e/spike-b/b8/leak-check.ts --scan "$logs" --scan "$B8/tmp-$tag" --scan "$out" || fail=1
  echo "staging outputs: work/$tag-*, reports/b8-staging-$tag-*, logs-$tag, tmp-$tag (inside SPIKE_B8_DIR)"
fi
echo "listeners $b8base-$((b8base + 9)) after: $(listeners)"
echo "result: $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
