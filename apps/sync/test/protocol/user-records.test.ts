// tldraw `user:` records are bound to the verified ticket (reviewer finding G-R8).
//
// tldraw 5.4.2 keeps one document-scoped `user` record per person (id, name, color, imageUrl, meta):
// it syncs to everyone, persists with the board, and is where a note's "last edited by" name and
// other attribution come from. @tldraw/sync-core never checks who writes one, so without the sync
// server's rule any editor (a name-only guest on a workshop link included) could write
// `user:<someone>` named "Chase Boyajian", or drop the "(guest)" marker from their own name.

import type { TicketRole } from '@draftroom/auth-tickets'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { createUserId, type TLRecord, type TLUser, UserRecordType } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape, noteShape } from '../harness/records.ts'
import type { SyncServer } from '../harness/server-process.ts'
import type { NetworkDiff, NodeSyncClient } from '../harness/sync-client.ts'
import { callInternal, mintTicket } from '../harness/tickets.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()
const TICKET_COLOR = '#1971c2' // what ../harness/tickets.ts mints for every user
const DAN = 'usr_danDDDDDDDDDDDDDDD' // an id the private-notes endpoint accepts as an author

/** The name each user's ticket carries (the API's ticketName: a guest's has the marker). */
const TICKET_NAMES: Record<string, string> = {
  alice: 'Alice Adams',
  bob: 'Bob Brown',
  carol: 'Carol Chen',
  vic: 'Vic (guest)',
  [DAN]: 'Dan Dawson',
}

/** A user record as tldraw builds it from a TLUserStore's currentUser (the web client's shape). */
const userRecord = (user: string, over: Partial<TLUser> = {}): TLUser =>
  UserRecordType.create({
    id: createUserId(user),
    name: TICKET_NAMES[user] ?? user,
    color: TICKET_COLOR,
    ...over,
  })

const join = (server: SyncServer, boardId: string, user: string, role: TicketRole = 'editor') =>
  h.connected(server, {
    boardId,
    user,
    role,
    ticket: () => mintTicket(boardId, user, role, { name: TICKET_NAMES[user] ?? user }),
  })

/** Every record in the board's storage right now (what a restart or a new tab would load). */
async function stored(server: SyncServer, boardId: string): Promise<Map<string, TLRecord>> {
  const res = await callInternal(server.url, 'GET', `/internal/boards/${boardId}/snapshot`)
  expect(res.status).toBe(200)
  const snap = (await res.json()) as { documents: { state: TLRecord }[] }
  return new Map(snap.documents.map((d) => [d.state.id as string, d.state]))
}

/** alice (facilitator) with her own record, bob (a viewer) watching, vic (an editor guest). */
async function board() {
  const server = await h.server()
  const boardId = newBoardId()
  const alice = await join(server, boardId, 'alice')
  alice.keepUserRecord(userRecord('alice'))
  await alice.waitForAcked()
  const bob = await join(server, boardId, 'bob', 'viewer')
  await waitFor(() => bob.get('user:alice'))
  const vic = await join(server, boardId, 'vic')
  return { server, boardId, alice, bob, vic }
}

/** alice's record is exactly hers everywhere: in bob's tab, in `writer`'s tab and in storage. */
async function expectAliceIntact(server: SyncServer, boardId: string, ...tabs: NodeSyncClient[]) {
  await sleep(200) // anything forged would have been broadcast by now
  const hers = { id: 'user:alice', typeName: 'user', name: 'Alice Adams', color: TICKET_COLOR, imageUrl: '' }
  for (const c of tabs) expect(c.get('user:alice'), c.name).toMatchObject(hers)
  expect((await stored(server, boardId)).get('user:alice')).toMatchObject(hers)
}

function expectUndisturbed(...clients: NodeSyncClient[]) {
  for (const c of clients) {
    expect(c.closes, c.name).toEqual([])
    expect(c.status, c.name).toBe('online')
  }
}

