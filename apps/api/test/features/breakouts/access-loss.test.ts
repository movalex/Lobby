// Wave V follow-up (gate review u2): whoever loses access to a board leaves its running breakouts in the same
// transaction (src/features/breakouts/access-loss.ts), through every path that can take a board from someone: a board
// member removed, a workspace member removed or lowered to guest, a link revoked with removal, a board's visibility
// lowered, a guest's grants swept. Whoever keeps a view of the board stays. Every tab hears the new members at once.
// And the race the review found: a revoke landing between assign's check and its write no longer places the person.

import { breakoutActionPath, ReviewLinkCreated } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { DEV_STUDIO } from '../../helpers.ts'
import { type World as GuestWorld, guestSweeper, joinAsGuest } from '../guests/support.ts'
import {
  act,
  type BreakoutWorld,
  breakoutWorld,
  expectStatus,
  frames,
  groupsOf,
  start,
  state,
  stateEvents,
} from './support.ts'

let w: BreakoutWorld
afterEach(async () => {
  await w?.api.close()
})

/** Breakouts in manual mode, with `who` put in g1 and g2 in turn by the owner. Returns the session id. */
async function placed(world: BreakoutWorld, who: readonly { userId: string }[]): Promise<string> {
  const s = await start(world, world.owner, { mode: 'manual', groups: frames(2) })
  const brk = s.session?.id ?? ''
  const moves = who.map((c, i) => ({ userId: c.userId, groupId: i % 2 === 0 ? 'g1' : 'g2' }))
  expectStatus(await act(world.owner, brk, 'assign', { moves }), 200)
  return brk
}

/** The session's member ids, sorted here (a real Postgres's collation orders mixed-case ids unlike JS) */
const memberRows = async (world: BreakoutWorld, brk: string) =>
  (
    await world.api.db.query<{ user_id: string }>(
      'SELECT user_id FROM breakout_members WHERE session_id = $1',
      [brk],
    )
  ).rows
    .map((r) => r.user_id)
    .sort()

const revOf = async (world: BreakoutWorld, brk: string) =>
  (await world.api.db.one<{ rev: number }>('SELECT rev FROM breakout_sessions WHERE id = $1', [brk])).rev

/** The members of the last state event published for the board. */
const lastPublished = (world: BreakoutWorld) =>
  (stateEvents(world).at(-1)?.data as { members: { userId: string }[] } | undefined)?.members.map(
    (m) => m.userId,
  )

const setVisibility = async (world: BreakoutWorld, visibility: string) =>
  expectStatus(await world.owner.req('PATCH', `/api/boards/${world.boardId}`, { visibility }), 200)

/** Runs `before` once, just before the next transaction on the api's database begins. */
function beforeNextTransaction(world: BreakoutWorld, before: () => Promise<void>): void {
  const db = world.api.db as { transaction: <R>(f: (tx: Queryable) => Promise<R>) => Promise<R> }
  const original = db.transaction
  db.transaction = async <R>(f: (tx: Queryable) => Promise<R>): Promise<R> => {
    db.transaction = original
    await before()
    return original.call(db, f) as Promise<R>
  }
}

/** Lets the after-COMMIT republish (an event hub listener, one read) finish. */
const settle = () => new Promise((r) => setTimeout(r, 50))

