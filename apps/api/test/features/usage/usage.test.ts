// Wave M, M5-5 (S3): privacy-safe usage counters. POST /api/usage adds a capped batch of fixed event names to
// usage_daily(day, event, role_class, count); nothing else is kept. GET /internal/usage?days=N reads the rows back
// for the next scout, behind the internal secret.
import {
  InternalUsageResponse,
  USAGE_BATCH_MAX_KEYS,
  USAGE_COUNT_CAP,
  USAGE_EVENTS,
  USAGE_GUEST_COUNT_CAP,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBoard, DEV_STUDIO, INTERNAL_SECRET } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest, setupWorld, type World } from '../guests/support.ts'

let w: World
let sam: GuestClient
beforeEach(async () => {
  w = await setupWorld()
  sam = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'editor' })).url, 'Sam')
})
afterEach(() => w.api.close())

const rows = async () =>
  (
    await w.api.db.query<{ day: string; event: string; role_class: string; count: number }>(
      "SELECT to_char(day, 'YYYY-MM-DD') AS day, event, role_class, count FROM usage_daily ORDER BY event, role_class",
    )
  ).rows
const today = () => w.api.clock.now().toISOString().slice(0, 10)
const internal = (query = '', secret: string | null = INTERNAL_SECRET) =>
  w.api.anon('GET', `/internal/usage${query}`, undefined, secret ? { 'x-draftroom-internal': secret } : {})

