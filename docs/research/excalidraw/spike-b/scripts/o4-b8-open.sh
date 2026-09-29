#!/usr/bin/env bash
# O4's B8 rows that need conversion on open (docs/EXCALIDRAW-MIGRATION.md §8.3 B8, §8.6.7, §8.6.8), 3 runs
# each (RUNS), one after the other, a fresh web build per run (one Playwright invocation per run):
#   generated  per run: a fresh corpus (tour, multi-page, heavy, 8 fixtures) made on the R0 stand-in (7900),
#              then b8-two-browsers (every board converted on open by the Excalidraw stack at base 7905,
#              opened in two browsers) and b8-drill (the rollback drill on every board: conversion on open,
#              A in a browser, the R0 stand-in with B's edits and the born-after refusal against a board
#              created on the Excalidraw build, the roll-forward on open, two cycles); each run's Playwright
#              output is MOVED to <out-dir>/run<N>/results (Playwright wipes it per invocation, and O4's
#              default output folder stays empty for the leak check's default scope);
#   staging    (with --staging) per run: b8-staging-two-browsers (every restored copy) and b8-staging-drill
#              (the largest copy by records) in project b8-staging, with TEMP/TMP, data dirs, logs, reports
#              and Playwright output inside SPIKE_B8_DIR (traces, videos and screenshots off), then the leak
#              check (a count only).
#
#   bash docs/research/excalidraw/spike-b/scripts/o4-b8-open.sh <repo-root> <out-dir> [--staging]
#
# <out-dir> holds the generated runs (no staging data ever goes there). Env: SPIKE_B8_DIR (with --staging),
# RUNS (default 3), SKIP_GENERATED=1 (the staging runs only). Prints exit codes, pass counts and the summaries of e2e/spike-b/b8/summarize.ts (ids,
# counts, codes, timings, bytes, hashes); staging logs stay inside SPIKE_B8_DIR and are never printed.
set -u
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
listeners() { netstat -ano | grep LISTENING | grep -cE ':790[0-9] '; }
counts() { grep -oE '^ +[0-9]+ (passed|failed|flaky|skipped)' "$1" | tr -s ' ' | tr '\n' ' '; }
echo "commit $(git rev-parse --short HEAD) dirty $(git status --porcelain | wc -l) listeners 7900-7909 before: $(listeners)"
echo "start $(date -u +%H:%M:%SZ)"
fail=0
mkdir -p "$out"
pw="e2e/test-results/spike-b-7907"

# ---- generated ----
[ "${SKIP_GENERATED:-}" = "1" ] && runs_g=0 || runs_g="$runs"
for i in $(seq 1 "$runs_g"); do
  r="$out/run$i"
  mkdir -p "$r"
  node e2e/spike-b/b8/corpus.ts --out "$r/corpus" >"$r/corpus.log" 2>&1 || { echo "corpus run$i failed"; fail=1; continue; }
  (unset SPIKE_B8_DIR; SPIKE_B_PORT_BASE=7905 B8_CORPUS="$r/corpus" \
    pnpm --filter @draftroom/e2e spike-b --project=chromium b8-two-browsers b8-drill >"$r/pw.log" 2>&1)
  c=$?
  [ $c -eq 0 ] || fail=1
  rm -rf "$r/results"
  mv "$pw" "$r/results" 2>/dev/null
  echo "generated run$i $(date -u +%H:%M:%SZ) exit=$c $(counts "$r/pw.log")"
done
if [ "$runs_g" != "0" ]; then
  node e2e/spike-b/b8/summarize.ts two "$out"/run*/results/b8-two-browsers-*/b8-two-browsers.json || fail=1
  node e2e/spike-b/b8/summarize.ts drill "$out"/run*/results/b8-drill-*/*.drill.json || fail=1
fi

# ---- staging (§8.6.7) ----
if [ "$staging" = "--staging" ]; then
  : "${SPIKE_B8_DIR:?set SPIKE_B8_DIR}"
  B8="$SPIKE_B8_DIR"
  tag="q$(date +%H%M)"
  logs="$B8/logs-$tag"
  mkdir -p "$logs" "$B8/t3" "$B8/w3"
  for i in $(seq 1 "$runs"); do
    (export TEMP="$B8/t3" TMP="$B8/t3" TMPDIR="$B8/t3"
     SPIKE_B_PORT_BASE=7905 B8_RUN="${tag}r$i" \
       pnpm --filter @draftroom/e2e spike-b --project=b8-staging b8-staging-two-browsers b8-staging-drill \
       >"$logs/run$i.log" 2>&1)
    c=$?
    [ $c -eq 0 ] || fail=1
    rm -rf "$B8/w3/pw-${tag}r$i"
    cp -r "$B8/test-results" "$B8/w3/pw-${tag}r$i" 2>/dev/null
    echo "staging run$i $(date -u +%H:%M:%SZ) exit=$c $(counts "$logs/run$i.log")"
  done
  node e2e/spike-b/b8/summarize.ts two "$B8"/reports/b8-staging-two-browsers-${tag}r*.json || fail=1
  node e2e/spike-b/b8/summarize.ts drill "$B8"/reports/b8-staging-drill-room-${tag}r*.json || fail=1
  # the scope: §8.6.7's defaults, this invocation's logs, data dirs, reports and Playwright copies (w3), and
  # its TEMP except the two caches of compiled repo source (node-compile-cache, playwright-transform-cache:
  # source code, which the search leaves out; template text in them matches boards made from templates)
  extra=()
  for d in "$B8"/t3/*; do
    case "$(basename "$d")" in node-compile-cache | playwright-transform-cache) ;; *) extra+=(--scan "$d") ;; esac
  done
  node e2e/spike-b/b8/leak-check.ts --scan "$logs" --scan "$B8/w3" "${extra[@]}" || fail=1
  # the generated runs' outputs (they never read a staging copy), counted apart
  echo "generated outputs: $(node e2e/spike-b/b8/leak-check.ts --no-defaults --scan "$out" | grep -oE '^leak-check: [0-9]+ matches')"
  echo "staging outputs: w3/2b-${tag}r*, w3/dr-${tag}r*, w3/pw-${tag}r*, reports/b8-staging-{two-browsers,drill-room}-${tag}r*, logs-$tag, t3 (inside SPIKE_B8_DIR)"
fi
echo "end $(date -u +%H:%M:%SZ) listeners 7900-7909 after: $(listeners)"
echo "result: $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
