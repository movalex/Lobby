// REVIEW-6: when an owner changes or removes someone's board access, that person's own event stream
// (and nobody else's) hears who did it, so the "your access changed" toast can say whom to ask.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventHub } from '../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from './helpers.ts'
import { listen, openSse, type SseStream, until } from './sse.ts'

let api: TestApi
let base: string
let bob: Client
let carol: Client
let alice: Client
let boardId: string
let hub: EventHub
const streams: SseStream[] = []

beforeEach(async () => {
  hub = new EventHub()
  api = await createTestApi({ deps: { events: hub } })
  base = await listen(api)
  alice = await api.login('alice', 'Alice Admin')
  bob = await api.login('bob', 'Bob Owner')
  carol = await api.login('carol', 'Carol Reviewer')
  boardId = await createBoard(bob, DEV_STUDIO, 'Campaign review')
  await bob.req('PATCH', `/api/boards/${boardId}`, { visibility: 'workspace_edit' })
})
afterEach(async () => {
  await Promise.all(streams.splice(0).map((s) => s.close()))
  await api.close()
})

async function open(c: Client): Promise<SseStream> {
  const s = await openSse(base, boardId, c.cookie)
  streams.push(s)
  await s.waitFor('hello')
  return s
}
const actorEvents = (s: SseStream) => s.events.filter((e) => e.type === 'access.changed')

describe('access.changed carries the actor (REVIEW-6)', () => {
  it('tells the affected person, and only them, who lowered their access', async () => {
    const mine = await open(carol)
    const owner = await open(alice)
    const res = await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'viewer' })
    expect(res.statusCode, res.body).toBe(200)
    await mine.waitFor('access.changed')
    expect(actorEvents(mine).map((e) => e.data)).toEqual([{ actor: { name: 'Bob Owner' } }])
    // a bystander on the same board only gets the identity-free sharing hint
    await owner.waitFor('sharing.changed')
    expect(actorEvents(owner)).toEqual([])
    // the actor's id and the target's id never go on the wire
    expect(JSON.stringify(mine.events)).not.toContain(bob.userId)
  })

  it('names the person who removed a grant', async () => {
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'editor' })
    const mine = await open(carol)
    const res = await bob.req('DELETE', `/api/boards/${boardId}/members/${carol.userId}`)
    expect(res.statusCode, res.body).toBeLessThan(300)
    await mine.waitFor('access.changed')
    expect(actorEvents(mine).map((e) => e.data)).toEqual([{ actor: { name: 'Bob Owner' } }])
  })

  it('takes the actor from the session, not from the request', async () => {
    const mine = await open(carol)
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, {
      role: 'commenter',
      actor: 'Mallory',
      name: 'Mallory',
    })
    await mine.waitFor('access.changed')
    expect(JSON.stringify(actorEvents(mine))).toContain('Bob Owner')
    expect(JSON.stringify(mine.events)).not.toContain('Mallory')
  })

  it('says nothing when the change was refused, or when people change their own access', async () => {
    const mine = await open(carol)
    const owner = await open(bob)
    // carol cannot manage access: refused, nothing published
    const refused = await carol.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, {
      role: 'owner',
    })
    expect(refused.statusCode).toBeGreaterThanOrEqual(400)
    // bob changes his own role (he stays the only owner, so give himself the same role): no actor for him
    const self = await bob.req('PUT', `/api/boards/${boardId}/members/${bob.userId}`, { role: 'owner' })
    expect(self.statusCode, self.body).toBe(200)
    await until(() => owner.events.some((e) => e.type === 'sharing.changed'), 3_000, 'the sharing hint')
    expect(actorEvents(mine)).toEqual([])
    expect(actorEvents(owner)).toEqual([])
  })
})

