import { describe, expect, it } from 'vitest'
import { rect } from '../testing/elements.ts'
import type { OfflineEntry, SceneElement } from '../types.ts'
import { mergeOfflineQueues } from './offline-merge.ts'

const doc = (set: Record<string, unknown>, lostDoc?: OfflineEntry['lostDoc']): OfflineEntry => ({
  element: {
    id: '#doc',
    type: 'lobby-doc',
    version: 0,
    versionNonce: 0,
    index: null,
    isDeleted: false,
    set,
  } as unknown as SceneElement,
  groups: ['doc'],
  base: 1,
  queuedAt: 10,
  ...(lostDoc ? { lostDoc } : {}),
})

describe('mergeOfflineQueues (V1 re-check P16: two tabs’ queues)', () => {
  it('keeps every tab’s board-document keys, the later queue winning a key both set', () => {
    const tab1 = [doc({ 'tagDef:a': { name: 'a', color: 'red' }, 'tagDef:both': 1 })]
    const tab2 = [doc({ 'tagDef:b': { name: 'b', color: 'blue' }, 'tagDef:both': 2 })]
    const [d] = mergeOfflineQueues([tab1, tab2])
    expect((d?.element as unknown as { set?: Record<string, unknown> } | undefined)?.set).toEqual({
      'tagDef:a': { name: 'a', color: 'red' },
      'tagDef:b': { name: 'b', color: 'blue' },
      'tagDef:both': 2,
    })
  })

  it('keeps the lost doc writes and lost pushes of both queues', () => {
    const lostDoc1 = [{ set: { 'tagDef:a': 1 }, base: { 'tagDef:a': null } }]
    const lostDoc2 = [{ set: { 'tagDef:b': 2 }, base: { 'tagDef:b': null } }]
    const el = rect('x', 'a0')
    const lost = (src: string) => [{ src, seq: 1, base: 1, at: 5, create: false, groups: ['pos'], el, pv: 1 }]
    const merged = mergeOfflineQueues([
      [doc({}, lostDoc1), { element: el, groups: ['style'], base: 1, queuedAt: 7, lost: lost('t1:1') }],
      [doc({}, lostDoc2), { element: el, groups: ['pos'], base: 2, queuedAt: 3, lost: lost('t2:1') }],
    ])
    expect(merged.find((e) => e.element.id === '#doc')?.lostDoc).toEqual([...lostDoc1, ...lostDoc2])
    const x = merged.find((e) => e.element.id === 'x')
    expect([...(x?.groups ?? [])].sort()).toEqual(['pos', 'style'])
    expect(x?.queuedAt).toBe(3)
    expect(x?.lost?.map((l) => l.src)).toEqual(['t1:1', 't2:1'])
  })

  it('an element in one queue only is kept as it is', () => {
    const a = { element: rect('a', 'a0'), groups: ['pos'], base: 1, queuedAt: 1 }
    expect(mergeOfflineQueues([[a], []])).toEqual([a])
  })
})

// N1-2 (wave N): two tabs' merged queues adopted by a page: the queued copies go into the scene and the server's
// copies into the confirmed map, and no object is ever both (the harness asserts it after every apply too).
describe('a merged queue adopted by a page shares nothing with the confirmed copies (N1-2)', () => {
  it('both tabs’ edits land, the scene holds its own copies of every element', async () => {
    const { createHarness } = await import('../testing/harness.ts')
    const { stored } = await import('../testing/fakeRoom.ts')
    const { createMemoryOfflineStore } = await import('./offline-memory.ts')
    const { assertNoSharing } = await import('../testing/sharing.ts')
    const { bump } = await import('../headless/scene.ts')
    const h = createHarness({ seed: [stored(rect('x', 'a0')), stored(rect('y', 'a1'))] })
    const x = h.room.elements.get('x') as unknown as SceneElement
    const y = h.room.elements.get('y') as unknown as SceneElement
    const { diffGroups } = await import('./fields.ts')
    const x1 = bump(x, { strokeColor: '#e03131', groupIds: ['g1'] })
    const tab1: OfflineEntry[] = [
      { element: x1, groups: [...diffGroups(x1, x).groups], base: 0, queuedAt: 1 },
    ]
    const tab2: OfflineEntry[] = [{ element: bump(y, { x: 300 }), groups: ['pos'], base: 0, queuedAt: 2 }]
    const merged = mergeOfflineQueues([tab1, tab2])
    const a = h.client('alice', { offline: createMemoryOfflineStore(merged) })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    h.settle()
    expect(h.room.elements.get('x')?.strokeColor).toBe('#e03131')
    expect(h.room.elements.get('x')?.groupIds).toEqual(['g1'])
    expect(h.room.elements.get('y')?.x).toBe(300)
    assertNoSharing(a.core, a.scene)
    expect(await a.hash()).toBe(await h.roomHash())
  })
})
