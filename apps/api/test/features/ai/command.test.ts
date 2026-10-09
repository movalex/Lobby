// Wave L (W1, L1-4): plain-language board commands, the AI fallback of the local grammar. The api sends a
// compact index (alias, type, Lobby colour name, frame alias, tag names, text cut to 120) of the selection
// or the whole board, at most 400 items; the plan keeps only ops of the closed AiCommandOp set (no delete,
// unlock, ungroup or text op), ids from this call's aliases only (200 per op at most), 12 ops at most, and
// in 'find' mode only select and zoomTo. 'find' needs view, 'do' needs edit.

import { AI_COMMAND_MAX_IDS_PER_OP, AI_COMMAND_MAX_OPS, AiResult } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_ITEMS } from '../../../src/features/ai/sources.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { frame, image, note, ref, shape } from './elements.ts'
import { itemsOf } from './fake-openai.ts'
import { type AiWorld, aiWorld, expectError, run } from './support.ts'

let w: AiWorld | undefined
afterEach(async () => {
  await w?.close()
  w = undefined
})

async function world() {
  const x = await aiWorld()
  x.sync.setElements(x.board, [
    ...frame('F', 'Pricing ideas', { x: 0, y: 0 }),
    // red note fill, tagged
    ...note('a', 'Raise the price', {
      frameId: 'F',
      x: 100,
      y: 100,
      backgroundColor: '#ef8c82',
      lobby: { 'tag:research': { name: 'Research', color: 'blue' } },
    }),
    ...note('b', `A long note ${'word '.repeat(60)}`, { frameId: 'F', x: 320, y: 100 }),
    // a blue rectangle outside the frame
    ...shape('s', 'Budget box', { x: 2000, y: 0, strokeColor: '#4465e9' }),
    ...note('blank', '', { x: 2300, y: 0, backgroundColor: '#a6d8f3' }),
    ...image('img', { x: 2600, y: 0 }),
  ])
  w = x
  return x
}
const cmd = (instruction: string, mode: 'find' | 'do' = 'do', shapeIds: string[] = []) => ({
  action: 'command',
  instruction,
  mode,
  shapeIds,
})
const commandOf = (res: { json(): unknown }) => {
  const r = AiResult.parse(res.json())
  if (r.action !== 'command') throw new Error(r.action)
  return r
}
type IndexLine = {
  id: string
  type: string
  text: string
  color: string | null
  frame: string | null
  tags: string[]
}

describe('the index', () => {
  it('per item: alias, type, Lobby colour name, frame alias, tag names, text cut to 120; frames first; no file names', async () => {
    const x = await world()
    expect((await run(x.bob, x.board, cmd('make the red notes yellow'))).statusCode).toBe(200)
    const lines = itemsOf(x.openai.requests.at(-1) as never) as unknown as IndexLine[]
    expect(lines.map((l) => [l.id, l.type, l.color, l.frame, l.tags])).toEqual([
      ['n1', 'frame', null, null, []],
      ['n2', 'note', 'red', 'n1', ['Research']],
      ['n3', 'note', 'yellow', 'n1', []],
      ['n4', 'shape', 'blue', null, []],
      ['n5', 'note', 'light-blue', null, []],
      ['n6', 'image', null, null, []],
    ])
    expect(lines[0]?.text).toBe('Pricing ideas')
    expect([...(lines[2]?.text ?? '')].length).toBeLessThanOrEqual(120)
    expect(lines[5]?.text).toBe('')
    const body = JSON.stringify(x.openai.requests.at(-1)?.body)
    expect(body).not.toContain('SECRET-plan.png')
    expect(body).not.toContain('shape:')
    expect(body).toContain('"lobby_command"')
  })

  it('a selection is the frame and what is inside it; a board too big is cut at 400 items, truncated', async () => {
    const x = await world()
    expect((await run(x.bob, x.board, cmd('line these up', 'do', [ref('F')]))).statusCode).toBe(200)
    expect((itemsOf(x.openai.requests.at(-1) as never) as unknown as IndexLine[]).map((l) => l.type)).toEqual(
      ['frame', 'note', 'note'],
    )
    const many: Record<string, unknown>[] = []
    for (let k = 0; k < 450; k++)
      many.push(...note(`m${k}`, `n ${k}`, { x: (k % 30) * 220, y: Math.floor(k / 30) * 220 }))
    x.sync.setElements(x.board, many)
    const res = await run(x.bob, x.board, cmd('select everything'))
    expect(res.statusCode, res.body).toBe(200)
    expect(commandOf(res).truncated).toBe(true)
    expect(itemsOf(x.openai.requests.at(-1) as never).length).toBeLessThanOrEqual(MAX_ITEMS)
  })

  it('a board too big for the index: frames first, then the objects most relevant to the instruction', async () => {
    const x = await world()
    const many: Record<string, unknown>[] = [...frame('G', 'Week plan', { x: 0, y: 0, w: 400, h: 400 })]
    for (let k = 0; k < 1200; k++)
      many.push(
        ...note(`m${k}`, `Filler ${k} about catering`, { x: (k % 30) * 220, y: Math.floor(k / 30) * 220 }),
      )
    // the last three objects of the board, far down: invisible to a reading-order cut at 400
    for (const k of [1, 2, 3])
      many.push(...note(`p${k}`, `Pricing note ${k}`, { x: k * 220, y: 100_000, backgroundColor: '#ef8c82' }))
    x.sync.setElements(x.board, many)
    const res = await run(x.dave, x.board, cmd('find the pricing notes', 'find'))
    expect(res.statusCode, res.body).toBe(200)
    expect(commandOf(res).truncated).toBe(true)
    const lines = itemsOf(x.openai.requests.at(-1) as never) as unknown as IndexLine[]
    expect(lines.length).toBeLessThanOrEqual(MAX_ITEMS)
    expect(lines.slice(0, 4).map((l) => [l.id, l.type, l.text])).toEqual([
      ['n1', 'frame', 'Week plan'],
      ['n2', 'note', 'Pricing note 1'],
      ['n3', 'note', 'Pricing note 2'],
      ['n4', 'note', 'Pricing note 3'],
    ])
    // an instruction no object matches keeps the reading order
    expect((await run(x.dave, x.board, cmd('select everything', 'find'))).statusCode).toBe(200)
    const plain = itemsOf(x.openai.requests.at(-1) as never).map((l) => l.text)
    expect(plain.slice(0, 2)).toEqual(['Week plan', 'Filler 0 about catering'])
    expect(plain).not.toContain('Pricing note 1')
  })
})

