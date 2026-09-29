#!/usr/bin/env bash
# B9 cleanup (§8.6.6 "List by name before removing", "Removed afterwards"): list our containers and
# networks by name, remove only draftroom-spike-* names from that listing, one by one, then the folder
# /volume3/Apps/draftroom-spike (this exact path), then list again and read df. No image is removed (none
# was built; the pinned Node image is the base of Draftroom's own images). Never `docker system prune`,
# `image prune`, `rm $(docker ps -aq)`, `compose down`, a Docker restart, or anything without a name.
# Usage: DRY_RUN=0 bash nas-cleanup.sh
source "$(dirname "$0")/nas-lib.sh"
log "cleanup (DRY_RUN=$DRY_RUN) -> $LOG"
log "before:"
list_spike | tee -a "$LOG"
for c in "$C_LOAD" "$C_SYNC" "$C_INSTALL" "$C_GEN" "$C_FSYNC" "$C_SECRETS"; do remove_container "$c"; done
remove_network "$NET"
nas "if [ -d $S ]; then rm -rf -- $S; fi; test ! -e $S && echo 'folder removed'"
log "after:"
list_spike | tee -a "$LOG"
nas "df -h /volume3" | tee -a "$LOG"
nas "docker image inspect '$IMG' --format 'image kept: {{.Id}}' 2>/dev/null || echo 'image absent'" | tee -a "$LOG"
