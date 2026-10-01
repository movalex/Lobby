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
