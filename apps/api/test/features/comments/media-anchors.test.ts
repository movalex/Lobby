// Wave S (WS3, docs/WAVE-S-CONTRACTS.md §4): time-coded, page and spot comments. A new thread's `asset` anchor names a
// version servable on the board and of that asset; `page` only on a PDF and inside its page count, `timeMs` only on
// a video and inside its duration + 1 s (when the probe knows them); a `spot` only with an asset anchor, on a picture
// (an image, a video frame, a PDF page). Every refusal is 400 INVALID_ANCHOR and writes nothing. The spot round-trips
// exactly (0037's double precision columns), and a tab of the rev-2 build still parses every thread (the spot is a
// top-level optional field its z.object strips), events included.

import { CommentsThreadEvent, MEDIA_COMMENT_RULES, ThreadResponse } from '@draftroom/contracts'
import { Rev2CommentThread, Rev2ListThreadsResponse } from '@draftroom/contracts/fixtures/client-rev2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import { addVersion, countRows, type Fixture, onFile, onShape, point, setup } from './fixture.ts'

let f: Fixture
beforeEach(async () => {
  f = await setup()
})
afterEach(() => f.close())

const post = (body: object, c = f.commenter, board = f.boardId) =>
  c.req('POST', `/api/boards/${board}/threads`, body)

async function refused(body: object, why: RegExp) {
  const res = await post(body)
  expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(400)
  const error = (res.json() as { error: { code: string; message: string } }).error
  expect(error.code).toBe(MEDIA_COMMENT_RULES.invalidAnchor)
  expect(error.message).toMatch(why)
}

async function accepted(body: object) {
  const res = await post(body)
  expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(201)
  return ThreadResponse.parse(res.json()).thread
}

describe('time-coded comments on a video', () => {
  it('a time inside the probed duration (plus the 1 s slack) is stored; past it, or on another kind, refused', async () => {
    const video = await addVersion(f.api, f.owner, f.boardId, 'video', { durationMs: 5_000 })
    const pdf = await addVersion(f.api, f.owner, f.boardId, 'pdf', { pageCount: 4 })
    const t = await accepted({ anchor: onFile(video, { timeMs: 4_200 }), body: 'Logo pops here' })
    expect(t.anchor).toMatchObject({ kind: 'asset', versionId: video.versionId, timeMs: 4_200 })
    await accepted({ anchor: onFile(video, { timeMs: 0 }), body: 'First frame' })
    await accepted({
      anchor: onFile(video, { timeMs: 5_000 + MEDIA_COMMENT_RULES.timeSlackMs }),
      body: 'end',
    })
    await refused(
      { anchor: onFile(video, { timeMs: 5_000 + MEDIA_COMMENT_RULES.timeSlackMs + 1 }), body: 'x' },
      /past the end/,
    )
    await refused({ anchor: onFile(pdf, { timeMs: 1_000 }), body: 'x' }, /Only a video/)
    await refused({ anchor: onFile(video, { page: 1 }), body: 'x' }, /Only a PDF/)
    expect(await countRows(f.api, 'comment_threads')).toBe(3)
  })

  it('a video whose probe has no duration yet (still processing) takes any time the contract allows', async () => {
    const video = await addVersion(f.api, f.owner, f.boardId, 'video', { durationMs: null })
    await accepted({ anchor: onFile(video, { timeMs: 3_600_000 }), body: 'an hour in' })
  })
})

describe('page comments on a PDF or a document', () => {
  it('a page inside the page count is stored; page 5 of 4 refused; no page count yet: any page', async () => {
    const pdf = await addVersion(f.api, f.owner, f.boardId, 'pdf', { pageCount: 4 })
    const t = await accepted({ anchor: onFile(pdf, { page: 4 }), body: 'Typo on the last page' })
    expect(t.anchor).toMatchObject({ page: 4 })
    await refused({ anchor: onFile(pdf, { page: 5 }), body: 'x' }, /4 pages/)
    const fresh = await addVersion(f.api, f.owner, f.boardId, 'pdf', {})
    await accepted({ anchor: onFile(fresh, { page: 12 }), body: 'not probed yet' })
    const image = await addVersion(f.api, f.owner, f.boardId, 'image')
    await refused({ anchor: onFile(image, { page: 1 }), body: 'x' }, /Only a PDF/)
  })
})

