# Wave R contracts: Bring the team over

Wave R brings a team's work into Lobby and keeps it connected: **import from Miro** (WS1), **notifications to Slack
and Teams** (WS2), **design-file previews** (PSD, AI, TIFF, HEIC; WS3) and **board backup and restore** (`.lobby`;
WS4). The foundation (branch `wave-r/foundation`) lands the shared contracts, two migrations, the guard rows, the
shared outbound-request module, the secret box, the import job runner, the dashboard's Import control and the Miro
probe. Nothing changes for a user until the workstreams land:

- every new route is **pending** (`apps/api/src/features/pending-routes.ts`): not registered, so it answers 404
  `NOT_FOUND` exactly like an unknown route, for every caller;
- the web clients answer empty without a request, and every write rejects `'unavailable'`;
- the Import control's switches are off: the dashboard shows today's single "Import" button;
- no board is ever `importing` until a source is registered on the runner;
- chat hooks stay off while `DRAFTROOM_WEBHOOK_SECRET` is unset (fail closed).

What does not change: the sync protocol (`CONTRACTS_REV` stays 13), `ELEMENT_SCHEMA_VERSION`, the room's validation.
A Miro board is built from existing element types and `customData.lobby` keys and must **not** write the `import` doc
key (`ImportDocValue.from` is `z.literal('tldraw-5.4.2')`): Miro provenance lives in Postgres (`board_imports`).

Design: the wave R design scout (`scratchpad/wave-r/design.md`), followed except where §9 says why not.

## 1. Workstreams and file ownership

