// Kanban code that moves a card (Tidy, a status change into its column) moves the card's bound label by the same
// delta in the same write: the server re-fits a label only when a text lease ends, so a label left behind would
// stay behind for everyone.
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../canvas/api/index.ts'
import { setStatus } from '../cards/write.ts'
import { KANBAN_HEADER_H, KANBAN_PAD } from './layout.ts'
import { tidyKanban } from './write.ts'

type Mutable = { -readonly [K in keyof CanvasElement]: CanvasElement[K] }
type Canvas = Parameters<typeof tidyKanban>[0] & Parameters<typeof setStatus>[0]
const TOP = KANBAN_HEADER_H + KANBAN_PAD

function setup() {
  const els = new Map<string, Mutable>()
  const put = (e: Record<string, unknown> & { id: string; type: string }) =>
    els.set(e.id, {
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      angle: 0,
      groupIds: [],
      frameId: null,
      locked: false,
      isDeleted: false,
      customData: { lobby: {} },
      ...e,
    } as unknown as Mutable)
  put({ id: 'k', type: 'frame', width: 1500, height: 900, customData: { lobby: { kanban: {} } } })
  // a "done" card standing in the To do column, out of place: Tidy and a status change both move it
  put({
    id: 'c1',
    type: 'stickynote',
    x: 37,
    y: TOP + 300,
    frameId: 'k',
    customData: { lobby: { 'card:status': 'done' } },
    boundElements: [{ id: 'c1.t', type: 'text' }],
  })
  put({
    id: 'c1.t',
    type: 'text',
    x: 47,
    y: TOP + 320,
    width: 180,
    height: 30,
    frameId: 'k',
    containerId: 'c1',
  })
  const updates: [string, Record<string, unknown>][] = []
  const canvas = {
    get: (id: string) => els.get(id) as CanvasElement | undefined,
    index: {
      byFrame: (f: string) => [...els.values()].filter((e) => e.frameId === f && !e.isDeleted),
    },
    transact: (_label: string, fn: (tx: unknown) => unknown) =>
      fn({ update: (id: string, patch: Record<string, unknown>) => updates.push([id, patch]) }),
    isLocked: (id: string) => els.get(id)?.locked === true,
    readOnly: () => false,
    room: { contractsRev: () => 14 },
    viewport: {},
    select: () => {},
    selection: () => [],
  } as unknown as Canvas
  const moveOf = (id: string) =>
    updates.find(([u, p]) => u === id && 'x' in p)?.[1] as { x: number; y: number } | undefined
  return { canvas, updates, moveOf, els }
}

function expectLabelFollows(t: ReturnType<typeof setup>) {
  const card = t.moveOf('c1')
  const label = t.moveOf('c1.t')
  expect(card).toBeDefined()
  expect(label).toEqual({ x: 47 + ((card?.x ?? 0) - 37), y: TOP + 320 + ((card?.y ?? 0) - (TOP + 300)) })
}

describe('a card moved by Kanban code takes its label along', () => {
  it('Tidy', () => {
    const t = setup()
    expect(tidyKanban(t.canvas, 'k')).toBe(1)
    expectLabelFollows(t)
  })

  it('a status change moves the card to its column', () => {
    const t = setup()
    expect(setStatus(t.canvas, ['c1'], 'review')).toBe(1)
    expectLabelFollows(t)
  })
})
