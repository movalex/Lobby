import { WorkshopSummonEvent } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { expectStatus, setupWorld, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.api.close()
})

describe('gather everyone (summon)', () => {
  it('facilitators summon; the event names them, from the session (never from the body)', async () => {
    w = await setupWorld()
    const res = await w.editor.req('POST', `/api/boards/${w.boardId}/summon`, {
      userId: w.owner.userId, // ignored: identity comes from the session
      name: 'Someone else',
    })
    expectStatus(res, 202)
    expect(w.events).toHaveLength(1)
    const e = w.events[0]
    expect(e?.type).toBe('workshop.summon')
    const data = WorkshopSummonEvent.parse(e?.data)
    expect(data).toEqual({ userId: w.editor.userId, name: 'Ed Editor', targetUserId: null })
  })

  it('"bring one person" carries the target; viewers, commenters and outsiders cannot summon', async () => {
    w = await setupWorld()
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/summon`), 403)
    expectStatus(await w.commenter.req('POST', `/api/boards/${w.boardId}/summon`), 403)
    expectStatus(await w.outsider.req('POST', `/api/boards/${w.boardId}/summon`), 404)
    expectStatus(await w.api.anon('POST', `/api/boards/${w.boardId}/summon`), 401)
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/summon`, { targetUserId: 'nope' }), 400)
    expect(w.events).toHaveLength(0)
    expectStatus(
      await w.owner.req('POST', `/api/boards/${w.boardId}/summon`, { targetUserId: w.viewer.userId }),
      202,
    )
    expect(w.events[0]?.data).toMatchObject({ userId: w.owner.userId, targetUserId: w.viewer.userId })
  })

  it('relays the summoner’s canvas size when sent (R2-04), and refuses a malformed one', async () => {
    w = await setupWorld()
    for (const screen of [{ w: 0, h: 800 }, { w: 1440 }, { w: 'wide', h: 800 }, { w: 1e9, h: 800 }])
      expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/summon`, { screen }), 400)
    expect(w.events).toHaveLength(0)
    expectStatus(
      await w.owner.req('POST', `/api/boards/${w.boardId}/summon`, {
        screen: { w: 1396, h: 844.5, extra: 'dropped' },
      }),
      202,
    )
    expect(WorkshopSummonEvent.parse(w.events[0]?.data)).toEqual({
      userId: w.owner.userId,
      name: expect.any(String),
      targetUserId: null,
      screen: { w: 1396, h: 844.5 },
    })
    expect(w.events[0]?.data).toEqual(WorkshopSummonEvent.parse(w.events[0]?.data))
  })

  it('is rate limited per person and board (no summon storms)', async () => {
    w = await setupWorld()
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/summon`), 202)
    const again = await w.owner.req('POST', `/api/boards/${w.boardId}/summon`)
    expectStatus(again, 429)
    // another facilitator is not blocked by the first one's cooldown
    expectStatus(await w.editor.req('POST', `/api/boards/${w.boardId}/summon`), 202)
    w.clock.advance(3_000)
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/summon`), 202)
    expect(w.events.filter((e) => e.type === 'workshop.summon')).toHaveLength(3)
  })
})
