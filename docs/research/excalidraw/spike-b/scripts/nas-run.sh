#!/usr/bin/env bash
# One B9 run on the NAS (§8.3 B9, §8.6.6): fresh boards, fresh secrets, sync under Render's limits on an
# --internal network with no published port, the load generator next to it, the host sampler, the SIGKILL
# at minute 8 (L1), then the reports back to the workstation and the run's containers removed by name.
#
# Usage: DRY_RUN=0 bash nas-run.sh <L1|L2> <tag> [--cul] [--env NAME=VALUE]... [--overcap-notes N] [--duration-s S]
#                                  [--worker-heap-mb N]
#   --cul            the conversion-under-load run: at minute 5 a joiner opens cul-heavy (a lazy conversion),
#                    a second opens cul-second (it must queue), and the planted cul-overcap is opened too
#   --env            one extra environment variable for SYNC (repeatable; --presence-env is the same). Two
#                    test-only preloads of e2e/load use it, each for ONE comparison run:
#                    - the presence-mode comparison: O1's room has no switch (it serializes one frame for
#                      everyone up to 41 sessions and per-view capped frames above), so the shared branch is
#                      forced on L1's 200-session board with
#                      --env NODE_OPTIONS=--import=/app/e2e/load/presence-shared-hook.ts
#                    - the owner's pre-approved fsync fallback (§2.13 step 3), only if the targets are missed:
#                      --env NODE_OPTIONS=--import=/app/e2e/load/sqlite-normal-hook.ts
#   --worker-heap-mb each load worker's old-generation cap (default 360). The generator runs 5 workers on the
#                    container's 4 CPUs: worker 0 holds every thin session (no engine core, so the socket-side
#                    measurements do not queue behind a scene rebuild) and 1-4 the full cores (runner.ts)
#
# The SIGKILL at minute 8 (L1, no --duration-s) counts from the load generator's own start (its t0 file),
# by nas-killer.sh on the NAS; the kill file it writes (kill command, docker start returned) goes into the
# report's restart numbers. The sampler (nas-sampler.sh) adds the cgroup's anonymous memory every 1 s.
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
# the planted over-cap board: MANY SHORT notes. The worker's heap grows with the record count, so a board of
# short notes passes the 98 MB cap (ERR_WORKER_OUT_OF_MEMORY, the §8.3 pass condition) within seconds, while a
# board of long texts hits the 60 s time budget first (measured locally: 6,000 notes of 2,000 characters =
# time-budget; see B9.md)
OVERCAP=40000
OVERCAP_CHARS=60
DURATION=""
WORKER_HEAP=360
while (($#)); do
  case "$1" in
    --cul) CUL="--cul" ;;
    --env|--presence-env)
      # only NAME=VALUE of a plain NAME, and a value without quotes or spaces (it goes into one remote command)
      [[ "$2" =~ ^[A-Z_][A-Z0-9_]*=[A-Za-z0-9_./:=,-]+$ ]] || { log "bad --env $2"; exit 2; }
      PRESENCE_ENV="$PRESENCE_ENV -e $2"; shift ;;
    --overcap-notes) OVERCAP="$2"; shift ;;
    --overcap-chars) OVERCAP_CHARS="$2"; shift ;;
    --duration-s) DURATION="--duration-s $2"; shift ;;
    --worker-heap-mb) WORKER_HEAP="$2"; shift ;;
    *) log "unknown option $1"; exit 2 ;;
  esac
  shift
done
[[ "$P" == L1 || "$P" == L2 ]] || { log "profile must be L1 or L2"; exit 2; }
[[ "$TAG" =~ ^[a-z0-9-]{1,32}$ ]] || { log "tag must match [a-z0-9-]{1,32}"; exit 2; }
[[ "$OVERCAP" =~ ^[0-9]+$ && "$OVERCAP_CHARS" =~ ^[0-9]+$ && "$WORKER_HEAP" =~ ^[0-9]+$ ]] || { log "--overcap-notes, --overcap-chars and --worker-heap-mb take a number"; exit 2; }
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
nas "docker run --rm --name $C_GEN --user $U --network none -v $S/src:/app:ro -v $S/data:/var/data -w /app '$IMG' node e2e/load/gen-boards.ts --data-dir /var/data --profile $P ${CUL:+--cul --overcap-notes $OVERCAP --overcap-chars $OVERCAP_CHARS}" | tee -a "$LOG"
check_cap

# 2. the per-run secrets, generated on the NAS inside the folder (never printed)
nas "docker run --rm --name $C_SECRETS --user $U --network none -v $S/src:/app:ro -v $S:/s -w /app '$IMG' node e2e/load/write-run-env.ts --out /s/run.env --api-url http://$C_LOAD:7899"

# 3. the internal network, sync under the Render-sized limits, the load generator
nas "docker network inspect $NET >/dev/null 2>&1 || docker network create --internal $NET"
nas "docker run -d --init --name $C_SYNC --user $U --network $NET --cpus=0.5 --memory=512m --memory-swap=512m -v $S/src:/app:ro -v $S/data:/var/data -w /app --env-file $S/run.env -e HOST=0.0.0.0 -e PORT=5858 -e DRAFTROOM_DATA_DIR=/var/data -e DRAFTROOM_ENGINE=excalidraw -e DRAFTROOM_BACKUP_STORE=off -e DRAFTROOM_TEST_HOOKS=1 $PRESENCE_ENV '$IMG' node apps/sync/src/server.ts"
nas "docker run -d --init --name $C_LOAD --user $U --network $NET --cpus=4 --memory=2g -v $S/src:/app:ro -v $S/reports:/reports -w /app --env-file $S/run.env '$IMG' node e2e/load/run.ts --profile $P --sync http://$C_SYNC:5858 --api-listen 0.0.0.0:7899 --out /reports --tag $TAG --threads 5 --worker-heap-mb $WORKER_HEAP --host-samples $HOSTFILE --t0-file /reports/t0-$P-$TAG.txt --kill-file /reports/kill-$P-$TAG.txt $CUL $DURATION"

# 4. the host sampler (docker stats every 10 s, du every 30 s, the 2,048 MB stop) and, for L1, the kill at minute 8
nas_stdin "cat > $S/sampler.sh" <"$(dirname "$0")/nas-sampler.sh"
nas "nohup sh $S/sampler.sh $S $S/reports/host-$P-$TAG.jsonl $CAP_MB </dev/null >/dev/null 2>&1 &"
if [[ "$P" == L1 && -z "$DURATION" ]]; then
  # minute 8 of the LOAD GENERATOR's run (its t0 file), not of this script (nas-killer.sh)
  nas_stdin "cat > $S/killer.sh" <"$(dirname "$0")/nas-killer.sh"
  nas "nohup sh $S/killer.sh $S/reports/t0-$P-$TAG.txt $S/reports/kill-$P-$TAG.txt 480000 </dev/null >/dev/null 2>&1 &"
fi

# 5. wait for the load generator, then bring back only the JSON/markdown reports (never a board file)
nas "docker wait $C_LOAD"
mkdir -p "$EVIDENCE_DIR/b9"
# no OOM of the sync container, and how often it restarted (the kill is one)
nas "docker inspect $C_SYNC --format 'sync: OOMKilled={{.State.OOMKilled}} restarts={{.RestartCount}} exit={{.State.ExitCode}} status={{.State.Status}}'" | tee -a "$LOG"
for f in "$P-$TAG.json" "$P-$TAG.md" "host-$P-$TAG.jsonl" "kill-$P-$TAG.txt" "t0-$P-$TAG.txt"; do
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
