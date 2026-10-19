#!/usr/bin/env bash
# REALPG on the NAS: the api project and packages/db against a throwaway PostgreSQL 18, both containers on the
# NAS, so the workstation stays quiet (no test worker runs there) and nothing is published: Postgres and the
# test runner share an --internal network, the password never leaves the NAS.
#
#   DRY_RUN=1 (the default): every SSH/Docker command is printed, nothing touches the NAS.
#   DRY_RUN=0: under the standing NAS approval for throwaway draftroom-* names.
# Usage: DRY_RUN=0 bash scripts/nas-pg-api.sh <commit> [--max-workers N] [--only api|db] [--keep]
#        DRY_RUN=0 bash scripts/nas-pg-api.sh --remove <run-id>     (what a --keep run left: under the NAS lock, and
#                                                                   never while that run is live)
#
# Two runs at once (wave V: two workstreams' runs removed each other's containers and folder, which had fixed names):
#   - every run has its own id (RUN_ID, default r-<utc time>-<pid><random>; strict: r-<14 digits>-<4-16 of a-z0-9>,
#     so it is never `lock` and no id's -install/-test/-net name is another id's: review m8), in all it creates: the containers
#     draftroom-pg-<run>, draftroom-pg-<run>-install and draftroom-pg-<run>-test, the network draftroom-pg-<run>-net
#     and the folder /volume3/Apps/draftroom-pg-runs/<run>;
#   - a run takes the NAS lock first: `mkdir /volume3/Apps/draftroom-pg-runs/lock` (atomic), holding "<run> <epoch>"
#     (refreshed at every step). While another run holds it, this one STOPS and touches nothing. A lock older than
#     LOCK_STALE_S (default 6 h) whose run has no container left is stale: it is removed and taken (one mkdir wins);
#   - a run made by the script before run ids (the fixed names draftroom-pg, draftroom-pg-net, the folder
#     /volume3/Apps/draftroom-pg) counts as live: this run STOPS;
#   - the cleanup removes only the four names this run's id gives (each name is checked against them), and the lock
#     only while this invocation holds it. Other draftroom-pg* names are listed, never touched;
#   - --remove takes the same lock (as its own id) and STOPs while another run holds it, or while the run to remove
#     holds it and is live (a fresh lock, or its test container running).
#
# What it does, in order: preflight (df, MemAvailable; a STOP here leaves everything as it is), the lock, the commit's
# tracked source (git archive; refused if it would hold .env*, .data, node_modules or test-results) into the run's
# folder, one install container (the only one with network) with the pinned Node image of the B9 scripts, the password
# generated ON the NAS into two 0600 files in that folder (never printed), postgres:18 (already on the NAS; pulled once
# if absent and then kept, like the Node image; no image is ever removed) with UTF8, max_connections 300 and its data
# on the container's writable layer (a 16 MB tmpfs over /var/lib/postgresql keeps Docker from creating an anonymous
# volume), fsync/synchronous_commit/full_page_writes off (the tests check locks, races and migrations, not
# durability), then `vitest run --project api --maxWorkers=N` and `vitest run --project packages packages/db
# --maxWorkers=1` (its files share one database and their PGlite workers outgrew the 2.5 GB runner: SIGKILLs, then a
# dropped relation under a neighbour, waves N and N.1) in a runner container, and the cleanup of this run (also on
# failure, unless --keep). Never `prune`, `rm $(docker ps -aq)`, `compose down`, a Docker restart, or anything that is
# not this run's draftroom-pg* name. Evidence (logs, vitest JSON) goes to $EVIDENCE_DIR on the workstation.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.10.1}"
NAS_USER="${NAS_USER:-chase}"
NAS_KEY="${NAS_KEY:-$HOME/.ssh/ugreen_nas}"
DRY_RUN="${DRY_RUN:-1}"
RUNS=/volume3/Apps/draftroom-pg-runs
LOCK="$RUNS/lock"
LOCK_STALE_S="${LOCK_STALE_S:-21600}"
# the names of the script before run ids: a run of it is live while any is there
LEGACY_FOLDER=/volume3/Apps/draftroom-pg
LEGACY_NAMES='^(draftroom-pg|draftroom-pg-install|draftroom-pg-test|draftroom-pg-net)$'
IMG='node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de'
PG_IMG=postgres:18
PNPM=pnpm@10.34.5
MIN_FREE_GB=10
MIN_AVAIL_MB=3072
EVIDENCE_DIR="${EVIDENCE_DIR:-${TMPDIR:-/tmp}/nas-pg-evidence}"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/nas-pg-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

