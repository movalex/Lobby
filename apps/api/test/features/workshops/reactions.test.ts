import {
  REACTION_EMOJIS,
  REACTION_RATE_MAX,
  REACTION_RATE_WINDOW_MS,
  WorkshopReactionEvent,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { REACTIONS_PER_BOARD_MAX, SlidingWindowLimiter } from '../../../src/features/workshops/reactions.ts'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import { listen, openStream } from './streams.ts'
import { expectStatus, json, setupWorld, type World } from './support.ts'

describe('sliding-window limiter (pure)', () => {
  it('allows max per window, counts only accepted takes, and frees slots as they age', () => {
    const l = new SlidingWindowLimiter(3, 1000)
    expect([0, 100, 200].map((t) => l.take('a', t))).toEqual([true, true, true])
    expect(l.take('a', 300)).toBe(false)
    expect(l.retryAfterMs('a', 300)).toBe(700)
    expect(l.take('b', 300)).toBe(true) // per key
    expect(l.take('a', 999)).toBe(false)
    expect(l.take('a', 1000)).toBe(true) // the take at 0 has aged out
    expect(l.take('a', 1050)).toBe(false)
    expect(l.take('a', 1100)).toBe(true)
    expect(l.retryAfterMs('b', 5000)).toBe(0)
  })

  it('stays bounded: past maxKeys the least recently used key is forgotten', () => {
    const l = new SlidingWindowLimiter(1, 1000, 2)
    l.take('a', 0)
    l.take('b', 0)
    l.take('a', 0) // refused, and 'a' is not refreshed by a refusal
    l.take('c', 0)
    expect(l.take('a', 1)).toBe(true) // forgotten, so allowed early (never the other way round)
    expect(l.take('c', 1)).toBe(false)
  })
})

let w: World
afterEach(async () => {
  await w?.api.close()
})

const reactions = (world: World) =>
  world.events.filter((e) => e.type === 'workshop.reaction').map((e) => WorkshopReactionEvent.parse(e.data))

describe('reactions (routes)', () => {
  it('everyone who can view reacts; the event names them from the session, and nothing is stored', async () => {
    w = await setupWorld()
    const path = `/api/boards/${w.boardId}/reactions`
    const people = [w.viewer, w.commenter, w.editor, w.owner]
    for (const [i, c] of people.entries()) {
      const emoji = REACTION_EMOJIS[i] ?? '👍'
      const res = await c.req('POST', path, { emoji, userId: w.owner.userId, name: 'Someone else' })
      expectStatus(res, 202)
      expect(json(res)).toEqual({ ok: true })
    }
    expect(reactions(w)).toEqual([
      { userId: w.viewer.userId, name: 'Vic Viewer', emoji: '👍' },
      { userId: w.commenter.userId, name: 'Cora Commenter', emoji: '❤️' },
      { userId: w.editor.userId, name: 'Ed Editor', emoji: '😂' },
      { userId: w.owner.userId, name: 'Ada Owner', emoji: '🎉' },
    ])
    // Not part of any stored state.
    const state = await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`)
    for (const e of REACTION_EMOJIS) expect(state.body).not.toContain(e)
  })

  it('arrives on every open stream of the board', async () => {
    w = await setupWorld()
    const base = await listen(w)
    const a = await openStream(w, base, w.owner.cookie)
    const b = await openStream(w, base, w.viewer.cookie)
    expectStatus(await w.commenter.req('POST', `/api/boards/${w.boardId}/reactions`, { emoji: '👏' }), 202)
    for (const s of [a, b]) {
      const e = await s.waitFor('workshop.reaction')
      expect(e.data).toEqual({ userId: w.commenter.userId, name: 'Cora Commenter', emoji: '👏' })
    }
    await a.close()
    await b.close()
  })

  it('takes only the six allowlisted emojis, exactly', async () => {
    w = await setupWorld()
    const path = `/api/boards/${w.boardId}/reactions`
    for (const body of [
      { emoji: '💩' },
      { emoji: '❤' }, // the heart without its variation selector is a different string
      { emoji: '👍🏽' },
      { emoji: ' 👍' },
      { emoji: '<img src=x onerror=alert(1)>' },
      { emoji: '' },
      { emoji: 1 },
      { emoji: ['👍'] },
      {},
      undefined,
    ]) {
      const res = await w.viewer.req('POST', path, body)
      expectStatus(res, 400)
    }
    expect(reactions(w)).toEqual([])
  })

  it(`is rate limited per person: ${REACTION_RATE_MAX} per ${REACTION_RATE_WINDOW_MS} ms, across boards`, async () => {
    w = await setupWorld()
    const other = await createBoard(w.owner, DEV_STUDIO, 'Second board')
    expectStatus(
      await w.owner.req('PUT', `/api/boards/${other}/members/${w.viewer.userId}`, { role: 'viewer' }),
      200,
    )
    const on = (b: string) => `/api/boards/${b}/reactions`
    for (let i = 0; i < REACTION_RATE_MAX - 1; i++)
      expectStatus(await w.viewer.req('POST', on(w.boardId), { emoji: '👍' }), 202)
    expectStatus(await w.viewer.req('POST', on(other), { emoji: '👍' }), 202) // the 5th, elsewhere
    const refused = await w.viewer.req('POST', on(w.boardId), { emoji: '👍' })
    expectStatus(refused, 429)
    expect(json<{ error: { code: string } }>(refused).error.code).toBe('RATE_LIMITED')
    expect(refused.headers['retry-after']).toBe('1')
    // Someone else is not slowed down by the viewer.
    expectStatus(await w.editor.req('POST', on(w.boardId), { emoji: '🎉' }), 202)
    expect(reactions(w).filter((r) => r.userId === w.viewer.userId)).toHaveLength(REACTION_RATE_MAX - 1)
    w.clock.advance(REACTION_RATE_WINDOW_MS)
    expectStatus(await w.viewer.req('POST', on(w.boardId), { emoji: '👍' }), 202)
  })

  it(`caps what one board relays: ${REACTIONS_PER_BOARD_MAX} per window, whoever sends them`, async () => {
    w = await setupWorld()
    const people = [w.owner, w.editor, w.commenter, w.viewer]
    const perPerson = REACTION_RATE_MAX
    const needed = Math.ceil(REACTIONS_PER_BOARD_MAX / perPerson) + 1 - people.length
    for (let i = 0; i < needed; i++) {
      const c = await w.api.login(`crowd-${i}`, `Crowd ${i}`)
      const res = await w.owner.req('PUT', `/api/boards/${w.boardId}/members/${c.userId}`, { role: 'viewer' })
      expectStatus(res, 200)
      people.push(c)
    }
    const path = `/api/boards/${w.boardId}/reactions`
    const counts = { ok: 0, limited: 0 }
    for (const c of people)
      for (let i = 0; i < perPerson; i++) {
        const res = await c.req('POST', path, { emoji: '👏' })
        if (res.statusCode === 202) counts.ok++
        else if (res.statusCode === 429) counts.limited++
        else throw new Error(`unexpected ${res.statusCode}`)
      }
    expect(counts).toEqual({
      ok: REACTIONS_PER_BOARD_MAX,
      limited: people.length * perPerson - REACTIONS_PER_BOARD_MAX,
    })
    expect(reactions(w)).toHaveLength(REACTIONS_PER_BOARD_MAX)
    // Another board is not affected.
    const other = await createBoard(w.owner, DEV_STUDIO, 'Quiet board')
    expectStatus(await w.owner.req('POST', `/api/boards/${other}/reactions`, { emoji: '👍' }), 429) // owner used 5
    expectStatus(await w.editor.req('POST', `/api/boards/${other}/reactions`, { emoji: '👍' }), 404) // no access
    const fresh = await w.api.login('fresh', 'Fresh Face')
    const own = await createBoard(fresh, fresh.personalWorkspaceId, 'Mine')
    expectStatus(await fresh.req('POST', `/api/boards/${own}/reactions`, { emoji: '👍' }), 202)
    w.clock.advance(REACTION_RATE_WINDOW_MS)
    expectStatus(await w.viewer.req('POST', path, { emoji: '👍' }), 202)
  })

  it('refuses outsiders without revealing the board, anonymous callers, and archived boards', async () => {
    w = await setupWorld()
    const path = `/api/boards/${w.boardId}/reactions`
    expectStatus(await w.outsider.req('POST', path, { emoji: '👍' }), 404)
    expectStatus(await w.outsider.req('POST', '/api/boards/b-nosuchboard9/reactions', { emoji: '👍' }), 404)
    expectStatus(await w.api.anon('POST', path, { emoji: '👍' }), 401)
    // Cross-origin posts are refused before anything else (the app's CSRF rule).
    expectStatus(await w.viewer.req('POST', path, { emoji: '👍' }, { origin: 'https://evil.example' }), 403)
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/archive`), 200)
    expectStatus(await w.viewer.req('POST', path, { emoji: '👍' }), 403)
    expect(reactions(w)).toEqual([])
  })
})