| Workstream | Owns | Reads (does not edit) |
|---|---|---|
| **WS1 Miro import** | `packages/miro-import/**` (new: converter, colour tables, fixtures); `apps/sync/src/room-internal/{seed.ts, convert-miro.ts, convert-miro-worker.ts}` (the `miro-v2` seed body); `apps/api/src/features/imports/miro/**` (the Miro client over the egress module, pacing and 429 waits, the `'miro'` import source, the two Miro routes); **the six job routes**, written in `apps/api/src/features/imports/routes.ts` (new; registered from `imports/index.ts` in place of its stub loop: the one line WS1 changes there); `apps/web/src/dashboard/import-miro/**` (dialog, picker, progress, report) and `apps/web/src/dashboard/imports/client.ts` (made live); `packages/contracts/src/miro-import.ts` after the foundation (but `MIRO_DOWNLOAD_HOSTS`: the lead's, from the probe); `e2e/tests/support/miro.ts`, `e2e/excalidraw/r1-*.spec.ts` | `features/imports/{jobs,runner,finalize}.ts`, `egress/**`, `contracts/imports.ts` |
| **WS2 Notifications** | `apps/api/src/features/chat-hooks/**` (routes, the outbox writer `enqueueChatDeliveries`, the delivery loop, rendering); the one-line calls at the three notification insert sites (`features/comments/notifications.ts`, `features/dashboard/access-requests.ts`, `features/dashboard/outside.ts`); `apps/web/src/features/notify-settings/**` (workspace hooks panel, "My notifications"); `packages/contracts/src/chat-hooks.ts` after the foundation (but `CHAT_HOOK_RULES`: the lead's, once the Teams URL is confirmed); `e2e/tests/support/chat-hooks.ts`, `e2e/excalidraw/r3-*.spec.ts` | `crypto/sealed.ts`, `egress/**`, migration 0036 |
| **WS3 Design previews** | `apps/worker/src/{psd.ts, psd-child.ts, psd-protocol.ts, tiff.ts}`, `image.ts` `ALLOWED_LOADERS`, `sniff.ts`, `processJob.ts`; `apps/worker/scripts/make-fixtures.ts`, `apps/worker/test/**`; the classification lines of `packages/dev-assets/src/shared.ts` (`classifyUpload`, `maxUploadBytes`: they read `DESIGN_FORMATS`, in the same change as the worker); `apps/web/src/file-card/**` (badge and hint) and the optional Safari HEIC conversion in the uploader; `packages/contracts/src/design-previews.ts` after the foundation; `docs/M3-STORAGE-CONTRACTS.md` §5 (the system-binary policy and table); the `ag-psd` catalog pin and lockfile (pre-approved by the lead, MIT, worker only) | `DESIGN_FORMATS` rows (change them with contracts' rows: an api test compares them) |
| **WS4 Backup and restore** | `packages/board-archive/**` (new: zip writer and reader, manifest); `apps/api/src/features/backup/**` (export stream and ticket, the `'lobby-backup'` import source, the three routes); `apps/web/src/dashboard/import-backup/**` and the board menu's "Download backup (.lobby)" line in `features/present-export`; `packages/contracts/src/board-backup.ts` after the foundation; `e2e/excalidraw/r5-*.spec.ts` | `features/imports/{jobs,runner,finalize}.ts`, `dashboard/imports/client.ts` |

**Lead-only** (serialise through the lead): `packages/contracts/src/imports.ts`, `apps/api/src/features/imports/{jobs,
runner,finalize,index}.ts`, `apps/api/src/egress/**`, `apps/api/src/crypto/**`, `apps/api/src/config.ts`, the
migrations (`0035`, `0036` are shipped: never edited; a fix is a new migration), `packages/permissions`,
`apps/web/src/dashboard/import-menu/**` and its line in `DashboardPage.tsx`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`render.yaml`, `AGENTS.md`, `docs/PROGRESS.md`. Each workstream removes its own keys from `PENDING_ROUTES` and from
`WAVE_R_ROUTES` in `apps/api/test/features/pending-routes.test.ts` in the change that implements them; the guard rows
are in place, and the refusal and creation matrices then hold each route to them.

Plan items: WS1 R1-1 (list boards), R1-2 (start), R1-4 (the job routes); WS2 R2-1 (hooks), R2-2 (test), R2-3
(preferences); WS4 R4-1 (download), R4-2 (restore); WS3 has no route.

## 2. Import jobs (shared; contracts `imports.ts`, migration `0035_board_imports`)

### 2.1 Routes

| Route | Who | Answer |
|---|---|---|
| `GET /api/imports/:id` | its starter; the workspace's owners and admins | `ImportJobView` |
| `GET /api/workspaces/:wid/imports` (`?mine=1`) | members (non-managers see only their own) | `ListImportJobsResponse` (30 days, newest first) |
| `POST /api/imports/:id/cancel` | its starter | 202 `ImportJobView`; finished boards stay |
| `POST /api/imports/:id/pause` | its starter | 202; stops at the next step boundary, keeps the board and its stored files |
| `POST /api/imports/:id/resume` (`{ token }` for Miro) | its starter, a creator (`'always'`) | 202; `IMPORT_SECRET_REQUIRED` without the token |
| `GET /api/imports/:id/report.csv` | its starter, the new boards' owners | per item: source id, type, result, element id, note |

A name-only guest is refused all six (`IMPORT_GUESTS_MESSAGE`). Path builders: `importJobPath`, `importListPath`,
`importCancelPath`, `importPausePath`, `importResumePath`, `importReportPath`. The web polls every
`IMPORT_POLL_MS` (1.5 s): plain JSON, which Render's static `/api` rewrite passes (no SSE needed).

### 2.2 Ids and statuses

- A **job** (`importId`, what a person started, what the web polls) is `imp_…` = `board_imports.batch_id`; each
  **board** of it is one row `imb_…`, in `position` order (≤ 50 boards).
- Row statuses (`IMPORT_STATUSES`): `queued → running → done | failed | cancelled`, plus `running → paused` (the
  starter paused) and `running → interrupted` (a process that is gone: its secrets were in its memory);
  `paused | interrupted → queued` on resume. The job's status is derived (`importJobStatus`): running, else queued,
  else interrupted, else paused, else the worst ending.
- Progress (`ImportProgress`: phase, items read/total, files done/failed/total/bytes) is written with a heartbeat at
  most every 2 s. Reports (`ImportBoardReport`: counts by result and type, notes, ≤ 10,000 rows) are capped at
  256 KiB (in code and by a CHECK). Error codes are upper-case words only (`IMPORT_ERROR_CODE_PATTERN`, a CHECK):
  `IMPORT_CODES` (`IMPORT_BUSY`, `IMPORT_DAILY_LIMIT`, `IMPORT_TOO_LARGE`, `QUOTA_EXCEEDED`, `IMPORT_WRONG_STATE`,
  `CREATOR_REQUIRED`, `IMPORT_SEED_FAILED`, `IMPORT_INTERRUPTED`, `IMPORT_CANCELLED`, `IMPORT_EXPIRED`,
  `IMPORT_SECRET_REQUIRED`, `INTERNAL`) and each source's own (`MIRO_CODES`, `BACKUP_CODES`).

### 2.3 The runner (`apps/api/src/features/imports/runner.ts`)

```ts
importRunnerOf(app).useSource({
  source: 'miro' | 'lobby-backup',
  resumeNeedsSecrets: boolean,          // Miro: true (the token was never stored)
  runBoard(step: ImportStep): Promise<{ report, links?, counts? }>,
})
// step: importId, rowId, workspaceId, projectId, userId (the starter: authorship), sourceRef, title, boardId (the
// importing board), secrets (RedactedSecret[]), progress(p), checkpoint() (throws ImportStopped), storedFile(key),
// recordFile(key, { versionId } | { failed: note })
runner.start({ workspaceId, projectId, userId, source, boards }, secrets) → importId   // the ROUTE checks first
runner.pause / cancel / resume(importId, userId[, secrets]); view(importId, viewerId); list(wid, viewerId, { mine })
```

- Boards run one after another; each is atomic. The runner makes the importing board (`finalize.ts
  createImportingBoard`) before `runBoard`, activates it after (`activateBoard`), or discards it with its files
  (`discardBoard`) when the board fails or is cancelled; the next board still runs after a failure.
- A source throws `ImportFailure(code)` for its own known failures; anything else becomes `INTERNAL` (logged by code
  and row id only). The source runs inside `withSecrets`: whatever else it throws is rebuilt without message, stack or
  cause. Call `step.checkpoint()` between requests and between files.
- **Files**: the source streams each into a new version of `step.boardId` (the normal upload path's limits and quota,
  `checkQuota` before each file), then `recordFile`; on resume `storedFile(key)` returns the version a source file
  already became, so nothing is uploaded twice. A board can reuse one image many times: dedupe by source key.
- Limits (`IMPORT_CONCURRENCY`): 2 running jobs per api process (the rest wait in order), 1 unfinished job per person
  (`IMPORT_BUSY`), 10 starts per person per day (`IMPORT_DAILY_LIMIT`, 429), 3 running jobs per workspace.
- **Recovery**: at start-up and then every 2 minutes, `queued`/`running` rows whose heartbeat (or, never run, last
  change) is older than `IMPORT_STALE_HEARTBEAT_MS` become `interrupted`, except this process's own jobs. A deploy's
  overlap therefore never interrupts the old instance's live job; a dead process's rows go within 2-4 minutes.
- **Sweep** (hourly): an `importing` board older than 24 h that no live run holds (its row paused, interrupted,
  finished, or gone) is discarded; a paused or interrupted row then fails with `IMPORT_EXPIRED`.

### 2.4 The `importing` board

- `boards.status = 'importing'` (0035) is a **row status only**: `packages/permissions` keeps `BOARD_STATUSES` as
  the three a person can see and adds `BOARD_ROW_STATUSES`; `can()` refuses every action on any status it does not
  know; `isOpenBoardStatus` is what lists keep.
- `apps/api/src/access.ts` `loadBoardAccess`/`loadBoardAccessMany` read only `active`, `archived`, `trashed`: every
  route that decides access through them answers an importing board as a missing one (404), its owner included, and
  sync gets no role. Every list that used to say "not trashed" now says `status IN ('active', 'archived')`
  (dashboard members' boards, AI settings, backlinks, outside access, templates, checkpoint marks, search passes,
  private notes, touched); checkpoints and run-all skip it; the file collector does not scan it and holds its
  versions. A source tripwire (`apps/api/test/importing-board.test.ts`) refuses `<> 'trashed'` in `apps/api/src`.
- Creation and activation use `createBoardFrom`'s guards (workspace row first, creating role, `requireCreator`,
  room, project in the workspace), again at activation: someone who stopped being a creator, or left the workspace,
  during the import gets no board (`CREATOR_REQUIRED` / `NOT_FOUND`, the board discarded). The board is private,
  owned by the starter, audited `board.import.start`, then `board.create` with `via: 'miro' | 'backup'`.
- **Sync has no route to delete a board's file.** A canvas seeded before a failed activation stays an orphan file
  nobody can open (the row is gone, ids are never reused), exactly as `createBoardFrom`'s failed insert after a seed
  today. A sync discard route is a later option if orphans ever matter. Seeding an importing board needs nothing new:
  the seed does not look up file refs.

### 2.5 Rollback

0035 and 0036 are additive: roll the api back with `DRAFTROOM_ALLOW_NEWER_SCHEMA=1` and "Deploy a specific commit".
**But the rev-13 build's `can()` (main `db6a4dc7`) treats an unknown status as active**, and its access loaders read
every row. Once any import has run (an `importing` row may exist), roll back only to this foundation's build or
later, whose `can()` and loaders fail closed. Before WS1 or WS4 ships, no `importing` row can exist, so a rollback
past the foundation is safe until then. An importing board's id is never handed out before activation.

## 3. Import from Miro (WS1; contracts `miro-import.ts`)

| Route | Who | Body | Answer |
|---|---|---|---|
| `POST /api/workspaces/:wid/imports/miro/boards` | a creator who may create in `wid` (`'always'`) | `{ token, query?, offset? }` | `ListMiroBoardsResponse` (team name, ≤ 50 boards); nothing kept |
| `POST /api/workspaces/:wid/imports/miro` | the same | `{ token, boards ≤ 50, projectId?, referencePdf? }` | 202 `StartImportResponse` |

- **The token** is taken out of the parsed body by hand (`splitMiroToken`: never a schema, never an issue, never a
  message), checked with `MIRO_TOKEN_PATTERN`, wrapped as a `RedactedSecret` (`apps/api/src/egress/secret.ts`: it
  prints as `[redacted]` in String, JSON, inspect and pino) and handed to `runner.start`. The schemas
  (`ListMiroBoardsInput`, `StartMiroImportInput`) are strict and refuse a `token` key, so the split is mandatory. In
  the browser it is a `type=password`, `autocomplete=off` field kept only in the dialog's memory.
- **Egress** (`miroEgressPolicy(ctx.config.miroTestOrigins)`, `MIRO_EGRESS_USER_AGENT`): `https://api.miro.com`, GET,
  `MIRO_API_PATH_PATTERNS` (`/v1/oauth-token` and the v2 read paths: boards, a board, its items, connectors, groups,
  tags, members, a resource), Bearer allowed there only. Board ids go into paths as they are (`[A-Za-z0-9_=-]`, the
  `=` unencoded: the patterns match it literally; the probe records whether Miro accepts it, §3.4).
- **Files**: rewrite an item's `imageUrl`/`documentUrl` path (`MIRO_RESOURCE_PATH_PATTERN`) to
  `?format=original&redirect=false`; the JSON answer's `url` is fetched only if its host is in `MIRO_DOWNLOAD_HOSTS`,
  GET, no Bearer, and only while its `Expires` (epoch seconds) is in the future (`MIRO_FILE_RULE`). **The list is
  empty until the probe ran**: every file is refused (`file-host-refused` in the report, a placeholder card) until the
  lead adds the probed host in a reviewed change.
- Errors: `MIRO_TOKEN_INVALID` (400/401), `MIRO_SCOPE_MISSING` (403), `MIRO_BOARD_NOT_VISIBLE` (404),
  `MIRO_RATE_LIMITED` (after `MIRO_RATE.retries` waits of ≤ 60 s), `MIRO_UNAVAILABLE`; messages in
  `MIRO_CODE_MESSAGES`. Pacing: ≤ 8 requests a second per job, slower under 10 % remaining credits.
- Limits (`MIRO_IMPORT_LIMITS`): 10,000 items, 5,000 connectors, 1,000 files and 2 GiB of files per board; 50 boards
  per job; 4 MiB per JSON answer; 20 s per request.
- The fake Miro (e2e): `DRAFTROOM_MIRO_TEST_ORIGINS=<api origin>,<files origin>` (local dev only: it requires
  `DRAFTROOM_DEV_AUTH=1`), each origin standing for its rule (path and Bearer rules still apply).
- No URL found in Miro content (embeds, links) is ever fetched; mind maps (`/v2-experimental/…`) are not on the
  api's allowlist (AGENTS.md says `/v2/` read paths): they become placeholders unless a reviewed change adds it.

### 3.4 The probe (`scripts/miro-probe.mjs`, R0.4)

The owner runs it once on his machine, with a token of his:
`MIRO_TOKEN=… node scripts/miro-probe.mjs --boards 3 --json probe.json` (or `MIRO_TOKEN_FILE=…`; a `--token`
argument is refused). It prints the team, the scopes, the boards (names on screen only) and per board: counts by item
type, shape kind, sticky shape, font and position base, frame children, the first item ids in Miro's order, connector
shapes, caps and captions, groups and tags, the image and document download host with the **names** of its query
parameters and its time to expiry, optionally mind-map geometry (`--mindmaps`), the rate-limit headers, and whether a
board id works in a path as it is or encoded (`idInPath`). GET only, `api.miro.com` only, redirects refused; it never
prints or writes the token, a signed URL or item content. Its results fill `MIRO_DOWNLOAD_HOSTS`, the dialog's help
text (whether a personal token reaches the team's boards without a Miro admin's install) and
`docs/MIRO-IMPORT-CONTRACTS.md` (WS1). Afterwards: revoke the token in Miro.

## 4. Notifications to Slack and Teams (WS2; contracts `chat-hooks.ts`, migration `0036_chat_hooks`)

### 4.1 Routes and guards

| Route | Who (server-side) |
|---|---|
| `GET /api/workspaces/:wid/chat-hooks` | an owner or admin who is a creator (`'always'`, share; the role in the route) |
| `POST …/chat-hooks` `CreateChatHookInput` | the same; ≤ 20 hooks (`CHAT_HOOKS_FULL`) |
| `PATCH …/chat-hooks/:hid` `PatchChatHookInput` | the same (a new URL is checked and sealed again; `enabled: true` re-enables) |
| `DELETE …/chat-hooks/:hid` | any owner or admin (removing is lowering: no creator row) |
| `POST …/chat-hooks/:hid/test` | an owner or admin who is a creator; `TestChatHookResponse` ("sent", never "delivered") |
| `GET /api/me/chat-prefs?workspace=` / `PUT /api/me/chat-prefs` | any workspace member (never a name-only guest) |

Every route refuses a name-only guest (`CHAT_HOOK_GUESTS_MESSAGE`). With no `DRAFTROOM_WEBHOOK_SECRET` every route
answers 404 `CHAT_HOOKS_OFF`.

### 4.2 URLs (`CHAT_HOOK_RULES`, `checkChatHookUrl`)

- Printable ASCII, ≤ 2 KiB, WHATWG-parsed, `https:`, port empty or 443, no user or password, no fragment, a host with
  no trailing dot that is no IP literal, matched exactly (never by suffix): Slack `hooks.slack.com` +
  `/services/T…/B…/…` and no query; Teams `<tenant>.<2>.environment.api.powerplatform.com` +
  `/powerautomate/automations/direct/workflows/<hex>/triggers/manual/paths/invoke` with exactly `api-version`, `sp`,
  `sv`, `sig`. **The Teams host, path and query are UNVERIFIED**: the lead confirms them with one real Workflows URL
  from the owner (one paste, no message sent) before WS2 ships, and changes only this table.
- Retired Microsoft hosts (`*.webhook.office.com`, `outlook.office.com`, `*.logic.azure.com`) are refused with a
  message saying what to use (`CHAT_HOOK_URL_RETIRED`). The hint (`chatHookHint`) keeps 4 characters of the secret
  part.
- Egress: `chatHookEgressPolicy(ctx.config.chatHookTestOrigins)`, `CHAT_HOOK_EGRESS_USER_AGENT`: POST only, no
  Bearer, the provider's path and exact query keys; 5 s per request, ≤ 4 KiB of the answer read. The fake receiver:
  `DRAFTROOM_CHAT_HOOK_TEST_ORIGINS=<slack origin>[,<teams origin>]` (local dev only).

### 4.3 Sealing (`apps/api/src/crypto/sealed.ts`)

`createSecretBox(ctx.config.webhookSecret)`: AES-256-GCM, key = HKDF-SHA256(secret, info `lobby-chat-hook-url-v1`),
a fresh 12-byte nonce, AAD `chatHookAad(workspaceId, hookId)`; stored as `url_sealed` (nonce ‖ ciphertext ‖ tag,
29-2,076 bytes) with `key_id` (`k` + 3 digits of the key's fingerprint). `open()` says `stale` when only the previous
key opened it: re-seal it. **Rotation**: set `DRAFTROOM_WEBHOOK_SECRET_PREVIOUS` to the current value, then a new
`DRAFTROOM_WEBHOOK_SECRET`, run the re-seal pass (WS2), then remove the previous one. Losing the secret means the
admins paste the URLs again. `DRAFTROOM_WEBHOOK_SECRET` is `checkSecret`-validated (≥ 32 characters, no development
placeholder in production) and must differ from every other secret of the api. On Render it is generated in its own
env group `draftroom-staging-webhook-secret`, linked to the api only (`scripts/smoke/render-yaml.test.mjs`); the
lead applies it through the Render API before the deploy that first reads it.

### 4.4 Messages and delivery

- Kinds a person may send (`CHAT_HOOK_KINDS`): `mention`, `reply`, `new_comment`, `access_request`,
  `outsider_joined` (0036 CHECKs `chat_hook_prefs.kinds`). `resolved` and `access_granted` stay bell-only. All off by
  default; prefs go with the person's workspace membership (a FK through `workspace_members`) and with their hook.
- A message (`ChatMessage` → `chatMessageSentence`, `slackPayload`, `teamsPayload`) carries only the event, display
  names (`cleanDisplayText`), the board title (≤ 80), the link back to Lobby and, with `includeSnippets` on, a snippet
  ≤ 140 characters, never from a team-only thread. Slack: every string escaped (`&`, `<`, `>`) in the blocks **and in
  the fallback `text`** (a `<!channel>` name stays text), unfurling off, a section ≤ 3,000 characters. Teams: an
  Adaptive Card 1.4, markdown characters backslash-escaped (how Teams renders `\-` is UNVERIFIED: the live check),
  only `Action.OpenUrl`, < 25 KB.
- The outbox (`chat_deliveries`) is written in the notification's own transaction, unique per (hook, notification);
  the loop claims ≤ 20 due rows `FOR UPDATE SKIP LOCKED` every 2 s, re-checks the recipient's access, the thread and
  the hook at send time (else `dropped`), and retries per `CHAT_DELIVERY` (429 `Retry-After` ≤ 10 min; 5xx, network
  and timeouts back off 30 s, 2 min, 10 min, 30 min, 2 h; 400 `failed`; 403/404/410 disable the hook with a reason).
  Caps: 1 a second per hook, 30 an hour per recipient, 600 an hour per workspace; over a cap, `coalesced` into one
  "and N more" message. Rows hold codes only, never the receiver's words; purged after 14 days.

## 5. Board backup and restore (WS4; contracts `board-backup.ts`)

| Route | Who | Answer |
|---|---|---|
| `POST /api/boards/:bid/backup/ticket` | whoever may export the board (view + its export policy) | `BackupTicketResponse` (a one-minute ticket for the api's own origin) |
| `GET /api/boards/:bid/backup?ticket=` | the ticket | `application/vnd.lobby.board+zip`, streamed (direct to the api origin: the static site's `/api` rewrite buffers) |
| `POST /api/workspaces/:wid/backups` (`?projectId=&title=`; body: the file) | a creator who may create in `wid` (`'always'`) | 202 `StartImportResponse`: an import job, source `'lobby-backup'`, always a NEW private board |

- A name-only guest is refused the ticket and the restore; the download itself has no guest row (it is
  ticket-authorised, like the event stream).
- A `.lobby` is a ZIP (no ZIP64, no encryption, methods 0 and 8) holding exactly `manifest.json` (first,
  `BoardBackupManifest`), `board.json` (the v2 archive, unchanged) and `files/<sha256>` (each original once, STORED).
  Any other name refuses the file (`isBackupEntryName`). Limits (`BACKUP_LIMITS`): 2 GiB and 5,000 files, `board.json`
  ≤ 64 MiB, the central directory ≤ 16 MiB, a restore body ≤ 2 GiB + 64 MiB. Codes: `BACKUP_TOO_LARGE`,
  `BACKUP_INVALID`, `BACKUP_FROM_NEWER_LOBBY`, `EXPORT_DISABLED`. A restore spools to the blob store and reads by
  range; every file becomes a new asset and version of the importing board (sha256-checked, then the worker's checks);
  elements go through `importLobbyArchive` and sync's seed validation.

## 6. Design-file previews (WS3; contracts `design-previews.ts`)

- `DESIGN_PREVIEW_KINDS`: `psd`, `ai`, `tiff` (flattened pages, classified `pdf` like Office) and `heic` (an
  attachment with a hint). `designFormatOf(mime, name)` reads the table (`application/postscript` alone is EPS, not
  Illustrator). Codes and messages (`DESIGN_PREVIEW_CODES`): `NO_PDF_CONTENT`, `POSTSCRIPT_NOT_SUPPORTED`,
  `PSD_THUMBNAIL_ONLY`, `PSD_NO_COMPOSITE`, `PSD_UNSUPPORTED`, `HEIC_NO_PREVIEW`, `DESIGN_TOO_LARGE`; the badge
  `DESIGN_PREVIEW_BADGE` ("Flattened preview"); never "editable". Worker limits: `DESIGN_PREVIEW_LIMITS`.
- The same rows are in `packages/dev-assets/src/shared.ts` `DESIGN_FORMATS` (the worker does not depend on
  contracts); `apps/api/test/design-formats.test.ts` compares the two and proves the foundation changed no
  classification: a PSD, TIFF or HEIC upload is still `other` until WS3 wires `classifyUpload` and `maxUploadBytes`
  with the worker in one change.

## 7. The web

- `apps/web/src/dashboard/import-menu/`: `ImportMenu` renders today's "Import" button (`data-testid="import-board"`,
  the same title and file input) while `IMPORT_MENU_FLAGS` are off (`menu`, `miro`, `backup`). With `menu` on and at
  least one more entry, an "Import" menu (`data-testid="import-menu"`): "Lobby backup (.lobby)…" (WS4 passes
  `onBackup`), "Lobby board (.json)…", "From Miro…" (WS1 passes `onMiro`). A dev-auth page may set
  `localStorage['lobby.importMenu' | 'lobby.importMiro' | 'lobby.importBackup'] = '1'` (or `'0'`).
- Client stubs with frozen signatures (no request; reads empty, writes reject `'unavailable'`):
  `dashboard/imports/client.ts` (`ImportRequestError`; WS1 makes it live), `dashboard/import-miro/client.ts`,
  `dashboard/import-backup/client.ts`, `features/notify-settings/client.ts` (`ChatHookRequestError`). The browser
  never calls Miro, Slack or Teams.

## 8. The egress module (`apps/api/src/egress`)

```ts
egressFetch(deps, { method, url, accept?, body?, contentType?, bearer?: RedactedSecret, timeoutMs, maxBytes })
  → { status, headers (content-type, content-length, retry-after, x-ratelimit-*), body: Buffer }
egressOpen(deps, req) → { status, headers, body: Readable }   // metered: errors 'too-large' / 'timeout'
egressDeps(policy, userAgent, { lookup?, request?, now? })
withSecrets(secrets, fn, keep?) / secretSafe(e, secrets) / errorFacts(e) / redact(text, secrets)
```

A request is refused before anything resolves unless one rule allows all of it (`checkTarget`: https:443, no userinfo
or fragment, exact host or anchored tenant pattern, never an IP literal, its paths and methods, Bearer only where the
rule carries one, the rule's URL check). Then every address the host resolves to must be public (link previews'
`isPublicAddress`, their c-ares lookup with a time limit) and the connection goes to that address (pinned). Any 3xx is
refused (`redirect`); one deadline covers lookup, connect and the whole body; the byte cap applies after
decompression; only User-Agent, Accept, Accept-Encoding, Content-Type/Length and the Bearer header are sent, no
cookies, no connection reuse. Every other status is an answer (the caller maps it). `EgressError` holds a reason, a
status and a refusal detail, never a URL, header or body. Link previews keep their own fetch (http allowed, redirects
followed and re-checked): unchanged.

## 9. Where the foundation differs from the design

- **`importing` is not a `BoardStatus`.** Adding it to `BOARD_STATUSES` would have widened `ListBoardsQuery.status`
  (a `?status=importing` list) and the public `Board` schema. It is `BOARD_ROW_STATUSES` instead; `can()` fails closed
  on anything unknown.
- **The lists did not "filter on active and archived".** Sixteen api queries said `status <> 'trashed'`, which would
  have shown importing boards (dashboard members' boards, backlinks, outside access, templates, search passes, …).
  They now name what they keep, the access loaders skip importing rows, and a tripwire test keeps it so.
- **The rev-13 `can()` falls through to the active rules** for an unknown status (checked on `db6a4dc7`): the
  rollback rule of §2.5.
- **Sync has no board delete route** (the design asked to verify it): a seeded canvas of a failed activation stays an
  orphan file, as `createBoardFrom` does today.
- **Ids**: the job (`importId`) is `imp_` and each board row `imb_` (the design put `imp_` on the rows and left the
  batch unconstrained). **Pause** is a status (`paused`, `pause_requested`), as the lead asked, besides cancel and
  interrupted. 0035 also has `title`, `position`, a board FK with `ON DELETE SET NULL (board_id)`, and
  `board_import_files.version_id` nullable (a failed file) with a FK to its version and a note code.
- **0036**: `chat_hooks.created_by` is nullable (`ON DELETE SET NULL`: the hook is the workspace's), `updated_at`;
  `chat_hook_prefs` reaches its person through `workspace_members` (a removal deletes the prefs by itself) and CHECKs
  its kinds; `chat_deliveries` has a `coalesced` status and code-only `last_code`.
- **The webhook key has its own Render env group, linked to the api only**: the shared secrets group is linked to
  sync too.
- **Link previews are not moved onto the egress module**: their behaviour differs (http, followed redirects); egress
  shares their address and DNS code instead, and their tests are unchanged.
- **Recovery uses the stale heartbeat on a timer**, never "every running row at start-up", so a zero-downtime deploy
  does not interrupt the old instance's job.
- **`MIRO_DOWNLOAD_HOSTS` is empty** until the probe: files fail closed instead of trusting `r.miro.com` from a 2023
  community post. **Mind maps** (`/v2-experimental/`) are not on the api's allowlist (AGENTS.md says `/v2/`).
- **The Slack fallback `text` is escaped** like the blocks (the design's example left it raw: a `<!channel>` name in
  it would have pinged the channel). **Teams** needs exactly `api-version`, `sp`, `sv`, `sig` (UNVERIFIED).
- **Listing chat hooks needs a creator** too (`'always'`), as the design's test matrix implies (a non-creator admin is
  403); removing one does not.
- **`DESIGN_FORMATS` is data only**: wiring `classifyUpload` before the worker can preview PSD would have turned PSD
  uploads into failed previews; WS3 owns those two lines of `shared.ts`.
- **AGENTS.md**: the Miro exception names the owner-run probe as the one other process that calls Miro (else the
  probe the design asks for would contradict "no other process").
- **No new dependency**: `ag-psd` is WS3's, pre-approved by the lead.

## 10. Checks (the foundation's head)

Run on the foundation's head, on the Windows PC (2026-10-16):

| Check | Result |
|---|---|
| `pnpm -r typecheck` | 16 packages, pass |
| vitest `packages` | 63 files, 1,912 tests pass (1 skipped) |
| vitest `api` (PGlite) | 212 files, 2,032 tests pass (128 skipped: the real-Postgres files). One earlier full run failed once on `convert-v1-worker.test.ts` (a timing test of conversion slots, untouched here); it passed alone 3 times and in the next full run |
| vitest `sync` | 132 files, 849 tests pass (5 skipped) |
| vitest `web` | 460 files, 5,531 tests pass (1 skipped) |
| vitest `scripts`, `dev-assets` | 26 and 9 tests pass |
| `node --test scripts/smoke/render-yaml.test.mjs` | 7 pass |
| `pnpm licence:check` | PASS (no new dependency) |

Not run here: the `*.pg.test.ts` files (they need `DRAFTROOM_TEST_DATABASE_URL`: the lead runs them on the NAS),
biome (it cannot run on this PC: the lead lints on the NAS), e2e (nothing user-visible changed; the import-board
button keeps its test id).
