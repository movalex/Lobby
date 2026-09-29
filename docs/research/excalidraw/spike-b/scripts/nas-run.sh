#!/usr/bin/env bash
# One B9 run on the NAS (§8.3 B9, §8.6.6): fresh boards, fresh secrets, sync under Render's limits on an
# --internal network with no published port, the load generator next to it, the host sampler, the SIGKILL
# at minute 8 (L1), then the reports back to the workstation and the run's containers removed by name.
#
# Usage: DRY_RUN=0 bash nas-run.sh <L1|L2> <tag> [--cul] [--presence-env NAME=VALUE] [--overcap-notes N] [--duration-s S]
#   --cul            the conversion-under-load run: at minute 5 a joiner opens cul-heavy (a lazy conversion),
#                    a second opens cul-second (it must queue), and the planted cul-overcap is opened too
#   --presence-env   the room's switch between one shared presence frame and per-view frames (O1's knob;
#                    its name is confirmed at M2), for the presence-mode comparison run
#
# Deviation from §8.3's listing, on purpose: sync also runs with DRAFTROOM_TEST_HOOKS=1 (no NODE_ENV=
# production), so the load generator can read every board back through the test snapshot at the end for
# the acked-but-missing check; nothing else changes. The fake api listens inside the load container on
# 7899 of the internal network only.
source "$(dirname "$0")/nas-lib.sh"
P="${1:?usage: nas-run.sh <L1|L2> <tag> [...]}"
TAG="${2:?usage: nas-run.sh <L1|L2> <tag> [...]}"
shift 2
CUL=""
PRESENCE_ENV=""
OVERCAP=60000
DURATION=""
while (($#)); do
  case "$1" in
    --cul) CUL="--cul" ;;
    --presence-env) PRESENCE_ENV="-e $2"; shift ;;
    --overcap-notes) OVERCAP="$2"; shift ;;
    --duration-s) DURATION="--duration-s $2"; shift ;;
    *) log "unknown option $1"; exit 2 ;;
  esac
  shift
done
[[ "$P" == L1 || "$P" == L2 ]] || { log "profile must be L1 or L2"; exit 2; }
[[ "$TAG" =~ ^[a-z0-9-]{1,32}$ ]] || { log "tag must match [a-z0-9-]{1,32}"; exit 2; }
U="$(nas_uid | tail -1)"
HOSTFILE="/reports/host-$P-$TAG.jsonl"
log "run $P $TAG ${CUL} ${PRESENCE_ENV} (DRY_RUN=$DRY_RUN)"

# 0. nothing of an earlier run may still be there
if [[ "$DRY_RUN" == "0" ]]; then
  left="$(nas "docker ps -a --filter name=^draftroom-spike-sync\$ --filter name=^draftroom-spike-load\$ --format '{{.Names}}'")"
  [[ -z "$left" ]] || { log "STOP: containers of an earlier run are still there: $left (nas-cleanup.sh)"; exit 1; }
fi

# 1. fresh boards: the data folder is emptied (this exact path only) and regenerated in a --network none container
nas "rm -rf -- $S/data && mkdir -p $S/data $S/reports"
nas "docker run --rm --name $C_GEN --user $U --network none -v $S/src:/app:ro -v $S/data:/var/data -w /app '$IMG' node e2e/load/gen-boards.ts --data-dir /var/data --profile $P ${CUL:+--cul --overcap-notes $OVERCAP}" | tee -a "$LOG"
check_cap

# 2. the per-run secrets, generated on the NAS inside the folder (never printed)
nas "docker run --rm --name $C_SECRETS --user $U --network none -v $S/src:/app:ro -v $S:/s -w /app '$IMG' node e2e/load/write-run-env.ts --out /s/run.env --api-url http://$C_LOAD:7899"

