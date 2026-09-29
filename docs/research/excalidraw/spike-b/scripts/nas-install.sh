#!/usr/bin/env bash
# B9: the one-time dependency install (§8.6.6): pull the pinned image once if absent (it stays: it is the
# base of Draftroom's own images), then a throwaway container, the ONLY one with network access, installs
# the lockfile into src/ (store and home inside it) and exits. Then the 2,048 MB cap is checked.
# Usage: DRY_RUN=0 bash nas-install.sh
source "$(dirname "$0")/nas-lib.sh"
U="$(nas_uid | tail -1)"
nas "docker image inspect '$IMG' >/dev/null 2>&1 || docker pull '$IMG'"
log "install (the only container with network), as $U"
nas "docker run --rm --name $C_INSTALL --user $U -e HOME=/app/.home -e CI=true -v $S/src:/app -w /app '$IMG' npx --yes $PNPM install --frozen-lockfile --store-dir /app/.pnpm-store"
check_cap
