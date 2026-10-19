#!/usr/bin/env bash
# OWNER: WS1 (wave V). The live activities load run on the NAS (docs/WAVE-V-CONTRACTS.md §2.6; AGENTS.md "Local
# environment"): throwaway containers named draftroom-load-*, LAN-only with NO published port (an --internal network),
# no image built (the Node base image Draftroom's Dockerfiles pin, and postgres:18 as scripts/nas-pg-api.sh uses), a
# `git archive` of the commit in its own folder, dependencies installed by a throwaway install container (the only one
# with network), a throwaway Postgres with nothing but the run's own data, and everything removed afterwards by name.
#
#   DRY_RUN=1 (the default): every SSH/Docker command is printed, nothing touches the NAS.
#   DRY_RUN=0: under the standing NAS approval for throwaway draftroom-load-* names.
# Usage: DRY_RUN=0 bash e2e/load/activities-nas.sh <commit> [--participants N] [--bursts N] [--keep]
#        DRY_RUN=0 bash e2e/load/activities-nas.sh --remove <run-id>   (what a --keep run left: under the NAS lock, and
#                                                                       never while that run is live)
#
# Two runs at once (the fix wave, as scripts/nas-pg-api.sh; the review's g1: the names were fixed):
#   - every run has its own id (RUN_ID, default r-<utc time>-<pid><random>; strict: r-<14 digits>-<4-16 of a-z0-9>,
#     exactly two dashes, so it is never `lock` and no id's -install/-api/-run/-net name is another id's), in all it
#     creates: the containers draftroom-load-<run> (Postgres 18, fsync ON: commits as a real database makes them),
#     draftroom-load-<run>-install, draftroom-load-<run>-api (e2e/load/activities-api.ts: the real api on that Postgres,
#     its own CPUs) and draftroom-load-<run>-run (e2e/load/activities.ts: the guests, their event streams and their
#     answers), the network draftroom-load-<run>-net and the folder /volume3/Apps/draftroom-load-runs/<run>;
#   - a run takes the NAS lock first: `mkdir /volume3/Apps/draftroom-load-runs/lock` (atomic), holding "<id> <epoch>"
#     (refreshed at every step). While another run holds it, this one STOPS and touches nothing. A lock older than
#     LOCK_STALE_S (default 6 h) whose run is not alive is stale: it is removed (compare-before-remove) and taken;
#   - a run of the script before run ids (the fixed names draftroom-load-pg, -install, -api, -run, -net, the folder
#     /volume3/Apps/draftroom-load) counts as live: this run STOPS;
#   - the cleanup removes only the five names this run's id gives (each name is checked against them), its own folder,
#     and the lock only while this invocation holds it. Other draftroom-load* names are listed, never touched;
#   - --remove takes the same lock (as its own id) and STOPs while another run holds it, or while the run to remove
#     holds it and is live (a fresh lock, or its load container running).
# Secrets are generated ON the NAS into 0600 files in the folder and never printed. Never `prune`,
# `rm $(docker ps -aq)`, `compose down`, a Docker restart, or anything not this run's draftroom-load name. The report
# (JSON) and the logs go to $EVIDENCE_DIR on the workstation.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.10.1}"
NAS_USER="${NAS_USER:-chase}"
NAS_KEY="${NAS_KEY:-$HOME/.ssh/ugreen_nas}"
DRY_RUN="${DRY_RUN:-1}"
RUNS=/volume3/Apps/draftroom-load-runs
LOCK="$RUNS/lock"
LOCK_STALE_S="${LOCK_STALE_S:-21600}"
# the names of the script before run ids: a run of it is live while any is there
LEGACY_FOLDER=/volume3/Apps/draftroom-load
LEGACY_NAMES='^(draftroom-load-pg|draftroom-load-install|draftroom-load-api|draftroom-load-run|draftroom-load-net)$'
# the Node base image of Draftroom's Dockerfiles (as scripts/nas-pg-api.sh)
IMG='node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de'
PG_IMG=postgres:18
PNPM=pnpm@10.34.5
MIN_FREE_GB=10
MIN_AVAIL_MB=3072
# the folder's cap (source + node_modules + the pnpm store): the run refuses to go on past it
MAX_FOLDER_MB=4096
EVIDENCE_DIR="${EVIDENCE_DIR:-${TMPDIR:-/tmp}/nas-load-evidence}"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/nas-load-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

usage='usage: activities-nas.sh <commit> [--participants N] [--bursts N] [--keep] | --remove <run-id>'
REMOVE=
if [[ "${1:-}" == --remove ]]; then
  REMOVE="${2:?$usage}"
  SHA=
else
  SHA="${1:?$usage}"
  shift
