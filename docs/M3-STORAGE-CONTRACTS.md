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

## 2. Asset metadata in Postgres (`packages/db/migrations/0007_assets.sql`)

- `asset_versions(id ver_ pk, asset_id ast_, workspace_id, board_id, name, declared_mime_type, mime_type, kind, size_bytes, sha256, uploaded_by, status queued|processing|ready|failed, attempts, error_code, error_message, probe jsonb, created_at, updated_at)`
- `asset_derivatives(id drv_ pk, version_id → asset_versions, role, page, width, height, mime_type, bytes, blob_key, created_at)`
- `preview_jobs(version_id pk → asset_versions, profile, status queued|running|done|failed, attempts, run_after timestamptz, lease_owner text, lease_until timestamptz, last_error text, created_at, updated_at)`; index for claiming (`status, run_after`).
- The API builds the same `AssetVersionMeta` JSON as before from these rows (web unchanged). `meta.json` files and the filesystem job queue are no longer used by the API or worker (dev-assets keeps its shared types/limits/URL builders; its fs queue helpers may remain for the worker's local scratch processing only).
- history's `board_asset_links` keeps working: a version is viewable on board B if `asset_versions.board_id = B` or a link exists (same workspace).

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

## 5. Preview worker (`apps/worker`)

Loop: claim → download the original to a short temp path (size-checked) → run the existing processors (image/pdf/video/sniff with all M0 limits and child-process timeouts) against a temp local layout → for each derivative: reserve via `/derivatives`, `PUT` the bytes to the returned URL → `/complete` (or `/retry` / permanent `failed`) → delete temp files. Heartbeat every ≤ 30 s while processing. Graceful shutdown: finish or release the current job. Config: `DRAFTROOM_API_URL`, `DRAFTROOM_WORKER_TOKEN`, `WORKER_ID` (default hostname), `WORKER_CONCURRENCY` (default 1), `WORKER_POLL_MS` (idle poll, default 2000, with jitter/backoff up to 15 s), `WORKER_PDF_HEAP_MB` (default 384), `FFMPEG_PATH`, `FFPROBE_PATH`. The worker holds **no** database or R2 credentials. It works the same against the local API (fs mode), the Render API, or from the NAS.

## 6. Configuration

- api: `DRAFTROOM_BLOB_STORE=fs|r2` (default `fs`: `${DRAFTROOM_DATA_DIR}/blobs`), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (required when `r2`), `DRAFTROOM_WORKER_TOKEN` (required; dev placeholder in `apps/api/dev.env` and `apps/worker/dev.env`, refused in production).
- Local dev (`pnpm dev`) and e2e: api in `fs` mode, worker in HTTP mode against the local api. The live R2 path is exercised by an opt-in test that reads `.env.deploy.local` (gitignored) when present and cleans up every object it writes.
- Render (`render.yaml`): api `0.5c-512mb` **without a disk**, `DRAFTROOM_BLOB_STORE=r2`, `R2_*` as `sync: false`, `DRAFTROOM_WORKER_TOKEN` generated in the secrets group; optional Render background worker (commented out, ~$7/month) as always-on backup; the NAS worker is documented and deployable with one script.
- NAS: `deploy/nas/worker/` (compose file + deploy script): builds the worker image on the NAS, runs one container with memory/CPU caps, `restart: unless-stopped`, no published ports, `cap_drop: ALL`, `no-new-privileges`, env file on the NAS holding only `DRAFTROOM_API_URL` + `DRAFTROOM_WORKER_TOKEN`. Never touches the `theaitre` compose project.

## 7. Security notes

- Worker token = capability to read originals of queued uploads and write derivatives; it cannot read boards, users or other assets. Rotate by changing it on the API and the workers.
- Presigned URLs expire in ≤ 15 min, are scoped to one key and one method, and are never logged.
- The browser never talks to R2; all browser file access stays behind the API's board authorization.
