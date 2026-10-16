// Wave S, WS2 (docs/WAVE-S-CONTRACTS.md §3): versions of a deliverable. The upload with X-Lobby-Supersedes makes a new
// version of the superseded version's asset (same asset id, `supersedes`, linear, same workspace, with edit
// permission), refuses before the body and again in its transaction, and publishes its board event after COMMIT; the
// version list numbers only the versions this board serves, oldest first, with uploader, size, thread counts as the
// caller may see them and the last review status.

import {
  ASSET_VERSION_CODES,
  ASSET_VERSION_EVENT,
  ListAssetVersionsResponse,
  VersionNotLatestBody,
} from '@draftroom/contracts'
import type { AssetVersionMeta } from '@draftroom/dev-assets'
import { newId, SUPERSEDES_HEADER } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../src/events/hub.ts'
import { chainOrder } from '../../src/files/versions.ts'
import { createThread, reply } from '../features/comments/fixture.ts'
import { guestLink, joinAsGuest } from '../features/guests/support.ts'
import { recordEvents } from '../features/history/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../helpers.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

interface Sent {
  status: number
  body: Record<string, unknown>
  headers: Record<string, unknown>
  meta: AssetVersionMeta
}

function send(
  t: TestApi,
  cookie: string,
  board: string,
  name: string,
  opts: { supersedes?: string | string[]; type?: string; body?: Buffer } = {},
): Promise<Sent> {
  const type = opts.type ?? (name.endsWith('.pdf') ? 'application/pdf' : 'image/png')
  return t.app
    .inject({
      method: 'POST',
      url: `/api/boards/${board}/assets`,
      payload: opts.body ?? (type === 'application/pdf' ? PDF : PNG),
      headers: {
        origin: ORIGIN,
        'content-type': type,
        'x-file-name': encodeURIComponent(name),
        cookie,
        ...(opts.supersedes === undefined ? {} : { [SUPERSEDES_HEADER]: opts.supersedes }),
      },
    })
    .then((res) => {
      const body = (res.json() ?? {}) as Record<string, unknown>
      return { status: res.statusCode, body, headers: res.headers, meta: body as unknown as AssetVersionMeta }
    })
}

async function world() {
  const hub = new EventHub()
  api = await createTestApi({ deps: { events: hub } })
  const t = api
  const owner = await t.login('owner', 'Olive Owner')
  const viewer = await t.login('vic', 'Vic Viewer')
  const board = await createBoard(owner, DEV_STUDIO, 'Cuts')
  const res = await owner.req('PUT', `/api/boards/${board}/members/${viewer.userId}`, { role: 'viewer' })
  expect(res.statusCode, res.body).toBe(200)
  const up = async (c: Client, b: string, name: string, supersedes?: string, type?: string) => {
    const r = await send(t, c.cookie, b, name, { supersedes, type })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.meta
  }
  const list = async (c: { req: Client['req'] }, b: string, ast: string) => {
    const r = await c.req('GET', `/api/boards/${b}/asset-versions/${ast}`)
    return {
      status: r.statusCode,
      body: r.statusCode === 200 ? ListAssetVersionsResponse.parse(r.json()) : null,
    }
  }
  return { t, hub, owner, viewer, board, up, list }
}

const supersedesOf = async (t: TestApi, versionId: string) =>
  (
    await t.db.one<{ supersedes: string | null }>('SELECT supersedes FROM asset_versions WHERE id = $1', [
      versionId,
    ])
  ).supersedes

describe('chainOrder', () => {
  const at = (ms: number) => new Date(ms)
  it('walks supersedes, not upload times; a broken chain continues in upload order; nothing is dropped', () => {
    const rows = [
      { id: 'c', supersedes: 'b', created_at: at(1) },
      { id: 'a', supersedes: null, created_at: at(5) },
      { id: 'b', supersedes: 'a', created_at: at(1) },
      { id: 'e', supersedes: 'gone', created_at: at(9) },
      { id: 'x', supersedes: 'y', created_at: at(3) },
      { id: 'y', supersedes: 'x', created_at: at(4) },
    ]
    expect(chainOrder(rows).map((r) => r.id)).toEqual(['a', 'b', 'c', 'e', 'x', 'y'])
  })
})

