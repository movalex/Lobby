#!/usr/bin/env bash
# The local dry run of the load generator (§8.6.5: 7890): the same commands the NAS runs, on the
# workstation, without Docker or limits, to check the plumbing end to end before a NAS session:
# gen-boards into a scratch data dir, a per-run run.env (never printed), the real sync (excalidraw engine,
# test hooks on, backups off) on 7890, the load generator with its fake api on 7891, the dry profile for
# 60 s (or L1/L2 shortened with --duration-s), the fsync probe, then everything stopped and 7880-7899 free.
#   bash o3-load-dry.sh [profile] [duration-s]        (profile: dry | L1 | L2)
# Needs M2 (O1's room, O2's headless client). Plain `--fake` needs neither:
#   node e2e/load/run.ts --profile dry --fake --out <dir>
source "$(dirname "$0")/o3-lib.sh"
P="${1:-dry}"
DUR="${2:-60}"
DATA="$LOGDIR/data"
mkdir -p "$DATA"
check_free before
# the refusal of §8.6.7: never an R2 or backup variable in the environment of a spike process
if env | grep -qE '^(R2_|DRAFTROOM_BACKUP_R2_)'; then log "REFUSED: R2 variables in the environment"; exit 1; fi
cd "$REPO"
gen_profile="$P"; [[ "$P" == dry ]] && gen_profile=dry
node e2e/load/gen-boards.ts --data-dir "$DATA" --profile "$gen_profile" | tee -a "$LOGDIR/run.log"
node e2e/load/write-run-env.ts --out "$LOGDIR/run.env" --api-url http://127.0.0.1:7891 >/dev/null
node e2e/load/fsync-probe.ts --dir "$DATA" --n 500 | tee "$LOGDIR/fsync.json"
set -a; source "$LOGDIR/run.env"; set +a
HOST=127.0.0.1 PORT=7890 DRAFTROOM_DATA_DIR="$DATA" DRAFTROOM_ENGINE=excalidraw DRAFTROOM_TEST_HOOKS=1 DRAFTROOM_BACKUP_STORE=off \
  node apps/sync/src/server.ts >"$LOGDIR/sync.log" 2>&1 &
SYNC_PID=$!
trap 'kill $SYNC_PID 2>/dev/null || true; rm -f "$LOGDIR/run.env"' EXIT
node e2e/load/run.ts --profile "$P" --sync http://127.0.0.1:7890 --api-listen 127.0.0.1:7891 --out "$LOGDIR/reports" \
  --tag dry --threads 2 --duration-s "$DUR" --seed file | tee -a "$LOGDIR/run.log"
kill "$SYNC_PID" 2>/dev/null || true
wait "$SYNC_PID" 2>/dev/null || true
check_free after
log "reports: $LOGDIR/reports"
