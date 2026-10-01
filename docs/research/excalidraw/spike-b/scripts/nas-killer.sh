#!/bin/sh
# Runs ON THE NAS during one L1 run (copied into the run folder by nas-run.sh and started with nohup): the
# SIGKILL of sync at minute 8 of the LOAD GENERATOR's run (§2.13 L1, §8.3 B9), then its restart. Minute 8
# counts from the generator's t0 file (written when the sessions' clock starts, after the boards were
# checked), not from when the containers started. It waits up to 10 min for that file, kills only while
# the load generator still runs, and writes the kill file: line 1 the epoch ms of `docker kill`, line 2
# when `docker start` returned (the load generator reads it into its report). Names only draftroom-spike-*.
# Usage (by nas-run.sh): nohup sh killer.sh <t0-file> <kill-file> [at-ms] >/dev/null 2>&1 &
T0F="$1"
KF="$2"
AT="${3:-480000}"
i=0
while [ ! -s "$T0F" ] && [ "$i" -lt 600 ]; do
  sleep 1
  i=$((i + 1))
done
[ -s "$T0F" ] || exit 0
t0=$(cat "$T0F")
w=$(((t0 + AT - $(date +%s%3N)) / 1000))
if [ "$w" -gt 0 ]; then sleep "$w"; fi
while [ "$(date +%s%3N)" -lt $((t0 + AT)) ]; do sleep 0.1; done
docker ps -q --filter 'name=^draftroom-spike-load$' --filter status=running | grep -q . || exit 0
date +%s%3N >"$KF"
docker kill --signal=KILL draftroom-spike-sync >/dev/null
docker start draftroom-spike-sync >/dev/null
date +%s%3N >>"$KF"
