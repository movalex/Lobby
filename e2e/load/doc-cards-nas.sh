#!/usr/bin/env bash
# OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2 "Risks": the room's cost of a long doc card, measured on
# the NAS before the cap is decided). Throwaway containers named draftroom-load-<run>-*, LAN-only with NO published
# port (an --internal network), no image built (the Node base image Draftroom's Dockerfiles pin), a `git archive` of
# the commit in its own folder, dependencies installed by a throwaway install container (the only one with network),
# the sync under Render's limits (0.5 CPU, 512 MB, as docs/research/excalidraw/spike-b/scripts/nas-run.sh) with its
# SQLite on the NAS's own volume inside the run folder (never over SMB, never real board data: the boards are made
# by the run), and everything removed afterwards by name (AGENTS.md "Local environment").
#
#   DRY_RUN=1 (the default): every SSH/Docker command is printed, nothing touches the NAS.
#   DRY_RUN=0: under the standing NAS approval for throwaway draftroom-load-* names.
# Usage: DRY_RUN=0 bash e2e/load/doc-cards-nas.sh <commit> [--duration-s 120] [--scenarios "20000:1:30 20000:5:30 …"]
#
# Each scenario (chars:typists:watchers) runs on a FRESH sync (its event-loop delay is the process's), with the load
# generator e2e/load/doc-cards.ts next to it (its own CPUs); `docker stats` of the sync every 5 s (CPU as % of its
# 0.5 CPU quota). Then the server relayout of one such card (canvas-schema layoutBoundText, the room's rule 6) in a
# --network none container with the sync's CPU limit. The reports (JSON, numbers only) go to $EVIDENCE_DIR.
#
# The NAS lock is the load runs' (/volume3/Apps/draftroom-load-runs/lock, as e2e/load/activities-nas.sh): while another
# run holds it, this one STOPS and touches nothing. Never `prune`, `rm $(docker ps -aq)`, `compose down`, a Docker
# restart, or any name that is not this run's.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.10.1}"
NAS_USER="${NAS_USER:-chase}"
NAS_KEY="${NAS_KEY:-$HOME/.ssh/ugreen_nas}"
DRY_RUN="${DRY_RUN:-1}"
RUNS=/volume3/Apps/draftroom-load-runs
LOCK="$RUNS/lock"
IMG='node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de'
PNPM=pnpm@10.34.5
MIN_FREE_GB=10
MIN_AVAIL_MB=1800
MAX_FOLDER_MB=4096
EVIDENCE_DIR="${EVIDENCE_DIR:-${TMPDIR:-/tmp}/nas-doc-cards-evidence}"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/nas-doc-cards-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

SHA="${1:?usage: doc-cards-nas.sh <commit> [--duration-s N] [--scenarios LIST]}"
shift
DURATION=120
SCENARIOS="20000:1:30 20000:5:30 12000:1:30 12000:5:30"
while (($#)); do
  case "$1" in
    --duration-s) DURATION="$2"; shift ;;
    --scenarios) SCENARIOS="$2"; shift ;;
    *) log "unknown option $1"; exit 2 ;;
  esac
  shift
done
[[ "$DURATION" =~ ^[0-9]+$ ]] || { log "--duration-s takes a number"; exit 2; }
for sc in $SCENARIOS; do [[ "$sc" =~ ^[0-9]{1,5}:[0-9]{1,2}:[0-9]{1,3}$ ]] || { log "bad scenario $sc"; exit 2; }; done

RUN="r-$(date -u +%Y%m%d%H%M%S)-dc$$"
[[ "$RUN" =~ ^r-[0-9]{14}-[a-z0-9]{4,16}$ ]] || { log "bad run id $RUN"; exit 2; }
S="$RUNS/$RUN"
NET="draftroom-load-$RUN-net"
C_INSTALL="draftroom-load-$RUN-install"
C_ENV="draftroom-load-$RUN-env"
C_SYNC="draftroom-load-$RUN-sync"
C_RUN="draftroom-load-$RUN-run"
C_RELAYOUT="draftroom-load-$RUN-relayout"

