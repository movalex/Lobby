// Wave S, WS1 (docs/WAVE-S-CONTRACTS.md §2): the review routes on PGlite. Who may do what (server-side, fail
// closed), the actor from the session and as it was then ("Ana (guest)"), one status write (fromSeq, the version a
// file's status is about, the note thread, the bell), the history, rounds with their named checkpoint, the
// new-version reset WS2 calls, the dashboard counts, and the board events after COMMIT.

import {
  ListAssetVersionsResponse,
  ListNotificationsResponse,
  ListReviewEventsResponse,
  REVIEW_GUESTS_MESSAGE,
  REVIEW_LIMITS,
  ReviewRoundResponse,
  ReviewStatusChangedBody,
  reviewActorLabel,
  reviewEventsPath,
  reviewItemPath,
  reviewItemsPath,
  reviewPath,
  reviewRoundClosePath,
  reviewRoundsPath,
  SetReviewStatusResponse,
  VersionNotLatestBody,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { resetForNewVersion } from '../../../src/features/review/hooks.ts'
import { REVIEW_NOTIFY_ACTOR_CAP, REVIEW_NOTIFY_BOARD_CAP } from '../../../src/features/review/store.ts'
import { createBoard } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { createFakeSync, upload } from '../history/helpers.ts'
import {
  type Caller,
  codeOf,
  DEV_STUDIO,
  getReview,
  grant,
  mark,
  type ReviewWorld,
  rev3,
  reviewWorld,
  setStatus,
  supersede,
  versionRow,
} from './support.ts'

let w: ReviewWorld | undefined
afterEach(async () => {
  await w?.api.close()
  w = undefined
})

const count = async (world: ReviewWorld, table: string) =>
  (await world.api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n

describe('who may see and set a review (server-side, fail closed)', () => {
  it('a member without access gets 404 everywhere; a viewer link sees but cannot set; a commenter-link guest sets', async () => {
    w = await reviewWorld()
    const world = w
    const item = await mark(world.bob, world.board, {
      elementId: 'frame-1',
      kind: 'frame',
      label: 'Key art B',
    })
    // carol is not on the board: the review does not exist for her
    for (const [m, url, body] of [
      ['GET', reviewPath(world.board), undefined],
      ['GET', reviewEventsPath(world.board, item.id), undefined],
      ['POST', `${reviewItemPath(world.board, item.id)}/status`, { status: 'approved' }],
      ['POST', reviewItemsPath(world.board), { elementId: 'f2', kind: 'frame', label: 'x' }],
      ['POST', reviewRoundsPath(world.board), {}],
    ] as const) {
      const res = await world.carol.req(m, url, body)
      expect(res.statusCode, `${m} ${url}`).toBe(404)
    }
    // the viewer link sees the same review, with no buttons, and the server refuses its write
    const seen = await getReview(world.vic, world.board)
    expect(seen.items.map((i) => i.id)).toEqual([item.id])
    expect(seen.can).toEqual({ setStatus: false, manage: false })
    const refused = await setStatus(world.vic, world.board, item.id, { status: 'approved' })
    expect(refused.statusCode, refused.body).toBe(403)
    // the commenter-link guest may approve, but not manage
    expect((await getReview(world.ana, world.board)).can).toEqual({ setStatus: true, manage: false })
    const ok = await setStatus(world.ana, world.board, item.id, { status: 'approved', fromSeq: 0 })
    expect(ok.statusCode, ok.body).toBe(200)
    const body = SetReviewStatusResponse.parse(ok.json())
    expect(body.item).toMatchObject({ status: 'approved', statusSeq: 1 })
    expect(body.item.statusBy).toEqual({ id: world.ana.userId, name: 'Ana', kind: 'guest', external: false })
    expect(reviewActorLabel(body.item.statusBy ?? { name: '', kind: 'account', external: false })).toBe(
      'Ana (guest)',
    )
    expect(body.event).toMatchObject({
      kind: 'status',
      status: 'approved',
      previousStatus: 'pending',
      reason: 'set',
    })
    // the owner and an admin manage
    expect((await getReview(world.bob, world.board)).can).toEqual({ setStatus: true, manage: true })
    expect((await getReview(world.alice, world.board)).can).toEqual({ setStatus: true, manage: true })
  })

  it('a name-only guest is refused the five manage routes (GUEST_ACCOUNT_REQUIRED), a workshop editor too', async () => {
    w = await reviewWorld()
    const world = w
    const item = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'Key art' })
    const round = ReviewRoundResponse.parse(
      (await world.bob.req('POST', reviewRoundsPath(world.board), {})).json(),
    ).round
    for (const guest of [world.ana, world.ed]) {
      for (const [m, url, body] of [
        ['POST', reviewItemsPath(world.board), { elementId: 'f2', kind: 'frame', label: 'x' }],
        ['PATCH', reviewItemPath(world.board, item.id), { label: 'y' }],
        ['DELETE', reviewItemPath(world.board, item.id), undefined],
        ['POST', reviewRoundsPath(world.board), {}],
        ['POST', reviewRoundClosePath(world.board, round.id), {}],
      ] as const) {
        const res = await guest.req(m, url, body)
        expect(res.statusCode, `${m} ${url}`).toBe(403)
        expect(codeOf(res)).toBe('GUEST_ACCOUNT_REQUIRED')
        expect((res.json() as { error: { message: string } }).error.message).toBe(REVIEW_GUESTS_MESSAGE)
      }
    }
    // the workshop guest's link role is editor: it may still set a status
    const ok = await setStatus(world.ed, world.board, item.id, { status: 'changes_requested' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await count(world, 'review_items')).toBe(1)
  })

  it('an account commenter sets but does not manage; an editor manages; an archived board is read-only for all', async () => {
    w = await reviewWorld()
    const world = w
    await grant(world, world.carol.userId, 'commenter')
    const item = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'Key art' })
    expect((await getReview(world.carol, world.board)).can).toEqual({ setStatus: true, manage: false })
    const add = await world.carol.req('POST', reviewItemsPath(world.board), {
      elementId: 'f2',
      kind: 'frame',
      label: 'x',
    })
    expect(add.statusCode, add.body).toBe(403)
    expect((await setStatus(world.carol, world.board, item.id, { status: 'approved' })).statusCode).toBe(200)
    await grant(world, world.carol.userId, 'editor')
    await mark(world.carol, world.board, { elementId: 'frame-2', kind: 'frame', label: 'Logo' })
    await world.api.db.query("UPDATE boards SET status = 'archived' WHERE id = $1", [world.board])
    for (const c of [world.bob, world.carol, world.ana]) {
      expect((await getReview(c, world.board)).can).toEqual({ setStatus: false, manage: false })
      expect((await setStatus(c, world.board, item.id, { status: 'pending' })).statusCode).toBe(403)
    }
    expect(
      (
        await world.bob.req('POST', reviewItemsPath(world.board), {
          elementId: 'f3',
          kind: 'frame',
          label: 'x',
        })
      ).statusCode,
    ).toBe(403)
    // trashed: gone for everyone
    await world.api.db.query("UPDATE boards SET status = 'trashed', trashed_at = now() WHERE id = $1", [
      world.board,
    ])
    expect((await world.bob.req('GET', reviewPath(world.board))).statusCode).toBe(404)
  })

  it('every input is strict: an actor (or any unknown key) is refused, and the actor is the session', async () => {
    w = await reviewWorld()
    const world = w
    const item = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'Key art' })
    const forged = await setStatus(world.ana, world.board, item.id, {
      status: 'approved',
      actor: { id: world.bob.userId, name: 'Bob', kind: 'account' },
    })
    expect(forged.statusCode).toBe(400)
    const add = await world.bob.req('POST', reviewItemsPath(world.board), {
      elementId: 'f2',
      kind: 'frame',
      label: 'x',
      createdBy: world.alice.userId,
    })
    expect(add.statusCode).toBe(400)
    expect(
      (
        await world.bob.req('POST', reviewItemsPath(world.board), {
          elementId: 'bad id',
          kind: 'frame',
          label: 'x',
        })
      ).statusCode,
    ).toBe(400)
    const events = await world.api.db.query<{ actor_id: string; kind: string }>(
      'SELECT actor_id, kind FROM review_events ORDER BY seq',
    )
    expect(events.rows).toEqual([{ actor_id: world.bob.userId, kind: 'added' }])
  })
})

