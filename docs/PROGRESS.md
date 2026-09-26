# Draftroom progress log

Plan: `docs/Miro_Clone_Build_Plan.md` · Handoff: `docs/Cursor_Start_Here.md` · Evidence: `docs/FEASIBILITY.md`

## Current milestone: 0 — engine feasibility

Status: in progress (kickoff 2026-09-26)

| Gate | Status | Evidence |
|---|---|---|
| Versions verified and pinned | pending | |
| Two sessions see each other and their edits | pending | |
| Reload preserves content | pending | |
| Killed/restarted server preserves acknowledged changes | pending | |
| Network interruption + reconnect does not restore an old board | pending | |
| Same-note typing, edit/delete, undo-after-remote documented | pending | |
| Custom file-card shape with shared schema + migration | pending | |
| Image / multipage PDF / MP4 preview path | pending | |
| Engine recommendation | pending | |

## Log

### 2026-09-26
- Repository created; plan documents copied to `docs/`.
- Toolchain: Node 24.19.0 LTS (winget), pnpm 10.34.5, git 2.55, ffmpeg 9.0.1. Python not installed.
- npm registry check: tldraw / @tldraw/sync / @tldraw/sync-core latest = 5.4.2 (newer than model training data; APIs verified from published packages, see `docs/research/`).
