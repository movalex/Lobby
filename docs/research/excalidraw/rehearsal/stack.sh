#!/bin/sh
# draftroom-rehearsal stack on the NAS: a LAN-only copy of staging for the Excalidraw cut-over rehearsal
# (docs/EXCALIDRAW-CUTOVER.md §3). Touches ONLY names that start with draftroom-rehearsal-; never prunes.
#
#   ./stack.sh start [TAG]        start pg, api, sync and the TLS edge (images draftroom-rehearsal-{api,sync}:TAG, default r0)
#   ./stack.sh stop               stop the four containers (data stays)
#   ./stack.sh rm                 stop and remove the four containers (data, images, env files stay)
#   ./stack.sh status             containers, memory, the last log line of each
#   ./stack.sh logs NAME [N]      NAME = pg | api | sync | edge; last N lines (default 50)
#   ./stack.sh restore-pg FILE    restore a staging Postgres dump (pg_dump -Fc or plain SQL) into a fresh
#                                 database, api stopped meanwhile, then start the api again
#   ./stack.sh pg-counts          users / workspaces / projects / boards / memberships in the rehearsal database (counts only)
#   ./stack.sh rooms              board files under data/sync/rooms (count and total size)
#   ./stack.sh dump-staging       pg_dump of STAGING (env/pg-source.env) from a one-shot postgres:18 container
#                                 into pg/dump/staging-<time>.dump (owned by the caller, mode 600). Render refuses
#                                 it while the database's ipAllowList is empty; the owner allows the NAS's public
#                                 /32 for the minutes of the dump (rehearsal/pg-allowlist.mjs add | restore).
#
# Secrets live only in env/*.env (mode 600). This script never prints them.
set -eu
D=/volume3/Apps/draftroom-rehearsal
NET=draftroom-rehearsal-net
LAN=192.168.10.1
NODE_IMG=node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de
PG_IMG=postgres:18
P=draftroom-rehearsal

