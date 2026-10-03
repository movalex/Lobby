# Lobby: cut-over to the Excalidraw canvas, rollback and roll-forward (runbook)

Status (2026-10-03, written at the wave C6 docs refresh): **THE CUT-OVER IS DONE; THIS RUNBOOK IS NOW THE RECORD AND
THE ROLLBACK/ROLL-FORWARD REFERENCE.** Staging has run the Excalidraw canvas since 2026-10-01 20:43–20:56Z
(`docs/CUTOVER-LOG.md`: C4–C17 passed as adapted there). What has happened since, each checkable in the log:
the CSP is enforced (2026-10-03 ~05:10Z, CUTOVER-LOG §7); C19 is done (`render.yaml` matches live, 0 differences);
the owner's real sign-in check passed; the watch check at about 31 h read "Go" (log §7); waves A (`main` 0644365), B1–B5 (99d902c)
and C1/C3/C4/C5 (9627f29) are deployed on top of the cut-over build. **Still open:** the owner's Shell checks of the
conversion (§6 steps 2–3 of the log), the close of the 48 h window at about **2026-10-03 20:55Z (W4)**, drop-legacy (D7,
about 2026-10-08, under the owner's standing OK once those checks pass), the asset collector's day-30 switch (D30,
about 2026-10-31), and the held release `release/held` (migration 0024 and `CONTRACTS_REV` 11, built and gated, **not
deployed** when this was written; it deploys after the window closes, in the order api → sync → web). After the window
closes a rollback to R0 is no longer offered, and the held release makes it unreachable by design (R0's api could not read
migration 0024): §7 is history from then on.

Before that: **prepared 2026-09-30 on `engine/w4-prep`; rehearsed 2026-10-01 on the NAS against a39a1c5 with
staging's real data (`docs/research/excalidraw/REHEARSAL.md`): C4–C17, §7 and §8 passed; the corrections
below come from it; the owner's parts (R8's real sign-in, R9, P3's sign-off) were left to the owner (the real sign-in
passed on 2026-10-03; R9 and P3's lossy-count sign-off are listed as not run in CUTOVER-LOG §5).** This is the Excalidraw side's
runbook for plan §7.5 (`docs/EXCALIDRAW-MIGRATION.md`). It takes the tldraw side's steps from
`docs/DEPLOY.md` "Bridge release R0" on `main` (R0 runs cut-over steps C4 to C6). R0 went live on staging
2026-09-30 (`main` 38d3833, tag `lobby-r0`, `docs/PROGRESS.md`); the owner waived the 3-day floor on 2026-10-01 and
approved the window (CUTOVER-LOG §1).

Sources: plan §2.12, §5.3-§5.10, §7.5, §10, Appendix B, and the "Contracts R0 fixed" section (now in the plan itself,
cherry-picked from the `excalidraw` docs branch at wave C6); `docs/DEPLOY.md`
"Bridge release R0" and "Rollback"; `docs/research/excalidraw/SYNTHESIS.md` (the verified facts);
`docs/research/excalidraw/render.cutover.yaml.patch` (the `render.yaml` change).

## 0. How to read this

- **[OWNER]** marks a step that needs the owner's sign-off before it runs. The owner has approved the
  plan, its accepted losses and the AGENTS.md rewrite (applied at the cut-over merge, P12). Every
  deploy to staging, every Render setting change, the go/no-go calls, a rollback and drop-legacy still
  need his OK at the time.
- **[BUILD]** marks something this runbook needs that the branch does not have yet. §1 lists the
  cut-over's (G1-G11) with each one's status at the wave-4a integration (2026-10-01): the cut-over cannot
  start while one is open, except where §1 gives a workaround. R4 and R8 name two more that only the
  rehearsal needs.
- **UNVERIFIED** marks a Render behaviour or an assumption no one has checked.
- **Stop** means: do not go on; keep maintenance on; decide with the owner between fixing forward and
  the rollback (§7).
- **The cut-over log** is a folder on the workstation, outside the repository, for example
  `C:\Users\Chase\Documents\Lobby-cutover\<date>\`. Every report and every check's output goes into it,
  with the time. It holds board ids, digests, clocks and object keys, never board content. Never commit
  it.
- **Shells.** "Sync Shell" is Dashboard → `draftroom-staging-sync` → Shell; "api Shell" is
  Dashboard → `draftroom-staging-api` → Shell (the api Shell has not been used before: UNVERIFIED). The
  images have no `pnpm`; commands run with `node`. In each new Shell session, define the internal-route
  helper once (the same requests as DEPLOY.md's one-liners):

  ```sh
  int() { node -e "const [m,p,b]=process.argv.slice(1);fetch('http://127.0.0.1:'+(process.env.PORT||10000)+p,{method:m,headers:{'content-type':'application/json','x-draftroom-internal':process.env.DRAFTROOM_INTERNAL_SECRET},body:b}).then(async r=>{console.log(r.status,await r.text());process.exitCode=r.ok?0:1})" "$@"; }
  ```

  Then `int GET /internal/maintenance`, `int POST /internal/maintenance '{"on":true}'`, and so on. The
  snippets below avoid a bare `!` (an interactive bash would treat it as a history expansion inside
  double quotes); keep it that way when editing them, or run `set +H` first.
- **Copying or restoring a board file by hand.** Never `cp` a `board-<id>.sqlite` alone: every board
  database runs in WAL mode, and a board born on the Excalidraw build whose sync was killed before its
  first checkpoint keeps its whole `lb_*` schema in the `-wal` next to it (a copy of the `.sqlite` is an
  empty file). Before any copy or restore of a board file by hand (a staging copy for the rehearsal, a
  `--from=file` restore, the B8 drill's inputs), with the sync stopped or in maintenance and the board's
  room closed: `node apps/sync/src/backup/checkpoint-board.ts --board <id>` (or `--path <file>`); it
  answers `checkpointed`, `nothing to do` or `busy` (exit 1: wait for the room to close and run it again).
  Otherwise copy the `-wal` and `-shm` along. The sync's own backups and run-all never copy raw, and
  `restore-board --from=file` and the B8 scripts copy a file with its WAL (DEPLOY.md "Copying or restoring
  a board file by hand"; `apps/sync/src/backup/checkpoint.ts`).
- **Render.** Staging's Blueprint has auto-synced on pushes to `main` that change `render.yaml`, and an
  env change applied by a Blueprint sync has deployed the service (observed 2026-09-28). Service code
  deploys are manual. So `render.yaml` is changed only at C19, after the Blueprint is on Manual Sync
  (P8). Until then every setting is changed by hand, one service at a time, in the order below.

## 1. What the branch still lacked (found 2026-09-30; status at the wave-4a integration, 2026-10-01; G11 refreshed 2026-10-03)

Found while writing this runbook (read-only checks of `engine/excalidraw` at 1a85d5c). Each is a wave 4
or wave 5 item; the workstream column names who writes the code (plan §7.2). The **Status** column was
filled when `engine/w4-prep`, `engine/w4a-web`, `engine/w4a-sync` and `engine/w4a-api` were merged
into `engine/excalidraw` (PROGRESS.md's wave-4 entries; contracts §12 W4-WEB-1 and W4-API-1), and G10 when the tldraw
removal (wave 4 part 2) merged: **G11 was open**; the other ten were closed (G11 is refreshed at wave C6, 2026-10-03: see its row), each with the test or document
that pins it. The "Missing" column keeps the 2026-09-30 wording as the record of what was found.

| # | Missing | Why the runbook needs it | Workstream | Closed when | Status (2026-10-01) |
|---|---|---|---|---|---|
| G1 | **No boot-in-maintenance flag.** Maintenance is a runtime switch that starts off on every start (`apps/sync/src/app.ts:140-144`); `DRAFTROOM_BOOT_MAINTENANCE` is read nowhere (plan open item 11) | C9 and F6: the new sync must come up with every socket refused, so no one edits a board before it is converted and checked | 2B | sync reads `DRAFTROOM_BOOT_MAINTENANCE=1` at start (any other value or unset: off), logs it, and a test starts a server with it and sees sockets refused and internal routes working | **Closed** before wave 4a, on `engine/excalidraw` (wave 5, 2B): `apps/sync/src/config.ts` reads `DRAFTROOM_BOOT_MAINTENANCE=1` (any other value or unset: off), `app.ts` logs "[maintenance] on at start"; test `apps/sync/test/r0/boot-maintenance.test.ts`. C9 and F6 use it. |
| G2 | **The production build has no Excalidraw board.** The engine route and the font assets need the dev-auth guard (`apps/web/build/excalidraw-assets.ts:51-53`, `App.tsx`); with `VITE_LOBBY_ENGINE=excalidraw` and no dev auth the build ships no engine and no `/excalidraw-assets/` | C14: the web Render builds | 2C + wave 4 | a build with `VITE_LOBBY_ENGINE=excalidraw`, `NODE_ENV=production` and no dev auth opens `/b/<id>` on Excalidraw and emits `dist/excalidraw-assets/` (without `Liberation/`) | **Closed** (W4-WEB-1): `apps/web/src/App.tsx`, `src/lib/board-engine.ts`, `build/excalidraw-assets.ts`. Gates: `pnpm --filter @draftroom/e2e excalidraw:prod` (`e2e/excalidraw-builds/prod-build.spec.ts`: the production build, no dev auth, opens `/b/<id>` on Excalidraw, fonts from this origin, `Liberation/` 404) and the default-suite spec `e2e/tests/build-engine-markers.spec.ts` (the default build: 0 engine markers, no `excalidraw-assets/`). |
| G3 | **`index.html` still has the inline theme script** (`apps/web/index.html:19-39`), and `z.config({ jitless: true })` exists nowhere | the CSP in the patch has no hash and no `unsafe-eval`; without these two fixes every page logs violations, and the theme script is blocked (a flash of the wrong theme) | wave 4 | `index.html` has no inline script (a test asserts it); zod is jitless before any schema runs; A12's CSP run gives 0 violations on the cut-over commit | **Closed** (W4-WEB-1): `index.html` has no inline script; the theme boot is `apps/web/public/theme-boot.js` (`theme.test.ts` asserts it), zod is jitless through `public/zod-jitless.js`, a classic head script (`src/lib/zod-jitless.test.ts`; a module placement ran after the shared zod chunk). A12 on the production build: `pnpm --filter @draftroom/e2e csp:cutover` (`e2e/spike/csp/run-cutover.ts`, the patch's header), 0 violations, 3 runs in a row. Clerk's real origins in the header stay UNVERIFIED (P5): the harness signs in with the dev provider. |
| G4 | **The conversion does not get the final backup's digest.** `MigrationService`'s `backupOf` is wired nowhere, so `converted_from.backupKey` is null and each report's `sourceMatchesBackup` is null (`apps/sync/src/room/migrate/service.ts:112-121`) | C11: §5.3 requires `lb_source`'s digest to equal the final backup's `recordsSha256` | 2B | `backupOf` reads the board's newest held manifest entry (`holdUntil` in the future). Until then, C11's script makes the comparison from the saved run-all report | **Closed** (W4-SYNC): `convert-all` reads the board's newest held, tldraw-described entry of the local manifest on the sync disk (`apps/sync/src/room/migrate/final-backup.ts`); the conversion refuses a board whose records differ (`backup-digest`, nothing written; the report carries `backupKey` and `expectedSourceSha256`) and records the key as `converted_from.backupKey`. Test `apps/sync/test/migrate/final-backup.test.ts`. Lazy conversions on open get no backup (plan §5.3 "Lazy"). C11's script stays as the independent check against the saved run-all report. |
| G5 | **No `engine_migration` checkpoint after conversion** (plan §5.5): the reason exists (migration 0022, labels) but nothing takes it | C12: the per-board restore point | 2F with 2B | the conversion (or a route C12 calls) saves one `engine_migration` checkpoint per converted board, `body_version` 2 | **Closed** (W4-API-1): `POST /internal/checkpoints/engine-migration` and `node apps/api/src/features/history/checkpoint-all-cli.ts --engine-migration` save one automatic `engine_migration` checkpoint per converted board (`body_version` 2), idempotent (`apps/api/src/features/history/checkpoint-all.ts`, `checkpoints.ts`). Tests `apps/api/test/features/history/engine-migration.test.ts`, `e2e/excalidraw/cutover-api.spec.ts`. C12 has the command. |
| G6 | **R0's row contracts are dormant:** nothing writes `board_snapshots.body_version = 2` or `boards.new_canvas = true`, and the api still carries R0's refusals of them (`EXCALIDRAW-CONTRACTS.md` W3-15, W3-16) | the rollback (§7): R0 must recognise checkpoints and boards made on the new canvas by these columns | 2F with 2B | the Excalidraw build writes both (converted boards keep `new_canvas = false`) and drops R0's refusals in the same change | **Closed** before wave 4a, on `engine/excalidraw` (wave 5, 2A), checked by W4-API with nothing to change: `apps/api/src/canvas-engine.ts` writes `boards.new_canvas = true` for every board the api creates on the new canvas (create, duplicate, restore-as-new, import), `body_version` 2 for v2 bodies, keeps converted boards `false`, and turns R0's refusals off when `GET /internal/canvas` says excalidraw; test `apps/api/test/features/history/new-canvas-build.test.ts`. |
| G7 | **No rollback export** (`rollback-exports/<board>/<time>.json`, plan §5.9 step 2) | B4 | 2B | a route or CLI writes every board's lb_* state to R2. **Workaround until then:** B4 takes a run-all held backup of every board file, which copies the file whole, lb_* included (DEPLOY.md "R0 at the cut-over") | **Closed by documentation** (W4-SYNC): no second format is written. The held run-all backup on the Excalidraw build in maintenance IS the lb_* export: whole files, every `lb_*` table incl. `lb_prev_*` and `lb_source`, described from `lb_*` as `lobby-elements-converted`, signed, held 90 days, drilled and restorable (`apps/sync/src/backup/run-all.ts` header; gate `apps/sync/test/r0/rollback-safety-copy.test.ts`). B4 records the report's `offsiteKeys` as the export keys; the `rollback-exports/<board>/<time>.json` layout is dropped. |
| G8 | **No `drop-legacy`** (plan §5.9 step 5) | D7 | 2B | a reviewed command that removes the tldraw tables, `dr_deleted_*`, `lb_source` and `lb_prev_*` and runs `VACUUM`, with a test | **Closed** (W4-SYNC): `POST /internal/migrate/drop-legacy` with `{"confirm":"drop-legacy", force?, dryRun?, boards?}` (`apps/sync/src/room/migrate/drop-legacy.ts`; tests `apps/sync/test/migrate/drop-legacy.test.ts`, `drop-legacy-process.test.ts`). D7 has the command and the guards. |
| G9 | **R0 contracts to re-check on the cut-over commit:** retention keeps `holdUntil` entries (Contracts R0 fixed item 3); the build reads `format: "lobby-elements"` entries (item 4); the roll-forward mirrors R0's restores and trims into `lb_deleted` (open item 10); a converted file's backup is described from its tldraw tables or a format of its own, never `lobby-elements` (DEPLOY.md "backup formats") | the rollback and the roll-forward | 2B | each has a gate test on the cut-over commit | **Closed** (2B's wave-5 gate tests, green again at the integration): `apps/sync/test/r0/final-backup-hold.test.ts` (item 3), `apps/sync/test/r0/manifest-format.test.ts` (item 4), `apps/sync/test/migrate/rollforward-deleted.test.ts` (open item 10), `apps/sync/test/backup/excalidraw-backups.test.ts` (a converted file is described as `lobby-elements-converted`, never `lobby-elements`), and W4-SYNC's `apps/sync/test/r0/rollback-safety-copy.test.ts` (the whole lb_* state in the copy after Excalidraw-era edits and a roll-forward). *(Checked 2026-10-03 at `release/held` 99ac6c52: `final-backup-hold.test.ts` and `manifest-format.test.ts` were deleted from the tree with the tldraw build, `a75883d6`, and are on the tag `lobby-r0` only; the hold's retention is now pinned by `excalidraw-backups.test.ts` and `r0/run-all-fresh.test.ts`. The other three files exist.)* |
| G10 | **tldraw still in the build** (lockfile PR #2 not done): `scripts/licence-check.mjs` passes only with `--before-cutover` | P2: the licence check must pass in strict mode | wave 4 | `pnpm licence:check` (strict) passes and CI drops `--before-cutover` | **Closed** (wave 4 part 2, the tldraw removal, PROGRESS.md 2026-10-01): `tldraw`, `@tldraw/sync`, `sync-core` and `assets` left the catalog, every manifest and the lockfile (lockfile PR #2); the five MIT packages are dependencies of `packages/tldraw-import` alone (`@draftroom/tldraw-import/schema`, `/tldraw`, `/archive-v1`, `/templates`); `pnpm licence:check` passes in strict mode and the script has no other mode; CI runs it without a flag. SMK-1 closed with it: the board chunk carries no `@tldraw/` string and no tldraw embed host (`e2e/excalidraw-builds/prod-build.spec.ts` "no tldraw … no host but Clerk's" fails on 32859b1, passes now). `DRAFTROOM_ENGINE=tldraw` is refused by sync (the rollback is R0's deploy, §7); `VITE_LOBBY_ENGINE` and `VITE_TLDRAW_LICENSE_KEY` are gone from the web build and `render.yaml`. |
| G11 | **Cut-over blockers from the waves** (`WAVE-3.md` §6, `REVIEW-W5-EARLY.md`): B9's edit visibility on the heavy board (1.5 s p95 against 250 ms) and its NAS capacity half (never run); B11's one unexplained divergence; the open review blockers (for example W5-02, deleted notes' text sent to every role) | P2 | the owners named there | each is closed or accepted by the owner | **Closed where measured at wave C6 (2026-10-03); the remainders are named, and nothing here is an owner acceptance.** (1) **Edit visibility on the heavy board: met.** On Lobby's board page with all 200 images loaded, three runs: p95 at 100% zoom 185 / 177 / 208 ms against the 250 ms gate, 0 of 180 edits lost (`spike-b/B9.md` "Workstation half, re-run on Lobby's board page", `spike-b/PERF.md`; app code `release/held` 99ac6c52, harness on `wave-c6/perf-heavy`; workstation, headless, machine 2.9-10 % busy, see PERF.md). The 1.5 s figure above and every earlier Excalidraw browser number on this board (spike B, 3B-2, B9's diagnostic runs) were taken with no image drawn (W5-34); they are superseded. (2) **NAS capacity half (0.5 CPU / 512 MB): run, server side holds, three L1 targets missed.** Run at 5caee00, again after the room's performance round, and on 99ac6c52 (2026-10-03: one run each of L1, L2, the conversion run and L1 with `synchronous = NORMAL`; at 5caee00 there were three runs each of L1 and L2): receive-to-ack p95 ≤ 100 ms, all 260 sessions back 5.0–5.4 s after the SIGKILL, RSS ≤ 147 MB (310 MB with the conversion worker), 0 acked-but-missing in every run, the conversion run's five conditions held. **Missed at L1 on 99ac6c52: the server event-loop p99 (115.1 ms after the restart, 56.5 ms before the kill; target ≤ 50), steady-state CPU of the quota (mean 62.4 %, max 91.8 %; target ≤ 80 % in any window) and the restart and conversion windows (97.1 %, 98.9–109.3 %).** The profile names the rev-10 presence relay's re-rank (`PresenceHub.rank`, a5e8eb6); `synchronous = NORMAL` clears the steady CPU window (max 76.6 %) but not the event loop (50.5 ms before the kill, 89.5 ms after). Staging stays on FULL. No owner acceptance of these misses is recorded, and Render's own commit latency was not measured (`spike-b/B9.md` "Re-run on the release/held head"). (3) **B11's divergence: explained, fix written, not yet merged.** The one run (017f76d) is root-caused to an index re-key racing an unacknowledged create and reproduced with a test; the fix is bf45f19a on `wave-c6/b11`. At release/held 18 runs gave 16 PASS, 0 not converged, 2 no verdict (a headless rejoin that waited past its 60 s ticket: a new open finding, not a divergence) (`spike-b/B11.md`). (4) **The review blockers** (W5-01, W5-02, W5-05, W5-08) were fixed at the engine merge and shipped in the cut-over build (`REVIEW-W5-EARLY.md` §11, §12). The lead's wave-4b queue (pending findings, 2026-10-01) adds L1 as a must-fix before the switch (maintenance does not refuse the engine's room-internal write routes; closed by the engine fixer). SMK-2 is built (wave 4b, 2A, `CONTRACTS_REV` 9): every terminal close is announced in band by a `notice` CLOSING and the web treats the close that follows as terminal with that reason, so an edge that strips close frames no longer hides "Lobby is updating" or a refused ticket; the smoke run re-checks it through the Render edge on the cut-over build. M2 (an unknown `NODE_ENV` is refused by api, sync and worker) and L5 (the sync logs {name, message, code}) are built too. **Closed in wave 4b (2B):** M3 (a dedicated `DRAFTROOM_BACKUP_SIGNING_SECRET`; the derived key only verifies older manifests; a Render env var at C8; `apps/sync/test/backup/signing-secret.test.ts`) and L6 (run-all refuses a new run while a held set of every board from the last 30 minutes exists unless forced, 409 `RECENT_HELD_SET` / `--force`; convert-all needs maintenance on or `{"confirm": true}`, 409 `MAINTENANCE_REQUIRED`; `apps/sync/test/r0/run-all.test.ts`, `apps/sync/test/migrate/convert-all-guard.test.ts`). |

## 2. Preconditions (plan §7.5 step 0)

All must hold on the day. Record each check in the log.

- **P1. R0 live at least 3 days.** Not before 2026-10-03 05:16Z. On the day: R0's api, sync and web are the
  live deploys (Dashboard → each service → Events), and DEPLOY.md "Checking it after the deploy" items 1
  and 2 pass (`int GET /internal/maintenance` prints `200 {"maintenance":false}`).
- **P2. The gate, on the cut-over commit.** Every §1 item closed. Wave 4's full gate ×2 and wave 5's
  review with no open major finding (plan §7.3). `pnpm lint`, `pnpm -r typecheck`, `pnpm test`, the
  e2e suite (`pnpm --filter @draftroom/e2e test`: the Excalidraw suite, the default since wave 4 part 2;
  the tldraw suite is R0's on main) and **`pnpm licence:check`** (strict: no tldraw package but the five
  MIT ones inside `packages/tldraw-import`). The engine probe suite passes
  (`apps/web/test/engine-probe`, part of `pnpm test`). The NAS load re-run (wave 4) meets plan §2.13's
  targets, or the owner accepts the numbers **[OWNER]**. *(Status 2026-10-03: the cut-over went ahead on 2026-10-01 with the wave-4 NAS
  numbers in hand, which already missed the L1 event-loop target as the report defines it (PROGRESS 2026-10-01); no
  explicit acceptance of those numbers is recorded. The re-run on the release/held head misses three L1 targets, see G11.)*
- **P3. The rehearsal (§3) passed, and the owner signed it off [OWNER]**, including the lossy counts
  and the side-by-side comparison of 10 boards. The rehearsal ran on 2026-10-01 (`REHEARSAL.md`: every
  step passed; lossy codes on one board: `geo-approximated` 1, `geo-polygon` 1); the sign-off and R9 are open.
- **P4. Disk.** In the sync Shell:

  ```sh
  df -B1 /var/data
  du -sb /var/data/rooms /var/data/backups
  ```

  Free bytes must be at least **3.5 × the rooms total + 50 MB** (the conversion's own check per board,
  `DISK_FACTOR`), plus room for one more local backup of every board (C5 and later passes). Spike B8
  measured converted files at up to 4.6 × the tldraw file and recommends 5 × + 50 MB
  (`spike-b/B8.md`); use 5 ×. If it does not fit: **stop**. A bigger disk is an owner decision (paid,
  Appendix B 14) **[OWNER]**.
- **P5. The CSP's Clerk origins are final**: recorded from a real sign-in at the rehearsal (R8), and the
  CSP line in `render.cutover.yaml.patch` corrected to them. Today's line has the frontend-API host
  decoded from staging's publishable key (`splendid-flamingo-3744.clerk.accounts.dev`, a development
  instance), plus `img.clerk.com`, `clerk-telemetry.com` and `challenges.cloudflare.com` from code and
  Clerk's documentation (UNVERIFIED). At the rehearsal the sign-in page under the enforced header
  (Clerk's widget rendered) requested only the frontend-API host and `img.clerk.com`, with 0 violations;
  `challenges.cloudflare.com` and `clerk-telemetry.com` were not requested. A completed sign-in is still
  needed before the line is final (`REHEARSAL.md` §8 D7). *(Status 2026-10-03: the owner's real sign-in under the
  report-only header showed 0 Lobby CSP lines and the policy has been enforced since about 05:10Z, CUTOVER-LOG §7;
  staging is still a Clerk development instance.)*
- **P6. A missing file under `/excalidraw-assets/` gets a 404 on the static host, not `index.html`
  [OWNER: a staging setting change].** Render's answer to the rule is UNVERIFIED, so it is tried before
  the cut-over, on its own: Dashboard → `draftroom-staging-web` → Redirects/Rewrites → add, **above**
  the `/*` rule, a Rewrite from `/excalidraw-assets/*` to `/excalidraw-assets/__not-found__` (the
  patch's first hunk). The tldraw build never requests that prefix, so this changes nothing for users.
  Then from the workstation:

  ```sh
  curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://draftroom-staging-web.onrender.com/excalidraw-assets/fonts/Nunito/not-there.woff2
  curl -s -o /dev/null -w '%{http_code}\n' https://draftroom-staging-web.onrender.com/b/anything   # the SPA still answers 200
  ```

  The first must print `404` (any content type but `text/html` with a 200). If Render answers 200 with
  `index.html`, or follows the rewrite into the SPA rule: **stop** and replace the `/*` fallback by
  rewrites of the app's own route prefixes (the routes in `apps/web/src/App.tsx`), which leaves every
  other missing path a 404; re-test. *(Measured at the cut-over, CUTOVER-LOG §1 A2: Render answered the patch's
  rewrite to `/excalidraw-assets/__not-found__` with `200`, an empty body, not a 404; the rule's destination was
  changed to `https://draftroom-staging-api.onrender.com/excalidraw-assets/*`, whose unknown-route answer is a real
  404 JSON. Do not use the rewrite above as written.)*
- **P7. The tldraw key's expiry [OWNER].** The owner records the staging key's exact expiry date
  (estimated 2027-01-05 if issued at the first staging deploy, plan §7.4). Cut-over day + 7 (drop-legacy)
  must fall at least two weeks before it, or the key is renewed first. Until drop-legacy, a rollback
  rebuilds or reuses R0's web, which needs the key.
- **P8. The Blueprint is on Manual Sync [OWNER: a Render setting].** Blueprint `draftroom-staging` →
  Settings (exact location UNVERIFIED, DEPLOY.md "First provisioning" step 6). Without it, C19's
  `render.yaml` commit would apply env changes and deploy services in an order no one controls.
- **P9. The window and the words [OWNER].** A 30-minute window outside workshops (resized from R11's
  timings), the announcement text, and who sends it. The rollback semantics are as approved with the
  plan (Appendix B 5).
- **P10. A real iPhone or iPad Safari session** on the rehearsal or a preview of the cut-over build
  (Appendix B 11) **[OWNER]**.
- **P11. Free memory for conversion.** Nothing to do on Render (the maintenance run uses a 256 MB heap
  cap with no room open, plan §5.3), but the rehearsal's report must show every board's peak heap below
  the cap. Measured 2026-10-01: 29.1–33.3 MB per conversion and 31.4 MB for the roll-forward merge, against
  `capMb` 256 (the status also shows `runtimeCapMb: 98`, the cap of a lazy conversion on open).
- **P12. The cut-over commit [OWNER].**
  - `engine/excalidraw` (wave 4 and 5 merged, gate green) is merged into `main`, with **AGENTS.md
    replaced by `docs/research/excalidraw/AGENTS.next.md`** (the approved §10 rewrite; delete the
    `.next.md` copy in the same commit) and `docs/research/excalidraw/SYNTHESIS.md` finished (plan §10:
    part of the cut-over gate). **`render.yaml` is not changed by this merge** (C19 does it), so the
    push deploys nothing.
  - Before the merge, tag the R0 commit that is live: `git tag lobby-r0 <R0 sha> && git push origin
    lobby-r0`. Rollbacks and R0 hotfixes start from that tag.
  - The api has no migration after 0022 on the cut-over commit, or each one is additive for R0
    (DEPLOY.md "Rolling the api back past a migration" step 1). Checked on 2026-09-30: none after 0022.
    **Changed on 2026-10-01 (wave 4b, audit L3): `0023_export_policy_guests` widens the export policy's
    CHECK to allow `everyone-including-guests`.** Additive for R0 (no row changes meaning; R0 never writes
    the value and reads it as "not everyone", so it limits like `editors`: fail closed). Consequence for
    a rollback: R0's api needs `DRAFTROOM_ALLOW_NEWER_SCHEMA=1` and *Deploy a specific commit* →
    `lobby-r0`, never *Rollback* (B6 below; DEPLOY.md "Rolling the api back past a migration").
- **P13. Private brainstorms.** The day before, list the open private-brainstorm sessions; they are closed
  or frozen in C2 (plan §5.8).
- **P14. People.** The operator (runs the Shells), one helper for C17's two-user smoke, and the owner
  reachable for the stop decisions.
- **P15. The backup signing secret [OWNER: a Render setting].** A value for `DRAFTROOM_BACKUP_SIGNING_SECRET`
  (`openssl rand -base64 32` on the workstation: 44 characters, different from the two secrets in the
  env group), ready to set on the sync service in C8 and kept nowhere else (never in the log, in chat or
  in git). The Excalidraw sync signs the offsite backups with it and **refuses to start in production
  with `DRAFTROOM_BACKUP_STORE=r2` and without it** (security audit M3; DEPLOY.md "Signed backups"). R0's
  backups, signed with the key derived from `DRAFTROOM_INTERNAL_SECRET`, still verify on the new build
  (the drill says "signed under the older key").

## 3. Rehearsal on the NAS (plan §7.5 step 1, wave 6)

The rehearsal runs the whole cut-over, the conversion of every staging board, DEMO.md, the full e2e
with the CSP enforced, the owner's comparison and the rollback → roll-forward drill on a copy of
staging, on the NAS, with nothing exposed. It produces the window's timings and the sign-off P3 needs.

- **R1. Approvals [OWNER]. None is given yet for the rehearsal itself.**
  - **(a) The Postgres dump of staging: owner OK NOT YET GIVEN** (Appendix B 3: "The rehearsal needs a
    staging database dump (not yet authorized)"). It holds every account, workspace, comment and invite.
  - **(b) Copies of staging's board files on the NAS.** Real DBC content. The standing NAS approval
    covers throwaway containers with generated boards only (plan §8.6.6, and the AGENTS.next.md
    local-environment rule "never with real board data"); the rehearsal needs its own OK.
  - **(c) Read-only use of R2** for the board restore (and, optionally, for copies of the files the
    boards reference, so images show in the comparison). Spike B's read-only restore was authorized for
    the spike only.
  - **(d) The staging Clerk secret key on the NAS** for a real sign-in (R8), in a mode-600 env file that
    the cleanup deletes; or a separate Clerk development instance for the rehearsal (a new, free
    resource).
  - Without (a) and (b), the rehearsal can run on generated boards only. That checks the steps and their
    timings, but not the real boards' conversion or lossy counts, so it does **not** satisfy P3.
- **R2. The NAS, before anything** (over SSH: `ssh -i ~/.ssh/ugreen_nas -o BatchMode=yes
  chase@192.168.10.1`). Everything is named `draftroom-rehearsal-*`: containers, network, images and the
  folder `/volume3/Apps/draftroom-rehearsal/` (`src-x/`, `src-r0/`, `data/`, `pg/`, `web/`, `reports/`).

  ```sh
  df -h /volume3            # stop below 10 GB free (Docker's root /volume3/@docker is on this volume)
  free -m                   # stop below 3 GB available (the owner's other containers use about 3.6 GB)
  docker ps -a --format '{{.Names}}'   # the "before" listing, into the log
  ```

  Nothing of `theaitre` or `draftroom-worker` is touched, listed beyond `docker ps`, stopped or rebuilt.
  SQLite runs on the NAS's own volume, never over SMB (`V:\`). Ports are published on the NAS's LAN
  address only (`192.168.10.1:8443` web, `:8444` sync; the owner's instruction, `REHEARSAL-PREP.md` §1),
  never `0.0.0.0`; the NAS has no route from outside. (An earlier draft wanted `127.0.0.1` through `ssh -L`.)
- **R3. Source.** From the workstation, the cut-over candidate and R0, as `git archive` (never `.env*`,
  `.data`, `node_modules`):

  ```sh
  git archive --format=tar <candidate sha> | ssh <nas> 'mkdir -p /volume3/Apps/draftroom-rehearsal/src-x && tar -x -C /volume3/Apps/draftroom-rehearsal/src-x'
  git archive --format=tar lobby-r0 | ssh <nas> 'mkdir -p /volume3/Apps/draftroom-rehearsal/src-r0 && tar -x -C /volume3/Apps/draftroom-rehearsal/src-r0'
  ```
- **R4. Images and the stack** (built: `docs/research/excalidraw/rehearsal/` on `engine/rehearsal-prep`:
  `stack.sh`, `edge.mjs`, `build-x.sh`; `REHEARSAL-PREP.md` §1–§2). The api and sync images from
  `docker/api.Dockerfile` and `docker/sync.Dockerfile` of each source, tagged
  `draftroom-rehearsal-{api,sync}:{excalidraw,r0}` (as `deploy/nas/deploy-worker.sh` builds the worker there); the
  web built in the pinned Node image (since G10 no `VITE_LOBBY_ENGINE` and no licence key: `web-build-x.env`
  holds `VITE_DRAFTROOM_SYNC_ORIGIN` only; R0's web keeps its key); a
  `postgres:18` container `draftroom-rehearsal-pg`; and a static server that does what Render's does:
  the SPA fallback, a 404 under `/excalidraw-assets/`, the `/api/*` and `/files/*` rewrites, and the
  patch's headers including the CSP, with the sync origin replaced by the rehearsal's
  (`rehearsal/edge.mjs`: the CSP behind `EDGE_CSP` from `env/edge.env`, present on the Excalidraw build and
  absent on R0; the `/excalidraw-assets/` 404 always on). Production mode needs https origins
  (`PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`), so the static server and the sync socket sit behind TLS
  (a self-signed certificate, `edge/tls/`; Playwright runs with `ignoreHTTPSErrors`, Node with
  `NODE_EXTRA_CA_CERTS=edge.crt`). Everything runs with
  `DRAFTROOM_BACKUP_STORE=fs` inside the folder: **nothing in the rehearsal may ever write to R2**; a
  container with any `R2_*` variable in its environment must refuse to start. The api's blob store is
  `fs` too. The network is a plain bridge (the api must reach Clerk's API); only `127.0.0.1` ports.
- **R5. The data.**
  - **Boards**, after R1 (b) and (c): restore every board's newest offsite backup with the drill tooling,
    read-only on R2, signatures verified with the staging internal secret read through the Render API and
    never printed or saved (Appendix B 13's rule), and keep the copies:
    `node apps/sync/src/backup/restore-drill.ts --from=store --keep` (on the workstation, as spike B8 did,
    then `scp` the kept files into `data/rooms/` on the NAS and delete the workstation copies; or in a
    one-shot container on the NAS). Record each board's `recordsSha256`.
  - **Postgres**, after R1 (a): the owner downloads a logical backup (Dashboard → `draftroom-staging-db`
    → Recovery or Backups → export; DEPLOY.md "Postgres and platform snapshots"; exact location
    UNVERIFIED), copies it to `pg/` over SSH, and it is restored into `draftroom-rehearsal-db`.
- **R6. The cut-over, timed.** On the copies, run §5's steps C4 to C17 against the rehearsal stack, with
  the same commands (the Shell is `docker exec -it draftroom-rehearsal-sync sh`, with `PORT` and
  `DRAFTROOM_INTERNAL_SECRET` from its environment; `tools/int.sh sync|api METHOD PATH [BODY]` on the NAS
  runs the `int` helper through `docker exec`). R0 first (maintenance on, run-all
  `--expect-maintenance`, the checkpoint of every board), then the new api, the new sync booting in
  maintenance, `convert-all` and C11's check, the web, maintenance off. Time each step into the log.
  The rehearsal's stand-in for a Render deploy is `docker rm -f draftroom-rehearsal-api draftroom-rehearsal-sync
  && ./stack.sh start excalidraw` after editing `env/*.env` (C7–C9, 3.8 s on 2026-10-01), `mv web/dist
  web/dist-r0 && mv web/dist-x web/dist` plus `env/edge.env` and a recreated edge for C13–C14, and the same
  with `r0` and the folders swapped back for §7. A container's environment is fixed at creation: an env
  change (C8, C16's deletion of the boot flag) reaches the process only through a recreate, never a
  `docker restart`, so "delete the flag, then a restart starts open" cannot be rehearsed in Docker.
- **R7. The conversion's results.** C11's script on every board: 0 failures, every diff check passing
  (100% of boards), every digest equal to the board's backup, the invariant checker run with 0
  violations. Keep every `<board>.json` report's counts, lossy codes, `ms` and `peakHeapUsedMb` (ids and
  counts only; the reports name no content). The heavy board's peak heap must stay under the cap with
  margin (spike B8: 62.7-67.1 MB total heap against a 98 MB runtime cap; the maintenance run's cap is
  256 MB).
- **R8. DEMO.md and e2e with the CSP enforced.** DEMO.md end to end in Chrome through the tunnel with a
  real Clerk sign-in (R1 (d)); the DevTools network log of the sign-in and of a board gives the exact
  Clerk origins: correct the patch's CSP line to them (P5). The console shows 0 CSP violations on the
  sign-in page, the dashboard and a board. The full e2e ×3 with the header enforced (the e2e stack runs
  on the workstation; its web server must send the patch's header: `pnpm --filter @draftroom/e2e
  csp:cutover` (`e2e/spike/csp/run-cutover.ts`) serves the production build under the patch's header and
  drives sign-in, dashboard and a board by hand (G3); the full suite under the header is still [BUILD]:
  the suites' preview server has no header option). The e2e network assertion (no request leaves Lobby's origins and Clerk's) passes.
- **R9. The owner's comparison [OWNER].** The owner opens 10 boards on the rehearsal and on staging side
  by side and signs off the lossy counts (plan §5.3). Screenshots go to the owner only, never into a
  report or the repository.
- **R10. The drill** (plan §5.9 step 6; spike B8's drill is the model, `e2e/spike-b/b8/drill.ts`): cut-over
  → edits on Excalidraw → rollback to R0 (§7's steps) → edits on tldraw (an add, a delete, a z-order
  change, an edit on a flattened page 2, a frame move while the Excalidraw side moved one of its children,
  a same-group conflict) → roll-forward (§8's steps) → a second rollback and roll-forward. A board created
  on Excalidraw after the cut-over is opened on R0 during the drill. **Pass:**
  - 0 edits lost on either side, except same-group conflicts, which are listed in
    `<board>.rollforward.json` and kept in `lb_prev_*`;
  - untouched elements byte-identical; Excalidraw-era z-order unchanged except where tldraw re-ordered;
  - the second cycle merges against the refreshed base (`converted_from.cycle` 2);
  - the born-after board refused by R0 (4099 `NEW_CANVAS_BOARD`, internal routes 409 `new-canvas`) and
    byte-identical afterwards;
  - `dr_deleted_*` byte-identical to the pre-cut-over file apart from R0's own rows.

  Run once on 2026-10-01 (`REHEARSAL.md` §5–§6, one cycle, one board edited on each side): ours added two
  notes, moved a frame with its 34 children, moved a child of a second frame and moved a third note; R0
  moved the second frame, moved the same third note and added two notes. The merge kept every edit but
  the one same-element move (listed as the single `pos` conflict, ours in `lb_prev_1_*`); the child whose
  frame R0 moved ended at ours' position plus the frame's delta (`parentMoved`, no conflict); the
  born-after board was refused by R0 three ways and byte-identical afterwards. Still to run: a delete, a
  z-order change, a page-2 edit, a board created on R0, the second cycle, the `dr_deleted_*` check.
- **R11. The window.** From R6's and R10's timings: how long C4 → C17 takes (conversion was 27-314 ms per
  staging board in spike B8, so the deploys dominate), how long a rollback and a roll-forward take. The
  owner resizes the window (P9) from them. Measured 2026-10-01 (`REHEARSAL.md` §2): C4 → C16 4 min 43 s
  wall-clock with the operator's pauses, about 30 s of commands (conversions 104–146 ms per board; three
  CLIs poll for 5 s each); rollback B3 → B8 23.5 s; roll-forward F3 → F9 19.6 s; the Docker stand-ins for
  the deploys took 2–4 s each, so Render's deploys are the unknown that sizes the window.
- **R12. Clean-up, always** (also after a failed run):

  ```sh
  docker ps -a --filter name=^draftroom-rehearsal- --format '{{.Names}}'
  docker network ls --filter name=^draftroom-rehearsal- --format '{{.Name}}'
  docker images --filter reference='draftroom-rehearsal-*' --format '{{.Repository}}:{{.Tag}}'
  # then remove ONLY names from those three lists, one by one: docker rm -f <name>; docker network rm <name>; docker rmi <image>
  rm -rf /volume3/Apps/draftroom-rehearsal
  df -h /volume3; docker ps -a --format '{{.Names}}'   # the "after" listing, into the log
  ```

  Never `docker system prune`, `docker image prune`, `docker compose down` or a command without an
  explicit name. The pinned Node image and `postgres:18` may stay (base images). Delete the workstation's
  restore copies and the Postgres dump wherever it was downloaded. Before anything from the rehearsal is
  committed, a leak check (as in spike B8, plan §8.6.7) reads the restored boards' text and searches the
  reports and test outputs for it; it prints only the match count, which must be 0.

## 4. Before the window (the day before and the hour before)

- Every P item is checked and logged.
- The operator has the Render Dashboard open on the three services and the Blueprint, the two Shells
  ready, and the log folder open.
- Each service's current live deploy is recorded in the log (Dashboard → service → Events: the deploy's
  commit and id). These are the rollback targets (§7).

## 5. The cut-over

- **C1. Go [OWNER].** The owner says go. From here, a stop means §0's "Stop".
- **C2. Announce** (plan §7.5 step 2) **[OWNER sends]**. The window is open. Close or freeze the open
  private-brainstorm sessions (P13).
- **C3. Log.** Write the start time, the cut-over commit, and the rollback targets (§4).
- **C4. Maintenance on, on R0** (plan §7.5 step 3; DEPLOY.md "R0 at the cut-over" step 2). Sync Shell:

  ```sh
  int POST /internal/maintenance '{"on":true}'    # 200 {"maintenance":true,"closedSockets":…}
  int GET /internal/maintenance                   # 200 {"maintenance":true}
  ```

  Pending pushes commit, every board closes with "Lobby is updating", new sockets are refused, internal
  routes that write a board answer 503. **R0's maintenance is a runtime switch: if R0's sync restarts
  before C9, maintenance is off again; start again from C4.**
- **C5. The final backup, after maintenance is on** (plan §7.5 step 4, §5.6; DEPLOY.md step 3). Sync
  Shell. The report is kept on the sync disk, which outlives the deploy, so the new sync can check
  against it in C11:

  ```sh
  mkdir -p /var/data/cutover
  node apps/sync/src/backup/run-all-cli.ts --expect-maintenance > /var/data/cutover/final-backups.json; echo "exit $?"
  cat /var/data/cutover/final-backups.json
  ```

  It must exit 0 (`"ok": true` and `"inMaintenance": true`). Any other exit: **stop** (the stderr lines
  name each failed board). `refused (HTTP 409, RECENT_HELD_SET …)`: every board has a held backup from
  the last 30 minutes already (this step repeated after a sync restart in the window, C4's warning): add
  `--force`, because the restart may have let edits land (audit L6; a run-all adds a 90-day copy of every
  board to the 1 GB disk, so repeated calls are refused). The CLI polls every 5 s, so a run of under a
  second still takes 5 s (`--interval-ms 1000` shortens it; the same for C6 and C12). Copy the JSON into the log. Every board has an `offsiteKey`, a
  `recordsSha256`, a `documentClock` and a `holdUntil` 90 days ahead: this set is the disaster copy,
  held 90 days outside retention (approved with the plan, Appendix B 6).
- **C6. A checkpoint of every board** (plan §7.5 step 4; DEPLOY.md step 4). api Shell, after C5:

  ```sh
  node apps/api/src/features/history/checkpoint-all-cli.ts > /tmp/checkpoints.json; echo "exit $?"
  cat /tmp/checkpoints.json
  ```

  It must exit 0 (`"ok": true`, `"failed": 0`). Copy it into the log as `checkpoints.json`, next to
  `final-backups.json`, and check on the workstation, in the log folder, that every board has the same
  `documentClock` in both:

  ```sh
  node -e "const f=require('./final-backups.json'),c=require('./checkpoints.json');const m=new Map(f.boards.map(b=>[b.boardId,b.documentClock]));let bad=0;for(const b of c.boards){if(b.outcome==='skipped'){console.log('skipped',b.boardId,b.why);continue}if(m.has(b.boardId)===false){console.log('no board file (an empty board):',b.boardId);continue}if(m.get(b.boardId)!==b.documentClock){bad++;console.log('CLOCK DIFFERS',b.boardId)}}console.log(bad?'STOP':'clocks match')"
  ```

  A first cut-over has no `skipped` row with `"why": "new-canvas"`. `CLOCK DIFFERS`: **stop**.
- **C7. Deploy the new api [OWNER]** (plan §7.5 step 5). Dashboard → `draftroom-staging-api` → Manual
  Deploy → Deploy a specific commit → the cut-over commit. Checks: the deploy is live; `/healthz` 200;
  the log has no error; `schema_migrations` lists nothing the cut-over commit does not know. R0's sync is
  still in maintenance; the new api reads its snapshots as before.
- **C8. The sync's environment, without deploying [OWNER: a Render setting].** On
  `draftroom-staging-sync`, add `DRAFTROOM_ENGINE=excalidraw`, `DRAFTROOM_BOOT_MAINTENANCE=1` and
  `DRAFTROOM_BACKUP_SIGNING_SECRET=<P15's value>` (the sync service's own variable, never the env group)
  without a deploy: either the Render API (`PUT /v1/services/<sync>/env-vars/<key>`, as DEPLOY.md
  describes; on 2026-09-28 an env PUT did not trigger a deploy), or Dashboard → Environment with the
  save option that does not deploy (its label is UNVERIFIED; if only "Save and deploy" is offered, that
  deploy is C9, so pick the cut-over commit first). R0 ignores all three variables, so a restart of R0 now
  changes nothing but turning its maintenance off (C4's warning). Without the signing secret the new sync
  refuses to start (`DRAFTROOM_BACKUP_SIGNING_SECRET is required when DRAFTROOM_BACKUP_STORE is on in
  production`), and Render keeps R0 running: set it, then deploy again.
- **C9. Deploy the new sync [OWNER], booting in maintenance** (plan §7.5 step 6; open item 11; G1 built:
  `DRAFTROOM_BOOT_MAINTENANCE=1`, `apps/sync/src/config.ts`).
  Dashboard → `draftroom-staging-sync` → Manual Deploy → Deploy a specific commit → the cut-over commit.
  Render stops R0's sync before it starts the new one (DEPLOY.md "What users see during a deploy").
  Checks, as soon as it is live:

  ```sh
  int GET /internal/maintenance     # 200 {"maintenance":true}: it booted closed
  int GET /internal/migrate/status  # 200 {...,"convertAll":"idle"}: the Excalidraw engine is loaded
  ```

  and the startup log names the boot maintenance and the signing key: `[maintenance] on at start
  (DRAFTROOM_BOOT_MAINTENANCE=1)` and `[backup] offsite
  backups signed with DRAFTROOM_BACKUP_SIGNING_SECRET (key id …); the key derived from
  DRAFTROOM_INTERNAL_SECRET (key id …) only verifies older backups` (key ids are hashes, not secrets; a
  line saying `set DRAFTROOM_BACKUP_SIGNING_SECRET` cannot occur in production: the server would not
  have started). The log does not name the engine: the migrate route answering 200 is what attests it
  (rehearsed). Its status shows `runtimeCapMb: 98` (a lazy conversion's cap) and, on each job, `capMb: 256`. Maintenance is **not** on: `int POST
  /internal/maintenance '{"on":true}'` at once, then **stop** (the build or the flag is wrong). The
  migrate route answers 404: the engine flag did not reach the process; **stop**.
- **C10. Convert every board** (plan §5.3 "convert-all"). Sync Shell:

  ```sh
  int POST /internal/migrate/convert-all    # 202 {"started":true}
  node -e "const u='http://127.0.0.1:'+(process.env.PORT||10000)+'/internal/migrate/status',h={headers:{'x-draftroom-internal':process.env.DRAFTROOM_INTERNAL_SECRET}};const tick=async()=>{const s=await(await fetch(u,h)).json();const c={};for(const b of s.boards)c[b.state]=(c[b.state]||0)+1;console.log(new Date().toISOString(),'convertAll',s.convertAll,'running',s.running,'queued',s.queued.length,JSON.stringify(c));if(s.convertAll==='idle'&&s.running===null&&s.queued.length===0){for(const b of s.boards.filter(b=>b.state==='failed'))console.log('FAILED',b.boardId,b.reason);return}setTimeout(tick,5000)};tick()"
  ```

  One board at a time, in a worker with a 256 MB heap cap. The poll ends when nothing runs or waits.
  `409 MAINTENANCE_REQUIRED` means maintenance is off (audit L6: `convert-all` rewrites every board
  file and runs only inside the window; it takes `{"confirm":true}` to run with boards open, which this
  runbook never does): **stop**, C9's boot maintenance did not hold.
  Any `FAILED` line: that board stays on its tldraw tables, unconverted and closed; **stop** (decide:
  fix forward and convert it again with another `convert-all`, which skips converted boards, or roll
  back). `backup-digest` = that board's records are not the final backup's (an edit landed after C5, or
  C5's run is not the board's newest held set): **stop**. The conversion read the board's newest held,
  tldraw-described entry of the local manifest (`/var/data/backups/<board>/manifest.json`, G4); its
  report carries `backupKey` and `expectedSourceSha256`.
- **C11. Check the conversion** (plan §7.5 step 6, §5.3's table). Sync Shell; it reads only the run-all
  report from C5 and the conversion reports in `/var/data/migration/`:

  ```sh
  node -e "
  const fs=require('fs');const fin=JSON.parse(fs.readFileSync('/var/data/cutover/final-backups.json','utf8'));let bad=0;
  for(const b of fin.boards){let r;try{r=JSON.parse(fs.readFileSync('/var/data/migration/'+b.boardId+'.json','utf8'))}catch{console.log('NO REPORT',b.boardId);bad++;continue}
  const p=[];if(r.ok!==true)p.push('not converted: '+r.reason);if(r.ok&&r.sourceSha256!==b.recordsSha256)p.push('lb_source digest differs from the final backup');
  if(r.sourceMatchesBackup===false)p.push('the sync says the digest differs');if((r.disk&&r.disk.ok)!==true)p.push('disk');
  if(r.diff==null)p.push('no semantic diff');else if(r.diff.ok!==true)p.push('diff: '+r.diff.checks.filter(c=>c.pass!==true).map(c=>c.name+' '+c.failed).join(', '));
  if(r.invariants!=='ran')p.push('invariants '+r.invariants);if(r.violations&&r.violations.length)p.push(r.violations.length+' invariant violations');
  console.log(p.length?'FAIL':'ok  ',b.boardId,r.elementsOut+' elements',JSON.stringify(r.lossy),r.ms+' ms',r.peakHeapUsedMb+' MB',p.join('; '));if(p.length)bad++}
  console.log(bad?bad+' board(s) failed: STOP':'all '+fin.boards.length+' boards converted and checked')"
  ```

  Pass: every board `ok`, the last line "all … boards converted and checked", and the lossy counts as
  rehearsed (R7; the owner signed them off in R9). Copy the output into the log. Anything else: **stop**.
  A board in `final-backups.json` with `"format":"lobby-elements"` (born on the new canvas) cannot occur
  at a first cut-over. With G4 built every converted board's report also says `"sourceMatchesBackup":
  true` and names C5's object in `backupKey`; the script's own digest comparison stays as the independent
  check.
- **C12. The restore point per board** (plan §5.5; G5 built, W4-API-1). One automatic `engine_migration`
  checkpoint ("Moved to the new canvas", `body_version` 2, no author) per converted board, read from the
  new sync's snapshot route (it answers in maintenance). api Shell (UNVERIFIED, §0):

  ```sh
  node apps/api/src/features/history/checkpoint-all-cli.ts --engine-migration > /tmp/engine-migration.json; echo "exit $?"
  ```

  It runs like C6, against `POST /internal/checkpoints/engine-migration` (`GET …/engine-migration/<runId>`
  has the report; `--run <runId> --engine-migration` follows a run). 409 `WRONG_CANVAS` (nothing started)
  means the api's sync still runs tldraw: **stop**. Pass: `"ok": true`, `"failed": 0`, and `saved` equal
  to C11's converted count. A `skipped` row says why: `new-canvas` (born on the new canvas; none at a
  first cut-over), `not-converted` (the board never had a file: nothing to restore), `tldraw` (its
  snapshot is still a tldraw body: the new sync is not serving it; **stop**). Repeating the command saves
  nothing twice (`unchanged`). Copy the report into the log (DEPLOY.md "R0 at the cut-over" step 6 is
  the same command).
- **C13. The static site's settings [OWNER: a Render setting].** Dashboard → `draftroom-staging-web`:
  - Headers: add the patch's `Content-Security-Policy` for `/*` (the value as corrected in P5, on one
    line). Users are in maintenance, so R0's web, still live for a few minutes, running under it does not
    matter.
  - The `/excalidraw-assets/*` rewrite is already there (P6).
  - Environment: add `VITE_LOBBY_ENGINE=excalidraw` without deploying (as in C8). **Keep
    `VITE_TLDRAW_LICENSE_KEY`'s value** until D7: the new build ignores it, and a rollback may rebuild
    R0's web.
- **C14. Deploy the new web [OWNER]** (plan §7.5 step 7; G2 and G3 built, W4-WEB-1: the build is gated
  by `pnpm --filter @draftroom/e2e excalidraw:prod` and `csp:cutover`). Manual Deploy → Deploy a
  specific commit → the cut-over commit (the build takes a few minutes). Checks from the workstation:

  ```sh
  W=https://draftroom-staging-web.onrender.com
  curl -sI $W/ | grep -i -E '^content-security-policy|^x-frame-options'      # the CSP is served
  curl -s -o /dev/null -w '%{http_code}\n' $W/excalidraw-assets/fonts/Nunito/not-there.woff2   # 404
  curl -s $W/ | grep -o '<script[^>]*>' | grep -vc 'src='                     # 0: no inline script
  ```

  A real font answers 200: open a board's network log in C15 or C17 and pick one
  `/excalidraw-assets/fonts/...woff2` request. Old tabs get `CLIENT_TOO_OLD` and show "Reload"; the leave
  guard is kept (plan §7.5 step 7).
- **C15. Smoke in maintenance** (the parts of plan §7.5 step 8 that need no board socket). In Chrome with
  DevTools open: sign in (the console shows 0 CSP violations), the dashboard lists every board, a board's
  History lists C6's checkpoint "Before the move to the new canvas", and a board shows "Lobby is
  updating". Sync Shell: `int GET /internal/backups/status` answers, and
  `node apps/sync/src/backup/restore-drill.ts --from=local --board <one converted board>` passes.
- **C16. Maintenance off** (plan §7.5 step 9; the order differs from the plan, which puts the smoke first:
  maintenance refuses every socket, the smoke's too, so the socket half of the smoke, C17, runs inside
  the still-announced window instead). Sync Shell:

  ```sh
  int POST /internal/maintenance '{"on":false}'   # 200 {"maintenance":false,…}
  ```

  Then **delete `DRAFTROOM_BOOT_MAINTENANCE`** from the sync service without deploying (as in C8)
  **[OWNER: a Render setting]**. While it is set, any restart or deploy starts with every board closed.
- **C17. Smoke with sockets, inside the window** (plan §7.5 step 8). The operator and the helper:
  DEMO.md's flows; two users editing one converted board (both see each other's edits and cursors;
  "Saved" after the edits; a reload keeps them); a phone guest by a name-only link; three more converted
  boards open and look as in the rehearsal; a board created now opens (keep it: B9 checks that R0
  refuses it); the console shows 0 CSP
  violations. From the workstation, `node scripts/smoke/live-smoke.mjs --base <web origin> --expect
  excalidraw` (`engine/smoke`) covers C14's checks, the bundle's hosts, the sign-in page under the header
  and the socket refusal (34 checks on the rehearsal; against a self-signed single-origin edge it needs
  `--api`/`--sync`, an insecure-TLS switch and `NODE_EXTRA_CA_CERTS`, `REHEARSAL.md` §8 D13). Sync Shell:
  `int GET /internal/metrics` shows sessions and commits. Within 15 minutes,
  `int GET /internal/backups/status` shows offsite successes after the cut-over. Anything wrong:
  maintenance on again (`int POST /internal/maintenance '{"on":true}'`) and **stop**.
- **C18. Announce that Lobby is back [OWNER sends].** Write the time in the log: the 24 h go/no-go and the
  48 h window count from here.
- **C19. `render.yaml` [OWNER].** With the Blueprint on Manual Sync (P8), commit the patch to `main`:

  ```sh
  git apply docs/research/excalidraw/render.cutover.yaml.patch
  git diff --stat render.yaml
  ```

  with the CSP line as corrected in P5. Then the Blueprint's manual sync preview must show no change to
  apply (every value is already set by hand); if it shows any, do not sync and find out why. Whether a
  Blueprint sync removes `VITE_TLDRAW_LICENSE_KEY` from the service is UNVERIFIED; the value is needed
  until D7.

## 6. The 48 h watch

- **W1. The first hour.** Every 10 minutes: `int GET /internal/metrics` (sessions, `lobby_commit_failures_total`,
  `lobby_closes_total` by reason, `lobby_event_loop_delay_ms`, `lobby_receive_to_ack_ms`), the sync and
  api logs (errors, `CONVERSION_FAILED`, `RATE_LIMITED`, backpressure closes, `[backup] offsite upload
  failed`), and the service's CPU and memory in the Dashboard (0.5 CPU, 512 MB; plan §2.13 targets:
  RSS ≤ 400 MB, CPU ≤ 80 %).
- **W2. Then every few hours** while someone is awake: the same, plus `int GET /internal/backups/status`
  (every edited board has a recent offsite success) and any report from users. A CSP violation reported
  by a user (a blocked request in their console) is a fix of the header: edit it in the Dashboard (no
  rebuild) and in `render.yaml`.
- **W3. Go/no-go at 24 h [OWNER].** Go: the watch continues to 48 h. No-go: §7. *(Done: the check at about 31 h, 2026-10-03
  04:15Z, read "Go", CUTOVER-LOG §7. Caveat recorded there: nobody had edited a board since the switch, so it saw an idle
  system.)*
- **W4. The window closes at 48 h [OWNER].** After it, a rollback is no longer offered as reversible; R0
  stays the last tldraw build, and the tldraw side of each file stays until D7. *(Closes about 2026-10-03 20:55Z. Open at the
  time of writing: the owner's call to close it after real use, and the watch under real editing.)*

## 7. Rollback to R0 (within 48 h; plan §5.9 step 2, DEPLOY.md "Rollback to R0")

> **Status 2026-10-03: not used.** The cut-over passed and no rollback was made. The window closes about 20:55Z today; after
> that this section is history. The held release adds migration 0024 and `CONTRACTS_REV` 11 (`docs/PROGRESS.md`, "The held
> deploy"), which R0 cannot read, so it is deployed only after the window. Rolling the held release back is a different, smaller
> matter (the web alone, or the sync alone to rev 10, are safe; the api below 0024 needs `DRAFTROOM_ALLOW_NEWER_SCHEMA=1`).

R0 is the only rollback target, never an older build: an older build opens a board born on the new
canvas as an empty tldraw board and writes tldraw tables into it (DEPLOY.md "Rollback").

- **B1. Decision [OWNER].** The owner decides on a rollback. Write the reason and the time in the log.
- **B2. Announce [OWNER sends].** During a rollback, edits made on the new canvas are hidden but kept, and
  boards created on it do not open (Appendix B 5).
- **B3. Maintenance on, on the Excalidraw build.** Sync Shell:
  `int POST /internal/maintenance '{"on":true}'`, then `int GET /internal/maintenance`.
- **B4. The safety copy, before any build changes** (plan §5.9 step 2's export; G7 closed by
  documentation, W4-SYNC). Sync Shell:

  ```sh
  node apps/sync/src/backup/run-all-cli.ts --expect-maintenance > /var/data/cutover/rollback-$(date -u +%Y%m%dT%H%M%SZ).json; echo "exit $?"
  ```

  Exit 0, then copy it into the log. `409 RECENT_HELD_SET` (every board has a held backup from the last
  30 minutes: a rollback within half an hour of C5 **with no board created since**; the board C17 creates
  has no held backup, so the guard does not fire and the first run writes the set, as rehearsed): only
  then add `--force`; C5's set describes the tldraw side,
  this one the lb_* side (`format: lobby-elements-converted`; a board born on the new canvas `lobby-elements`). The held run-all backup on the Excalidraw build in maintenance IS
  the lb_* export: whole files, every `lb_*` table incl. `lb_prev_*` and `lb_source`, described from
  `lb_*` as `lobby-elements-converted`, signed, held 90 days outside retention, drilled and restorable
  (`apps/sync/src/backup/run-all.ts`'s header says why no second format is written; gate
  `apps/sync/test/r0/rollback-safety-copy.test.ts`). Record the report's `offsiteKeys` as the export keys.
- **B5. The static site [OWNER: a Render setting].** Remove the `Content-Security-Policy` header (R0's
  web is not built for it: its inline theme script, its zod probe and tldraw's `data:` fetch break under
  it, spike A12). Static-site settings are not rolled back by a Rollback (DEPLOY.md "Rollback"). The
  `/excalidraw-assets/*` rewrite can stay.
- **B6. R0's api [OWNER].** If the live api has no migration after 0022 (P12): Dashboard →
  `draftroom-staging-api` → Rollback to the R0 deploy recorded in §4. **The cut-over build has one
  (`0023_export_policy_guests`, additive), so this is the "otherwise" case.** Otherwise set
  `DRAFTROOM_ALLOW_NEWER_SCHEMA=1` on the api and Manual Deploy → Deploy a specific commit → `lobby-r0`
  (DEPLOY.md "Rolling the api back past a migration": never Rollback in that case). Check `/healthz` and
  the log (rehearsed: `DRAFTROOM_ALLOW_NEWER_SCHEMA=1 … newerMigrations: ["0023_export_policy_guests"]`).
  While R0's api talks to the Excalidraw sync, it refuses its snapshots, so no empty checkpoint, duplicate
  or export is saved: rehearsed with R0's checkpoint-all against the Excalidraw sync in maintenance, every
  converted board failed with "the sync server answered with a snapshot that is not a tldraw one", the
  born-after board was skipped `new-canvas`, 0 saved, `board_snapshots` unchanged (the api's own routes
  answer 503 `SYNC_UNAVAILABLE` for the same reason).
- **B7. R0's sync [OWNER].** Dashboard → `draftroom-staging-sync` → Rollback to the R0 deploy recorded in
  §4 (Render reuses that deploy's build and its environment, which has no `DRAFTROOM_ENGINE`; R0 ignores
  it anyway, as it ignores `DRAFTROOM_BACKUP_SIGNING_SECRET`: R0 signs its backups with the key derived
  from `DRAFTROOM_INTERNAL_SECRET`, which the new build verifies after the roll-forward). Expect at R0's
  start one line per board and one for the index: `[backup] offsite manifest of board … is signed with
  another key (DRAFTROOM_INTERNAL_SECRET changed?); signing it with the current key, its older entries stay
  as they are`: the Excalidraw build signed them with the dedicated secret, R0 re-signs with its derived
  key; the new build read them again without complaint after the roll-forward (rehearsed). Never roll back
  by unsetting `DRAFTROOM_ENGINE` on the new build. **R0's sync starts with
  maintenance off: boards open on R0 as soon as it is live.** Converted boards are served from their
  tldraw tables, which hold the state of C5; R0 never writes any lb_* table; boards born on the new canvas
  are refused.
- **B8. R0's web [OWNER].** Dashboard → `draftroom-staging-web` → Rollback to the R0 deploy (Render reuses
  the built artifact, the tldraw key inlined). Load a board for more than 6 s: no tldraw licence blank
  (DEPLOY.md "tldraw license key").
- **B9. Checks.** DEPLOY.md "Checking it after the deploy" items 1, 2 and 5; a converted board opens and
  edits on tldraw (rehearsed: R0 served the converted boards from their tldraw tables at C5's state, the
  Excalidraw edits hidden, not lost); the board created in C17 shows "This board was made on the new canvas…"
  (R0's web shows it as its own page, `data-testid="new-canvas-board"`, before any socket; its ticket
  route answers 409 `NEW_CANVAS`; the sync's internal snapshot 409 `new-canvas`; its file byte-identical
  afterwards); the dashboard shows its "New canvas" badge (G6: 2A's wave-5 `apps/api/src/canvas-engine.ts` writes both columns; W4-API checked it).
  Editing on tldraw through its UI: drag in one pointer gesture (a click then a drag within a double-click
  reads as text editing) and press Escape before a tool key (R0's COL-04 types a key into the one selected note).
- **B10. Announce [OWNER sends].** Lobby is back on its previous canvas. Edits made on the new canvas
  since the cut-over come back with the roll-forward.

## 8. Roll-forward (redeploying the Excalidraw build; plan §5.9 step 3)

- **F1. Decision [OWNER]**, after the cause of the rollback is fixed (a new cut-over commit, gated as P2).
- **F2. Announce [OWNER sends]** a window, as C2.
- **F3. Maintenance on, on R0**: C4's commands.
- **F4. A backup of the rollback's edits**: C5's command, into
  `/var/data/cutover/before-rollforward-<time>.json` (held 90 days). The roll-forward's base is
  `lb_source` in each file and needs no network; this is the disaster copy of the tldraw side.
- **F5. The new api [OWNER]**: as C7. Remove `DRAFTROOM_ALLOW_NEWER_SCHEMA` if B6 set it, in the same
  step.
- **F6. The sync, booting in maintenance [OWNER]**: set `DRAFTROOM_BOOT_MAINTENANCE=1` (and
  `DRAFTROOM_ENGINE=excalidraw` and `DRAFTROOM_BACKUP_SIGNING_SECRET` if they are gone) as in C8, then
  deploy the new sync as in C9, with C9's checks.
- **F7. Merge both sides**: `int POST /internal/migrate/convert-all` and C10's poll. It rolls forward
  every converted board whose tldraw side moved during the rollback, and converts the boards created on
  R0 (plan §5.3 "Lazy", §5.9 step 4). Then check the reports:

  ```sh
  node -e "const fs=require('fs');let bad=0;for(const f of fs.readdirSync('/var/data/migration').filter(f=>f.endsWith('.rollforward.json'))){const r=JSON.parse(fs.readFileSync('/var/data/migration/'+f,'utf8'));const v=(r.violations||[]).length;console.log(r.ok&&v===0?'ok  ':'FAIL',f,r.ok?'':r.reason,'cycle',r.cycle,'conflicts',(r.conflicts||[]).length,'violations',v,'resnap',r.resnap);if(r.ok!==true||v>0)bad++}console.log(bad?'STOP':'roll-forward reports ok')"
  ```

  Rehearsed on one board: a frame moved on R0 while the Excalidraw side moved one of its children left
  the child at the Excalidraw position plus the frame's delta (`parentMoved`, no conflict); the same note
  moved on both sides was listed as the one `pos` conflict, R0's position kept and the Excalidraw one in
  `lb_prev_1_elements`; both sides' new notes were present; `converted_from.sourceSha256` equalled F4's
  `recordsSha256` and `cycle` 1. Boards untouched on R0 need no job and are not listed.
  A board whose `lb_source` digest no longer matches stays closed (`base-digest`, plan §5.9 step 3):
  **stop**, the owner is told. The listed conflicts (element ids and group names, never content) go into
  the log; the Excalidraw side's values are kept in `lb_prev_<cycle>_*`. Boards created on R0 and
  converted now have a `<board>.json` report; F4's run-all (R0's, no `format`, held) is their newest
  held entry, so the conversion checked their digest against it and set `backupKey` (G4), but C11's
  script, which reads C5's list, does not list them: check each by eye (`ok`, `sourceMatchesBackup`
  true, `diff.ok`, `invariants` "ran", no violations).
- **F8. The web**: the CSP header back (C13), then deploy the new web (C14 with its checks).
- **F9. Maintenance off, the flag deleted, the smoke**: C15, C16, C17.
- **F10. Announce [OWNER sends].** The owner decides whether the 48 h window starts again. A second
  rollback and roll-forward work the same way: each merges against the base the last one left
  (`converted_from.cycle`).

## 9. Clean-up

> **Status 2026-10-03: all three still ahead.** D7 is due about 2026-10-08. It is under the owner's standing OK ("auto
> drop-legacy after 7 days", memory of 2026-10-01) but waits on the owner's Shell checks (CUTOVER-LOG §6 steps 2 and 3: the
> per-board conversion reports, `restore-drill --from=local`, `df -B1 /var/data`, `schema_migrations` listing 0023) and on the
> lossy counts being signed off. `VITE_TLDRAW_LICENSE_KEY` is still set on the web service and declared `sync: false` in
> `render.yaml`; it comes off after D7. D30 is about 2026-10-31 (review the collector's reports first).

- **D7. drop-legacy [OWNER]** (day 7 after C18, plan §5.9 step 5; G8 built, W4-SYNC). Only after the
  window has closed and the owner says so. Maintenance on (C4's commands; the room's writes would wait
  on `VACUUM` otherwise), then Sync Shell, a dry run first:

  ```sh
  int POST /internal/migrate/drop-legacy '{"confirm":"drop-legacy","dryRun":true}'   # 202 {"started":true,...}
  int GET /internal/migrate/status                                                   # poll until "dropLegacy" is idle
  ```

  Read each board's state and reason in the status (kind `drop-legacy`) and in
  `/var/data/migration/<board>.drop-legacy.json` (table names, bytes, times; no content), then run the
  same command without `dryRun`. It removes, one board at a time through the migration worker, the
  tldraw tables, `dr_deleted_*`, `lb_source` and every `lb_prev_<cycle>_*`, then `VACUUM` and a WAL
  checkpoint; unknown tables are listed and left alone. Guards: `window` = less than 7 days since that
  board's conversion or its newest roll-forward (wait, or `"force":true` with the owner's OK; the report
  then says `forced`); `window-unknown` = no import row dates the conversion (force overrides);
  `not-converted` and `rollforward-pending` are never dropped, force or not: **stop** and look;
  `nothing-to-drop` for boards born on the new canvas or already stripped; 409 `BUSY` while a
  `convert-all` runs; 400 without `"confirm":"drop-legacy"`. After it, a rollback to R0 is no longer
  possible (R0 classifies the files converted-without-tldraw and refuses them). Then remove
  `VITE_TLDRAW_LICENSE_KEY` from the static site and the tldraw key is no longer needed (plan §7.5 step
  10). Delete `/var/data/cutover/` once its reports are in the log.
- **D30. The asset collector may leave report mode [OWNER]** (plan §5.8).
- **D90.** The final backup set (C5) and every other held backup age out by themselves when `holdUntil`
  passes (DEPLOY.md "run-all").
- **After D7:** DEPLOY.md loses its tldraw sections (licence key, R0's rollback) in a docs change, and
  `docs/research/SYNTHESIS.md` stays as the tldraw era's history (plan §10).
