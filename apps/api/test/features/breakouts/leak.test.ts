// Wave V (WS4, V3-3): "follow never leaks across groups", the server half (docs/WAVE-V-CONTRACTS.md §4.3). A group's
// summon and broadcast are delivered by the hub only to the streams of that group's members: a member of group A never
// receives group B's summon or message, on any of their tabs, and neither does anyone in no group (the facilitator
// included). The whole state (`workshop.breakout`) and a broadcast to everyone go to every stream. The web half (a tab
// obeys a summon only for its own group: contracts breakoutSummonApplies) is tested in apps/web.
import {
  BREAKOUT_EVENTS,
  breakoutSummonApplies,
  WorkshopBreakoutBroadcastEvent,
  WorkshopBreakoutSummonEvent,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { act, type BreakoutWorld, breakoutWorld, expectStatus, start, type TabStream } from './support.ts'

let w: BreakoutWorld | null = null
afterEach(async () => {
  await w?.api.close()
  w = null
})

const of = (tab: TabStream, type: string) => tab.received.filter((e) => e.type === type)

describe('a group summon and a group broadcast reach that group only', () => {
  it('three people in two groups, every tab: A never hears B, B never hears A, nobody outside hears either', async () => {
    w = await breakoutWorld()
    // group 1: the editor (two tabs) and the commenter; group 2: the viewer; the second editor is in no group
    const a1 = w.tab(w.editor)
    const a1b = w.tab(w.editor)
    const a2 = w.tab(w.commenter)
    const b1 = w.tab(w.viewer)
    const none = w.tab(w.editor2)
    const facilitator = w.tab(w.owner)
    // another board's stream of a group member hears nothing of this board
    const elsewhere = w.tab(w.viewer, 'b_zzzzzzzzzz')
    const all = [a1, a1b, a2, b1, none, facilitator]
    const s = await start(w, w.owner, { mode: 'manual' })
    const brk = s.session?.id ?? ''
    expectStatus(
      await act(w.owner, brk, 'assign', {
        moves: [
          { userId: w.editor.userId, groupId: 'g1' },
          { userId: w.commenter.userId, groupId: 'g1' },
          { userId: w.viewer.userId, groupId: 'g2' },
        ],
      }),
      200,
    )
    // every stream heard both whole states (start, assign)
    for (const t of all) expect(of(t, BREAKOUT_EVENTS.state), t.userId).toHaveLength(2)

    expectStatus(await act(w.owner, brk, 'summon', { groupId: 'g2' }), 204)
    w.clock.advance(3_000)
    expectStatus(await act(w.owner, brk, 'summon', { groupId: 'g1' }), 204)
    expectStatus(await act(w.owner, brk, 'broadcast', { text: 'Only for group 2', groupId: 'g2' }), 204)
    w.clock.advance(3_000)
    expectStatus(await act(w.owner, brk, 'broadcast', { text: 'Only for group 1', groupId: 'g1' }), 204)

    const summons = (t: TabStream) =>
      of(t, BREAKOUT_EVENTS.summon).map((e) => WorkshopBreakoutSummonEvent.parse(e.data))
    const messages = (t: TabStream) =>
      of(t, BREAKOUT_EVENTS.broadcast).map((e) => WorkshopBreakoutBroadcastEvent.parse(e.data).text)
    for (const t of [a1, a1b, a2]) {
      expect(
        summons(t).map((e) => e.groupId),
        t.userId,
      ).toEqual(['g1'])
      expect(messages(t), t.userId).toEqual(['Only for group 1'])
    }
    expect(summons(b1).map((e) => e.groupId)).toEqual(['g2'])
    expect(messages(b1)).toEqual(['Only for group 2'])
    for (const t of [none, facilitator, elsewhere]) {
      expect(summons(t), t.userId).toEqual([])
      expect(messages(t), t.userId).toEqual([])
    }

    // the web half agrees on what it does get: each tab obeys only its own group's summon, never one of another
    const self = (userId: string, groupId: string | null) => ({ userId, sessionId: brk, groupId })
    for (const e of summons(b1)) {
      expect(breakoutSummonApplies(e, self(w.viewer.userId, 'g2'))).toBe(true)
      expect(breakoutSummonApplies(e, self(w.editor.userId, 'g1'))).toBe(false)
      expect(breakoutSummonApplies(e, self(w.editor2.userId, null))).toBe(false)
      expect(breakoutSummonApplies(e, self(w.owner.userId, null))).toBe(false)
    }

    // a broadcast to everyone reaches every stream on the board
    w.clock.advance(3_000)
    expectStatus(
      await act(w.owner, brk, 'broadcast', { text: 'Everyone back in 2 minutes', groupId: null }),
      204,
    )
    for (const t of all) expect(messages(t).at(-1), t.userId).toBe('Everyone back in 2 minutes')
    expect(messages(elsewhere)).toEqual([])
  })

  it('moving someone to another group moves where the next summon reaches them', async () => {
    const world = await breakoutWorld()
    w = world
    const viewerTab = w.tab(w.viewer)
    const s = await start(w, w.owner, { mode: 'manual' })
    const brk = s.session?.id ?? ''
    const move = (groupId: string) =>
      act(world.owner, brk, 'assign', { moves: [{ userId: world.viewer.userId, groupId }] })
    expectStatus(await move('g1'), 200)
    expectStatus(await act(w.owner, brk, 'summon', { groupId: 'g2' }), 204)
    expect(of(viewerTab, BREAKOUT_EVENTS.summon)).toHaveLength(0)
    expectStatus(await move('g2'), 200)
    w.clock.advance(3_000)
    expectStatus(await act(w.owner, brk, 'summon', { groupId: 'g1' }), 204)
    expect(of(viewerTab, BREAKOUT_EVENTS.summon)).toHaveLength(0)
    w.clock.advance(3_000)
    expectStatus(await act(w.owner, brk, 'summon', { groupId: 'g2' }), 204)
    expect(of(viewerTab, BREAKOUT_EVENTS.summon).map((e) => (e.data as { groupId: string }).groupId)).toEqual(
      ['g2'],
    )
  })
})
