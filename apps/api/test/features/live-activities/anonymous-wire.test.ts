// OWNER: WS1 (wave V). The anonymous wire test (docs/WAVE-V-CONTRACTS.md §2.2 rules 1 and 4; lead decision d): an
// anonymous poll, scale and word cloud run start to finish with eight kinds of participant (accounts, a client on a
// review link and two name-only guests). Every response body any of them gets (the facilitator's included) and every
// event the board stream is sent is captured, and none carries a participant's user id or name, or a key that could
// name a person; the only account id anywhere is the starter's `createdBy`. After the reveal (and the cancel) no row
// ties anyone to an answer.

import { activitiesPath, activityActionPath, activityPath, openStatePath } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { POLL, SCALE, setupWorld, WORDS, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.close()
})

const W = 5_000

/** Every key of a JSON value, nested. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out)
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k)
      keysOf(x, out)
    }
  return out
}

/** Keys that could name a person or group answers by one. `createdBy` (the starter, a facilitator) is the only one allowed. */
const PERSON_KEYS =
  /^(user|userId|users|name|names|author|authorId|authors|by|who|people|person|members|voter|voters|answers|answeredBy|email)$/i

describe('an anonymous activity on the wire', () => {
  it('no body or event names a participant; only the starter id appears, as createdBy; nothing is kept after', async () => {
    w = await setupWorld()
    const bodies: { who: string; route: string; body: string }[] = []
    type C = {
      userId: string
      req: (m: 'GET' | 'POST', url: string, body?: unknown) => Promise<LightMyRequestResponse>
    }
    const track = (who: string, c: C): C => ({
      userId: c.userId,
      req: async (m, url, body) => {
        const res = await c.req(m, url, body)
        bodies.push({ who, route: `${m} ${url}`, body: res.body })
        return res
      },
    })
    const fac = track('owner', w.owner)
    const people = {
      editor: track('editor', w.editor),
      commenter: track('commenter', w.commenter),
      viewer: track('viewer', w.viewer),
      client: track('client', w.client),
      guest: track('guest', w.guest),
      reviewGuest: track('reviewGuest', w.reviewGuest),
      editor2: track('editor2', w.editor2),
    }
    const participants = Object.values(people)
    const names = [
      'Ed Editor',
      'Eve Editor',
      'Cora Commenter',
      'Vic Viewer',
      'Rita Client',
      'Gus Guest',
      'Rae Reviewguest',
    ]
    const ids = participants.map((p) => p.userId)

    const everyRead = async () => {
      for (const c of [fac, ...participants]) {
        await c.req('GET', activityPath(w.board))
        await c.req('GET', activitiesPath(w.board))
        await c.req('GET', openStatePath(w.board))
      }
    }
    const run = async (input: object, answerOf: (i: number) => unknown, end: 'reveal' | 'cancel') => {
      const s = await fac.req('POST', activitiesPath(w.board), input)
      expect(s.statusCode, s.body).toBe(201)
      const aid = (s.json() as { activity: { id: string } }).activity.id
      for (const [i, p] of participants.entries()) {
        const r = await p.req('POST', activityActionPath(aid, 'answer'), { answer: answerOf(i) })
        expect(r.statusCode, r.body).toBe(200)
        await p.req('GET', activityActionPath(aid, 'results'))
        await p.req('GET', activityActionPath(aid, 'answers'))
      }
      await everyRead()
      w.clock.advance(W)
      await everyRead()
      // a change of mind, then the facilitator's moderation and the end
      await people.viewer.req('POST', activityActionPath(aid, 'answer'), { answer: answerOf(3) })
      await fac.req('GET', activityActionPath(aid, 'results'))
      if ((input as { kind: string }).kind === 'words')
        await fac.req('POST', activityActionPath(aid, 'hide'), { word: 'w0' })
      w.clock.advance(W)
      await everyRead()
      await fac.req('POST', activityActionPath(aid, 'close'), {})
      const e = await fac.req('POST', activityActionPath(aid, end), {})
      expect(e.statusCode, e.body).toBe(200)
      if (end === 'reveal') await fac.req('POST', activityActionPath(aid, 'placed'), {})
      for (const c of [fac, ...participants]) {
        await c.req('GET', activityActionPath(aid, 'results'))
        await c.req('GET', activityActionPath(aid, 'answers'))
      }
      await everyRead()
      // nothing ties a person to an answer any more
      const kept = await w.api.db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM live_answers WHERE activity_id = $1',
        [aid],
      )
      expect(kept.n, `${aid} kept answers`).toBe(0)
      w.clock.advance(10)
      return aid
    }

    await run(POLL, (i) => ({ kind: 'poll', choices: [i % 3] }), 'reveal')
    await run(SCALE, (i) => ({ kind: 'scale', value: 1 + (i % 5) }), 'reveal')
    await run(
      { ...WORDS, resultsLive: true },
      (i) => ({ kind: 'words', words: [`w${i % 2}`, 'shared'] }),
      'reveal',
    )
    await run({ ...POLL, resultsLive: true }, (i) => ({ kind: 'poll', choices: [i % 2] }), 'cancel')

    const events = w.events.filter((e) => e.type.startsWith('workshop.activity'))
    expect(events.length).toBeGreaterThan(8)
    const texts = [
      ...bodies.map((b) => ({ where: `${b.who} ${b.route}`, text: b.body })),
      ...events.map((e) => ({ where: `event ${e.type}`, text: JSON.stringify(e.data) })),
    ]
    expect(bodies.length).toBeGreaterThan(200)
    let openStates = 0
    for (const { where, text: raw } of texts) {
      const parsed = JSON.parse(raw) as unknown
      // the open-state body has parts of other features (sharing lists people by design): only its activity part
      const openState = where.includes('/open-state')
      if (openState) openStates++
      const scope = openState ? ((parsed as { activity?: unknown }).activity ?? null) : parsed
      const text = JSON.stringify(scope)
      for (const id of ids) expect(text.includes(id), `${where} carries a participant id`).toBe(false)
      for (const n of names) expect(text.includes(n), `${where} carries a name`).toBe(false)
      // the facilitator's id only as the starter
      const rest = text.split(`"createdBy":"${w.owner.userId}"`).join('')
      expect(rest.includes(w.owner.userId), `${where} carries the facilitator id outside createdBy`).toBe(
        false,
      )
      expect(rest.includes('Ada Owner'), `${where} carries the facilitator name`).toBe(false)
      for (const k of keysOf(scope)) expect(PERSON_KEYS.test(k), `${where}: key ${k}`).toBe(false)
    }
    expect(openStates).toBeGreaterThan(0)
  })

  it('a named activity keeps its answers for its facilitator; the wire to participants still names nobody', async () => {
    w = await setupWorld()
    const s = await w.owner.req('POST', activitiesPath(w.board), {
      ...WORDS,
      anonymous: false,
      resultsLive: true,
    })
    const aid = (s.json() as { activity: { id: string } }).activity.id
    const seen: string[] = []
    for (const c of [w.viewer, w.guest]) {
      const r = await c.req('POST', activityActionPath(aid, 'answer'), {
        answer: { kind: 'words', words: ['named'] },
      })
      seen.push(r.body)
    }
    w.clock.advance(W)
    await w.owner.req('POST', activityActionPath(aid, 'reveal'), {})
    for (const c of [w.viewer, w.guest, w.commenter]) {
      seen.push((await c.req('GET', activityPath(w.board))).body)
      seen.push((await c.req('GET', activityActionPath(aid, 'results'))).body)
      seen.push((await c.req('GET', activityActionPath(aid, 'answers'))).body)
    }
    seen.push(...w.events.map((e) => JSON.stringify(e.data)))
    for (const text of seen)
      for (const id of [w.viewer.userId, w.guest.userId]) expect(text.includes(id)).toBe(false)
    const kept = await w.api.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM live_answers WHERE activity_id = $1',
      [aid],
    )
    expect(kept.n).toBe(2)
  })
})
