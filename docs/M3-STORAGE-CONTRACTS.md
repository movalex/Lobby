# Milestone 3 (storage): object storage, database-backed assets, remote preview workers

Integration owner: main session. Goal: files leave the API's local disk so (a) the Render API needs no disk and fits the smallest plan, and (b) preview workers can run **anywhere** — on the user's NAS as extra capacity, optionally a small Render worker as backup — without database or storage credentials. Everything else (routes the browser sees, `AssetVersionMeta` shape, the web client, previews themselves) stays as it is.

Binding context: `docs/M0-CONTRACTS.md` §5–§6 (file routes, headers, limits, preview behavior), `docs/M1-CONTRACTS.md` (auth, Origin check), `docs/FEATURES-M2-CONTRACTS.md` (history's asset links), `packages/dev-assets/src/shared.ts` (types, ids, limits, URL builders — unchanged).

## 1. Blob store (`packages/blob-store`)

```ts
export interface BlobStore {
  readonly kind: 'fs' | 'r2'
  put(key: string, body: NodeJS.ReadableStream | Uint8Array, opts: { contentType: string; contentLength: number }): Promise<void>
  get(key: string, opts?: { range?: { start: number; end: number } }): Promise<BlobObject | null>  // null = missing
  head(key: string): Promise<{ contentLength: number; contentType: string | null } | null>
  delete(key: string): Promise<void>                       // idempotent
  /** Short-lived signed GET for a server-side consumer (the worker). fs → null (caller serves bytes itself). */
  presignGet(key: string, opts: { expiresSec: number }): Promise<string | null>
  /** Short-lived signed PUT for a server-side producer (the worker). fs → null. */
  presignPut(key: string, opts: { expiresSec: number; contentType: string; contentLength?: number }): Promise<string | null>
}
export interface BlobObject { body: NodeJS.ReadableStream; contentLength: number; contentType: string | null; contentRange?: string }
export function createFsBlobStore(root: string): BlobStore      // keys map to files under root (validated: [A-Za-z0-9_./-], no '..', no leading '/')
export function createR2BlobStore(cfg: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; endpoint?: string }): BlobStore  // aws4fetch; region 'auto'; path-style https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
```

- Keys: `assets/<ast>/<ver>/original`, `assets/<ast>/<ver>/d/<drvId>.<webp|png>`.
- Uploads stream (no full buffering): R2 `PUT` with `x-amz-content-sha256: UNSIGNED-PAYLOAD` and an exact `Content-Length` (limits ≤ 500 MB < R2's 5 GB single-PUT cap). The API has already hashed the bytes (sha256 kept in the DB).
- Presigned URLs: `expiresSec` ≤ 900; they are handed only to authenticated workers and never stored anywhere.

DEVIATION (additions; the required fields and methods are unchanged): `createR2BlobStore` also takes `timeoutMs` (default 30 s per attempt, until response headers), `stallTimeoutMs` (60 s without body progress), `retries` (2, for idempotent requests only; a streamed PUT is sent once) and the test hooks `fetch` and `now`. The package also exports `BlobStoreError` (codes `INVALID_KEY`, `INVALID_ARGUMENT`, `LENGTH_MISMATCH`, `RANGE_NOT_SATISFIABLE`, `KEY_CONFLICT`, `BUSY`, `TIMEOUT`, `NETWORK`, `UPSTREAM`), the key validators, `blobKeys`, `MAX_OBJECT_BYTES` (5e9), `MAX_PRESIGN_EXPIRES_SEC` (900) and `presignedPutHeaders()`. Why: bounded failure modes on a real network, and error codes the api can map to responses.

DEVIATION (semantics made exact):
- `get()` with a range that starts at or past the end throws `RANGE_NOT_SATISFIABLE`; `null` still means "missing".
- The fs store does not persist content types: `head()`/`get()` return `contentType: null` there. The api takes types from the database.
- Keys are validated more strictly than the alphabet rule: no empty segments, no segment starting or ending with `.`, no Windows device names, at most 512 characters. The contract keys pass.
- `presignPut` signs `Content-Type` (always) and `Content-Length` (when given), so the URL cannot store another type or size. The uploader must send exactly `presignedPutHeaders()`.
- `put()` consumes a stream body once its arguments validate and destroys it on failure; a stream that errors rejects `put()` with that same error.
- There is no key prefix option: the api writes `assets/…` and `snapshots/…` at the bucket root. The live tests isolate themselves by wrapping the store (`test/<run-id>/…`); the live e2e run (§8) deletes exactly the keys its database lists.

Hazard found while building: Node's `fetch` (undici 7.29) keeps a copy of a **streamed** request body unless the request has `redirect: 'error'` (it may need to replay the body on a redirect). Measured on live R2: a 50 MiB streamed PUT retained about 50 MB by default and under 1 MB with the option. Every R2 request sets it; any other code that streams an upload through `fetch` must too.

## 2. Asset metadata in Postgres (`packages/db/migrations/0007_assets.sql`)

- `asset_versions(id ver_ pk, asset_id ast_, workspace_id, board_id, name, declared_mime_type, mime_type, kind, size_bytes, sha256, uploaded_by, status queued|processing|ready|failed, attempts, error_code, error_message, probe jsonb, created_at, updated_at)`
- `asset_derivatives(id drv_ pk, version_id → asset_versions, role, page, width, height, mime_type, bytes, blob_key, created_at)`
- `preview_jobs(version_id pk → asset_versions, profile, status queued|running|done|failed, attempts, run_after timestamptz, lease_owner text, lease_until timestamptz, last_error text, created_at, updated_at)`; index for claiming (`status, run_after`).
- The API builds the same `AssetVersionMeta` JSON as before from these rows (web unchanged). `meta.json` files and the filesystem job queue are no longer used by the API or worker (dev-assets keeps its shared types/limits/URL builders; its fs queue helpers may remain for the worker's local scratch processing only).
- history's `board_asset_links` keeps working: a version is viewable on board B if `asset_versions.board_id = B` or a link exists (same workspace).

DEVIATION (schema additions): `asset_derivatives.position` keeps the worker's order in the meta JSON, and `asset_derivative_reservations(id, version_id, attempt, role, page, width, height, mime_type, bytes, blob_key)` holds reserved derivatives between `/derivatives` and `/complete`. Why: a reservation must outlive one request, be tied to one attempt, and be deleted (row and blob) when the lease is lost.

DEVIATION: history's checkpoint bodies moved from `${DATA}/snapshots` to the blob store, under the existing `storage_key` (`snapshots/<boardId>/<snp>.json`), with a read fallback to the old path. Why: §6's Render api has no disk, so checkpoints written there would be lost on every deploy.

Not migrated: local dev uploads made before milestone 3 (`.data/assets/**/meta.json`) are not imported into the database and show as missing.

## 3. Upload and file routes (same paths and behavior as M0 §5 / M1 §5)

- `POST /api/boards/:bid/assets`: same checks and limits; streams the body to the blob store under `assets/<ast>/<ver>/original` while hashing; on success inserts `asset_versions` (queued) + `preview_jobs` (queued) in one transaction; on any failure deletes the partial blob and writes no rows.
- `GET /api/boards/:bid/assets/:ast/:ver` → `AssetVersionMeta` from the DB (board-scoped 404s as before).
- `GET /files/:ast/:ver/original?board=` and `/files/:ast/:ver/d/:drv?board=`: authorize exactly as before, then **proxy** the bytes from the blob store (Range forwarded, 206/416, every M0 header: nosniff, CSP sandbox, cache, disposition rules). Same origin, so no bucket CORS is needed and canvas exports keep working. (A redirect-to-signed-URL mode is a later optimization; not now.)

## 4. Worker protocol (API routes under `/api/worker/*`)

Auth: `Authorization: Bearer <DRAFTROOM_WORKER_TOKEN>` (≥ 32 chars, constant-time compare; dev placeholder refused in production). These routes are **exempt from the Origin check** (they are not browser routes) and refuse any request that carries a session cookie. Rate-limited per token. Never logged with bodies or URLs.

| Route | Behavior |
|---|---|
| `POST /api/worker/claim {workerId}` | Atomically claims the oldest claimable job (`status='queued' AND run_after<=now` OR `status='running' AND lease_until<now`) with `FOR UPDATE SKIP LOCKED`; sets `running`, `lease_owner=workerId`, `lease_until=now+120s`, `attempts+1`, and the version `processing`. `204` when nothing to do. `200 { job: { versionId, assetId, boardId, kind, name, declaredMimeType, sizeBytes, attempt, leaseMs }, original: { url, headers? } }` — `url` is a presigned R2 GET, or in fs mode an API URL `GET /api/worker/blobs/<opaque>` accepted with the worker token. |
| `POST /api/worker/jobs/:ver/heartbeat {workerId}` | Extends the lease; `409` if the lease is no longer this worker's. |
| `POST /api/worker/jobs/:ver/derivatives {workerId, role, page, mimeType, width, height, bytes}` | Reserves a derivative id + blob key; returns `{ derivativeId, upload: { url, method: 'PUT', headers } }` (presigned R2 PUT, or fs-mode `PUT /api/worker/blobs/<opaque>`). |
| `POST /api/worker/jobs/:ver/complete {workerId, status: 'ready'|'failed', mimeType?, probe, derivatives: string[], error?: {code, message}}` | Verifies every listed derivative blob exists (`head`) with the declared size, writes derivative rows, sets the version `ready`/`failed` (user-safe error), job `done`/`failed`; idempotent for the same worker; `409` if the lease was lost. Publishes the board event `assets.version { assetId, versionId, status }` after commit. |
| `POST /api/worker/jobs/:ver/retry {workerId, error}` | Transient failure: back to `queued` with `run_after = now + backoff(attempt)`; after `LIMITS.maxAttempts` → `failed` (`INTERNAL`). |

DEVIATION (protocol extensions; `apps/worker` relies on all of them):
- Optional `attempt` (the claim's `job.attempt`) on heartbeat, derivatives, complete and retry. It separates two slots that share one `workerId`; a stale attempt gets `409 LEASE_LOST`.
- `release: true` on retry: a graceful-shutdown hand-back. The job is requeued at once and the attempt is not counted.
- Responses: heartbeat `{ leaseMs }`; derivatives `{ derivativeId, upload: { url, method: 'PUT', headers: { 'Content-Type', 'Content-Length' } } }`; complete `{ versionId, status, repeated }`; retry `{ versionId, status, runAfter }`. `claim` omits `original.headers` when there are none. The retry `error` body is `{ code: 'TRANSIENT' | 'RELEASED' | 'PROTOCOL', message }` (≤ 300 characters, paths scrubbed).
- Backoff: 15 s × 4^(n−1), capped at 15 min. A job whose leases keep expiring is failed (`INTERNAL`) at the claim after `LIMITS.maxAttempts`.
- Error codes: `409 LEASE_LOST` for any lease not held (including an unknown version id); `409 DERIVATIVE_MISSING` when a listed derivative was never uploaded or has the wrong size (the worker hands the job back through `/retry`, it is not a lost lease); `400 UNKNOWN_DERIVATIVE` for an unknown or foreign derivative id; a malformed `:ver` gives 404.
- fs-mode blob URLs are absolute, built on the Host the worker called: `GET|PUT /api/worker/blobs/<opaque>`. They authenticate like presigned URLs (HMAC under a key derived from the worker token, 900 s, one blob and one method, re-checked against the live job or reservation). A Bearer header is verified when present but not required; the worker sends it only to the api's own origin.
- Worker routes refuse **any** `Cookie` header, not only `dr_session`.
- Rate limit: one budget per token across all worker routes (6,000/min), and 600/min per address without a valid token.

## 5. Preview worker (`apps/worker`)

Loop: claim → download the original to a short temp path (size-checked) → run the existing processors (image/pdf/video/sniff with all M0 limits and child-process timeouts) against a temp local layout → for each derivative: reserve via `/derivatives`, `PUT` the bytes to the returned URL → `/complete` (or `/retry` / permanent `failed`) → delete temp files. Heartbeat every ≤ 30 s while processing. Graceful shutdown: finish or release the current job. Config: `DRAFTROOM_API_URL`, `DRAFTROOM_WORKER_TOKEN`, `WORKER_ID` (default hostname), `WORKER_CONCURRENCY` (default 1), `WORKER_POLL_MS` (idle poll, default 2000, with jitter/backoff up to 15 s), `WORKER_PDF_HEAP_MB` (default 384), `FFMPEG_PATH`, `FFPROBE_PATH`. The worker holds **no** database or R2 credentials. It works the same against the local API (fs mode), the Render API, or from the NAS.

DEVIATION (extra settings): `WORKER_POLL_MAX_MS` (the idle backoff cap, default 15000), `WORKER_TMP_DIR` (default: the OS temp dir), `WORKER_SHUTDOWN_GRACE_MS` (default 10000). `DRAFTROOM_API_URL` also accepts `host:port` (Render's `hostport`) and becomes `http://host:port`; under `NODE_ENV=production` plain http is accepted only for a private-network host.

DEVIATION: kind `other` (attachments) is completed `ready` with no derivatives **without downloading the original**, because no byte of it is examined; this saves up to 250 MB of transfer per attachment. The api verified the bytes at upload. The filesystem-queue loop (`apps/worker/src/loop.ts`) was removed; `processJob` still runs each claimed job inside a temporary local layout.

## 6. Configuration

- api: `DRAFTROOM_BLOB_STORE=fs|r2` (default `fs`: `${DRAFTROOM_DATA_DIR}/blobs`), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (required when `r2`), `DRAFTROOM_WORKER_TOKEN` (required; dev placeholder in `apps/api/dev.env` and `apps/worker/dev.env`, refused in production).
- Local dev (`pnpm dev`) and e2e: api in `fs` mode, worker in HTTP mode against the local api. The live R2 path is exercised by an opt-in test that reads `.env.deploy.local` (gitignored) when present and cleans up every object it writes.
- Render (`render.yaml`): api `0.5c-512mb` **without a disk**, `DRAFTROOM_BLOB_STORE=r2`, `R2_*` as `sync: false`, `DRAFTROOM_WORKER_TOKEN` generated in the secrets group; optional Render background worker (commented out, ~$7/month) as always-on backup; the NAS worker is documented and deployable with one script.
- NAS: `deploy/nas/worker/` (compose file + deploy script): builds the worker image on the NAS, runs one container with memory/CPU caps, `restart: unless-stopped`, no published ports, `cap_drop: ALL`, `no-new-privileges`, env file on the NAS holding only `DRAFTROOM_API_URL` + `DRAFTROOM_WORKER_TOKEN`. Never touches the `theaitre` compose project.

DEVIATION: the worker token is generated in its **own** Render environment group, `draftroom-staging-worker-token`, linked to the api and the optional worker, not in the shared secrets group. Why: Render links a group as a whole, so a worker linked to the secrets group would also receive `DRAFTROOM_TICKET_SECRET` and `DRAFTROOM_INTERNAL_SECRET`, contradicting §5 and §7.

DEVIATION: under `NODE_ENV=production` the api requires `DRAFTROOM_BLOB_STORE` to be set explicitly (no silent fs default on a host without a disk). The api also accepts an optional `R2_ENDPOINT` (an https origin). `DRAFTROOM_DATA_DIR` is still required in r2 mode, so `render.yaml` sets the scratch path `/tmp/draftroom-api`.

DEVIATION: the NAS env file also holds `WORKER_ID`; `deploy/nas/deploy-worker.sh` refuses any other key.

As built (tests): both live R2 tests are opt-in with `DRAFTROOM_LIVE_R2=1` (`packages/blob-store/test/r2-live.test.ts`, `apps/api/test/worker/live-r2.test.ts`), so a plain `pnpm test` never touches the network. `.env.deploy.local` names the account `CLOUDFLARE_ACCOUNT_ID`; the tests map it to `R2_ACCOUNT_ID`, and Render must set `R2_ACCOUNT_ID`. The e2e stack (`e2e/tests/support/stack.ts`) starts the api in fs mode and the worker in HTTP mode with a random per-stack worker token; `E2E_BLOB_STORE=r2` (opt-in, with the four `R2_*` variables in the environment) points only the api at a real staging/test bucket.

## 7. Security notes

- Worker token = capability to read originals of queued uploads and write derivatives; it cannot read boards, users or other assets. Rotate by changing it on the API and the workers.
- Presigned URLs expire in ≤ 15 min, are scoped to one key and one method, and are never logged.
- The browser never talks to R2; all browser file access stays behind the API's board authorization.

## 8. As built: integration (2026-09-27)

- **Local dev** (`pnpm dev`): the api in fs mode (`${DRAFTROOM_DATA_DIR}/blobs`), the worker in HTTP mode against `http://127.0.0.1:5859` with the dev-only token from both `dev.env` files. Checked from a scratch data dir: a PNG and a PDF became ready, and derivatives and a Range of the original came through the Vite proxy. After stopping, nothing listened on 5858, 5859 or 5173.
- **e2e** (`e2e/tests/support/stack.ts`): the api in fs mode, the worker in HTTP mode against the stack's api. They share a random per-stack worker token that sync never sees, and the worker's temp dir is inside the stack's data dir. The stack strips `R2_*`, `CLOUDFLARE_*`, `RENDER_*` and `WORKER_*` from the environment it inherits.
- **Live R2** (opt-in): because there is no key prefix (§1), the live run deleted exactly the keys its databases listed, then listed the whole bucket to prove nothing was left. Results, including the api's memory during a 200 MiB upload and download, are in `docs/DEPLOY.md` ("Milestone 3 integration: live R2 from the dev PC").
- **Logging**: the api logs an idle worker poll (`claim` → `204`) at debug level, not info, so an idle worker doesn't fill the log. Claims that hand out a job, and every other request, stay at info.
- **Not run**: `apps/api/test/worker/skip-locked.pg.test.ts` (real Postgres `FOR UPDATE SKIP LOCKED` contention). There is no Postgres on the dev PC; PGlite serializes transactions, so two concurrent claimers are covered there only.
