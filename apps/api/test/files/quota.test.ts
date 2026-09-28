// FC-1 (docs/SECURITY-REVIEW-2026-09-27.md): one editor repeating POST /api/boards/:bid/assets must
// not be able to fill the shared storage. Uploads are rate limited per signed-in user, and every
// workspace has a byte quota (SUM(size_bytes) of its asset_versions) and a file-count cap, checked
// before any body byte is read (from Content-Length) and again after hashing, under a workspace lock.

import type { BlobStore } from '@draftroom/blob-store'
import { newId } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_UPLOAD_POLICY, type UploadPolicy } from '../../src/files/deps.ts'
import {
  ALICE,
  assetRows,
  BOB,
  req,
  startApp,
  storedBlobs,
  type TestApp,
  upload,
  WORKSPACE,
} from './helpers.ts'

let t: TestApp | undefined
afterEach(async () => {
  await t?.stop()
  t = undefined
})

const policy = (p: { maxBytes?: number; maxFiles?: number; perUser?: number }): UploadPolicy => ({
  workspaceQuota: {
    maxBytes: p.maxBytes ?? DEFAULT_UPLOAD_POLICY.workspaceQuota.maxBytes,
    maxFiles: p.maxFiles ?? DEFAULT_UPLOAD_POLICY.workspaceQuota.maxFiles,
  },
  perUser: { max: p.perUser ?? 1_000, timeWindow: 60_000 },
})

/** Sends only the request head and waits for the answer: proof that no body byte was needed. */
const headOnly = (port: number, length: number, board = 'board-a') =>
  req(port, {
    method: 'POST',
    path: `/api/boards/${board}/assets`,
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(length), 'X-File-Name': 'big.png' },
    body: 'none',
  })

const bytes = (n: number) => Buffer.alloc(n, 7)

describe('upload rate limit (per signed-in user)', () => {
  it('429 with Retry-After once a user repeats uploads, before any byte is read or stored; other users and the next window are fine', async () => {
    let offset = 0
    t = await startApp({ uploads: policy({ perUser: 3 }), now: () => new Date(Date.now() + offset) })
    for (let i = 0; i < 3; i++) expect((await upload(t.port)).status).toBe(201)
    const refused = await headOnly(t.port, 11)
    expect(refused.status).toBe(429)
    expect(refused.json()).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } })
    expect(refused.json().error.message).toMatch(/too quickly/i)
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    expect(refused.headers.connection).toBe('close')
    expect((await assetRows(t.db)).versions).toBe(3)
    expect(storedBlobs(t)).toHaveLength(3)

    // Keyed on the signed-in user, not the connection or IP: Bob on the same socket source is fine.
    t.auth.userId = BOB
    expect((await upload(t.port)).status).toBe(201)
    t.auth.userId = ALICE
    expect((await upload(t.port)).status).toBe(429)
    offset += 61_000
    expect((await upload(t.port)).status).toBe(201)
  })

  it('refuses people who may not edit before counting them (401/403/404 stay as they were)', async () => {
    t = await startApp({ uploads: policy({ perUser: 1 }) })
    t.auth.roles['board-b'] = 'viewer'
    expect((await upload(t.port, { board: 'board-b' })).status).toBe(403)
    expect((await upload(t.port, { board: 'board-x' })).status).toBe(404)
    expect((await upload(t.port)).status).toBe(201)
  })
})

