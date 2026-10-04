// REVIEW-6 (wave E3), the api half: every change of someone's board access that really changed something
// tells the affected person's own event stream (and nobody else's) who made it, from the authenticated
// session, so the web's "your access changed" toast names the right person. One test per flow: an access
// request approved, a review link revoked, the board's visibility, a workspace role, a transfer of
// ownership (the member routes and the email invite are in events-access-actor.test.ts and
// features/dashboard/email-invites.test.ts). A change that changed nothing sends nothing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHttpSyncNotifier, createRecordingNotifier, fanOutAccessChanges } from '../src/notifier.ts'
import { setupWorld, type World } from './features/dashboard/setup.ts'
import { DEV_STUDIO } from './helpers.ts'
import { listen, openSse, type SseStream, until } from './sse.ts'

let w: World
let base: string
const streams: SseStream[] = []

beforeEach(async () => {
  w = await setupWorld()
  base = await listen(w.api)
  // everyone in Dev Studio can view bob's board (so carol, a member, is a viewer who may ask for more)
  const res = await w.bob.req('PATCH', `/api/boards/${w.board}`, { visibility: 'workspace_view' })
  expect(res.statusCode, res.body).toBe(200)
})
afterEach(async () => {
  await Promise.all(streams.splice(0).map((s) => s.close()))
  await w.api.close()
})

async function open(c: { cookie: string }): Promise<SseStream> {
  const s = await openSse(base, w.board, c.cookie)
  streams.push(s)
  await s.waitFor('hello')
  return s
}
const named = (s: SseStream) => s.events.filter((e) => e.type === 'access.changed').map((e) => e.data)

let fences = 0
/** An event published now reaches these streams after everything published before it (they keep order). */
async function fence(...ss: SseStream[]): Promise<void> {
  const type = `fence.${++fences}`
  w.events.publish(w.board, { type, data: {} })
  await Promise.all(ss.map((s) => s.waitFor(type)))
}

describe('an access request approved', () => {
  it('names the approver to the person approved, and to nobody else', async () => {
    const { bob, carol, alice, board } = w
    const mine = await open(carol)
    const owner = await open(alice)
    expect(
      (await carol.req('POST', `/api/boards/${board}/access-requests`, { role: 'editor' })).statusCode,
    ).toBe(202)
    const listed = await bob.req('GET', `/api/boards/${board}/access-requests`)
    const [pending] = (listed.json() as { requests: { id: string }[] }).requests
    const approved = await bob.req('POST', `/api/access-requests/${pending?.id}/approve`)
    expect(approved.statusCode, approved.body).toBe(200)
    await mine.waitFor('access.changed')
    expect(named(mine)).toEqual([{ actor: { name: 'bob' } }])
    await fence(mine, owner)
    expect(named(owner)).toEqual([]) // a bystander gets the identity-free sharing hint only
    expect(JSON.stringify(mine.events)).not.toContain(bob.userId)
  })

  it('a request that is denied changes nothing, so it names nobody', async () => {
    const { bob, carol, board } = w
    const mine = await open(carol)
    await carol.req('POST', `/api/boards/${board}/access-requests`, { role: 'editor' })
    const listed = await bob.req('GET', `/api/boards/${board}/access-requests`)
    const [pending] = (listed.json() as { requests: { id: string }[] }).requests
    expect((await bob.req('POST', `/api/access-requests/${pending?.id}/deny`)).statusCode).toBe(200)
    await fence(mine)
    expect(named(mine)).toEqual([])
  })
})

describe('a review link revoked', () => {
  it('names whoever revoked it to the person whose access the link gave, once', async () => {
    const { bob, carol, alice, board } = w
    const link = await bob.req('POST', `/api/boards/${board}/review-links`, {})
    expect(link.statusCode, link.body).toBe(201)
    const { id, url } = link.json() as { id: string; url: string }
    // carol (a viewer through the workspace) joins as a commenter through the link
    const joined = await carol.req('POST', `/api/invitations/${url.slice(url.lastIndexOf('/') + 1)}/accept`)
    expect(joined.statusCode, joined.body).toBe(200)
    const mine = await open(carol)
    const owner = await open(alice)
    await fence(mine) // her join named nobody (it is her own act)
    expect(named(mine)).toEqual([])

    const revoked = await bob.req('POST', `/api/boards/${board}/review-links/${id}/revoke`)
    expect(revoked.json()).toEqual({ removed: 1 })
    await mine.waitFor('access.changed') // back to a viewer: the stream stays, the toast can name him
    expect(named(mine)).toEqual([{ actor: { name: 'bob' } }])
    // revoking it again removes nobody, so it names nobody again
    const again = await bob.req('POST', `/api/boards/${board}/review-links/${id}/revoke`)
    expect(again.json()).toEqual({ removed: 0 })
    await fence(mine, owner)
    expect(named(mine)).toHaveLength(1)
    expect(named(owner)).toEqual([])
  })

  it('a link revoked while keeping the access names nobody', async () => {
    const { bob, carol, board } = w
    const link = await bob.req('POST', `/api/boards/${board}/review-links`, {})
    const { id, url } = link.json() as { id: string; url: string }
    await carol.req('POST', `/api/invitations/${url.slice(url.lastIndexOf('/') + 1)}/accept`)
    const mine = await open(carol)
    const res = await bob.req('POST', `/api/boards/${board}/review-links/${id}/revoke`, {
      removeAccess: false,
    })
    expect(res.json()).toEqual({ removed: 0 })
    await fence(mine)
    expect(named(mine)).toEqual([])
  })
})

