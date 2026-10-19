# Wave W contracts: Formats

Wave W is about the formats people bring to a board: **doc cards** (a formatted text card on the canvas, WS1),
**background removal** on images (WS2), **search inside files** (the text of PDFs and Office documents in search and Ask,
WS3), **deck import** (a PPTX, ODP or PDF placed as slides, WS4) and a **workspace admin page** (WS5, who also runs the
gate). Background removal, file search and deck import run on the NAS preview worker through one new job family, the
**worker ops** (§3). The foundation (branch `wave-w/foundation`) lands the shared contracts, migration `0039_formats`, the
five api kill switches, every wave W browser route pending behind its switch with its guard rows, the worker ops protocol
on the api (live, with stub per-kind handlers) and on the worker (with no runner), the capability report and the model file
check, `onnxruntime-node` (worker only, its install script blocked), the web switches, the three wave W board features
(registered empty), the `/w/:wid/admin` route and the models rule of the licence check. Nothing changes for a user until
the workstreams land:

- every new browser route is **pending** (`apps/api/src/features/pending-routes.ts`): not registered, so it answers 404
  `NOT_FOUND` exactly like an unknown route, for every caller; once its owner lands it, its **kill switch** gates it the
  same way while off (§1.2);
- the api switches are off (`render.yaml`: `"off"`; unset is off) and `GET /api/auth/config` says so (`formats`);
- the worker ops routes are live but hand out nothing: no route queues an op yet, and the foundation's worker build
  reports no capability (it has no runner), so the api hands it nothing and offers nothing worker-backed to the web;
- every web switch is off (`apps/web/src/features/formats/flags.ts` `FORMATS_FLAGS`), the three board features are
  registered empty, and `/w/:wid/admin` is the unknown-address screen;
- the five wave W palette ids are pending (`PENDING_PALETTE_COMMAND_IDS`).

