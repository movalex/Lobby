#!/usr/bin/env bash
# B9 NAS preflight (§8.6.6 "Disk", "Limits", "List by name"): free disk on /volume3 (Docker's root is
# /volume3/@docker, the volume theaitre also uses), available memory, our own containers and networks by
# name, and whether the pinned image is present. Stops (exit 1) below 10 GB free or 3 GB available.
# Usage: DRY_RUN=0 bash nas-preflight.sh
source "$(dirname "$0")/nas-lib.sh"
log "preflight (DRY_RUN=$DRY_RUN) -> $LOG"

nas "df -h /volume3" | tee -a "$LOG"
free_gb="$(nas "df -Pk /volume3 | awk 'NR==2 {print int(\$4/1048576)}'" | tail -1)"
avail_mb="$(nas "awk '/^MemAvailable:/ {print int(\$2/1024)}' /proc/meminfo" | tail -1)"
log "free on /volume3: ${free_gb} GB (min ${MIN_FREE_GB}); memory available: ${avail_mb} MB (min ${MIN_AVAIL_MB})"
log "our containers and networks (by name):"
list_spike | tee -a "$LOG"
nas "docker image inspect '$IMG' --format '{{.Id}}' 2>/dev/null || echo 'image absent (nas-install.sh pulls it once)'" | tee -a "$LOG"

if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$free_gb" =~ ^[0-9]+$ ]] && (( free_gb >= MIN_FREE_GB )) || { log "STOP: less than ${MIN_FREE_GB} GB free on /volume3"; exit 1; }
  [[ "$avail_mb" =~ ^[0-9]+$ ]] && (( avail_mb >= MIN_AVAIL_MB )) || { log "STOP: less than ${MIN_AVAIL_MB} MB available"; exit 1; }
fi
log "preflight ok"