describe('losing a board takes the person out of its running breakouts', () => {
  it('a board member removed: out at once, the others stay, rev moves and every tab hears it', async () => {
    w = await breakoutWorld()
    const brk = await placed(w, [w.editor, w.editor2, w.viewer])
    const rev = await revOf(w, brk)
    expectStatus(await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.editor.userId}`), 200)
    expect(await memberRows(w, brk)).toEqual([w.editor2.userId, w.viewer.userId].sort())
    expect(await revOf(w, brk)).toBe(rev + 1)
    await settle()
    expect(lastPublished(w)?.sort()).toEqual([w.editor2.userId, w.viewer.userId].sort())
    const now = await state(w, w.owner)
    expect(now.members.map((m) => m.userId)).not.toContain(w.editor.userId)
    expect(now.session?.rev).toBe(rev + 1)
  })

  it('a board member removed who still sees the board through its visibility stays in their group', async () => {
    w = await breakoutWorld()
    await setVisibility(w, 'workspace_view')
    const brk = await placed(w, [w.editor, w.editor2])
    const rev = await revOf(w, brk)
    expectStatus(await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.editor.userId}`), 200)
    expect(await memberRows(w, brk)).toEqual([w.editor.userId, w.editor2.userId].sort())
    expect(await revOf(w, brk)).toBe(rev)
  })

  it('a workspace member removed: out of the breakouts of every board there', async () => {
    w = await breakoutWorld()
    const brk = await placed(w, [w.editor, w.viewer])
    expectStatus(await w.owner.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${w.editor.userId}`), 200)
    expect(await memberRows(w, brk)).toEqual([w.viewer.userId])
    await settle()
    expect(lastPublished(w)).toEqual([w.viewer.userId])
  })

  it('a workspace member lowered to guest loses a board seen only through its visibility, and its breakouts', async () => {
    w = await breakoutWorld()
    await setVisibility(w, 'workspace_view')
    const brk = await placed(w, [w.outsider, w.viewer]) // the outsider sees it as a workspace member
    const res = await w.owner.req('PATCH', `/api/workspaces/${DEV_STUDIO}/members/${w.outsider.userId}`, {
      role: 'guest',
    })
    expectStatus(res, 200)
    expect(await memberRows(w, brk)).toEqual([w.viewer.userId])
    await settle()
    expect(lastPublished(w)).toEqual([w.viewer.userId])
  })

  it('a link revoked with removal takes its guests out', async () => {
    w = await breakoutWorld()
    const made = await w.owner.req('POST', `/api/boards/${w.boardId}/review-links`, {
      role: 'viewer',
      allowGuests: true,
    })
    expectStatus(made, 201)
    const link = ReviewLinkCreated.parse(made.json())
    const sam = await joinAsGuest(w.api, link.url, 'Sam Guest')
    const brk = await placed(w, [sam, w.viewer])
    expect(await memberRows(w, brk)).toContain(sam.userId)
    const revoked = await w.owner.req('POST', `/api/boards/${w.boardId}/review-links/${link.id}/revoke`, {
      removeAccess: true,
    })
    expectStatus(revoked, 200)
    expect(await memberRows(w, brk)).toEqual([w.viewer.userId])
    await settle()
    expect(lastPublished(w)).toEqual([w.viewer.userId])
  })

  it('a guest whose grants the sweep removes (they signed out) leaves the breakouts', async () => {
    w = await breakoutWorld()
    const made = await w.owner.req('POST', `/api/boards/${w.boardId}/review-links`, {
      role: 'viewer',
      allowGuests: true,
    })
    expectStatus(made, 201)
    const sam = await joinAsGuest(w.api, ReviewLinkCreated.parse(made.json()).url, 'Sam Guest')
    const brk = await placed(w, [sam, w.viewer])
    expect((await sam.req('POST', '/api/auth/logout')).statusCode).toBe(204)
    const out = await guestSweeper({ api: w.api, events: w.hub } as unknown as GuestWorld).run()
    expect(out.removed).toEqual([{ userId: sam.userId, boardIds: [w.boardId] }])
    expect(await memberRows(w, brk)).toEqual([w.viewer.userId])
  })

  it('a lower visibility takes out the workspace members it no longer reaches, never those with a grant', async () => {
    w = await breakoutWorld()
    await setVisibility(w, 'workspace_view')
    const brk = await placed(w, [w.outsider, w.viewer])
    await setVisibility(w, 'private')
    expect(await memberRows(w, brk)).toEqual([w.viewer.userId])
    await settle()
    expect(lastPublished(w)).toEqual([w.viewer.userId])
  })

  it('an ended session keeps its record of who was in which group', async () => {
    w = await breakoutWorld()
    const brk = await placed(w, [w.editor, w.viewer])
    expectStatus(await act(w.owner, brk, 'end'), 200)
    expectStatus(await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.editor.userId}`), 200)
    expect(await memberRows(w, brk)).toEqual([w.editor.userId, w.viewer.userId].sort())
  })
})

describe('a loss of access that lands between a placement check and its write (review u2)', () => {
  it('assign: the move is refused and nobody is placed', async () => {
    w = await breakoutWorld()
    const s = await start(w, w.owner, { mode: 'manual', groups: frames(2) })
    const brk = s.session?.id ?? ''
    // after assign has checked that the editor may open the board, before its transaction
    beforeNextTransaction(w, async () => {
      expectStatus(await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.editor.userId}`), 200)
    })
    const res = await w.owner.req('POST', breakoutActionPath(brk, 'assign'), {
      moves: [{ userId: w.editor.userId, groupId: 'g1' }],
    })
    expect(res.statusCode, res.body).toBe(400)
    expect(await memberRows(w, brk)).toEqual([])
    expect(groupsOf(await state(w, w.owner))).toEqual({})
  })

  it('shuffle: whoever lost the board is not dealt back in', async () => {
    w = await breakoutWorld()
    const brk = await placed(w, [w.editor, w.viewer, w.commenter])
    beforeNextTransaction(w, async () => {
      expectStatus(await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.commenter.userId}`), 200)
    })
    // the commenter is read as a current member before the transaction; the removal commits in between
    expectStatus(await act(w.owner, brk, 'shuffle'), 200)
    const now = await memberRows(w, brk)
    expect(now).not.toContain(w.commenter.userId)
    expect(now.sort()).toEqual([w.editor.userId, w.viewer.userId].sort())
  })

  it('start in auto mode: someone removed from the workspace after the dealing read is left out', async () => {
    w = await breakoutWorld()
    const tabs = [w.tab(w.editor), w.tab(w.viewer)]
    beforeNextTransaction(w, async () => {
      expectStatus(
        await w.owner.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${w.editor.userId}`),
        200,
      )
    })
    const s = await start(w, w.owner, { mode: 'auto', groups: frames(2) })
    expect(s.members.map((m) => m.userId)).toEqual([w.viewer.userId])
    expect(await memberRows(w, s.session?.id ?? '')).toEqual([w.viewer.userId])
    for (const t of tabs) t.close()
  })

  it('join (choose mode): a self-join after the person lost the board is refused', async () => {
    w = await breakoutWorld()
    const s = await start(w, w.owner, { mode: 'choose', groups: frames(2), groupCap: 5 })
    const brk = s.session?.id ?? ''
    beforeNextTransaction(w, async () => {
      expectStatus(await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.viewer.userId}`), 200)
    })
    const res = await act(w.viewer, brk, 'join', { groupId: 'g1' })
    expect(res.statusCode).toBe(404)
    expect(await memberRows(w, brk)).toEqual([])
  })
})