describe('per-workspace storage quota', () => {
  it('413 when the declared size would pass the byte quota, before the body is read; nothing is stored', async () => {
    t = await startApp({ uploads: policy({ maxBytes: 100 }) })
    expect((await upload(t.port, { body: bytes(60) })).status).toBe(201)
    const refused = await headOnly(t.port, 41)
    expect(refused.status).toBe(413)
    expect(refused.json().error.code).toBe('STORAGE_QUOTA_EXCEEDED')
    expect(refused.json().error.message).toMatch(/storage/i)
    expect(refused.headers.connection).toBe('close')
    expect(storedBlobs(t)).toHaveLength(1)
    // Exactly at the quota is allowed; every board of the workspace counts toward it.
    t.auth.roles['board-b'] = 'editor'
    expect((await upload(t.port, { board: 'board-b', body: bytes(40) })).status).toBe(201)
    expect((await upload(t.port, { body: bytes(1) })).status).toBe(413)
    expect((await assetRows(t.db)).versions).toBe(2)
  })

  it('413 FILE_LIMIT_REACHED at the file-count cap', async () => {
    t = await startApp({ uploads: policy({ maxFiles: 2 }) })
    expect((await upload(t.port)).status).toBe(201)
    expect((await upload(t.port)).status).toBe(201)
    const refused = await headOnly(t.port, 11)
    expect(refused.status).toBe(413)
    expect(refused.json().error.code).toBe('FILE_LIMIT_REACHED')
    expect(refused.json().error.message).toMatch(/2 files/)
    expect((await assetRows(t.db)).versions).toBe(2)
  })

  it('re-checks after hashing under a workspace lock: of two uploads that both passed the first check, one is refused and its bytes deleted', async () => {
    let waiting = 0
    let release: () => void = () => {}
    const bothStarted = new Promise<void>((r) => {
      release = r
    })
    const gated = (inner: BlobStore): BlobStore => ({
      ...inner,
      put: async (key, body, o) => {
        waiting++
        if (waiting === 2) release()
        await bothStarted
        return inner.put(key, body, o)
      },
    })
    t = await startApp({ uploads: policy({ maxBytes: 100 }), wrap: gated })
    const port = t.port
    const [a, b] = await Promise.all([
      upload(port, { body: bytes(60), name: 'a.png' }),
      upload(port, { body: bytes(60), name: 'b.png' }),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 413])
    const loser = a.status === 413 ? a : b
    expect(loser.json().error.code).toBe('STORAGE_QUOTA_EXCEEDED')
    expect((await assetRows(t.db)).versions).toBe(1)
    expect(storedBlobs(t)).toHaveLength(1)
  })

  it('is per workspace: a full workspace does not block uploads to another one', async () => {
    t = await startApp({ uploads: policy({ maxBytes: 50 }) })
    const other = 'wsp_otherWSPotherWSP0000'
    await t.db.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Other', $2)`, [other, ALICE])
    await t.db.query(
      `INSERT INTO boards (id, workspace_id, title, created_by) VALUES ('board-c', $1, 'c', $2)`,
      [other, ALICE],
    )
    t.auth.roles['board-c'] = 'editor'
    t.auth.workspaces['board-c'] = other
    // A version already stored in the first workspace (any uploader, any board) counts.
    await t.db.query(
      `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type,
         kind, size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, $3, 'board-b', 'x.bin', 'application/octet-stream', 'application/octet-stream',
         'other', 50, $4, $5)`,
      [newId('ver'), newId('ast'), WORKSPACE, '0'.repeat(64), BOB],
    )
    expect((await upload(t.port, { body: bytes(1) })).status).toBe(413)
    expect((await upload(t.port, { board: 'board-c', body: bytes(50) })).status).toBe(201)
  })

  it('has safe defaults when the host passes no policy', async () => {
    expect(DEFAULT_UPLOAD_POLICY.workspaceQuota.maxBytes).toBeGreaterThan(0)
    expect(DEFAULT_UPLOAD_POLICY.workspaceQuota.maxBytes).toBeLessThanOrEqual(5 * 1024 ** 3)
    expect(DEFAULT_UPLOAD_POLICY.workspaceQuota.maxFiles).toBeGreaterThan(0)
    expect(DEFAULT_UPLOAD_POLICY.perUser.max).toBeGreaterThan(0)
    t = await startApp()
    expect((await upload(t.port)).status).toBe(201)
  })
})
