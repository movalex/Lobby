#!/bin/sh
# Container entrypoint of the api and sync images (PID 1 until it execs tini). The worker image does not
# use it: it has no data directory and starts as `node` directly (docker/worker.Dockerfile).
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
  # tini becomes PID 1 as `node`, with the app as its direct child. Both run as the same user, so tini can
  # forward SIGTERM from `docker stop` / Render without CAP_KILL, which Render does not grant (a root tini
  # failed with "Unexpected error when forwarding signal: Operation not permitted" on every deploy).
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs env HOME=/home/node /usr/bin/tini -- "$@"
fi

exec /usr/bin/tini -- "$@"
