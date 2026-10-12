#!/usr/bin/env bash
# REALPG on the NAS: the api project and packages/db against a throwaway PostgreSQL 18, both containers on the
# NAS, so the workstation stays quiet (no test worker runs there) and nothing is published: Postgres and the
# test runner share an --internal network, the password never leaves the NAS.
#
#   DRY_RUN=1 (the default): every SSH/Docker command is printed, nothing touches the NAS.
#   DRY_RUN=0: under the standing NAS approval for throwaway draftroom-* names.
# Usage: DRY_RUN=0 bash scripts/nas-pg-api.sh <commit> [--max-workers N] [--only api|db] [--keep]
#
# What it does, in order: preflight (df, MemAvailable, nothing named draftroom-pg* yet), the commit's tracked
# source (git archive; refused if it would hold .env*, .data, node_modules or test-results) into
# /volume3/Apps/draftroom-pg/src, one install container (the only one with network) with the pinned Node image
# of the B9 scripts, the password generated ON the NAS into two 0600 files in that folder (never printed),
# postgres:18 (already on the NAS; pulled once if absent and then kept, like the Node image; no image is ever
# removed) with UTF8, max_connections 300 and its data on the container's writable layer (a 16 MB tmpfs over
# /var/lib/postgresql keeps Docker from creating an anonymous volume), fsync/synchronous_commit/
# full_page_writes off (the tests check locks, races and migrations, not durability), then
# `vitest run --project api --maxWorkers=N` and `vitest run --project packages packages/db --maxWorkers=1` (its
# files share one database and their PGlite workers outgrew the 2.5 GB runner: SIGKILLs, then a dropped relation
# under a neighbour, waves N and N.1) in a runner
# container, and the cleanup by name (also on failure, unless --keep): containers, the network, the folder.
# Never `prune`, `rm $(docker ps -aq)`, `compose down`, a Docker restart, or anything not named draftroom-pg*.
# Evidence (logs, vitest JSON) goes to $EVIDENCE_DIR on the workstation.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.10.1}"
NAS_USER="${NAS_USER:-chase}"
NAS_KEY="${NAS_KEY:-$HOME/.ssh/ugreen_nas}"
DRY_RUN="${DRY_RUN:-1}"
S=/volume3/Apps/draftroom-pg
NET=draftroom-pg-net
C_PG=draftroom-pg
C_INSTALL=draftroom-pg-install
C_TEST=draftroom-pg-test
IMG='node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de'
PG_IMG=postgres:18
PNPM=pnpm@10.34.5
MIN_FREE_GB=10
MIN_AVAIL_MB=3072
EVIDENCE_DIR="${EVIDENCE_DIR:-${TMPDIR:-/tmp}/nas-pg-evidence}"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/nas-pg-$(date -u +%Y%m%dT%H%M%SZ).log"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

SHA="${1:?usage: nas-pg-api.sh <commit> [--max-workers N] [--keep]}"
shift
MW=4
KEEP=0
ONLY=
while (($#)); do
  case "$1" in
    --max-workers) MW="$2"; shift ;;
    --only) ONLY="$2"; shift ;;
    --keep) KEEP=1 ;;
    *) log "unknown option $1"; exit 2 ;;
  esac
  shift
