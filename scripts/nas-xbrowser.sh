#!/usr/bin/env bash
# The browser suite in Firefox and WebKit (and chromium, the control) on the NAS: Windows Smart App Control on the
# development PC blocks Playwright's bundled Firefox (`spawn UNKNOWN`, SideBySide event 33, mozglue), so a Firefox
# result needs Linux. Everything runs in throwaway containers of the official Playwright image whose version is the
# commit's exact @playwright/test pin (mcr.microsoft.com/playwright:v<ver>-noble: the browsers and their system
# libraries built in). The stack is the e2e suite's own (api with PGlite, sync, the preview worker, vite preview with
# dev auth, all on 127.0.0.1 inside one container with --network none: nothing is published, nothing leaves).
#
#   DRY_RUN=1 (the default): every SSH/Docker command is printed, nothing touches the NAS.
#   DRY_RUN=0: under the standing NAS approval for throwaway draftroom-load-* names.
# Usage: DRY_RUN=0 bash scripts/nas-xbrowser.sh <commit> [--browsers firefox,webkit] [--specs "a.spec.ts b.spec.ts"]
#                                                [--grep <re>] [--repeat-each N] [--keep] [--reuse <run-id>]
#        DRY_RUN=0 bash scripts/nas-xbrowser.sh --remove <run-id>  (what a --keep run left: under the NAS lock, and
#                                                                  never while that run is live)
#   --specs  spec files under e2e/excalidraw (default: CORE_SPECS below, a normal user's path);
#   --browsers  any of chromium, firefox, webkit (default firefox,webkit); E2E_XBROWSER_ALL=1 lets the webkit and
#            firefox projects run any named spec (playwright.config.ts), not only the smoke;
#   --reuse  a run that --keep left: its folder (source, install, ffmpeg) is used again, no new archive or install;
#            the commit must be the one that run archived.
#
# Run ids, the lock and the cleanup are those of scripts/nas-pg-api.sh (wave V: two runs removed each other's
# containers): an id is r-<14 digits>-<4-16 of a-z0-9>; every name a run makes carries it (the containers
# draftroom-load-ff-<run>-install and draftroom-load-ff-<run>-test, the folder /volume3/Apps/draftroom-load-ff-runs/<run>);
# a run takes the lock `mkdir /volume3/Apps/draftroom-load-ff-runs/lock` (atomic, "<run> <epoch>", refreshed at every
# step) before it makes anything, and STOPS touching nothing while another run holds it; a lock older than
# LOCK_STALE_S (default 6 h) whose run has no container left is taken over; the cleanup removes only this run's names
# and releases the lock only while this invocation holds it; --remove takes the same lock.
#
# What it does: preflight (df, MemAvailable; a STOP here leaves everything as it is), the lock, the commit's tracked
# source (git archive; refused if it would hold .env*, .data, node_modules or test-results) into the run's folder, one
# install container (the only one with network: the default bridge) that downloads Ubuntu's own ffmpeg packages
# (apt-get --download-only, for the preview worker and `pnpm fixtures`) and runs `pnpm install --frozen-lockfile`, then
# one test container (--network none, capped CPU and memory) that installs those packages offline, generates the
# synthetic fixtures and runs Playwright as the NAS user. The folder is capped (MAX_FOLDER_GB) after each step. The
# Playwright image is pulled only if absent and then removed by this run's cleanup only if this run pulled it and no
# container uses it (KEEP_IMAGE=1 keeps it). Never `prune`, `rm $(docker ps -aq)`, a Docker restart, or anything that is
# not this run's draftroom-load-ff-* name. Evidence (the list output, the JSON report, each failure's error-context.md)
# goes to $EVIDENCE_DIR on the workstation; traces stay in the folder of a --keep run.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.10.1}"
NAS_USER="${NAS_USER:-chase}"
NAS_KEY="${NAS_KEY:-$HOME/.ssh/ugreen_nas}"
DRY_RUN="${DRY_RUN:-1}"
RUNS=/volume3/Apps/draftroom-load-ff-runs
LOCK="$RUNS/lock"
LOCK_STALE_S="${LOCK_STALE_S:-21600}"
PNPM_VERSION=10.34.5
MIN_FREE_GB=20
MIN_AVAIL_MB=3072
MAX_FOLDER_GB="${MAX_FOLDER_GB:-8}"
KEEP_IMAGE="${KEEP_IMAGE:-0}"
EVIDENCE_DIR="${EVIDENCE_DIR:-${TMPDIR:-/tmp}/nas-xbrowser-evidence}"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/nas-xbrowser-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

