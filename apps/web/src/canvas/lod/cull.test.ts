// 3b's render seam (./cull.ts): the culled ids join the board overrides' snapshot without replacing any of
// its entries, the engine API is otherwise forwarded, and the pass learns what the overrides move. Node only.
import type { ElementRenderOverrides, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { describe, expect, it } from 'vitest'
import { createLodTarget, LOD_CULL_OFFSET, mergeCulled, splitSnapshot } from './cull.ts'

const snap = (entries: [string, { opacity?: number; offset?: { x: number; y: number } }][]) =>
  new Map(entries) as ElementRenderOverrides

describe('mergeCulled', () => {
  it('adds a far render offset for each culled id the snapshot does not name', () => {
    const out = mergeCulled(snap([['drag', { offset: { x: 5, y: 0 } }]]), new Set(['a', 'drag']))
    expect(out?.get('a')).toEqual({ offset: LOD_CULL_OFFSET })
    expect(out?.get('drag')).toEqual({ offset: { x: 5, y: 0 } })
  })

  it('is the snapshot itself (or null) when nothing is culled', () => {
    const s = snap([['x', { opacity: 0 }]])
    expect(mergeCulled(s, new Set())).toBe(s)
    expect(mergeCulled(null, new Set())).toBeNull()
    expect(mergeCulled(new Map(), new Set())).toBeNull()
  })

  it('splits a snapshot into what it moves and what it fades', () => {
    const { moved, opacity } = splitSnapshot(
      snap([
        ['m', { offset: { x: 1, y: 2 } }],
        ['z', { offset: { x: 0, y: 0 } }],
        ['h', { opacity: 0 }],
      ]),
    )
    expect([...moved]).toEqual(['m'])
    expect([...opacity]).toEqual([['h', 0]])
  })
})

describe('createLodTarget', () => {
  const fakeApi = () => {
    const submitted: (ElementRenderOverrides | null)[] = []
    const api = {
      isDestroyed: false,
      getAppState: () => ({ zoom: { value: 0.1 } }),
      setElementRenderOverrides: (o: ElementRenderOverrides | null) => submitted.push(o),
    } as unknown as ExcalidrawImperativeAPI
    return { api, submitted }
  }

  it('forwards the engine API and merges every snapshot the board overrides submit', () => {
    const { api, submitted } = fakeApi()
    const t = createLodTarget(api)
    expect(t.api.getAppState()).toEqual({ zoom: { value: 0.1 } })
    t.setCulled(new Set(['n1', 'n2']))
    expect([...(submitted.at(-1)?.keys() ?? [])].sort()).toEqual(['n1', 'n2'])
    // RenderOverrides submits a drag preview of n1: its entry wins, n2 stays culled
    t.api.setElementRenderOverrides(snap([['n1', { offset: { x: 10, y: 0 } }]]))
    expect(submitted.at(-1)?.get('n1')).toEqual({ offset: { x: 10, y: 0 } })
    expect(submitted.at(-1)?.get('n2')).toEqual({ offset: LOD_CULL_OFFSET })
    expect([...t.moved()]).toEqual(['n1'])
    // the preview ends; nothing culled: the engine gets null
    t.api.setElementRenderOverrides(null)
    t.setCulled(null)
    expect(submitted.at(-1)).toBeNull()
  })

  it('skips a culled set equal to the last one, and names the ids whose opacity changed', () => {
    const { api, submitted } = fakeApi()
    const t = createLodTarget(api)
    const changes: string[][] = []
    t.onSnapshot((c) => changes.push([...c].sort()))
    t.setCulled(new Set(['a']))
    const n = submitted.length
    t.setCulled(new Set(['a']))
    expect(submitted.length).toBe(n)
    t.api.setElementRenderOverrides(snap([['h', { opacity: 0 }]]))
    t.api.setElementRenderOverrides(snap([['h', { opacity: 0 }]]))
    t.api.setElementRenderOverrides(null)
    expect(changes).toEqual([['h'], [], ['h']])
  })
})
