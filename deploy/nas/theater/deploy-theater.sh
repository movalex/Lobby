#!/usr/bin/env bash
# The theater Lobby on the NAS: build on the NAS, start, report. Run from the PC (Git Bash); see
# deploy/nas/theater/README.md.
#
#   deploy/nas/theater/deploy-theater.sh [deploy]       upload sources + compose file, create missing secrets,
#                                                       build, start (the tunnel too once its token is there)
#   deploy/nas/theater/deploy-theater.sh status         containers, health, memory, last log lines
#   deploy/nas/theater/deploy-theater.sh logs SVC [N]   one service's last N log lines (default 100); N=-f follows
#   deploy/nas/theater/deploy-theater.sh smoke          from inside the NAS: page, api health, sign-in config
#   deploy/nas/theater/deploy-theater.sh stop|start     stop / start the whole project without rebuilding
#   deploy/nas/theater/deploy-theater.sh bundle OUT     local dry run: build and check the upload bundle
#
# Settings (address, workspace name, sign-in methods, Google client id) live in settings.env next to
# this script: not secret, committed, uploaded as the project's .env on every deploy.
#
# Isolation: every remote docker command names the compose project `lobby-theater` and its own folder
# NAS_DIR. Nothing here lists, stops, prunes or edits another project (theaitre, draftroom-worker, ctboyd).
#
# Secrets never leave the NAS and are never printed. The first deploy creates them there (64 random hex
# characters each, mode 600, kept across deploys): secrets/shared.env (ticket + internal secrets),
# secrets/db.env (the Postgres password), secrets/api.env (DATABASE_URL, the worker and partner tokens),
# secrets/worker.env (the worker token). The Cloudflare Tunnel token is yours: put it in the local file
# deploy/nas/theater/.env.tunnel (one line, TUNNEL_TOKEN=..., gitignored) and deploy, or write
# secrets/tunnel.env on the NAS yourself.
set -euo pipefail

PROJECT=lobby-theater
NAS=${NAS:-chase@192.168.10.1}
NAS_KEY=${NAS_KEY:-$HOME/.ssh/ugreen_nas}
NAS_DIR=${NAS_DIR:-/volume3/Apps/lobby-theater}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/../../.." && pwd)
COMPOSE_FILE=$SCRIPT_DIR/docker-compose.yml
SETTINGS_FILE=$SCRIPT_DIR/settings.env # non-secret, committed; uploaded as the project's .env
TUNNEL_FILE=${TUNNEL_ENV_FILE:-$SCRIPT_DIR/.env.tunnel}

die() {
  printf 'deploy-theater: %s\n' "$*" >&2
  exit 1
}
say() { printf '==> %s\n' "$*"; }

[[ $NAS_DIR =~ ^/[A-Za-z0-9/_.-]+/lobby-theater$ ]] || die "NAS_DIR must be an absolute path ending in /lobby-theater"
[[ $NAS_DIR != *theaitre* && $NAS_DIR != *..* ]] || die "refusing NAS_DIR $NAS_DIR"
[[ $NAS =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+$ ]] || die "NAS must look like user@host"

