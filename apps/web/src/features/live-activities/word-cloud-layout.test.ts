// WS2 (wave V, V1): the word cloud's packer is pure and deterministic: the same words and seed give the same layout
// whatever order the words come in; no two measured boxes overlap; sizes follow sqrt(count) in 16..96; at most 60
// words; 100 words lay out in well under 50 ms.
import { describe, expect, it } from 'vitest'
import {
  CLOUD_COLOR_NAMES,
  CLOUD_EVEN_SIZE,
  CLOUD_GAP,
  CLOUD_SIZES,
  cloudFontSize,
  cloudOrder,
  layoutWordCloud,
  seedOf,
} from './word-cloud-layout.ts'

/** A measurer like the server's metrics in shape: width by code points, height by size. */
const measure = (text: string, style: { fontSize: number }) => ({
  width: [...text].length * style.fontSize * 0.55,
  height: style.fontSize * 1.25,
})

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ text: `word${i}`, count: Math.max(1, n - i * 2) }))

const overlap = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('the word cloud layout', () => {
  it('is the same for the same words and seed, whatever their order', () => {
    const list = words(40)
    const a = layoutWordCloud({ words: list, measure, seed: 7 })
    const b = layoutWordCloud({ words: [...list].reverse(), measure, seed: 7 })
    expect(b).toEqual(a)
    // another seed moves things, and is deterministic too
    const c = layoutWordCloud({ words: list, measure, seed: 8 })
    expect(c).toEqual(layoutWordCloud({ words: list, measure, seed: 8 }))
    expect(c.words.map((w) => [w.x, w.y])).not.toEqual(a.words.map((w) => [w.x, w.y]))
  })

  it('never overlaps two measured boxes, and keeps every word inside its bounds', () => {
    for (const seed of [1, 2, 3, seedOf('act_0123456789abcdef')]) {
      const l = layoutWordCloud({ words: words(60), measure, seed })
      expect(l.words).toHaveLength(60)
      for (let i = 0; i < l.words.length; i++) {
        const w = l.words[i]
        if (!w) continue
        expect(w.x).toBeGreaterThanOrEqual(0)
        expect(w.y).toBeGreaterThanOrEqual(0)
        expect(w.x + w.width).toBeLessThanOrEqual(l.width + 0.01)
        expect(w.y + w.height).toBeLessThanOrEqual(l.height + 0.01)
        // the measured box is what the plan keeps
        const m = measure(w.text, { fontSize: w.fontSize })
        expect(w.width).toBe(Math.ceil(m.width))
        for (let j = i + 1; j < l.words.length; j++) {
          const o = l.words[j]
          if (o) expect(overlap(w, o), `${w.text} / ${o.text}`).toBe(false)
        }
      }
    }
    expect(CLOUD_GAP).toBeGreaterThan(0)
  })

  it('draws at most 60 words, the most frequent, and counts the rest', () => {
    const l = layoutWordCloud({ words: words(100), measure, seed: 3 })
    expect(l.words).toHaveLength(60)
    expect(l.left).toBe(40)
    expect(l.words.map((w) => w.text)).toEqual(
      cloudOrder(words(100))
        .slice(0, 60)
        .map((w) => w.text),
    )
  })

  it('sizes words 16..96 by sqrt(count), biggest first, the same size when counts are equal', () => {
    expect(cloudFontSize(1, 1, 100)).toBe(16)
    expect(cloudFontSize(100, 1, 100)).toBe(96)
    // sqrt: a quarter of the top count is half way
    expect(cloudFontSize(25, 1, 100)).toBe(CLOUD_SIZES[Math.round(((5 - 1) / 9) * 5)])
    expect(cloudFontSize(4, 4, 4)).toBe(CLOUD_EVEN_SIZE)
    const l = layoutWordCloud({
      words: [
        { text: 'big', count: 50 },
        { text: 'small', count: 1 },
      ],
      measure,
    })
    expect(l.words.map((w) => w.fontSize)).toEqual([96, 16])
    const even = layoutWordCloud({ words: words(3).map((w) => ({ ...w, count: 2 })), measure })
    expect(new Set(even.words.map((w) => w.fontSize))).toEqual(new Set([CLOUD_EVEN_SIZE]))
    for (const w of layoutWordCloud({ words: words(60), measure }).words) {
      expect(w.fontSize).toBeGreaterThanOrEqual(16)
      expect(w.fontSize).toBeLessThanOrEqual(96)
    }
  })

  it('orders ties by text in code-point order, uses Lobby palette colours only, and copes with nothing', () => {
    expect(
      cloudOrder([
        { text: 'b', count: 2 },
        { text: 'Z', count: 2 },
        { text: 'a', count: 3 },
        { text: 'é', count: 2 },
      ]).map((w) => w.text),
    ).toEqual(['a', 'Z', 'b', 'é'])
    const l = layoutWordCloud({ words: words(12), measure })
    for (const w of l.words) expect(CLOUD_COLOR_NAMES).toContain(w.color)
    expect(layoutWordCloud({ words: [], measure })).toEqual({ words: [], width: 0, height: 0, left: 0 })
  })

  it('lays out 100 words in well under 50 ms', () => {
    const list = Array.from({ length: 100 }, (_, i) => ({
      text: `${'abcdefghij'.slice(0, 3 + (i % 8))}${i}`,
      count: 1 + ((i * 37) % 23),
    }))
    layoutWordCloud({ words: list, measure, seed: 1 }) // warm up
    const t0 = performance.now()
    for (let i = 0; i < 5; i++) layoutWordCloud({ words: list, measure, seed: i })
    expect((performance.now() - t0) / 5).toBeLessThan(50)
  })
})