describe('tldraw user records are bound to the ticket', () => {
  it("a session's own record, with the ticket's name and color, commits, reaches everyone and persists; tldraw's re-put settles after one push", async () => {
    const { server, boardId, alice, bob, vic } = await board()
    const before = vic.sentPushes().length
    vic.keepUserRecord(userRecord('vic'))
    await vic.waitForAcked()
    expect(vic.pushResults.at(-1)?.action).toBe('commit')
    const seen = await waitFor(() => bob.get<TLUser>('user:vic'))
    expect(seen).toMatchObject({ name: 'Vic (guest)', color: TICKET_COLOR, imageUrl: '' })
    expect((await stored(server, boardId)).get('user:vic')).toMatchObject({ name: 'Vic (guest)' })
    await sleep(300)
    expect(vic.sentPushes().length - before).toBe(1) // no re-put loop
    expectUndisturbed(alice, bob, vic)
  })

  it('a session may change its own record in other ways (meta) and remove it', async () => {
    const { server, boardId, bob, vic } = await board()
    vic.store.put([userRecord('vic')])
    await vic.waitForAcked()
    vic.store.put([userRecord('vic', { meta: { pronouns: 'they/them' } })])
    await vic.waitForAcked()
    expect(vic.pushResults.at(-1)?.action).toBe('commit')
    await waitFor(() => bob.get<TLUser>('user:vic')?.meta.pronouns === 'they/them')
    vic.store.remove([createUserId('vic')])
    await vic.waitForAcked()
    expect(vic.pushResults.at(-1)?.action).toBe('commit')
    await waitFor(() => bob.get('user:vic') === undefined)
    expect((await stored(server, boardId)).has('user:vic')).toBe(false)
    expectUndisturbed(bob, vic)
  })

  const othersRecords: { name: string; send: (vic: NodeSyncClient) => number | undefined }[] = [
    {
      // what tldraw's putContentOntoCurrentPage does when a pasted note names someone not on the board
      name: 'creating a record for someone else (a paste does this)',
      send: (vic) => {
        vic.store.put([userRecord('carol', { name: 'Carol (not really)' })])
        return undefined
      },
    },
    {
      name: "overwriting alice's record with another name",
      send: (vic) => {
        vic.store.put([userRecord('alice', { name: 'Chase Boyajian' })])
        return undefined
      },
    },
    {
      name: "a hand-crafted patch renaming alice's record",
      send: (vic) => vic.sendRawPush({ 'user:alice': ['patch', { name: ['put', 'Chase Boyajian'] }] }),
    },
    {
      name: "deleting alice's record",
      send: (vic) => {
        vic.store.remove([createUserId('alice')])
        return undefined
      },
    },
  ]

  for (const w of othersRecords)
    it(`another person's record cannot be written: the op is skipped, the writer's tab self-corrects and stays connected, nobody sees it: ${w.name}`, async () => {
      const { server, boardId, alice, bob, vic } = await board()
      const clock = w.send(vic)
      if (clock === undefined) {
        await vic.waitForAcked()
        expect(vic.pushResults.at(-1)?.action).not.toBe('commit')
      } else {
        const result = await waitFor(() => vic.pushResults.find((r) => r.clientClock === clock))
        expect(result.action).toBe('discard')
      }
      await expectAliceIntact(server, boardId, bob, alice, vic)
      for (const c of [bob, vic]) expect(c.get('user:carol'), c.name).toBeUndefined()
      expect((await stored(server, boardId)).has('user:carol')).toBe(false)
      expectUndisturbed(alice, bob, vic)
    })

  const smuggled = geoShape('smuggled')
  const forgeries: {
    name: string
    honestFirst?: boolean
    send: (vic: NodeSyncClient) => void
  }[] = [
    {
      name: "its own record under alice's name (TLSyncClient put)",
      send: (vic) =>
        vic.store.put([userRecord('vic', { name: 'Alice Adams' }), smuggled as unknown as TLRecord]),
    },
    {
      name: 'its own record without the "(guest)" marker',
      send: (vic) =>
        vic.sendRawPush({
          'user:vic': ['put', userRecord('vic', { name: 'Vic' })],
          [smuggled.id]: ['put', smuggled],
        }),
    },
    {
      name: 'its own record in a color the ticket does not have',
      send: (vic) =>
        vic.sendRawPush({
          'user:vic': ['put', userRecord('vic', { color: '#ff00ff' })],
          [smuggled.id]: ['put', smuggled],
        }),
    },
    {
      name: 'its own record with an image',
      send: (vic) =>
        vic.sendRawPush({
          'user:vic': ['put', userRecord('vic', { imageUrl: 'https://example.com/alice.png' })],
          [smuggled.id]: ['put', smuggled],
        }),
    },
    {
      name: "its own record sent under alice's id",
      send: (vic) =>
        vic.sendRawPush({ 'user:alice': ['put', userRecord('vic')], [smuggled.id]: ['put', smuggled] }),
    },
    {
      name: "alice's record sent under vic's id",
      send: (vic) =>
        vic.sendRawPush({
          'user:vic': ['put', userRecord('alice', { name: 'Chase Boyajian' })],
          [smuggled.id]: ['put', smuggled],
        }),
    },
    {
      name: 'a user record under a key that is not a user id',
      send: (vic) =>
        vic.sendRawPush({ 'shape:x': ['put', userRecord('vic')], [smuggled.id]: ['put', smuggled] }),
    },
    {
      name: 'a shape sent under a user id',
      send: (vic) =>
        vic.sendRawPush({ 'user:carol': ['put', geoShape('x')], [smuggled.id]: ['put', smuggled] }),
    },
    {
      name: 'a patch renaming its own record, after an honest put',
      honestFirst: true,
      send: (vic) =>
        vic.sendRawPush({
          'user:vic': ['patch', { name: ['put', 'Alice Adams'] }],
          [smuggled.id]: ['put', smuggled],
        }),
    },
    {
      name: 'a patch appending to its own name, after an honest put',
      honestFirst: true,
      send: (vic) =>
        vic.sendRawPush({
          'user:vic': ['patch', { name: ['append', ' Adams', 'Vic (guest)'.length] }],
          [smuggled.id]: ['put', smuggled],
        }),
    },
    {
      name: "a patch switching its own record's id to alice's, after an honest put",
      honestFirst: true,
      send: (vic) =>
        vic.sendRawPush({
          'user:vic': ['patch', { id: ['put', 'user:alice'] }],
          [smuggled.id]: ['put', smuggled],
        }),
    },
    {
      name: 'a forged record split into chunked frames',
      send: (vic) =>
        vic.sendRawPush(
          {
            'user:vic': ['put', userRecord('vic', { name: 'Alice Adams' })],
            [smuggled.id]: ['put', smuggled],
          },
          { chunkSize: 64 },
        ),
    },
  ]

  for (const f of forgeries)
    it(`a forged own record closes the session with 4099 INVALID_RECORD, the whole push is refused and nobody sees it: ${f.name}`, async () => {
      const { server, boardId, alice, bob, vic } = await board()
      if (f.honestFirst) {
        vic.store.put([userRecord('vic')])
        await vic.waitForAcked()
        await waitFor(() => bob.get('user:vic'))
      }

      f.send(vic)

      const close = await vic.waitForClose()
      expect(close).toMatchObject({ code: 4099, reason: 'INVALID_RECORD' })
      expect(vic.status).toBe('error') // terminal: no reconnect loop
      await expectAliceIntact(server, boardId, bob, alice)
      const inStorage = await stored(server, boardId)
      // nothing of the push landed: not the record, not the shape that came with it
      expect(bob.get(smuggled.id)).toBeUndefined()
      expect(inStorage.has(smuggled.id)).toBe(false)
      for (const id of ['user:carol', 'shape:x']) {
        expect(bob.get(id), id).toBeUndefined()
        expect(inStorage.has(id), id).toBe(false)
      }
      const vics = f.honestFirst ? { name: 'Vic (guest)', color: TICKET_COLOR, imageUrl: '' } : undefined
      if (vics) {
        expect(bob.get('user:vic')).toMatchObject(vics)
        expect(inStorage.get('user:vic')).toMatchObject(vics)
      } else {
        expect(bob.get('user:vic')).toBeUndefined()
        expect(inStorage.has('user:vic')).toBe(false)
      }
      expectUndisturbed(alice, bob)
    })

  it('a stale client whose tldraw keeps re-writing its record under a name the ticket does not have is closed once, terminally: no push loop, no reconnect loop', async () => {
    const { server, boardId, alice, bob } = await board()
    // The web client before this rule: the account's full display name, where the ticket carries the
    // label form a long guest name is shortened to.
    const stale = await join(server, boardId, 'vic')
    stale.keepUserRecord(userRecord('vic', { name: 'Victoria Longname-Smith (guest)' }))
    const close = await stale.waitForClose()
    expect(close).toMatchObject({ code: 4099, reason: 'INVALID_RECORD' })
    await sleep(1_500) // a reconnect (100 ms in this harness) or a re-put loop would show by now
    expect(stale.status).toBe('error')
    expect(stale.connectUrls).toHaveLength(1)
    expect(stale.closes).toHaveLength(1)
    expect(stale.sentPushes()).toHaveLength(1)
    expect(bob.get('user:vic')).toBeUndefined()
    expect((await stored(server, boardId)).has('user:vic')).toBe(false)
    expectUndisturbed(alice, bob)
  })

  it('user records the server writes (a template seed, a private-notes placement) reach everyone; their owners can still update their own, nobody else can', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const seeded = await callInternal(server.url, 'POST', `/internal/boards/${boardId}/seed`, {
      body: {
        snapshot: {
          schema: draftroomSchema.serialize(),
          documents: [
            userRecord('carol', { name: 'Carol (from the template)' }),
            noteShape('carols-note', 'by carol'),
          ].map((state) => ({ state, lastChangedClock: 0 })),
        },
      },
    })
    expect(seeded.status).toBe(201)
    const bob = await join(server, boardId, 'bob', 'viewer')
    expect(bob.get('user:carol')).toMatchObject({ name: 'Carol (from the template)' })

    const placed = await callInternal(server.url, 'POST', `/internal/boards/${boardId}/place-notes`, {
      body: {
        sessionId: 'pbs_AAAAAAAAAAAAAAAAAAAA',
        anonymous: false,
        frame: {
          id: 'shape:frame1',
          pageId: 'page:page',
          x: 0,
          y: 0,
          w: 1000,
          h: 600,
          name: 'Private ideas',
        },
        notes: [{ id: 'pnt_0001AAAAAAAAAAAAAAAA', text: 'Dan one', color: 'yellow', authorId: DAN }],
        authors: [{ id: DAN, name: 'Dan (as the API knows him)', color: '#3355ff' }],
      },
    })
    expect(placed.status).toBe(200)
    await waitFor(() => bob.get(`user:${DAN}`))
    expect(bob.get(`user:${DAN}`)).toMatchObject({ name: 'Dan (as the API knows him)', color: '#3355ff' })
    expect(bob.get(`shape:pnt_0001AAAAAAAAAAAAAAAA`)).toMatchObject({ props: { textLastEditedBy: DAN } })

    // Their owners' tabs put their own current record over the server's: allowed.
    const carol = await join(server, boardId, 'carol')
    carol.keepUserRecord(userRecord('carol'))
    const dan = await join(server, boardId, DAN)
    dan.keepUserRecord(userRecord(DAN))
    await carol.waitForAcked()
    await dan.waitForAcked()
    expect(carol.pushResults.at(-1)?.action).toBe('commit')
    expect(dan.pushResults.at(-1)?.action).toBe('commit')
    await waitFor(() => bob.get<TLUser>('user:carol')?.name === 'Carol Chen')
    await waitFor(() => bob.get<TLUser>(`user:${DAN}`)?.name === 'Dan Dawson')

    // Anybody else's write to them is skipped.
    const vic = await join(server, boardId, 'vic')
    const clock = vic.sendRawPush({
      'user:carol': ['patch', { name: ['put', 'Chase Boyajian'] }],
      [`user:${DAN}`]: ['remove'],
    } as NetworkDiff)
    expect((await waitFor(() => vic.pushResults.find((r) => r.clientClock === clock))).action).toBe('discard')
    await sleep(200)
    expect(bob.get('user:carol')).toMatchObject({ name: 'Carol Chen' })
    expect(bob.get(`user:${DAN}`)).toMatchObject({ name: 'Dan Dawson' })
    const inStorage = await stored(server, boardId)
    expect(inStorage.get('user:carol')).toMatchObject({ name: 'Carol Chen' })
    expect(inStorage.get(`user:${DAN}`)).toMatchObject({ name: 'Dan Dawson' })
    expectUndisturbed(bob, carol, dan, vic)
  })
})
