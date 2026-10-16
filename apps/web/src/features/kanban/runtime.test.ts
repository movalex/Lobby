// The Kanban drop runtime: the actor's move writes position + status as part of its own step (joinPrevious); a
// receiving client, this tab's undo/redo and a dragged frame write nothing (the echo rule).
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasChange, CanvasElement } from '../../canvas/api/index.ts'
import { atom } from '../../lib/signals.ts'
import { KANBAN_HEADER_H, KANBAN_PAD } from './layout.ts'
import { KanbanRuntime, type RuntimeCanvas } from './runtime.ts'

type Mutable = { -readonly [K in keyof CanvasElement]: CanvasElement[K] }
const TOP = KANBAN_HEADER_H + KANBAN_PAD

function setup(opts: { kanban?: boolean; cards?: boolean; lockedFrame?: boolean; label?: boolean } = {}) {
  const els = new Map<string, Mutable>()
  const put = (e: Partial<Mutable> & { id: string; type: string }) =>
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
  put({
    id: 'k',
    type: 'frame',
    x: 0,
    y: 0,
    width: 1500,
    height: 900,
    locked: !!opts.lockedFrame,
    customData: { lobby: { kanban: {} } },
  })
  put({
    id: 'c1',
    type: 'stickynote',
    x: 50,
    y: TOP,
    frameId: 'k',
    customData: { lobby: { 'card:status': 'todo' } },
    ...(opts.label ? { boundElements: [{ id: 'c1.t', type: 'text' }] } : {}),
  } as Partial<Mutable> & { id: string; type: string })
  if (opts.label)
    put({
      id: 'c1.t',
      type: 'text',
      x: 60,
      y: TOP + 10,
      width: 180,
      height: 30,
      frameId: 'k',
      containerId: 'c1',
    } as Partial<Mutable> & { id: string; type: string })
  put({ id: 'n1', type: 'stickynote', x: 2000, y: 0 })
  const gesture = atom<'idle' | 'dragging'>('test.gesture', 'idle')
  const listeners: ((c: CanvasChange) => void)[] = []
  const writes: { label: string; join: boolean; ops: unknown[] }[] = []
  const live = () => [...els.values()].filter((e) => !e.isDeleted) as CanvasElement[]
  const canvas: RuntimeCanvas = {
    get: (id) => els.get(id) as CanvasElement | undefined,
    index: {
      notes: () => live().filter((e) => e.type === 'stickynote'),
      byType: (t: string) => live().filter((e) => e.type === t),
      byFrame: (f: string) => live().filter((e) => e.frameId === f),
      withLobbyKey: (k: string) => live().filter((e) => k in (e.customData?.lobby ?? {})),
      withLobbyKeyPrefix: () => [],
      byKind: () => [],
      count: () => els.size,
      onChanged: () => () => {},
    },
    transact: ((label: string, fn: (tx: unknown) => unknown, o?: { joinPrevious?: boolean }) => {
      const ops: unknown[] = []
      fn({
        update: (id: string, patch: unknown) => ops.push(['update', id, patch]),
        setFrame: (ids: string[], f: string | null) => ops.push(['setFrame', ids, f]),
      })
      writes.push({ label, join: o?.joinPrevious === true, ops })
    }) as RuntimeCanvas['transact'],
    isLocked: (id) => els.get(id)?.locked === true,
    on: ((event: string, l: (c: CanvasChange) => void) => {
      if (event === 'change') listeners.push(l)
      return () => {}
    }) as RuntimeCanvas['on'],
    gesture: () => gesture.get(),
    editingId: () => null,
  }
  const rt = new KanbanRuntime(canvas, {
    kanbanOffered: () => opts.kanban !== false,
    cardsOffered: () => opts.cards !== false,
  })
  const stop = rt.start()
  const change = (source: CanvasChange['source'], updated: string[]) => {
    for (const l of listeners) l({ source, created: [], updated, deleted: [] })
  }
  const move = (id: string, patch: Partial<Mutable>) => Object.assign(els.get(id) as Mutable, patch)
  return { rt, stop, change, move, writes, gesture, els }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('the Kanban drop runtime', () => {
  it('this person’s drag into another column: position and status, folded into the drag’s step', async () => {
    const t = setup()
    cleanup = t.stop
    t.gesture.set('dragging')
    t.move('c1', { x: 380, y: 300 })
    t.change('local', ['c1'])
    await settle()
    expect(t.writes).toEqual([]) // nothing while the gesture is on
    t.gesture.set('idle')
    await settle()
    expect(t.writes).toEqual([
      {
        label: 'kanban: drop',
        join: true,
        ops: [['update', 'c1', { x: 350, y: 300, customData: { lobby: { 'card:status': 'doing' } } }]],
      },
    ])
    // its own write comes back as a local change: nothing more to do
    t.move('c1', { x: 350, customData: { lobby: { 'card:status': 'doing' } } })
    t.change('local', ['c1'])
    await settle()
    expect(t.writes).toHaveLength(1)
  })

  it('the snap moves the card’s bound label by the same delta, in the same write', async () => {
    const t = setup({ label: true })
    cleanup = t.stop
    // the drag moved the card and its label together
    t.move('c1', { x: 380, y: 300 })
    t.move('c1.t', { x: 390, y: 310 })
    t.change('local', ['c1', 'c1.t'])
    await settle()
    expect(t.writes).toEqual([
      {
        label: 'kanban: drop',
        join: true,
        ops: [
          ['update', 'c1', { x: 350, y: 300, customData: { lobby: { 'card:status': 'doing' } } }],
          ['update', 'c1.t', { x: 360, y: 310 }],
        ],
      },
    ])
  })

  it('a receiving client and this tab’s own undo/redo write nothing (a mismatch stays a mismatch)', async () => {
    const t = setup()
    cleanup = t.stop
    t.move('c1', { x: 1280, y: 300 })
    t.change('remote', ['c1'])
    await settle()
    t.move('c1', { x: 680 })
    t.change('history', ['c1'])
    await settle()
    expect(t.writes).toEqual([])
  })

  it('a dragged Kanban moves its cards on the board, not in the frame: no drop', async () => {
    const t = setup()
    cleanup = t.stop
    t.move('k', { x: 500, y: 100 })
    t.move('c1', { x: 550, y: 100 + TOP })
    t.change('local', ['k', 'c1'])
    await settle()
    expect(t.writes).toEqual([])
  })

  it('a plain note dropped onto a Kanban joins it as a card of that column; not without the cards switch', async () => {
    const t = setup()
    cleanup = t.stop
    t.move('n1', { x: 1210, y: 400 })
    t.change('local', ['n1'])
    await settle()
    expect(t.writes[0]?.ops).toEqual([
      ['setFrame', ['n1'], 'k'],
      ['update', 'n1', { x: 1250, y: 400, customData: { lobby: { 'card:status': 'done' } } }],
    ])
    const u = setup({ cards: false })
    u.move('n1', { x: 1210, y: 400 })
    u.change('local', ['n1'])
    await settle()
    expect(u.writes).toEqual([])
    u.stop()
  })

  it('writes nothing when Kanbans are not offered or the frame is locked', async () => {
    for (const o of [{ kanban: false }, { lockedFrame: true }]) {
      const t = setup(o)
      t.move('c1', { x: 380, y: 300 })
      t.change('local', ['c1'])
      await settle()
      expect(t.writes).toEqual([])
      t.stop()
    }
  })
})