fi
PARTICIPANTS=200
BURSTS=3
KEEP=0
if [[ -z "$REMOVE" ]]; then
  while (($#)); do
    case "$1" in
      --participants) PARTICIPANTS="$2"; shift ;;
      --bursts) BURSTS="$2"; shift ;;
      --keep) KEEP=1 ;;
      *) log "unknown option $1"; exit 2 ;;
    esac
    shift
  done
fi
[[ "$PARTICIPANTS" =~ ^[0-9]+$ && "$BURSTS" =~ ^[0-9]+$ ]] || { log "--participants and --bursts take numbers"; exit 2; }

# the run id (see the header): never `lock`, never another id plus a suffix
RUN_ID_RE='^r-[0-9]{14}-[a-z0-9]{4,16}$'
new_run_id() { printf 'r-%s-%s%04d' "$(date -u +%Y%m%d%H%M%S)" "$$" "$((RANDOM % 10000))"; }
RUN="${REMOVE:-${RUN_ID:-$(new_run_id)}}"
[[ "$RUN" =~ $RUN_ID_RE ]] || { log "a run id is r-<14 digits>-<4-16 of a-z0-9>: $RUN"; exit 2; }
S="$RUNS/$RUN"
NET="draftroom-load-$RUN-net"
C_PG="draftroom-load-$RUN"
C_INSTALL="draftroom-load-$RUN-install"
C_API="draftroom-load-$RUN-api"
C_RUN="draftroom-load-$RUN-run"
# who holds the NAS lock: the run itself, or for --remove the remover (its own id)
HOLDER="$RUN"
[[ -z "$REMOVE" ]] || HOLDER="$(new_run_id)"

nas() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] ssh %s@%s -- %s\n' "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$*"
}
nas_stdin() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] <stdin> | ssh %s@%s -- %s\n' "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    cat >/dev/null
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$*"
}
# a name this run may remove: exactly one of the five names its id gives, nothing else
is_run_name() { [[ "$1" == "$C_PG" || "$1" == "$C_INSTALL" || "$1" == "$C_API" || "$1" == "$C_RUN" || "$1" == "$NET" ]]; }
list_load() {
  nas "docker ps -a --filter name=^draftroom-load --format '{{.Names}}\t{{.Status}}'; echo '--- networks'; docker network ls --filter name=^draftroom-load --format '{{.Name}}'; echo '--- volumes'; docker volume ls --filter name=^draftroom-load --format '{{.Name}}'; echo '--- runs'; ls -1 $RUNS 2>/dev/null; cat $LOCK/owner 2>/dev/null || true"
}
remove_container() {
  local name="$1" listed
  is_run_name "$name" || { log "REFUSED: $name is not this run's ($RUN) draftroom-load name"; return 1; }
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker rm -f $name"; return 0; fi
  listed="$(nas "docker ps -a --filter name=^draftroom-load --format '{{.Names}}'")"
  if grep -qx -- "$name" <<<"$listed"; then nas "docker rm -f $name" >/dev/null && log "removed container $name"
  else log "container $name not present"; fi
}
# while this invocation holds the lock: its time is now (a long run does not make it look stale)
lock_touch() {
  nas "if [ \"\$(cut -d' ' -f1 $LOCK/owner 2>/dev/null)\" = '$HOLDER' ]; then echo '$HOLDER '\$(date +%s) > $LOCK/owner; fi" || true
}
lock_release() {
  nas "if [ \"\$(cut -d' ' -f1 $LOCK/owner 2>/dev/null)\" = '$HOLDER' ]; then rm -rf -- $LOCK && echo 'lock released'; fi" | tee -a "$LOG" || true
}
# takes the lock (atomic mkdir); prints "acquired", or the holder's line
lock_try() {
  nas "mkdir -p $RUNS && if mkdir $LOCK 2>/dev/null; then echo '$HOLDER '\$(date +%s) > $LOCK/owner && echo acquired; else cat $LOCK/owner 2>/dev/null || echo 'unknown 0'; fi" | tail -1
}
# Takes the NAS lock for HOLDER, or STOPs (exit 1) touching nothing (as scripts/nas-pg-api.sh acquire_lock).
acquire_lock() {
  local got holder since age alive
  got="$(lock_try)"
  [[ "$got" == acquired ]] && return 0
  holder="${got%% *}"
  since="${got##* }"
  [[ "$holder" =~ ^[a-z0-9-]{1,80}$ ]] || holder=unknown
  [[ "$since" =~ ^[0-9]+$ ]] || since=0
  age=$(( $(date +%s) - since ))
  if [[ -n "$REMOVE" && "$holder" == "$RUN" ]]; then
    alive="$(nas "docker ps --filter name=^$C_RUN\$ --filter status=running --format '{{.Names}}'" | grep -x -- "$C_RUN" || true)"
  else
    alive="$(nas "docker ps -a --filter name=^draftroom-load-$holder --format '{{.Names}}'" | grep -E "^draftroom-load-$holder(-|$)" || true)"
  fi
  if (( age > LOCK_STALE_S )) && [[ -z "$alive" ]]; then
    log "the lock of run $holder is stale (${age} s, not alive): taking it over"
    nas "o=\$(cat $LOCK/owner 2>/dev/null || echo 'unknown 0'); if [ \"\$o\" = '$got' ]; then rm -rf -- $LOCK; fi"
    got="$(lock_try)"
    [[ "$got" == acquired ]] && return 0
  fi
  trap - EXIT
  if [[ -n "$REMOVE" && "$holder" == "$RUN" ]]; then
    log "STOP: run $RUN is live: it holds the NAS lock (${age} s old); --remove waits for it to end"
  else
    log "STOP: another run holds the NAS lock: ${got} (${age} s old; containers: ${alive:-none})"
  fi
  exit 1
}
cleanup() {
  log "cleanup of run $RUN: before"
  list_load | tee -a "$LOG" || true
  for c in "$C_RUN" "$C_API" "$C_INSTALL" "$C_PG"; do remove_container "$c" || true; done
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker network rm $NET"
  elif nas "docker network ls --filter name=^draftroom-load --format '{{.Name}}'" | grep -qx -- "$NET"; then
    is_run_name "$NET" && nas "docker network rm $NET" >/dev/null && log "removed network $NET"
  fi
  # the run's own folder only (its name is this run's id, under the runs folder)
  nas "if [ -d $S ]; then rm -rf -- $S; fi; test ! -e $S && echo 'folder removed'" | tee -a "$LOG" || true
  lock_release
  log "cleanup of run $RUN: after"
  list_load | tee -a "$LOG" || true
}

