#!/usr/bin/env bash
# One whole B9 NAS session (§8.3 B9 "Runs on the NAS"): preflight, copy of one commit, install, the disk
# probe, L1 x3 (SIGKILL at minute 8), L2 x3, the conversion-under-load run, the presence-mode comparison,
# and the cleanup, which also runs if any step fails (trap). Evidence: $EVIDENCE_DIR (logs, reports).
# A run that fails is logged and its two containers are removed by name; the session goes on with the next
# run (a failed run is reported, never retried silently). The setup steps (preflight, copy, install) stop
# the session.
# Usage: DRY_RUN=0 bash nas-session.sh <commit> [--presence-env NAME=VALUE] [--overcap-notes N] [--only RUNS] [--normal]
#   --presence-env  for the comparison run; the shared-frame mode is O1's own branch forced by a preload:
#                   --presence-env NODE_OPTIONS=--import=/app/e2e/load/presence-shared-hook.ts
#   --only          a comma list of runs to do, of L1-r1..r3, L2-r1..r3, cul, presence, normal (default: all
#                   but normal)
#   --normal        also the owner's pre-approved fsync fallback comparison (§2.13 step 3, ONE L1 run with
#                   PRAGMA synchronous = NORMAL through e2e/load/sqlite-normal-hook.ts), only when the targets
#                   were missed with FULL; both are reported
#   --no-cleanup    keep the install (src/ and the network) for more runs; nas-cleanup.sh removes it later
source "$(dirname "$0")/nas-lib.sh"
D="$(dirname "$0")"
SHA="${1:?usage: nas-session.sh <commit> [--presence-env NAME=VALUE] [--overcap-notes N] [--only RUNS] [--normal]}"
shift
PRESENCE=()
OVERCAP=()
ONLY="L1-r1,L1-r2,L1-r3,L2-r1,L2-r2,L2-r3,cul,presence"
NORMAL=0
CLEANUP=1
while (($#)); do
  case "$1" in
    --presence-env) PRESENCE=(--env "$2"); shift ;;
    --overcap-notes) OVERCAP=(--overcap-notes "$2"); shift ;;
    --only) ONLY="$2"; shift ;;
    --normal) NORMAL=1 ;;
    --no-cleanup) CLEANUP=0 ;;
    *) log "unknown option $1"; exit 2 ;;
  esac
  shift
done
if ((CLEANUP)); then trap 'log "session ends: cleanup"; bash "$D/nas-cleanup.sh" || true' EXIT
else trap 'log "session ends: --no-cleanup, the install stays (run nas-cleanup.sh)"' EXIT; fi

FAILED=()
run_one() {
  local name="$1"
  shift
  [[ ",$ONLY," == *",$name,"* ]] || { log "skipped $name (--only)"; return 0; }
  log "=== run $name: nas-run.sh $*"
  if bash "$D/nas-run.sh" "$@"; then log "=== run $name done"; return 0; fi
  log "=== RUN FAILED: $name"
  FAILED+=("$name")
  remove_container "$C_LOAD" || true
  remove_container "$C_SYNC" || true
  nas "rm -f -- $S/run.env" || true
}

bash "$D/nas-preflight.sh"
bash "$D/nas-copy.sh" "$SHA"
bash "$D/nas-install.sh"
bash "$D/nas-fsync.sh" || log "fsync probe failed"
for r in 1 2 3; do run_one "L1-r$r" L1 "r$r"; done
for r in 1 2 3; do run_one "L2-r$r" L2 "r$r"; done
run_one cul L1 cul --cul "${OVERCAP[@]}"
if ((${#PRESENCE[@]})); then run_one presence L1 presence-alt "${PRESENCE[@]}"
else log "presence-mode comparison skipped: pass --presence-env"; fi
if ((NORMAL)); then
  [[ ",$ONLY," == *",normal,"* ]] || ONLY="$ONLY,normal"
  run_one normal L1 normal --env NODE_OPTIONS=--import=/app/e2e/load/sqlite-normal-hook.ts
fi
log "failed runs: ${FAILED[*]:-none}"
