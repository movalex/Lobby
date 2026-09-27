// Concurrent edits of one shape. "Concurrent" is forced deterministically: both clients make their
// change while their outgoing frames are held (so each push is built without seeing the other), then
// the pushes are released one at a time to fix the order in which the server processes them.
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import type { NodeSyncClient } from '../harness/sync-client.ts'
import { waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()
const X = 'shape:x'

async function twoClientsWithShape() {
  const server = await h.server()
  const boardId = newBoardId()
  const a = await h.connected(server, { boardId, user: 'alice' })
  const b = await h.connected(server, { boardId, user: 'bob' })
  a.put(geoShape('x', { x: 0, color: 'black' }))
  await a.waitForAcked()
  await waitFor(() => b.get(X))
  return { server, boardId, a, b }
}

/** Releases `first`'s held push and waits for its ack, then does the same for `second`. */
async function processInOrder(first: NodeSyncClient, second: NodeSyncClient) {
  first.releaseOutgoing()
  await first.waitForAcked()
  second.releaseOutgoing()
  await second.waitForAcked()
}

const moveX = (c: NodeSyncClient, x: number) => c.update(X, (r) => ({ ...r, x }))
const recolorX = (c: NodeSyncClient, color: string) =>
  c.update(X, (r) => ({ ...r, props: { ...r.props, color } }))

describe('concurrent edits of one record', () => {
  for (const order of ['alice-then-bob', 'bob-then-alice'] as const) {
    it(`DOCUMENTED LIMITATION: same prop, crossing pushes: the one the server processes last wins, both get commit (${order})`, async () => {
      const { server, boardId, a, b } = await twoClientsWithShape()
      a.holdOutgoing()
      b.holdOutgoing()
      moveX(a, 100)
      moveX(b, 200)
      const [first, second] = order === 'alice-then-bob' ? [a, b] : [b, a]
      await processInOrder(first, second)
      const winner = second === a ? 100 : 200
      await waitFor(() => first.get(X)?.x === winner)
      expect(a.get(X)?.x).toBe(winner)
      expect(b.get(X)?.x).toBe(winner)
      expect((await h.freshView(server, boardId)).get(X)?.x).toBe(winner)
      // no conflict signal: the loser's push was also a plain commit
      expect([a.pushResults.at(-1)?.action, b.pushResults.at(-1)?.action]).toEqual(['commit', 'commit'])
    })
  }

  it('different props of one record, crossing pushes: both changes are kept everywhere', async () => {
    const { server, boardId, a, b } = await twoClientsWithShape()
    a.holdOutgoing()
    b.holdOutgoing()
    moveX(a, 111)
    recolorX(b, 'green')
    await processInOrder(a, b)
    await waitFor(() => a.get(X)?.props.color === 'green')
    for (const view of [a, b]) expect(view.get(X)).toMatchObject({ x: 111, props: { color: 'green' } })
    expect((await h.freshView(server, boardId)).get(X)).toMatchObject({ x: 111, props: { color: 'green' } })
  })
})

describe('edit vs delete', () => {
  it('an edit the server processes after a delete is discarded: the editor reverts and the shape stays deleted', async () => {
    const { server, boardId, a, b } = await twoClientsWithShape()
    b.holdOutgoing()
    moveX(b, 999) // B's edit is in flight...
    a.remove(X) // ...while A's delete reaches the server first
    await a.waitForAcked()
    await waitFor(() => !b.get(X)) // B applies the remove even with its own edit pending
    const editClock = b.lastPushClock()
    b.releaseOutgoing()
    await b.waitForAcked()
    expect(b.pushResults.find((r) => r.clientClock === editClock)?.action).toBe('discard')
    expect(b.get(X)).toBeUndefined()
    expect(a.get(X)).toBeUndefined()
    expect((await h.freshView(server, boardId)).has(X)).toBe(false)
  })

  it('a delete the server processes after an edit still wins: the shape is gone and the edit in flight behind it is discarded', async () => {
    const { server, boardId, a, b } = await twoClientsWithShape()
    a.holdOutgoing()
    a.remove(X) // A's delete is in flight...
    moveX(b, 999) // ...while B's first edit reaches the server first
    await b.waitForAcked()
    expect(b.pushResults.at(-1)?.action).toBe('commit')
    b.holdOutgoing()
    moveX(b, 1000) // B keeps dragging; this push is built before B knows about the delete
    const secondEdit = b.lastPushClock()
    a.releaseOutgoing()
    await a.waitForAcked()
    expect(a.pushResults.at(-1)?.action).toBe('commit')
    await waitFor(() => !b.get(X))
    b.releaseOutgoing()
    await b.waitForAcked()
    expect(b.pushResults.find((r) => r.clientClock === secondEdit)?.action).toBe('discard')
    expect(b.get(X)).toBeUndefined()
    expect((await h.freshView(server, boardId)).has(X)).toBe(false)
  })
})
