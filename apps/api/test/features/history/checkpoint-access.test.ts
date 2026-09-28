// Listing, previewing and deleting checkpoints (docs/WAVE4-CONTRACTS.md checkpoints-2): who may do what.
//   GET    /api/boards/:bid/snapshots   view, but never a name-only guest (DANA-05; nor saving one)
//   GET    /api/snapshots/:sid/content  view + a workspace membership above guest
//   DELETE /api/snapshots/:sid          the board's owners (manage_access), never a guest; audited
// Guests of both kinds are checked: accounts whose workspace role is `guest`, and name-only guests who
// joined through a review or workshop link (users.kind = 'guest').
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { checkpointServices } from '../../../src/features/history/index.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest } from '../guests/support.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec, recordEvents } from './helpers.ts'

let api: TestApi
let sync: FakeSync
let events: EventHub
let alice: Client // owns Dev Studio (so: owner of every board in it)
let bob: Client // member; owns the board
let carol: Client // member; given a role per test
let dave: Client // member without access to the private board
let erin: Client // an account outside Dev Studio
let gwen: Client // an account that is a GUEST of Dev Studio
let boardId: string
let manualId: string
let autoId: string
const saved = { ...checkpointSettings }

beforeEach(async () => {
  Object.assign(checkpointSettings, { tickMs: 0, pruneEveryMs: 0 })
  sync = createFakeSync()
  events = new EventHub()
  api = await createTestApi({ deps: { syncInternal: sync, events } })
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  dave = await api.login('dave')
  erin = await api.login('erin')
  gwen = await api.login('gwen')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  await api.db.query("UPDATE workspace_members SET role = 'guest' WHERE user_id = $1 AND workspace_id = $2", [
    gwen.userId,
    DEV_STUDIO,
  ])
  boardId = await createBoard(bob, DEV_STUDIO, 'Pitch')
  sync.setBoard(boardId, [...baseRecords(), noteRec('n1', 'secret draft')])
  const manual = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'Draft' })
  expect(manual.statusCode).toBe(201)
  manualId = manual.json().id
  sync.setBoard(boardId, [...baseRecords(), noteRec('n1', 'cleaned up')])
  const auto = await checkpointServices.get(api.app)?.capture(boardId, 'session_end')
  if (auto?.status !== 'saved') throw new Error('no automatic checkpoint')
  autoId = auto.checkpoint.id
})
afterEach(async () => {
  Object.assign(checkpointSettings, saved)
  await api.close()
})

const grant = (who: Client, role: string) =>
  bob.req('PUT', `/api/boards/${boardId}/members/${who.userId}`, { role }).then((r) => {
    expect(r.statusCode, r.body).toBe(200)
  })
type Caller = Pick<Client, 'req'> | Pick<GuestClient, 'req'>
const preview = (c: Caller, sid = manualId) => c.req('GET', `/api/snapshots/${sid}/content`)
const remove = (c: Caller, sid = manualId) => c.req('DELETE', `/api/snapshots/${sid}`)
const code = (res: { json(): unknown }) => (res.json() as { error?: { code?: string } }).error?.code

describe('GET /api/snapshots/:sid/content (preview)', () => {
  it('gives the checkpoint and its records, for manual and automatic checkpoints alike', async () => {
    const res = await preview(bob)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    const body = res.json()
    expect(body.snapshot).toMatchObject({ id: manualId, kind: 'manual', reason: null, name: 'Draft' })
    expect(body.schema).toMatchObject({ schemaVersion: expect.any(Number) })
    expect(JSON.stringify(body.records)).toContain('secret draft')
    const auto = (await preview(bob, autoId)).json()
    expect(auto.snapshot).toMatchObject({ id: autoId, kind: 'auto', reason: 'session_end' })
    expect(JSON.stringify(auto.records)).toContain('cleaned up')
  })

  it('workspace members who can view the board may preview, whatever their board role', async () => {
    expect((await preview(alice)).statusCode).toBe(200)
    for (const role of ['viewer', 'commenter', 'editor']) {
      await grant(carol, role)
      expect((await preview(carol)).statusCode, role).toBe(200)
    }
  })

  it('people who cannot see the board get 404, signed-out callers 401, unknown ids 404', async () => {
    expect((await preview(dave)).statusCode).toBe(404)
    expect((await preview(erin)).statusCode).toBe(404)
    expect((await api.anon('GET', `/api/snapshots/${manualId}/content`)).statusCode).toBe(401)
    expect((await preview(bob, 'snp_doesnotexist000')).statusCode).toBe(404)
    expect((await preview(bob, 'not-an-id')).statusCode).toBe(404)
  })

  it('guest accounts and name-only guests get 403, whatever role they have on the board', async () => {
    for (const role of ['viewer', 'editor']) {
      await grant(gwen, role)
      const res = await preview(gwen)
      expect(res.statusCode, role).toBe(403)
      expect(res.json().error.message).toMatch(/Guests can’t open earlier versions/)
    }
    const viewerLink = await guestLink(bob, boardId, { role: 'viewer' })
    const sam = await joinAsGuest(api, viewerLink.url, 'Sam')
    expect((await preview(sam)).statusCode).toBe(403)
    const workshopLink = await guestLink(bob, boardId, { role: 'editor' })
    const kim = await joinAsGuest(api, workshopLink.url, 'Kim')
    expect((await preview(kim, autoId)).statusCode).toBe(403)
  })

  it('410 when the stored content is gone; 404 once the board is trashed', async () => {
    await api.blobs.delete(`snapshots/${boardId}/${manualId}.json`)
    expect((await preview(bob)).statusCode).toBe(410)
    expect((await bob.req('POST', `/api/boards/${boardId}/trash`)).statusCode).toBe(200)
    expect((await preview(bob, autoId)).statusCode).toBe(404)
  })
})