nas() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] ssh %s@%s -- %s\n' "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$*" 2> >(grep -v -e 'post-quantum' -e 'store now, decrypt later' -e 'pq.html' >&2)
}
nas_stdin() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] <stdin> | ssh %s@%s -- %s\n' "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    cat >/dev/null
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$*" 2> >(grep -v -e 'post-quantum' -e 'store now, decrypt later' -e 'pq.html' >&2)
}
is_run_name() {
  [[ "$1" == "$C_INSTALL" || "$1" == "$C_ENV" || "$1" == "$C_SYNC" || "$1" == "$C_RUN" || "$1" == "$C_RELAYOUT" || "$1" == "$NET" ]]
}
list_load() {
  nas "docker ps -a --filter name=^draftroom-load --format '{{.Names}}\t{{.Status}}'; echo '--- networks'; docker network ls --filter name=^draftroom-load --format '{{.Name}}'; echo '--- runs'; ls -1 $RUNS 2>/dev/null; cat $LOCK/owner 2>/dev/null || true"
}
remove_container() {
  local name="$1" listed
  is_run_name "$name" || { log "REFUSED: $name is not this run's ($RUN) name"; return 1; }
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker rm -f $name"; return 0; fi
  listed="$(nas "docker ps -a --filter name=^draftroom-load --format '{{.Names}}'")"
  if grep -qx -- "$name" <<<"$listed"; then nas "docker rm -f $name" >/dev/null && log "removed container $name"; fi
}
lock_release() {
  nas "if [ \"\$(cut -d' ' -f1 $LOCK/owner 2>/dev/null)\" = '$RUN' ]; then rm -rf -- $LOCK && echo 'lock released'; fi" | tee -a "$LOG" || true
}
cleanup() {
  log "cleanup of run $RUN: before"
  list_load | tee -a "$LOG" || true
  for c in "$C_RUN" "$C_SYNC" "$C_RELAYOUT" "$C_ENV" "$C_INSTALL"; do remove_container "$c" || true; done
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker network rm $NET"
  elif nas "docker network ls --filter name=^draftroom-load --format '{{.Name}}'" | grep -qx -- "$NET"; then
    is_run_name "$NET" && nas "docker network rm $NET" >/dev/null && log "removed network $NET"
  fi
  nas "if [ -d $S ]; then rm -rf -- $S; fi; test ! -e $S && echo 'folder removed'" | tee -a "$LOG" || true
  lock_release
  log "cleanup of run $RUN: after"
  list_load | tee -a "$LOG" || true
}

# 1. preflight (a STOP here leaves everything as it is)
log "preflight of run $RUN (DRY_RUN=$DRY_RUN) -> $LOG"
nas "df -h /volume3; uptime" | tee -a "$LOG"
free_gb="$(nas "df -Pk /volume3 | awk 'NR==2 {print int(\$4/1048576)}'" | tail -1)"
avail_mb="$(nas "awk '/^MemAvailable:/ {print int(\$2/1024)}' /proc/meminfo" | tail -1)"
log "free on /volume3: ${free_gb} GB; memory available: ${avail_mb} MB"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$free_gb" =~ ^[0-9]+$ ]] && (( free_gb >= MIN_FREE_GB )) || { log "STOP: less than ${MIN_FREE_GB} GB free"; exit 1; }
  [[ "$avail_mb" =~ ^[0-9]+$ ]] && (( avail_mb >= MIN_AVAIL_MB )) || { log "STOP: less than ${MIN_AVAIL_MB} MB available"; exit 1; }
fi

# 2. the load runs' lock (atomic mkdir); another run's: STOP, touching nothing
got="$(nas "mkdir -p $RUNS && if mkdir $LOCK 2>/dev/null; then echo '$RUN '\$(date +%s) > $LOCK/owner && echo acquired; else cat $LOCK/owner 2>/dev/null || echo 'unknown 0'; fi" | tail -1)"
if [[ "$DRY_RUN" == "0" && "$got" != acquired ]]; then log "STOP: another load run holds the NAS lock: $got"; exit 1; fi
trap cleanup EXIT
U="$(if [[ "$DRY_RUN" != "0" ]]; then echo '<uid>:<gid>'; else nas 'echo "$(id -u):$(id -g)"'; fi)"

# 3. the commit's tracked source (never .env*, .data, node_modules, test results)
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$REPO" rev-parse "${SHA}^{commit}")"
PATHS=(package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version tsconfig.base.json apps packages e2e scripts)
git -C "$REPO" cat-file -e "${sha}:patches" 2>/dev/null && PATHS+=(patches)
listing="$(git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | tar -t)"
if grep -nE '(^|/)(\.env[^/]*|\.data|node_modules|test-results)(/|$)' <<<"$listing"; then
  log "REFUSED: the archive would contain a forbidden path (above)"; exit 1
fi
log "archive of $sha: $(wc -l <<<"$listing") entries"
nas "mkdir -p $S/src $S/data $S/reports"
git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | nas_stdin "tar -x -C $S/src"