describe('the version must be servable on this board and of the asset', () => {
  it('missing, of another asset, on another board (unlinked) or in another workspace: one refusal; linked: stored', async () => {
    const otherBoard = await createBoard(f.owner, DEV_STUDIO, 'Other cut')
    const mine = await addVersion(f.api, f.owner, f.boardId, 'image')
    const theirs = await addVersion(f.api, f.owner, otherBoard, 'image')
    const foreign = await addVersion(
      f.api,
      f.owner,
      f.foreignBoardId,
      'image',
      {},
      {
        workspaceId: f.owner.personalWorkspaceId,
      },
    )
    const msg = /not on this board/
    await refused(
      { anchor: onFile({ assetId: mine.assetId, versionId: 'ver_0123456789abcdefghij' }), body: 'x' },
      msg,
    )
    await refused({ anchor: onFile({ assetId: theirs.assetId, versionId: mine.versionId }), body: 'x' }, msg)
    await refused({ anchor: onFile(theirs), body: 'x' }, msg)
    await refused({ anchor: onFile(foreign), body: 'x' }, msg)
    expect(await countRows(f.api, 'comment_threads')).toBe(0)
    await f.api.db.query(
      'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
      [DEV_STUDIO, f.boardId, theirs.assetId, theirs.versionId],
    )
    await accepted({ anchor: onFile(theirs), body: 'linked here' })
    await accepted({ anchor: onFile(mine), body: 'uploaded here' })
  })

  it('a viewer is refused 403 before any version is looked at (nobody probes versions)', async () => {
    const res = await post(
      {
        anchor: onFile({ assetId: 'ast_0123456789abcdefghij', versionId: 'ver_0123456789abcdefghij' }),
        body: 'x',
      },
      f.viewer,
    )
    expect(res.statusCode).toBe(403)
  })

  it('a thread stays on the version it was made on when a newer version of the asset exists', async () => {
    const v1 = await addVersion(f.api, f.owner, f.boardId, 'video', { durationMs: 5_000 })
    const t = await accepted({ anchor: onFile(v1, { timeMs: 1_000 }), body: 'On the first cut' })
    const v2 = await addVersion(
      f.api,
      f.owner,
      f.boardId,
      'video',
      { durationMs: 6_000 },
      { assetId: v1.assetId },
    )
    await accepted({ anchor: onFile(v2, { timeMs: 5_500 }), body: 'On the second cut' })
    // v1 is 5 s long: 5.5 s is past its end, whatever v2's length
    await refused({ anchor: onFile(v1, { timeMs: 6_500 }), body: 'x' }, /past the end/)
    const list = await f.viewer.req('GET', `/api/boards/${f.boardId}/threads`)
    const threads = (list.json() as { threads: { id: string; anchor: { versionId: string } }[] }).threads
    expect(threads.find((x) => x.id === t.id)?.anchor.versionId).toBe(v1.versionId)
  })
})

