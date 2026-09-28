// Presence is bound to the verified ticket (docs/SECURITY-REVIEW-2026-09-27.md, authz-004 / SYNC-01).
// @tldraw/sync-core 5.4.2 never authorizes presence: its presence lane forces only `id` and
// `typeName`, and it runs for read-only sessions too. Without the sync server's guard, any board
// participant (a review-link viewer included) could publish a cursor under the facilitator's userId,
// name and color with a far-future timestamp, which every other tab then prefers over hers.
import {
  createUserId,
  InstancePresenceRecordType,
  PageRecordType,
  type TLInstancePresence,
} from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import type { NodeSyncClient } from '../harness/sync-client.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()
const TICKET_COLOR = '#1971c2' // what ../harness/tickets.ts mints for every user
const YEAR_MS = 365 * 24 * 3600_000

/** The presences `observer` holds for `user` (one per session of theirs). */
const presencesOf = (observer: NodeSyncClient, user: string) =>
  observer.presences().filter((p) => p.userId === createUserId(user))

/** A complete presence record, as a hand-crafted client would put it on the wire. */
function presenceRecord(user: string, extra: Partial<TLInstancePresence> = {}): TLInstancePresence {
  return InstancePresenceRecordType.create({
    id: InstancePresenceRecordType.createId('forged'),
    currentPageId: PageRecordType.createId('page'),
    userId: createUserId(user),
    userName: user,
    color: TICKET_COLOR,
    lastActivityTimestamp: Date.now(),
    cursor: { x: 0, y: 0, type: 'default', rotation: 0 },
    ...extra,
  })
}

/** Board with the victim (alice, facilitator) and an observer (bob), both with live presence. */
async function board() {
  const server = await h.server()
  const boardId = newBoardId()
  const alice = await h.connected(server, { boardId, user: 'alice' })
  const bob = await h.connected(server, { boardId, user: 'bob' })
  const aliceActivity = Date.now()
  alice.setPresence({
    lastActivityTimestamp: aliceActivity,
    cursor: { x: 1, y: 2, type: 'default', rotation: 0 },
  })
  bob.setPresence()
  await waitFor(() => presencesOf(bob, 'alice').length === 1)
  await waitFor(() => presencesOf(alice, 'bob').length === 1)
  return { server, boardId, alice, bob, aliceActivity }
}

/** bob still sees exactly one alice: her own presence, untouched. */
async function expectAliceIntact(bob: NodeSyncClient, aliceActivity: number) {
  await sleep(200) // anything forged would have been broadcast by now
  const seen = presencesOf(bob, 'alice')
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    userName: 'alice',
    lastActivityTimestamp: aliceActivity,
    cursor: { x: 1, y: 2 },
  })
}