What does not change: the sync protocol (`CONTRACTS_REV` stays **14**: §9.1), `ELEMENT_SCHEMA_VERSION` (1),
`LOBBY_CLIENT_REV` (3: no existing response enum gains a value), every `customData` key, the preview job protocol (an old
worker keeps working against the new api: §9.1), and the sync (not deployed in wave W). Design: the wave W scout
(`scratchpad/wave-w/SCOUT.md`), followed except where §12 says why not. Lead decisions taken as given: no rev bump; the
model file is not downloaded by anyone but the owner, after a separate approval; retention on the admin page is
read-only; the worker side ships as a NAS worker rebuild after the wave (the owner's standing OK).

## 1. The switches

### 1.1 The api (`apps/api/src/config.ts` `parseOnOff`, `parseFormatSwitches`)

| Variable | Feature | Values |
|---|---|---|
| `DRAFTROOM_DOC_CARDS` | doc cards (WS1; no api route: the web's offer) | `on`; `off`, empty or unset = off; anything else (any case, trimmed) refuses to start: `… must be on or off` |
| `DRAFTROOM_REMOVE_BACKGROUND` | background removal (WS2), op kind `remove-bg` | as above |
| `DRAFTROOM_FILE_SEARCH` | search inside files (WS3), op kind `extract-text`, file hits in search and Ask | as above |
| `DRAFTROOM_DECK_IMPORT` | deck import (WS4), op kind `render-pages` | as above |
| `DRAFTROOM_WORKSPACE_ADMIN` | the workspace admin page (WS5) | as above |

Read once at boot (`ApiConfig.formats`, contracts `FormatSwitches`); a change is a restart. `render.yaml` sets all five to
`"off"` on the api only (`scripts/smoke/render-yaml.test.mjs`); the e2e stack (`e2e/tests/support/stack.ts`) and the api's
`setupWorld` set all five `on` (a spec may set one `off` through `apiEnv`).

### 1.2 What "off" means (`apps/api/src/features/formats/switch.ts`, a copy of wave V's `live/switch.ts`)

- Every browser route of the feature answers **exactly like an unknown route** (the root 404 `{"error":{"code":"NOT_FOUND",
  "message":"Not found."}}`) for every caller. The gate is the route's own `onRequest` hook (`formatsRoute`), before the
  body is parsed and before the root guards, so neither a guest refusal nor anything else tells anyone the feature
  exists, and nothing is read or written.
- No op of its kind is handed to a worker (`claimOp` filters by `enabledKinds`), and a queued one fails
  `WORKER_UNAVAILABLE` at the next claim (§3.1). File search off: file text rows stay, are never read, and searches
  return canvas hits only (WS3 checks `formatsOn(ctx, 'fileSearch')` in the query).
- A route may open on any of several switches: `GET /api/file-ops/:op` and its cancel open while
  `DRAFTROOM_REMOVE_BACKGROUND` or `DRAFTROOM_DECK_IMPORT` is on, and then answer 404 for an op whose own kind is off.
- `DRAFTROOM_DOC_CARDS` gates no route: a doc card is an ordinary element. Off, the web offers no insert, face or panel
  (a placed card stays a rectangle with its text, editable as any label).
- Every wave W browser route registers through `formatsRoute(app, ctx, gate, method, url, handler)` and nothing else;
  until its owner implements it, its handler is `formatsStub` (501 `NOT_IMPLEMENTED`, reachable only with the route off
  the pending list and its switch on). Test: `apps/api/test/features/formats/switch.test.ts`.

### 1.3 The web (`apps/web/src/features/formats/flags.ts`)

`FORMATS_FLAGS` `{docCards, removeBackground, fileSearch, deckImport, admin}`, all `false`; a dev-auth page may set
`FORMATS_FLAG_KEYS[name]` (`lobby.formatsDocCards`, `…RemoveBackground`, `…FileSearch`, `…DeckImport`, `…Admin`) to
`'1'`/`'0'` in localStorage (read in try/catch; a production bundle ignores it). `formatsEnabled(flag)`: the web switch
AND the api's offer (`FORMATS_FLAG_SERVER`: every flag needs one, doc cards too, so their kill switch hides them);
`formatsOffer` is a signal the session sets from `AuthConfig.formats` (`setFormatsOffer`; anything not exactly `true` is
off). Each workstream turns its own `FORMATS_FLAGS` line on (through the lead) in the change that makes its feature live;
the api still decides every request.

## 2. Doc cards (WS1, web only; contracts `formats.ts` `FORMAT_ELEMENT_KINDS.docCard`, `DOC_CARD_LIMITS`)

**A board element, not an api-stored document** (the scout's table: one authority, the existing lease, merge, undo,
search, exports, archives, backups and the stale tab all for free; an api doc would need its own concurrency, which
AGENTS.md forbids). Never call the feature "doc": that is the board document `lb_doc`.

- **The element**: a `rectangle` with `customData.lobby.kind = 'doc-card'`, created at 640 × 400, white fill, a 1 px
  stroke; its bound label (`containerId` = the card) has `textAlign: 'left'`, `verticalAlign: 'top'`, the body font. The
  label's `originalText` holds **Markdown-lite**: `#`/`##`/`###` headings, `**bold**`, `_italic_`, `` `code` ``, `-` and
  `1.` lists, `- [ ]`/`- [x]` checklists, `>` quotes, `---` rules, `[text](url)` links (only `https:` and Lobby-relative
  `/b/…` are made clickable, opened with `noopener`, never fetched). The words stay readable as plain text in an old
  tab, exports, search and Ask.
- **The face** (`features/doc-cards/DocFace.tsx`, a CardLayer-style face over visible cards only, not while editing): a
  dependency-free parser (`markdown-lite.ts`: linear time, at most `DOC_CARD_LIMITS.maxBlocks` 2,000 blocks and
  `maxInlineNodes` 20,000 inline nodes) emits **React nodes, never HTML** (no `dangerouslySetInnerHTML`, as today in
  `apps/web/src`). Headings by weight, not size, so the server-derived height still fits; overflow is cut with a fade
  and an "Open" button. The face is never in an export (WS1 decides whether PNG/PDF strip the marks through the
  export-overlay registry, `present-export/ported/badges.ts`; recommended: strip).
- **Editing: a side panel `DocEditor`** (a textarea plus a toolbar that inserts marks), a **lease client**: it acquires
  the card's text lease through `canvas/lease` and is read-only until granted; renews through presence `editing`; pushes
  words, layout and the container's fit at `TYPING_PUSH_MS` through the existing holder path (`fit.ts`, `words.ts`);
  closes without writing when the lease is lost; releases on close. Double-click and double-tap on a doc card open the
  panel (`canvas/input/dblclick.ts`, `doubleTap.ts`); the panel goes on the input guard's list with a test that it is
  never writable without a lease this tab holds (AGENTS.md). The engine's own editor path stays guarded; for a 7e5b4d6
  tab it is plain text editing under the lease, as for any label.
- **The insert**: palette `doc-card.insert` and an Insert-menu entry; `doc-card.from-text` turns a selected text into a
  new card in one undo step.
- **Limits**: `DOC_CARD_LIMITS.maxChars` 20,000 (= `MAX_ORIGINAL_TEXT_CHARS`, a counter in the panel); search indexes the
  first 4,000 characters per entry (`ENTRY_MAX_CHARS`, `apps/sync/src/http/board-text.ts`; raising it is a sync change:
  not in W, and the panel says so). Proven: a doc card at 20,000 characters passes every frozen reader
  (`wave-w-kinds.test.ts`).
- **Risks**: one writer per card (unlike Miro): the UI says "Name is editing"; a 20k-character card at a 500 ms push is
  about 80 KB per push: WS1 measures the room's p95 commit and the relayout CPU on the NAS and lowers the cap to 12,000
  (through the lead) if the gate misses.
- **Tests (WS1)**: the parser (adversarial nesting, a 20k-character line, `javascript:`/`data:` links refused, no HTML
  passthrough); the panel is never writable without a lease and closes without writing on loss; two tabs: B sees "A is
  editing" and a read-only panel; one undo step per edit session; the face never in exports; and **the stale pair**
  `e2e/excalidraw/w-compat-7e5b4d6.spec.ts` with the real 7e5b4d6 web (`E2E_OLD_WEB_DIST`, the build steps of
  `e2e/excalidraw/l-compat-kit.ts`): on a board where a new tab places a doc card AND deck slides (WS1 writes the slide
  frames and page images itself from a fixture PDF's pages 1..8, so the spec does not wait for WS4), the old tab keeps
  the board live, drops no frame, renders the card as a labelled rectangle and the slides as frames with images, pushes
  nothing while it only receives, and its plain edits of the card's words survive.

## 3. Worker ops (the lead's; contracts `formats.ts` `WorkerOp*`; migration 0039)

`preview_jobs` cannot carry new work (one row per version, `done` once the preview exists). Wave W adds one job family
beside it; the preview path is untouched.

### 3.1 The model (`worker_ops`, `worker_op_outputs`; `apps/api/src/worker/ops-jobs.ts`)

```
queued ──claim──> running ──complete──> done
  ^  │              │ └──fail(retry, attempts left) / fail(release)──> queued (run_after = backoff | now)
  │  │              └──fail──> failed (error_code)
  │  ├──(due > 15 min, or its kind's switch off: expireOps at each claim)──> failed WORKER_UNAVAILABLE
  │  └──(at claim: board trashed or gone)──> cancelled CANCELLED; (source version not ready)──> failed SOURCE_MISSING
  └──lease expired──┘ (reclaimed by the next claim; attempts count claims; the claim after the 3rd fails INTERNAL)
```

- Kinds `remove-bg`, `extract-text`, `render-pages` (`WORKER_OP_KINDS`), each with a strict params shape
  (`WORKER_OP_PARAMS`: `{}`; `{maxPages ≤ 300}`; `{from, to}`, at most 30 pages) and result (`WORKER_OP_RESULTS`).
- **One active op per (kind, source version, `params_key`)** (0039 `worker_ops_active_idx`; `params_key` is the canonical
  params, `'-'` or `'9-38'`): a second request is 409 `FILE_OP_ACTIVE` naming the first.
- Leases as previews: `WORKER_OP_LIMITS.leaseMs` 120 s, heartbeats every leaseMs/4 (≤ 30 s), every lease-bound call checks
  status = running AND `lease_owner` AND `attempts = attempt` under the row lock (`FOR UPDATE SKIP LOCKED` at claim).
- **Outputs** are attempt-scoped reservations (`worker_op_outputs`, like `asset_derivative_reservations`): `role:
  'original'` (remove-bg's PNG: a NEW asset and version id picked at reservation, key `assets/<new ast>/<new ver>/original`)
  or `role: 'page'` (render-pages: a derivative id under the SOURCE version, key `assets/<ast>/<ver>/d/<drv>.<ext>`), at most
  32 per attempt, 32 MiB each. A reclaimed, failed, released or completed op drops its unpublished reservations; their
  blobs are deleted after COMMIT.
- No I/O inside a transaction; the clock is the api's (`now`), never Postgres `now()`.

### 3.2 The worker wire (`WORKER_OP_ROUTES`; `apps/api/src/worker/ops-routes.ts`)

Registered inside the preview protocol's scope of `worker/routes.ts`, so they share the Bearer token check
(`DRAFTROOM_WORKER_TOKEN`), the cookie refusal (403), the one rate limit for every worker route, the error shape
`{error:{code,message}}` and pattern-only logging. They are not on the pending list (the worker protocol; nothing is
handed out until a browser route queues an op).

| Route | Body (contracts) | Answer |
|---|---|---|
| `POST /api/worker/ops/claim` | `WorkerOpClaimInput` `{workerId, capabilities ≤ 16}` | 204 none; 200 `WorkerOpClaimed` `{op: {id, kind, capability, boardId, sourceVersionId, params, attempt, leaseMs, source: {kind, name, mimeType, sizeBytes, pageCount}}, source: {url}}` (a presigned GET, or the fs-mode grant `q.<wop>`; 900 s) |
| `POST /api/worker/ops/:op/heartbeat` | `WorkerOpLeaseInput` `{workerId, attempt}` | `{leaseMs}`; 409 `LEASE_LOST` |
| `POST /api/worker/ops/:op/output` | `WorkerOpOutputInput` `{…, role, page?, mimeType png/webp, width, height ≤ 16,384, bytes ≤ 32 MiB}` | `WorkerOpOutputReserved` `{outputId wpo_, upload: {url, method: PUT, headers}}` (presigned PUT, or fs-mode `p.<wpo>`); the kind may refuse (`checkOutput`: 4xx with a code) |
| `POST /api/worker/ops/:op/text` | `WorkerOpTextInput` `{…, pages: [{page 1..300, body ≤ 8,000}] 1..50}` | `{pages}`; extract-text only (the kind stores them, an upsert per page) |
| `POST /api/worker/ops/:op/complete` | `WorkerOpCompleteInput` `{…, outputs: wpo_[] ≤ 32, result ≤ 4 KiB}` | `WorkerOpDone` `{opId, status, repeated}`; 409 `OUTPUT_MISSING` (a listed blob absent or not its reserved size/type), 400 `UNKNOWN_OUTPUT`, `DUPLICATE_OUTPUT`, `RESULT_TOO_LARGE`; a repeat of the same worker and attempt answers `repeated: true` |
| `POST /api/worker/ops/:op/fail` | `WorkerOpFailInput` `{…, code, retry?, release?}` | `WorkerOpDone`; the code users see is `opFailureCode(code)` (unknown → `INTERNAL`); the worker's own detail is never stored or logged |

The per-kind work on the api is one interface (`worker/ops-kinds.ts` `OpKindHandler`: `checkOutput`, `acceptText`,
`complete`, each in the op's transaction under its lease); the foundation's handlers are 501 stubs (`stubKind`). WS2, WS3
and WS4 each replace their kind's line in `OP_KINDS` (through the lead).

### 3.3 Capabilities and the web's offer

- A capability is `<kind>[:<variant>]@<version>` (`WORKER_CAPABILITY_RE`); the current ones are `remove-bg:u2netp@1`,
  `extract-text@1`, `render-pages@1` (`WORKER_CAPABILITIES`). The api hands a worker only kinds whose CURRENT capability
  it reports **exactly** (`claimableKinds`) AND whose switch is on; bumping a version means "the old runner's output is no
  longer acceptable".
- Every claim records what the worker reported in `worker_capabilities_seen` (one row per capability; at most one write
  per 30 s each; the last worker id for operators).
- `GET /api/auth/config` `formats` (`features/formats/offer.ts`): `docCards` and `admin` are their switches; the three
  worker-backed ones are their switch AND their current capability seen within `WORKER_OP_LIMITS.capabilityFreshMs`
  (10 min). Cached 15 s (forgotten on each claim), fails closed (a database error offers none of the three). So until the
  owner rebuilds the NAS worker, the web offers nothing that would only queue.
- The worker reports a capability only when (`apps/worker/src/ops/capabilities.ts`): its kind is enabled by `WORKER_OPS`
  (`all` or unset; `none`; a comma list), the build has a runner for it (`ops/dispatch.ts` `OP_RUNNERS`, empty in the
  foundation), and its prerequisites hold (remove-bg: the model file passes its pinned hash, §4.2). It logs at start which
  capabilities it reports and why the others are not (no path or value).

### 3.4 An op as its requester sees it (`FileOpState`; `features/formats/op-state.ts`)

`{id, kind, status, boardId, sourceVersionId, resultVersionId, pagesReady, errorCode, message, createdAt, finishedAt}`:
no person, path or URL. The `file.op` event (`FILE_OP_EVENT`, `FileOpEvent {op}`) goes after COMMIT to the **requester's**
streams on the op's board only (`events/hub.ts` `to`), with the same body `GET /api/file-ops/:op` answers; an op without a
requester (WS3's extract-text) has none. A queued op past its time reads as failed `WORKER_UNAVAILABLE` before any sweep
wrote it (`opExpired`). The message is `WORKER_OP_MESSAGES[code]`, a fixed user-safe text. WS2 added (through the lead,
folded in at integration) the optional `resultAssetId` (`ast_…`, a done remove-bg's NEW asset, so the web can point
`customData.lobby.file.assetId` at it; null otherwise; optional, so the foundation's shape still parses).

### 3.5 The worker side (`apps/worker/src/ops/{client,loop,dispatch,capabilities,bg-model,bg-inference}.ts`)

- `remote-loop.ts` asks for an op only when its preview claim came back empty, in the same slot: **previews keep
  priority** and ops share `WORKER_CONCURRENCY` (1 on the NAS).
- `runOneOp` / `runClaimedOp`: claim → the op's own temp dir (`drw-job-*`, swept like preview jobs) → heartbeats → the
  kind's runner (`OpRunner.run(ctx)` → `{outputs, result}`) → complete. `OpFailure(code, retry)` fails with its code; any
  other error fails `INTERNAL` with a retry; a lost lease (409/404 on any call) aborts the run and sends nothing more; a
  shutdown past the grace aborts and releases (the attempt not counted).
- An api of before wave W answers the ops claim 404: the client reports `'unsupported'`, the loop logs once "this api has
  no worker ops: previews only" and asks again only after 10 minutes. A worker that reports no capability never calls the
  ops routes at all (a worker of before wave W is exactly that).
- `ops/client.ts` uses the preview client's one POST (`api-client.ts` `createApiCall`, factored out: the token to the API
  origin only, no redirects, a timeout, errors by kind) and parses the claim with the contracts' strict `WorkerOpClaimed`.

## 4. Background removal (WS2; contracts `REMOVE_BG_LIMITS`, `noBackgroundName`)

### 4.1 The flow

1. On a ready image, "Remove background (beta)" calls `POST /api/files/:ver/remove-background {boardId}`
   (`FileOpInput`, strict). The route checks, in order: the switch (its gate) AND a worker with
   `WORKER_CAPABILITIES['remove-bg']` seen within 10 min (else the same 404); `requireBoardAction(edit)` with an account
   (name-only guests are refused by the guard first: 403 `GUEST_ACCOUNT_REQUIRED`, `FORMAT_GUESTS_MESSAGE`); the version is
   served on that board (`files-auth.ts`), kind image, a `REMOVE_BG_LIMITS.inputMimeTypes` type, `ready` (409
   `FILE_NOT_READY`), within the size and pixel limits (400 `FILE_OP_UNSUPPORTED`); quota room (`checkRoom`; 507
   `QUOTA_EXCEEDED`); the windows (429 `FILE_OP_LIMIT`). Then the `worker_ops` row (params `{}`, `params_key '-'`,
   `requested_by` = the caller): 202 `FileOpState`.
2. The worker runner (`apps/worker/src/ops/remove-bg.ts`) downloads the original with the `transfer.ts` caps and spawns
   `node --max-old-space-size=256 apps/worker/src/ops/bg-child.ts` (argv only, the minimal env, a 45 s SIGKILL). The child
   decodes with sharp (`limitInputPixels` 40 MP, `failOn: 'warning'`, first frame only; animated input refused), resizes to
   320², runs the model through `ops/bg-inference.ts` `createOrtInference` (the only `onnxruntime-node` import, dynamic,
   child process only), upsamples the mask to the output size (long edge ≤ 4,096), applies it as alpha and writes a PNG
   RGBA to a temp file; the parent re-reads it with sharp metadata, reserves an `original` output, PUTs it and completes
   with `RemoveBgResult {sha256, width, height, bytes}`.
3. The completer (`features/formats/remove-bg/kind.ts`), in the op's complete transaction: re-checks quota and that the
   board is still active; inserts a **new asset and version** (the output's ids, kind image, mime `image/png`, name
   `noBackgroundName(<source name>)`, `board_id` = the op's board, `uploaded_by` = the requester,
   `derived_from_version_id` = the source) and its `preview_jobs` row (thumbnails and display images come from the normal
   pipeline); returns `resultVersionId`. After COMMIT the requester gets `file.op` and the board `assets.version`.
4. The web, on `done`, swaps the element's `fileId` and `customData.lobby.file` to the new version in ONE
   `canvas.transact` (one undo step: undo puts the original back). Never base64, `data:` or `blob:`: the result is a
   stored version with a stable `ver_` id. A new asset, not a new version in the chain (a chain would reset review status
   and say "v2 is newer" on every board linked to the asset: wave S); "Save as new version" is a follow-up.

### 4.2 The model file (`apps/worker/src/ops/bg-model.ts`; `apps/worker/models/MODELS.json`)

- **U²-Net small, `u2netp`** (xuebinqin/U-2-Net, Apache-2.0 for the repository, which includes the weights; 320 × 320; the
  published file is about 4.6 MB). The only model that fits the 1.5 GB NAS worker comfortably. Excluded: BRIA RMBG
  (non-commercial), `@imgly/background-removal-node` (AGPL); later candidates (U²-Net full, BiRefNet MIT, IS-Net) need a
  memory cap raise (§11).
- **It is never downloaded by Lobby, at build or at run time, and the foundation fetched nothing.** The owner places the
  approved file (a separately approved one-time download) and points `DRAFTROOM_BG_MODEL_PATH` (absolute) at it.
- `checkBgModel(path)` reports the capability as missing when the path is unset or relative, the file is absent, a
  directory, larger than 16 MiB, or its sha256 differs from `BG_MODEL.sha256`. **That pin is `null` (a TODO for the
  owner's approved file)**, and a null pin passes no file: background removal stays off whatever its switch says until
  the owner supplies the file and the lead commits its hash in `bg-model.ts` and `MODELS.json` together.
  `loadBgModel` re-checks the bytes in the child before use.
- `MODELS.json` lists every model a Lobby process may load (id, file, licence, https source, notice, sha256 or null);
  `pnpm licence:check` fails on a non-permissive licence, a missing source, a malformed hash, or any weights file in the
  repository (`.onnx`, `.ort`, `.pth`, `.pt`, `.safetensors`, `.tflite`, `.ckpt`, `.h5`, `.pb`, `.gguf`, `.mlmodel`) that
  is not listed with its exact hash (`scripts/licence-models.test.ts`). There is none today.

### 4.3 The runtime: `onnxruntime-node` 1.30.0 (the foundation's dependency change)

- MIT (Microsoft), published 2026-09-14, checked on the npm registry 2026-10-19. Its tree: `onnxruntime-common` 1.30.0
  (MIT), `adm-zip` 0.6.1 (MIT) and `global-agent` 4.1.3 (BSD-3-Clause, with `globalthis`, `matcher`, `serialize-error` and
  their MIT tree); the last two are used only by its install script. The lockfile adds those 16 packages.
- Its `postinstall` (`script/install`) would download CUDA binaries on linux x64: **blocked** by
  `allowBuilds: {onnxruntime-node: false}` in `pnpm-workspace.yaml` (`strictDepBuilds` stays on). The CPU binaries ship in
  the tarball (`bin/napi-v6/{linux,win32,darwin}/<arch>`; linux/x64 45 MB of 301 MB unpacked).
- **Verified on this Windows x64 machine, with the script blocked**: `apps/worker/test/ort-cpu.test.ts` runs a tiny model
  encoded byte by byte in the test (`test/tiny-onnx.ts`: ReduceMean over the channels + Sigmoid, the u2netp shape
  `[1,3,S,S] → [1,1,S,S]`) on the CPU provider and matches its oracle to 1e-5 (3/3). Not yet verified: the linux/x64
  binary in the Debian 13 worker image on the NAS CPU (glibc and instruction set). **WS2 checks it before relying on it**,
  in a throwaway `draftroom-spike-*` container (AGENTS.md NAS rules), and proposes (through the lead, with an image build)
  the `docker/worker.Dockerfile` line that keeps only `bin/napi-v6/linux/<arch>` (the image is 1.19 GB today; the other
  platforms' 256 MB of binaries serve nothing there).
- Session options (`BG_SESSION_OPTIONS`): CPU provider only, `intraOpNumThreads` 2, `interOpNumThreads` 1,
  `enableCpuMemArena: false`, `graphOptimizationLevel: 'all'`. Rejected: `onnxruntime-web` in the browser (needs
  `wasm-unsafe-eval` in the CSP and ships the model to every client).

### 4.4 Tests (WS2; never the real model)

The tiny synthetic model (`test/tiny-onnx.ts`, any square size) or an injected `BgInference`. The api: switch off and no
capable worker are both 404; guest, viewer and commenter refusals; a version of another board 404; quota at request and at
complete (a race); idempotent complete; a trashed board cancels at claim; the windows (one active per user, 30 an hour, 300
a workspace a day, 3 active a workspace). The worker: alpha present and the mask non-empty on fixtures; deterministic
within a tolerance; a decompression bomb, a truncated PNG and an animated GIF refused; the timeout kill; a heap OOM gives
`REMOVE_BG_FAILED`, not a crash; the ORT session is never created in the parent (`createOrtInference` is reached only
from `bg-child.ts`). The web: one undo step restores the original; a stale tab sees the `fileId` change; no
`data:`/`blob:` URL in any element; the e2e no-outside-request assertion.

### 4.5 Limits (`REMOVE_BG_LIMITS`)

Input at most 25 MiB, 40 MP and a 12,000 px long edge; output long edge ≤ 4,096 (scaled down) and ≤ 25 MiB; the child a
256 MB V8 heap and 45 s; 2 intra-op threads (of the worker's 3 CPUs); one op per user at a time, 30 per user per hour, 300
per workspace per day, at most 3 active per workspace (counted under a lock in the request's transaction); previews keep
priority. Expected peak RSS about 300 MB with u2netp inside the 1.5 GB worker at concurrency 1: **WS2 measures it on the
NAS** (cgroup reads in a throwaway container, as the office evidence did) and reports it in the gate.

## 5. Search inside files (WS3; contracts `FILE_TEXT_LIMITS`, `SearchHit.file`, `fileHitObjectId`)

- **Extraction** is op `extract-text` (no requester), enqueued by the api when a `pdf`-kind version (PDF, PPTX, ODP,
  DOCX, …) becomes `ready` (one call on the `assets.version` path in `app.ts`, through the lead) and by a backfill sweep
  (`FILE_TEXT_LIMITS.backfillPerSweep` 20 versions every `backfillEveryMs` 10 min, newest first, paused while previews
  queue, only versions without a `file_text_state` row and no active op). The worker runs `pdf-text-child.ts` (pdfjs
  `getTextContent`, the same pdfjs as previews, 384 MB heap, 60 s) over pages 1..min(N, 300); Office goes to PDF again
  through the no-network sidecar (≤ 120 s; one more conversion, but the preview path stays untouched). Text is cleaned
  (the `cleanText` rules), ≤ 8,000 characters a page and ≤ 512 KiB a version, written to a temp file (the child's stdout
  cap is 64 KB) and sent in `/text` batches of ≤ 50 pages; the completer writes `file_text_state` (`done`, `empty` for a
  scan: OCR is out of scope and the UI says "no text found", `failed`, or `skipped` past the workspace's
  `maxWorkspaceBytes` 200 MB of body).
- **Storage (0039)**: `file_text_pages (version_id, workspace_id, page, body, tsv)` with GIN (`tsv` = english of the body
  || simple of its folded form, computed by the api in the INSERT, as `board_search_entries`), `file_text_state`, and
  `board_file_refs (board_id, version_id)`, which the indexer refreshes from sync's existing
  `GET /internal/boards/:bid/asset-refs` (canvas only) on each canvas reindex. Everything cascades from its version or
  board, so GC and board deletion clean it; `purgeTrashed` also clears `board_file_refs`.
- **The query** (`features/search/store.ts`): a second ranked CTE over `file_text_pages ⋈ board_file_refs`, restricted
  to the same `searchScope` boards AND to versions `files-auth` serves on that board, **checked at query time, never
  cached per user**. Hits keep `kind: 'file'`, add `file: {versionId, page, name}`, and `objectId` `file:<ver>.p<page>`;
  `ts_headline` snippets as today; at most `maxFileHitsPerBoard` 2 of `SEARCH_HITS_PER_BOARD` 5 per board. The new web
  opens `/b/<id>?file=<ver>&page=<n>` (`FILE_HIT_QUERY`): it resolves the card through `canvas.index` by `fileId` and opens
  `PdfViewer` at that page (`file-card/ported/open-file-hit.ts`); an old web opens the board. Ctrl+K shows
  "Page 3 · Brief.pdf · Board". With `DRAFTROOM_FILE_SEARCH` off the CTE is skipped.
- **Ask across boards**: file pages become a third source with `askShareChars` 4,000 of the 12,000 cap, cited "Brief.pdf
  p.3", only for boards that pass `aiGateFor` AND `mayExport` (the re-check before sending exists:
  `workspace-ask.ts:289`).
- **Tests (WS3)**: extraction fixtures (PDF, DOCX, PPTX, a CJK PDF the `simple` config must match); a bomb, more than 300
  pages, a timeout; **the leak matrix on PGlite and real Postgres**: a private board's file never hits for a non-member; a
  removed card stops hitting after the reindex; a version only in "Recently deleted" does not hit; a trashed board does
  not hit; a board-linked but unplaced version does not hit; a guest sees only their grants; the GC cascade; Ask never
  sends text from an exports-off board; the `?file=` deep link; the 7e5b4d6 contracts' `SearchResponse` parses the new
  answer.

## 6. Deck import (WS4; contracts `DECK_LIMITS`, `deckRenderRuns`, `deckSlideName`)

- **Honest scope: slides become flattened page pictures**, one frame per slide, with the slide text searchable (§5);
  nothing claims to be editable. Native PPTX editing (DrawingML) is not in W; speaker notes are not in LibreOffice's PDF
  export, so they are not imported. Keynote: "Export to PDF or PowerPoint first" (`.key` stays kind `other`; no op).
- On a ready deck card (kind `pdf`), "Insert as slides": when `probe.pageCount > DECK_LIMITS.eagerPages` (8), the web
  calls `POST /api/files/:ver/render-pages {boardId}`: the switch AND a capable worker (else 404), edit with an account
  (guests refused by the guard: 403), the version served there, `ready`, kind `pdf`; one op per `deckRenderRuns(pageCount)`
  run (pages 9..min(N, 100) in runs of ≤ 30, params `{from, to}`, `params_key` `'<from>-<to>'`) in one transaction; 202
  with the first op's state; 409 `NOTHING_TO_RENDER` for 8 pages or fewer (they exist). The worker renders with the
  existing `pdf-child` at the same 1024 px `page` role (`render-pages.ts`; the Office PDF cached in the op's temp dir for
  its lifetime only). The completer turns the op's page outputs into `asset_derivatives` rows of the SOURCE version
  (positions after the existing ones), under the version's row lock and skipping pages that already have a row (§12
  departure 5): a re-run is idempotent. The loader is unchanged, so a 7e5b4d6 web shows pages 9+ too.
- The web places everything in **one `canvas.transact`, one undo step**: per slide a `frame` (`kind: 'deck-slide'`,
  `deckSlideName(n, first line of the slide's text)`, 1600 wide at the page's aspect) and inside it an `image`
  (`kind: 'deck-page'`, `fileId ver_….p<n>`, alt "Slide n of N"), in a 5-wide grid (`gridColumns`, `gridGap` 80) next to
  the card, so Present walks them in frame order. 100 slides are 200 creates: within `MAX_OPS_PER_PUSH` 500 and 512 KiB.
  More than 100 pages: the first 100, with a notice. Guests may place decks of 8 pages or fewer (no op needed).
- **A per-person window** (the integration): `DECK_LIMITS.requestRate`, 20 render-pages requests that queued ops per
  person an hour (each queues at most 4 ops of at most 92 pages), checked before the transaction and counted after its
  COMMIT (an empty or refused request is free); over it 429 `RATE_LIMITED` with `Retry-After`. In memory, one api
  instance, like the other keyed limits.
- "New board from deck" is deferred (it would add `'deck'` to `IMPORT_SOURCES`, a response enum: `LOBBY_CLIENT_REV` 4).
- **Tests (WS4)**: idempotent complete (a double complete, a re-run); the output cap; pages 9..100 rendered; 101 pages
  gives the notice; placement is one undo step, frames in order, Present walks them; the old web renders slides 9+; a
  PPTX end to end on the NAS image; `.key` gives the guidance and no op.
- **Risk**: 1024 px pages look soft full screen at 1080p and above (said in the dialog); "HD slides" (a new `slide` role
  at 1920 px) is a follow-up, since an old web could not read a new role.

## 7. The workspace admin page (WS5; contracts `workspace-admin.ts`)

`/w/:wid/admin` (`lib/routing.ts` route `workspace-admin`; `App.tsx` loads `features/workspace-admin/AdminPage.tsx`
lazily inside the session, only while `FORMATS_FLAGS.admin` is on and the api offers it), linked from the workspace menu
for owners and admins only (one entry in `dashboard/WorkspaceMenu.tsx`). Five tabs (`ADMIN_TABS`), each from an
owner/admin route; **everyone else gets the unknown route's 404, never a 403** (anonymous, a member, a workspace guest,
someone of another workspace; a name-only guest is answered 404 by the guest guard before any query:
`GUEST_HIDDEN_ROUTES`). Read-only by itself: every change it offers calls an **existing** route.

| Route (`ADMIN_ROUTE_KEYS`) | Answer | Item |
|---|---|---|
| `GET …/admin/members` | `AdminMembersResponse`: role, `creator`, `boardGrants`, outsider markers (no last visit: §12 departure 3). Role change and removal through the existing `PATCH`/`DELETE /api/workspaces/:wid/members/:uid` (the creator and last-owner rules stay there) | W5-1 |
| `GET …/admin/invitations` | `AdminInvitationsResponse`: pending workspace and board invitations, the email hint only (never the address or token) | W5-1 |
| `GET …/admin/storage/by-board`, `…/by-uploader` | `AdminStorageResponse`: the top 50 by bytes, the same sums as `files/usage.ts` `workspaceUsage`, the total and quota (5 GB on staging), `fileTextBytes` (§5) | W5-2 |
| `GET …/admin/audit?before=&action=&actor=&limit≤100` | `AdminAuditResponse`: newest first by `id` (stable under inserts); `action` a free string; `detail` only the scalars a per-action allowlist names (`audit-view.ts`), never raw jsonb; the three raw-SQL actions (`asset.gc_delete`, `*internal_only`, `comment.moderate_delete`) move into the `AuditAction` union; a test fails when an action has no view entry | W5-3 |
| `GET …/admin/links` | `AdminLinksResponse`: every open multi-use link (review, workshop with `hasJoinCode`, never the code; role, creator, expiry, uses) and name-only guests with grant counts, from `outsideAccessIn`'s queries without its Internal-only condition. Revoke and extend call the existing per-board routes; workspace owners and admins act as board owner there | W5-4 |
| `GET …/admin/retention` | `AdminRetentionResponse`: read-only facts (`ADMIN_RETENTION_FACT_IDS`): trash "kept until restored", the checkpoint tiers (`CHECKPOINT_RETENTION`), the GC mode and grace, visits 180 days, the library purge 30 days, imports listed 30 days, the chat outbox 14 days, audit "kept" (no purge), board backups as documented (sync's settings are not visible to the api). **No control that deletes anything** (lead decision e) | W5-5 |

The links tab's name-only guests carry `AdminGuest.boards` (WS5, folded in at integration: at most
`ADMIN_LIMITS.guestBoards` 20 boards, newest grant first, `{id, title}`), so a guest can be taken off one board through
the existing `DELETE /api/boards/:bid/members/:uid`. The page waits for the config before it decides (the loading
screen, never "Page not found" first, for an owner). The palette's `workspace.admin` (registered by the integration in
`features/workspace-admin/index.tsx`) opens the page for the board's workspace owners and admins only.
Limits: pages of 100, 50-row storage lists, `ADMIN_LIMITS.rate` 20 requests per 10 s per user over every admin route.
Audit reads use `audit_events_workspace_idx (workspace_id, at DESC)`; WS5 checks the plan of the `before` page on real
Postgres and, if it is not an index scan, asks the lead for a `(workspace_id, id DESC)` index (a new migration). Tests: the
404 matrix (anonymous, member, workspace guest, name-only guest, another workspace, switch off); pagination under inserts;
the detail allowlist leaks no URL, token, email or webhook hint; the links list equals the per-board lists; revoke from
admin equals revoke from Share; the storage sums equal `workspaceUsage`; the page at phone width (no horizontal scroll).

## 8. Who may do what

### 8.1 The rules (checked server-side by each route; contracts `FORMAT_RULES`)

`edit-account`: may edit the board (`requireBoardAction(edit)`) AND has an account. `requester`: the op's `requested_by`,
still able to view its board (404 for anyone else, so an op id reveals nothing). `admin`: owner or admin of the workspace
(`requireWorkspaceRole` then `canManageWorkspace`; 404 otherwise). Canvas actions (doc cards, placing slides) are the
room's as for any element.

### 8.2 The matrix

| Action | Owner / editor (account) | Commenter | Viewer | Name-only guest, editor link | Name-only guest, review link | Workspace member, no board access | Workspace owner / admin | Another workspace | Archived board |
|---|---|---|---|---|---|---|---|---|---|
| Insert, edit a doc card (under the lease) | yes | no (read-only room) | no | yes | per link role | no (no access) | per board role | no | no (read-only) |
| Remove background | yes | 403 | 403 | 403 `GUEST_ACCOUNT_REQUIRED` (guard) | 403 (guard) | 404 | per board role | 404 | 409 (not active) |
| Render deck pages (Insert as slides, more than 8 pages) | yes | 403 | 403 | 403 (guard) | 403 (guard) | 404 | per board role | 404 | 409 |
| Place a deck of 8 pages or fewer | yes | no | no | yes | per link role | no | per board role | no | no |
| See or cancel an op | its requester only (404 for everyone else) | | | | | | | | the requester (cancel: queued only) |
| File hits in search | boards they can view now, versions served AND placed there | same | same | their grants only | their grants only | boards the workspace role lets them view | same rule | none | in the archived list, same rule |
| File text in Ask across boards | boards passing `aiGateFor` AND `mayExport` | same | same | no (Ask refuses guests) | no | same rule | same rule | none | same rule |
| The admin page (all tabs) | 404 | 404 | 404 | 404 (guard, `GUEST_HIDDEN_ROUTES`) | 404 (guard) | 404 | yes | 404 | n/a |
| `/api/worker/ops/*` | the worker token only (cookies 403, no token 401), as the preview routes | | | | | | | | |

Exports-off boards still give search snippets (as canvas text does today) but never reach Ask. Viewers already see the
page images, so file snippets reveal nothing new to them.

### 8.3 Guard rows and palette ids

- `apps/api/src/features/guests/guard.ts`: `POST /api/files/:ver/remove-background` and `POST /api/files/:ver/render-pages`
  refuse a name-only guest (403, `FORMAT_GUESTS_MESSAGE`; contracts `FORMAT_GUEST_REFUSED_ROUTE_KEYS`) before any board
  check, whatever role the guest was given; the seven admin routes answer a guest 404 (`GUEST_HIDDEN_ROUTES`, new). The
  op state and cancel routes keep no row (a guest never requests an op).
- `domain-access/guard.ts`: **no creator row** (nothing of wave W makes a board or hands out access; a remove-bg result
  is a file in the board's own workspace, as an upload).
- Tested by `refusals.test.ts` (+2 rows, the admin 404), `pending-routes.test.ts` (a pending row answers as an unknown
  route; a landed one is held to its row) and `creation-matrix.test.ts` (unchanged: 25 always rows).
- Palette ids (frozen, pending: `WAVE_W_PALETTE_COMMAND_IDS`): `doc-card.insert`, `doc-card.from-text` (WS1),
  `image.remove-background` (WS2), `deck.insert-slides` (WS4), `workspace.admin` (WS5). The deployed api refuses a usage
  batch naming an unknown id, so the api deploys before the web (§9.2). At integration all are registered but
  `image.remove-background`, still in `PENDING_PALETTE_COMMAND_IDS` until the owner approves the model file (§4.2, §11.1).

## 9. Compatibility, deploy order and rollback

### 9.1 No CONTRACTS_REV or LOBBY_CLIENT_REV bump

- **Board elements**: the only canvas writes of the wave are ordinary creates by the user's own client carrying the
  existing create-only `customData.lobby.kind` with new values (`doc-card`, `deck-slide`, `deck-page`), and an image's
  `fileId` swap (an ordinary update; the `ver_…` id of a stored version). Proven by
  `packages/canvas-schema/src/wave-w-kinds.test.ts`: `checkElement` and the strict `ServerMessage` of the frozen rev 11
  (437b4e7), rev 12 (3c83611) and rev 13 (6769e07) schemas and of this package (rev 14; `git diff 7e5b4d6 --
  packages/canvas-schema` holds only that test, so it is the deployed web's AND sync's) accept a doc card (a rectangle and
  its bound Markdown-lite label, also at the 20,000-character cap) and deck slides (a frame and an image `ver_….p9`,
  `.p100`) in a `changes` frame; `kind` is create-only in all four; the pairs pass `checkInvariants`; a kind outside the
  word rule and a page past 9999 are still refused. No frozen reader refused any of it, so no redesign was needed.
- **The api's answers**: every new field is additive on a non-strict `z.object` (`AuthConfig.formats`, `SearchHit.file`);
  a 7e5b4d6 tab strips them. `SearchHit.kind` stays `'file'`; no existing enum gains a value: `LOBBY_CLIENT_REV` stays 3.
  New routes and new responses only otherwise.
- **Events**: one new name, `file.op`, to the requester only; an old web has no listener for it.
- **The worker**: the preview protocol is unchanged (`apps/api/test/worker/ops.test.ts` "an old worker…": with ops
  queued, an old worker's claim gets a preview job, completes it and then 204: it never sees an op; the existing preview
  protocol suites `lifecycle`, `leases`, `auth`, `units`, `r2-mode`, `rate-limit-required` pass unchanged). The worker of
  wave W against an api of before wave W: one 404 on the ops claim, then previews only (`apps/worker/test/ops.test.ts`).
  The integration ran the deployed worker itself (its tree, `E2E_OLD_WORKER_ENTRY`) as the e2e stack's worker
  (`e2e/excalidraw/w-compat-old-worker.spec.ts`): its previews are made, nothing worker-backed is offered and the two
  op requests answer 404 until a worker of this build checks in.
- **The stale proof (WS1)**: `e2e/excalidraw/w-compat-7e5b4d6.spec.ts` with the real 7e5b4d6 web (§2).

### 9.2 Deploy order

1. **api** with 0039 and the routes (switches off): nothing answers yet; the usage list knows the wave W palette ids; the
   ops routes are live and idle (the deployed NAS worker never calls them).
2. **web** (the switches the integration turned on): it offers nothing until the api's `formats` says on.
3. **`DRAFTROOM_DOC_CARDS` and `DRAFTROOM_WORKSPACE_ADMIN` on** (Render API, a restart; render.yaml follows in the same
   change): these two need no worker.
4. **The NAS worker rebuild** (the owner's standing OK; `deploy/nas/deploy-worker.sh`; the model file placed and its hash
   committed first if background removal ships, §11): its start-up log names the capabilities it reports.
5. **`DRAFTROOM_REMOVE_BACKGROUND`, `DRAFTROOM_FILE_SEARCH`, `DRAFTROOM_DECK_IMPORT` on**, each once its capability shows in
   `worker_capabilities_seen` (the web's offer follows within 10 minutes of a claim on its own).

Sync is not deployed. WS5 writes the wave W section of `docs/DEPLOY.md`.

### 9.3 Rollback

- A switch off: instant (a restart); its routes 404, its queued ops fail `WORKER_UNAVAILABLE` at the next claim, Postgres
  keeps every row. Placed doc cards and slides are plain elements; images whose background was removed point at an
  ordinary version (undo restores the original).
- The worker: `WORKER_OPS=none` (or the previous image) stops all ops; previews are unaffected.
- The web below wave W: safe (it never calls the routes). The api below wave W: safe (0039 is additive; with
  `DRAFTROOM_ALLOW_NEWER_SCHEMA=1` that build ignores the tables and the column; queued ops stay queued and a later api
  fails them; a wave W worker hears 404 and keeps to previews).

## 10. Migration `0039_formats`

Additive (`packages/db/migrations/0039_formats.sql`; tested in `packages/db/test/wave-w-0039.test.ts` and the real-Postgres
`apps/api/test/migrations.pg.test.ts`):

| Table / column | Holds | Keys and CHECKs |
|---|---|---|
| `worker_ops` | `id` (`wop_`), `workspace_id`, `board_id`, `kind`, `source_version_id`, `params` (an object ≤ 1 KiB), `params_key`, `status`, `attempts`, `run_after`, `lease_owner`, `lease_until`, `result` (an object ≤ 4 KiB), `result_version_id`, `requested_by`, `error_code`, `created_at`, `updated_at`, `finished_at` | running needs a lease; `finished_at` iff done/failed/cancelled; `error_code` iff failed/cancelled; `result_version_id` only on a done remove-bg; one active per (kind, source, params_key) (`worker_ops_active_idx`); claim, workspace, requester and result indexes; cascades with its source version and its board (composite key: the board stays in its workspace); requester and result version SET NULL |
| `worker_op_outputs` | `id` (`wpo_`), `op_id`, `attempt`, `role` (`original`/`page`), `page`, `width`, `height`, `mime_type` (png/webp), `bytes`, `asset_id`, `version_id`, `derivative_id`, `blob_key`, `created_at` | page iff role page; `derivative_id` iff role page; `blob_key` an `assets/…/original` or `assets/…/d/drv_….(png|webp)` key, unique; cascades with the op |
| `worker_capabilities_seen` | `capability` (PK, the versioned word), `last_seen_at`, `worker_id` | the capability regex |
| `asset_versions.derived_from_version_id` | the version a server-made one came from (nullable) | FK SET NULL; partial index |
| `file_text_state` | `version_id` (PK), `workspace_id`, `status` (done/empty/failed/skipped), `pages` 0..300, `bytes` ≤ 512 KiB, `truncated`, `extractor`, `extracted_at` | cascades with the version and the workspace |
| `file_text_pages` | `version_id`, `workspace_id`, `page` 1..300, `body` 1..8,000 characters, `tsv` | PK (version, page); GIN on `tsv`; cascades |
| `board_file_refs` | `board_id`, `workspace_id`, `version_id`, `refreshed_at` | PK (board, version); the board by its composite key; cascades with either |

db ids: `wop`, `wpo`. **Rollback** of the api below 0039 (with `DRAFTROOM_ALLOW_NEWER_SCHEMA=1`): nothing to undo (the
migration's header). Not in 0039: a unique (version, role, page) index on `asset_derivatives` (§12 departure 5).

## 11. Needs the owner (designed around), and open decisions

1. **The model file** (`u2netp.onnx`, about 4.6 MB): a one-time download the owner approves separately (a github.com
   release of rembg's export of the Apache weights, or a conversion of the `.pth`, which needs Python, absent on this PC).
   Then its sha256 goes into `BG_MODEL.sha256` and `MODELS.json` (the lead), and the file onto the NAS worker's volume at
   `DRAFTROOM_BG_MODEL_PATH`. Also an acknowledgement that the weights' Apache licence does not speak to the training
   data's (DUTS-TR) terms. **Until then background removal stays hidden**; the other four ship.
2. **The NAS worker rebuild** after the wave (the owner's standing OK; pending since wave R/S): without it remove-bg and
   deck import stay hidden and file search indexes nothing. Doc cards and the admin page ship anyway.
3. **Retention that deletes** (a trash auto-purge, an audit purge): permanent deletion, not in W.
4. **The admin members tab's activity column**: 0031 stores visit times on the condition that nobody else sees who
   visited when, so the scout's "last visit" is not shown (§12 departure 3). If the owner wants an admin-visible "last
   active", that is a new decision (from sessions, not visits).
5. **A heavier model later** (BiRefNet MIT, U²-Net full) needs a raise of the worker's 1.5 GB memory cap on the NAS
   compose: an owner decision.
6. Open for WS1 at its gate: lower the doc card cap to 12,000 characters if the room's p95 misses (§2).
7. The quota fact: staging is 5 GB per workspace (render.yaml), not the 100 GB of older notes and `.env.example`; file
   text adds Postgres size on Render's plan (capped at 200 MB a workspace, shown on the admin storage tab).

No paid service, no new runtime external host and no egress exception are needed.

## 12. Where the foundation differs from the scout, and why

1. **The model is not vendored into `apps/worker/models/`** (the scout): lead decision (c). The worker loads it from
   `DRAFTROOM_BG_MODEL_PATH`, checked against a pinned sha256 (null until the owner's file), and reports the capability
   as missing otherwise; `MODELS.json` documents the model, and the licence check refuses any unlisted weights file in the
   repository.
2. **`worker_op_outputs` is a table of its own** (the scout listed only `worker_ops`): outputs must be scoped to one
   attempt, like `asset_derivative_reservations`, so a reclaimed attempt's blobs are dropped and the fs-mode PUT grant
   resolves only while that attempt holds the lease.
3. **No "last visit" on the members tab**: `board_visits` (0031) is stored on the owner's condition that nobody else ever
   sees who visited when. `AdminMember.boardGrants` instead; an activity column is an owner decision (§11.4).
4. **One active op per (kind, source, `params_key`)**, a canonical text rather than a params hash (readable, checkable,
   and the uniqueness is exact); the per-workspace active cap is counted by the api under a lock (a CHECK cannot count
   rows).
5. **No unique (version, role, page) index on `asset_derivatives`**: creating one over existing staging rows would fail
   the deploy if a single duplicate existed, which cannot be checked from here; WS4's completer locks the version row and
   skips pages that already have a row, so a re-run stays idempotent.
6. **The admin routes answer name-only guests 404 through a new `GUEST_HIDDEN_ROUTES`**, not 403 rows: a 403 would tell a
   guest the page exists, and the design is 404 for everyone but owners and admins.
7. **`GET /api/file-ops/:op` and `POST …/cancel` are added** (the scout had only the `file.op` event): a reconnecting tab
   needs the state, and a requester can stop a queued op. They open with either requestable kind's switch.
8. **A switched-off kind's queued ops fail `WORKER_UNAVAILABLE`** at the next claim (the scout: cancelled): the requester
   is told plainly that it cannot run now, with the same code as the 15-minute rule.
9. **Extracted text goes in batches of ≤ 50 pages per `/text` call** (the scout: one call): headroom under the api's body
   limit; each page is an upsert, and the 512 KiB cap is checked at complete.
10. **An op's source must be `ready` and its board active or archived at claim** (else failed `SOURCE_MISSING` or
    cancelled), in the shared state machine rather than in each kind.
11. **A file hit's objectId is `file:<ver>.p<page>`** (the scout: `file:<ver>`): two pages of one file are two hits, and a
    distinct id keeps keyed lists stable.
12. **The worker depends on `@draftroom/contracts`** for the capability strings and the claim's shape, so the two sides
    cannot drift (zod joins the worker's tree; licence check PASS).
13. **The Dockerfile is not changed by the foundation**: keeping only the linux binaries of onnxruntime-node needs an image
    build to prove, which was not run here; WS2 proposes the line with that evidence (§4.3).
14. **The three worker-backed features need their capability seen for the web's offer AND for the request route** (both
    404 without one), so a stale tab whose offer predates a worker leaving gets the same answer as a switch off.

## 13. Workstreams and file ownership

| Workstream | Owns | Reads (does not edit) |
|---|---|---|
| **WS1 Doc cards** (web only) | `apps/web/src/features/doc-cards/**` (replacing the stub `index.tsx`: `markdown-lite.ts`, `DocFace.tsx`, `DocEditor.tsx`, insert and "Text → Doc card", its export-overlay registration); `apps/web/src/canvas/lease/panel-editor.ts` (new: the lease-client adapter) and its rows in `apps/web/src/canvas/input/{dblclick,doubleTap}.ts` plus the guard test; `e2e/excalidraw/w1-*.spec.ts`; **`e2e/excalidraw/w-compat-7e5b4d6.spec.ts`** (the stale pair with the real 7e5b4d6 web: doc card and deck slides); the NAS room measurement for the cap | `canvas/lease/*` (`editorLease.ts`, `fit.ts`, `words.ts`), `file-card/ported/{CardLayer,link-cards}.tsx`, `present-export/ported/badges.ts`, `e2e/excalidraw/l-compat-kit.ts`, contracts `formats.ts` |
| **WS2 Background removal** (worker, api, web) | `apps/worker/src/ops/{remove-bg,bg-child}.ts` and `apps/worker/test/remove-bg*.test.ts`; `apps/api/src/features/formats/remove-bg/**` (the route in `index.ts`, the completer `kind.ts`) and `apps/api/src/features/formats/ops/**` (op state and cancel); `apps/api/test/features/formats/{remove-bg,ops}/**`; `apps/web/src/features/remove-bg/**` (replacing the stub) and one menu row in `apps/web/src/file-card/ported/edit-media.tsx`; `e2e/excalidraw/w2-*.spec.ts`; the NAS measurement report (a throwaway `draftroom-spike-*` container) incl. the linux ORT binary check | `apps/api/src/worker/ops-*.ts`, `features/formats/{switch,offer,op-state}.ts`, `files/upload.ts`, `features/backup/restore.ts` `storeOriginal`, `files-auth.ts`, `apps/worker/src/ops/{bg-inference,bg-model,loop,client}.ts`, `transfer.ts` |
| **WS3 File text and search** | `apps/worker/src/ops/{extract-text,pdf-text-child}.ts` and their tests; `apps/api/src/features/search/{file-text.ts, file-refs.ts, file-text-kind.ts, file-backfill.ts}`, the file CTE lines in `features/search/store.ts` (and `purgeTrashed`'s `board_file_refs` line), the `board_file_refs` refresh call in `features/search/indexer.ts`; the file source lines in `features/ai/workspace-ask.ts` and `workspace-plan.ts`; web `features/command-palette/workspace-search.ts`, `dashboard/search/content-search.ts` (file hits, the `?file=` href) and the resolver `apps/web/src/file-card/ported/open-file-hit.ts` (new); `apps/api/test/features/search/file-*.test.ts` and `*.pg.test.ts` (the leak matrix); `e2e/excalidraw/w3-*.spec.ts` | `search/scope.ts`, `files-auth.ts`, `files/gc.ts`, `apps/sync/src/http/asset-refs.ts` (no sync change), `worker/ops-*.ts`, `pdf-child.ts`, `office-client.ts` |
| **WS4 Deck import** | `apps/worker/src/ops/render-pages.ts` (reusing `pdf-child.ts`) and its tests; `apps/api/src/features/formats/deck/**` (the route, the completer `kind.ts`); `apps/api/test/features/formats/deck/**`; `apps/web/src/features/deck-import/**` (replacing the stub: the dialog, the layout, one transact) and one button row in `apps/web/src/file-card/ported/PdfViewer.tsx`; `e2e/excalidraw/w4-*.spec.ts` | `file-card/ported/{place-pages,pdf-pages}.ts`, `worker/jobs.ts` `completeJob`, `worker/ops-*.ts`, `features/formats/op-state.ts` |
| **WS5 Admin and the gate** | `apps/api/src/features/workspace-admin/**` (replacing the stubs: the seven routes, `audit-view.ts`); the `AuditAction` union move (`apps/api/src/audit.ts` and the three raw call sites, one line each); `apps/api/test/features/workspace-admin/**`; `apps/web/src/features/workspace-admin/**` (replacing the stub `AdminPage.tsx`: the five tabs); one entry in `apps/web/src/dashboard/WorkspaceMenu.tsx`; `e2e/excalidraw/w5-*.spec.ts`; the `docs/DEPLOY.md` wave W section; the gate (§14) | everything (read) |

**Lead-only** (serialise through the lead): `packages/contracts/**` (incl. `formats.ts`, `workspace-admin.ts`, `search.ts`,
`usage.ts`), `packages/db/**` (0039 is shipped once merged: a fix is a new migration), `packages/canvas-schema/**`
(unchanged but for the proof), `pnpm-lock.yaml` and `pnpm-workspace.yaml`, `apps/api/src/{config.ts, context.ts, app.ts,
routes/auth.ts}`, `apps/api/src/features/{index.ts, pending-routes.ts, formats/{index,switch,offer,op-state}.ts,
guests/guard.ts, domain-access/guard.ts}`, `apps/api/src/worker/{ops-jobs,ops-routes,ops-kinds,routes,blob-urls}.ts`,
`apps/worker/src/ops/{client,loop,dispatch,capabilities,bg-model,bg-inference}.ts`, `apps/worker/src/{remote-loop,
api-client,env,worker}.ts`, `apps/worker/models/MODELS.json`, `scripts/licence-check.mjs`, `docker/worker.Dockerfile`,
`deploy/nas/**`, `apps/web/src/{App.tsx, lib/routing.ts, auth/session.tsx}`, `apps/web/src/features/{formats/flags.ts,
canvas-registry.ts}`, `e2e/tests/support/stack.ts`, `render.yaml`, `AGENTS.md`, `docs/PROGRESS.md`.

Shared lines each workstream edits itself (its own lines only; the lead resolves adjacent-line conflicts at
integration): its keys in `apps/api/src/features/pending-routes.ts` and its share of `WAVE_W_ROUTES` in
`apps/api/test/features/pending-routes.test.ts` (deleted in the change that implements the routes); its probes in
`refusals.test.ts`. Through the lead: its `FORMATS_FLAGS` line on; its palette ids out of `PENDING_PALETTE_COMMAND_IDS`;
its kind's line in `apps/api/src/worker/ops-kinds.ts` `OP_KINDS` and its runner's line in `apps/worker/src/ops/dispatch.ts`
`OP_RUNNERS` (the line that makes the worker report its capability); WS3's enqueue call on the `assets.version` path in
`app.ts`; WS2's model hash in `bg-model.ts` and `MODELS.json` and its Dockerfile line. **Order**: WS1 and WS5 need no
worker; WS2, WS3 and WS4 test against the api's ops tests and a fake worker first (`apps/api/test/worker/ops.test.ts`
shows how to inject a kind: `ApiDeps.workerOpKinds`, TEST-ONLY), then a real worker image in a NAS throwaway container;
WS5 runs the gate last.

## 14. Checks of the foundation, and what each workstream inherits

Pinned by: `packages/contracts/src/wave-w.test.ts`, `packages/canvas-schema/src/wave-w-kinds.test.ts`,
`packages/db/test/wave-w-0039.test.ts` (and the migration lists of the older ones), `apps/api/test/{config.test.ts,
auth.test.ts, open-signin.test.ts, migrations.pg.test.ts}`, `apps/api/test/features/{formats/switch.test.ts,
pending-routes.test.ts, guests/refusals.test.ts}`, `apps/api/test/worker/ops.test.ts`, `apps/worker/test/{ops.test.ts,
ort-cpu.test.ts}`, `apps/web/src/features/wave-w-stubs.test.ts`, `apps/web/src/lib/routing.test.ts`,
`scripts/licence-models.test.ts`, `scripts/smoke/render-yaml.test.mjs`, `pnpm licence:check`.

Run on the foundation (the Windows PC and the NAS, 2026-10-19; tests on 2e220370; the commits after it change only
comments and docs):

| Check | Result |
|---|---|
| `pnpm -r typecheck` | every workspace project, pass |
| `biome check .` | 0 errors; the 4 older warnings in sync tests this branch does not touch (as on main) |
| vitest `packages`, `canvas-schema`, `scripts`, `dev-assets` | 99 files, 2,399 passed (1 skipped); incl. contracts `wave-w.test.ts`, `wave-w-kinds.test.ts` 15/15, db (PGlite) 18 files / 134 |
| vitest `worker` | 12 files, 200 passed (3 skipped); incl. `ops.test.ts` 14 and `ort-cpu.test.ts` 3 (onnxruntime-node CPU, install script blocked, a tiny synthetic model) |
| vitest `web` | 511 files, 6,004 passed (1 skipped) |
| vitest `api` (PGlite, 4 workers) | 254 files, 2,432 passed (153 skipped: the real-Postgres files) |
| real Postgres 18.6 on the NAS (`nas-pg-api.sh 2e220370 --only db`, `--only api`) | db 18 files / 134 passed; api 283 files / 2,584 passed (1 skipped), `migrations.pg` (0039 additive over data) included |
| `node --test scripts/smoke/render-yaml.test.mjs` | 11 / 11 |
| `pnpm licence:check` | PASS (FAIL 0; the worker's tree 40 packages; models: u2netp Apache-2.0, not pinned; 0 weights files in the repository) |

Not run by the foundation: e2e (nothing user-visible changed: every web switch is off and every browser route pending),
`probe:browser`, `test:arrows` (no engine or sync change), `audit:prod`, a worker image build or any run of the linux ORT
binary (WS2), a run of the deployed 7e5b4d6 worker process against this api (the api side of the old protocol is tested
in-process, §9.1), and anything against Render, Clerk or R2.

The gate (WS5, at integration): `pnpm lint`, `pnpm typecheck`, `pnpm test`, the real-Postgres api and db suites on the
NAS (`bash scripts/nas-pg-api.sh <sha> --only api|db`), `probe:browser`, `test:arrows`, the whole e2e on chromium twice
(normally and with `E2E_DIRECT_EVENTS=1`), the stale pair with the real 7e5b4d6 web, a worker image built from the wave
running every op kind against a staging-like api in a NAS throwaway container (with the tiny model for remove-bg unless
the owner's file is in place), WS2's memory report, WS1's room measurement, `pnpm audit:prod` and `pnpm licence:check`.
