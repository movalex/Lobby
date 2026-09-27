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

Before any staging deploy (needs your decisions/accounts): Clerk keys; a tldraw key listing the staging host; publishing the repo. WebSocket routing, internal-URL wiring/loopback refusal, trustProxy and /healthz were resolved in the features phase (platform section, docs/DEPLOY.md); Render itself is still unverified.

## Miro-style features phase (milestones 2, 4, 5 scope): built and integrated (2026-09-27)

Per-feature checklist coverage: docs/FEATURES-M2-CONTRACTS.md §3 "As built".

- **Canvas UX**: Miro shortcuts (L connector, P pen, Alt+1/2, Ctrl+0, Ctrl+Shift+L, PgUp/PgDn, M minimap, Ctrl+F search), guides on by default, type-to-edit notes, paste-as-sticky-notes prompt, Draftroom 13-colour WCAG-AA note palette, Miro-style toolbar, template picker/insert (one undo), frame outline with reorder, board search, copy link to selection, start view, 20k shape cap.
- **Comments**: comment tool (C), shape-anchored pins that move with shapes, threads with replies/edit/delete, resolve/reopen, read/unread/mentioned states, @mentions (in-app notifications; no email), comments panel with filters, notifications bell, orphaned threads, Shift+C.
- **History**: named checkpoints, restore as new private board, duplicate, board JSON export/import, board-wide "recently deleted" with restore (captured server-side), periodic consistent SQLite backups + restore drill.
- **Present & export**: frame-by-frame presentation (hides chrome/cursors/pins), PNG/SVG/PDF (raster pages + text layer)/CSV export.
- **Workshops**: server-timed timer, voting with transactional budgets and ballots hidden until reveal, results, "gather everyone" (follow).
- **Dashboard & sharing**: starred, grid/list, template gallery on New board, duplicate/move/import, sharing-state badge, review links (multi-use, expiring), access requests with owner approval, pending-invitation list.
- **Platform**: production refuses loopback internal URLs, TRUST_PROXY, sync Origin allowlist, separate sync origin for Render, render.yaml/Docker updated.

Checks: pnpm verify — lint 0 errors / 0 warnings, typecheck, vitest 1245 passed / 1 skipped, Playwright 14/14 (M0/M1 suites; feature e2e suites are the next phase); integration smoke 53/53 in branded Chrome with four users.

## Validation phase (feature e2e + collaboration quality): COMPLETE locally (2026-09-27)

Seven engineers proved the features in real browsers (two or three contexts, fresh contexts and the API as the second witness) and fixed what failed; an integration pass ran everything together. Per-ID status with the e2e test names: docs/FEATURES-M2-CONTRACTS.md §3; scenario map: docs/E2E-PLAN.md (66/66 covered, 4 with a stated deviation).

- **Collaboration quality**: truthful save indicator (Saved / Saving… / Offline / Offline — changes will sync / Change not saved / View only) and per-property undo (WRK-03, WRK-05), plus a guard for a tldraw rebase that wiped the redo stack.
- **Bugs found and fixed**: viewer/commenter user-record push loop; "Saved" while an image was uploading; event stream dead after an api restart (proxy + data ping + watchdog); edits lost when leaving a board within a second (leave guard); ballots leaking through selection presence; workshop timer offset; no new vote after "End without results"; PNG exports with two pHYs chunks; restore summary counting binding ends; comment Esc/focus; share badge and Share dialog not live for M1 changes; import title; start view not observable; right-click "Unlock all" missing.
- **One-command dev flow** re-checked from an empty `.data`: `pnpm dev` → sign in → New board → a note placed with N shows Saving… then Saved → a second browser loads it; one event stream per board under StrictMode; stopping the tree left nothing listening.

Checks: pnpm verify — lint 0 errors / 0 warnings (504 files), typecheck 13 projects, vitest 1298 passed / 1 skipped (POSIX-only SIGINT test), Playwright 113/113 in 7.7 min; the full browser suite also passed 3 consecutive runs before that (113/113 each).

## Current phase: Miro-user persona reviews (still open from the previous plan); deploy prerequisites unchanged (Clerk keys, tldraw license, Render)

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

### 2026-09-27
- Miro-style features built by seven owners against docs/FEATURES-M2-CONTRACTS.md (canvas-ux, comments, history, present-export, workshops, dashboard-share, platform), then integrated: StrictMode-safe board event stream, SSE streams ended on api close, M2 migrations checked on fresh and M1 databases, one cross-feature keyboard map test, dashboard card-menu stacking fix, comment pins hidden while presenting, e2e ports configurable (E2E_PORT_BASE) with per-run build/output folders. As-built checklist status: docs/FEATURES-M2-CONTRACTS.md §3. Open: workspace dependency declarations for @draftroom/board-ops/@draftroom/templates (filtered Docker/Render installs).
- Engine spikes: truthful Saved indicator (88/88 browser checks) and per-property undo (verified with two clients) — recipes in docs/research/saved-indicator.md and undo-per-prop.md; found read-only viewers re-pushing their user record ~14×/s.
- Miro-style feature phase built by seven parallel owners + integration (fixed: SSE stream closed under StrictMode, card menu z-index, pins on slides, API shutdown hang with open streams). Integration owner: declared @draftroom/board-ops/templates dependencies (filtered installs for Docker/Render), cleared all lint warnings.
- Validation phase: seven engineers wrote the feature browser suites (canvas-ux, comments, history, present-export, workshops, dashboard-share, collab quality; the suite grew from 14 to 113 tests) and fixed the bugs they exposed in their features; integration fixed the cross-cutting ones (event stream after an api death, edits lost on in-app navigation, right-click Unlock all), converted the last expected-failure and fixme tests into passing ones, and re-checked `pnpm dev` from an empty data dir. Full suite 113/113 in 3 consecutive runs (~7.7 min each, one worker).
- Validation phase: Saved indicator, per-property undo, viewer fix adopted; e2e suites for every feature (113 tests); e2e now declares pdf-lib/pdfjs-dist itself.