describe('the plan', () => {
  it('drops unknown and destructive ops, ids that were not sent, palette-less colours and bad tags; caps at 12 ops', async () => {
    const x = await world()
    x.openai.next({
      kind: 'content',
      content: {
        ops: [
          { op: 'delete', ids: ['n2'] },
          { op: 'unlock', ids: ['n2'] },
          { op: 'ungroup', ids: ['n2'] },
          { op: 'setText', ids: ['n2'], text: 'pwned' },
          { op: 'select', ids: ['n2', 'n99', 'shape:secret', 'n2'] },
          { op: 'select', ids: ['n404'] },
          { op: 'recolor', ids: ['n3'], color: '#ff0000' },
          { op: 'recolor', ids: ['n3'], color: 'yellow' },
          { op: 'tag', ids: ['n3'], tag: '#Research' },
          { op: 'tag', ids: ['n3'], tag: 'x'.repeat(40) },
          { op: 'wrapInFrame', ids: ['n3', 'n4'], name: '  Next steps  ' },
          { op: 'align', ids: ['n3', 'n4'], edge: 'diagonal' },
          { op: 'align', ids: ['n3', 'n4'], edge: 'left' },
          ...Array.from({ length: 20 }, () => ({ op: 'zoomTo', ids: ['n1'] })),
        ],
        explain: 'Done.',
      },
    })
    const r = commandOf(await run(x.bob, x.board, cmd('make it so')))
    expect(r.ops).toHaveLength(AI_COMMAND_MAX_OPS)
    expect(r.ops.slice(0, 5)).toEqual([
      { op: 'select', ids: [ref('a')] },
      { op: 'recolor', ids: [ref('b')], color: 'yellow' },
      { op: 'tag', ids: [ref('b')], tag: 'Research' },
      { op: 'wrapInFrame', ids: [ref('b'), ref('s')], name: 'Next steps' },
      { op: 'align', ids: [ref('b'), ref('s')], edge: 'left' },
    ])
    expect(r.ops.slice(5).every((o) => o.op === 'zoomTo')).toBe(true)
    expect(JSON.stringify(r)).not.toMatch(/delete|unlock|ungroup|setText|pwned|secret/)
    expect(r.explain).toBe('Done.')
  })

  it("'find' mode: write ops are refused, only select and zoomTo come back", async () => {
    const x = await world()
    x.openai.next({
      kind: 'content',
      content: {
        ops: [
          { op: 'recolor', ids: ['n2'], color: 'red' },
          { op: 'lock', ids: ['n2'] },
          { op: 'select', ids: ['n2', 'n3'] },
          { op: 'arrangeGrid', ids: ['n2', 'n3'] },
          { op: 'zoomTo', ids: ['n2'] },
        ],
        explain: 'Found two notes',
      },
    })
    const r = commandOf(await run(x.dave, x.board, cmd('find the pricing notes', 'find')))
    expect(r.mode).toBe('find')
    expect(r.ops).toEqual([
      { op: 'select', ids: [ref('a'), ref('b')] },
      { op: 'zoomTo', ids: [ref('a')] },
    ])
  })

  it('at most 200 ids per op', async () => {
    const x = await aiWorld()
    w = x
    const many: Record<string, unknown>[] = []
    for (let k = 0; k < 260; k++)
      many.push(...note(`m${k}`, '', { x: (k % 30) * 220, y: Math.floor(k / 30) * 220 }))
    x.sync.setElements(x.board, many)
    x.openai.next({
      kind: 'content',
      content: {
        ops: [{ op: 'select', ids: Array.from({ length: 260 }, (_, k) => `n${k + 1}`) }],
        explain: '',
      },
    })
    const r = commandOf(await run(x.bob, x.board, cmd('select all the notes')))
    expect(r.ops[0]?.ids).toHaveLength(AI_COMMAND_MAX_IDS_PER_OP)
  })
})

describe('who may command', () => {
  it("a viewer gets 200 for 'find' and 403 for 'do'; a guest 403; an instruction of 201 characters is a 400", async () => {
    const x = await world()
    expect((await run(x.dave, x.board, cmd('find the budget', 'find'))).statusCode).toBe(200)
    expectError(await run(x.dave, x.board, cmd('make them red', 'do')), 403, 'FORBIDDEN')
    expect((await run(x.bob, x.board, cmd('make them red', 'do'))).statusCode).toBe(200)
    const link = await guestLink(x.alice, x.board, { role: 'editor' })
    const guest = await joinAsGuest(x.api, link.url, 'Sam')
    expectError(await run(guest, x.board, cmd('find the budget', 'find')), 403, 'GUEST_ACCOUNT_REQUIRED')
    expectError(await run(x.bob, x.board, cmd('x'.repeat(201))), 400, 'BAD_REQUEST')
    expect((await run(x.bob, x.board, cmd('x'.repeat(200)))).statusCode).toBe(200)
    expect(x.openai.requests).toHaveLength(3)
  })
})
