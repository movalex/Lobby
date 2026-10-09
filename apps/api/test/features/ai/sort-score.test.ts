// Wave L (W1, L1-6): sort by a lens and 2x2 scores. Both read what "Group into themes" reads (unlocked team
// notes with text; a template's prompt notes stay out, contracts splitThemeNotes), both need edit, and both
// save a before_ai_themes checkpoint before their plan returns (they move notes). sort reuses the themes
// plan (AI_THEMES_MAX, 'Other', each note once); score returns, per note sent, whole numbers from -5 to 5,
// a note the model left out at 0,0 with `unscored`.

import { AI_OTHER_THEME, AI_THEMES_MAX, AiResult } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { frame, note, ref } from './elements.ts'
import { itemsOf } from './fake-openai.ts'
import { type AiWorld, aiWorld, expectError, run } from './support.ts'

let w: AiWorld | undefined
afterEach(async () => {
  await w?.close()
  w = undefined
})

const axes = [
  { name: 'Impact', low: 'Low', high: 'High' },
  { name: 'Effort', low: 'Easy', high: 'Hard' },
]

async function world() {
  const x = await aiWorld()
  x.sync.setElements(x.board, [
    ...frame('F', 'Prioritise', { x: 0, y: 0 }),
    ...note('a', 'Fix the login bug', { frameId: 'F', x: 100, y: 300 }),
    ...note('b', 'Redesign the dashboard', { frameId: 'F', x: 320, y: 300 }),
    ...note('c', 'Add dark mode', { frameId: 'F', x: 540, y: 300 }),
    // a template's prompt note, and one nobody typed (unattributed and unmarked) next to team notes
    ...note('p', 'What should we do first?', { frameId: 'F', x: 100, y: 0, lobby: { prompt: true } }),
    ...note('t', 'Template sample idea', { frameId: 'F', x: 320, y: 0, typedBy: null }),
    ...note('l', 'A locked note', { frameId: 'F', x: 760, y: 300, locked: true }),
  ])
  w = x
  return x
}
const sort = (lens = 'urgency') => ({ action: 'sort', shapeIds: [ref('F')], lens })
const score = () => ({ action: 'score', shapeIds: [ref('F')], axes })
const checkpoints = async (x: AiWorld) =>
  (
    await x.api.db.query<{ name: string }>(
      `SELECT name FROM board_snapshots WHERE board_id = $1 AND kind = 'auto' ORDER BY created_at, id`,
      [x.board],
    )
  ).rows.map((r) => r.name)

describe('what is sent', () => {
  it('the themes rules: unlocked team notes only; prompt, template and locked notes stay out', async () => {
    const x = await world()
    for (const body of [sort(), score()]) {
      const res = await run(x.bob, x.board, body)
      expect(res.statusCode, res.body).toBe(200)
      expect(itemsOf(x.openai.requests.at(-1) as never).map((i) => i.text)).toEqual([
        'Fix the login bug',
        'Redesign the dashboard',
        'Add dark mode',
      ])
    }
    expect(x.openai.requests.map((r) => r.body.response_format?.json_schema?.name)).toEqual([
      'lobby_sort',
      'lobby_score',
    ])
    const user = x.openai.requests[1]?.body.messages?.find((m) => m.role === 'user')?.content ?? ''
    expect(user).toContain('"Impact"')
    expect(user).toContain('"Hard"')
  })

  it('too few notes: sort needs two, score one (400 AI_NOTHING_TO_GROUP); nothing sent', async () => {
    const x = await world()
    expectError(
      await run(x.bob, x.board, { action: 'sort', shapeIds: [ref('a')], lens: 'urgency' }),
      400,
      'AI_NOTHING_TO_GROUP',
    )
    expectError(
      await run(x.bob, x.board, { action: 'score', shapeIds: [ref('p')], axes }),
      400,
      'AI_NOTHING_TO_GROUP',
    )
    expect(x.openai.requests).toHaveLength(0)
    expect((await run(x.bob, x.board, { action: 'score', shapeIds: [ref('a')], axes })).statusCode).toBe(200)
  })
})

