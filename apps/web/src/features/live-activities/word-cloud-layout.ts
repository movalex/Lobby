// OWNER: WS2 (wave V, V1; docs/WAVE-V-CONTRACTS.md §2.5). The word cloud's layout: a pure, deterministic spiral packer.
// Numbers and words only: no canvas, no DOM, no clock. The text measurer is injected (`canvas.text.measure` in the app:
// the server's metrics, so every client draws the same boxes the layout planned).
//
//  - the words are a revealed word cloud's results (aggregates; no word carries its author), sorted again here by
//    count (highest first), then by text in code-point order, so the input order never matters; at most
//    ACTIVITY_LIMITS.cloudWordsMax (60) are drawn, the rest are counted in `left`;
//  - font sizes 16..96 by sqrt(count), in CLOUD_SIZES buckets (rank buckets of the square root between the smallest and
//    the largest count; all counts equal: one middle size);
//  - each word, biggest first, goes at the first free place along an elliptical Archimedean spiral from the middle,
//    starting at an angle drawn from a seeded generator (mulberry32 of `seed`): the same input and seed give the same
//    layout on every machine; no two measured boxes (with CLOUD_GAP between) overlap; a word with no place within
//    CLOUD_MAX_RADIUS is left out (counted in `left`);
//  - positions come back relative to the cloud's own top left (0, 0), with `width` and `height` its bounding box, so
//    whatever frame it is put in holds it whole;
//  - colours are Lobby palette solids only (CLOUD_COLORS), by rank.

import { ACTIVITY_LIMITS, type WordCount } from '@draftroom/contracts'

/** Lobby's sans (Nunito): the font of every word (results-plan.ts PLAN_FONT_FAMILY). */
export const CLOUD_FONT_FAMILY = 6
/** The font sizes, smallest to largest (16..96). */
export const CLOUD_SIZES = [16, 24, 36, 52, 72, 96] as const
/** The size every word gets when all counts are equal. */
export const CLOUD_EVEN_SIZE = 36
/** Room kept between two words' boxes (scene px). */
export const CLOUD_GAP = 6
/** How far from the middle a word may go before it is left out (scene px, along the spiral's long axis). */
export const CLOUD_MAX_RADIUS = 1400
/** The spiral is this much wider than tall (a cloud reads as a landscape block). */
const ASPECT = 1.7
/** The spiral's growth per radian (scene px) and its step along the curve (scene px). */
const SPIRAL_GROWTH = 3
const SPIRAL_STEP = 6

/**
 * Lobby palette solids (`@draftroom/board-ops` LOBBY_PALETTE `.solid`, light mode: Excalidraw darkens them on a dark
 * canvas) that read on a white frame: ink, blue, violet, green, orange, red. Literal values: the layout is pure.
 */
export const CLOUD_COLOR_NAMES = ['black', 'blue', 'violet', 'green', 'orange', 'red'] as const

export type Measure = (
  text: string,
  style: { fontFamily: number; fontSize: number },
) => { readonly width: number; readonly height: number }

export interface CloudWord {
  readonly text: string
  readonly count: number
  readonly fontSize: number
  /** relative to the cloud's top left; the box's left edge and top */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** a CLOUD_COLOR_NAMES entry */
  readonly color: (typeof CLOUD_COLOR_NAMES)[number]
}

export interface CloudLayout {
  readonly words: readonly CloudWord[]
  readonly width: number
  readonly height: number
  /** words not drawn: past the cap, or with no place left */
  readonly left: number
}

/** Code-point order (not UTF-16, not locale): the contracts' tie-break. */
function byCodePoint(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0)
    if (d) return d
  }
  return x.length - y.length
}

/** The words in drawing order: highest count first, ties by text in code-point order (deterministic). */
export function cloudOrder(words: readonly WordCount[]): WordCount[] {
  return words
    .filter((w) => w.count > 0 && w.text.trim().length > 0)
    .slice()
    .sort((a, b) => b.count - a.count || byCodePoint(a.text, b.text))
}