usage='usage: nas-pg-api.sh <commit> [--max-workers N] [--only api|db] [--keep] | --remove <run-id>'
REMOVE=
if [[ "${1:-}" == --remove ]]; then
  REMOVE="${2:?$usage}"
  SHA=
else
  SHA="${1:?$usage}"
  shift
fi
MW=4
KEEP=0
ONLY=
if [[ -z "$REMOVE" ]]; then
  while (($#)); do
    case "$1" in
      --max-workers) MW="$2"; shift ;;
      --only) ONLY="$2"; shift ;;
      --keep) KEEP=1 ;;
      *) log "unknown option $1"; exit 2 ;;
    esac
    shift
  done
fi
[[ "$MW" =~ ^[0-9]+$ ]] || { log "--max-workers takes a number"; exit 2; }
[[ -z "$ONLY" || "$ONLY" == api || "$ONLY" == db ]] || { log "--only takes api or db"; exit 2; }

# A run id is `r-<14 digits of UTC time>-<4-16 of a-z0-9>` (the default: r-<time>-<pid><random>), exactly two dashes:
#   - it can never be `lock` (the lock's folder beside the runs) or any other name the script keeps there;
#   - no id plus -install, -test or -net is another valid id, so no run's container or network name is another run's
#     (wave V review m8: run `x`'s draftroom-pg-x-install was run `x-install`'s Postgres).
# --remove also takes the ids of the script before this rule (`<14 digits>-<pid>-<random>`: the same two dashes), so
# what a --keep run of it left can still be removed.
RUN_ID_RE='^r-[0-9]{14}-[a-z0-9]{4,16}$'
LEGACY_RUN_ID_RE='^[0-9]{14}-[0-9]{1,10}-[0-9]{1,4}$'
new_run_id() { printf 'r-%s-%s%04d' "$(date -u +%Y%m%d%H%M%S)" "$$" "$((RANDOM % 10000))"; }
RUN="${REMOVE:-${RUN_ID:-$(new_run_id)}}"
if [[ -n "$REMOVE" ]]; then
  [[ "$RUN" =~ $RUN_ID_RE || "$RUN" =~ $LEGACY_RUN_ID_RE ]] || { log "not a run id (r-<14 digits>-<4-16 of a-z0-9>): $RUN"; exit 2; }
else
  [[ "$RUN" =~ $RUN_ID_RE ]] || { log "a run id is r-<14 digits>-<4-16 of a-z0-9>: $RUN"; exit 2; }