# 4. the install (the only container with network)
nas "docker image inspect '$IMG' >/dev/null 2>&1 || docker pull '$IMG'"
nas "docker run --rm --name $C_INSTALL --user $U -e HOME=/app/.home -e CI=true -v $S/src:/app -w /app '$IMG' npx --yes $PNPM install --frozen-lockfile --prod=false --store-dir /app/.pnpm-store" | tail -3 | tee -a "$LOG"
folder_mb="$(nas "du -sm $S | cut -f1" | tail -1)"
log "folder: ${folder_mb} MB (cap ${MAX_FOLDER_MB} MB)"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$folder_mb" =~ ^[0-9]+$ ]] && (( folder_mb <= MAX_FOLDER_MB )) || { log "STOP: the folder is over its cap"; exit 1; }
fi

# 5. the per-run secrets (generated on the NAS, 0600, never printed) and the internal network
nas "docker run --rm --name $C_ENV --user $U --network none -v $S/src:/app:ro -v $S:/s -w /app '$IMG' node e2e/load/write-run-env.ts --out /s/run.env --api-url http://$C_RUN:7899"
nas "docker network create --internal $NET >/dev/null && echo 'network $NET'"

# 6. the scenarios, each on a fresh sync
for sc in $SCENARIOS; do
  IFS=: read -r chars typists watchers <<<"$sc"
  tag="doc-$chars-$typists-$watchers"
  log "scenario $tag ($DURATION s)"
  nas "rm -rf -- $S/data && mkdir -p $S/data"
  nas "docker run -d --init --name $C_SYNC --user $U --network $NET --cpus=0.5 --memory=512m --memory-swap=512m -v $S/src:/app:ro -v $S/data:/var/data -w /app --env-file $S/run.env -e HOST=0.0.0.0 -e PORT=5858 -e DRAFTROOM_DATA_DIR=/var/data -e DRAFTROOM_ENGINE=excalidraw -e DRAFTROOM_BACKUP_STORE=off '$IMG' node apps/sync/src/server.ts" >/dev/null
  if [[ "$DRY_RUN" == "0" ]]; then
    for i in $(seq 1 60); do nas "docker logs $C_SYNC 2>&1 | grep -q 'sync listening'" && break; sleep 1; done
  fi
  nas "docker run -d --init --name $C_RUN --user $U --network $NET --cpus=3 --memory=1g --memory-swap=1g -v $S/src:/app:ro -v $S/reports:/reports -w /app --env-file $S/run.env '$IMG' node e2e/load/doc-cards.ts --sync http://$C_SYNC:5858 --api-listen 0.0.0.0:7899 --chars $chars --typists $typists --watchers $watchers --duration-s $DURATION --out /reports/$tag.json" >/dev/null
  # the sync's CPU (% of its 0.5 CPU quota) and memory every 5 s while the generator runs
  nas "while docker ps --filter name=^$C_RUN\$ --filter status=running -q | grep -q .; do docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' $C_SYNC | awk '{gsub(\"%\",\"\",\$1); print \$1/0.5, \$2}' >> $S/reports/$tag.cpu; sleep 5; done; docker wait $C_RUN" | tail -1 | tee -a "$LOG"
  if [[ "$DRY_RUN" == "0" ]]; then
    nas "cat $S/reports/$tag.json" >"$EVIDENCE_DIR/$tag.json" 2>/dev/null || true
    nas "cat $S/reports/$tag.cpu" >"$EVIDENCE_DIR/$tag.cpu" 2>/dev/null || true
  fi
  nas "docker logs --tail 20 $C_RUN" >"$EVIDENCE_DIR/$tag.run.log" 2>&1 || true
  nas "docker logs --tail 20 $C_SYNC 2>&1 | grep -v -e 'GET /internal'" >"$EVIDENCE_DIR/$tag.sync.log" 2>&1 || true
  nas "docker inspect $C_SYNC --format 'sync: OOMKilled={{.State.OOMKilled}} status={{.State.Status}}'" | tee -a "$LOG"
  remove_container "$C_RUN"
  remove_container "$C_SYNC"
done

# 7. the server relayout of one card, at the sync's CPU limit, no network
for chars in $(for sc in $SCENARIOS; do echo "${sc%%:*}"; done | sort -u); do
  nas "docker run --rm --name $C_RELAYOUT --user $U --network none --cpus=0.5 --memory=512m -v $S/src:/app:ro -v $S/reports:/reports -w /app '$IMG' node e2e/load/doc-cards.ts --relayout-only --chars $chars --out /reports/relayout-$chars.json" | tail -1 | tee -a "$LOG"
  if [[ "$DRY_RUN" == "0" ]]; then nas "cat $S/reports/relayout-$chars.json" >"$EVIDENCE_DIR/relayout-$chars.json" 2>/dev/null || true; fi
done
nas "rm -f -- $S/run.env"
log "run $RUN done; reports in $EVIDENCE_DIR"
