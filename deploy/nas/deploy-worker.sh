#!/usr/bin/env bash
# Draftroom preview worker on the NAS: build on the NAS, swap the container, report. Run from the PC
# (Git Bash) in any directory; see deploy/nas/README.md.
#
#   deploy/nas/deploy-worker.sh [deploy]    upload sources + compose file (+ env file), build, swap, status
#   deploy/nas/deploy-worker.sh status      both containers: state, restarts, memory/CPU, last log lines
#   deploy/nas/deploy-worker.sh logs [N]    worker: last N log lines (default 100); `logs -f` follows;
#                                           `logs N office` / `logs -f office`: the office sidecar's
#   deploy/nas/deploy-worker.sh stop        graceful stop (a job in progress is handed back to the api)
#   deploy/nas/deploy-worker.sh start       start the already-built container again
#   deploy/nas/deploy-worker.sh bundle OUT  local dry run: build and check the upload bundle, no ssh
#   deploy/nas/deploy-worker.sh check-env   local: validate the worker env file (never prints values)
#
# Isolation: every remote docker command names the compose project `draftroom-worker` (containers
# draftroom-worker and draftroom-office, one image) and its own compose file under NAS_DIR. Nothing here
# lists, stops, prunes or edits anything else on the NAS (in particular the `theaitre` project); image
# cleanup is limited to dangling images labelled com.draftroom.component=worker.
#
# Secrets: the only secret is DRAFTROOM_WORKER_TOKEN in the local env file (default
# deploy/nas/worker/.env.worker, gitignored by `.env.*`). It is copied to NAS_DIR/worker.env with mode 600
# and is never printed, logged, put on a command line or included in the source bundle.
set -euo pipefail

PROJECT=draftroom-worker
CONTAINER=draftroom-worker
OFFICE_CONTAINER=draftroom-office
NAS=${NAS:-chase@192.168.10.1}
NAS_KEY=${NAS_KEY:-$HOME/.ssh/ugreen_nas}
NAS_DIR=${NAS_DIR:-/volume3/Apps/draftroom-worker}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/../.." && pwd)
ENV_FILE=${WORKER_ENV_FILE:-$SCRIPT_DIR/worker/.env.worker}
COMPOSE_FILE=$SCRIPT_DIR/worker/docker-compose.yml

die() {
  printf 'deploy-worker: %s\n' "$*" >&2
  exit 1
}
say() { printf '==> %s\n' "$*"; }

# NAS_DIR is interpolated into remote commands: plain path characters only, and it must be ours.
[[ $NAS_DIR =~ ^/[A-Za-z0-9/_.-]+/draftroom-worker$ ]] || die "NAS_DIR must be an absolute path ending in /draftroom-worker"
[[ $NAS_DIR != *theaitre* && $NAS_DIR != *..* ]] || die "refusing NAS_DIR $NAS_DIR"
[[ $NAS =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+$ ]] || die "NAS must look like user@host"

remote() {
  [ -f "$NAS_KEY" ] || die "ssh key $NAS_KEY not found (set NAS_KEY)"
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS" "$@"
}

# Runs a bash script on the NAS with the project/dir/container as positional parameters.
remote_script() {
  remote bash -s -- "$NAS_DIR" "$PROJECT" "$CONTAINER" "$@"
}

# ---- local checks -----------------------------------------------------------------------------------

