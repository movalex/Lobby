#!/bin/sh
# Container entrypoint of the api and sync images (runs as tini's child). The worker image does not use
# it: it has no data directory and starts as `node` directly (docker/worker.Dockerfile).
#
# The image starts as root ONLY so this script can make DRAFTROOM_DATA_DIR writable, then it drops to
# the unprivileged `node` user before the application starts. Why: Render mounts persistent disks
# owned by root (reported by other Render users; UNVERIFIED by us, see docs/DEPLOY.md), and a root-owned
# mount would make the app fail with EACCES on first write.
set -eu

if [ "$(id -u)" = "0" ]; then
  dir="${DRAFTROOM_DATA_DIR:-}"
  if [ -n "$dir" ]; then
    mkdir -p -- "$dir"
    # Only the top directory is adjusted: everything below it is created by the app itself as `node`,
    # so a recursive chown (slow on a large disk) is never needed.
    if [ "$(stat -c %u -- "$dir")" != "$(id -u node)" ]; then
      chown node:node -- "$dir"
    fi
  fi
  # exec keeps the app as tini's direct child, so SIGTERM from `docker stop` / Render reaches it.
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs env HOME=/home/node "$@"
fi

exec "$@"