# A normal user's path (the cross-browser task, 2026-10-19): sign-in and the dashboard, a board, notes/shapes/arrows/
# text, selection and undo, copy and paste, comments, two users live, share and a guest link, present, export, doc
# cards, a guest's poll on a phone, the Elements panel, a file drop with its preview.
CORE_SPECS="xbrowser-smoke.spec.ts dashboard.spec.ts k4-dashboard.spec.ts board-canvas.spec.ts k2-text-tool.spec.ts
k2-shape-fill.spec.ts board-drag-arrows.spec.ts canvas-ux-tools.spec.ts gaps-input-select.spec.ts
history-selection.spec.ts navigation-paste.spec.ts canvas-ux-duplicate.spec.ts comments-core.spec.ts
board-presence.spec.ts people-follow.spec.ts sharing-share-dialog.spec.ts guests-join.spec.ts guests-sharing.spec.ts
present-export-present.spec.ts present-export-files.spec.ts w1-doc-cards.spec.ts v1-poll.spec.ts
q3-elements-insert.spec.ts q3-elements-phone.spec.ts media-drops.spec.ts"

usage='usage: nas-xbrowser.sh <commit> [--browsers b,..] [--specs "..."] [--grep re] [--repeat-each N] [--keep] [--reuse <run-id>] | --remove <run-id>'
REMOVE=
if [[ "${1:-}" == --remove ]]; then
  REMOVE="${2:?$usage}"
  SHA=
else
  SHA="${1:?$usage}"
  shift
fi
BROWSERS=firefox,webkit
SPECS="$CORE_SPECS"
GREP=
REPEAT=1
KEEP=0
REUSE=
if [[ -z "$REMOVE" ]]; then
  while (($#)); do
    case "$1" in
      --browsers) BROWSERS="$2"; shift ;;
      --specs) SPECS="$2"; shift ;;
      --grep) GREP="$2"; shift ;;
      --repeat-each) REPEAT="$2"; shift ;;
      --keep) KEEP=1 ;;
      --reuse) REUSE="$2"; shift ;;
      *) log "unknown option $1"; exit 2 ;;
    esac
    shift
  done
fi
[[ "$REPEAT" =~ ^[0-9]{1,2}$ ]] && ((REPEAT >= 1)) || { log "--repeat-each takes 1-99"; exit 2; }
[[ "$BROWSERS" =~ ^(chromium|firefox|webkit)(,(chromium|firefox|webkit))*$ ]] || { log "--browsers takes chromium,firefox,webkit"; exit 2; }
SPECS="$(tr '\n' ' ' <<<"$SPECS")"
for f in $SPECS; do
  [[ "$f" =~ ^[a-z0-9][a-z0-9.-]*\.spec\.ts$ ]] || { log "--specs takes spec file names under e2e/excalidraw: $f"; exit 2; }
done
# the grep goes into the run script through printf %q (any characters are safe), one line
[[ "$GREP" != *$'\n'* ]] || { log "--grep takes one line"; exit 2; }

