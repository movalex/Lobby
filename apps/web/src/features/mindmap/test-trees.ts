// Test helpers (unit tests only): topic inputs for model/layout tests and a seeded random map.

import type { MindmapSide } from '@draftroom/contracts'
import type { Box, TopicInput } from './model.ts'

export const R = 'shape:root'

export function topic(
  id: string,
  parentId: string | null,
  box: Partial<Box> = {},
  opts: { side?: MindmapSide; collapsed?: boolean; rootId?: string } = {},
): TopicInput {
  return {
    id,
    meta: {
      rootId: opts.rootId ?? R,
      parentId,
      side: opts.side ?? 'right',
      collapsed: opts.collapsed ?? false,
    },
    box: { x: box.x ?? 0, y: box.y ?? 0, w: box.w ?? 120, h: box.h ?? 56 },
  }
}

/** Mulberry32: a small deterministic PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A random map of `n` topics: random parents, sides, sizes (widths 120..300, heights 52..140, like
 * wrapped labels), some collapsed, positions scattered (so the order comes from them).
 */
export function randomMap(seed: number, n: number): TopicInput[] {
  const r = rng(seed)
  const out: TopicInput[] = [topic(R, null, { x: 0, y: 0, w: 220, h: 84 })]
  for (let i = 1; i < n; i++) {
    const parent = out[Math.floor(r() * out.length)] as TopicInput
    const id = `shape:t${String(i).padStart(4, '0')}`
    out.push(
      topic(
        id,
        parent.id,
        {
          x: Math.round((r() - 0.5) * 3000),
          y: Math.round((r() - 0.5) * 3000),
          w: 120 + Math.round(r() * 180),
          h: 52 + Math.round(r() * 88),
        },
        { side: r() < 0.5 ? 'left' : 'right', collapsed: r() < 0.08 },
      ),
    )
  }
  return out
}