running() { [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
exists() { docker inspect "$1" >/dev/null 2>&1; }

wait_pg() {
  i=0
  while [ $i -lt 90 ]; do
    if docker exec $P-pg pg_isready -U draftroom -d draftroom >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 1
  done
  echo "postgres did not become ready" >&2; return 1
}

start_one() { # name, then the docker run arguments after --name
  name=$1; shift
  if exists "$name"; then docker start "$name" >/dev/null; echo "started $name (existing)"; else docker run -d --name "$name" "$@" >/dev/null; echo "created $name"; fi
}

cmd=${1:-status}
case "$cmd" in
  start)
    TAG=${2:-r0}
    docker network inspect $NET >/dev/null 2>&1 || docker network create $NET >/dev/null
    start_one $P-pg --network $NET --env-file $D/env/pg.env -v $D/pg/data:/var/lib/postgresql \
      --memory 256m --restart unless-stopped $PG_IMG
    wait_pg
    start_one $P-api --network $NET --env-file $D/env/api.env -v $D/data/api:/var/data \
      --memory 512m --cpus 0.5 --restart unless-stopped $P-api:$TAG
    start_one $P-sync --network $NET --env-file $D/env/sync.env -v $D/data/sync:/var/data \
      --memory 512m --cpus 0.5 --restart unless-stopped $P-sync:$TAG
    # env/edge.env (optional): EDGE_CSP=<the cut-over's Content-Security-Policy on one line> (runbook C13 /
    # B5: present on the Excalidraw build, absent on R0). The edge reads it at start: `docker rm -f` the
    # edge container and `start` again to apply a change.
    EDGE_ENV=""; if [ -f $D/env/edge.env ]; then EDGE_ENV="--env-file $D/env/edge.env"; fi
    start_one $P-edge --network $NET $EDGE_ENV -p $LAN:8443:8443 -p $LAN:8444:8444 \
      -v $D/edge:/edge:ro -v $D/web:/web-root:ro -e EDGE_DIST=/web-root/dist \
      --init --memory 256m --restart unless-stopped $NODE_IMG node /edge/edge.mjs
    ;;
  stop)
    for c in edge sync api pg; do if running $P-$c; then docker stop $P-$c >/dev/null && echo "stopped $P-$c"; fi; done
    ;;
  rm)
    for c in edge sync api pg; do if exists $P-$c; then docker rm -f $P-$c >/dev/null && echo "removed $P-$c"; fi; done
    ;;
  status)
    docker ps -a --filter name="^$P-" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
    for c in pg api sync edge; do
      if running $P-$c; then
        printf '%s: ' "$P-$c"; docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}} restarts=' $P-$c | tr -d '\n'
        docker inspect --format '{{.RestartCount}}' $P-$c
        docker logs --tail 1 $P-$c 2>&1 | cut -c1-160 | sed 's/^/    /'
      fi
    done
    ;;
  logs)
    docker logs --tail "${3:-50}" "$P-${2:?name: pg|api|sync|edge}" 2>&1
    ;;
  restore-pg)
    f=${2:?dump file}
    [ -s "$f" ] || { echo "no such dump file (or empty): $f" >&2; exit 1; }
    running $P-pg || { echo "start the stack first" >&2; exit 1; }
    if running $P-api; then docker stop $P-api >/dev/null && echo "api stopped"; fi
    docker exec $P-pg psql -U draftroom -d postgres -v ON_ERROR_STOP=1 -q \
      -c 'DROP DATABASE IF EXISTS draftroom' -c 'CREATE DATABASE draftroom OWNER draftroom'
    if [ "$(head -c 5 "$f")" = "PGDMP" ]; then
      docker exec -i $P-pg pg_restore -U draftroom -d draftroom --no-owner --no-privileges --exit-on-error <"$f"
    else
      docker exec -i $P-pg psql -U draftroom -d draftroom -v ON_ERROR_STOP=1 -q <"$f"
    fi
    echo "restored; starting the api"
    docker start $P-api >/dev/null
    "$0" pg-counts
    ;;
  dump-staging)
    T=$(date -u +%Y%m%dT%H%M%SZ); name=staging-$T.dump
    mkdir -p "$D/pg/dump" && chmod 700 "$D/pg/dump"
    # The container runs as the caller, not root, so the file is ours to chmod and rm; umask 077 makes it 600
    # from the first byte. stderr goes to a file (it may name the host); only the exit code and a host-masked
    # excerpt are shown. The name and time travel as variables, never through the quoting.
    docker run --rm --name $P-pgdump --user "$(id -u):$(id -g)" -e HOME=/tmp -e NAME="$name" -e T="$T" \
      --env-file $D/env/pg-source.env -v $D/pg/dump:/dump $PG_IMG sh -c '
      umask 077
      pg_dump -Fc --no-owner --no-privileges -d "$PGURL" -f "/dump/$NAME" 2>"/dump/pg_dump-$T.err"; echo "pg_dump exit $?"
      sed -E "s/[A-Za-z0-9-]+\.oregon-postgres\.render\.com/<host>/g; s/dpg-[a-z0-9-]+/<id>/g; s#postgres(ql)?://[^ ]+#<url>#g" "/dump/pg_dump-$T.err" | head -3'
    if [ -s "$D/pg/dump/$name" ]; then chmod 600 "$D/pg/dump/$name"; ls -la "$D/pg/dump/$name"; else rm -f "$D/pg/dump/$name"; echo "no dump written"; fi
    ;;
  pg-counts)
    docker exec $P-pg psql -U draftroom -d draftroom -At -c \
      "select 'users='||(select count(*) from users)||' workspaces='||(select count(*) from workspaces)||' projects='||(select count(*) from projects)||' boards='||(select count(*) from boards)||' workspace_members='||(select count(*) from workspace_members)||' board_members='||(select count(*) from board_members)||' migrations='||(select count(*) from schema_migrations)" 2>&1
    ;;
  rooms)
    n=$(ls $D/data/sync/rooms/*.sqlite 2>/dev/null | wc -l | tr -d ' ')
    echo "board files: $n, $(du -sh $D/data/sync/rooms 2>/dev/null | cut -f1 || echo 0)"
    ;;
  *) echo "unknown command $cmd" >&2; sed -n '5,13p' "$0" >&2; exit 2 ;;
esac