describe('X-Lobby-Supersedes', () => {
  it('v2 and v3 keep the asset id and name their predecessor; the list numbers them oldest first', async () => {
    const w = await world()
    const v1 = await w.up(w.owner, w.board, 'key-art.png')
    const v2 = await w.up(w.owner, w.board, 'key-art-v2.png', v1.versionId)
    const v3 = await w.up(w.owner, w.board, 'key-art-v3.png', v2.versionId)
    expect([v2.assetId, v3.assetId]).toEqual([v1.assetId, v1.assetId])
    expect(await supersedesOf(w.t, v1.versionId)).toBeNull()
    expect(await supersedesOf(w.t, v2.versionId)).toBe(v1.versionId)
    expect(await supersedesOf(w.t, v3.versionId)).toBe(v2.versionId)
    // every version is still served as itself
    for (const v of [v1, v2, v3]) {
      const meta = await w.viewer.req('GET', `/api/boards/${w.board}/assets/${v.assetId}/${v.versionId}`)
      expect(meta.json()).toMatchObject({ versionId: v.versionId, name: v.name })
    }
    const { status, body } = await w.list(w.viewer, w.board, v1.assetId)
    expect(status).toBe(200)
    expect(body?.latestVersionId).toBe(v3.versionId)
    expect(body?.versions.map((v) => [v.n, v.versionId, v.supersedes, v.name])).toEqual([
      [1, v1.versionId, null, 'key-art.png'],
      [2, v2.versionId, v1.versionId, 'key-art-v2.png'],
      [3, v3.versionId, v2.versionId, 'key-art-v3.png'],
    ])
    expect(body?.versions[2]).toMatchObject({
      kind: 'image',
      sizeBytes: PNG.length,
      status: 'queued',
      uploadedBy: { id: w.owner.userId, name: 'Olive Owner', kind: 'account', external: false },
      threads: { open: 0, resolved: 0 },
      review: null,
      pageCount: null,
      durationMs: null,
    })
  })

  it('publishes asset.version on the board after COMMIT (nothing for a fresh upload)', async () => {
    const w = await world()
    const got = recordEvents(w.hub, w.board)
    const v1 = await w.up(w.owner, w.board, 'cut.png')
    expect(got.filter((e) => e.type === ASSET_VERSION_EVENT)).toEqual([])
    const v2 = await w.up(w.owner, w.board, 'cut-2.png', v1.versionId)
    expect(got.filter((e) => e.type === ASSET_VERSION_EVENT)).toEqual([
      { type: ASSET_VERSION_EVENT, data: { assetId: v1.assetId, versionId: v2.versionId } },
    ])
  })

  it('refuses before the body: a malformed or repeated header 400; a version this board does not serve 404', async () => {
    const w = await world()
    const v1 = await w.up(w.owner, w.board, 'cut.png')
    const other = await createBoard(w.owner, DEV_STUDIO, 'Other')
    const elsewhere = await w.up(w.owner, other, 'other.png')
    const foreignBoard = await createBoard(w.owner, w.owner.personalWorkspaceId, 'Personal')
    const foreign = await w.up(w.owner, foreignBoard, 'foreign.png')
    for (const bad of [
      '',
      'nope',
      `${v1.versionId} `,
      [v1.versionId, v1.versionId],
      'ast_0123456789abcdefghij',
    ]) {
      const r = await send(w.t, w.owner.cookie, w.board, 'x.png', { supersedes: bad })
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect((r.body.error as { code: string }).code).toBe(ASSET_VERSION_CODES.badHeader)
      expect(r.headers.connection).toBe('close')
    }
    // another board's version (same workspace, not linked), another workspace's, and one that does not exist
    for (const ver of [elsewhere.versionId, foreign.versionId, newId('ver')]) {
      const r = await send(w.t, w.owner.cookie, w.board, 'x.png', { supersedes: ver })
      expect(r.status).toBe(404)
      expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
      expect(r.headers.connection).toBe('close')
    }
    const { n } = await w.t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')
    expect(n).toBe(3)
  })

  it('refuses an older version 409 VERSION_NOT_LATEST with the newest one, and a kind mismatch 400', async () => {
    const w = await world()
    const v1 = await w.up(w.owner, w.board, 'cut.png')
    const v2 = await w.up(w.owner, w.board, 'cut-2.png', v1.versionId)
    const old = await send(w.t, w.owner.cookie, w.board, 'cut-3.png', { supersedes: v1.versionId })
    expect(old.status).toBe(409)
    expect(VersionNotLatestBody.parse(old.body).latestVersionId).toBe(v2.versionId)
    const pdf = await send(w.t, w.owner.cookie, w.board, 'cut.pdf', { supersedes: v2.versionId })
    expect(pdf.status).toBe(400)
    expect((pdf.body.error as { code: string }).code).toBe(ASSET_VERSION_CODES.kindMismatch)
    // a document may follow a document (a PDF, then an Office file or a video)
    const doc = await w.up(w.owner, w.board, 'deck.pdf')
    const video = await w.up(w.owner, w.board, 'deck.mp4', doc.versionId, 'video/mp4')
    expect(video.assetId).toBe(doc.assetId)
    const img = await send(w.t, w.owner.cookie, w.board, 'deck.png', { supersedes: video.versionId })
    expect(img.status).toBe(400)
  })

  it('a viewer is refused 403 before the header is looked at; the list is theirs to read; strangers get 404', async () => {
    const w = await world()
    const v1 = await w.up(w.owner, w.board, 'cut.png')
    const r = await send(w.t, w.viewer.cookie, w.board, 'cut-2.png', { supersedes: 'garbage' })
    expect(r.status).toBe(403)
    expect((await w.list(w.viewer, w.board, v1.assetId)).status).toBe(200)
    const stranger = await w.t.login('stan', 'Stan Stranger')
    await w.t.db.query('DELETE FROM workspace_members WHERE user_id = $1', [stranger.userId])
    expect((await w.list(stranger, w.board, v1.assetId)).status).toBe(404)
    expect((await w.t.anon('GET', `/api/boards/${w.board}/asset-versions/${v1.assetId}`)).statusCode).toBe(
      401,
    )
    // an unknown or malformed asset: 404
    expect((await w.list(w.owner, w.board, 'ast_0123456789abcdefghij')).status).toBe(404)
    expect((await w.list(w.owner, w.board, 'nope')).status).toBe(404)
    // a trashed board serves nothing
    expect((await w.owner.req('POST', `/api/boards/${w.board}/trash`)).statusCode).toBe(200)
    expect((await w.list(w.owner, w.board, v1.assetId)).status).toBe(404)
  })

  it('a copy numbers only the versions it serves, and never takes the chain over: only the origin board supersedes', async () => {
    const w = await world()
    const v1 = await w.up(w.owner, w.board, 'cut.png')
    const v2 = await w.up(w.owner, w.board, 'cut-2.png', v1.versionId)
    const v3 = await w.up(w.owner, w.board, 'cut-3.png', v2.versionId)
    // a client copy that shows v3 only (as a duplicate links what the canvas showed)
    const copy = await createBoard(w.owner, DEV_STUDIO, 'Client copy')
    await w.t.db.query(
      'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
      [DEV_STUDIO, copy, v3.assetId, v3.versionId],
    )
    const onCopy = await w.list(w.owner, copy, v1.assetId)
    expect(onCopy.body?.versions.map((v) => [v.n, v.versionId, v.supersedes])).toEqual([
      [1, v3.versionId, null],
    ])
    // the copy only links v3, uploaded on the origin board: superseding it from the copy is refused (the web then
    // makes a fresh asset), before the body and with nothing stored
    const before = await w.t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')
    const refused = await send(w.t, w.owner.cookie, copy, 'cut-4b.png', { supersedes: v3.versionId })
    expect(refused.status).toBe(409)
    expect(VersionNotLatestBody.parse(refused.body)).toMatchObject({
      latestVersionId: v3.versionId,
      error: {
        code: ASSET_VERSION_CODES.notLatest,
        message: 'This file’s versions are kept on another board. Upload it here as a new file instead.',
      },
    })
    expect(refused.headers.connection).toBe('close')
    expect((await w.t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')).n).toBe(
      before.n,
    )
    // a fresh upload on the copy works as ever
    const fresh = await w.up(w.owner, copy, 'cut-4b.png')
    expect(fresh.assetId).not.toBe(v1.assetId)
    // the origin board still continues the chain
    const v4 = await w.up(w.owner, w.board, 'cut-4.png', v3.versionId)
    expect(v4.assetId).toBe(v1.assetId)
    expect(await supersedesOf(w.t, v4.versionId)).toBe(v3.versionId)
    // and once it moved on there, the copy (still showing v3) is told the chain moved on
    const stale = await send(w.t, w.owner.cookie, copy, 'cut-5.png', { supersedes: v3.versionId })
    expect(stale.status).toBe(409)
    expect(VersionNotLatestBody.parse(stale.body)).toMatchObject({
      latestVersionId: v3.versionId,
      error: { message: 'This file already has a newer version on another board.' },
    })
  })

  it('counts this version’s threads as the caller may see them; the last review status given to it', async () => {
    const w = await world()
    const v1 = await w.up(w.owner, w.board, 'cut.png')
    const v2 = await w.up(w.owner, w.board, 'cut-2.png', v1.versionId)
    const anchor = (v: AssetVersionMeta) => ({
      kind: 'asset',
      shapeId: 'shape:card-1',
      assetId: v.assetId,
      versionId: v.versionId,
    })
    const open = await createThread(w.owner, w.board, 'Warmer?', anchor(v1))
    const done = await createThread(w.owner, w.board, 'Logo bigger', anchor(v1))
    await reply(w.owner, done.id, 'Done')
    expect((await w.owner.req('POST', `/api/threads/${done.id}/resolve`)).statusCode).toBe(200)
    await createThread(w.owner, w.board, 'Great', anchor(v2))
    // a thread whose every comment was deleted is gone for everyone
    const gone = await createThread(w.owner, w.board, 'Oops', anchor(v2))
    await w.t.db.query('UPDATE comments SET deleted_at = now() WHERE thread_id = $1', [gone.id])
    // a team-only thread: counted for the team, not for a name-only guest
    await w.t.db.query("UPDATE comment_threads SET visibility = 'team' WHERE id = $1", [open.id])
    const link = await guestLink(w.owner, w.board, { role: 'viewer' })
    const guest = await joinAsGuest(w.t, link.url, 'Dana')
    const counts = async (c: { req: Client['req'] }) =>
      (await w.list(c, w.board, v1.assetId)).body?.versions.map((v) => v.threads)
    expect(await counts(w.owner)).toEqual([
      { open: 1, resolved: 1 },
      { open: 1, resolved: 0 },
    ])
    expect(await counts(guest)).toEqual([
      { open: 0, resolved: 1 },
      { open: 1, resolved: 0 },
    ])
    // a review status event about v2 (as WS1's store writes one)
    const item = `rvi_${newId('ver').slice(4)}`
    await w.t.db.query(
      `INSERT INTO review_items (id, workspace_id, board_id, element_id, kind, asset_id, label, created_by)
       VALUES ($1, $2, $3, 'card-1', 'file', $4, 'Key art', $5)`,
      [item, DEV_STUDIO, w.board, v1.assetId, w.owner.userId],
    )
    for (const status of ['changes_requested', 'approved'])
      await w.t.db.query(
        `INSERT INTO review_events (id, workspace_id, board_id, item_id, kind, status, reason, version_id, actor_id,
                                    actor_name, actor_kind)
         VALUES ($1, $2, $3, $4, 'status', $5, 'set', $6, NULL, 'Dana', 'guest')`,
        [`rve_${newId('ver').slice(4)}`, DEV_STUDIO, w.board, item, status, v2.versionId],
      )
    const listed = (await w.list(guest, w.board, v1.assetId)).body
    expect(listed?.versions[0]?.review).toBeNull()
    expect(listed?.versions[1]?.review).toMatchObject({
      status: 'approved',
      by: { id: null, name: 'Dana', kind: 'guest', external: false },
    })
  })

  it('a name-only guest on an editing link uploads a version; the list names it by its typed name', async () => {
    const w = await world()
    const v1 = await w.up(w.owner, w.board, 'cut.png')
    const link = await guestLink(w.owner, w.board, { role: 'editor' })
    const guest = await joinAsGuest(w.t, link.url, 'Dana Whitfield')
    const r = await send(w.t, guest.cookie, w.board, 'cut-2.png', { supersedes: v1.versionId })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const listed = (await w.list(w.owner, w.board, v1.assetId)).body
    expect(listed?.versions[1]?.uploadedBy).toEqual({
      id: guest.userId,
      name: 'Dana Whitfield',
      kind: 'guest',
      external: false,
    })
    // a viewer link's guest cannot
    const viewLink = await guestLink(w.owner, w.board, { role: 'viewer' })
    const looker = await joinAsGuest(w.t, viewLink.url, 'Lou')
    expect(
      (await send(w.t, looker.cookie, w.board, 'cut-3.png', { supersedes: r.meta.versionId })).status,
    ).toBe(403)
  })
})