/** The font size of each count: CLOUD_SIZES by sqrt(count) between the smallest and the largest. */
export function cloudFontSize(count: number, minCount: number, maxCount: number): number {
  if (maxCount <= minCount) return CLOUD_EVEN_SIZE
  const lo = Math.sqrt(Math.max(1, minCount))
  const hi = Math.sqrt(maxCount)
  const t = (Math.sqrt(Math.max(1, count)) - lo) / (hi - lo)
  const bucket = Math.min(CLOUD_SIZES.length - 1, Math.max(0, Math.round(t * (CLOUD_SIZES.length - 1))))
  return CLOUD_SIZES[bucket] ?? CLOUD_EVEN_SIZE
}

/** mulberry32: a tiny seeded generator in [0, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A 32-bit seed from a string (FNV-1a), e.g. the activity's id. */
export function seedOf(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const overlaps = (a: Box, b: Box, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The cloud: up to `maxWords` words (default 60), biggest in the middle. Deterministic for the same words, measurer
 * and seed. An empty list is an empty cloud (0 × 0).
 */
export function layoutWordCloud(input: {
  readonly words: readonly WordCount[]
  readonly measure: Measure
  readonly seed?: number
  readonly maxWords?: number
}): CloudLayout {
  const all = cloudOrder(input.words)
  const shown = all.slice(0, Math.max(0, input.maxWords ?? ACTIVITY_LIMITS.cloudWordsMax))
  if (shown.length === 0) return { words: [], width: 0, height: 0, left: all.length }
  const maxCount = shown[0]?.count ?? 1
  const minCount = shown[shown.length - 1]?.count ?? 1
  const next = rng(input.seed ?? 1)
  const placed: { word: WordCount; box: Box; fontSize: number; rank: number }[] = []
  let left = all.length - shown.length
  let lastHit: Box | null = null

  shown.forEach((word, rank) => {
    const fontSize = cloudFontSize(word.count, minCount, maxCount)
    const m = input.measure(word.text, { fontFamily: CLOUD_FONT_FAMILY, fontSize })
    const w = Math.max(1, Math.ceil(m.width))
    const h = Math.max(1, Math.ceil(m.height))
    const start = next() * Math.PI * 2
    const free = (box: Box) => {
      // the box that stopped the last try is the likeliest to stop this one
      if (lastHit && overlaps(box, lastHit, CLOUD_GAP)) return false
      for (const p of placed)
        if (overlaps(box, p.box, CLOUD_GAP)) {
          lastHit = p.box
          return false
        }
      return true
    }
    let t = 0
    let at: Box | null = null
    for (;;) {
      const r = SPIRAL_GROWTH * t
      if (r > CLOUD_MAX_RADIUS) break
      const cx = r * Math.cos(start + t) * ASPECT
      const cy = r * Math.sin(start + t)
      const box = { x: cx - w / 2, y: cy - h / 2, w, h }
      if (free(box)) {
        at = box
        break
      }
      // about SPIRAL_STEP px along the curve per step, whatever the radius
      t += SPIRAL_STEP / Math.max(SPIRAL_STEP, r * ASPECT)
    }
    if (!at) {
      left++
      return
    }
    placed.push({ word, box: at, fontSize, rank })
  })

  if (placed.length === 0) return { words: [], width: 0, height: 0, left }
  const minX = Math.min(...placed.map((p) => p.box.x))
  const minY = Math.min(...placed.map((p) => p.box.y))
  const maxX = Math.max(...placed.map((p) => p.box.x + p.box.w))
  const maxY = Math.max(...placed.map((p) => p.box.y + p.box.h))
  const words: CloudWord[] = placed.map((p) => ({
    text: p.word.text,
    count: p.word.count,
    fontSize: p.fontSize,
    x: round2(p.box.x - minX),
    y: round2(p.box.y - minY),
    width: p.box.w,
    height: p.box.h,
    color: CLOUD_COLOR_NAMES[p.rank % CLOUD_COLOR_NAMES.length] ?? 'black',
  }))
  return { words, width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY), left }
}