if [[ -n "$REMOVE" ]]; then
  log "removing what run $RUN left (DRY_RUN=$DRY_RUN; the lock as $HOLDER)"
  if [[ "$DRY_RUN" == "0" ]]; then acquire_lock; else lock_try >/dev/null; fi
  trap lock_release EXIT
  cleanup
  trap - EXIT
  exit 0
fi

# 1. preflight: free disk, memory, no run of the script before run ids (a STOP here leaves everything as it is)
trap - EXIT
log "preflight of run $RUN (DRY_RUN=$DRY_RUN) -> $LOG"
nas "df -h /volume3" | tee -a "$LOG"
free_gb="$(nas "df -Pk /volume3 | awk 'NR==2 {print int(\$4/1048576)}'" | tail -1)"
avail_mb="$(nas "awk '/^MemAvailable:/ {print int(\$2/1024)}' /proc/meminfo" | tail -1)"
log "free on /volume3: ${free_gb} GB; memory available: ${avail_mb} MB"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$free_gb" =~ ^[0-9]+$ ]] && (( free_gb >= MIN_FREE_GB )) || { trap - EXIT; log "STOP: less than ${MIN_FREE_GB} GB free"; exit 1; }
  [[ "$avail_mb" =~ ^[0-9]+$ ]] && (( avail_mb >= MIN_AVAIL_MB )) || { trap - EXIT; log "STOP: less than ${MIN_AVAIL_MB} MB available"; exit 1; }
  legacy="$(nas "docker ps -a --filter name=^draftroom-load --format '{{.Names}}'; docker network ls --filter name=^draftroom-load --format '{{.Name}}'" | grep -E "$LEGACY_NAMES" || true)"
  legacy_folder="$(nas "if test -e $LEGACY_FOLDER; then echo $LEGACY_FOLDER; fi")"
  [[ -z "$legacy$legacy_folder" ]] || { trap - EXIT; log "STOP: a run of the script before run ids is live: $legacy $legacy_folder"; exit 1; }
fi

# 2. the lock (one run at a time; a stale lock is taken over, see the header)
if [[ "$DRY_RUN" == "0" ]]; then
  acquire_lock
  log "lock taken by run $RUN"
else
  lock_try >/dev/null
fi
# from here on the cleanup removes this run's names (and only them) whatever happens
if ((KEEP)); then trap 'lock_release; log "--keep: run $RUN stays; remove it with: DRY_RUN=0 bash e2e/load/activities-nas.sh --remove $RUN"' EXIT
else trap cleanup EXIT; fi
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
nas "mkdir -p $S/src $S/data"
git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | nas_stdin "tar -x -C $S/src"
nas "echo $sha > $S/src/.load-commit"
lock_touch

