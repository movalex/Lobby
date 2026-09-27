// Gate: "reconnect does not restore an old board". An offline client reconnects with its
// lastServerClock, receives only what changed since, and re-pushes only the fields it changed.
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape, type ShapeRecord } from '../harness/records.ts'
import { waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()

const X = 'shape:x'
const Y = 'shape:y'
const Z = 'shape:z'

const color = (s: ShapeRecord | undefined) => s?.props.color

describe('reconnect after a network interruption', () => {
  it("merges per field: the returning client gets the peer's edits, its own land, and its stale copies never overwrite", async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const a = await h.connected(server, { boardId, user: 'alice' })
    const b = await h.connected(server, { boardId, user: 'bob' })
    a.put(geoShape('x', { x: 0, color: 'black' }), geoShape('y', { x: 0 }), geoShape('z', { x: 0 }))
    await a.waitForAcked()
    await waitFor(() => b.get(Z))

    const clockWhenOffline = a.observedServerClock()
    a.goOffline()

    // B, online: moves X and recolors Y.
    b.update(X, (r) => ({ ...r, x: 500 }))
    b.update(Y, (r) => ({ ...r, props: { ...r.props, color: 'red' } }))
    await b.waitForAcked()

    // A, offline: edits only Z, and a field of X that B did not touch. A still holds x=0 / black for X and Y.
    a.update(Z, (r) => ({ ...r, x: 300 }))
    a.update(X, (r) => ({ ...r, props: { ...r.props, color: 'blue' } }))
    expect(a.get(X)?.x).toBe(0) // A's stale copy of B's field

    const pushesBefore = a.sentPushes().length
    a.goOnline()
    await a.waitForAcked()
    await waitFor(() => b.get(Z)?.x === 300 && color(b.get(X)) === 'blue')

    // The reconnect is incremental: A asked for changes since its clock and got only B's two records.
    const reconnect = a.sent.filter((m) => m.type === 'connect').at(-1)
    expect(reconnect).toMatchObject({ lastServerClock: clockWhenOffline })
    const served = a.connectEvents().at(-1)
    expect(served?.hydrationType).toBe('wipe_presence')
    expect(Object.keys(served?.diff ?? {}).sort()).toEqual([X, Y])

    // A re-pushed exactly the two fields it changed: no snapshot, no x for X, nothing for Y.
    const replayed = a.sentPushes().slice(pushesBefore)
    expect(replayed.map((p) => p.diff)).toEqual([
      {
        [Z]: ['patch', { x: ['put', 300] }],
        [X]: ['patch', { props: ['patch', { color: ['put', 'blue'] }] }],
      },
    ])

    for (const view of [a, b]) {
      expect(view.get(X)).toMatchObject({ x: 500, props: { color: 'blue' } })
      expect(color(view.get(Y))).toBe('red')
      expect(view.get(Z)?.x).toBe(300)
    }
    const fresh = await h.freshView(server, boardId)
    expect(fresh.get(X)).toMatchObject({ x: 500, props: { color: 'blue' } })
    expect(color(fresh.get(Y))).toBe('red')
    expect(fresh.get(Z)?.x).toBe(300)
    expect([...a.syncErrors, ...b.syncErrors]).toEqual([])
  })

  it('DOCUMENTED LIMITATION: a field both sides changed while one was offline ends with the value re-pushed last (the offline one)', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const a = await h.connected(server, { boardId, user: 'alice' })
    const b = await h.connected(server, { boardId, user: 'bob' })
    a.put(geoShape('x', { color: 'black' }))
    await a.waitForAcked()
    await waitFor(() => b.get(X))

    a.goOffline()
    b.update(X, (r) => ({ ...r, props: { ...r.props, color: 'red' } }))
    await b.waitForAcked()
    a.update(X, (r) => ({ ...r, props: { ...r.props, color: 'blue' } }))
    a.goOnline()
    await a.waitForAcked()
    await waitFor(() => color(b.get(X)) === 'blue')
    expect(color((await h.freshView(server, boardId)).get(X))).toBe('blue') // B's newer red is gone
  })
})
