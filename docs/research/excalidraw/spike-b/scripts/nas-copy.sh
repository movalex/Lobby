#!/usr/bin/env bash
# B9: the source the two processes and the install need, from ONE commit, unpacked on the NAS over SSH
# (§8.3 B9, §8.6.6). `git archive` holds tracked files only, so never .env*, .data, node_modules or the
# restored staging boards; the listing is checked anyway and the copy refused if any such path appears.
# The target src/ must be empty (a fresh session).
# Usage: DRY_RUN=0 bash nas-copy.sh <commit>
source "$(dirname "$0")/nas-lib.sh"
sha="${1:?usage: nas-copy.sh <commit>}"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
git -C "$REPO" cat-file -e "${sha}^{commit}"
sha="$(git -C "$REPO" rev-parse "$sha")"
PATHS=(package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version apps packages e2e)

listing="$(git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | tar -t)"
if grep -nE '(^|/)(\.env[^/]*|\.data|node_modules|test-results)(/|$)|spike-b8|dr-restore-drill' <<<"$listing"; then
  log "REFUSED: the archive would contain a forbidden path (above)"; exit 1
fi
bytes="$(git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | wc -c | tr -d ' ')"
log "archive of $sha: $(wc -l <<<"$listing") entries, $((bytes / 1048576)) MB"

nas "mkdir -p $S/src $S/data $S/reports && test -z \"\$(ls -A $S/src)\""
git -C "$REPO" archive --format=tar "$sha" -- "${PATHS[@]}" | nas_stdin "tar -x -C $S/src"
nas "echo $sha > $S/src/.spike-commit && du -sm $S | cut -f1"
log "copied $sha to $S/src"
