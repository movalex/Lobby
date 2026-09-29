#!/bin/sh
# Runs ON THE NAS during one B9 run (copied into the run folder by nas-run.sh and started with nohup):
# every 10 s one `docker stats` line of draftroom-spike-sync (CPU as % of its 0.5 CPU quota, memory MB),
# every 30 s `du -sm` of the run folder; one JSON line per sample into the run's host file, which the load
# generator reads into its report. Above the 2,048 MB cap it stops the run (load, then sync) and writes a
# STOP marker. It ends when the load container is no longer running. POSIX sh; names only draftroom-spike-*.
# Usage (by nas-run.sh): nohup sh sampler.sh <folder> <host-jsonl> <cap-mb> >/dev/null 2>&1 &
S="$1"
OUT="$2"
CAP="$3"
i=0
while docker ps --filter name=^draftroom-spike-load$ --filter status=running -q | grep -q .; do
  t=$(($(date +%s%N) / 1000000))
  line=$(docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' draftroom-spike-sync 2>/dev/null)
  cpu=$(echo "$line" | awk '{gsub("%","",$1); printf "%.1f", $1 / 0.5}')
  mem=$(echo "$line" | awk '{m=$2; v=m+0; if (m ~ /GiB/) v=v*1024; else if (m ~ /KiB/) v=v/1024; else if (m ~ /^[0-9.]+B$/) v=v/1048576; printf "%.1f", v}')
  folder=""
  if [ $((i % 3)) -eq 0 ]; then
    mb=$(du -sm "$S" 2>/dev/null | cut -f1)
    folder=",\"folderMB\":${mb:-0}"
    if [ "${mb:-0}" -gt "$CAP" ]; then
      echo "{\"at\":$t,\"stop\":\"folder over ${CAP} MB\"}" >> "$OUT"
      docker stop draftroom-spike-load >/dev/null 2>&1
      docker stop draftroom-spike-sync >/dev/null 2>&1
      echo "STOP folder ${mb} MB > ${CAP} MB" > "$S/reports/STOP"
      break
    fi
  fi
  if [ -n "$line" ]; then
    echo "{\"at\":$t,\"cpuPct\":${cpu:-0},\"memMB\":${mem:-0}${folder}}" >> "$OUT"
  fi
  i=$((i + 1))
  sleep 10
done