describe('items', () => {
  it('marks once per element (409 ALREADY_IN_REVIEW), labels, orders, removes softly, marks again as a new row', async () => {
    w = await reviewWorld()
    const world = w
    const item = await mark(world.bob, world.board, {
      elementId: 'frame-1',
      kind: 'frame',
      label: '  Key​ art  ',
    })
    expect(item).toMatchObject({
      label: 'Key art',
      kind: 'frame',
      assetId: null,
      status: 'pending',
      statusSeq: 0,
    })
    expect(item.statusBy).toBeNull()
    const again = await world.bob.req('POST', reviewItemsPath(world.board), {
      elementId: 'frame-1',
      kind: 'frame',
      label: 'Again',
    })
    expect(again.statusCode).toBe(409)
    expect(codeOf(again)).toBe('ALREADY_IN_REVIEW')
    const patched = await world.bob.req('PATCH', reviewItemPath(world.board, item.id), {
      label: 'Hero',
      position: 3,
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect((patched.json() as { item: { label: string; position: number } }).item).toMatchObject({
      label: 'Hero',
      position: 3,
    })
    expect((await world.bob.req('DELETE', reviewItemPath(world.board, item.id))).statusCode).toBe(204)
    expect((await getReview(world.bob, world.board)).items).toEqual([])
    expect((await world.bob.req('DELETE', reviewItemPath(world.board, item.id))).statusCode).toBe(404)
    // its history stays readable
    const hist = ListReviewEventsResponse.parse(
      (await world.bob.req('GET', reviewEventsPath(world.board, item.id))).json(),
    )
    expect(hist.events.map((e) => e.kind)).toEqual(['removed', 'added'])
    const fresh = await mark(world.bob, world.board, {
      elementId: 'frame-1',
      kind: 'frame',
      label: 'Key art',
    })
    expect(fresh.id).not.toBe(item.id)
  })

  it('a file names an asset with a version this board can show (404 otherwise); a frame names none (400)', async () => {
    w = await reviewWorld()
    const world = w
    const { assetId } = await versionRow(world, world.board)
    const item = await mark(world.bob, world.board, {
      elementId: 'card-1',
      kind: 'file',
      assetId,
      label: 'Trailer',
    })
    expect(item).toMatchObject({ kind: 'file', assetId })
    const foreign = await versionRow(world, await createBoard(world.alice, DEV_STUDIO, 'Other'))
    const res = await world.bob.req('POST', reviewItemsPath(world.board), {
      elementId: 'card-2',
      kind: 'file',
      assetId: foreign.assetId,
      label: 'Not here',
    })
    expect(res.statusCode).toBe(404)
    const noAsset = await world.bob.req('POST', reviewItemsPath(world.board), {
      elementId: 'card-3',
      kind: 'file',
      label: 'x',
    })
    expect(noAsset.statusCode).toBe(400)
    const frameWithAsset = await world.bob.req('POST', reviewItemsPath(world.board), {
      elementId: 'frame-9',
      kind: 'frame',
      assetId,
      label: 'x',
    })
    expect(frameWithAsset.statusCode).toBe(400)
  })

  it('a board holds at most 200 live items (409 REVIEW_FULL)', async () => {
    w = await reviewWorld()
    const world = w
    await world.api.db.query(
      `INSERT INTO review_items (id, workspace_id, board_id, element_id, kind, label, created_by)
       SELECT 'rvi_fill' || lpad(g::text, 12, '0'), $1, $2, 'el-' || g, 'frame', 'Item ' || g, $3
         FROM generate_series(1, 200) g`,
      [DEV_STUDIO, world.board, world.bob.userId],
    )
    const res = await world.bob.req('POST', reviewItemsPath(world.board), {
      elementId: 'x',
      kind: 'frame',
      label: 'x',
    })
    expect(res.statusCode).toBe(409)
    expect(codeOf(res)).toBe('REVIEW_FULL')
  })
})

describe('one status write', () => {
  it('fromSeq: a stale seq is 409 STATUS_CHANGED with the item as it is now; without it the write wins', async () => {
    w = await reviewWorld()
    const world = w
    const item = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'Key art' })
    expect(
      (await setStatus(world.ana, world.board, item.id, { status: 'changes_requested', fromSeq: 0 }))
        .statusCode,
    ).toBe(200)
    const stale = await setStatus(world.bob, world.board, item.id, { status: 'approved', fromSeq: 0 })
    expect(stale.statusCode).toBe(409)
    const body = ReviewStatusChangedBody.parse(stale.json())
    expect(body.item).toMatchObject({ status: 'changes_requested', statusSeq: 1 })
    expect(reviewActorLabel(body.item.statusBy ?? { name: '', kind: 'account', external: false })).toBe(
      'Ana (guest)',
    )
    expect((await setStatus(world.bob, world.board, item.id, { status: 'approved' })).statusCode).toBe(200)
    const now = (await getReview(world.bob, world.board)).items[0]
    expect(now).toMatchObject({ status: 'approved', statusSeq: 2 })
  })

  it('a file status is about the version given (any this board serves): VERSION_REQUIRED, another board’s 404, "approved v2"', async () => {
    w = await reviewWorld()
    const world = w
    const v1 = await versionRow(world, world.board, { createdAt: new Date('2026-01-01T00:00:00Z') })
    const item = await mark(world.bob, world.board, {
      elementId: 'card-1',
      kind: 'file',
      assetId: v1.assetId,
      label: 'Trailer',
    })
    const missing = await setStatus(world.ana, world.board, item.id, { status: 'approved' })
    expect(missing.statusCode).toBe(400)
    expect(codeOf(missing)).toBe('VERSION_REQUIRED')
    const v2 = await versionRow(world, world.board, {
      assetId: v1.assetId,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    })
    // a version of the asset on a board this one does not serve it from: 404, nothing changes
    const elsewhere = await createBoard(world.bob, DEV_STUDIO, 'Elsewhere')
    const v3 = await versionRow(world, elsewhere, {
      assetId: v1.assetId,
      createdAt: new Date('2026-01-03T00:00:00Z'),
    })
    const foreign = await setStatus(world.ana, world.board, item.id, {
      status: 'approved',
      versionId: v3.versionId,
    })
    expect(foreign.statusCode).toBe(404)
    expect(await count(world, "review_events WHERE kind = 'status'")).toBe(0)
    // the older version the card shows (after an undo, "Make current", a restore): the status is about it
    const old = await setStatus(world.ana, world.board, item.id, {
      status: 'changes_requested',
      versionId: v1.versionId,
    })
    expect(old.statusCode, old.body).toBe(200)
    expect(SetReviewStatusResponse.parse(old.json()).item.statusVersionId).toBe(v1.versionId)
    const ok = await setStatus(world.ana, world.board, item.id, {
      status: 'approved',
      versionId: v2.versionId,
    })
    expect(ok.statusCode, ok.body).toBe(200)
    const res = SetReviewStatusResponse.parse(ok.json())
    expect(res.item.statusVersionId).toBe(v2.versionId)
    expect(res.event.versionId).toBe(v2.versionId)
    // a frame never takes a version
    const frame = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'Frame' })
    expect(
      (await setStatus(world.ana, world.board, frame.id, { status: 'approved', versionId: v2.versionId }))
        .statusCode,
    ).toBe(400)
  })

  it('Make current, then approve v1: the status is about v1 while v2 is the newest (never 409 for the shown version)', async () => {
    w = await reviewWorld()
    const world = w
    const v1 = await upload(world.api, world.bob, world.board, 'cut.png')
    const item = await mark(world.bob, world.board, {
      elementId: 'card-1',
      kind: 'file',
      assetId: v1.assetId,
      label: 'Cut',
    })
    const first = await setStatus(world.ana, world.board, item.id, {
      status: 'approved',
      versionId: v1.versionId,
    })
    expect(first.statusCode, first.body).toBe(200)
    // "Upload new version": v2 joins the chain and resets the item to pending about v2
    const up = await supersede(world, world.bob, world.board, v1.versionId, 'cut-2.png')
    expect(up.statusCode, up.body).toBe(201)
    const v2 = up.json() as { assetId: string; versionId: string }
    expect(v2.assetId).toBe(v1.assetId)
    expect((await getReview(world.bob, world.board)).items[0]).toMatchObject({
      status: 'pending',
      statusVersionId: v2.versionId,
    })
    // the card is pointed back at v1 (the version list's "Make current", an undo, a checkpoint restore); the web sends
    // the version the card shows
    const again = await setStatus(world.ana, world.board, item.id, {
      status: 'approved',
      versionId: v1.versionId,
    })
    expect(again.statusCode, again.body).toBe(200)
    const res = SetReviewStatusResponse.parse(again.json())
    expect(res.item).toMatchObject({ status: 'approved', statusVersionId: v1.versionId })
    expect(res.event.versionId).toBe(v1.versionId)
    // the version list says which version got it
    const list = ListAssetVersionsResponse.parse(
      (await world.bob.req('GET', `/api/boards/${world.board}/asset-versions/${v1.assetId}`)).json(),
    )
    expect(list.latestVersionId).toBe(v2.versionId)
    expect(list.versions.map((v) => v.review?.status ?? null)).toEqual(['approved', 'pending'])
  })

  it('a card that now shows another asset (a fresh-asset fallback): a status on it re-points the item to that asset', async () => {
    w = await reviewWorld()
    const world = w
    const a = await versionRow(world, world.board)
    const item = await mark(world.bob, world.board, {
      elementId: 'card-1',
      kind: 'file',
      assetId: a.assetId,
      label: 'Key art',
    })
    expect(
      (await setStatus(world.ana, world.board, item.id, { status: 'approved', versionId: a.versionId }))
        .statusCode,
    ).toBe(200)
    // Replace media made a fresh asset (another board held the chain, or a rev-2 tab): the element now names it
    const b = await versionRow(world, world.board)
    const res = await setStatus(world.ana, world.board, item.id, {
      status: 'changes_requested',
      versionId: b.versionId,
      note: 'Darker sky',
    })
    expect(res.statusCode, res.body).toBe(200)
    const got = SetReviewStatusResponse.parse(res.json())
    expect(got.item).toMatchObject({
      assetId: b.assetId,
      status: 'changes_requested',
      statusVersionId: b.versionId,
    })
    expect(got.event.versionId).toBe(b.versionId)
    // the note is pinned to the new file's version, never a mix of the old asset and the new version
    expect(got.thread?.anchor).toEqual({
      kind: 'asset',
      shapeId: 'shape:card-1',
      assetId: b.assetId,
      versionId: b.versionId,
    })
    // a new version of the NEW asset resets it; a version of the old one no longer does
    const items = await world.api.db.transaction((tx) =>
      resetForNewVersion(tx, {
        workspaceId: DEV_STUDIO,
        boardId: world.board,
        assetId: a.assetId,
        versionId: a.versionId,
        actorId: world.bob.userId,
      }),
    )
    expect(items).toEqual([])
    // an asset this board does not serve: 404, the item stays as it is
    const elsewhere = await createBoard(world.bob, DEV_STUDIO, 'Elsewhere')
    const c = await versionRow(world, elsewhere)
    expect(
      (await setStatus(world.ana, world.board, item.id, { status: 'approved', versionId: c.versionId }))
        .statusCode,
    ).toBe(404)
    expect((await getReview(world.bob, world.board)).items[0]).toMatchObject({
      assetId: b.assetId,
      status: 'changes_requested',
    })
  })

  it('the newest version is the chain’s (supersedes), not created_at then id: two versions in one millisecond', async () => {
    w = await reviewWorld()
    const world = w
    const at = new Date('2026-01-01T00:00:00Z')
    // ids in the opposite order of the chain: `newer` sorts first by id, and supersedes `older`
    const newer = await versionRow(world, world.board, { createdAt: at })
    const older = await versionRow(world, world.board, { assetId: newer.assetId, createdAt: at })
    await world.api.db.query('UPDATE asset_versions SET supersedes = $2 WHERE id = $1', [
      newer.versionId,
      older.versionId,
    ])
    const item = await mark(world.bob, world.board, {
      elementId: 'card-1',
      kind: 'file',
      assetId: newer.assetId,
      label: 'Cut',
    })
    const res = await setStatus(world.ana, world.board, item.id, {
      status: 'approved',
      versionId: newer.versionId,
    })
    expect(res.statusCode, res.body).toBe(200)
    const list = ListAssetVersionsResponse.parse(
      (await world.bob.req('GET', `/api/boards/${world.board}/asset-versions/${newer.assetId}`)).json(),
    )
    expect(list.versions.map((v) => v.versionId)).toEqual([older.versionId, newer.versionId])
    expect(list.latestVersionId).toBe(newer.versionId)
    // the upload agrees: the chain's head is the one to supersede
    const up = await supersede(world, world.bob, world.board, older.versionId, 'cut-3.png')
    expect(up.statusCode).toBe(409)
    expect(VersionNotLatestBody.parse(up.json()).latestVersionId).toBe(newer.versionId)
  })

  it('a note is an everyone thread made in the same write (a frame: top-right; a file: on the version)', async () => {
    w = await reviewWorld()
    const world = w
    const frame = await mark(world.bob, world.board, {
      elementId: 'frame-1',
      kind: 'frame',
      label: 'Key art',
    })
    const res = await setStatus(world.ana, world.board, frame.id, {
      status: 'changes_requested',
      note: 'Logo larger, please',
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = SetReviewStatusResponse.parse(res.json())
    expect(body.thread).toMatchObject({
      visibility: 'everyone',
      anchor: { kind: 'shape', shapeId: 'shape:frame-1', u: 1, v: 0 },
    })
    expect(body.thread?.comments[0]?.body).toBe('Logo larger, please')
    expect(body.event.threadId).toBe(body.thread?.id)
    const threads = await world.bob.req('GET', `/api/boards/${world.board}/threads`)
    expect((threads.json() as { threads: { id: string }[] }).threads.map((t) => t.id)).toEqual([
      body.thread?.id,
    ])
    const v1 = await versionRow(world, world.board)
    const file = await mark(world.bob, world.board, {
      elementId: 'card-1',
      kind: 'file',
      assetId: v1.assetId,
      label: 'Cut',
    })
    const onFile = SetReviewStatusResponse.parse(
      (
        await setStatus(world.ana, world.board, file.id, {
          status: 'changes_requested',
          versionId: v1.versionId,
          note: 'Trim the end',
        })
      ).json(),
    )
    expect(onFile.thread?.anchor).toEqual({
      kind: 'asset',
      shapeId: 'shape:card-1',
      assetId: v1.assetId,
      versionId: v1.versionId,
    })
  })

  it('a refused write leaves nothing behind (no event, no thread, no notification)', async () => {
    w = await reviewWorld()
    const world = w
    const v1 = await versionRow(world, world.board)
    const file = await mark(world.bob, world.board, {
      elementId: 'card-1',
      kind: 'file',
      assetId: v1.assetId,
      label: 'Cut',
    })
    // a version this board does not serve (uploaded to another board, not linked here)
    const elsewhere = await createBoard(world.bob, DEV_STUDIO, 'Elsewhere')
    const v2 = await versionRow(world, elsewhere, { assetId: v1.assetId })
    const before = await count(world, 'review_events')
    const res = await setStatus(world.ana, world.board, file.id, {
      status: 'changes_requested',
      versionId: v2.versionId,
      note: 'Trim',
    })
    expect(res.statusCode).toBe(404)
    expect(await count(world, 'review_events')).toBe(before)
    expect(await count(world, 'comment_threads')).toBe(0)
    expect(await count(world, "notifications WHERE kind = 'review_status'")).toBe(0)
  })

  it('30 status changes per person per board per minute, then 429 REVIEW_RATE_LIMITED with Retry-After', async () => {
    w = await reviewWorld()
    const world = w
    const item = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'Key art' })
    for (let i = 0; i < 30; i++)
      expect(
        (await setStatus(world.ana, world.board, item.id, { status: i % 2 ? 'approved' : 'pending' }))
          .statusCode,
      ).toBe(200)
    const over = await setStatus(world.ana, world.board, item.id, { status: 'approved' })
    expect(over.statusCode).toBe(429)
    expect(codeOf(over)).toBe('REVIEW_RATE_LIMITED')
    expect(over.headers['retry-after']).toBe('60')
    // another person is not held back
    expect((await setStatus(world.bob, world.board, item.id, { status: 'approved' })).statusCode).toBe(200)
    world.api.clock.advance(61_000)
    expect((await setStatus(world.ana, world.board, item.id, { status: 'approved' })).statusCode).toBe(200)
  })

  it('the bell: owners, the marker and earlier account setters hear it, never the actor; rev 3 reads the facts', async () => {
    w = await reviewWorld()
    const world = w
    await grant(world, world.carol.userId, 'editor')
    // carol marks; bob owns; ana (a guest) and then alice set
    const item = await mark(world.carol, world.board, {
      elementId: 'frame-1',
      kind: 'frame',
      label: 'Key art B',
    })
    expect(
      (await setStatus(world.alice, world.board, item.id, { status: 'changes_requested' })).statusCode,
    ).toBe(200)
    expect((await setStatus(world.ana, world.board, item.id, { status: 'approved' })).statusCode).toBe(200)
    const rows = await world.api.db.query<{ user_id: string; actor_id: string }>(
      "SELECT user_id, actor_id FROM notifications WHERE kind = 'review_status' ORDER BY seq",
    )
    const firstSet = rows.rows.filter((r) => r.actor_id === world.alice.userId).map((r) => r.user_id)
    expect(firstSet.sort()).toEqual([world.bob.userId, world.carol.userId].sort())
    const second = rows.rows.filter((r) => r.actor_id === world.ana.userId).map((r) => r.user_id)
    // alice set it earlier (an account): she hears the guest's approval; the guest never gets a bell row
    expect(second.sort()).toEqual([world.alice.userId, world.bob.userId, world.carol.userId].sort())
    const bell = ListNotificationsResponse.parse(
      (await world.bob.req('GET', '/api/me/notifications', undefined, rev3)).json(),
    )
    const top = bell.notifications[0]
    expect(top?.kind).toBe('review_status')
    expect(top?.actor?.name).toBe('Ana (guest)')
    expect(top?.review).toEqual({
      event: 'status',
      itemId: item.id,
      status: 'approved',
      reason: 'set',
      label: 'Key art B',
      roundTitle: null,
      itemCount: null,
    })
    // a rev-2 build gets neither the row nor its count
    const old = (
      await world.bob.req('GET', '/api/me/notifications', undefined, { 'x-lobby-client': '2' })
    ).json() as {
      notifications: { kind: string }[]
    }
    expect(old.notifications.map((n) => n.kind)).not.toContain('review_status')
  })

  it('31+ flips from two guests stay capped: one bell row per item per actor (the latest), a cap per actor and per board', async () => {
    w = await reviewWorld()
    const world = w
    const gus = await joinAsGuest(
      world.api,
      (await guestLink(world.bob, world.board, { role: 'commenter' })).url,
      'Gus',
    )
    const flips = async (c: Caller, itemId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        // past the per-minute write budget: the clock moves on, the bell's window (an hour) does not end
        if (i > 0 && i % REVIEW_LIMITS.statusChangesPerMinute === 0) world.api.clock.advance(61_000)
        const res = await setStatus(c, world.board, itemId, {
          status: i % 2 ? 'approved' : 'changes_requested',
        })
        expect(res.statusCode, res.body).toBe(200)
      }
    }
    const bobsRows = async () =>
      (
        await world.api.db.query<{ actor_id: string; status: string; item_id: string }>(
          `SELECT n.actor_id, e.status, e.item_id FROM notifications n JOIN review_events e ON e.id = n.review_event_id
            WHERE n.user_id = $1 AND n.kind = 'review_status' ORDER BY n.seq`,
          [world.bob.userId],
        )
      ).rows
    // one item flipped 31 times by each guest: ONE row per guest, naming the last flip
    const one = await mark(world.bob, world.board, { elementId: 'frame-0', kind: 'frame', label: 'Key art' })
    await flips(world.ana, one.id, 31)
    await flips(gus, one.id, 31)
    expect(await bobsRows()).toEqual([
      { actor_id: world.ana.userId, status: 'changes_requested', item_id: one.id },
      { actor_id: gus.userId, status: 'changes_requested', item_id: one.id },
    ])
    // reading them does not reopen the floodgates: many items, each flipped, stay under both caps
    await world.api.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1', [
      world.bob.userId,
    ])
    const items: string[] = []
    for (let i = 1; i <= 40; i++)
      items.push(
        (await mark(world.bob, world.board, { elementId: `frame-${i}`, kind: 'frame', label: `F${i}` })).id,
      )
    for (const [k, id] of items.entries()) {
      if (k > 0 && k % REVIEW_LIMITS.statusChangesPerMinute === 0) world.api.clock.advance(61_000)
      expect((await setStatus(world.ana, world.board, id, { status: 'approved' })).statusCode).toBe(200)
    }
    for (const [k, id] of items.entries()) {
      if (k > 0 && k % REVIEW_LIMITS.statusChangesPerMinute === 0) world.api.clock.advance(61_000)
      expect((await setStatus(gus, world.board, id, { status: 'changes_requested' })).statusCode).toBe(200)
    }
    const rows = await bobsRows()
    const of = (id: string) => rows.filter((r) => r.actor_id === id).length
    expect(of(world.ana.userId)).toBe(REVIEW_NOTIFY_ACTOR_CAP)
    expect(rows.length).toBe(REVIEW_NOTIFY_BOARD_CAP)
    // the statuses themselves all applied
    expect(
      (await getReview(world.bob, world.board)).items.filter((i) => i.status === 'changes_requested'),
    ).toHaveLength(41)
    // an hour later the window is new
    world.api.clock.advance(61 * 60_000)
    expect((await setStatus(world.ana, world.board, one.id, { status: 'approved' })).statusCode).toBe(200)
    expect((await bobsRows()).length).toBe(REVIEW_NOTIFY_BOARD_CAP + 1)
  })

  it('a board event after COMMIT, the same payload for every viewer; a refused write publishes nothing', async () => {
    const events = new EventHub()
    w = await reviewWorld({ events })
    const world = w
    const seen: { type: string; data: unknown }[] = []
    events.subscribe(world.board, (e) => void seen.push({ type: e.type, data: e.data }))
    const item = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'Key art' })
    await setStatus(world.ana, world.board, item.id, { status: 'approved', note: 'Lovely' })
    const types = seen.map((e) => e.type)
    expect(types).toEqual(['review.item', 'review.item', 'comments.thread'])
    expect((seen[1]?.data as { item: { status: string } } | undefined)?.item.status).toBe('approved')
    seen.length = 0
    await setStatus(world.vic, world.board, item.id, { status: 'pending' })
    await setStatus(world.ana, world.board, item.id, { status: 'pending', fromSeq: 0 })
    expect(seen).toEqual([])
  })
})