describe('presence identity is bound to the ticket', () => {
  const forgeries: {
    name: string
    user?: string
    honestFirst?: boolean
    send: (c: NodeSyncClient) => void
  }[] = [
    {
      name: "TLSyncClient pushing another user's id (a client that edits its own presence)",
      send: (c) =>
        c.setPresence({
          userId: createUserId('alice'),
          userName: 'alice',
          lastActivityTimestamp: Date.now() + YEAR_MS,
        }),
    },
    {
      name: "a hand-crafted put with another user's id, name and a far-future timestamp",
      send: (c) =>
        c.sendRawPresence(['put', presenceRecord('alice', { lastActivityTimestamp: Date.now() + YEAR_MS })]),
    },
    {
      name: 'the same put split into chunked frames',
      send: (c) =>
        c.sendRawPresence(['put', presenceRecord('alice', { lastActivityTimestamp: Date.now() + YEAR_MS })], {
          chunkSize: 64,
        }),
    },
    {
      name: 'a patch that switches the userId after an honest put',
      honestFirst: true,
      send: (c) => c.sendRawPresence(['patch', { userId: ['put', createUserId('alice')] }]),
    },
    {
      name: "a patch that appends to the userId ('user:ali' + 'ce' = 'user:alice')",
      user: 'ali',
      honestFirst: true,
      send: (c) => c.sendRawPresence(['patch', { userId: ['append', 'ce', 'user:ali'.length] }]),
    },
  ]

  for (const f of forgeries)
    it(`a viewer forging another user's presence is closed with 4099 INVALID_RECORD and nobody sees it: ${f.name}`, async () => {
      const { server, boardId, alice, bob, aliceActivity } = await board()
      const user = f.user ?? 'vic'
      const viewer = await h.connected(server, { boardId, user, role: 'viewer' })
      if (f.honestFirst) {
        viewer.setPresence()
        await waitFor(() => presencesOf(bob, user).length === 1)
      }

      f.send(viewer)

      const close = await viewer.waitForClose()
      expect(close).toMatchObject({ code: 4099, reason: 'INVALID_RECORD' })
      expect(viewer.status).toBe('error') // terminal: no reconnect loop
      await expectAliceIntact(bob, aliceActivity)
      // the forger's presence is gone with its session; the others were never disturbed
      await waitFor(() => presencesOf(bob, user).length === 0)
      for (const c of [alice, bob]) {
        expect(c.closes, c.name).toEqual([])
        expect(c.status, c.name).toBe('online')
      }
    })

  it("a forged display name, color, chat and far-future timestamp are replaced by the ticket's and the server's (put and patch)", async () => {
    const { server, boardId, bob, aliceActivity } = await board()
    const viewer = await h.connected(server, { boardId, user: 'vic', role: 'viewer' })

    const beforePut = Date.now()
    viewer.setPresence({
      userName: 'alice',
      color: '#ff00ff',
      lastActivityTimestamp: Date.now() + YEAR_MS,
      chatMessage: 'x'.repeat(10_000),
    })
    const put = await waitFor(() => presencesOf(bob, 'vic')[0])
    expect(put).toMatchObject({ userName: 'vic', color: TICKET_COLOR })
    expect(put.lastActivityTimestamp).toBeGreaterThanOrEqual(beforePut)
    expect(put.lastActivityTimestamp).toBeLessThanOrEqual(Date.now())
    expect(put.chatMessage).toBe('x'.repeat(500))

    // patches: replaced, clamped, capped; a harmless change in the same patch still applies
    viewer.sendRawPresence([
      'patch',
      {
        userName: ['put', 'alice'],
        color: ['append', 'ff', TICKET_COLOR.length],
        lastActivityTimestamp: ['put', Date.now() + YEAR_MS],
        chatMessage: ['append', 'y'.repeat(100), 500],
        cursor: ['put', { x: 42, y: 0, type: 'default', rotation: 0 }],
      },
    ])
    const patched = await waitFor(() => presencesOf(bob, 'vic').find((p) => p.cursor?.x === 42))
    expect(patched).toMatchObject({ userName: 'vic', color: TICKET_COLOR, chatMessage: 'x'.repeat(500) })
    expect(patched.lastActivityTimestamp).toBeLessThanOrEqual(Date.now())

    // a chat typed from scratch is cut at the cap too
    viewer.sendRawPresence(['patch', { chatMessage: ['put', 'hello'] }])
    await waitFor(() => presencesOf(bob, 'vic').find((p) => p.chatMessage === 'hello'))
    viewer.sendRawPresence(['patch', { chatMessage: ['append', 'z'.repeat(1_000), 5] }])
    await waitFor(() => presencesOf(bob, 'vic').find((p) => p.chatMessage === `hello${'z'.repeat(495)}`))

    expect(viewer.closes).toEqual([])
    expect(viewer.status).toBe('online')
    await expectAliceIntact(bob, aliceActivity)
  })

  it('a normal client’s presence passes through unchanged: cursor, selection, camera, follow and the editingShapeId meta', async () => {
    const { alice, bob } = await board()
    const X = geoShape('x')
    alice.put(X)
    await alice.waitForAcked()

    const t1 = Date.now() - 1_000
    alice.setPresence({
      color: TICKET_COLOR, // the web client sends the account's color, which the ticket carries
      lastActivityTimestamp: t1,
      cursor: { x: 10, y: 20, type: 'default', rotation: 0 },
      selectedShapeIds: [X.id],
      camera: { x: -5, y: 7, z: 1.5 },
      followingUserId: createUserId('bob'),
      chatMessage: 'hi',
      meta: { editingShapeId: X.id },
    })
    await waitFor(() => presencesOf(bob, 'alice').find((p) => p.cursor?.x === 10))
    expect(presencesOf(bob, 'alice')).toEqual([
      expect.objectContaining({
        userId: createUserId('alice'),
        userName: 'alice',
        color: TICKET_COLOR,
        lastActivityTimestamp: t1,
        cursor: { x: 10, y: 20, type: 'default', rotation: 0 },
        selectedShapeIds: [X.id],
        camera: { x: -5, y: 7, z: 1.5 },
        followingUserId: createUserId('bob'),
        chatMessage: 'hi',
        meta: { editingShapeId: X.id },
      }),
    ])

    // TLSyncClient sends the next change as a patch
    const t2 = Date.now()
    alice.setPresence({
      color: TICKET_COLOR,
      lastActivityTimestamp: t2,
      cursor: { x: 30, y: 20, type: 'default', rotation: 0 },
      selectedShapeIds: [],
      chatMessage: 'hi there',
      meta: { editingShapeId: null },
    })
    await waitFor(() => presencesOf(bob, 'alice').find((p) => p.cursor?.x === 30))
    expect(presencesOf(bob, 'alice')[0]).toMatchObject({
      lastActivityTimestamp: t2,
      selectedShapeIds: [],
      chatMessage: 'hi there',
      meta: { editingShapeId: null },
    })
    expect(alice.sentPushes().some((p) => Array.isArray(p.presence) && p.presence[0] === 'patch')).toBe(true)

    // document edits keep flowing next to presence
    alice.update(X.id, (s) => ({ ...s, x: 99 }))
    await alice.waitForAcked()
    expect(alice.pushResults.at(-1)?.action).toBe('commit')
    await waitFor(() => bob.get(X.id)?.x === 99)
    for (const c of [alice, bob]) {
      expect(c.closes, c.name).toEqual([])
      expect(c.syncErrors, c.name).toEqual([])
    }
  })

  it('a chunked push (a large paste with presence) is reassembled: the document change commits and the presence is bound', async () => {
    const { alice, bob } = await board()
    const big = geoShape('big', { text: 'long text '.repeat(400) })
    const record = presenceRecord('alice', {
      userName: 'Not Alice',
      color: '#000000',
      cursor: { x: 77, y: 0, type: 'default', rotation: 0 },
    })
    const clock = alice.sendRawPresence(['put', record], { diff: { [big.id]: ['put', big] }, chunkSize: 512 })
    await waitFor(() => alice.pushResults.find((r) => r.clientClock === clock))
    expect(alice.pushResults.find((r) => r.clientClock === clock)?.action).toBe('commit')
    await waitFor(() => bob.get(big.id))
    const seen = await waitFor(() => presencesOf(bob, 'alice').find((p) => p.cursor?.x === 77))
    expect(seen).toMatchObject({ userName: 'alice', color: TICKET_COLOR })
    expect(presencesOf(bob, 'alice')).toHaveLength(1)
    expect(alice.closes).toEqual([])
  })
})
