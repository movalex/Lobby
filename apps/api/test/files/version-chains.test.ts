// Wave S foundation (the design's risk 1: "one asset, many versions is new"): every read of a version is keyed by the
// version or by (asset, version), never by the asset alone (audited site by site for the foundation; see
// docs/WAVE-S-CONTRACTS.md §3.5). These tests hold the read paths a chain goes through to that: meta, the original,
// visibility per version across boards (uploaded to it, or linked), sync's file refs (A1), and the upload, which
// honours X-Lobby-Supersedes since WS2 (the new version joins the asset: same id, supersedes; files/versions.test.ts
// holds its refusals).

import type { AssetVersionMeta } from '@draftroom/dev-assets'
import { newId, SUPERSEDES_HEADER } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it } from 'vitest'
import { originalKey } from '../../src/files/blobs.ts'
import { fileRefsFor } from '../../src/routes/engine-internal.ts'
import { upload } from '../features/history/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../helpers.ts'

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

interface World {
  api: TestApi
  alice: Client
  a: string
  b: string
  v1: AssetVersionMeta
  /** v2 of v1's asset, uploaded to `board` (as WS2's upload will write it) */
  supersede(prev: AssetVersionMeta, board: string, body: string): Promise<AssetVersionMeta>
  original(m: AssetVersionMeta, board: string): Promise<{ status: number; body: string }>
  link(board: string, m: AssetVersionMeta): Promise<void>
}

async function world(): Promise<World> {
  api = await createTestApi()
  const t = api
  const alice = await t.login('alice')
  const a = await createBoard(alice, DEV_STUDIO, 'Cuts')
  const b = await createBoard(alice, DEV_STUDIO, 'Client copy')
  const v1 = await upload(t, alice, a, 'key-art.png')
  return {
    api: t,
    alice,
    a,
    b,
    v1,
    async supersede(prev, board, body) {
      const versionId = newId('ver')
      const bytes = Buffer.from(body)
      await t.db.query(
        `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                     size_bytes, sha256, uploaded_by, status, probe, supersedes)
         SELECT $1, asset_id, workspace_id, $3, 'key-art-v2.png', declared_mime_type, mime_type, kind, $4, sha256,
                uploaded_by, status, probe, id
           FROM asset_versions WHERE id = $2`,
        [versionId, prev.versionId, board, bytes.length],
      )
      await t.blobs.put(originalKey(prev.assetId, versionId), bytes, {
        contentType: 'image/png',
        contentLength: bytes.length,
      })
      return { ...prev, versionId, boardId: board, name: 'key-art-v2.png' }
    },
    async original(m, board) {
      const res = await alice.req('GET', `/files/${m.assetId}/${m.versionId}/original?board=${board}`)
      return { status: res.statusCode, body: res.body }
    },
    async link(board, m) {
      await t.db.query(
        'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
        [DEV_STUDIO, board, m.assetId, m.versionId],
      )
    },
  }
}

describe('two versions of one asset', () => {
  it('meta and the original are each version’s own', async () => {
    const w = await world()
    const v2 = await w.supersede(w.v1, w.a, 'second cut')
    for (const v of [w.v1, v2]) {
      const meta = await w.alice.req('GET', `/api/boards/${w.a}/assets/${v.assetId}/${v.versionId}`)
      expect(meta.statusCode, meta.body).toBe(200)
      expect(meta.json()).toMatchObject({ assetId: w.v1.assetId, versionId: v.versionId, name: v.name })
    }
    expect(await w.original(v2, w.a)).toEqual({ status: 200, body: 'second cut' })
    const first = await w.original(w.v1, w.a)
    expect(first.status).toBe(200)
    expect(first.body).not.toBe('second cut')
  })

  it('visibility is per version: a board serves the versions uploaded to it or linked to it, never the chain', async () => {
    const w = await world()
    // v2 uploaded to the client's copy (which shows v1 through a link, as a duplicate would)
    await w.link(w.b, w.v1)
    const v2 = await w.supersede(w.v1, w.b, 'client cut')
    expect((await w.original(v2, w.b)).status).toBe(200)
    expect((await w.original(w.v1, w.b)).status).toBe(200)
    // the cuts board never got v2: not servable there until it is linked
    expect((await w.original(v2, w.a)).status).toBe(404)
    await w.link(w.a, v2)
    expect((await w.original(v2, w.a)).status).toBe(200)
  })

  it('sync’s file refs (A1) answer each version with the asset id the chain shares; an unlinked one is missing', async () => {
    const w = await world()
    const v2 = await w.supersede(w.v1, w.b, 'client cut')
    const boardA = { id: w.a, workspace_id: DEV_STUDIO } as Parameters<typeof fileRefsFor>[1]
    const refs = await fileRefsFor(w.api.db, boardA, [w.v1.versionId, v2.versionId])
    expect(refs.ok.map((r) => [r.versionId, r.assetId])).toEqual([[w.v1.versionId, w.v1.assetId]])
    expect(refs.missing).toEqual([v2.versionId])
    await w.link(w.a, v2)
    const linked = await fileRefsFor(w.api.db, boardA, [w.v1.versionId, v2.versionId])
    expect(linked.ok.map((r) => r.assetId)).toEqual([w.v1.assetId, w.v1.assetId])
    expect(linked.missing).toEqual([])
  })

  it('an upload that names a version to supersede joins its asset (WS2), and A1 answers it with that asset id', async () => {
    const w = await world()
    const res = await w.api.app.inject({
      method: 'POST',
      url: `/api/boards/${w.a}/assets`,
      payload: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'image/png',
        'x-file-name': 'key-art-v2.png',
        [SUPERSEDES_HEADER]: w.v1.versionId,
        cookie: w.alice.cookie,
      },
    })
    expect(res.statusCode, res.body).toBe(201)
    const made = res.json() as AssetVersionMeta
    expect(made.assetId).toBe(w.v1.assetId)
    const row = await w.api.db.one<{ supersedes: string | null }>(
      'SELECT supersedes FROM asset_versions WHERE id = $1',
      [made.versionId],
    )
    expect(row.supersedes).toBe(w.v1.versionId)
    const boardA = { id: w.a, workspace_id: DEV_STUDIO } as Parameters<typeof fileRefsFor>[1]
    const refs = await fileRefsFor(w.api.db, boardA, [made.versionId])
    expect(refs.ok.map((r) => [r.versionId, r.assetId])).toEqual([[made.versionId, w.v1.assetId]])
  })
})
