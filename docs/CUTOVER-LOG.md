# Lobby: the Excalidraw cut-over on staging (2026-10-01)

Status: **done 2026-10-01 20:43–20:56Z on Render staging.** Every step of `docs/EXCALIDRAW-CUTOVER.md` C4–C17
passed as adapted below; the 4 real boards were converted, checked and are served on the Excalidraw canvas;
all three services run the cut-over commit `bbe1b48` (`main`). The 24 h go/no-go (W3) falls at about
2026-10-02 20:55Z and the 48 h window (W4) closes at about 2026-10-03 20:55Z; drop-legacy (D7) is day 7, about
2026-10-08, with the owner's OK. The owner's checks are in §6.

This page holds ids, counts, digests (prefixes), clocks, object keys and timings only: no board content, no
secret. The reports named below are in the cut-over log folder on the workstation, outside the repository:
`C:\Users\Chase\Documents\Lobby-cutover\2026-10-01\` (`01-smoke-r0-baseline.json`, `02-final-backups.json`,
`03-checkpoints.json`, `04-engine-migration.json`, `05-smoke-excalidraw-in-maintenance.json`,
`06-csp-report-only-header.txt`, `07-smoke-excalidraw-live.json`). Keep them; never commit them.

## 1. What ran, and how the runbook was adapted

| Part | Value |
|---|---|
| Operator | an agent on the workstation, through the Render API (`RENDER_API_KEY` from `.env.deploy.local`, nothing else read from it) and the services' **public** `/internal/*` routes with the internal secret (read in-process from the Render env group `draftroom-staging-secrets`, held in memory, never printed or written). The Dashboard Shells were not used: the runbook's CLIs (`run-all-cli.ts`, `checkpoint-all-cli.ts`) ran on the workstation with `--url <public origin>` and the secret in the child process's environment. |
| R0 (live before) | `main` 38d3833 on all three services (api `dep-dau9lag93c1s73db0310`, sync `dep-dau9ll7avr4c7389qe8g`, web `dep-dau9m4hsrm7s73bc9oug`); `main`'s head ec344cd was a docs-only commit beyond it. Tagged **`lobby-r0` = 38d3833** and pushed (P12). |
| The cut-over commit | **`bbe1b484fa496bb6d9ee4b80bc6645e1bc3a3105`** = `origin/engine/excalidraw` a39a1c5 merged into `main` (merge-base 2a4e5a6; no conflict; `render.yaml` restored to `main`'s version in the merge commit so that no Blueprint sync fires: the headers, the route rule and the env values were applied through the Render API instead, recorded in `docs/DEPLOY.md`). AGENTS.md on the merged tree is `engine/excalidraw`'s (the §10 rewrite had already been applied there; no `AGENTS.next.md` exists). |
| Boards | b-0gazyr0d3e, b-7gw2v3e61a, b-e7mx42m5yt, b-esfzg8j7zo (1 user, 1 workspace) |
| Owner approvals used | go now (the 3-day floor waived, 2026-10-01); roll back without asking if a check fails; apply the prepared Render changes (nothing paid, no plan change); keep the final backups 90 days; keep `VITE_TLDRAW_LICENSE_KEY` on the web service until day 7 |
| Lead decisions applied | the CSP shipped as **`Content-Security-Policy-Report-Only`** (a real Clerk sign-in under the enforced header is not verified yet); `render.yaml` on `main` unchanged in this cut-over |

Adaptations (each is also marked in §2):

- **A1. Where the gate ran.** `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm licence:check` ran on the merged tree **before** C4 (not inside the window); the push to `main` happened after C6, as the task ordered.
- **A2. P6, the `/excalidraw-assets/*` rule.** Render answers the patch's rewrite destination (`/excalidraw-assets/__not-found__`) with **`200`, `Content-Length: 0`, no content type**, not a 404 (measured 20:38–20:42Z on R0's build; the SPA's `index.html` was not returned either). The rule's destination was changed to **`https://draftroom-staging-api.onrender.com/excalidraw-assets/*`**: Render serves a real font file itself (a rule is skipped when the file exists) and proxies a miss to the api, whose unknown-route answer is a real `404 application/json` (the same mechanism as the `/api/*` and `/files/*` rules; a 401 passes through them today). Verified: miss → 404 JSON, `/b/anything` → 200 HTML, `/api/me` → 401, a real Excalifont file → 200 `font/woff2`. `docs/research/excalidraw/render.cutover.yaml.patch` must be corrected to this destination before C19 (its header says so now).
- **A3. The CSP header's name.** `Content-Security-Policy-Report-Only`, value = the patch's line (Clerk frontend API `splendid-flamingo-3744.clerk.accounts.dev`, `img.clerk.com`, `clerk-telemetry.com`, `challenges.cloudflare.com`, the sync origin). The smoke script looks for the enforced header name, so its one `FAIL content-security-policy: missing` is the expected reading of this decision; the report-only header's directives were checked separately with the same eight expectations (all pass, `06-csp-report-only-header.txt`). The browser still fires `securitypolicyviolation` events under a report-only policy, so the smoke's "0 CSP violations" on the sign-in page is a real measurement.
- **A4. C8.** `DRAFTROOM_ENGINE=excalidraw` was set as the runbook lists (this build accepts unset or `excalidraw`, `apps/sync/src/config.ts`), with `DRAFTROOM_BOOT_MAINTENANCE=1` and a generated `DRAFTROOM_BACKUP_SIGNING_SECRET` (44 characters from `crypto.randomBytes(32)`, sent to Render only). The three `PUT /env-vars/<key>` calls triggered no deploy (the live deploy id was unchanged 30 s later; maintenance still on).
- **A5. C11's script.** The conversion reports (`/var/data/migration/<board>.json`) are on the sync disk, which the workstation cannot read. The check was made from the outside instead: a conversion that fails its final-backup digest, its semantic diff, the invariant checker, the disk check or the limits ends `failed` with that reason (`convert-board.ts`: `backup-digest`, `diff`, `invariants`, `disk`, `limits`, `source-digest`), and `GET /internal/migrate/status` showed every board `done`; each board's live snapshot (`GET /internal/boards/<id>/snapshot`, counts only) is `lobby-elements`; C12's record counts equal the snapshots' element counts. The lossy codes are not visible from outside: the owner reads them in the sync Shell (§6).
- **A6. C13 ran in parallel with C9** (20:48:37Z, while the sync deployed): a report-only header blocks nothing on R0's web, and users were in maintenance.
- **A7. C15 and C17's human parts** (a real sign-in in Chrome, two users editing, a phone guest, a board created now, the History panel in the UI, `restore-drill --from=local` in the Shell) did not run: the smoke's headless sign-in page, the api's and sync's routes and the sync's internal snapshot of each board stood in. They are the owner's checks (§6).
- **A8. The CDN after C14.** A check 15 s after the web deploy went live still read the CDN's cached R0 `index.html` (entry `index-BVxzb3fe.js`, 1 inline script); from about 50 s after "live" the new index was served (`last-modified` 20:52:13Z, `cf-cache-status: MISS`). The C14 checks below are from the new index.
- **A9. Migration 0023.** The api logs nothing for an applied migration (only for `DRAFTROOM_ALLOW_NEWER_SCHEMA`), and the workstation has no database access, so `schema_migrations` was not read; the api started and serves (the runner applies pending migrations at start or refuses to start). Owner check in §6.
- **A10. Commit attribution.** The commits end with the harness's attribution line for this session (`Claude Fable 5.1`), not the `Opus 5.5` line the task text named.

## 2. The steps, timed (UTC, 2026-10-01)

| Step | Start | Result | Evidence (ids, counts, timings) |
|---|---|---|---|
| Worktree, install, runbook read | 20:30 | PASS | `Draftroom-cutover` on `cutover/excalidraw` from `origin/main` ec344cd; `pnpm install --frozen-lockfile` 9.3 s |
| Pre: Render API, services, deploys | 20:34 | PASS | all three live on 38d3833, no deploy running, `autoDeploy=no`; env group `draftroom-staging-secrets` readable (2 vars) |
| Pre: health, internal routes on R0 | 20:40:11 | PASS | api and sync `/healthz` 200; `GET /internal/maintenance` `{"maintenance":false}`; backups status store r2, `failuresTotal` 0, offsite counts 1/1/1/4; `GET /internal/checkpoints/run-all` `{"runs":[]}`; `/internal/canvas` 404 on R0 (expected) |
| Pre: disk (P4) | 20:38 | PASS | sync disk usage 1,097,728 B of 1,020,702,700 B (Render metrics API) |
| Pre: smoke `--expect r0` (baseline) | 20:36:53 | PASS | 22 passed, 0 failed, 1 warning (sync socket: the edge hides the close frame; same on every run), 27 info; JSON written 20:40:24 (`01-smoke-r0-baseline.json`) |
| Merge (local) | 20:36:10 | PASS | `bbe1b48`; `render.yaml` identical to `main` (0 diff lines); 1,588 files changed |
| Gate: lint, typecheck (A1) | 20:37 | PASS | biome: 1,746 files, 0 errors, 4 warnings; `tsc` in every project |
| Gate: unit tests (A1) | 20:37:00 | PASS | vitest: 446 files passed, 9 skipped; 4,492 tests passed, 36 skipped; 86.8 s |
| Gate: licence check (strict) | 20:38 | PASS | `Result: PASS` (2 allowlisted: sharp win32, khroma) |
| P6 route rule, first form (A2) | 20:38:30 | **not a 404** | `PUT /services/<web>/routes` with the patch's destination: miss → `200`, empty body |
| P6 route rule, corrected (A2) | 20:42:45 | PASS | destination = the api; miss → `404 application/json`; Liberation path → 404; `/b/anything` 200 HTML; `/api/me` 401; `/assets/not-there.js` 404 |
| **C4** maintenance on (R0) | 20:43:44 | PASS | `{"maintenance":true,"closedSockets":0}`; GET `{"maintenance":true}` |
| **C5** run-all `--expect-maintenance` | 20:44:05 | PASS | `run_9a7bc8889777fb57`, exit 0: `ok` true, `offsite` r2, `inMaintenance` true, 4 boards, run 20:44:06.520–20:44:09.974Z; b-0gazyr0d3e clock 3, 43 records, sha `ea02f085…`, 98,304 B, key `backups/sync/b-0gazyr0d3e/2026-10-01T20-44-06-557Z-c3.sqlite`; b-7gw2v3e61a clock 1, 64, `8474f443…`, 102,400 B, `…T20-44-07-737Z-c1.sqlite`; b-e7mx42m5yt clock 15, 4, `cd8de466…`, 69,632 B, `…T20-44-08-467Z-c15.sqlite`; b-esfzg8j7zo clock 83, 33, `b55f33d7…`, 106,496 B, `…T20-44-09-212Z-c83.sqlite`; **`holdUntil` 2026-12-30T20:44:06.520Z** on every board (90 days) |
| **C6** checkpoint of every board (api) | 20:44:36 | PASS | `run_228bb0e5d82ce230`, exit 0: `ok` true, 4 saved ("Before the move to the new canvas"), 0 unchanged/skipped/failed; snapshots `snp_pxT8sbDDzGpzBjmbyVl6`, `snp_t7VgS1Nqom8ppskTHeUU`, `snp_uNVPVMBWqbAtdytK0TRY`, `snp_ZCvwErbxvc5ahkTDaBgV`; clocks 3/1/15/83 = C5's: **`clocks match`** |
| Step 5: push `main` | 20:45:18 | PASS | `origin/main` = `bbe1b48`; no Blueprint sync (render.yaml unchanged), no auto-deploy |
| **C7** api deploy | 20:45:23 | PASS | `dep-davccotg1s2s739vbmn0`, live after 63 s; `/healthz` 200; 0 `error` lines; migration 0023: see A9 |
| **C8** sync env (A4) | 20:46:28 | PASS | `DRAFTROOM_BACKUP_SIGNING_SECRET` (generated), `DRAFTROOM_ENGINE=excalidraw`, `DRAFTROOM_BOOT_MAINTENANCE=1`; no deploy triggered; maintenance still true at 20:47:02 |
| **C9** sync deploy, booting in maintenance | 20:47:36 | PASS | `dep-davcdqegekts73dgut70`, live after 52 s; boot log 20:48:22Z: `[maintenance] on at start (DRAFTROOM_BOOT_MAINTENANCE=1)`, `[backup] offsite backups: r2`, `[backup] offsite backups signed with DRAFTROOM_BACKUP_SIGNING_SECRET (key id 1b7c98684d31b232); the key derived from DRAFTROOM_INTERNAL_SECRET (key id 8853c19108f89020) only verifies older backups`; checks at 20:50:01 (two edge 502s at 20:48:34 during the instance switch): `{"maintenance":true}`, `/internal/canvas` `{"engine":"excalidraw"}`, `/internal/migrate/status` 200 `convertAll idle`, `runtimeCapMb` 98 |
| **C10** convert-all | 20:50:22 | PASS | 202; 20:50:28 idle: **4 done, 0 failed**; `kind convert`, `mode maintenance`, `capMb` 256; ms 1,190 / 1,229 / 1,052 / 1,165; peak heap 31.8 / 31.6 / 28.8 / 32.6 MB |
| **C11** check (A5) | 20:50:55 | PASS | snapshots `format lobby-elements`, `schema` 1, `clock` 1, elements **49 / 76 / 2 / 33** (b-0gazyr0d3e had 43 records, two more than at the rehearsal, hence 49 not 47); backups status `failuresTotal` 0, offsiteCount 2/2/2/5; 0 `error` lines on sync and api |
| **C12** engine-migration checkpoints (api) | 20:51:01 | PASS | `run_75f9eb2aad118940`, exit 0: `ok` true, 4 saved ("Moved to the new canvas"), 0 skipped/failed; records 49/76/2/33 = the snapshots; snapshots `snp_tl4R9gHbDMwaKCogl4iQ`, `snp_cWU7GZpBL8U3flWdZj03`, `snp_uRE1uDhkev1kGsgYaJRh`, `snp_yQHTgIbAKAt0NrNi47Hl` |
| **C13** web headers (A3, A6) | 20:48:37 | PASS | `PUT /services/<web>/headers` (replaces all): `Content-Security-Policy-Report-Only` for `/*` added (`hdr-davce9jbc2fs73cbmcdg`); the four existing headers kept with new ids; served at 20:49:0x |
| **C14** web deploy | 20:51:42 | PASS | `dep-davcfnvpn0mc73cgibj0`, live after 32 s (vite `built in 5.03s`, the host-rewrite plugin ran 3,196 calls); new index (A8): 0 inline scripts, `/theme-boot.js` and `/zod-jitless.js` 200 `application/javascript`, CSP-RO served, no enforced CSP, miss → 404 JSON, `Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2` → 200 `font/woff2`, 23,600 B |
| **C15** smoke in maintenance (A7) | 20:53:41 | PASS | `--expect excalidraw`: 24 passed, 1 failed (the CSP header name, A3), 1 warning (edge close frame), 13 info; 10 index chunks, 189 files in the bundle closure (11.1 MB); foreign hosts none but Clerk's; engine markers excalidraw present, tldraw absent; headless sign-in page 200 in 3.8 s, **0 CSP violations**, 0 console errors, requests to the web origin (16), the Clerk frontend API (16), `img.clerk.com` (2) only (`05-smoke-excalidraw-in-maintenance.json`) |
| **C16** maintenance off, flag deleted | 20:54:51 | PASS | `{"maintenance":false}`; `DRAFTROOM_BOOT_MAINTENANCE` deleted 20:54:52; no deploy triggered (live still `dep-davcdqegekts73dgut70`); `{"maintenance":false}` at 20:55:19 |
| **C17** smoke live (A7) | 20:55:42 | PASS | 24 passed, 1 failed (A3), 1 warning; the sync logged the probe as `[connect] refused on board b-live-smoke: malformed` (not MAINTENANCE) (`07-smoke-excalidraw-live.json`) |
| **C17** boards open | 20:56:02 | PASS | the four snapshots again (rooms opened with maintenance off): 49/76/2/33 elements; metrics `lobby_rooms_open 4`, sessions 0; migrate status idle (no lazy conversion); backups `failuresTotal` 0; 0 `error` lines; sync log `[maintenance] off` |
| Final state | 20:56 | PASS | api `dep-davccotg1s2s739vbmn0`, sync `dep-davcdqegekts73dgut70`, web `dep-davcfnvpn0mc73cgibj0`, all `bbe1b48` live |

**Window numbers (R11).** C4 → C16: **11 min 07 s** (20:43:44 → 20:54:51), of which the three deploys took 63 + 52 + 32 s and
the conversions 6.6 s; the rest was the operator's checks between steps. The CLIs polled at 1 s.

## 3. The conversion, per board

| Board | Records in (C5) | Clock (C5) | Elements out | ms | Peak heap (MB) | State | C12 checkpoint |
|---|---|---|---|---|---|---|---|
| b-0gazyr0d3e | 43 | 3 | 49 | 1,190 | 31.8 | done | saved, 49 records |
| b-7gw2v3e61a | 64 | 1 | 76 | 1,229 | 31.6 | done | saved, 76 records |
| b-e7mx42m5yt | 4 | 15 | 2 | 1,052 | 28.8 | done | saved, 2 records |
| b-esfzg8j7zo | 33 | 83 | 33 | 1,165 | 32.6 | done | saved, 33 records |

Every conversion compared its records with the board's newest held, tldraw-described manifest entry (C5's set, G4) and
would have ended `failed` (`backup-digest`) otherwise; the same for the semantic diff and the invariant checker (A5). The
lossy codes (the rehearsal saw `geo-approximated` 1, `geo-polygon` 1 on b-esfzg8j7zo) are in `/var/data/migration/<board>.json`
on the sync disk (§6).

## 4. What is live now

- **api, sync, web:** `main` `bbe1b48`. The sync's environment: `DRAFTROOM_ENGINE=excalidraw`, `DRAFTROOM_BACKUP_SIGNING_SECRET`
  (set by hand; never in git), `DRAFTROOM_BACKUP_STORE=r2` and the `R2_*` values as before; **no** `DRAFTROOM_BOOT_MAINTENANCE`
  (deleted at C16, so a restart starts open). The web's environment: `VITE_DRAFTROOM_SYNC_ORIGIN`, and `VITE_TLDRAW_LICENSE_KEY`
  kept until D7 (the new build ignores it). No `VITE_LOBBY_ENGINE` (gone since G10).
- **The static site's rules:** routes `/api/*` → api, `/files/*` → api, `/excalidraw-assets/*` → api (the 404 for a miss, A2),
  `/*` → `/index.html`; headers `Content-Security-Policy-Report-Only` (the patch's line), `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy` for `/*`, `Cache-Control` for `/assets/*`. Exact values in `docs/DEPLOY.md`.
- **`render.yaml` on `main` is unchanged** (C19 pending, Blueprint on Manual Sync first): it still declares `VITE_TLDRAW_LICENSE_KEY`
  and lacks the route rule, the CSP header, `DRAFTROOM_ENGINE`, `DRAFTROOM_BACKUP_SIGNING_SECRET` and `DRAFTROOM_BOOT_MAINTENANCE`.
- **Backups:** the final set (C5) is held to 2026-12-30 in R2 under `backups/sync/<board>/2026-10-01T20-44-0x-…-c<clock>.sqlite`;
  the new sync signs with the dedicated secret (key id `1b7c98684d31b232`) and verifies R0's with the derived key (`8853c19108f89020`).
- **Rollback targets (§7 of the runbook, within 48 h):** tag `lobby-r0` = 38d3833; R0's deploys api `dep-dau9lag93c1s73db0310`,
  sync `dep-dau9ll7avr4c7389qe8g`, web `dep-dau9m4hsrm7s73bc9oug`. The api needs `DRAFTROOM_ALLOW_NEWER_SCHEMA=1` and
  *Deploy a specific commit* → `lobby-r0` (migration 0023; B6); remove the CSP-RO header (B5; harmless either way, as it only
  reports); B3's maintenance and B4's safety copy first.

## 5. Checks that did not run (honest list)

- A real Clerk sign-in, DEMO.md, two users editing one board with cursors, a phone guest, a board created after the cut-over, the
  History panel in the UI (C15, C17; A7).
- `restore-drill --from=local --board <id>` in the sync Shell (C15).
- The conversion reports' lossy codes, `diff` and `invariants` fields read directly (C11; A5).
- `schema_migrations` listing 0023 (C7; A9).
- The side-by-side comparison of boards and the owner's sign-off of the lossy counts (P3/R9), the real iPhone/iPad session (P10),
  the Blueprint's Manual Sync setting (P8), the tldraw key's expiry date (P7).

## 6. What the owner should check now (in this order)

1. Sign in on https://draftroom-staging-web.onrender.com in Chrome with DevTools open: the dashboard lists the 4 boards; open
   each board, edit, reload; the console shows no `[Report Only]` CSP line (a report-only violation is logged, not blocked);
   two browsers on one board see each other's edits and cursors and "Saved"; a phone by a name-only link; the History panel
   lists "Before the move to the new canvas" and "Moved to the new canvas"; create a board and keep it (B9's born-after check).
2. Sync Shell (Dashboard → `draftroom-staging-sync` → Shell): `cat /var/data/migration/b-esfzg8j7zo.json` and the other three
   (ids and counts only): `ok` true, `sourceMatchesBackup` true, `diff.ok` true, `invariants` "ran", `violations` empty, the
   lossy codes as rehearsed; `node apps/sync/src/backup/restore-drill.ts --from=local --board b-e7mx42m5yt` → PASS;
   `df -B1 /var/data`.
3. api Shell or the database: `schema_migrations` lists `0023_export_policy_guests` (A9).
4. The 48 h watch (runbook §6): `GET /internal/metrics`, `GET /internal/backups/status` (an offsite success for every edited board
   within 15 minutes), the services' CPU and memory; go/no-go at 24 h (about 2026-10-02 20:55Z).
5. The CSP: once a completed real sign-in shows 0 report-only lines on the sign-in page, the dashboard and a board, rename the
   header to `Content-Security-Policy` (Dashboard → `draftroom-staging-web` → Headers, or `PUT /v1/services/<web>/headers`; no
   rebuild). Until then it reports.
6. C19 (`render.yaml`), after the Blueprint is on Manual Sync (P8): apply `docs/research/excalidraw/render.cutover.yaml.patch` with
   the route destination corrected to the api (A2) and the header name as decided in step 5; the Blueprint's sync preview must then
   show nothing to apply.
7. D7 (about 2026-10-08, owner OK): drop-legacy (runbook §9), then remove `VITE_TLDRAW_LICENSE_KEY` from the web service.

## 7. The watch (W3), checked 2026-10-03 04:15Z (about 31 h after the switch)

**Go.** Read-only checks, no change made:

- api and sync `/healthz` 200, the web site 200; all three still on `bbe1b48`; no deploy, restart or out-of-memory event on
  api or sync since the cut-over deploys (Render service events).
- Logs since 2026-10-01 20:57Z: 0 `error` and 0 `FATAL` lines on api and sync.
- Sync `GET /internal/maintenance` `{"maintenance":false}`; `GET /internal/backups/status` store r2, `failuresTotal` 0, every
  board `failures` 0 and `pending` 0, offsite counts 3/3/3/6, the backup loop's last pass 04:03Z.
- Metrics: `lobby_rooms_open` 0, no sessions, 0 commits since the process started; event-loop delay p50 10 ms, p99 12 ms.
- Caveat: nobody has edited a board since the switch (every board's last offsite copy is the clock-1 copy from 21:03Z on
  2026-10-01), so the watch shows a healthy idle system, not one under use. The owner's real sign-in (§6 step 1) is still the
  check that matters, and it is due before the 48 h window closes at about 2026-10-03 20:55Z.
- **CSP enforced 2026-10-03 ~05:10Z** (owner pre-approval 2026-10-01, §6 step 5). The feature audit before it (workflow
  `lobby-csp-audit`): four static reviewers by directive group (script/worker/wasm, connect, img/media/font/style,
  frame/form/object/navigation), each checked by an independent verifier, and the whole Excalidraw e2e suite (96 specs, 467 tests,
  0 failed) run under the policy as report-only with a local report collector and a positive control (data:, eval, wasm-eval and
  blob: media reports all arrived). One real finding: an export of a board holding file cards fetches the card faces from
  same-origin `blob:` URLs (`connect-src` lacked `blob:`; the export would lose the faces). Ruled out with evidence: Excalidraw's
  WASM/eval font subsetter (Lobby passes `skipInliningFonts: true`), pica WASM (the engine's image tool is off), zod's JIT (the
  jitless shim loads first; one zod copy in the bundle), mermaid paste (no eval), embeddables (`validateEmbeddable` refuses all),
  video (same-origin `/files`), the timer chime (WebAudio oscillator), link previews (served by the api), the PDF export worker
  (same-origin). Added: `blob:` to connect-src, and Clerk's documented Protect hosts (off on this instance; added so turning it on
  cannot break sign-in). The api's sandbox CSP on `/files` answers is untouched (Render's static headers do not reach rewritten
  answers; measured). After the switch: headless loads of `/`, `/signin`, `/b/<id>`, `/invite/<id>`: Clerk loaded, sign-in form
  drawn, 0 violations, 0 CSP console lines, 0 page errors, 0 failed requests. **A rollback to R0 must remove the enforced header
  first** (docs/DEPLOY.md).
- **C19 done 2026-10-03** (Blueprint on Manual Sync first): `render.yaml` declares the `/excalidraw-assets/*` → api rule before the
  SPA fallback, the enforced CSP (byte-equal to the live value), sync's `DRAFTROOM_ENGINE=excalidraw` and the `sync: false`
  entries `DRAFTROOM_BOOT_MAINTENANCE` and `DRAFTROOM_BACKUP_SIGNING_SECRET`; `VITE_TLDRAW_LICENSE_KEY` stays declared
  `sync: false` until D7 (so no sync can drop it while a rollback could still need it), and `VITE_LOBBY_ENGINE` is NOT added back
  (the patch's hunk 3 was out of date). A drift check of every declared field against the live services, env groups and the web's
  routes and headers shows **0 differences**, so a manual Blueprint sync has nothing to apply; the file validates against Render's
  published schema (ajv, draft 2020-12).
- P8 done 2026-10-03 ~04:40Z: the Blueprint `draftroom-staging` was still on auto-sync; it was switched to Manual Sync through
  the Render API (`autoSync` false, status `paused`; owner pre-approval 2026-10-01). Services' auto-deploy is off (`autoDeployTrigger`
  off on api, sync and web). The owner's real sign-in check (§6 step 1) passed the same day: 0 Lobby CSP lines (the only console
  lines came from a browser extension's content script), boards open, edit and reload, two browsers see each other.
- **Wave A deployed 2026-10-03 08:02–08:07Z** (`main` `0644365`; api → sync → web, the order the wave needs: the new web's
  +1 on locked notes, locked-frame reorder and guest tags need the new sync's rules). api live in 52 s (domain-access policy loaded,
  0 errors); sync live in 62 s, `/healthz` 502 for about 40 s after Render reported live (the disk service's boot), then 200,
  maintenance off, backups running with the dedicated signing key, 0 errors; web live in 31 s. Live smoke
  (`scripts/smoke/live-smoke.mjs --expect excalidraw`, from `engine/smoke`): 33 passed, 0 failed, 1 known warning (the edge hides
  the sync's refusal code). No migration, no storage or converter change, so the rollback paths are unchanged (the R0 rollback must
  still drop the enforced CSP first). The watch continues on this build.
- **Wave B (B1-B5) deployed 2026-10-03 10:55–10:59Z** (`main` `99d902c`; api → sync → web, the order L7 needs: the new web offers
  the ticket only as a `lobby.ticket.*` subprotocol, which only the new sync reads). Checked before the web went out: through
  Render's edge (Cloudflare) a handshake offering `lobby.board.v1, lobby.ticket.<t>` gets `101` with `Sec-WebSocket-Protocol:
  lobby.board.v1`, on the old sync and the new one; the new sync reads the ticket from the subprotocol and from `?ticket=` (both
  logged `refused … bad_signature` for a bogus one, the ticket itself in no log line), so tabs opened before the deploy keep
  connecting. api live in 42 s, sync in 52 s (`/healthz` 200 ten seconds later; maintenance off; backups 0 failures), web in 31 s.
  Live smoke 33 passed, 0 failed, the known warning; 0 `error`/`FATAL` lines on api and sync. No migration (still 0023). Held for
  after 20:55Z on `wave-b/held`: migration 0024 (selection votes, the access-granted bell) and the smoke script.
- **Wave C (C1, C3, C4, C5) deployed 2026-10-03 15:18–15:19Z** (`main` `9627f29`; api → web; the sync stays on `99d902c`, as no
  sync, protocol or migration file changed). api live in 42 s, web in 31 s. Live smoke 33 passed, 0 failed, the known warning; 0
  `error`/`FATAL` lines. The web bundle closure fell from 189 files (11.1 MB) to 96 (7.8 MB), since Mermaid is stubbed out (C1).
  Held for after 20:55Z on `release/held`: migration 0024 (wave B's B6) and push receipts (`CONTRACTS_REV` 11, C2). The lead
  reverted C2's CR-2B-2 there: it moved a port of tldraw 5.4.2's geo geometry into `packages/canvas-schema`, i.e. into the
  web bundle. Leaving tldraw was a licence decision, so tldraw-derived code stays in the server-side converter only. The polygon
  tools keep Lobby's own outlines (W5-33 D4 stays open).
- **The held release deployed 2026-10-03 21:09–21:12Z**, after the 48 h rollback window closed at 20:55Z (`main` `e2cb709` = merge of
  `release/held`; api → sync → web). It brings migration 0024 (selection votes, the access-granted bell), push receipts (`CONTRACTS_REV`
  11, the last known lost-edit path) and the merged live smoke script. CR-2B-2 is reverted (no tldraw-derived geometry in the web
  bundle). Pre-check: health 200, maintenance off, backups 0 failures, 0 error lines, 0 rooms open. api live in 42 s. 0024 is applied
  by the start-up runner (the api starts only with every migration applied; as with 0023 it logs nothing, so `schema_migrations`
  stays an owner check). sync live in 62 s (`/healthz` 200 ten seconds later, maintenance off, backups running, the board handshake
  still echoes `lobby.board.v1` through the edge). web live in 31 s. Live smoke (the merged `scripts/smoke/live-smoke.mjs`, its
  CSP read from `render.yaml`): 34 passed, 0 failed, the known warning; 0 `error`/`FATAL` lines. **The R0 rollback path is retired**
  from here: 0024 is newer than R0 can read, and D7 drop-legacy follows around 2026-10-08.
- **Wave D deployed 2026-10-03 23:49–23:51Z** (`main` `54ea729`; api → sync → web; no migration, no protocol change, `CONTRACTS_REV`
  stays 11). It carries:
  - the presence relay re-ranking only when a shown set can change (NAS L1 at 200 sessions: steady CPU 62 → 50 % of the quota, pre-kill
    event-loop p99 56.5 → 35.1 ms);
  - the B11 divergence fix (SYNC-4), the receipt-gap marker, and the archive READ_ONLY fix (DEF-GAPS-1);
  - history re-key in one sorted pass;
  - the api's offboarding sweep, v1-preview cap + LRU, and request timeouts (408 `REQUEST_TIMEOUT`; streamed uploads cut only on a 60 s
    stall, 60 min ceiling);
  - the web polish follow-ups and C6's measured harness and docs.

  Results: api live in 41 s, sync in 52 s (`/healthz` 200 twelve seconds later), web in 31 s. Live smoke 34 passed, 0 failed, the known
  warning; 0 `error`/`FATAL` lines; backups 0 failures; the board handshake echoes `lobby.board.v1`. Known and queued for wave E: a
  removal racing the same person's multi-use link redemption can deadlock (one side answers 500) or leave an orphan grant.
- **Wave E deployed 2026-10-04 01:43–01:44Z** (`main` `48510b1`; api → web; sync stays on `54ea729`; no migration, no protocol change).
  It closes the removal-vs-redeem deadlock and orphan grant (membership row first, then the grant, on every grant path; forced
  interleavings on real PostgreSQL 18.4 on the workstream's branch). It bounds the v1 preview by stored size (2.5 MiB) as well as
  records (1,000). The shell no longer restarts the board session on re-render, the heartbeat clears on the raw pong, and undo
  restores group selections. The board's access hint names the person who changed it, and only for real changes. Gate: 563 of 565 e2e
  passed, 0 failed; stale-client checks 64/64 and 67/67. Live smoke 34 passed, 0 failed; 0 `error`/`FATAL` lines.
- **Wave F deployed 2026-10-04 02:51–02:52Z** (`main` `e5cb6df`; api → web; sync stays on `54ea729`; no migration, no protocol change).
  It covers ownership transfer and the keep-sharing duplicate, which now lock the membership before the grant (no copied grant for a
  non-member), the hidden-member filter on undo's group restore, guest-queue purge coverage and stale comments. `docs/BACKLOG.md` is
  rewritten as the current open list. Gate: 563 of 566 e2e passed, 1 known LOD pixel flake (3/3 alone), 2 skipped; stale-client
  checks 48/48 and 49/49. Live smoke 34 passed, 0 failed; 0 `error`/`FATAL` lines.
- **Day 3 clean (2026-10-04 02:54Z, about 54 h after the switch):**
  - api, sync and web return 200; maintenance off.
  - Backups: store r2, last pass 02:50Z, `failuresTotal` 0, 4 boards with 0 failures and 0 pending.
  - 0 `error`/`FATAL` lines on api and sync in 24 h.
  - Render service events show only the day's deploys (api/web `e5cb6df`, sync `54ea729`): no restart or out-of-memory event.
- **2026-10-04 check clean (16:47Z, about 68 h after the switch):**
  - api, sync and web return 200; maintenance off.
  - Backups: last pass 16:35Z, `failuresTotal` 0, 4 boards with 0 failures and 0 pending.
  - 0 `error`/`FATAL` lines on api and sync in 24 h.
  - No Render service event since the 02:52Z deploys (api/web `e5cb6df`, sync `54ea729` unchanged): no restart or out-of-memory event.
- **Live two-user test on staging, 2026-10-05.** The owner (Chase's Brave, through Claude in Chrome) and a name-only workshop
  guest (a separate browser) on throwaway boards b-4avbft2xkr and b-x3cqq2jh0l, both now in Trash.
  - Passed: create from a template, edit and reload (stored); two-way live sync in about 3 s; cursors, remote selections and
    guest labels; the selection vote names its frames; a late joiner sees the open vote; a revoked link shows the guest
    "Your guest access has ended" in about 16 s.
  - Found and fixed:
    - **Wave G** (`8c31139`, deployed 05:59–06:01Z): a participant kept the previous vote's scope after a new vote, and a
      failed workshop refetch was never retried; Create workshop link stuck on "Creating…" while the clipboard hung; the
      name-only option did not apply to an existing link (new PATCH).
    - **The board event stream was never live on staging.** Render's static-site `/api/*` rewrite holds a response until it
      ends. Measured with the new public `GET /api/diag/stream` (`2dc1ad15`): first byte 3.25 s = total through the rewrite,
      0.23 s direct to the api. `no-transform` and padding (`79e5e13`) did not help.
    - **Wave H** (`0e970a2`, 09:15–09:17Z): the page mints a single-use 30 s ticket through the rewrite
      (`POST /api/boards/:bid/events/ticket`) and opens the stream directly on the api origin with `Authorization: Bearer`.
      There is CORS for the web origin only, and a fallback to the cookie stream. The web CSP `connect-src` gained the api
      origin, and the api has `DRAFTROOM_EVENTS_ORIGIN`; both were applied through the Render API, and `render.yaml` drift is 0.
  - After wave H, live smoke: 39 passed, 0 failed. The owner's stream stayed open more than 74 s with no reconnect (before:
    one every 40 s). **A vote started by the owner reached the guest's page in 283 ms** (before: up to 40 s).
- **2026-10-05 check clean (16:47Z, about 92 h after the switch):**
  - api, sync and web return 200; maintenance off.
  - Backups: last pass 16:35Z, `failuresTotal` 0, 6 boards (the 4 real ones plus the 2 trashed test boards) with 0 failures and 0 pending.
  - 0 `error`/`FATAL` lines on api and sync in 24 h.
  - No Render service event besides the lead's own deploys (api/web `0e970a2` at 09:16Z; sync `54ea729` unchanged): no restart or out-of-memory event.