# settings.env: only the four known keys, checked so a typo fails here and not as a crash-looping api.
validate_settings() {
  local line key val origin='' methods='' client=''
  [ -f "$SETTINGS_FILE" ] || die "missing $SETTINGS_FILE"
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case $line in '' | '#'*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    case $key in
      LOBBY_ORIGIN) origin=$val ;;
      LOBBY_WORKSPACE_NAME) [[ -n $val && ${#val} -le 120 ]] || die "settings.env: LOBBY_WORKSPACE_NAME must be 1-120 characters" ;;
      LOBBY_SIGNIN_METHODS) methods=$val ;;
      LOBBY_GOOGLE_CLIENT_ID) client=$val ;;
      *) die "settings.env: unknown setting $key" ;;
    esac
  done <"$SETTINGS_FILE"
  [[ $origin =~ ^https://[a-z0-9.-]+$ ]] || die "settings.env: LOBBY_ORIGIN must be https://host (lowercase, no port or path)"
  [[ $methods =~ ^(email|google)(,(email|google))?$ ]] || die "settings.env: LOBBY_SIGNIN_METHODS must be email, google or both"
  if [[ $methods == *google* ]]; then
    [[ $client =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]] ||
      die "settings.env: google sign-in needs LOBBY_GOOGLE_CLIENT_ID (<number>-<id>.apps.googleusercontent.com)"
  fi
}
validate_settings

remote() {
  [ -f "$NAS_KEY" ] || die "ssh key $NAS_KEY not found (set NAS_KEY)"
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "$NAS" "$@"
}
# A bash script on the NAS with the folder and project as $1 and $2.
remote_script() { remote bash -s -- "$NAS_DIR" "$PROJECT" "$@"; }

validate_tunnel() {
  local f=$1 line n=0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case $line in '' | '#'*) continue ;; esac
    n=$((n + 1))
    [[ $line == TUNNEL_TOKEN=* ]] || die "$f: the only allowed line is TUNNEL_TOKEN=..."
    local val=${line#TUNNEL_TOKEN=}
    [[ ${#val} -ge 32 && $val != *[[:space:]\"\']* ]] || die "$f: TUNNEL_TOKEN looks wrong (unquoted, no spaces, the long token Cloudflare shows)"
  done <"$f"
  [ "$n" = 1 ] || die "$f must hold exactly one TUNNEL_TOKEN line"
}

# Every workspace manifest + the lockfile (the frozen, filtered installs check them all), docker/, the
# packages, the four apps the images build, patches/ (the engine patch: every image's pnpm install reads
# pnpm-workspace.yaml's patchedDependencies) and this folder's nginx.conf. No tests, env files, local data
# or node_modules.
make_bundle() {
  local out=$1 manifests=()
  (
    cd "$REPO"
    mapfile -t manifests < <(find e2e -maxdepth 1 -name package.json | sort)
    tar -czf "$out" \
      --exclude=node_modules --exclude='.env' --exclude='.env.*' --exclude='dev.env' \
      --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='apps/*/test' --exclude='apps/worker/scripts' \
      --exclude='packages/*/test' --exclude='.data' --exclude='.data-*' --exclude='dist' \
      --exclude='*.log' --exclude='*.tsbuildinfo' \
      package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .dockerignore .node-version \
      patches docker packages apps/api apps/sync apps/web apps/worker deploy/nas/theater/nginx.conf "${manifests[@]}"
  )
  local names
  names=$(tar -tzf "$out")
  if grep -Eq '(^|/)(\.env($|\.)|dev\.env$|node_modules/)' <<<"$names"; then
    die "bundle check failed: it contains an env file or node_modules"
  fi
  if [ -f "$TUNNEL_FILE" ]; then
    local token
    token=$(sed -n 's/\r$//; /^TUNNEL_TOKEN=/{s/^TUNNEL_TOKEN=//p;q;}' "$TUNNEL_FILE")
    if [ -n "$token" ] && tar -xzOf "$out" | grep -cF -f <(printf '%s\n' "$token") >/dev/null; then
      die "bundle check failed: the tunnel token appears in a bundled file"
    fi
  fi
}

compose_fn='compose() {
  local profile=()
  if [ -s "$dir/secrets/tunnel.env" ]; then profile=(--profile tunnel); fi
  docker compose -p "$project" -f "$dir/docker-compose.yml" "${profile[@]}" "$@"
}'

cmd_status() {
  remote_script <<REMOTE
set -u
dir=\$1 project=\$2
$compose_fn
if [ ! -f "\$dir/docker-compose.yml" ]; then echo "not deployed: \$dir/docker-compose.yml does not exist"; exit 0; fi
cd "\$dir"
compose ps -a
if [ ! -s secrets/tunnel.env ]; then echo "(no secrets/tunnel.env yet: the tunnel is not running, nothing is reachable from the internet)"; fi
ids=\$(compose ps -q)
[ -n "\$ids" ] && docker stats --no-stream --format '{{.Name}}  cpu={{.CPUPerc}}  mem={{.MemUsage}}' \$ids
for svc in api sync web worker tunnel; do
  id=\$(compose ps -q "\$svc" 2>/dev/null)
  [ -n "\$id" ] || continue
  echo "--- \$svc: \$(docker inspect --format 'state={{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}' "\$id")"
  docker logs --tail 8 "\$id" 2>&1
done
REMOTE
}

cmd_logs() {
  local svc=${1:-} n=${2:-100}
  [[ $svc =~ ^(db|api|sync|web|worker|tunnel)$ ]] || die "logs takes a service: db, api, sync, web, worker or tunnel"
  local follow=()
  if [ "$n" = -f ]; then
    follow=(-f)
    n=50
  fi
  [[ $n =~ ^[0-9]{1,6}$ ]] || die "logs SVC takes a line count or -f"
  remote_script "$svc" "$n" "${follow[@]}" <<REMOTE
set -eu
dir=\$1 project=\$2 svc=\$3 n=\$4
$compose_fn
compose logs --no-log-prefix --tail "\$n" \${5:-} "\$svc"
REMOTE
}

cmd_smoke() {
  remote_script <<'REMOTE'
set -u
dir=$1 project=$2
web=$(docker compose -p "$project" -f "$dir/docker-compose.yml" ps -q web)
[ -n "$web" ] || { echo "web is not running"; exit 1; }
# From inside the web container (the only way in besides the tunnel): page, api health, sign-in config.
docker exec "$web" sh -c '
  printf "page:        "; wget -qO- http://127.0.0.1:8080/ | grep -o "<title>[^<]*</title>" || echo FAIL
  printf "api health:  "; wget -qO- http://api:5859/healthz || echo FAIL; echo
  printf "auth config: "; wget -qO- http://127.0.0.1:8080/api/auth/config || echo FAIL; echo
  printf "missing font 404: "; wget -qS -O /dev/null http://127.0.0.1:8080/excalidraw-assets/fonts/__missing__.woff2 2>&1 | grep -o "HTTP/[0-9.]* [0-9]*" | head -1
'
REMOTE
}

cmd_stop() {
  remote_script <<REMOTE
set -eu
dir=\$1 project=\$2
$compose_fn
compose stop
compose ps -a
REMOTE
}

cmd_start() {
  remote_script <<REMOTE
set -eu
dir=\$1 project=\$2
$compose_fn
compose up -d --no-build
REMOTE
  cmd_status
}

cmd_deploy() {
  [ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE"
  local have_tunnel=0
  if [ -f "$TUNNEL_FILE" ]; then
    validate_tunnel "$TUNNEL_FILE"
    have_tunnel=1
  fi

  work=$(mktemp -d)
  trap 'rm -rf "${work:-}"' EXIT
  local bundle=$work/bundle.tgz
  say "bundling sources"
  make_bundle "$bundle"
  say "bundle: $(du -h "$bundle" | cut -f1), $(tar -tzf "$bundle" | wc -l | tr -d ' ') entries"

  say "preparing $NAS:$NAS_DIR"
  remote_script <<'REMOTE'
set -eu
dir=$1
docker compose version >/dev/null
mkdir -p "$dir/secrets"
# Owner-only (the Apps share's inherited ACL would let every NAS account edit what Docker runs as root).
chmod 700 "$dir" "$dir/secrets"
REMOTE

  say "uploading"
  remote "cat > '$NAS_DIR/bundle.tgz.part' && mv '$NAS_DIR/bundle.tgz.part' '$NAS_DIR/bundle.tgz'" <"$bundle"
  remote "cat > '$NAS_DIR/docker-compose.yml.part' && mv '$NAS_DIR/docker-compose.yml.part' '$NAS_DIR/docker-compose.yml'" <"$COMPOSE_FILE"
  tr -d '\r' <"$SETTINGS_FILE" | remote "cat > '$NAS_DIR/.env.part' && mv '$NAS_DIR/.env.part' '$NAS_DIR/.env'"
  if [ "$have_tunnel" = 1 ]; then
    tr -d '\r' <"$TUNNEL_FILE" | remote "umask 077 && cat > '$NAS_DIR/secrets/tunnel.env.part' && mv '$NAS_DIR/secrets/tunnel.env.part' '$NAS_DIR/secrets/tunnel.env'"
  fi

  say "creating missing secrets, building and starting on the NAS"
  remote_script <<REMOTE
set -eu
dir=\$1 project=\$2
$compose_fn
cd "\$dir"
umask 077
rand() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
if [ ! -s secrets/shared.env ]; then
  printf 'DRAFTROOM_TICKET_SECRET=%s\nDRAFTROOM_INTERNAL_SECRET=%s\n' "\$(rand)" "\$(rand)" > secrets/shared.env
  echo "created secrets/shared.env"
fi
if [ ! -s secrets/db.env ] && [ ! -s secrets/api.env ]; then
  pw=\$(rand) worker=\$(rand) partner=\$(rand)
  printf 'POSTGRES_PASSWORD=%s\n' "\$pw" > secrets/db.env
  printf 'DATABASE_URL=postgres://lobby:%s@db:5432/lobby\nDRAFTROOM_WORKER_TOKEN=%s\nDRAFTROOM_PARTNER_TOKEN=%s\n' "\$pw" "\$worker" "\$partner" > secrets/api.env
  printf 'DRAFTROOM_WORKER_TOKEN=%s\n' "\$worker" > secrets/worker.env
  echo "created secrets/db.env, secrets/api.env, secrets/worker.env"
elif [ ! -s secrets/db.env ] || [ ! -s secrets/api.env ]; then
  # The Postgres password is in both: one without the other cannot be repaired by guessing.
  echo "only one of secrets/db.env and secrets/api.env exists: restore the other (both hold the database password)" >&2
  exit 1
elif [ ! -s secrets/worker.env ]; then
  grep '^DRAFTROOM_WORKER_TOKEN=' secrets/api.env > secrets/worker.env
  echo "recreated secrets/worker.env from secrets/api.env"
fi
chmod 600 secrets/*.env
# Sources readable by everyone INSIDE the images (the apps run as the unprivileged node user, and COPY
# keeps file modes); the folder itself stays owner-only on the NAS (chmod 700 above).
umask 022
rm -rf src.new && mkdir src.new && tar -xzf bundle.tgz -C src.new
if [ -d src ]; then rm -rf src.old && mv src src.old; fi
mv src.new src
# One image at a time: the photo workers share this NAS, and the web build (vite) alone wants ~1.5 GB.
build_all() { for svc in api sync web worker; do echo "==> building \$svc"; compose build "\$svc" || return 1; done; }
if ! build_all; then
  echo "build failed: previous sources restored; running containers were not touched" >&2
  rm -rf src
  if [ -d src.old ]; then mv src.old src; fi
  exit 1
fi
compose up -d --no-build --remove-orphans
rm -rf src.old bundle.tgz
# Wait for the api (migrations run on its start) and sync to report healthy.
for svc in api sync; do
  for _ in \$(seq 1 90); do
    id=\$(compose ps -q "\$svc")
    state=\$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "\$id" 2>/dev/null || echo missing)
    [ "\$state" = healthy ] && break
    sleep 2
  done
  echo "\$svc: \$state"
done
REMOTE
  say "deployed"
  cmd_status
}

case ${1:-deploy} in
  deploy) cmd_deploy ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-}" "${3:-100}" ;;
  smoke) cmd_smoke ;;
  stop) cmd_stop ;;
  start) cmd_start ;;
  bundle)
    [ -n "${2:-}" ] || die "bundle takes an output path"
    make_bundle "$2"
    say "bundle: $(du -h "$2" | cut -f1), $(tar -tzf "$2" | wc -l | tr -d ' ') entries"
    ;;
  *) die "unknown command ${1} (deploy, status, logs, smoke, stop, start, bundle)" ;;
esac
