# Draftroom progress log

Plan: `docs/Miro_Clone_Build_Plan.md` · Handoff: `docs/Cursor_Start_Here.md` · Contracts: `docs/M0-CONTRACTS.md` · Evidence: `docs/FEASIBILITY.md` · Verified engine facts: `docs/research/SYNTHESIS.md`

## Current milestone: 0 — engine feasibility

Status: in progress (kickoff 2026-09-26)

| Gate | Status | Evidence |
|---|---|---|
| Versions verified and pinned | done | `pnpm-workspace.yaml` catalog; `docs/research/SYNTHESIS.md` §2 |
| Two sessions see each other and their edits | baseline passing; full suite in progress | `e2e/tests/m0.spec.ts` |
| Reload preserves content | baseline passing | `e2e/tests/m0.spec.ts` |
| Killed/restarted server preserves acknowledged changes | baseline passing (browser); protocol suite in progress | `e2e/tests/m0.spec.ts`; research kill tests (0 acked-but-missing) |
| Network interruption + reconnect does not restore an old board | baseline passing | `e2e/tests/m0.spec.ts` |
| Same-note typing, edit/delete, undo-after-remote documented | behavior characterized; lease in progress | `docs/research/conflict-semantics.md`, SYNTHESIS §8 |
| Custom file-card shape with shared schema + migration | done (unit + e2e) | `packages/canvas-schema`, `apps/web/src/schema.test.ts` |
| Image / multipage PDF / MP4 preview path | prototype verified; worker in progress | `docs/research/file-previews.md` |
| Engine recommendation | pending | |

## Log

### 2026-09-26
- Repository created; plan documents copied to `docs/`. Repo rules in `AGENTS.md` (read by Cursor and, via `CLAUDE.md`, by Claude Code).
- Toolchain: Node 24.19.0 LTS (winget), pnpm 10.34.5, git 2.55, ffmpeg 9.0.1. Python not installed.
- tldraw / @tldraw/sync / @tldraw/sync-core latest = **5.4.2** — newer than model training data, so every API was verified from the published packages (six research reports + a critic synthesis in `docs/research/`).
- Hazards found in the research and fixed in our wiring (all in the official example pattern):
  1. `SQLiteSyncStorage`'s throttled tombstone prune crashes the process if the DB closes within 1 s of a delete → `pruneTombstones.flush()` before `db.close()`.
  2. Passing the raw `ws` to `handleSocketConnect` lets a stale socket's late `close` kill the reconnected session → wrapper without `addEventListener` + current-socket guard.
  3. Mixed-case board ids open two rooms on one SQLite file on case-insensitive filesystems (Windows/macOS) → lowercase-only ids.
  4. `new SQLiteSyncStorage({ snapshot })` on an existing DB wipes it → never pass `snapshot` to an initialized DB.
- Durability facts: each push commits in one synchronous SQLite transaction before `push_result`/broadcast; the library sets no pragmas, so we set WAL + `synchronous=FULL` + `busy_timeout`.
- Conflict semantics (documented, SYNTHESIS §8): per-prop last-writer-wins; same-note typing replaces the whole rich-text doc (characters lost when edits cross) → server-enforced text lease; delete beats edit; undo writes back the whole earlier record (can revert others' props / resurrect deleted shapes).
- License: dev on localhost is free (watermark). Any HTTPS production host without a domain-matching key blanks the editor after 5 s; price is quote-only (open question for tldraw sales; see `docs/research/license.md` §10).
- Workspace scaffolded from the verified skeleton; baseline two-browser e2e (edits, presence, reload, SIGKILL/restart, offline reconnect) passing through the same-origin Vite proxy.
- Milestone-0 build started with parallel owners (sync, web, worker, protocol tests) against `docs/M0-CONTRACTS.md`, followed by an integration/e2e pass.
