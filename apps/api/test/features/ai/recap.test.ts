// Wave L (W1, L1-2): the recap. A 'since' recap reads the objects whose SERVER-stamped times (lobbyServer
// createdAt or lastEditedAt, of the object or its label) are in the window, never a client-set `updated`;
// `since` reaches back 14 days at most. Revealed votes in the window put `votes:n` on their items and make
// the server's top voted list; an open or unrevealed vote contributes nothing. The plan keeps only aliases
// that were sent and owners the items name verbatim, and clamps every list. Panel needs view; insert needs
// edit; guests and export-limited people get nothing.

import {
  AI_RECAP_ACTIONS_MAX,
  AI_RECAP_DECISIONS_MAX,
  AI_RECAP_MAX_WINDOW_MS,
  AI_RECAP_QUESTIONS_MAX,
  AiResult,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { AUTHOR, DAY, frame, freeText, image, note, ref } from './elements.ts'
import { type FakeItem, itemsOf } from './fake-openai.ts'
import { type AiWorld, aiWorld, expectError, run, usageRows } from './support.ts'
import { cast, closeVote, revealVote, startVote } from './votes-kit.ts'

let w: AiWorld
let now = 0
const HOUR = 3_600_000

beforeEach(async () => {
  w = await aiWorld()
  now = w.api.clock.now().getTime()
  w.sync.setElements(w.board, [
    ...frame('F', 'Sprint review', { createdAt: now - HOUR, w: 2000, h: 1200 }),
    ...note('a', 'Decision: we go with plan B', {
      frameId: 'F',
      x: 100,
      y: 100,
      createdAt: now - 30 * 60_000,
    }),
    // made 10 days ago, its words typed 20 minutes ago: in a 2 h window through its label
    ...note('b', 'Sam will draft the brief', {
      frameId: 'F',
      x: 320,
      y: 100,
      createdAt: now - 10 * DAY,
      editedAt: now - 20 * 60_000,
    }),
    // made 20 days ago, with a client-set `updated` of now: never in a window that starts later
    ...note('c', 'An old idea from last month', { x: 3000, y: 0, createdAt: now - 20 * DAY, updated: now }),
    ...note('d', 'Is pricing still open?', { frameId: 'F', x: 540, y: 100, createdAt: now - 5 * 60_000 }),
    ...freeText('e', 'Agenda for the review', { frameId: 'F', x: 0, y: 0, createdAt: now - 60_000 }),
    ...image('img', { frameId: 'F', x: 800, y: 400, createdAt: now - 60_000 }),
  ])
})
afterEach(() => w.close())

const lastRequest = () => {
  const r = w.openai.requests.at(-1)
  if (!r) throw new Error('no request reached the fake OpenAI')
  return r
}
const sentItems = () => itemsOf(lastRequest()) as (FakeItem & { votes?: number })[]
const since = (ms: number) => ({ action: 'recap', scope: { kind: 'since', since: ms }, mode: 'panel' })
const recapOf = (res: { json(): unknown }) => {
  const r = AiResult.parse(res.json())
  if (r.action !== 'recap') throw new Error(r.action)
  return r
}

describe('the window', () => {
  it('selects by the server-stamped createdAt and lastEditedAt (labels included), never a client `updated`', async () => {
    const res = await run(w.dave, w.board, since(now - 2 * HOUR))
    expect(res.statusCode, res.body).toBe(200)
    expect(sentItems().map((i) => i.text)).toEqual([
      'Agenda for the review',
      'Decision: we go with plan B',
      'Sam will draft the brief',
      'Is pricing still open?',
    ])
    const user = lastRequest().body.messages?.find((m) => m.role === 'user')?.content ?? ''
    expect(user).toContain('"Sprint review"')
    expect(recapOf(res).windowFrom).toBe(now - 2 * HOUR)
    // a window after everything: nothing to send, nothing reserved
    expectError(await run(w.dave, w.board, since(now + HOUR)), 400, 'AI_NOTHING_TO_SEND')
    expect(await usageRows(w.api)).toHaveLength(1)
  })

  it('a `since` 30 days back is clamped to 14: the 20-day-old note stays out, the 10-day-old one comes in', async () => {
    const res = await run(w.dave, w.board, since(now - 30 * DAY))
    expect(res.statusCode, res.body).toBe(200)
    // the clock runs on (test clock = wall clock + offset): within the run's own few milliseconds
    const from = recapOf(res).windowFrom ?? 0
    expect(from).toBeGreaterThanOrEqual(now - AI_RECAP_MAX_WINDOW_MS)
    expect(from).toBeLessThanOrEqual(w.api.clock.now().getTime() - AI_RECAP_MAX_WINDOW_MS)
    const texts = sentItems().map((i) => i.text)
    expect(texts).not.toContain('An old idea from last month')
    expect(texts).toContain('Sam will draft the brief')
  })

  it("a 'shapes' recap reads what is inside the named frames, with no window", async () => {
    const res = await run(w.dave, w.board, {
      action: 'recap',
      scope: { kind: 'shapes', shapeIds: [ref('F')] },
      mode: 'panel',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(recapOf(res).windowFrom).toBeNull()
    expect(sentItems()).toHaveLength(4)
  })
})

describe('a big board and odd windows (review of wave L)', () => {
  const grid = (k: number) => ({ x: (k % 60) * 220, y: Math.floor(k / 60) * 220 })

  it('6,000 old notes, then 3 made a minute ago: the 3 are the recap (no record is cut)', async () => {
    const elements: Record<string, unknown>[] = []
    for (let k = 0; k < 6000; k++)
      elements.push(
        ...note(`old${k}`, `Old note ${k} about the offsite`, { ...grid(k), createdAt: now - 3 * DAY }),
      )
    for (const k of [1, 2, 3])
      elements.push(
        ...note(`fresh${k}`, `Fresh decision ${k} on pricing`, {
          x: k * 220,
          y: 50_000,
          createdAt: now - 60_000,
        }),
      )
    w.sync.setElements(w.board, elements)
    const res = await run(w.dave, w.board, since(now - HOUR))
    expect(res.statusCode, res.body).toBe(200)
    expect(recapOf(res).truncated).toBe(false)
    expect(sentItems().map((i) => i.text)).toEqual([1, 2, 3].map((k) => `Fresh decision ${k} on pricing`))
  })

  it('more in the window than fits: the most recently edited go, in reading order, and `truncated` says so', async () => {
    const elements: Record<string, unknown>[] = []
    // all made 2 h ago; note k's words typed k seconds after that (the newest are last in the snapshot)
    for (let k = 0; k < 6000; k++)
      elements.push(
        ...note(`m${k}`, `Note ${k}`, {
          ...grid(k),
          createdAt: now - 2 * HOUR,
          editedAt: now - 2 * HOUR + k * 1000,
        }),
      )
    w.sync.setElements(w.board, elements)
    const res = await run(w.dave, w.board, since(now - 3 * HOUR))
    expect(res.statusCode, res.body).toBe(200)
    expect(recapOf(res).truncated).toBe(true)
    const texts = sentItems().map((i) => i.text)
    expect(texts.length).toBeGreaterThan(100)
    expect(texts).toEqual(Array.from({ length: texts.length }, (_, i) => `Note ${6000 - texts.length + i}`))
    expect(sentItems()[0]?.id).toBe('n1')
  })
})

describe('votes', () => {
  it('an open or closed but unrevealed vote contributes nothing; once revealed, votes:n and the top voted list (ties share a rank)', async () => {
    const vote = await startVote(w.alice, w.board)
    await cast(w.bob, vote, ref('a'), 3)
    await cast(w.carol, vote, ref('b'), 2)
    await cast(w.dave, vote, ref('d'), 2)

    const open = await run(w.dave, w.board, since(now - 2 * HOUR))
    expect(open.statusCode, open.body).toBe(200)
    expect(recapOf(open).topVoted).toEqual([])
    expect(sentItems().every((i) => i.votes === undefined)).toBe(true)
    expect(JSON.stringify(lastRequest().body)).not.toContain('\\"votes\\":')

    await closeVote(w.alice, vote)
    const closed = await run(w.dave, w.board, since(now - 2 * HOUR))
    expect(recapOf(closed).topVoted).toEqual([])
    expect(sentItems().every((i) => i.votes === undefined)).toBe(true)

    await revealVote(w.alice, vote)
    const revealed = await run(w.dave, w.board, since(now - 2 * HOUR))
    expect(revealed.statusCode, revealed.body).toBe(200)
    expect(recapOf(revealed).topVoted).toEqual([
      { id: ref('a'), votes: 3, rank: 1 },
      { id: ref('b'), votes: 2, rank: 2 },
      { id: ref('d'), votes: 2, rank: 2 },
    ])
    expect(Object.fromEntries(sentItems().map((i) => [i.text, i.votes]))).toEqual({
      'Agenda for the review': undefined,
      'Decision: we go with plan B': 3,
      'Sam will draft the brief': 2,
      'Is pricing still open?': 2,
    })
  })

  it('the top voted list comes from the tallies, whatever the model says about votes', async () => {
    const vote = await startVote(w.alice, w.board)
    await cast(w.bob, vote, ref('d'), 4)
    await revealVote(w.alice, vote)
    w.openai.next({
      kind: 'content',
      content: {
        title: 'Recap',
        summary: 'The team voted for n2 with 99 votes.',
        decisions: [],
        actions: [],
        questions: [],
        topVoted: [{ id: 'n2', votes: 99 }],
      },
    })
    const r = recapOf(await run(w.dave, w.board, since(now - 2 * HOUR)))
    expect(r.topVoted).toEqual([{ id: ref('d'), votes: 4, rank: 1 }])
  })
})

describe('what is sent', () => {
  it('a prompt snapshot holds no comment, private draft or author name', async () => {
    const thread = await w.bob.req('POST', `/api/boards/${w.board}/threads`, {
      anchor: { kind: 'shape', shapeId: ref('a'), u: 0.5, v: 0.5 },
      body: 'COMMENT-SECRET only for the thread',
    })
    expect(thread.statusCode, thread.body).toBe(201)
    const started = await w.alice.req('POST', `/api/boards/${w.board}/private-brainstorm`, {
      prompt: 'What should we stop doing?',
      anonymous: false,
      target: { frameId: ref('F'), pageId: 'page:page', x: 100, y: 200, w: 1120, h: 720 },
    })
    expect(started.statusCode, started.body).toBe(201)
    const sid = (started.json() as { session: { id: string } }).session.id
    const draft = await w.bob.req('POST', `/api/private-brainstorms/${sid}/notes`, {
      text: 'DRAFT-SECRET idea nobody may read',
      color: 'yellow',
    })
    expect(draft.statusCode, draft.body).toBe(201)

    const res = await run(w.dave, w.board, since(now - 2 * HOUR))
    expect(res.statusCode, res.body).toBe(200)
    const body = JSON.stringify(lastRequest().body)
    for (const secret of [
      'COMMENT-SECRET',
      'DRAFT-SECRET',
      AUTHOR.name,
      AUTHOR.uid,
      w.bob.me.user.name,
      'SECRET-plan.png',
      'shape:',
    ])
      expect(body, secret).not.toContain(secret)
  })
})

describe('the plan', () => {
  it('keeps only aliases that were sent and owners the items name verbatim; clamps every list', async () => {
    const many = (n: number, make: (k: number) => Record<string, unknown>) =>
      Array.from({ length: n }, (_, k) => make(k))
    w.openai.next({
      kind: 'content',
      content: {
        title: `  A very long title ${'x'.repeat(200)}`,
        summary: 'We met and decided.',
        decisions: many(20, (k) => ({ text: `Decision ${k}`, ids: ['n1', 'n99', 'shape:c'] })),
        actions: [
          { task: 'Draft the brief', owner: 'Sam', ids: ['n3'] },
          { task: 'Invent an owner', owner: 'Taylor', ids: ['n2'] },
          { task: 'A partial name', owner: 'Sa', ids: [] },
          ...many(20, (k) => ({ task: `Task ${k}`, owner: null, ids: ['n4'] })),
        ],
        questions: many(20, (k) => ({ text: `Question ${k}`, ids: ['n4', 'n4', 'n42'] })),
      },
    })
    const r = recapOf(await run(w.dave, w.board, since(now - 2 * HOUR)))
    const items = sentItems()
    const idOf = (alias: string) => {
      const i = items.findIndex((x) => x.id === alias)
      return i
    }
    expect(idOf('n1')).toBe(0)
    expect(r.title.length).toBeLessThanOrEqual(80)
    expect(r.decisions).toHaveLength(AI_RECAP_DECISIONS_MAX)
    // n1 is the agenda text (reading order); n99 and a real id copied from a note match nothing
    for (const d of r.decisions) expect(d.ids).toEqual([ref('e')])
    expect(r.actions).toHaveLength(AI_RECAP_ACTIONS_MAX)
    expect(r.actions.slice(0, 3)).toEqual([
      { task: 'Draft the brief', owner: 'Sam', ids: [ref('b')] },
      { task: 'Invent an owner', owner: null, ids: [ref('a')] },
      { task: 'A partial name', owner: null, ids: [] },
    ])
    expect(r.questions).toHaveLength(AI_RECAP_QUESTIONS_MAX)
    for (const q of r.questions) expect(q.ids).toEqual([ref('d')])
  })

  it('an answer without a summary is refused (502 AI_BAD_OUTPUT), and the call still counts', async () => {
    w.openai.next({
      kind: 'content',
      content: { title: 'x', summary: '', decisions: [], actions: [], questions: [] },
    })
    expectError(await run(w.dave, w.board, since(now - 2 * HOUR)), 502, 'AI_BAD_OUTPUT')
    expect((await usageRows(w.api)).map((r) => [r.action, r.status])).toEqual([['recap', 'failed']])
  })
})

describe('who may recap', () => {
  it('a viewer gets the panel (200) but not insert (403); an editor may insert; a guest gets 403', async () => {
    expect((await run(w.dave, w.board, since(now - 2 * HOUR))).statusCode).toBe(200)
    expectError(await run(w.dave, w.board, { ...since(now - 2 * HOUR), mode: 'insert' }), 403, 'FORBIDDEN')
    expect((await run(w.bob, w.board, { ...since(now - 2 * HOUR), mode: 'insert' })).statusCode).toBe(200)
    const link = await guestLink(w.alice, w.board, { role: 'editor' })
    const guest = await joinAsGuest(w.api, link.url, 'Sam')
    expectError(await run(guest, w.board, since(now - 2 * HOUR)), 403, 'GUEST_ACCOUNT_REQUIRED')
    expect(w.openai.requests).toHaveLength(2)
  })

  it('export policy "editors": a viewer gets 403 AI_EXPORT_DISABLED, nothing is sent', async () => {
    const res = await w.alice.req('PUT', `/api/boards/${w.board}/export-policy`, { exportPolicy: 'editors' })
    expect(res.statusCode, res.body).toBe(200)
    expectError(await run(w.dave, w.board, since(now - 2 * HOUR)), 403, 'AI_EXPORT_DISABLED')
    expect(w.openai.requests).toHaveLength(0)
  })

  it('the board switch turned off between the gate and the send: no OpenAI call', async () => {
    const original = w.sync.snapshot
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let reached = () => {}
    const reading = new Promise<void>((r) => {
      reached = r
    })
    w.sync.snapshot = async (boardId) => {
      reached()
      await gate
      return original(boardId)
    }
    const pending = run(w.dave, w.board, since(now - 2 * HOUR))
    await reading
    expect(
      (await w.alice.req('PUT', `/api/boards/${w.board}/ai/settings`, { enabled: false })).statusCode,
    ).toBe(200)
    release()
    expectError(await pending, 403, 'AI_BOARD_OFF')
    expect(w.openai.requests).toHaveLength(0)
    expect(await usageRows(w.api)).toHaveLength(0)
  })
})
