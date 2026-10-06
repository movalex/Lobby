// J2 item 6 (INV-6): at most ACCESS_REQUEST_BOARD_LIMIT new access requests per board in any 24 hours,
// across everyone who asks (the per-user limit cannot see a crowd of accounts).

import { describe, expect, it } from 'vitest'
import { ACCESS_REQUEST_BOARD_LIMIT } from '../src/features/dashboard/access-requests.ts'
import { ask, DAY, useWorld, w } from './access-lifecycle-support.ts'
import { type Client, createBoard, DEV_STUDIO } from './helpers.ts'

useWorld()

describe(`J2 item 6 (INV-6): at most ${ACCESS_REQUEST_BOARD_LIMIT.max} new access requests per board in any 24 hours`, () => {
  const pendingOn = async (boardId: string) =>
    (
      await w.api.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM access_requests WHERE board_id = $1 AND status = 'pending'",
        [boardId],
      )
    ).n
  const bellItems = async (boardId: string) =>
    (
      await w.api.db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM notifications WHERE board_id = $1 AND kind = 'access_request'",
        [boardId],
      )
    ).n

  it('across requesters: past the cap a new request is swallowed (the same 202, no row, no bell item); a pending one still updates; a day later it reopens', async () => {
    const { api, bob } = w
    const other = await createBoard(bob, DEV_STUDIO, 'Another board')
    const max = ACCESS_REQUEST_BOARD_LIMIT.max
    const askers: Client[] = []
    for (let i = 0; i <= max; i++) {
      const c = await api.login(`asker${i}`)
      await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
        c.userId,
        DEV_STUDIO,
      ])
      askers.push(c)
    }
    for (const c of askers.slice(0, max)) expect((await ask(c, 'viewer')).statusCode).toBe(202)
    expect(await pendingOn(w.board)).toBe(max)
    const bell = await bellItems(w.board)
    expect(bell).toBe(max) // one owner (bob): one item per requester

    const late = askers[max] as Client
    const refused = await ask(late, 'viewer')
    // the same answer as any request (no existence or limit leak), but nothing reaches the owners
    expect(refused.statusCode).toBe(202)
    expect(refused.json()).toEqual({ status: 'sent' })
    expect(await pendingOn(w.board)).toBe(max) // before the fix: max + 1
    expect(await bellItems(w.board)).toBe(bell)
    // another board is counted on its own
    expect((await ask(late, 'viewer', other)).statusCode).toBe(202)
    expect(await pendingOn(other)).toBe(1)
    // someone already pending can still raise what they asked for (an update, not a new request)
    expect((await ask(askers[0] as Client, 'editor')).statusCode).toBe(202)
    expect(
      (
        await api.db.one<{ role_requested: string }>(
          "SELECT role_requested FROM access_requests WHERE board_id = $1 AND user_id = $2 AND status = 'pending'",
          [w.board, (askers[0] as Client).userId],
        )
      ).role_requested,
    ).toBe('editor')

    // decided requests still count for the day: the window is about how many came in
    api.clock.advance(DAY + 1000)
    expect((await ask(late, 'viewer')).statusCode).toBe(202)
    expect(await pendingOn(w.board)).toBe(max + 1)
  }, 60_000)
})
