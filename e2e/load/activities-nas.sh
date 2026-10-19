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
#
# Containers: draftroom-load-pg (Postgres 18, fsync ON: commits as a real database makes them),
# draftroom-load-api (e2e/load/activities-api.ts: the real api on that Postgres, its own CPUs), draftroom-load-run
# (e2e/load/activities.ts: 200 guests, their event streams and their answers). Secrets are generated ON the NAS into
# 0600 files in the folder and never printed. Never `prune`, `rm $(docker ps -aq)`, `compose down`, a Docker restart,
# or anything not named draftroom-load*. The report (JSON) and the logs go to $EVIDENCE_DIR on the workstation.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.10.1}"
NAS_USER="${NAS_USER:-chase}"
NAS_KEY="${NAS_KEY:-$HOME/.ssh/ugreen_nas}"
DRY_RUN="${DRY_RUN:-1}"
S=/volume3/Apps/draftroom-load
NET=draftroom-load-net
C_PG=draftroom-load-pg
C_INSTALL=draftroom-load-install
C_API=draftroom-load-api
C_RUN=draftroom-load-run
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
LOG="$EVIDENCE_DIR/nas-load-$(date -u +%Y%m%dT%H%M%SZ).log"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

SHA="${1:?usage: activities-nas.sh <commit> [--participants N] [--bursts N] [--keep]}"
shift
PARTICIPANTS=200
BURSTS=3
KEEP=0
while (($#)); do
  case "$1" in
    --participants) PARTICIPANTS="$2"; shift ;;
    --bursts) BURSTS="$2"; shift ;;
    --keep) KEEP=1 ;;
    *) log "unknown option $1"; exit 2 ;;
  esac
  shift
done
[[ "$PARTICIPANTS" =~ ^[0-9]+$ && "$BURSTS" =~ ^[0-9]+$ ]] || { log "--participants and --bursts take numbers"; exit 2; }

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
is_load_name() { [[ "$1" =~ ^draftroom-load(-[a-z0-9-]+)?$ ]]; }
list_load() {
  nas "docker ps -a --filter name=^draftroom-load --format '{{.Names}}\t{{.Status}}'; echo '--- networks'; docker network ls --filter name=^draftroom-load --format '{{.Name}}'; echo '--- volumes'; docker volume ls --filter name=^draftroom-load --format '{{.Name}}'"
}
remove_container() {
  local name="$1" listed
  is_load_name "$name" || { log "REFUSED: $name is not a draftroom-load name"; return 1; }
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker rm -f $name"; return 0; fi
  listed="$(nas "docker ps -a --filter name=^draftroom-load --format '{{.Names}}'")"
  if grep -qx -- "$name" <<<"$listed"; then nas "docker rm -f $name" >/dev/null && log "removed container $name"
  else log "container $name not present"; fi
}
cleanup() {
  log "cleanup: before"
  list_load | tee -a "$LOG" || true
  for c in "$C_RUN" "$C_API" "$C_INSTALL" "$C_PG"; do remove_container "$c" || true; done
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker network rm $NET"
  elif nas "docker network ls --filter name=^draftroom-load --format '{{.Name}}'" | grep -qx -- "$NET"; then
    nas "docker network rm $NET" >/dev/null && log "removed network $NET"
  fi
  nas "if [ -d $S ]; then rm -rf -- $S; fi; test ! -e $S && echo 'folder removed'" | tee -a "$LOG" || true
  log "cleanup: after"
  list_load | tee -a "$LOG" || true
}
if ((KEEP)); then trap 'log "--keep: run the script again without it, or remove draftroom-load* by hand"' EXIT
else trap cleanup EXIT; fi

# 1. preflight: free disk, memory, nothing of ours left over
log "preflight (DRY_RUN=$DRY_RUN) -> $LOG"
nas "df -h /volume3" | tee -a "$LOG"
free_gb="$(nas "df -Pk /volume3 | awk 'NR==2 {print int(\$4/1048576)}'" | tail -1)"
avail_mb="$(nas "awk '/^MemAvailable:/ {print int(\$2/1024)}' /proc/meminfo" | tail -1)"
log "free on /volume3: ${free_gb} GB; memory available: ${avail_mb} MB"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$free_gb" =~ ^[0-9]+$ ]] && (( free_gb >= MIN_FREE_GB )) || { log "STOP: less than ${MIN_FREE_GB} GB free"; exit 1; }
  [[ "$avail_mb" =~ ^[0-9]+$ ]] && (( avail_mb >= MIN_AVAIL_MB )) || { log "STOP: less than ${MIN_AVAIL_MB} MB available"; exit 1; }
  left="$(nas "docker ps -a --filter name=^draftroom-load --format '{{.Names}}'; docker network ls --filter name=^draftroom-load --format '{{.Name}}'; if test -e $S; then echo folder; fi")"
  [[ -z "$left" ]] || { trap - EXIT; log "STOP: draftroom-load* already there (another run?): $left"; exit 1; }