done
[[ "$MW" =~ ^[0-9]+$ ]] || { log "--max-workers takes a number"; exit 2; }
[[ -z "$ONLY" || "$ONLY" == api || "$ONLY" == db ]] || { log "--only takes api or db"; exit 2; }

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
is_pg_name() { [[ "$1" =~ ^draftroom-pg(-[a-z0-9-]+)?$ ]]; }
list_pg() {
  nas "docker ps -a --filter name=^draftroom-pg --format '{{.Names}}\t{{.Status}}'; echo '--- networks'; docker network ls --filter name=^draftroom-pg --format '{{.Name}}'; echo '--- volumes'; docker volume ls --filter name=^draftroom-pg --format '{{.Name}}'"
}
remove_container() {
  local name="$1" listed
  is_pg_name "$name" || { log "REFUSED: $name is not a draftroom-pg name"; return 1; }
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker rm -f $name"; return 0; fi
  listed="$(nas "docker ps -a --filter name=^draftroom-pg --format '{{.Names}}'")"
  if grep -qx -- "$name" <<<"$listed"; then nas "docker rm -f $name" >/dev/null && log "removed container $name"
  else log "container $name not present"; fi
}
cleanup() {
  log "cleanup: before"
  list_pg | tee -a "$LOG" || true
  for c in "$C_TEST" "$C_INSTALL" "$C_PG"; do remove_container "$c" || true; done
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker network rm $NET"
  elif nas "docker network ls --filter name=^draftroom-pg --format '{{.Name}}'" | grep -qx -- "$NET"; then
    nas "docker network rm $NET" >/dev/null && log "removed network $NET"
  fi
  nas "if [ -d $S ]; then rm -rf -- $S; fi; test ! -e $S && echo 'folder removed'" | tee -a "$LOG" || true
  log "cleanup: after"
  list_pg | tee -a "$LOG" || true
}
if ((KEEP)); then trap 'log "--keep: run the script again without it, or remove draftroom-pg* by hand"' EXIT
else trap cleanup EXIT; fi

# 1. preflight
log "preflight (DRY_RUN=$DRY_RUN) -> $LOG"
nas "df -h /volume3" | tee -a "$LOG"
free_gb="$(nas "df -Pk /volume3 | awk 'NR==2 {print int(\$4/1048576)}'" | tail -1)"
avail_mb="$(nas "awk '/^MemAvailable:/ {print int(\$2/1024)}' /proc/meminfo" | tail -1)"
log "free on /volume3: ${free_gb} GB; memory available: ${avail_mb} MB"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$free_gb" =~ ^[0-9]+$ ]] && (( free_gb >= MIN_FREE_GB )) || { log "STOP: less than ${MIN_FREE_GB} GB free"; exit 1; }
  [[ "$avail_mb" =~ ^[0-9]+$ ]] && (( avail_mb >= MIN_AVAIL_MB )) || { log "STOP: less than ${MIN_AVAIL_MB} MB available"; exit 1; }
  left="$(nas "docker ps -a --filter name=^draftroom-pg --format '{{.Names}}'; docker network ls --filter name=^draftroom-pg --format '{{.Name}}'; if test -e $S; then echo folder; fi")"
  [[ -z "$left" ]] || { trap - EXIT; log "STOP: draftroom-pg* already there (another run?): $left"; exit 1; }
fi
U="$(if [[ "$DRY_RUN" != "0" ]]; then echo '<uid>:<gid>'; else nas 'echo "$(id -u):$(id -g)"'; fi)"

# 2. the commit's tracked source
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

# 3. the install (the only container with network)
nas "docker image inspect '$IMG' >/dev/null 2>&1 || docker pull '$IMG'"
nas "docker run --rm --name $C_INSTALL --user $U -e HOME=/app/.home -e CI=true -v $S/src:/app -w /app '$IMG' npx --yes $PNPM install --frozen-lockfile --store-dir /app/.pnpm-store" | tail -5 | tee -a "$LOG"

# 4. the password, generated on the NAS, two 0600 files, never printed
nas "umask 077 && pw=\$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n') && printf 'POSTGRES_PASSWORD=%s\\n' \"\$pw\" > $S/pg.env && printf 'DRAFTROOM_TEST_DATABASE_URL=postgres://postgres:%s@$C_PG:5432/postgres\\n' \"\$pw\" > $S/test.env && echo 'secrets written'"

# 5. Postgres on an internal network (no published port)
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

# 6. the suites, in a runner on the same internal network
run_suite() {
  local name="$1"
  shift
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
log "done; evidence in $EVIDENCE_DIR"