fi
S="$RUNS/$RUN"
NET="draftroom-pg-$RUN-net"
C_PG="draftroom-pg-$RUN"
C_INSTALL="draftroom-pg-$RUN-install"
C_TEST="draftroom-pg-$RUN-test"
# who holds the NAS lock for this invocation: the run itself, or for --remove the remover (its own id), so removing a
# run takes the same lock as running one and never releases a lock it did not take
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
# a name this run may remove: exactly one of the four names this run's id gives, nothing else
is_run_name() { [[ "$1" == "$C_PG" || "$1" == "$C_INSTALL" || "$1" == "$C_TEST" || "$1" == "$NET" ]]; }
list_pg() {
  nas "docker ps -a --filter name=^draftroom-pg --format '{{.Names}}\t{{.Status}}'; echo '--- networks'; docker network ls --filter name=^draftroom-pg --format '{{.Name}}'; echo '--- volumes'; docker volume ls --filter name=^draftroom-pg --format '{{.Name}}'; echo '--- runs'; ls -1 $RUNS 2>/dev/null; cat $LOCK/owner 2>/dev/null || true"
}
remove_container() {
  local name="$1" listed
  is_run_name "$name" || { log "REFUSED: $name is not this run's ($RUN) draftroom-pg name"; return 1; }
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker rm -f $name"; return 0; fi
  listed="$(nas "docker ps -a --filter name=^draftroom-pg --format '{{.Names}}'")"
  if grep -qx -- "$name" <<<"$listed"; then nas "docker rm -f $name" >/dev/null && log "removed container $name"
  else log "container $name not present"; fi
}
# the lock's owner line ("<run> <epoch>"), or nothing
lock_owner() { nas "cat $LOCK/owner 2>/dev/null || true" | tail -1; }
# while this invocation holds the lock: its time is now (a long suite does not make it look stale)
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
# Takes the NAS lock for HOLDER, or STOPs (exit 1) touching nothing. A lock older than LOCK_STALE_S whose run is not
# alive is taken over (compare-before-remove: a run that took it meanwhile keeps it). Alive: for an ordinary holder,
# any container of its id; for --remove of the run that holds the lock, its test container running (a run that holds
# a fresh lock is live: --remove refuses it, review m8).
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
    alive="$(nas "docker ps --filter name=^$C_TEST\$ --filter status=running --format '{{.Names}}'" | grep -x -- "$C_TEST" || true)"
  else
    alive="$(nas "docker ps -a --filter name=^draftroom-pg-$holder --format '{{.Names}}'" | grep -E "^draftroom-pg-$holder(-|$)" || true)"
  fi
  if (( age > LOCK_STALE_S )) && [[ -z "$alive" ]]; then
    log "the lock of run $holder is stale (${age} s, not alive): taking it over"
    # only the lock as it was read (a run that took it meanwhile keeps it); a lock with no owner line reads 'unknown 0'
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
  list_pg | tee -a "$LOG" || true
  for c in "$C_TEST" "$C_INSTALL" "$C_PG"; do remove_container "$c" || true; done
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker network rm $NET"
  elif nas "docker network ls --filter name=^draftroom-pg --format '{{.Name}}'" | grep -qx -- "$NET"; then
    is_run_name "$NET" && nas "docker network rm $NET" >/dev/null && log "removed network $NET"
  fi
  # the run's own folder only (its name is this run's id, under the runs folder)
  nas "if [ -d $S ]; then rm -rf -- $S; fi; test ! -e $S && echo 'folder removed'" | tee -a "$LOG" || true
  lock_release
  log "cleanup of run $RUN: after"
  list_pg | tee -a "$LOG" || true
}

if [[ -n "$REMOVE" ]]; then
  # the same lock as a run (review m8): never while that run, or any other, is live; the remover holds it as $HOLDER
  log "removing what run $RUN left (DRY_RUN=$DRY_RUN; the lock as $HOLDER)"
  if [[ "$DRY_RUN" == "0" ]]; then acquire_lock; else lock_try >/dev/null; fi
  trap lock_release EXIT
  cleanup
  trap - EXIT
  exit 0
fi

# 1. preflight (nothing armed yet: a STOP here leaves everything as it is; what is there may be another run's)
trap - EXIT
log "preflight of run $RUN (DRY_RUN=$DRY_RUN) -> $LOG"
nas "df -h /volume3" | tee -a "$LOG"
free_gb="$(nas "df -Pk /volume3 | awk 'NR==2 {print int(\$4/1048576)}'" | tail -1)"
avail_mb="$(nas "awk '/^MemAvailable:/ {print int(\$2/1024)}' /proc/meminfo" | tail -1)"
log "free on /volume3: ${free_gb} GB; memory available: ${avail_mb} MB"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$free_gb" =~ ^[0-9]+$ ]] && (( free_gb >= MIN_FREE_GB )) || { trap - EXIT; log "STOP: less than ${MIN_FREE_GB} GB free"; exit 1; }
  [[ "$avail_mb" =~ ^[0-9]+$ ]] && (( avail_mb >= MIN_AVAIL_MB )) || { trap - EXIT; log "STOP: less than ${MIN_AVAIL_MB} MB available"; exit 1; }
  legacy="$(nas "docker ps -a --filter name=^draftroom-pg --format '{{.Names}}'; docker network ls --filter name=^draftroom-pg --format '{{.Name}}'" | grep -E "$LEGACY_NAMES" || true)"
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
if ((KEEP)); then trap 'lock_release; log "--keep: run $RUN stays; remove it with: DRY_RUN=0 bash scripts/nas-pg-api.sh --remove $RUN"' EXIT
else trap cleanup EXIT; fi
U="$(if [[ "$DRY_RUN" != "0" ]]; then echo '<uid>:<gid>'; else nas 'echo "$(id -u):$(id -g)"'; fi)"