RUN_ID_RE='^r-[0-9]{14}-[a-z0-9]{4,16}$'
new_run_id() { printf 'r-%s-%s%04d' "$(date -u +%Y%m%d%H%M%S)" "$$" "$((RANDOM % 10000))"; }
if [[ -n "$REUSE" ]]; then RUN="$REUSE"; else RUN="${REMOVE:-${RUN_ID:-$(new_run_id)}}"; fi
[[ "$RUN" =~ $RUN_ID_RE ]] || { log "a run id is r-<14 digits>-<4-16 of a-z0-9>: $RUN"; exit 2; }
S="$RUNS/$RUN"
C_INSTALL="draftroom-load-ff-$RUN-install"
C_TEST="draftroom-load-ff-$RUN-test"
# who holds the NAS lock for this invocation: the run itself, or for --remove the remover (its own id)
HOLDER="$RUN"
[[ -z "$REMOVE" ]] || HOLDER="$(new_run_id)"

nas() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] ssh %s@%s -- %s\n' "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=60 "$NAS_USER@$NAS_HOST" "$*"
}
nas_stdin() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] <stdin> | ssh %s@%s -- %s\n' "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    cat >/dev/null
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$*"
}
# a name this run may remove: exactly one of the two container names this run's id gives, nothing else
is_run_name() { [[ "$1" == "$C_INSTALL" || "$1" == "$C_TEST" ]]; }
list_ff() {
  nas "docker ps -a --filter name=^draftroom-load-ff --format '{{.Names}}\t{{.Status}}'; echo '--- runs'; ls -1 $RUNS 2>/dev/null; cat $LOCK/owner 2>/dev/null || true"
}
remove_container() {
  local name="$1" listed
  is_run_name "$name" || { log "REFUSED: $name is not this run's ($RUN) draftroom-load-ff name"; return 1; }
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker rm -f $name"; return 0; fi
  listed="$(nas "docker ps -a --filter name=^draftroom-load-ff --format '{{.Names}}'")"
  if grep -qx -- "$name" <<<"$listed"; then nas "docker rm -f $name" >/dev/null && log "removed container $name"
  else log "container $name not present"; fi
}
lock_touch() {
  nas "if [ \"\$(cut -d' ' -f1 $LOCK/owner 2>/dev/null)\" = '$HOLDER' ]; then echo '$HOLDER '\$(date +%s) > $LOCK/owner; fi" || true
}
lock_release() {
  nas "if [ \"\$(cut -d' ' -f1 $LOCK/owner 2>/dev/null)\" = '$HOLDER' ]; then rm -rf -- $LOCK && echo 'lock released'; fi" | tee -a "$LOG" || true
}
lock_try() {
  nas "mkdir -p $RUNS && if mkdir $LOCK 2>/dev/null; then echo '$HOLDER '\$(date +%s) > $LOCK/owner && echo acquired; else cat $LOCK/owner 2>/dev/null || echo 'unknown 0'; fi" | tail -1
}
acquire_lock() {
  local got holder since age alive
  got="$(lock_try)"
  [[ "$got" == acquired ]] && return 0
  holder="${got%% *}"
  since="${got##* }"
  [[ "$holder" =~ ^[a-z0-9-]{1,80}$ ]] || holder=unknown
  [[ "$since" =~ ^[0-9]+$ ]] || since=0
  age=$(( $(date +%s) - since ))
  if [[ -n "$REMOVE" && "$holder" == "$RUN" ]]; then
    alive="$(nas "docker ps --filter name=^$C_TEST\$ --filter status=running --format '{{.Names}}'" | grep -x -- "$C_TEST" || true)"
  else
    alive="$(nas "docker ps -a --filter name=^draftroom-load-ff-$holder --format '{{.Names}}'" | grep -E "^draftroom-load-ff-$holder(-|$)" || true)"
  fi
  if (( age > LOCK_STALE_S )) && [[ -z "$alive" ]]; then
    log "the lock of run $holder is stale (${age} s, not alive): taking it over"
    nas "o=\$(cat $LOCK/owner 2>/dev/null || echo 'unknown 0'); if [ \"\$o\" = '$got' ]; then rm -rf -- $LOCK; fi"
    got="$(lock_try)"
    [[ "$got" == acquired ]] && return 0
  fi
  trap - EXIT
  if [[ -n "$REMOVE" && "$holder" == "$RUN" ]]; then
    log "STOP: run $RUN is live: it holds the NAS lock (${age} s old); --remove waits for it to end"
  else
    log "STOP: another run holds the NAS lock: ${got} (${age} s old; containers: ${alive:-none})"
  fi
  exit 1
}
# the image, when this run pulled it (a marker in the run's folder), goes only if no container (any name) uses it
remove_pulled_image() {
  local img
  img="$(nas "cat $S/pulled-image 2>/dev/null || true" | tail -1)"
  [[ -n "$img" ]] || return 0
  [[ "$img" =~ ^mcr\.microsoft\.com/playwright:v[0-9]+\.[0-9]+\.[0-9]+-noble$ ]] || { log "REFUSED: odd image marker $img"; return 0; }
  if [[ "$KEEP_IMAGE" == 1 ]]; then log "KEEP_IMAGE=1: $img stays"; return 0; fi
  if [[ -n "$(nas "docker ps -a --filter ancestor=$img --format '{{.Names}}'")" ]]; then
    log "$img is used by a container: it stays"
    return 0
  fi
  nas "docker image rm $img" >/dev/null && log "removed image $img (this run pulled it)"
}
cleanup() {
  log "cleanup of run $RUN: before"
  list_ff | tee -a "$LOG" || true
  for c in "$C_TEST" "$C_INSTALL"; do remove_container "$c" || true; done
  remove_pulled_image || true
  # the run's own folder only (its name is this run's id, under the runs folder). Files the root half of the test
  # container wrote (none expected: it drops to the NAS user before anything runs) would be removed the same way.
  nas "if [ -d $S ]; then rm -rf -- $S; fi; test ! -e $S && echo 'folder removed'" | tee -a "$LOG" || true
  lock_release
  log "cleanup of run $RUN: after"
  list_ff | tee -a "$LOG" || true
}
folder_cap() {
  local gb
  [[ "$DRY_RUN" == "0" ]] || { nas "du -sk $S"; return 0; }
  gb="$(nas "du -sk $S | awk '{print int(\$1/1048576)}'" | tail -1)"
  log "run folder: ${gb} GB (cap ${MAX_FOLDER_GB} GB)"
  [[ "$gb" =~ ^[0-9]+$ ]] && (( gb < MAX_FOLDER_GB )) || { log "STOP: the run folder is over its cap"; exit 1; }
}