describe('spots', () => {
  it('round-trip exactly on an image, a video frame and a PDF page, in the answer, the list and the event', async () => {
    const image = await addVersion(f.api, f.owner, f.boardId, 'image')
    const video = await addVersion(f.api, f.owner, f.boardId, 'video', { durationMs: 5_000 })
    const pdf = await addVersion(f.api, f.owner, f.boardId, 'pdf', { pageCount: 4 })
    const spot = { u: 0.123456789, v: 0.987654321 }
    const a = await accepted({ anchor: onFile(image), body: 'This corner', spot })
    expect(a.spot).toEqual(spot)
    const b = await accepted({
      anchor: onFile(video, { timeMs: 2_000 }),
      body: 'This face',
      spot: { u: 0, v: 1 },
    })
    expect(b.spot).toEqual({ u: 0, v: 1 })
    const c = await accepted({
      anchor: onFile(pdf, { page: 2 }),
      body: 'This line',
      spot: { u: 0.5, v: 0.5 },
    })
    expect(c.spot).toEqual({ u: 0.5, v: 0.5 })
    const plain = await accepted({ anchor: onFile(image), body: 'No spot' })
    expect('spot' in plain).toBe(false)
    const list = await f.viewer.req('GET', `/api/boards/${f.boardId}/threads`)
    const byId = new Map(
      (list.json() as { threads: { id: string; spot?: unknown }[] }).threads.map((t) => [t.id, t.spot]),
    )
    expect(byId.get(a.id)).toEqual(spot)
    expect(byId.get(plain.id)).toBeUndefined()
    const event = f.events.find(
      (e) => e.type === 'comments.thread' && (e.data as { thread: { id: string } }).thread.id === a.id,
    )
    expect(CommentsThreadEvent.parse(event?.data).thread.spot).toEqual(spot)
    expect(await f.api.db.one('SELECT spot_u, spot_v FROM comment_threads WHERE id = $1', [a.id])).toEqual({
      spot_u: spot.u,
      spot_v: spot.v,
    })
  })

  it('refused without an asset anchor, on a document without its page, on a file with no picture, out of range', async () => {
    const pdf = await addVersion(f.api, f.owner, f.boardId, 'pdf', { pageCount: 4 })
    const zip = await addVersion(f.api, f.owner, f.boardId, 'other')
    const spot = { u: 0.5, v: 0.5 }
    await refused({ anchor: point(), body: 'x', spot }, /only be on a file/)
    await refused({ anchor: onShape(), body: 'x', spot }, /only be on a file/)
    await refused({ anchor: onFile(pdf), body: 'x', spot }, /needs its page/)
    await refused({ anchor: onFile(zip), body: 'x', spot }, /no picture/)
    // the contract's own bounds (400 BAD_REQUEST before any check)
    for (const bad of [{ u: 1.5, v: 0 }, { u: 0.5 }, { u: 0.5, v: 0.5, w: 1 }, { u: -0.1, v: 0 }]) {
      const res = await post({ anchor: onFile(pdf, { page: 1 }), body: 'x', spot: bad })
      expect(res.statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect(await countRows(f.api, 'comment_threads')).toBe(0)
    expect(await countRows(f.api, 'comments')).toBe(0)
  })
})

describe('a tab of the rev-2 build', () => {
  it('parses the list and the events with its frozen schemas; the spot is stripped, the anchor identical', async () => {
    const video = await addVersion(f.api, f.owner, f.boardId, 'video', { durationMs: 5_000 })
    const t = await accepted({
      anchor: onFile(video, { timeMs: 1_500 }),
      body: 'Here',
      spot: { u: 0.25, v: 0.75 },
    })
    await accepted({ anchor: point(), body: 'On the board' })
    for (const rev of [null, '2']) {
      const res = await f.viewer.req(
        'GET',
        `/api/boards/${f.boardId}/threads`,
        undefined,
        rev ? { 'x-lobby-client': rev } : {},
      )
      const old = Rev2ListThreadsResponse.safeParse(res.json())
      expect(old.success, `rev ${rev}`).toBe(true)
      expect(old.data?.threads).toHaveLength(2)
      const mine = old.data?.threads.find((x) => x.id === t.id)
      expect(mine?.anchor).toEqual(t.anchor)
      expect(mine && 'spot' in mine).toBe(false)
    }
    for (const e of f.events.filter((x) => x.type === 'comments.thread')) {
      const thread = (e.data as { thread: unknown }).thread
      expect(Rev2CommentThread.safeParse(thread).success).toBe(true)
    }
  })
})