describe('access.changed only for a change that changed something (REVIEW-6)', () => {
  let fences = 0
  /** An event published now reaches the stream after everything published before it. */
  async function fence(...ss: SseStream[]): Promise<void> {
    const type = `fence.${++fences}`
    hub.publish(boardId, { type, data: {} })
    await Promise.all(ss.map((s) => s.waitFor(type)))
  }

  it('a grant set to the role it already is, or removed when there is none, names nobody', async () => {
    const mine = await open(carol)
    // carol has no direct grant (the board is open to the workspace): removing it changes nothing
    const none = await bob.req('DELETE', `/api/boards/${boardId}/members/${carol.userId}`)
    expect(none.statusCode, none.body).toBe(200)
    await fence(mine)
    expect(actorEvents(mine)).toEqual([])

    // a real change is named, once; the same PUT again changes nothing and names nobody again
    const put = () => bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'viewer' })
    expect((await put()).statusCode).toBe(200)
    await mine.waitFor('access.changed')
    expect((await put()).statusCode).toBe(200)
    await fence(mine)
    expect(actorEvents(mine).map((e) => e.data)).toEqual([{ actor: { name: 'Bob Owner' } }])

    // removing the grant is a real change (named); removing it a second time is not
    const del = () => bob.req('DELETE', `/api/boards/${boardId}/members/${carol.userId}`)
    expect((await del()).statusCode).toBe(200)
    await until(() => actorEvents(mine).length === 2, 3_000, 'the removal named')
    expect((await del()).statusCode).toBe(200)
    await fence(mine)
    expect(actorEvents(mine)).toHaveLength(2)
  })

  it('tells the sync server of the same change without the name (docs/M1-CONTRACTS.md §7)', async () => {
    const mine = await open(carol)
    api.notifications.length = 0
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'commenter' })
    await mine.waitFor('access.changed')
    expect(api.notifications).toEqual([{ boardId, userId: carol.userId }])
  })
})

describe('EventHub.accessChangedBy', () => {
  it('delivers to the affected person only, and never to oneself or with an empty name', () => {
    const hub = new EventHub()
    const got: Record<string, string[]> = { a: [], b: [] }
    for (const id of ['a', 'b'])
      hub.openStream('b-board00001', {
        userId: id,
        sessionId: `s-${id}`,
        deliver: (e) => got[id]?.push(e.type),
        end: () => {},
      })
    hub.accessChangedBy({ boardId: 'b-board00001', userId: 'a' }, { id: 'b', name: 'Bea' })
    expect(got).toEqual({ a: ['access.changed'], b: [] })
    hub.accessChangedBy({ boardId: 'b-board00001', userId: 'a' }, { id: 'a', name: 'Self' })
    hub.accessChangedBy({ boardId: 'b-board00001', userId: 'a' }, { id: 'b', name: '   ' })
    expect(got.a).toEqual(['access.changed'])
  })

  it('a change of the whole board (no person) goes to every stream but the actor’s own', () => {
    const hub = new EventHub()
    const got: Record<string, string[]> = { a: [], b: [], c: [] }
    for (const id of ['a', 'b', 'c'])
      hub.openStream('b-board00001', {
        userId: id,
        sessionId: `s-${id}`,
        deliver: (e) => got[id]?.push(e.type),
        end: () => {},
      })
    hub.accessChangedBy({ boardId: 'b-board00001' }, { id: 'b', name: 'Bea' })
    expect(got).toEqual({ a: ['access.changed'], b: [], c: ['access.changed'] })
  })

  it('accessChanged with an actor names it to the affected person; without one it says nothing', () => {
    const hub = new EventHub()
    const got: Record<string, string[]> = { a: [], b: [] }
    for (const id of ['a', 'b'])
      hub.openStream('b-board00001', {
        userId: id,
        sessionId: `s-${id}`,
        deliver: (e) => got[id]?.push(e.type),
        end: () => {},
      })
    hub.accessChanged({ boardId: 'b-board00001', userId: 'a' })
    expect(got).toEqual({ a: [], b: [] })
    hub.accessChanged({ boardId: 'b-board00001', userId: 'a', actor: { id: 'b', name: 'Bea' } })
    expect(got).toEqual({ a: ['access.changed'], b: [] })
    // the person's own change names nobody
    hub.accessChanged({ boardId: 'b-board00001', userId: 'a', actor: { id: 'a', name: 'Self' } })
    expect(got.a).toEqual(['access.changed'])
  })

  it('caps the name it puts on the wire', () => {
    const hub = new EventHub()
    const seen: unknown[] = []
    hub.openStream('b-board00001', {
      userId: 'a',
      sessionId: 's-a',
      deliver: (e) => seen.push(e.data),
      end: () => {},
    })
    hub.accessChangedBy({ boardId: 'b-board00001', userId: 'a' }, { id: 'b', name: `${'x'.repeat(200)}` })
    expect((seen[0] as { actor: { name: string } }).actor.name).toHaveLength(80)
  })
})