validate_env() {
  local f=$1 line key val have_url='' have_token='' have_id=''
  [ -f "$f" ] || die "worker env file $f not found (see deploy/nas/README.md)"
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case $line in '' | '#'*) continue ;; esac
    [[ $line == *=* ]] || die "worker env file: every line must be KEY=value"
    key=${line%%=*}
    val=${line#*=}
    [[ $val != \"* && $val != \'* ]] || die "worker env file: $key must not be quoted"
    case $key in
      DRAFTROOM_API_URL)
        have_url=1
        [[ $val =~ ^https?://[^/?#@[:space:]]+/?$ ]] || die "DRAFTROOM_API_URL must be an http(s) origin (https://host[:port]), no path or credentials"
        [[ $val == https://* ]] || printf 'deploy-worker: warning: DRAFTROOM_API_URL is plain http (the worker accepts that only on a private network)\n' >&2
        ;;
      DRAFTROOM_WORKER_TOKEN)
        have_token=1
        ((${#val} >= 32)) || die "DRAFTROOM_WORKER_TOKEN must be at least 32 characters"
        [[ $val != dev-only-* ]] || die "DRAFTROOM_WORKER_TOKEN is the development placeholder"
        [[ $val != *[[:space:]]* ]] || die "DRAFTROOM_WORKER_TOKEN must not contain whitespace"
        ;;
      WORKER_ID)
        have_id=1
        [[ $val =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "WORKER_ID must be 1-64 letters, digits, dot, underscore or hyphen"
        ;;
      *) die "worker env file: $key is not allowed (only DRAFTROOM_API_URL, DRAFTROOM_WORKER_TOKEN, WORKER_ID)" ;;
    esac
  done <"$f"
  [[ -n $have_url && -n $have_token && -n $have_id ]] ||
    die "worker env file must set DRAFTROOM_API_URL, DRAFTROOM_WORKER_TOKEN and WORKER_ID"
}

# The repository subset docker/worker.Dockerfile needs: every workspace manifest + the lockfile (the
# frozen, filtered install checks them all), docker/ (the Dockerfiles and their helpers), packages/ and
# apps/worker/ sources. Tests, fixtures, dev.env, .env* files and node_modules are left out.
make_bundle() {
  local out=$1 manifests=()
  (
    cd "$REPO"
    mapfile -t manifests < <(find apps e2e -maxdepth 2 -name package.json -not -path '*/node_modules/*' -not -path 'apps/worker/*' | sort)
    tar -czf "$out" \
      --exclude=node_modules --exclude='.env' --exclude='.env.*' --exclude='dev.env' \
      --exclude='*.test.ts' --exclude='apps/worker/test' --exclude='apps/worker/scripts' \
      --exclude='packages/*/test' --exclude='.data' --exclude='*.log' --exclude='*.tsbuildinfo' \
      package.json pnpm-lock.yaml pnpm-workspace.yaml .dockerignore .node-version \
      docker packages apps/worker "${manifests[@]}"
  )
  # (No `tar | grep -q` here: under pipefail an early grep exit SIGPIPEs tar and hides the match.)
  local names
  names=$(tar -tzf "$out")
  if grep -Eq '(^|/)(\.env($|\.)|dev\.env$|node_modules/)' <<<"$names"; then
    die "bundle check failed: it contains an env file or node_modules"
  fi
  # The token must not be anywhere in the bundle (e.g. pasted into a source file by mistake). It is
  # handed to grep through a pipe, never as an argument.
  if [ -f "$ENV_FILE" ]; then
    local token
    token=$(sed -n 's/\r$//; /^DRAFTROOM_WORKER_TOKEN=/{s/^DRAFTROOM_WORKER_TOKEN=//p;q;}' "$ENV_FILE")
    if [ -n "$token" ] && tar -xzOf "$out" | grep -cF -f <(printf '%s\n' "$token") >/dev/null; then
      die "bundle check failed: the worker token appears in a bundled file"
    fi
  fi
}

# ---- commands ---------------------------------------------------------------------------------------

cmd_status() {
  remote_script "$OFFICE_CONTAINER" <<'REMOTE'
set -u
dir=$1 project=$2
if [ ! -f "$dir/docker-compose.yml" ]; then
  echo "not deployed: $dir/docker-compose.yml does not exist"
  exit 0
fi
docker compose -p "$project" -f "$dir/docker-compose.yml" ps
for container in "$3" "$4"; do
  docker inspect "$container" >/dev/null 2>&1 || continue
  echo "--- $container"
  docker inspect --format 'state={{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}} oom-killed={{.State.OOMKilled}} image={{.Image}}' "$container"
  if [ "$(docker inspect --format '{{.State.Running}}' "$container")" = true ]; then
    docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}} pids={{.PIDs}}' "$container"
  fi
  echo "--- last log lines of $container"
  docker logs --tail 20 "$container" 2>&1
done
REMOTE
}

cmd_logs() {
  local arg=${1:-100} container=$CONTAINER
  if [ "${2:-}" = office ]; then container=$OFFICE_CONTAINER; fi
  if [ "$arg" = -f ]; then
    remote docker logs --tail 50 -f "$container"
  else
    [[ $arg =~ ^[0-9]{1,6}$ ]] || die "logs takes a line count or -f (then optionally: office)"
    remote docker logs --tail "$arg" "$container"
  fi
}

cmd_stop() {
  say "stopping $CONTAINER (it finishes or hands back its current job first)"
  remote_script <<'REMOTE'
set -eu
dir=$1 project=$2
docker compose -p "$project" -f "$dir/docker-compose.yml" stop
docker compose -p "$project" -f "$dir/docker-compose.yml" ps -a
REMOTE
}

cmd_start() {
  remote_script <<'REMOTE'
set -eu
dir=$1 project=$2
docker compose -p "$project" -f "$dir/docker-compose.yml" up -d --no-build
REMOTE
  cmd_status
}

cmd_deploy() {
  [ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE"
  command -v tar >/dev/null || die "tar is required"
  local have_env=0
  if [ -f "$ENV_FILE" ]; then
    validate_env "$ENV_FILE"
    have_env=1
  fi

  local bundle # 'work' stays global: the EXIT trap runs after this function returns
  work=$(mktemp -d)
  trap 'rm -rf "${work:-}"' EXIT
  bundle=$work/bundle.tgz
  say "bundling sources"
  make_bundle "$bundle"
  say "bundle: $(du -h "$bundle" | cut -f1), $(tar -tzf "$bundle" | wc -l | tr -d ' ') entries"

  say "checking $NAS"
  remote_script <<'REMOTE'
set -eu
dir=$1
docker version --format 'docker {{.Server.Version}}' >/dev/null
docker compose version >/dev/null
mkdir -p "$dir"
# Owner-only. New folders under /volume3/Apps inherit the share's ACL (drwxrwxrwx+, measured on the
# NAS 2026-09-27), so without this every NAS account could edit docker-compose.yml or the build
# context in src/, which Docker then runs as root. chmod drops the inherited ACL on this filesystem.
chmod 700 "$dir"
REMOTE
  if [ "$have_env" = 0 ]; then
    remote test -s "$NAS_DIR/worker.env" ||
      die "no worker env on the NAS and no local $ENV_FILE: create it first (see deploy/nas/README.md)"
    say "keeping the worker.env already on the NAS"
  fi

  say "uploading"
  remote "cat > '$NAS_DIR/bundle.tgz.part' && mv '$NAS_DIR/bundle.tgz.part' '$NAS_DIR/bundle.tgz'" <"$bundle"
  remote "cat > '$NAS_DIR/docker-compose.yml.part' && mv '$NAS_DIR/docker-compose.yml.part' '$NAS_DIR/docker-compose.yml'" <"$COMPOSE_FILE"
  if [ "$have_env" = 1 ]; then
    # CRLF from a Windows editor would end up inside the token; strip it. Mode 600 before any byte lands.
    tr -d '\r' <"$ENV_FILE" | remote "umask 077 && cat > '$NAS_DIR/worker.env.part' && chmod 600 '$NAS_DIR/worker.env.part' && mv '$NAS_DIR/worker.env.part' '$NAS_DIR/worker.env'"
  fi

  say "building on the NAS (the running worker keeps working meanwhile)"
  remote_script "$OFFICE_CONTAINER" <<'REMOTE'
set -eu
dir=$1 project=$2 container=$3 office=$4
cd "$dir"
compose() { docker compose -p "$project" -f "$dir/docker-compose.yml" "$@"; }
rm -rf src.new
mkdir src.new
tar -xzf bundle.tgz -C src.new
if [ -d src ]; then
  rm -rf src.old
  mv src src.old
fi
mv src.new src
if ! compose build worker; then
  echo "build failed: previous sources restored; the running container was not touched" >&2
  rm -rf src
  if [ -d src.old ]; then mv src.old src; fi
  exit 1
fi
echo "==> swapping the containers (worker and office sidecar, one image)"
compose up -d --no-build --remove-orphans
# Only this project's superseded image (dangling + our label); never a global prune.
docker image prune -f --filter label=com.draftroom.component=worker >/dev/null
rm -rf src.old bundle.tgz
# waits until <container> logs <pattern>, or gives up after 60 s (LibreOffice's first start takes a few).
wait_for() {
  for _ in $(seq 1 60); do
    if docker logs "$1" 2>&1 | grep -q "$2"; then return 0; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" != true ]; then break; fi
    sleep 1
  done
  echo "$1 did not log '$2' in time:" >&2
  docker logs --tail 30 "$1" >&2 2>&1 || true
  return 1
}
wait_for "$office" '\[office\] listening'
wait_for "$container" '\[worker\] started (api: '
REMOTE
  say "deployed"
  cmd_status
}

case ${1:-deploy} in
  deploy) cmd_deploy ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-100}" "${3:-}" ;;
  stop) cmd_stop ;;
  start) cmd_start ;;
  bundle)
    [ -n "${2:-}" ] || die "usage: deploy-worker.sh bundle OUT.tgz"
    make_bundle "$2"
    say "bundle ok: $2 ($(tar -tzf "$2" | wc -l | tr -d ' ') entries)"
    ;;
  check-env)
    validate_env "$ENV_FILE"
    say "worker env file ok: $ENV_FILE"
    ;;
  -h | --help | help) sed -n '2,13p' "$0" ;;
  *) die "unknown command '$1' (deploy, status, logs, stop, start, bundle, check-env)" ;;
esac