# 3. the commit's tracked source
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$REPO" rev-parse "${SHA}^{commit}")"
PATHS=(package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version tsconfig.base.json vitest.config.ts apps packages e2e scripts)
# patches/ (pnpm patchedDependencies, wave J) when the commit has it: the frozen install reads every patch file
git -C "$REPO" cat-file -e "${sha}:patches" 2>/dev/null && PATHS+=(patches)
listing="$(git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | tar -t)"
if grep -nE '(^|/)(\.env[^/]*|\.data|node_modules|test-results)(/|$)' <<<"$listing"; then
  log "REFUSED: the archive would contain a forbidden path (above)"; exit 1
fi
log "archive of $sha: $(wc -l <<<"$listing") entries"
nas "mkdir -p $S/src $S/reports"
git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | nas_stdin "tar -x -C $S/src"
nas "echo $sha > $S/src/.pg-commit"
lock_touch

# 4. the install (the only container with network)
nas "docker image inspect '$IMG' >/dev/null 2>&1 || docker pull '$IMG'"
nas "docker run --rm --name $C_INSTALL --user $U -e HOME=/app/.home -e CI=true -v $S/src:/app -w /app '$IMG' npx --yes $PNPM install --frozen-lockfile --store-dir /app/.pnpm-store" | tail -5 | tee -a "$LOG"
lock_touch

# 5. the password, generated on the NAS, two 0600 files, never printed
nas "umask 077 && pw=\$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n') && printf 'POSTGRES_PASSWORD=%s\\n' \"\$pw\" > $S/pg.env && printf 'DRAFTROOM_TEST_DATABASE_URL=postgres://postgres:%s@$C_PG:5432/postgres\\n' \"\$pw\" > $S/test.env && echo 'secrets written'"

# 6. Postgres on an internal network (no published port)
nas "docker image inspect $PG_IMG >/dev/null 2>&1 || docker pull $PG_IMG"
nas "docker network create --internal $NET >/dev/null && echo 'network $NET'"
nas "docker run -d --name $C_PG --network $NET --cpus=4 --memory=1g --memory-swap=1g --shm-size=256m --tmpfs /var/lib/postgresql:size=16m -e PGDATA=/pgdata/data -e POSTGRES_INITDB_ARGS=--encoding=UTF8 --env-file $S/pg.env $PG_IMG -c max_connections=300 -c fsync=off -c synchronous_commit=off -c full_page_writes=off"
if [[ "$DRY_RUN" == "0" ]]; then
  for i in $(seq 1 60); do
    nas "docker exec $C_PG pg_isready -U postgres -h 127.0.0.1" >/dev/null 2>&1 && break
    sleep 1
  done
fi
nas "docker exec $C_PG psql -U postgres -h 127.0.0.1 -Atc 'select version()' ; docker exec $C_PG psql -U postgres -h 127.0.0.1 -Atc 'show server_encoding'" | tee -a "$LOG"

# 7. the suites, in a runner on the same internal network
run_suite() {
  local name="$1"
  shift
  lock_touch
  log "suite $name: vitest run $*"
  local code=0
  nas "docker run --rm --name $C_TEST --user $U --network $NET --cpus=5 --memory=2560m --memory-swap=2560m -v $S/src:/app -w /app -e HOME=/app/.home -e CI=true --env-file $S/test.env '$IMG' node_modules/.bin/vitest run $* --reporter=default --reporter=json --outputFile.json=/app/.reports-$name.json" \
    >"$EVIDENCE_DIR/$name.log" 2>&1 || code=$?
  if [[ "$DRY_RUN" == "0" ]]; then nas "cat $S/src/.reports-$name.json" >"$EVIDENCE_DIR/$name.json" 2>/dev/null || true; fi
  # vitest colours its summary even without a TTY; the colour codes go before the match
  sed 's/\x1b\[[0-9;]*m//g' "$EVIDENCE_DIR/$name.log" | grep -E '^\s+(Test Files|Tests|Duration)' | tee -a "$LOG" || true
  log "suite $name exit $code"
}
[[ "$ONLY" == db ]] || run_suite api --project api --maxWorkers="$MW"
[[ "$ONLY" == api ]] || run_suite db --project packages packages/db --maxWorkers=1
nas "docker logs --tail 50 $C_PG" >"$EVIDENCE_DIR/postgres.log" 2>&1 || true
log "done (run $RUN); evidence in $EVIDENCE_DIR"
