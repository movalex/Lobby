#!/usr/bin/env bash
# One whole B9 NAS session (§8.3 B9 "Runs on the NAS"): preflight, copy of one commit, install, the disk
# probe, L1 x3 (SIGKILL at minute 8), L2 x3, the conversion-under-load run, the presence-mode comparison,
# and the cleanup, which also runs if any step fails (trap). Evidence: $EVIDENCE_DIR (logs, reports).
# Usage: DRY_RUN=0 bash nas-session.sh <commit> [--presence-env NAME=VALUE] [--overcap-notes N]
source "$(dirname "$0")/nas-lib.sh"
D="$(dirname "$0")"
SHA="${1:?usage: nas-session.sh <commit> [--presence-env NAME=VALUE] [--overcap-notes N]}"
shift
PRESENCE=()
OVERCAP=()
while (($#)); do
  case "$1" in
    --presence-env) PRESENCE=(--presence-env "$2"); shift ;;
    --overcap-notes) OVERCAP=(--overcap-notes "$2"); shift ;;
    *) log "unknown option $1"; exit 2 ;;
  esac
  shift
done
trap 'log "session ends: cleanup"; bash "$D/nas-cleanup.sh" || true' EXIT

bash "$D/nas-preflight.sh"
bash "$D/nas-copy.sh" "$SHA"
bash "$D/nas-install.sh"
bash "$D/nas-fsync.sh"
for r in 1 2 3; do bash "$D/nas-run.sh" L1 "r$r"; done
for r in 1 2 3; do bash "$D/nas-run.sh" L2 "r$r"; done
bash "$D/nas-run.sh" L1 cul --cul "${OVERCAP[@]}"
if ((${#PRESENCE[@]})); then bash "$D/nas-run.sh" L1 presence-alt "${PRESENCE[@]}"
else log "presence-mode comparison skipped: pass --presence-env with O1's switch (confirmed at M2)"; fi