describe('the board’s visibility changed', () => {
  it('names the owner to everyone on the board but the owner, and only when the visibility moved', async () => {
    const { bob, carol, alice, board } = w
    const mine = await open(carol)
    const admin = await open(alice)
    const owner = await open(bob)

    const to = (visibility: string) => bob.req('PATCH', `/api/boards/${board}`, { visibility })
    expect((await to('workspace_edit')).statusCode).toBe(200)
    await mine.waitFor('access.changed')
    await admin.waitFor('access.changed')
    expect(named(mine)).toEqual([{ actor: { name: 'bob' } }])
    expect(named(admin)).toEqual([{ actor: { name: 'bob' } }])
    await fence(owner)
    expect(named(owner)).toEqual([]) // the person who did it is not told who did it

    // the same visibility again, and a rename: nothing moved, nothing is named
    expect((await to('workspace_edit')).statusCode).toBe(200)
    expect((await bob.req('PATCH', `/api/boards/${board}`, { title: 'Renamed' })).statusCode).toBe(200)
    await fence(mine, admin, owner)
    expect(named(mine)).toHaveLength(1)
    expect(named(admin)).toHaveLength(1)
  })

  it('a stranger’s refused change names nobody', async () => {
    const { carol, board } = w
    const mine = await open(carol)
    const refused = await carol.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_edit' })
    expect(refused.statusCode).toBeGreaterThanOrEqual(400)
    await fence(mine)
    expect(named(mine)).toEqual([])
  })
})

describe('a workspace role changed', () => {
  it('names whoever changed it to the person whose role on the board moved, and only then', async () => {
    const { alice, carol } = w
    const mine = await open(carol)
    const url = `/api/workspaces/${DEV_STUDIO}/members/${carol.userId}`

    // member -> admin: a viewer becomes an owner of the board
    expect((await alice.req('PATCH', url, { role: 'admin' })).statusCode).toBe(200)
    await mine.waitFor('access.changed')
    expect(named(mine)).toEqual([{ actor: { name: 'alice' } }])
    // admin -> admin: nothing moves, so nothing is told
    expect((await alice.req('PATCH', url, { role: 'admin' })).statusCode).toBe(200)
    await fence(mine)
    expect(named(mine)).toHaveLength(1)
    // a demotion names the actor again
    expect((await alice.req('PATCH', url, { role: 'member' })).statusCode).toBe(200)
    await until(() => named(mine).length === 2, 3_000, 'the second name')
    expect(named(mine)).toEqual([{ actor: { name: 'alice' } }, { actor: { name: 'alice' } }])
  })
})

describe('ownership transferred', () => {
  it('names the previous owner to the new one; the step-down names nobody', async () => {
    const { bob, carol, board } = w
    const mine = await open(carol)
    const owner = await open(bob)
    const res = await bob.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: carol.userId })
    expect(res.statusCode, res.body).toBe(200)
    await mine.waitFor('access.changed')
    expect(named(mine)).toEqual([{ actor: { name: 'bob' } }])
    await fence(mine, owner)
    expect(named(owner)).toEqual([]) // bob's own step-down to editor: his own act
  })
})

describe('the actor stays out of what sync is told', () => {
  it('fanOutAccessChanges hands the sync notifier the board and the person, never the actor', () => {
    const sync = createRecordingNotifier()
    const local: unknown[] = []
    const notifier = fanOutAccessChanges(sync, { accessChanged: (c) => void local.push(c) })
    notifier.accessChanged({ boardId: 'b-1', userId: 'u-1', actor: { id: 'u-2', name: 'Bea' } })
    notifier.accessChanged({ boardId: 'b-1', actor: { id: 'u-2', name: 'Bea' } })
    expect(sync.calls).toEqual([{ boardId: 'b-1', userId: 'u-1' }, { boardId: 'b-1' }])
    expect(local).toEqual([
      { boardId: 'b-1', userId: 'u-1', actor: { id: 'u-2', name: 'Bea' } },
      { boardId: 'b-1', actor: { id: 'u-2', name: 'Bea' } },
    ])
  })

  it('the HTTP notifier posts the same two fields even when handed an actor', async () => {
    const sent: string[] = []
    const notifier = createHttpSyncNotifier({
      baseUrl: 'http://sync.invalid',
      secret: 'secret',
      log: { warn: () => {} },
      fetch: (async (_url: unknown, init?: { body?: string }) => {
        sent.push(String(init?.body))
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    })
    notifier.accessChanged({ boardId: 'b-1', userId: 'u-1', actor: { id: 'u-2', name: 'Bea' } })
    notifier.accessChanged({ boardId: 'b-1', actor: { id: 'u-2', name: 'Bea' } })
    await notifier.drain()
    expect(sent).toEqual([
      JSON.stringify({ boardId: 'b-1', userId: 'u-1' }),
      JSON.stringify({ boardId: 'b-1' }),
    ])
  })
})
