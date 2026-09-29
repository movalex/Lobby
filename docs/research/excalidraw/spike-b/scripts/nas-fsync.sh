#!/usr/bin/env bash
# B9 "Disk: fsync p50/p99 on the NAS volume" (§8.3 B9, §2.13): a --network none container of the pinned image
# times 2,000 single-row SQLite commits with sync's pragmas (WAL, synchronous=FULL) and 2,000 raw 4 KiB
# write+fsync calls in the data folder, prints JSON, and removes its files.
# Usage: DRY_RUN=0 bash nas-fsync.sh [n]
source "$(dirname "$0")/nas-lib.sh"
N="${1:-2000}"
U="$(nas_uid | tail -1)"
mkdir -p "$EVIDENCE_DIR/b9"
nas "mkdir -p $S/data && docker run --rm --name $C_FSYNC --user $U --network none -v $S/src:/app:ro -v $S/data:/var/data -w /app '$IMG' node e2e/load/fsync-probe.ts --dir /var/data --n $N" | tee -a "$EVIDENCE_DIR/b9/fsync-$(date -u +%Y%m%dT%H%M%SZ).json"