describe('POST /api/usage', () => {
  it('adds a batch to the day’s counters by role class, and answers 204', async () => {
    // bob is a creator (dev.invalid is a creator domain in tests), carol an account that is not one
    const res = await w.bob.req('POST', '/api/usage', {
      events: { 'palette.open:key': 3, 'mermaid.paste': 1 },
    })
    expect(res.statusCode, res.body).toBe(204)
    expect(res.body).toBe('')
    const classes = await rows()
    expect(classes).toHaveLength(2)
    for (const r of classes) expect(r.day).toBe(today())
    expect(classes.map((r) => [r.event, r.count])).toEqual([
      ['mermaid.paste', 1],
      ['palette.open:key', 3],
    ])
    // a second batch from someone else adds to the same rows (or their role class's)
    expect((await sam.req('POST', '/api/usage', { events: { 'mermaid.paste': 2 } })).statusCode).toBe(204)
    const after = await rows()
    expect(after.find((r) => r.event === 'mermaid.paste' && r.role_class === 'guest')?.count).toBe(2)
  })

  it('an unknown event refuses the whole batch with 400, and nothing is stored', async () => {
    for (const events of [
      { 'board:b-abc1234567': 1 },
      { 'palette.run:not-a-command': 1 },
      { 'mermaid.paste': 1, 'whatever.else': 1 },
      { 'Mermaid.paste': 1 },
    ]) {
      const res = await w.bob.req('POST', '/api/usage', { events })
      expect(res.statusCode, JSON.stringify(events)).toBe(400)
    }
    // the batch's shape: at least one event, at most 40, counts 1..50, no other key
    const many = Object.fromEntries(USAGE_EVENTS.slice(0, USAGE_BATCH_MAX_KEYS + 1).map((e) => [e, 1]))
    for (const body of [
      { events: {} },
      { events: many },
      { events: { 'mermaid.paste': 0 } },
      { events: { 'mermaid.paste': USAGE_COUNT_CAP + 1 } },
      { events: { 'mermaid.paste': 1.5 } },
      { events: { 'mermaid.paste': 1 }, boardId: w.board },
      {},
      null,
    ])
      expect((await w.bob.req('POST', '/api/usage', body)).statusCode, JSON.stringify(body)).toBe(400)
    expect(await rows()).toEqual([])
  })

  it('caps every count: 50 for an account, 10 for a guest', async () => {
    expect(USAGE_GUEST_COUNT_CAP).toBe(10)
    expect((await w.bob.req('POST', '/api/usage', { events: { 'coach.shown': 50 } })).statusCode).toBe(204)
    expect(
      (await sam.req('POST', '/api/usage', { events: { 'coach.shown': 50, 'coach.run': 7 } })).statusCode,
    ).toBe(204)
    const r = await rows()
    const of = (event: string, role: string) =>
      r.find((x) => x.event === event && x.role_class === role)?.count
    expect(of('coach.shown', 'creator')).toBe(50)
    expect(of('coach.shown', 'guest')).toBe(10)
    expect(of('coach.run', 'guest')).toBe(7)
  })

  it('one batch a minute per session: the next answers 429 with Retry-After and stores nothing', async () => {
    expect((await w.bob.req('POST', '/api/usage', { events: { 'open.cold': 1 } })).statusCode).toBe(204)
    const second = await w.bob.req('POST', '/api/usage', { events: { 'open.cold': 1 } })
    expect(second.statusCode).toBe(429)
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0)
    expect((await sam.req('POST', '/api/usage', { events: { 'open.cold': 1 } })).statusCode).toBe(204) // another session
    expect((await sam.req('POST', '/api/usage', { events: { 'open.cold': 1 } })).statusCode).toBe(429) // a guest too
    // a refused batch (400) does not use the minute
    expect((await w.carol.req('POST', '/api/usage', { events: { nope: 1 } })).statusCode).toBe(400)
    expect((await w.carol.req('POST', '/api/usage', { events: { 'open.cold': 1 } })).statusCode).toBe(204)
    w.api.clock.advance(60_000)
    expect((await w.bob.req('POST', '/api/usage', { events: { 'open.cold': 1 } })).statusCode).toBe(204)
    const total = (await rows()).filter((r) => r.event === 'open.cold').reduce((n, r) => n + r.count, 0)
    expect(total).toBe(4)
  })

  it('needs a session (an account or a name-only guest) and the page’s origin', async () => {
    expect((await w.api.anon('POST', '/api/usage', { events: { 'open.cold': 1 } })).statusCode).toBe(401)
    const cross = await w.bob.req(
      'POST',
      '/api/usage',
      { events: { 'open.cold': 1 } },
      { origin: 'https://evil.example' },
    )
    expect(cross.statusCode).toBe(403)
    expect(await rows()).toEqual([])
  })

  it('stores nothing but day, event, role class and count (the table has no other column)', async () => {
    const cols = await w.api.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'usage_daily' AND table_schema = current_schema() ORDER BY ordinal_position`,
    )
    expect(cols.rows.map((c) => c.column_name)).toEqual(['day', 'event', 'role_class', 'count'])
    const other = await createBoard(w.bob, DEV_STUDIO, 'Secret plan for Acme')
    expect(
      (await w.bob.req('POST', '/api/usage', { events: { 'template.pick:kanban': 1 } })).statusCode,
    ).toBe(204)
    const dump = JSON.stringify(await w.api.db.query('SELECT * FROM usage_daily'))
    for (const secret of [w.bob.userId, w.board, other, 'Acme', w.bob.cookie.split('=')[1] as string])
      expect(dump).not.toContain(secret)
  })
})

describe('GET /internal/usage', () => {
  it('requires the internal secret (401 without it, with a wrong one, or with a session)', async () => {
    expect((await internal('', null)).statusCode).toBe(401)
    expect((await internal('', 'x'.repeat(INTERNAL_SECRET.length))).statusCode).toBe(401)
    expect((await w.bob.req('GET', '/internal/usage')).statusCode).toBe(401)
    expect((await internal()).statusCode).toBe(200)
  })

  it('returns the rows of the last N UTC days, newest first (default 7, at most 90)', async () => {
    expect((await w.bob.req('POST', '/api/usage', { events: { 'compass.click': 2 } })).statusCode).toBe(204)
    await w.api.db.query(
      `INSERT INTO usage_daily (day, event, role_class, count) VALUES
         ($1::date - 3, 'follow.pause', 'member', 4), ($1::date - 20, 'follow.pause', 'member', 9)`,
      [today()],
    )
    const res = InternalUsageResponse.parse((await internal()).json())
    expect(res.rows.map((r) => [r.event, r.roleClass, r.count])).toEqual([
      ['compass.click', 'creator', 2],
      ['follow.pause', 'member', 4],
    ])
    expect(res.rows[0]?.day).toBe(today())
    expect(InternalUsageResponse.parse((await internal('?days=30')).json()).rows).toHaveLength(3)
    expect(InternalUsageResponse.parse((await internal('?days=1')).json()).rows).toHaveLength(1)
    for (const bad of ['?days=0', '?days=91', '?days=abc'])
      expect((await internal(bad)).statusCode, bad).toBe(400)
  })
})
