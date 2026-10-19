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
- **2026-10-06 03:55Z, wave I deployed:** api and web `edf27c2`, sync `54ea729` unchanged. Wave I covered live-update
  robustness, the private-notes retry, the creator-grant lock order and the guest queue release (PROGRESS.md). Live smoke passed.
- **2026-10-06 check clean (19:19Z, about 5 days after the switch):**
  - api, sync and web return 200; maintenance off.
  - Backups: last pass 19:05Z, `failuresTotal` 0, 9 boards with 0 failures and 0 pending.
  - 0 `error`/`FATAL` lines on api and sync in 24 h.
  - No Render service event besides the lead's 03:55Z deploy: no restart or out-of-memory event.
- **2026-10-06, `trailerpark.com` became a creator domain and sign-up stays in Lobby (owner's requests).** Two sessions did this
  at the same time.
  - 19:21Z (this watch): `DRAFTROOM_CREATOR_DOMAINS=darkburn.com,trailerparkgroup.com,trailerpark.com` was set on the api
    through the Render API, and the api was restarted at `edf27c2` (`dep-db2kk6navr4c73edo7m0`). Its startup line listed
    the three domains and 1 exception.
  - 19:29Z (the other session, PROGRESS.md): api then web were deployed at `eb96ba46`. That release has `trailerpark.com` in
    the code default (43b193a5), Clerk's sign-in-or-up flow (`<SignIn withSignUp>`) and the additive migration
    `0025_open_signin`.
  - The variable was then removed again, so unset means the default, the same three domains.
- **2026-10-07 03:00Z, wave J deployed:** api, then sync, then web at `a3e3f4a` (main fast-forwarded to `wave-j/integration`).
  - Before the deploy:
    - The integrator's gate passed (PROGRESS.md, wave J).
    - An independent pre-deploy review and three adversarial fix rounds closed IO-1 to IO-11, the Internal only bypasses and their follow-ups. Real PostgreSQL 18 races were added (`internal-only-locks.pg.test.ts`).
    - The final complete gate at `a3e3f4a` passed:
      - unit: 5,837 passed;
      - real PG 18: all `*.pg.test.ts` and the whole api project, 1,654 passed;
      - e2e: 594 passed and 0 failed, normally and again with `E2E_DIRECT_EVENTS=1`.
    - Old open tabs (the eb96ba46 web) against the new patched sync showed no write loop in seven scenarios.
  - `DRAFTROOM_FEEDBACK_ADMINS` was set on the api through the Render API, copied server-side from `DRAFTROOM_CREATOR_EMAILS` (1 address, never printed).
  - Deploys: api `dep-db2raoh42hec73fki8u0` (migrations 0026 and 0027; the feedback inbox route answers), sync `dep-db2rbf2d0e5s73e5231g`, web `dep-db2rc2vlk1mc738fjp7g`.
  - 0 `error`/`FATAL` lines afterwards. `render.yaml` drift is 0.
  - Live smoke: 40 passed, 0 failed. The bundle now names `accounts.google.com` (the theater's Google button). The smoke check passes it only while `/api/auth/config` offers no Google sign-in, which is the case on staging. The headless sign-in page check saw no request to it.
  - Live two-user check (the owner in Brave, a name-only guest in the built-in pane), on a test board in a test project:
    - "Shared outside" on the top bar for both people.
    - The guest tagged GUEST.
    - Presence, remote selection and a note typed under a lease reached the guest live.
    - Send feedback from the guest reached the owner's /feedback inbox; marking it done works through the api. A click in the hidden Brave tab did not land; the e2e `feedback.spec.ts` covers the button.
    - Project Internal only: on, a new link was refused with 409 INTERNAL_ONLY and its words; off, links work again.
    - Trashing the board ended the guest's access at once.
    - Not checkable live without a second real account: the External tag, the owner's first-join bell item (both for outside ACCOUNTS) and a plain editor's refused move-out. The api and e2e suites cover them.
  - Cleanup: both test links revoked, the board in Trash, the test project archived; the test feedback stays in the inbox as Done.
- **2026-10-09 08:43-08:50Z, D7 drop-legacy done** (owner's standing OK of 2026-10-01; full takeover 2026-10-08). The run was in the quiet window, after checking that no board had more than one idle client in the last 90 minutes.
  - Checks before:
    - 7 clean days: since the switch (2026-10-01 20:56Z), only the 8 deploys appear as events (no rollback, restart or OOM), and api and sync have 0 error/FATAL lines.
    - Backups: `failuresTotal` 0, last pass 08:31Z.
    - The C5 set is still in R2 (4 boards, 4 objects, held to 2026-12-30), listed with the sync's own R2 settings in memory.
  - Maintenance on (`closedSockets` 1). A fresh run-all under maintenance: `run_94bd324df7f52cd1`, ok, `inMaintenance` true, 18 of 18 boards offsite in R2, held to 2027-01-07. Maintenance off.
  - Runbook fix: the sync refuses drop-legacy while maintenance is on (503 MAINTENANCE; only `convert-all` is exempt, apps/sync/src/http/router.ts). It runs live by design, one board at a time in the migration worker.
  - The dry run, then the real run: 4 boards dropped 7 tables each (the 4 converted at the switch), 14 had nothing to drop (born on the new canvas), 0 refused, 0 failed.
    | Board | Before (bytes) | After (bytes) |
    |---|---|---|
    | b-0gazyr0d3e | 233,472 | 110,592 |
    | b-7gw2v3e61a | 253,952 | 118,784 |
    | b-e7mx42m5yt | 122,880 | 53,248 |
    | b-esfzg8j7zo | 360,448 | 221,184 |
  - Proof: a forced run-all after the drop (`run_9288733e98f7eba5`) left 14 boards' record digests identical. For the 4 converted boards, the backups from before and after were downloaded and compared table by table: `lb_meta`, `lb_elements`, `lb_doc`, `lb_deleted` and `lb_receipts` are identical, and the legacy tables went from 6 to 0. Their whole-file `recordsSha256` changed only because it also covers `lb_source`, which the drop removes by design (the room recreates it empty).
  - `VITE_TLDRAW_LICENSE_KEY` was removed from the web service (Render API) and from `render.yaml`. A rollback to R0 is no longer possible.
  - Not done: deleting `/var/data/cutover/` on the sync disk. It needs the sync Shell, and the reports in it are small.
- **2026-10-09 08:49-08:51Z, wave K deployed** (main `437b4e7`; quiet window): api `dep-db4al4dg1s2s738r08lg`, then web `dep-db4alk7lot8c738d5ebg`. Sync unchanged (`a3e3f4a`), so no board reconnected.
  - Gate: K.1's complete gate at `da3fefec`.
    - unit: 6,653 passed;
    - real PG 18: 1,684 passed;
    - whole e2e: 725/727 normally, and 724/727 with direct events, whose one failure is a pre-existing flake that also fails on main;
    - stale-client pair A passed.
  - The `/excalidraw-assets/*` `Cache-Control: public, max-age=604800` header (K1-6) was added through the Render API. render.yaml drift is 0.
  - Live smoke: 40 passed, 0 failed. 0 error/FATAL lines afterwards.
  - Live two-user check (the owner in Brave, a name-only guest in the built-in pane):
    - The dashboard shows "Start something" with the 6 new templates, the What's new card and the Feedback pill.
    - A Creative brief board was made from its tile; its top bar has 8 controls.
    - Vote: the guest saw the "Chase started a vote" banner and joined with one click. The facilitator saw "1 of 1 voted · 1 vote cast", and the results showed with Export CSV.
    - Present asked "Present to everyone? 1 other person is on this board" with "Just me" and "Present to everyone (1 here)". The guest got "Chase B is presenting · Follow".
    - Cursor chat: the guest's "/" message showed as a bubble on the owner's page.
    - The empty-board card shows on a blank board.
    - Not live-tested: the AI actions. The board's AI privacy notice was not accepted on the owner's behalf; the K7 tests cover them with the fake OpenAI.
  - Cleanup: the guest link revoked, both test boards in Trash.
- **2026-10-10 08:01-08:05Z, wave L deployed** (main `4e4a549`; 0 board connections in the 2 h before): api `dep-db4v182jnfac738l1rq0` (migration 0028_ai_actions), then sync `dep-db4v215ckfvc738c2rkg` (CONTRACTS_REV 12, the per-reader downgrade `frameForReader` and the writer-side keep), then web `dep-db4v35ad0e5s73djs8v0`.
  - The O1/O2 sign-off is recorded in PROGRESS.md.
  - After the deploy:
    - 0 error/FATAL lines; maintenance off; backups `failuresTotal` 0 on 20 boards;
    - render.yaml drift 0;
    - live smoke 40 passed, 0 failed.
  - Live check:
    - A real 437b4e7 (rev-11) tab on the rev-12 sync stayed Saved and Live with no console errors, including while a rev-12 guest set a frame's minutes.
    - The new web's minutes stepper persisted across reloads, and undo removed it as one step.
    - Ctrl+K opens the command palette.
    - Pieces lists the Flowchart, Wireframe, Org chart and Agency kits.
    - Not live-tested: AI actions (the owner's AI notice was not accepted on his behalf); the laser between two signed-in tabs.
  - Cleanup: the guest link revoked, the test board in Trash.
  - Open follow-up: the Mermaid-paste prompt flake (`wave-l/mermaid-flake`).
- **2026-10-10 10:17Z, hotfix H1 deployed** (web only, `f380e83`, `dep-db510uajnfac738rtgc0`; 0 board connections in the 2 h before). It fixes the phone board-blanking loop in SelectionBar and adds per-feature error boundaries.
  - Drift 0. Live smoke 40 passed, 0 failed.
  - Live check: a 375x812 name-only guest on a Retrospective board with 14 framed notes ran the palette command "Select 14 notes", the exact path that crashed before (React #185). The board stayed alive: no page errors, the canvas rendering, Saved.
  - Cleanup: the link revoked, the board in Trash.
- **2026-10-11 00:16-00:20Z, wave M deployed** (main `104c6e0`; 0 board connections in the 3 h before):
  - api `dep-db5dagflot8c73eibpqg` (migrations 0029_usage_daily and 0030_workspace_templates);
  - sync `dep-db5db2d9fdbs73cff5n0`;
  - web `dep-db5dbqvlot8c73eifnt0`.
  - Applied first through the Render API:
    - api: `DRAFTROOM_DB_POOL_MAX=5` and `DRAFTROOM_WORKSPACE_QUOTA_MB=5120`;
    - sync: `DRAFTROOM_BACKUP_KEEP=4`, `DRAFTROOM_OUTBOUND_BUDGET_MB=128` and `DRAFTROOM_WS_DEFLATE=off` (HOLD until the lost-words race is fixed; the sync logs "permessage-deflate off");
    - web: `VITE_PUBLIC_ORIGIN`, plus the `/version.json` `Cache-Control: no-store` header.
  - After the deploy:
    - api `/healthz` and `/healthz/deep` 200; sync `/healthz/deep` ok; maintenance off;
    - 0 error/FATAL lines; render.yaml drift 0;
    - live smoke 40 passed, 0 failed;
    - `/version.json` answers `{"commit":"104c6e011bfe"}` with no-store.
  - Gate at `104c6e01`:
    - units 8,578 passed; real PG 1,907 passed (with 4 workers);
    - whole e2e 903/903 normally and 903/903 with direct events;
    - stale pairs: (a) 131/131 with deflate on and off, (b) 164/164, (c) by design, (d) passed; l-compat-rev11 6/6.
  - Open: hotfix H2, the lost-words race (`hotfix/h2-lost-words`).
- **2026-10-11 05:59Z, hotfix H2 deployed** (web only, `3c83611`, `dep-db5ib1id0e5s73fium5g`; 0 board connections in the 3 h before). It fixes the lost-words race: words typed into a just-made note were dropped when Escape came before the label create's ack, while the page showed Saved.
  - Gate at `5a607c62`: units 8,604 passed; whole e2e 922/922; `board-lost-words` 90/90 (and 180/180 earlier); ai-actions DEMO with deflate on 30/30; l-compat-rev11 6/6.
  - Drift 0. Live smoke 40 passed, 0 failed. `/version.json` reports `3c83611e688e`, so open tabs are offered the update.
  - Live check, a name-only guest: N, click, wait for the editor, type, then Escape at once and reload. The words were kept ("Second note words").
  - Cleanup: the link revoked, the board in Trash.
  - `DRAFTROOM_WS_DEFLATE` stays off for now: turn it on only after measuring its ack time on staging.
- **2026-10-12 12:04-12:08Z, wave N deployed** (main `4fd0c2d`; 0 board connections in the 2 h before):
  - api `dep-db6cp25ckfvc73d08qo0` (migrations 0031_board_visits and 0032_board_links);
  - sync `dep-db6cpn942hec73bov6dg` (`CONTRACTS_REV` 13);
  - web `dep-db6cqslckfvc73d0eklg`.
  - Applied first through the Render API:
    - api: `DRAFTROOM_AI_VISION=on`, `DRAFTROOM_AI_VISION_USER_DAILY=10`, `DRAFTROOM_AI_VISION_GLOBAL_DAILY=150`, `DRAFTROOM_AI_TRANSCRIPT_MAX_CHARS=60000`, `DRAFTROOM_AI_TRANSCRIPT_USER_DAILY=10`, `DRAFTROOM_AI_VISION_TIMEOUT_MS=60000` and `DRAFTROOM_VISITS_RETENTION_DAYS=180`;
    - sync: `DRAFTROOM_REACTIONS=on` (the sync logs "[reactions] on"); `DRAFTROOM_WS_DEFLATE=off` stays (the wave M hold).
  - After the deploy:
    - api `/healthz/deep` 200; sync `/healthz/deep` ok; maintenance off;
    - 0 error/FATAL lines; render.yaml drift 0;
    - `/version.json` answers `{"commit":"4fd0c2d664be"}`.
  - Live smoke: the first run failed 1 check, "bundle foreign hosts". It flagged the PDF fork's XMP namespace names (`ns.adobe.com`, `purl.org`, `www.aiim.org`), which are never requested. The smoke now treats them as identifiers only when every chunk naming them is a PDF chunk, the rule INT-5 gave the build's host scan. Rerun: 40 passed, 0 failed.
  - Live check, the owner (Chase's signed-in browser) and a name-only guest on two new boards:
    - **Reactions:** the owner's 🎉 reached the guest. The guest joined it, added 👍, removed 👍 and added ❤️, and every change reached the owner; the owner's 😂 reached the guest. The arrival time was not measured: one tab was always a hidden window, whose timers fire about once a second (the push waits 50 ms, `COALESCE_MS`), and both one-way times came out at 0.9-1.1 s.
    - **Board links:** "Link to another board" placed a card for board A on board B (title and thumbnail), and the card's Open went to A. On A, "Linked from" listed B with "Go to the link"; `GET /api/boards/A/backlinks` answered B. The guest's request got 403, as designed.
    - **Since your last visit:** the owner left A, the guest added a note, and the owner came back to "Since you were here (Mon 5:17 am): 1 added", with one outline, Next change and Mark all seen.
    - AI capture was not tried live: the AI notice is the owner's to accept.
  - Cleanup: the guest link revoked (200; the guest sees "Your guest access has ended"), both boards in Trash.
  - Holds:
    - `VECTOR_PDF` stays off until fontkit is added (follow-up N.1);
    - of the four speed flags only `WORKER_DECODE` is on;
    - deflate stays off.
- **2026-10-12 19:28-19:32Z, wave N.1 deployed** (main `1821a65`; 0 board connections in the 4 h before):
  - api `dep-db6j9sij9qps73ck8mq0`. The script was called with an empty commit, so Render deployed the branch head, which is the same commit.
  - sync `dep-db6jaf49v7es73fn3ghg`;
  - web `dep-db6jb60473hc73dj1l1g`.
  - No migration and no `CONTRACTS_REV` change. Applied first through the Render API: sync `DRAFTROOM_OUTBOUND_BUDGET_MB=64` (it was 128). `DRAFTROOM_REACTIONS=on` and `DRAFTROOM_WS_DEFLATE=off` are unchanged.
  - After the deploy:
    - api `/healthz/deep` 200; sync `/healthz/deep` ok; maintenance off; `GET /internal/clock` 200;
    - 0 error/FATAL lines; render.yaml drift 0;
    - live smoke 40 passed, 0 failed;
    - `/version.json` answers `{"commit":"1821a6592a37"}`.
  - Gate at `aa0e589f` (docs/PROGRESS.md wave N.1):
    - lint on the NAS: 2,738 files, 0 errors;
    - units: 9,348 passed;
    - real PG: api 2,043 passed, db 82/82;
    - whole e2e 980/980 normally and 980/980 with direct events (14 skipped in each).
  - Live check, the owner on a new board: a note "Vector PDF non‑breaking 12 345 † check" (U+2011, U+2020) exported with "Export as PDF…" and vector pages. The file was caught in the page, not downloaded.
    - 6,619 bytes, `%PDF-1.7`;
    - 2 embedded TrueType subsets (`/FontFile2`, Type0 and CIDFontType2), 3 ToUnicode maps holding U+2011 and U+2020, and 8 text-show operators.
    - Cleanup: the board in Trash.
  - Holds:
    - `DIFF_APPLY` and `SIZE_AWARE_LOD` stay off. `CHUNKED_APPLY` and `VECTOR_PDF` are on.
    - Deflate stays off.
- **2026-10-13 04:09-04:12Z, wave O deployed** (main `d57a877`; 0 board connections in the 3 h before).
  - Deploys: api `dep-db6qtql9fdbs73e0ou5g`, sync `dep-db6qu7ij9qps73a6cpf0`, web `dep-db6qul0u01pc73b86e70`. All three load the patched `@excalidraw/element`.
  - No env change, no migration, no `CONTRACTS_REV` change.
  - After the deploy:
    - api `/healthz/deep` 200; sync `/healthz/deep` ok; maintenance off;
    - 0 error/FATAL lines; render.yaml drift 0;
    - live smoke 40 passed, 0 failed;
    - `/version.json` answers `{"commit":"d57a87700e98"}`.
  - Gate: docs/PROGRESS.md wave O. Units 9,425 passed; whole e2e 982 passed twice. The one failure in each run, K5-5, was a test race and is fixed. The L6-1 laser lag at 311 ms against 300 is a threshold flake that also happens without wave O.
  - Live check, the owner on a new board: a note, then wheel pans in four directions. The note was drawn whole at every step, with no stale strips, and came back to its place; the board said Saved and Live.
  - Cleanup: the board in Trash.
  - Holds:
    - `PAN_BLIT` on;
    - `DIFF_APPLY` and `SIZE_AWARE_LOD` off;
    - deflate off.
- **2026-10-15 01:10Z, wave P deployed: the team-ready release** (web only, main `ad288ee`, `dep-db82frij9qps73bcv1i0`; api and sync stay at d57a877). Three board connections in the 3 h before; a web deploy reconnects nobody, and open tabs are offered the update, which now waits while someone types.
  - After the deploy: 0 error/FATAL lines; render.yaml drift 0; live smoke 40 passed, 0 failed; `/version.json` answers `{"commit":"ad288eee7d10"}`.
  - Gate: docs/PROGRESS.md wave P. Units 9,566 passed; whole e2e 1,017 passed in both runs.
  - Live check, the owner's browser:
    - the dashboard shows the Welcome card, the Help menu and the neutral "No preview yet" placeholder, with no "DBC Lobby";
    - a Word file (`document.docx`, 1.3 KB) was dropped onto a new board: it was queued, then made into a 3-page preview by the NAS worker's LibreOffice sidecar ("Preview made from a PDF conversion", View pages).
  - The type-on-a-shape check could not be driven by hand (both browser windows were hidden, so no screenshots). It is covered by `canvas-ux-keys` in both whole e2e runs.
  - Cleanup: the guest link revoked, the board in Trash.
- **2026-10-16 06:47-06:50Z, wave Q deployed: the Elements panel** (main `b804aec`):
  - api `dep-db8sgtavcj2c73b2h3r0` (migrations 0033_library, 0034_library_place);
  - sync `dep-db8shfc9v7es73dnnqhg` (colour validation);
  - web `dep-db8shv4s728c73au41vg`.
  - The last board connection was 22 min before (a likely idle tab; the sync deploy's reconnect keeps edits).
  - Applied first through the Render API (`wave-q-web.mjs`): the `/lobby-assets/*` rewrite to the api before the SPA fallback, and two Cache-Control headers. Drift 0.
  - After the deploy:
    - api `/healthz/deep` 200; sync `/healthz/deep` ok; maintenance off;
    - 0 error/FATAL lines;
    - live smoke 41 passed, 0 failed (with the new missing-icon check);
    - `/version.json` answers `{"commit":"b804aec679b4"}`.
  - `curl -I`:
    - a missing `/lobby-assets/icons/…` file answers 404 application/json;
    - `LICENSES.txt` answers 200 with `max-age=31536000, immutable`: Render applied the wider `/lobby-assets/*` rule, not the 1-day one (follow-up: give it a hashed name at the next icon bump).
  - Live check, the owner on a new board:
    - the Elements panel opens (Icons, Shapes, Library);
    - "rocket" finds 4 icons, loaded from `/lobby-assets/icons/` (an index and 3 shards, 280-420 ms);
    - the first icon inserted (Undo enabled, Saved);
    - "steam" finds 6 icons and 5 Shapes (the Steam deliverable frames).
    - Cleanup: the board in Trash.
- **2026-10-16 12:37-12:40Z, wave R deployed** (main `ba1704c`; 0 board connections in the hour before):
  - api `dep-db91krlg1s2s739104p0` (migrations 0035, 0036);
  - sync `dep-db91l8jrjlhs73dtcd6g`;
  - web `dep-db91llvf3r2c73fpo660`.
  - Before: the env group `draftroom-staging-webhook-secret` (`evg-db91khvf3r2c73fpkng0`) created through the Render API with a random 256-bit `DRAFTROOM_WEBHOOK_SECRET` (never printed), linked to the api only.
  - After:
    - api `/healthz/deep` 200; sync ok; maintenance off;
    - 0 error/FATAL lines; drift 0;
    - live smoke 41/0, after 4ea0094b names miro.com and hooks.slack.com as text-only hosts.
  - Live check, the owner:
    - the dashboard Import menu offers "Lobby backup (.lobby)…", "Lobby board (.json)…" and "Import from Miro (beta)…";
    - a backup ticket (expires in 64 s) gave a 615-byte `application/vnd.lobby.board+zip` with manifest.json and board.json, and the ticket was refused on reuse (401);
    - the same file restored through `POST /api/workspaces/:wid/backups` gave 202, then the job done, then a new board "Wave R restored check".
    - Cleanup: three test boards in Trash.
  - NOT done: the NAS preview worker rebuild (the standing rule: draftroom-worker and draftroom-office are not mine to touch). So PSD/TIFF/AI previews would fail on staging, and they go behind `DRAFTROOM_DESIGN_PREVIEWS` (off) in the next api deploy.
  - Open:
    - the Miro probe needs a real token (until then Miro images and documents are placeholders);
    - the Teams URL rule is unconfirmed.
- **2026-10-16 13:25-13:27Z, api and web at `1cdc2fb`: the design-preview gate.**
  - Deploys: api `dep-db92be7f3r2c73frs0q0`, web `dep-db92brff3r2c73frte20`.
  - `DRAFTROOM_DESIGN_PREVIEWS=off` was set on the api first. PSD/AI/TIFF stay attachments, as before wave R, until the NAS worker is rebuilt (`/api/auth/config` answers `designPreviews:false`).
  - Drift 0; smoke 41/0; 0 error/FATAL lines.
  - To turn the previews on: rebuild the NAS worker at main or later (the owner's approval is needed), then set the key to `on` and restart the api.
- **2026-10-16 18:44-18:46Z, wave S deployed: client review** (main `6769e07`):
  - api `dep-db9713jodcbs739ie5bg` (migration 0037);
  - web `dep-db971h6k1f9s738m3mtg`;
  - sync unchanged at ba1704c.
  - After: api `/healthz/deep` 200; 0 error/FATAL lines; drift 0; live smoke 41/0; `/version.json` answers `{"commit":"6769e07220a6"}`.
  - Live check, the owner on a new board:
    - `GET /api/boards/:bid/review` gives 200 (items, rounds, openRoundId, can);
    - `/b/:bid?view=review` opens the client review page ("Nothing is waiting for review on this board yet.").
    - Cleanup: the board in Trash.
  - The deeper flows (status by a guest, versions and compare, video comments, the summary PDF) are covered by `s-int` and s1-s4 in the gate.
  - Waits for the NAS worker rebuild (owner approval): the video frame-rate probe (the viewer assumes 25 fps) and PSD/TIFF previews (`DRAFTROOM_DESIGN_PREVIEWS` off).
- **2026-10-17 02:14-02:23Z, wave T deployed: storyboards and planning walls, `CONTRACTS_REV` 14** (main `711dd04`; 0 board connections in the 2 h before). In the DEPLOY.md order:
  1. `DRAFTROOM_PLANNING=off` set on the sync;
  2. api `dep-db9djsu7bikc73fl45m0`, sync `dep-db9dk9rrjlhs73ee369g`, web `dep-db9dks5g1s2s738amq6g`;
  3. `DRAFTROOM_PLANNING=on`. A Render restart did NOT pick up the env change (the log still said "[planning] off"), so the sync was redeployed at the same commit (`dep-db9dnq61egvs73eshln0`), which logs "[planning] on".
  - After:
    - api `/healthz/deep` 200; sync ok; maintenance off;
    - 0 error/FATAL lines; drift 0; live smoke 41/0.
  - Live check, the owner on a new board: the palette's "Kanban board" made a Kanban frame with its columns (`kanban-layer`, `kanban-column`), and "Timeline" ran; the board said Saved and Live, so the rev-14 room accepted the planning keys.
  - Cleanup: the board in Trash.
- **2026-10-19 03:5x-04:02Z, the NAS preview worker rebuilt, and design previews on** (owner's approval, 2026-10-18):
  - NAS: `deploy/nas/deploy-worker.sh check-env` ok, then `deploy` from main `2f6f0479`. draftroom-worker and draftroom-office run the new image (restarts 0); the worker logs "office previews: LibreOffice sidecar", and the office sidecar logs "listening".
  - api: `DRAFTROOM_DESIGN_PREVIEWS=on` set through the Render API, render.yaml and its test updated (`cd41796`), then the api redeployed (`dep-dbapa6m1egvs73bjmn9g`; a restart does not apply env changes). `/api/auth/config` answers `designPreviews:true`.
  - After: drift 0; live smoke 41/0 (the usual sync-socket warning).
  - Live check, the owner on a new board:
    - a 24×16 TIFF dropped on the board was claimed by `nas-1` and became a flattened page preview (kind `pdf`, 1 page, a webp derivative) in about 3 s;
    - a 1 s 30 fps H.264 MP4 got a poster and a thumb, and its probe reports `frameRate: 30` (the review viewer no longer assumes 25 fps).
    - Not checked live: a real PSD or AI file. Those go through the same worker path and are covered by the worker's tests.
    - Cleanup: the board in Trash.
- **2026-10-19 10:39-10:46Z, wave V deployed: live sessions+** (merge `7e5b4d6`, switches `604bf50`; `CONTRACTS_REV` stays 14; sync and worker not redeployed). In the DEPLOY.md order:
  1. api `dep-dbav6mjncjis73ai9hc0` (migration 0038) with the three keys off. `/api/auth/config` reported `live` all false, and `/healthz/deep` returned 200.
  2. web `dep-dbav78vbtjjs738o6pmg`; `/version.json` reports `7e5b4d6bb672`.
  3. `DRAFTROOM_LIVE_ACTIVITIES`, `DRAFTROOM_JOIN_CODES` and `DRAFTROOM_BREAKOUTS` set to `on` through the Render API, then an api redeploy (`dep-dbav7vm1egvs73c95sng`, not a restart). `live` is now all true.
  - After: drift 0; live smoke 41/0 (the usual sync-socket warning); `/healthz/deep` 200; an unknown join code got 404.
  - Live check, the owner on a new board, through the api:
    - a poll started (201) and was revealed;
    - a word cloud took an anonymous answer containing 👩‍💻 (200) and was revealed with the right counts, with no participant ids in the reveal;
    - a workshop link got an 8-character join code (200), and `/api/join/<code>` returned its token.
    - My first answer call used the wrong body shape (400; the answer must be wrapped in `answer`), so that poll revealed with 0 answers. That was a check error, not a bug.
    - Breakouts were not driven live, because they need real frames on a board. The e2e suite covers them (v3, both event modes).
    - Cleanup: the board in Trash.
  - Gate (wave-v/int at 1a79a536): e2e chromium 1,128/1/8 normal (the one failure was an outdated K3-3 menu test, updated) and 1,129/0/8 with direct events; probe:browser pass; test:arrows 85/85; vitest 12,059/0; real Postgres db 123 and api 2,559 (1 link-preview race that also happens on main). NAS load test with 200 participants: poll answer ack p95 19 ms, 200/200 counted, 0 leaks.
- **2026-10-19 17:28-17:40Z, wave W deployed: formats** (merge `adbc2ce7`, sharp 0.35.5 `fc2281c`, switches `91d2a4f`; `CONTRACTS_REV` 14; sync not redeployed).
  1. api `dep-dbb56ie1egvs7395alvg` (migration 0039) with all five keys off; `formats` all false; `/healthz/deep` 200.
  2. web `dep-dbb574ijnfac73f1hst0`; `/version.json` `fc2281ca583a`.
  3. NAS worker and office rebuilt from main (`deploy/nas/deploy-worker.sh deploy`, standing OK). The start log reports the child memory caps enforced (pdf 768 MB, pdf-text 768 MB, remove-bg 640 MB) and offers `extract-text@1, render-pages@1`; remove-bg is not offered (no model).
  4. `DRAFTROOM_DOC_CARDS`, `DRAFTROOM_FILE_SEARCH`, `DRAFTROOM_DECK_IMPORT` and `DRAFTROOM_WORKSPACE_ADMIN` set to `on` and `DRAFTROOM_REMOVE_BACKGROUND` to `off` via the Render API, then an api redeploy (`dep-dbb588rncjis73dgvo40`). `formats` now reports docCards, fileSearch, deckImport and admin true, removeBackground false.
  - After: drift 0; live smoke 41/0; `/healthz/deep` 200; signed out, `/admin/members` answers 404.
  - Live check, the owner on a new board:
    - the admin members, storage/by-board and audit routes answered 200;
    - a one-page PDF dropped on the board got its preview on `nas-1` (1.8 s), then an extract-text op ran (`done`), and a workspace search for a word only in the PDF returned it as a `file` hit on that board, page 1, with a snippet.
    - Doc cards and deck import were not driven live; the gate covers them (w1/w4 e2e, both event modes).
    - Cleanup: the board in Trash.
  - Gate (wave-w/int at b98d0916): e2e 1,149/0 normal; 1,148/1 with direct events (the l6-laser lag flake also happens on main); probe:browser pass; arrows 85/85; vitest 12,479/0; real Postgres db 134 and api 2,680. Linux memory cap: a 1.5 MB hostile PDF was killed at about 800 MB (it used to reach about 3.3 GB). `audit:prod` passes after sharp 0.35.5 and the reviewed build-time source-map-js entry.
  - Open: background removal waits for the owner to approve the u2netp model download.
- **2026-10-19 18:44-18:53Z, background removal on** (owner's approval in chat). `u2netp.onnx` (4,574,861 bytes) was downloaded once from rembg's v0.0.0 release. Its md5 `8e83ca70e441ab06c318d82300c84806` matches the md5 rembg publishes; sha256 `309c8469…ddd8` is pinned in `bg-model.ts` and `MODELS.json` (`1da6816`). The file is placed read-only on the NAS at `draftroom-worker/models/` and mounted at `/models`.
  - The rebuilt worker reports `remove-bg:u2netp@1, extract-text@1, render-pages@1`.
  - `98b7724`: web switch on, palette command released, render.yaml set. `DRAFTROOM_REMOVE_BACKGROUND=on`; api `dep-dbb6c8ks728c73fffmug` and web `dep-dbb6clrncjis73dkhlbg`. `formats` is now all true.
  - Live check, the owner on a new board: a dropped 320×240 PNG → `POST /api/files/:ver/remove-background` 202 → op `done` with a new result version in about 10 s on `nas-1`. Cleanup: the board in Trash.
