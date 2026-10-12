#!/usr/bin/env bash
# LINT on the NAS: `biome check .` on a commit's tracked source, in a throwaway Linux container. For a workstation
# where Windows Smart App Control blocks biome.exe (2026-10-12: "An Application Control policy has blocked this
# file"); the Linux binary from the same lockfile checks the same rules.
#
#   DRY_RUN=1 (the default): every SSH/Docker command is printed, nothing touches the NAS.
#   DRY_RUN=0: under the standing NAS approval for throwaway draftroom-* names.
# Usage: DRY_RUN=0 bash scripts/nas-lint.sh <commit> [--keep]
#
# The same shape as nas-pg-api.sh: preflight (df, nothing named draftroom-lint* yet), the commit's whole tracked
# tree (git archive; refused if it would hold .env*, .data, node_modules or test-results) into
# /volume3/Apps/draftroom-lint/src, one install container (the only one with network; the pnpm store outside the
# source, so biome never walks it) with the pinned Node image, then `biome check .` in a runner with
# --network none, and the cleanup by name (also on failure, unless --keep): containers, the folder. Never
# `prune`, `rm $(docker ps -aq)`, `compose down`, a Docker restart, or anything not named draftroom-lint*.
# Evidence (the biome output) goes to $EVIDENCE_DIR on the workstation; the exit code is biome's.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.10.1}"
NAS_USER="${NAS_USER:-chase}"
NAS_KEY="${NAS_KEY:-$HOME/.ssh/ugreen_nas}"
DRY_RUN="${DRY_RUN:-1}"
S=/volume3/Apps/draftroom-lint
C_INSTALL=draftroom-lint-install
C_RUN=draftroom-lint-run
IMG='node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de'
PNPM=pnpm@10.34.5
MIN_FREE_GB=10
EVIDENCE_DIR="${EVIDENCE_DIR:-${TMPDIR:-/tmp}/nas-lint-evidence}"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/nas-lint-$(date -u +%Y%m%dT%H%M%SZ).log"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

SHA="${1:?usage: nas-lint.sh <commit> [--keep]}"
shift
KEEP=0
while (($#)); do
  case "$1" in
    --keep) KEEP=1 ;;
    *) log "unknown option $1"; exit 2 ;;
  esac
  shift
done

nas() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] ssh %s@%s -- %s\n' "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$*"
}
nas_stdin() {
  if [[ "$DRY_RUN" != "0" ]]; then
    printf '[dry-run] <stdin> | ssh %s@%s -- %s\n' "$NAS_USER" "$NAS_HOST" "$*" | tee -a "$LOG" >&2
    cat >/dev/null
    return 0
  fi
  ssh -i "$NAS_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$*"
}
is_lint_name() { [[ "$1" =~ ^draftroom-lint(-[a-z0-9-]+)?$ ]]; }
list_lint() { nas "docker ps -a --filter name=^draftroom-lint --format '{{.Names}}\t{{.Status}}'"; }
remove_container() {
  local name="$1" listed
  is_lint_name "$name" || { log "REFUSED: $name is not a draftroom-lint name"; return 1; }
  if [[ "$DRY_RUN" != "0" ]]; then nas "docker rm -f $name"; return 0; fi
  listed="$(nas "docker ps -a --filter name=^draftroom-lint --format '{{.Names}}'")"
  if grep -qx -- "$name" <<<"$listed"; then nas "docker rm -f $name" >/dev/null && log "removed container $name"
  else log "container $name not present"; fi
}
cleanup() {
  log "cleanup: before"
  list_lint | tee -a "$LOG" || true
  for c in "$C_RUN" "$C_INSTALL"; do remove_container "$c" || true; done
  nas "if [ -d $S ]; then rm -rf -- $S; fi; test ! -e $S && echo 'folder removed'" | tee -a "$LOG" || true
  log "cleanup: after"
  list_lint | tee -a "$LOG" || true
}
if ((KEEP)); then trap 'log "--keep: run the script again without it, or remove draftroom-lint* by hand"' EXIT
else trap cleanup EXIT; fi

# 1. preflight
log "preflight (DRY_RUN=$DRY_RUN) -> $LOG"
free_gb="$(nas "df -Pk /volume3 | awk 'NR==2 {print int(\$4/1048576)}'" | tail -1)"
log "free on /volume3: ${free_gb} GB"
if [[ "$DRY_RUN" == "0" ]]; then
  [[ "$free_gb" =~ ^[0-9]+$ ]] && (( free_gb >= MIN_FREE_GB )) || { log "STOP: less than ${MIN_FREE_GB} GB free"; exit 1; }
  left="$(nas "docker ps -a --filter name=^draftroom-lint --format '{{.Names}}'; if test -e $S; then echo folder; fi")"
  [[ -z "$left" ]] || { trap - EXIT; log "STOP: draftroom-lint* already there (another run?): $left"; exit 1; }
fi
U="$(if [[ "$DRY_RUN" != "0" ]]; then echo '<uid>:<gid>'; else nas 'echo "$(id -u):$(id -g)"'; fi)"

# 2. the commit's whole tracked tree (biome reads .gitignore and biome.json at the root)
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$REPO" rev-parse "${SHA}^{commit}")"
listing="$(git -C "$REPO" archive --format=tar "$sha" | tar -t)"
if grep -nE '(^|/)(\.env|\.data|node_modules|test-results)(/|$)' <<<"$listing"; then
  log "REFUSED: the archive would contain a forbidden path (above)"; exit 1
fi
log "archive of $sha: $(wc -l <<<"$listing") entries"
nas "mkdir -p $S/src $S/store $S/home"
git -C "$REPO" archive --format=tar "$sha" | nas_stdin "tar -x -C $S/src"

# 3. the install (the only container with network), then biome with no network
nas "docker image inspect '$IMG' >/dev/null 2>&1 || docker pull '$IMG'"
nas "docker run --rm --name $C_INSTALL --user $U -e HOME=/home/lint -e CI=true -v $S/src:/app -v $S/store:/store -v $S/home:/home/lint -w /app '$IMG' npx --yes $PNPM install --frozen-lockfile --ignore-scripts --store-dir /store" | tail -3 | tee -a "$LOG"
code=0
nas "docker run --rm --name $C_RUN --user $U --network none --cpus=4 --memory=2g -e HOME=/home/lint -v $S/src:/app -v $S/home:/home/lint -w /app '$IMG' node_modules/.bin/biome check ." \
  >"$EVIDENCE_DIR/biome.log" 2>&1 || code=$?
tail -5 "$EVIDENCE_DIR/biome.log" | tee -a "$LOG"
log "biome exit $code; output in $EVIDENCE_DIR/biome.log"
exit "$code"
