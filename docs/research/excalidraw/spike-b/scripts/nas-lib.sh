#!/usr/bin/env bash
# Shared settings and guards of O3's NAS scripts for B9 (docs/EXCALIDRAW-MIGRATION.md §8.3 B9, §8.6.6).
# Sourced by every nas-*.sh. Runs on the WORKSTATION (Git Bash); every NAS step goes over SSH in batch mode
# with the existing key, as the docker-group user, Docker without sudo. Nothing is exposed: no port is
# published, sync and load run on an --internal network.
#
#   DRY_RUN=1 (the default in this phase): every SSH/Docker command is PRINTED, nothing touches the NAS.
#   DRY_RUN=0: the commands run. Only under the standing NAS approval for draftroom-* (Appendix B 3).
#
# Rules this file enforces (§8.6.6):
#  - names: every container, network and folder is draftroom-spike-*; removals go through remove_container /
#    remove_network, which refuse any other name and act only on names a fresh listing returned;
#  - one stock image by digest, never built, never removed;
#  - the folder /volume3/Apps/draftroom-spike (src/, data/, reports/), capped at 2,048 MB;
#  - df -h /volume3 before a session (stop below 10 GB free), 3 GB of available memory;
#  - no value from .env.deploy.local goes anywhere: the per-run secrets are generated ON the NAS inside
#    the folder's run.env by a --network none container, and are never printed.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.10.1}"
NAS_USER="${NAS_USER:-chase}"
NAS_KEY="${NAS_KEY:-$HOME/.ssh/ugreen_nas}"
DRY_RUN="${DRY_RUN:-1}"

S=/volume3/Apps/draftroom-spike
IMG='node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de'
NET=draftroom-spike-net
C_INSTALL=draftroom-spike-install
C_GEN=draftroom-spike-gen
C_FSYNC=draftroom-spike-fsync
C_SECRETS=draftroom-spike-secrets
C_SYNC=draftroom-spike-sync
C_LOAD=draftroom-spike-load
PNPM=pnpm@10.34.5
CAP_MB=2048
MIN_FREE_GB=10
MIN_AVAIL_MB=3072
# where the evidence of a session goes on the workstation (never into the repo unreviewed)
EVIDENCE_DIR="${EVIDENCE_DIR:-${TMPDIR:-/tmp}/o3-nas-evidence}"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/nas-$(date -u +%Y%m%dT%H%M%SZ).log"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

# ssh to the NAS. In DRY_RUN the command is printed to stderr and the log, exactly as the remote shell
# receives it (after "--"), and nothing goes to stdout, so captured values stay empty.
nas() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] ssh -i %s -o BatchMode=yes %s@%s -- %s\n' "$NAS_KEY" "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$*"
}

# ssh that reads stdin (tar, file copies)
nas_stdin() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] <stdin> | ssh -i %s -o BatchMode=yes %s@%s -- %s\n' "$NAS_KEY" "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    cat >/dev/null
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$*"
}

# the uid:gid every container runs as (the SSH user, so everything in $S is its own and rm needs no sudo)
nas_uid() {
  if [[ "$DRY_RUN" != "0" ]]; then echo '<uid>:<gid>'; return 0; fi
  nas 'echo "$(id -u):$(id -g)"'
}

is_spike_name() { [[ "$1" =~ ^draftroom-spike-[a-z0-9-]+$ ]]; }

# Lists our containers and networks BY NAME (never anything else).
list_spike() {
  nas "docker ps -a --filter name=^draftroom-spike- --format '{{.Names}}\t{{.Status}}'; echo '--- networks'; docker network ls --filter name=^draftroom-spike- --format '{{.Name}}'"
}

# Removes one container, only if its name is draftroom-spike-* AND a fresh listing has it.
remove_container() {
  local name="$1"
  is_spike_name "$name" || { log "REFUSED: $name is not a draftroom-spike-* name"; return 1; }
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker rm -f $name"; return 0; fi
  local listed
  listed="$(nas "docker ps -a --filter name=^draftroom-spike- --format '{{.Names}}'")"
  if grep -qx -- "$name" <<<"$listed"; then nas "docker rm -f $name" >/dev/null && log "removed container $name"
  else log "container $name not present"; fi
}

remove_network() {
  local name="$1"
  is_spike_name "$name" || { log "REFUSED: $name is not a draftroom-spike-* name"; return 1; }
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker network rm $name"; return 0; fi
  local listed
  listed="$(nas "docker network ls --filter name=^draftroom-spike- --format '{{.Name}}'")"
  if grep -qx -- "$name" <<<"$listed"; then nas "docker network rm $name" >/dev/null && log "removed network $name"
  else log "network $name not present"; fi
}

# du of the folder in MB (0 when absent); fails the session above the cap
folder_mb() {
  if [[ "$DRY_RUN" != "0" ]]; then nas "du -sm $S 2>/dev/null | cut -f1"; echo '<dry-run>'; return 0; fi
  nas "du -sm $S 2>/dev/null | cut -f1 || echo 0"
}
check_cap() {
  local mb
  mb="$(folder_mb | tail -1)"
  log "folder $S: ${mb} MB (cap ${CAP_MB} MB)"
  if [[ "$mb" =~ ^[0-9]+$ ]] && (( mb > CAP_MB )); then log "STOP: $S is over ${CAP_MB} MB"; return 1; fi
}
