# Draftroom progress log

Plan: `docs/Miro_Clone_Build_Plan.md` · Handoff: `docs/Cursor_Start_Here.md` · Contracts: `docs/M0-CONTRACTS.md` · Evidence: `docs/FEASIBILITY.md` · Verified engine facts: `docs/research/SYNTHESIS.md`

## Milestone 0 — engine feasibility: COMPLETE (2026-09-26)

Recommendation: engine suitable — proceed, conditional on the tldraw license quote (see docs/FEASIBILITY.md).

| Gate | Status | Evidence |
|---|---|---|
| Versions verified and pinned | done | pnpm-workspace.yaml catalog; docs/research/SYNTHESIS.md §2 |
| Two sessions see each other and their edits | done | e2e/tests/collab-lifecycle.spec.ts (1) |
| Reload preserves content | done | collab-lifecycle.spec.ts (2) |
| Killed/restarted server preserves acknowledged changes | done | collab-lifecycle.spec.ts (3); apps/sync/test/protocol/durability.test.ts (0 acked-but-missing, 3 rounds) |
| Network interruption + reconnect does not restore an old board | done | e2e/tests/network-interruption.spec.ts; protocol/reconnect.test.ts |
| Same-note typing, edit/delete, undo-after-remote documented | done — server-enforced text lease shipped; undo limitation pinned | e2e/tests/conflicts.spec.ts; protocol/text-lease.test.ts, conflicts.test.ts |
| Custom file-card shape with shared schema + migration | done | packages/canvas-schema; apps/web/src/schema.test.ts; protocol/schema.test.ts |
| Image / multipage PDF / MP4 preview path | done | e2e/tests/files.spec.ts (7); apps/worker/test/*; docs/screenshots |
| Engine recommendation | done | docs/FEASIBILITY.md |

Checks at completion: pnpm verify — lint 0 errors, typecheck 11 projects, vitest 183 passed / 1 skipped, Playwright 10/10 (3 consecutive runs).

## Milestone 1 — accounts, permissions, deployment foundation: COMPLETE locally (2026-09-26)

| Gate | Status | Evidence |
|---|---|---|
| Postgres schema + migrations | done (PGlite locally; pg driver smoke-tested against Postgres 18.6 on the NAS) | packages/db (0001_core, checksum-guarded runner) |
| Sign-in | dev provider done; Clerk adapter written, UNVERIFIED (no keys) | apps/api/src/auth |
| Workspaces, projects, boards, members, invitations | done | apps/api/test/* (tenancy, members, invitations) |
| Server-enforced roles (owner/editor/commenter/viewer) | done | packages/permissions; e2e permissions.spec.ts (forged writes never land) |
| Board tickets (60 s, board-specific) | done | packages/auth-tickets; apps/sync/test/protocol/auth.test.ts |
| Revocation / downgrade within 15 s | done — 65 ms via push; 9.5 s via periodic re-check alone | e2e permissions.spec.ts; protocol/access.test.ts |
| Dashboard (create/rename/archive/trash/restore/search) | done | e2e dashboard.spec.ts |
| Wrong-workspace access, forged read-only mutation | done | e2e permissions.spec.ts; apps/api/test/tenancy.test.ts |
| CI + Render/Docker config | written; Docker images built and smoke-run on the NAS; Render Blueprint schema-valid; not deployed | render.yaml, docker/, .github/workflows/ci.yml, docs/DEPLOY.md |

Checks at completion: pnpm verify — lint 0 errors, typecheck 13 projects, vitest 812 passed / 1 skipped, Playwright 14/14 (6 consecutive runs).

Before any staging deploy (needs your decisions/accounts): Clerk keys; a tldraw key listing the staging host; publishing the repo; WebSocket routing on Render (static sites cannot proxy WebSockets); internal-URL wiring and refusing loopback defaults in production; trustProxy; an api /healthz. See docs/DEPLOY.md.

## Current phase: Miro-style features (milestones 2, 4, 5 scope)

Guided by docs/research/miro-ux-checklist.md (P0 items first).

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
- M0 build: sync file routes + text lease, preview worker, protocol test harness, branded web client, and browser e2e suites landed; e2e lease-test flake root-caused (caret placement on an already-selected note) and fixed.
- Integration fixes: worker file-type moved to runtime deps; web declares @draftroom/dev-assets; asset id validation aligned with the canvas-schema (10–40 chars); apps/sync typecheck now covers test/.
- M1 dependencies pinned and installed (Fastify 5.12.5, PGlite 0.5.8 = PostgreSQL 18.3 in-process, pg 8.23.0, zod 4.6.5, @clerk/backend 3.20.1, @clerk/react 6.17.2); PGlite smoke-tested (memory + file persistence).
- docs/FEASIBILITY.md, docs/DEMO.md written. Milestone 0 complete.
- Board logic packages: board-ops (bulk notes, search, frame outline/presentation order, CSV, archive import/export, id remap) and six templates; 372 tests; adversarial review fixed 7 defects.
- Miro UX research: official behaviors, user voices, and a 96-item P0 checklist (docs/research/miro-*.md).
- Milestone 1 built and integrated (api, db, auth, permissions, tickets, revocation, dashboard, share dialog, invitations, deploy config). Integration fixes: apps/sync and apps/web now declare @draftroom/permissions.