describe('sort', () => {
  it('follows the themes plan: each note once, unknown ids dropped, the rest in Other, at most 8 columns', async () => {
    const x = await aiWorld()
    w = x
    const els: Record<string, unknown>[] = []
    for (let k = 0; k < 12; k++) els.push(...note(`s${k}`, `Idea ${k}`, { x: k * 220 }))
    x.sync.setElements(x.board, els)
    x.openai.next({
      kind: 'content',
      content: {
        themes: [
          ...Array.from({ length: 10 }, (_, k) => ({ name: `Lens ${k}`, note_ids: [`n${k + 1}`] })),
          { name: 'Again', note_ids: ['n1', 'n99', 'shape:s0'] },
        ],
      },
    })
    const res = await run(x.bob, x.board, {
      action: 'sort',
      shapeIds: els.filter((e) => e.type === 'stickynote').map((e) => ref(e.id as string)),
      lens: 'how soon',
    })
    expect(res.statusCode, res.body).toBe(200)
    const r = AiResult.parse(res.json())
    if (r.action !== 'sort') throw new Error(r.action)
    expect(r.lens).toBe('how soon')
    expect(r.themes.length).toBeLessThanOrEqual(AI_THEMES_MAX)
    expect(r.themes.at(-1)?.name).toBe(AI_OTHER_THEME)
    const all = r.themes.flatMap((t) => t.noteIds)
    expect(all).toHaveLength(12)
    expect(new Set(all).size).toBe(12)
  })
})

describe('score', () => {
  it('clamps to -5..5 (whole numbers), drops aliases not sent, flags missing notes at 0,0; echoes the axes', async () => {
    const x = await world()
    x.openai.next({
      kind: 'content',
      content: {
        scores: [
          { id: 'n1', x: 9, y: -12 },
          { id: 'n2', x: 2.6, y: -0.4 },
          { id: 'n99', x: 1, y: 1 },
          { id: 'shape:c', x: 1, y: 1 },
          { id: 'n1', x: 0, y: 0 },
          { id: 'n3', x: 'high', y: 2 },
        ],
      },
    })
    const res = await run(x.bob, x.board, score())
    expect(res.statusCode, res.body).toBe(200)
    const r = AiResult.parse(res.json())
    if (r.action !== 'score') throw new Error(r.action)
    expect(r.axes).toEqual(axes)
    expect(r.scores).toEqual([
      { id: ref('a'), x: 5, y: -5 },
      { id: ref('b'), x: 3, y: 0 },
      { id: ref('c'), x: 0, y: 0, unscored: true },
    ])
  })

  it('an answer that scores nothing usable is refused (502)', async () => {
    const x = await world()
    x.openai.next({ kind: 'content', content: { scores: [{ id: 'n77', x: 1, y: 1 }] } })
    expectError(await run(x.bob, x.board, score()), 502, 'AI_BAD_OUTPUT')
    expect(await checkpoints(x)).toEqual([])
  })
})

describe('the checkpoint', () => {
  it('sort and score save one before their plan returns; the board unchanged since, the next one is skipped', async () => {
    const x = await world()
    expect((await run(x.bob, x.board, sort())).statusCode).toBe(200)
    expect(await checkpoints(x)).toEqual(['Before AI grouped 3 notes in Prioritise'])
    expect((await run(x.bob, x.board, score())).statusCode).toBe(200)
    expect(await checkpoints(x)).toHaveLength(1)
    // the board changed (the client applied the plan): the next run saves it first
    x.sync.setElements(x.board, [
      ...note('a', 'Fix the login bug', { x: 900 }),
      ...note('b', 'Moved', { x: 1200 }),
    ])
    expect(
      (await run(x.bob, x.board, { action: 'score', shapeIds: [ref('a'), ref('b')], axes })).statusCode,
    ).toBe(200)
    expect(await checkpoints(x)).toEqual([
      'Before AI grouped 3 notes in Prioritise',
      'Before AI grouped 2 notes into themes',
    ])
  })
})

describe('who may sort and score', () => {
  it('needs edit: viewer 403, guest 403; nothing sent', async () => {
    const x = await world()
    for (const body of [sort(), score()]) expectError(await run(x.dave, x.board, body), 403, 'FORBIDDEN')
    const link = await guestLink(x.alice, x.board, { role: 'editor' })
    const guest = await joinAsGuest(x.api, link.url, 'Sam')
    for (const body of [sort(), score()])
      expectError(await run(guest, x.board, body), 403, 'GUEST_ACCOUNT_REQUIRED')
    expectError(
      await run(x.bob, x.board, { action: 'score', shapeIds: [ref('a')], axes: [axes[0]] }),
      400,
      'BAD_REQUEST',
    )
    expectError(await run(x.bob, x.board, sort('x'.repeat(81))), 400, 'BAD_REQUEST')
    expect(x.openai.requests).toHaveLength(0)
  })
})