fi
U="$(if [[ "$DRY_RUN" != "0" ]]; then echo '<uid>:<gid>'; else nas 'echo "$(id -u):$(id -g)"'; fi)"

# 2. the commit's tracked source (never .env*, .data, node_modules, test results)
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

# 3. the install (the only container with network)
nas "docker image inspect '$IMG' >/dev/null 2>&1 || docker pull '$IMG'"
nas "docker run --rm --name $C_INSTALL --user $U -e HOME=/app/.home -e CI=true -v $S/src:/app -w /app '$IMG' npx --yes $PNPM install --frozen-lockfile --prod=false --store-dir /app/.pnpm-store" | tail -5 | tee -a "$LOG"
folder_mb="$(nas "du -sm $S | cut -f1" | tail -1)"
log "folder: ${folder_mb} MB (cap ${MAX_FOLDER_MB} MB)"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$folder_mb" =~ ^[0-9]+$ ]] && (( folder_mb <= MAX_FOLDER_MB )) || { log "STOP: the folder is over its cap"; exit 1; }
fi

# 4. the secrets, generated on the NAS, 0600, never printed
nas "umask 077 && pw=\$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n') && r() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n'; } && printf 'POSTGRES_PASSWORD=%s\\n' \"\$pw\" > $S/pg.env && { printf 'DATABASE_URL=postgres://postgres:%s@$C_PG:5432/postgres\\n' \"\$pw\"; printf 'DRAFTROOM_TICKET_SECRET=%s\\n' \"\$(r)\"; printf 'DRAFTROOM_INTERNAL_SECRET=%s\\n' \"\$(r)\"; printf 'DRAFTROOM_WORKER_TOKEN=%s\\n' \"\$(r)\"; } > $S/api.env && echo 'secrets written'"

# 5. Postgres on an internal network (no published port)
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

# 6. the api (its own CPUs), then the load
nas "docker run -d --name $C_API --user $U --network $NET --cpus=2 --memory=1g --memory-swap=1g -v $S/src:/app:ro -v $S/data:/data -w /app -e HOME=/tmp -e NODE_ENV=development -e DRAFTROOM_LIVE_ACTIVITIES=on -e DRAFTROOM_DEV_AUTH=1 -e AUTH_PROVIDER=dev -e TRUST_PROXY=true -e PUBLIC_ORIGIN=http://load.test -e DRAFTROOM_DATA_DIR=/data -e HOST=0.0.0.0 -e PORT=3101 -e LOG_LEVEL=warn --env-file $S/api.env '$IMG' node e2e/load/activities-api.ts"
if [[ "$DRY_RUN" == "0" ]]; then
  for i in $(seq 1 90); do
    nas "docker logs $C_API 2>&1 | grep -q 'activities-api listening'" && break
    sleep 1
  done
fi
nas "docker logs $C_API 2>&1 | tail -5" | tee -a "$LOG"
code=0
nas "docker run --rm --name $C_RUN --user $U --network $NET --cpus=3 --memory=1536m --memory-swap=1536m -v $S/src:/app -w /app -e HOME=/tmp -e LOAD_ORIGIN=http://load.test '$IMG' node e2e/load/activities.ts --api http://$C_API:3101 --participants $PARTICIPANTS --bursts $BURSTS --out /app/.load-report.json" \
  >"$EVIDENCE_DIR/load-run.log" 2>&1 || code=$?
if [[ "$DRY_RUN" == "0" ]]; then nas "cat $S/src/.load-report.json" >"$EVIDENCE_DIR/load-report.json" 2>/dev/null || true; fi
nas "docker logs --tail 100 $C_API" >"$EVIDENCE_DIR/api.log" 2>&1 || true
nas "docker logs --tail 50 $C_PG" >"$EVIDENCE_DIR/postgres.log" 2>&1 || true
grep -E 'joined|streams open|started|burst|revealed' "$EVIDENCE_DIR/load-run.log" | tee -a "$LOG" || true
log "load run exit $code; evidence in $EVIDENCE_DIR"
exit "$code"