# 3. the internal network, sync under the Render-sized limits, the load generator
nas "docker network inspect $NET >/dev/null 2>&1 || docker network create --internal $NET"
nas "docker run -d --init --name $C_SYNC --user $U --network $NET --cpus=0.5 --memory=512m --memory-swap=512m -v $S/src:/app:ro -v $S/data:/var/data -w /app --env-file $S/run.env -e HOST=0.0.0.0 -e PORT=5858 -e DRAFTROOM_DATA_DIR=/var/data -e DRAFTROOM_ENGINE=excalidraw -e DRAFTROOM_BACKUP_STORE=off -e DRAFTROOM_TEST_HOOKS=1 $PRESENCE_ENV '$IMG' node apps/sync/src/server.ts"
nas "docker run -d --init --name $C_LOAD --user $U --network $NET --cpus=4 --memory=2g -v $S/src:/app:ro -v $S/reports:/reports -w /app --env-file $S/run.env '$IMG' node e2e/load/run.ts --profile $P --sync http://$C_SYNC:5858 --api-listen 0.0.0.0:7899 --out /reports --tag $TAG --threads 4 --host-samples $HOSTFILE $CUL $DURATION"

# 4. the host sampler (docker stats every 10 s, du every 30 s, the 2,048 MB stop) and, for L1, the kill at minute 8
nas_stdin "cat > $S/sampler.sh" <"$(dirname "$0")/nas-sampler.sh"
nas "nohup sh $S/sampler.sh $S $S/reports/host-$P-$TAG.jsonl $CAP_MB >/dev/null 2>&1 &"
if [[ "$P" == L1 && -z "$DURATION" ]]; then
  nas "nohup sh -c 'sleep 480; date +%s%3N > $S/reports/kill-$P-$TAG.txt; docker kill --signal=KILL $C_SYNC; docker start $C_SYNC; date +%s%3N >> $S/reports/kill-$P-$TAG.txt' >/dev/null 2>&1 &"
fi

# 5. wait for the load generator, then bring back only the JSON/markdown reports (never a board file)
nas "docker wait $C_LOAD"
mkdir -p "$EVIDENCE_DIR/b9"
# no OOM of the sync container, and how often it restarted (the kill is one)
nas "docker inspect $C_SYNC --format 'sync: OOMKilled={{.State.OOMKilled}} restarts={{.RestartCount}} exit={{.State.ExitCode}} status={{.State.Status}}'" | tee -a "$LOG"
for f in "$P-$TAG.json" "$P-$TAG.md" "host-$P-$TAG.jsonl" "kill-$P-$TAG.txt"; do
  if [[ "$DRY_RUN" == "0" ]]; then nas "test -f $S/reports/$f && cat $S/reports/$f" >"$EVIDENCE_DIR/b9/$f" || true
  else nas "cat $S/reports/$f"; fi
done
nas "docker logs --tail 300 $C_LOAD" >"$EVIDENCE_DIR/b9/load-$P-$TAG.log" 2>&1 || true
nas "docker logs --tail 300 $C_SYNC" >"$EVIDENCE_DIR/b9/sync-$P-$TAG.log" 2>&1 || true
nas "test -f $S/reports/STOP && cat $S/reports/STOP || true" | tee -a "$LOG"

# 6. the run's containers, by name after a listing; the network and the folder stay for the next run
list_spike | tee -a "$LOG"
remove_container "$C_LOAD"
remove_container "$C_SYNC"
if [[ -n "$CUL" ]]; then
  # with sync stopped: the planted board must still be on its tldraw tables, the other two converted
  # (table names only; opened read-only; --network none)
  nas "docker run --rm --name $C_GEN --user $U --network none -v $S/src:/app:ro -v $S/data:/var/data -w /app '$IMG' node e2e/load/board-tables.ts /var/data/rooms/board-cul-overcap.sqlite /var/data/rooms/board-cul-heavy.sqlite /var/data/rooms/board-cul-second.sqlite" | tee "$EVIDENCE_DIR/b9/cul-tables-$TAG.jsonl"
fi
nas "rm -f -- $S/run.env"
check_cap
log "run $P $TAG done; reports in $EVIDENCE_DIR/b9"