describe('the history', () => {
  it('newest first, 50 a page, `before` pages on; an item of another board is 404', async () => {
    w = await reviewWorld()
    const world = w
    const item = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'Key art' })
    await world.api.db.query(
      `INSERT INTO review_events (id, workspace_id, board_id, item_id, kind, status, previous_status, reason, actor_id,
                                  actor_name, actor_kind)
       SELECT 'rve_fill' || lpad(g::text, 12, '0'), $1, $2, $3, 'status', 'approved', 'pending', 'set', $4, 'Bob', 'account'
         FROM generate_series(1, 60) g`,
      [DEV_STUDIO, world.board, item.id, world.bob.userId],
    )
    const p1 = ListReviewEventsResponse.parse(
      (await world.ana.req('GET', reviewEventsPath(world.board, item.id))).json(),
    )
    expect(p1.events).toHaveLength(50)
    expect(p1.events[0]?.seq).toBeGreaterThan(p1.events[1]?.seq ?? 0)
    expect(p1.nextBefore).not.toBeNull()
    const p2 = ListReviewEventsResponse.parse(
      (await world.ana.req('GET', reviewEventsPath(world.board, item.id, p1.nextBefore ?? 0))).json(),
    )
    expect(p2.events).toHaveLength(11)
    expect(p2.nextBefore).toBeNull()
    expect(p2.events.at(-1)?.kind).toBe('added')
    expect(
      (await world.ana.req('GET', `${reviewEventsPath(world.board, item.id)}?before=x`)).statusCode,
    ).toBe(400)
    expect(
      (await world.ana.req('GET', reviewEventsPath(world.board, 'rvi_0000000000nothere'))).statusCode,
    ).toBe(404)
  })

  it('keeps at most 1,000 events per item (the oldest go; the status still applies)', async () => {
    w = await reviewWorld()
    const world = w
    const item = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'Key art' })
    await world.api.db.query(
      `INSERT INTO review_events (id, workspace_id, board_id, item_id, kind, status, previous_status, reason, actor_id,
                                  actor_name, actor_kind)
       SELECT 'rve_fill' || lpad(g::text, 12, '0'), $1, $2, $3, 'status', 'approved', 'pending', 'set', $4, 'Bob', 'account'
         FROM generate_series(1, 1000) g`,
      [DEV_STUDIO, world.board, item.id, world.bob.userId],
    )
    expect((await setStatus(world.ana, world.board, item.id, { status: 'approved' })).statusCode).toBe(200)
    const n = await world.api.db.one<{ n: number; added: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE kind = 'added')::int AS added FROM review_events
        WHERE item_id = $1`,
      [item.id],
    )
    expect(n).toEqual({ n: 1000, added: 0 })
    expect((await getReview(world.bob, world.board)).items[0]?.status).toBe('approved')
  })
})

describe('rounds', () => {
  it('start: resets the picked items (approved kept), one bell row per recipient, a named checkpoint; one open round', async () => {
    const sync = createFakeSync()
    w = await reviewWorld({ sync })
    const world = w
    const a = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'A' })
    const b = await mark(world.bob, world.board, { elementId: 'frame-2', kind: 'frame', label: 'B' })
    const c = await mark(world.bob, world.board, { elementId: 'frame-3', kind: 'frame', label: 'C' })
    await setStatus(world.ana, world.board, a.id, { status: 'approved' })
    await setStatus(world.alice, world.board, b.id, { status: 'changes_requested' })
    const before = await world.api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'review_status'",
    )
    const res = await world.bob.req('POST', reviewRoundsPath(world.board), {})
    expect(res.statusCode, res.body).toBe(201)
    const { round, items } = ReviewRoundResponse.parse(res.json())
    expect(round).toMatchObject({ number: 1, title: 'Round 1', closedAt: null })
    expect(round.openedBy).toMatchObject({ id: world.bob.userId, kind: 'account' })
    // default: every live item not approved, reset to pending
    expect(items.map((i) => i.id).sort()).toEqual([b.id, c.id].sort())
    for (const i of items) expect(i).toMatchObject({ status: 'pending', roundId: round.id })
    const review = await getReview(world.bob, world.board)
    expect(review.openRoundId).toBe(round.id)
    expect(review.items.find((i) => i.id === a.id)).toMatchObject({ status: 'approved', roundId: null })
    // the checkpoint "Review round 1 sent", by bob, a manual one
    expect(round.checkpointId).not.toBeNull()
    const snap = await world.api.db.one<{ name: string; kind: string; created_by: string }>(
      'SELECT name, kind, created_by FROM board_snapshots WHERE id = $1',
      [round.checkpointId],
    )
    expect(snap).toEqual({ name: 'Review round 1 sent', kind: 'manual', created_by: world.bob.userId })
    // ONE notification per recipient for the whole start (alice set b earlier; bob is the actor)
    const after = await world.api.db.query<{ user_id: string; review_event_id: string }>(
      "SELECT user_id, review_event_id FROM notifications WHERE kind = 'review_status' ORDER BY seq OFFSET $1",
      [before.n],
    )
    expect(after.rows.map((r) => r.user_id)).toEqual([world.alice.userId])
    const bell = ListNotificationsResponse.parse(
      (await world.alice.req('GET', '/api/me/notifications', undefined, rev3)).json(),
    )
    expect(bell.notifications[0]?.review).toMatchObject({
      event: 'round_opened',
      roundTitle: 'Round 1',
      itemCount: 2,
    })
    // one open round per board
    const second = await world.bob.req('POST', reviewRoundsPath(world.board), { title: 'Again' })
    expect(second.statusCode).toBe(409)
    expect(codeOf(second)).toBe('ROUND_OPEN')
    // an item marked while the round is open joins it
    const d = await mark(world.bob, world.board, { elementId: 'frame-4', kind: 'frame', label: 'D' })
    expect(d.roundId).toBe(round.id)
    // close: frozen
    const closed = await world.bob.req('POST', reviewRoundClosePath(world.board, round.id), {})
    expect(closed.statusCode, closed.body).toBe(200)
    const closedBody = ReviewRoundResponse.parse(closed.json())
    expect(closedBody.round.closedAt).not.toBeNull()
    expect(closedBody.items.map((i) => i.id).sort()).toEqual([b.id, c.id, d.id].sort())
    const twice = await world.bob.req('POST', reviewRoundClosePath(world.board, round.id), {})
    expect(twice.statusCode).toBe(409)
    expect(codeOf(twice)).toBe('ROUND_CLOSED')
    // the next one is round 2, with its own checkpoint name
    const next = ReviewRoundResponse.parse(
      (await world.bob.req('POST', reviewRoundsPath(world.board), { keepApproved: false })).json(),
    )
    expect(next.round).toMatchObject({ number: 2, title: 'Round 2' })
    expect(next.items.map((i) => i.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort())
    for (const i of next.items) expect(i.status).toBe('pending')
    const names = await world.api.db.query<{ name: string }>(
      'SELECT name FROM board_snapshots ORDER BY created_at',
    )
    expect(names.rows.map((r) => r.name)).toEqual(['Review round 1 sent', 'Review round 2 sent'])
  })

  it('without a reachable sync server the round still opens, with no checkpoint; explicit items and a title', async () => {
    w = await reviewWorld()
    const world = w
    const a = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'A' })
    await mark(world.bob, world.board, { elementId: 'frame-2', kind: 'frame', label: 'B' })
    await setStatus(world.ana, world.board, a.id, { status: 'approved' })
    const res = await world.bob.req('POST', reviewRoundsPath(world.board), {
      title: 'Client pass',
      itemIds: [a.id],
    })
    expect(res.statusCode, res.body).toBe(201)
    const body = ReviewRoundResponse.parse(res.json())
    expect(body.round).toMatchObject({ title: 'Client pass', checkpointId: null })
    // keepApproved (default): the picked approved item stays approved
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ id: a.id, status: 'approved', roundId: body.round.id })
    expect(await count(world, 'board_snapshots')).toBe(0)
    const bad = await world.bob.req('POST', reviewRoundsPath(world.board), {
      itemIds: ['rvi_0000000000nothere'],
    })
    expect(bad.statusCode).toBe(409) // a round is open: refused before the items are looked at
  })
})

describe('the new-version reset (WS2 calls it in the upload transaction)', () => {
  it('resets the asset’s live non-pending items on boards that can show the new version, one bell row each', async () => {
    w = await reviewWorld()
    const world = w
    const v1 = await versionRow(world, world.board, { createdAt: new Date('2026-01-01T00:00:00Z') })
    const item = await mark(world.bob, world.board, {
      elementId: 'card-1',
      kind: 'file',
      assetId: v1.assetId,
      label: 'Cut',
    })
    await setStatus(world.ana, world.board, item.id, { status: 'approved', versionId: v1.versionId })
    const v2 = await versionRow(world, world.board, {
      assetId: v1.assetId,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    })
    const items = await world.api.db.transaction((tx) =>
      resetForNewVersion(tx, {
        workspaceId: DEV_STUDIO,
        boardId: world.board,
        assetId: v1.assetId,
        versionId: v2.versionId,
        actorId: world.carol.userId,
      }),
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: item.id, status: 'pending', statusVersionId: v2.versionId })
    const ev = await world.api.db.one<{ reason: string; version_id: string; actor_id: string }>(
      "SELECT reason, version_id, actor_id FROM review_events WHERE item_id = $1 AND kind = 'status' ORDER BY seq DESC LIMIT 1",
      [item.id],
    )
    expect(ev).toEqual({ reason: 'new_version', version_id: v2.versionId, actor_id: world.carol.userId })
    // a second reset changes nothing (already pending)
    const again = await world.api.db.transaction((tx) =>
      resetForNewVersion(tx, {
        workspaceId: DEV_STUDIO,
        boardId: world.board,
        assetId: v1.assetId,
        versionId: v2.versionId,
        actorId: world.carol.userId,
      }),
    )
    expect(again).toEqual([])
  })

  it('resets only the upload board: a copy of the card on another board keeps its status about v1', async () => {
    w = await reviewWorld()
    const world = w
    const other = await createBoard(world.bob, DEV_STUDIO, 'Copy')
    const v1 = await versionRow(world, world.board, { createdAt: new Date('2026-01-01T00:00:00Z') })
    // the copy: board B links v1 (copies share the asset id)
    await world.api.db.query(
      'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
      [DEV_STUDIO, other, v1.assetId, v1.versionId],
    )
    const here = await mark(world.bob, world.board, {
      elementId: 'card-1',
      kind: 'file',
      assetId: v1.assetId,
      label: 'A',
    })
    const there = await mark(world.bob, other, {
      elementId: 'card-1',
      kind: 'file',
      assetId: v1.assetId,
      label: 'B',
    })
    for (const [b, i] of [
      [world.board, here.id],
      [other, there.id],
    ] as const) {
      const res = await setStatus(world.bob, b, i, { status: 'approved', versionId: v1.versionId })
      expect(res.statusCode, res.body).toBe(200)
    }
    const v2 = await versionRow(world, world.board, {
      assetId: v1.assetId,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    })
    // even when board B can show v2 too (linked later), the upload on board A resets only A's item
    await world.api.db.query(
      'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
      [DEV_STUDIO, other, v1.assetId, v2.versionId],
    )
    const items = await world.api.db.transaction((tx) =>
      resetForNewVersion(tx, {
        workspaceId: DEV_STUDIO,
        boardId: world.board,
        assetId: v1.assetId,
        versionId: v2.versionId,
        actorId: world.bob.userId,
      }),
    )
    expect(items.map((i) => i.id)).toEqual([here.id])
    const rows = await world.api.db.query<{ id: string; status: string; status_version_id: string }>(
      'SELECT id, status, status_version_id FROM review_items ORDER BY label',
    )
    expect(rows.rows).toEqual([
      { id: here.id, status: 'pending', status_version_id: v2.versionId },
      { id: there.id, status: 'approved', status_version_id: v1.versionId },
    ])
  })
})

describe('the dashboard counts', () => {
  it('the board list carries live items per status (absent without any)', async () => {
    w = await reviewWorld()
    const world = w
    const list = async () =>
      (
        (await world.bob.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)).json() as {
          boards: { id: string; review?: unknown }[]
        }
      ).boards.find((b) => b.id === world.board)
    expect((await list())?.review).toBeUndefined()
    const a = await mark(world.bob, world.board, { elementId: 'frame-1', kind: 'frame', label: 'A' })
    await mark(world.bob, world.board, { elementId: 'frame-2', kind: 'frame', label: 'B' })
    const c = await mark(world.bob, world.board, { elementId: 'frame-3', kind: 'frame', label: 'C' })
    await setStatus(world.ana, world.board, a.id, { status: 'approved' })
    await setStatus(world.ana, world.board, c.id, { status: 'changes_requested' })
    expect((await list())?.review).toEqual({ pending: 1, changes: 1, approved: 1 })
    await world.bob.req('DELETE', reviewItemPath(world.board, a.id))
    expect((await list())?.review).toEqual({ pending: 1, changes: 1, approved: 0 })
  })
})