if [[ -n "$REMOVE" ]]; then
  log "removing what run $RUN left (DRY_RUN=$DRY_RUN; the lock as $HOLDER)"
  if [[ "$DRY_RUN" == "0" ]]; then acquire_lock; else lock_try >/dev/null; fi
  trap lock_release EXIT
  cleanup
  trap - EXIT
  exit 0
fi

# 1. preflight (nothing armed yet: a STOP here leaves everything as it is)
trap - EXIT
log "preflight of run $RUN (DRY_RUN=$DRY_RUN) -> $LOG"
nas "df -h /volume3" | tee -a "$LOG"
free_gb="$(nas "df -Pk /volume3 | awk 'NR==2 {print int(\$4/1048576)}'" | tail -1)"
avail_mb="$(nas "awk '/^MemAvailable:/ {print int(\$2/1024)}' /proc/meminfo" | tail -1)"
log "free on /volume3: ${free_gb} GB; memory available: ${avail_mb} MB"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$free_gb" =~ ^[0-9]+$ ]] && (( free_gb >= MIN_FREE_GB )) || { log "STOP: less than ${MIN_FREE_GB} GB free"; exit 1; }
  [[ "$avail_mb" =~ ^[0-9]+$ ]] && (( avail_mb >= MIN_AVAIL_MB )) || { log "STOP: less than ${MIN_AVAIL_MB} MB available"; exit 1; }
fi

# 2. the lock
if [[ "$DRY_RUN" == "0" ]]; then
  acquire_lock
  log "lock taken by run $RUN"
