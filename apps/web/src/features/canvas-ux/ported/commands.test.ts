// canvas-ux's commands (./commands.ts) on a fake canvas: the lock (MAK-05: the selection is kept, a frame
// locks what is inside it, labels with their containers), Unlock all, and the menus' Delete (a frame goes
// with what is inside it, a locked element never goes).
import { describe, expect, it } from 'vitest'
import type { CanvasElement, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { CMD, COMMANDS, lockTargets, toggleLock, unlockAll } from './commands.ts'

const el = (id: string, type: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    ...extra,
  }) as unknown as CanvasElement

function fake(els: CanvasElement[], selection: string[]) {
  const map = new Map(els.map((e) => [e.id, e]))
  const steps: { label: string; ops: [string, string, Record<string, unknown>?][] }[] = []
  let sel = selection
  const canvas = {
    get: (id: string) => map.get(id),
    items: () => [...map.values()].filter((e) => !(e as { isDeleted?: boolean }).isDeleted),
    get selection() {
      return sel
    },
    select: (ids: string[]) => {
      sel = ids
    },
    readOnly: () => false,
    focus: () => {},
    transact: (label: string, fn: (tx: unknown) => unknown) => {
      const ops: [string, string, Record<string, unknown>?][] = []
      const out = fn({
        update: (id: string, p: Record<string, unknown>) => {
          ops.push(['update', id, p])
          map.set(id, { ...(map.get(id) as CanvasElement), ...p } as CanvasElement)
        },
        delete: (id: string) => void ops.push(['delete', id]),
      })
      steps.push({ label, ops })
      return out
    },
  }
  const ctx = { canvas } as unknown as CanvasFeatureContext
  return { ctx, steps, map, selection: () => sel }
}

const scene = () => [
  el('f', 'frame'),
  el('n', 'stickynote', { frameId: 'f', boundElements: [{ id: 'nl', type: 'text' }] }),
  el('nl', 'text', { frameId: 'f', containerId: 'n' }),
  el('r', 'rectangle'),
  el('lk', 'rectangle', { frameId: 'f', locked: true }),
]

describe('lock', () => {
  it('a frame takes what is inside it and the labels; the selection is kept; one step', () => {
    const { ctx, steps, map, selection } = fake(scene(), ['f'])
    expect(lockTargets(ctx.canvas, [map.get('f') as CanvasElement]).sort()).toEqual(['f', 'lk', 'n', 'nl'])
    expect(toggleLock(ctx)).toBe(true)
    expect(steps).toHaveLength(1)
    // what was locked already is not written again
    expect(steps[0]?.ops.map(([, id]) => id).sort()).toEqual(['f', 'n', 'nl'])
    expect(selection()).toEqual(['f'])
    expect(toggleLock(ctx)).toBe(false)
    expect(map.get('lk')?.locked, 'unlocking the frame unlocks its contents').toBe(false)
  })

  it('a selected label counts as its note; Unlock all frees everything and selects it', () => {
    const { ctx, map, selection } = fake(scene(), ['nl'])
    toggleLock(ctx)
    expect([map.get('n')?.locked, map.get('nl')?.locked, map.get('f')?.locked]).toEqual([true, true, false])
    expect(unlockAll(ctx)).toBe(3)
    expect([...map.values()].some((e) => e.locked)).toBe(false)
    expect(selection().sort()).toEqual(['lk', 'n'])
  })
})

describe('the menus’ Delete', () => {
  it('deletes a frame with what is inside it, never a locked element; one step', () => {
    const { ctx, steps, selection } = fake(scene(), ['f', 'r'])
    COMMANDS.find((c) => c.id === CMD.delete)?.run(ctx, 'menu')
    expect(steps).toHaveLength(1)
    // labels go with their containers inside tx.delete
    expect(steps[0]?.ops.map(([op, id]) => `${op} ${id}`).sort()).toEqual([
      'delete f',
      'delete n',
      'delete r',
    ])
    expect(selection()).toEqual([])
  })
})