describe('GET/POST /api/boards/:bid/snapshots: none of it for name-only guests (DANA-05)', () => {
  const list = (c: Caller) => c.req('GET', `/api/boards/${boardId}/snapshots`)

  it('a review-link or workshop guest is refused the list and saving (403 GUEST_ACCOUNT_REQUIRED)', async () => {
    const viewerLink = await guestLink(bob, boardId, { role: 'viewer' })
    const sam = await joinAsGuest(api, viewerLink.url, 'Sam')
    const refused = await list(sam)
    expect(refused.statusCode).toBe(403)
    expect(code(refused)).toBe('GUEST_ACCOUNT_REQUIRED')
    expect(refused.body).not.toContain('Draft') // no checkpoint name in the answer
    const workshopLink = await guestLink(bob, boardId, { role: 'editor' })
    const kim = await joinAsGuest(api, workshopLink.url, 'Kim')
    expect((await list(kim)).statusCode).toBe(403)
    const save = await kim.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'Mine' })
    expect(save.statusCode).toBe(403)
    expect(code(save)).toBe('GUEST_ACCOUNT_REQUIRED')
    expect(await api.db.one('SELECT count(*)::int AS n FROM board_snapshots')).toEqual({ n: 2 })
  })

  it('people with an account still list them, workspace guests included; outsiders get 404 first', async () => {
    for (const role of ['viewer', 'editor']) {
      await grant(gwen, role)
      expect((await list(gwen)).statusCode, role).toBe(200)
    }
    await grant(carol, 'viewer')
    expect((await list(carol)).json().snapshots.map((s: { id: string }) => s.id)).toEqual([autoId, manualId])
    expect((await list(dave)).statusCode).toBe(404)
  })
})

describe('DELETE /api/snapshots/:sid', () => {
  it('the board owner deletes a checkpoint: row, stored content, an audit entry and a hint to every open list', async () => {
    const got = recordEvents(events, boardId)
    const res = await remove(bob)
    expect(res.statusCode).toBe(204)
    expect(await api.blobs.head(`snapshots/${boardId}/${manualId}.json`)).toBeNull()
    const list = (await bob.req('GET', `/api/boards/${boardId}/snapshots`)).json().snapshots
    expect(list.map((s: { id: string }) => s.id)).toEqual([autoId])
    expect(got).toEqual([{ type: 'history.snapshot.removed', data: { snapshotIds: [manualId] } }])
    const audit = await api.db.one<{ actor_id: string; action: string; target: string; detail: unknown }>(
      "SELECT actor_id, action, target, detail FROM audit_events WHERE action = 'board.checkpoint.delete'",
    )
    expect(audit).toMatchObject({
      actor_id: bob.userId,
      target: boardId,
      detail: { snapshotId: manualId, name: 'Draft', kind: 'manual', reason: null },
    })
    expect((await remove(bob)).statusCode).toBe(404)
    expect((await preview(bob)).statusCode).toBe(404)
  })

  it('automatic checkpoints can be deleted too, also by a workspace owner, and on an archived board', async () => {
    expect((await bob.req('POST', `/api/boards/${boardId}/archive`)).statusCode).toBe(200)
    expect((await remove(alice, autoId)).statusCode).toBe(204)
    expect((await remove(bob)).statusCode).toBe(204)
    expect(await api.db.one('SELECT count(*)::int AS n FROM board_snapshots')).toEqual({ n: 0 })
  })

  it('editors, commenters and viewers get 403; guests of both kinds too; outsiders 404; signed-out 401', async () => {
    for (const role of ['viewer', 'commenter', 'editor']) {
      await grant(carol, role)
      const res = await remove(carol)
      expect(res.statusCode, role).toBe(403)
      expect(res.json().error.message).toBe('Only the board’s owners can delete checkpoints.')
    }
    await grant(gwen, 'editor')
    expect((await remove(gwen)).statusCode).toBe(403)
    const workshopLink = await guestLink(bob, boardId, { role: 'editor' })
    const kim = await joinAsGuest(api, workshopLink.url, 'Kim')
    expect((await remove(kim, autoId)).statusCode).toBe(403)
    expect((await remove(dave)).statusCode).toBe(404)
    expect((await remove(erin)).statusCode).toBe(404)
    expect((await api.anon('DELETE', `/api/snapshots/${manualId}`)).statusCode).toBe(401)
    expect(await api.db.one('SELECT count(*)::int AS n FROM board_snapshots')).toEqual({ n: 2 })
    expect(
      await api.db.one('SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [
        'board.checkpoint.delete',
      ]),
    ).toEqual({ n: 0 })
  })

  it('refuses a request from another origin (CSRF) before anything is deleted', async () => {
    const res = await bob.req('DELETE', `/api/snapshots/${manualId}`, undefined, {
      origin: 'https://evil.example',
    })
    expect(res.statusCode).toBe(403)
    expect(code(res)).not.toBeUndefined()
    expect(await api.db.one('SELECT count(*)::int AS n FROM board_snapshots')).toEqual({ n: 2 })
  })
})