else
  lock_try >/dev/null
fi
if ((KEEP)); then trap 'lock_release; log "--keep: run $RUN stays; remove it with: DRY_RUN=0 bash scripts/nas-xbrowser.sh --remove $RUN"' EXIT
else trap cleanup EXIT; fi
U="$(if [[ "$DRY_RUN" != "0" ]]; then echo '<uid>:<gid>'; else nas 'echo "$(id -u):$(id -g)"'; fi)"

# 3. the commit, its Playwright pin, its tracked source
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$REPO" rev-parse "${SHA}^{commit}")"
PW="$(git -C "$REPO" show "$sha:pnpm-workspace.yaml" | sed -n "s/^  '@playwright\/test': *\([0-9.]*\) *$/\1/p" | head -1)"
[[ "$PW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "STOP: no exact @playwright/test pin in the commit's catalog"; exit 1; }
IMG="mcr.microsoft.com/playwright:v$PW-noble"
log "commit $sha, @playwright/test $PW, image $IMG"
if [[ -n "$REUSE" ]]; then
  had="$(nas "cat $S/src/.xb-commit 2>/dev/null || true" | tail -1)"
  [[ "$DRY_RUN" != "0" || "$had" == "$sha" ]] || { trap - EXIT; lock_release; log "STOP: run $RUN archived ${had:-nothing}, not $sha"; exit 1; }
  log "reusing the folder of run $RUN"
else
  PATHS=(package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version tsconfig.base.json render.yaml apps packages e2e scripts)
  git -C "$REPO" cat-file -e "${sha}:patches" 2>/dev/null && PATHS+=(patches)
  listing="$(git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | tar -t)"
  if grep -nE '(^|/)(\.env[^/]*|\.data|node_modules|test-results)(/|$)' <<<"$listing"; then
    log "REFUSED: the archive would contain a forbidden path (above)"; exit 1
  fi
  log "archive of $sha: $(wc -l <<<"$listing") entries"
  nas "mkdir -p $S/src $S/reports"
  git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | nas_stdin "tar -x -C $S/src"
  nas "echo $sha > $S/src/.xb-commit"
  lock_touch

  # 4. the image (pulled only if absent; the marker says this run pulled it)
  nas "docker image inspect '$IMG' >/dev/null 2>&1 || { docker pull '$IMG' >/dev/null && echo '$IMG' > $S/pulled-image && echo 'pulled $IMG'; }"

  # 5. the install (the only container with network): Ubuntu's ffmpeg packages, downloaded only; pnpm into the folder;
  #    the workspace install. Root only for apt; pnpm and the install run as the NAS user (files root writes onto the
  #    share's ACLs come out mode 000 for everyone else: the first run's node_modules could not be read).
  {
    echo '#!/bin/bash'
    echo 'set -euo pipefail'
    echo 'mkdir -p /app/.debs/partial'
    echo 'apt-get update -qq'
    echo 'apt-get install -y -qq --download-only --no-install-recommends -o Dir::Cache::archives=/app/.debs ffmpeg >/dev/null'
    echo 'rm -rf /app/.debs/partial /app/.debs/lock'
    printf 'chown -R %q /app/.debs && chmod -R u+rwX,go+rX /app/.debs\n' "$U"
    echo 'echo "debs: $(ls /app/.debs | wc -l)"'
    printf 'exec setpriv --reuid=%q --regid=%q --clear-groups env HOME=/app/.home bash -c %q\n' "${U%%:*}" "${U##*:}" \
      "set -euo pipefail; mkdir -p /app/.home /app/.tools; npm install -g --prefix /app/.tools --no-fund --no-audit pnpm@$PNPM_VERSION >/dev/null; /app/.tools/bin/pnpm install --frozen-lockfile --store-dir /app/.pnpm-store --reporter=append-only 2>&1 | tail -4"
  } >"$EVIDENCE_DIR/xb-install-$RUN.sh"
  nas_stdin "cat > $S/src/.xb-install.sh" <"$EVIDENCE_DIR/xb-install-$RUN.sh"
  nas "docker run --rm --name $C_INSTALL --cpus=4 --memory=3g -e CI=true -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 -v $S/src:/app -w /app '$IMG' bash /app/.xb-install.sh" | tail -8 | tee -a "$LOG"
  lock_touch
fi
folder_cap

# 6. the run: --network none (loopback only), the packages installed offline, then the NAS user runs the fixtures and
#    Playwright. E2E_XBROWSER_ALL lets the webkit/firefox projects take the named specs.
#    Two small scripts go into the folder (no argument crosses a shell unquoted: printf %q).
PW_ARGS=()
for b in ${BROWSERS//,/ }; do PW_ARGS+=("--project=$b"); done
for f in $SPECS; do PW_ARGS+=("excalidraw/$f"); done
[[ -z "$GREP" ]] || PW_ARGS+=(--grep "$GREP")
PW_ARGS+=("--repeat-each=$REPEAT" --reporter=list,json)
{
  echo '#!/bin/bash'
  echo 'set -euo pipefail'
  echo 'dpkg -i /app/.debs/*.deb >/tmp/dpkg.log 2>&1 || { tail -20 /tmp/dpkg.log; exit 1; }'
  echo 'ffprobe -version | head -1'
  printf 'exec setpriv --reuid=%q --regid=%q --clear-groups env HOME=/app/.home PATH=/app/.tools/bin:$PATH E2E_XBROWSER_ALL=1 NODE_OPTIONS=--max-old-space-size=2560 bash /app/.xb-inner.sh\n' "${U%%:*}" "${U##*:}"
} >"$EVIDENCE_DIR/xb-outer-$RUN.sh"
{
  echo '#!/bin/bash'
  echo 'set -euo pipefail'
  echo 'cd /app && pnpm fixtures >/app/.reports-fixtures.log 2>&1 || { tail -20 /app/.reports-fixtures.log; exit 1; }'
  echo 'cd /app/e2e && rm -rf test-results'
  printf 'PLAYWRIGHT_JSON_OUTPUT_NAME=/app/.reports-pw.json exec node_modules/.bin/playwright test'
  printf ' %q' "${PW_ARGS[@]}"
  echo
} >"$EVIDENCE_DIR/xb-inner-$RUN.sh"
nas_stdin "cat > $S/src/.xb-outer.sh" <"$EVIDENCE_DIR/xb-outer-$RUN.sh"
nas_stdin "cat > $S/src/.xb-inner.sh" <"$EVIDENCE_DIR/xb-inner-$RUN.sh"
log "playwright: ${PW_ARGS[*]}"
lock_touch
code=0
nas "docker run --rm --name $C_TEST --network none --cpus=6 --memory=3g --memory-swap=6g --shm-size=1g -v $S/src:/app -w /app '$IMG' bash /app/.xb-outer.sh" \
  >"$EVIDENCE_DIR/playwright-$RUN.log" 2>&1 || code=$?
lock_touch
if [[ "$DRY_RUN" == "0" ]]; then
  nas "cat $S/src/.reports-pw.json" >"$EVIDENCE_DIR/playwright-$RUN.json" 2>/dev/null || true
  nas "tail -5 $S/src/.reports-fixtures.log" >>"$LOG" 2>/dev/null || true
  # each failure's error-context.md (small), under its test folder's name
  nas "cd $S/src/e2e/test-results 2>/dev/null && find . -name error-context.md | head -200 | tar -cf - -T - 2>/dev/null" \
    >"$EVIDENCE_DIR/error-context-$RUN.tar" 2>/dev/null || true
fi
sed 's/\x1b\[[0-9;]*m//g' "$EVIDENCE_DIR/playwright-$RUN.log" | grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)' | tee -a "$LOG" || true
folder_cap || true
log "playwright exit $code (run $RUN); evidence in $EVIDENCE_DIR"
exit "$code"