# 4. the install (the only container with network)
nas "docker image inspect '$IMG' >/dev/null 2>&1 || docker pull '$IMG'"
nas "docker run --rm --name $C_INSTALL --user $U -e HOME=/app/.home -e CI=true -v $S/src:/app -w /app '$IMG' npx --yes $PNPM install --frozen-lockfile --prod=false --store-dir /app/.pnpm-store" | tail -5 | tee -a "$LOG"
lock_touch
folder_mb="$(nas "du -sm $S | cut -f1" | tail -1)"
log "folder: ${folder_mb} MB (cap ${MAX_FOLDER_MB} MB)"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$folder_mb" =~ ^[0-9]+$ ]] && (( folder_mb <= MAX_FOLDER_MB )) || { log "STOP: the folder is over its cap"; exit 1; }
fi

# 5. the secrets, generated on the NAS, 0600, never printed
nas "umask 077 && pw=\$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n') && r() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n'; } && printf 'POSTGRES_PASSWORD=%s\\n' \"\$pw\" > $S/pg.env && { printf 'DATABASE_URL=postgres://postgres:%s@$C_PG:5432/postgres\\n' \"\$pw\"; printf 'DRAFTROOM_TICKET_SECRET=%s\\n' \"\$(r)\"; printf 'DRAFTROOM_INTERNAL_SECRET=%s\\n' \"\$(r)\"; printf 'DRAFTROOM_WORKER_TOKEN=%s\\n' \"\$(r)\"; } > $S/api.env && echo 'secrets written'"

# 6. Postgres on an internal network (no published port)
nas "docker image inspect $PG_IMG >/dev/null 2>&1 || docker pull $PG_IMG"
nas "docker network create --internal $NET >/dev/null && echo 'network $NET'"
nas "docker run -d --name $C_PG --network $NET --cpus=2 --memory=1g --memory-swap=1g --shm-size=256m --tmpfs /var/lib/postgresql:size=16m -e PGDATA=/pgdata/data -e POSTGRES_INITDB_ARGS=--encoding=UTF8 --env-file $S/pg.env $PG_IMG -c max_connections=100"
if [[ "$DRY_RUN" == "0" ]]; then
  for i in $(seq 1 60); do
    nas "docker exec $C_PG pg_isready -U postgres -h 127.0.0.1" >/dev/null 2>&1 && break
    sleep 1
  done
fi
nas "docker exec $C_PG psql -U postgres -h 127.0.0.1 -Atc 'select version()'; docker exec $C_PG psql -U postgres -h 127.0.0.1 -Atc 'show fsync'" | tee -a "$LOG"

# 7. the api (its own CPUs), then the load
lock_touch
nas "docker run -d --name $C_API --user $U --network $NET --cpus=2 --memory=1g --memory-swap=1g -v $S/src:/app:ro -v $S/data:/data -w /app -e HOME=/tmp -e NODE_ENV=development -e DRAFTROOM_LIVE_ACTIVITIES=on -e DRAFTROOM_DEV_AUTH=1 -e AUTH_PROVIDER=dev -e TRUST_PROXY=true -e PUBLIC_ORIGIN=http://load.test -e DRAFTROOM_DATA_DIR=/data -e HOST=0.0.0.0 -e PORT=3101 -e LOG_LEVEL=warn --env-file $S/api.env '$IMG' node e2e/load/activities-api.ts"
if [[ "$DRY_RUN" == "0" ]]; then
  for i in $(seq 1 90); do
    nas "docker logs $C_API 2>&1 | grep -q 'activities-api listening'" && break
    sleep 1
  done
fi
nas "docker logs $C_API 2>&1 | tail -5" | tee -a "$LOG"
lock_touch
code=0
nas "docker run --rm --name $C_RUN --user $U --network $NET --cpus=3 --memory=1536m --memory-swap=1536m -v $S/src:/app -w /app -e HOME=/tmp -e LOAD_ORIGIN=http://load.test '$IMG' node e2e/load/activities.ts --api http://$C_API:3101 --participants $PARTICIPANTS --bursts $BURSTS --out /app/.load-report.json" \
  >"$EVIDENCE_DIR/load-run.log" 2>&1 || code=$?
if [[ "$DRY_RUN" == "0" ]]; then nas "cat $S/src/.load-report.json" >"$EVIDENCE_DIR/load-report.json" 2>/dev/null || true; fi
nas "docker logs --tail 100 $C_API" >"$EVIDENCE_DIR/api.log" 2>&1 || true
nas "docker logs --tail 50 $C_PG" >"$EVIDENCE_DIR/postgres.log" 2>&1 || true
grep -E 'joined|streams open|started|burst|revealed' "$EVIDENCE_DIR/load-run.log" | tee -a "$LOG" || true
log "load run $RUN exit $code; evidence in $EVIDENCE_DIR"
exit "$code"
