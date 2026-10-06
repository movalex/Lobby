// J2 item 5 (INV-5 / AUTHZ-PENDING-REQUEST-AFTER-REMOVAL): removing someone from a board denies their
// pending access request for it (as removing a workspace member already did for the workspace), so
// approving it later grants nothing; the usual one-day pause before asking again applies.

import { ListAccessRequestsResponse } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { ask, codeOf, DAY, del, put, requestOf, roleOn, useWorld, w } from './access-lifecycle-support.ts'
import { createBoard, DEV_STUDIO } from './helpers.ts'

useWorld()

describe('J2 item 5 (INV-5): a board removal denies the person’s pending request for that board', () => {
  it('approving it afterwards grants nothing; asking again waits the usual day; other boards’ requests stay', async () => {
    const { api, alice, bob, carol } = w
    const board2 = await createBoard(bob, DEV_STUDIO, 'Board two')
    expect((await put(bob, carol.userId, 'viewer')).statusCode).toBe(200)
    expect((await put(bob, carol.userId, 'viewer', board2)).statusCode).toBe(200)
    expect((await ask(carol, 'editor')).statusCode).toBe(202)
    expect((await ask(carol, 'editor', board2)).statusCode).toBe(202)
    const asked = await requestOf(carol.userId)
    if (!asked) throw new Error('no request')

    const res = await del(bob, carol.userId)
    expect(res.statusCode, res.body).toBe(200)
    expect(await requestOf(carol.userId)).toEqual({ id: asked.id, status: 'denied', decided_by: bob.userId })
    expect((await requestOf(carol.userId, board2))?.status).toBe('pending')
    const listed = ListAccessRequestsResponse.parse(
      (await bob.req('GET', `/api/boards/${w.board}/access-requests`)).json(),
    )
    expect(listed.requests).toEqual([])

    // before the fix: 200, and carol was an editor of the board she was just removed from
    const approve = await alice.req('POST', `/api/access-requests/${asked.id}/approve`, {})
    expect(approve.statusCode).toBe(409)
    expect(codeOf(approve)).toBe('ALREADY_DECIDED')
    expect(await roleOn(carol)).toBeNull()

    // a denial like any other: asking again within a day is swallowed (202, nothing new to approve)
    expect((await ask(carol, 'viewer')).statusCode).toBe(202)
    expect((await requestOf(carol.userId))?.status).toBe('denied')
    api.clock.advance(DAY + 1000)
    expect((await ask(carol, 'viewer')).statusCode).toBe(202)
    expect((await requestOf(carol.userId))?.status).toBe('pending')

    const removal = await api.db.one<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_events WHERE action = 'board.member.remove' ORDER BY id DESC LIMIT 1",
    )
    expect(removal.detail).toEqual({ userId: carol.userId, previousRole: 'viewer', accessRequestsDenied: 1 })
  })

  it('a member with no grant of their own (access through the workspace) who is “removed”: their request is denied too', async () => {
    const { bob, carol } = w
    expect(
      (await bob.req('PATCH', `/api/boards/${w.board}`, { visibility: 'workspace_view' })).statusCode,
    ).toBe(200)
    expect((await ask(carol, 'editor')).statusCode).toBe(202)
    expect((await del(bob, carol.userId)).statusCode).toBe(200)
    expect((await requestOf(carol.userId))?.status).toBe('denied')
    expect(await roleOn(carol)).toBe('viewer') // the workspace still gives what it gave
  })

  it('a refused removal (the board’s last owner) denies nothing', async () => {
    const { alice, bob, carol } = w
    expect((await ask(carol, 'editor')).statusCode).toBe(202) // asked while a member without access
    expect((await put(bob, carol.userId, 'owner')).statusCode).toBe(200)
    expect((await del(bob, bob.userId)).statusCode).toBe(200) // bob steps down: carol is the last owner
    const before = await requestOf(carol.userId)
    expect(before?.status).toBe('pending')
    const res = await del(alice, carol.userId)
    expect(res.statusCode).toBe(409)
    expect(codeOf(res)).toBe('LAST_OWNER')
    expect(await requestOf(carol.userId)).toEqual(before)
  })
})
