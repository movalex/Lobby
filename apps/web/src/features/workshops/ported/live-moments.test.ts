// K3-5 (wave K): live moments that feel live and stay ephemeral: a reaction bursts into staggered copies (one
// still copy with reduced motion), my vote dots wear my presence colour with an ink that reads on it, and a
// reveal drops confetti (an overlay only; none with reduced motion). In a browser: e2e/excalidraw/k3-live.spec.ts.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { colorForUser } from '../../../lib/identity.ts'
import { contrastRatio } from '../../../theme/contrast.ts'
import { BURST_COPIES, burstCopies } from '../reactions.ts'
import { CONFETTI_PIECES, dotInk, opaqueHex, revealConfetti } from '../voting.ts'
import { BurstFace } from './Reactions.tsx'
import { RevealConfetti } from './WorkshopOverlay.tsx'

const copiesIn = (html: string) => (html.match(/class="dr-wk-burst__emoji"/g) ?? []).length

describe('a reaction bursts (K3-5)', () => {
  it('4 to 6 staggered copies: the reaction itself first, the others later and spread sideways', () => {
    for (const jitter of [0, 0.3, 0.5, 0.99]) {
      const copies = burstCopies(false, jitter)
      expect(copies.length).toBeGreaterThanOrEqual(4)
      expect(copies.length).toBeLessThanOrEqual(6)
      expect(copies.length).toBe(BURST_COPIES)
      expect(copies[0]).toEqual({ dx: 0, rise: 0, delayMs: 0, scale: 1, turn: 0 })
      const delays = copies.map((c) => c.delayMs)
      for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1] as number)
      expect(new Set(copies.map((c) => c.dx)).size).toBe(copies.length)
      for (const c of copies.slice(1)) expect(c.rise).toBeLessThan(0)
    }
  })

  it('one still copy for people who prefer reduced motion', () => {
    expect(burstCopies(true)).toEqual([{ dx: 0, rise: 0, delayMs: 0, scale: 1, turn: 0 }])
  })

  it('renders as many copies as that: 5, or 1 under reduced motion', () => {
    const lively = renderToStaticMarkup(
      createElement(BurstFace, { emoji: '🎉', reduced: false, spread: 0.4 }),
    )
    expect(copiesIn(lively)).toBe(5)
    expect(lively).toContain('data-copies="5"')
    expect(lively).toMatch(/--delay:110ms/)
    const still = renderToStaticMarkup(createElement(BurstFace, { emoji: '🎉', reduced: true }))
    expect(copiesIn(still)).toBe(1)
    expect(still).not.toContain('--delay')
  })
})

describe('vote dots in the voter’s presence colour (K3-5)', () => {
  it('the figure reads at 4.5:1 or better on every presence colour', () => {
    const fills = new Set<string>()
    for (let i = 0; i < 400; i++) fills.add(colorForUser(`usr_sample${String(i).padStart(8, '0')}`))
    expect(fills.size).toBeGreaterThan(4)
    // and colours the api may send that are not that palette, light and dark
    for (const extra of [
      '#ffd966',
      '#f8e48f',
      '#ffffff',
      '#000000',
      '#777777',
      '#1d4ed8',
      '#22c55e',
      '#e11d48',
    ])
      fills.add(extra)
    for (const fill of fills) {
      const ink = dotInk(fill)
      expect(contrastRatio(ink, fill), `${ink} on ${fill}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(dotInk('#1d4ed8')).toBe('#ffffff')
    expect(dotInk('#ffd966')).toBe('#000000')
  })

  it('reads short and translucent hex colours; anything else falls back to white ink', () => {
    expect(opaqueHex('#ABC')).toBe('#aabbcc')
    expect(opaqueHex('#11223344')).toBe('#112233')
    expect(opaqueHex('red')).toBeNull()
    expect(dotInk('not a colour')).toBe('#ffffff')
  })
})

describe('reveal confetti (K3-5)', () => {
  it('a short fall of pieces across the view, the same for the same reveal; none with reduced motion', () => {
    const pieces = revealConfetti(false, 7)
    expect(pieces).toHaveLength(CONFETTI_PIECES)
    for (const p of pieces) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(100)
      expect(p.delayMs).toBeLessThan(500)
    }
    expect(revealConfetti(false, 7)).toEqual(pieces)
    expect(revealConfetti(true, 7)).toEqual([])
  })

  it('is an overlay only: pieces in a layer that takes no pointer and is hidden from assistive tech', () => {
    const html = renderToStaticMarkup(createElement(RevealConfetti, { seq: 3, reduced: false }))
    expect(html).toContain('data-testid="vote-confetti"')
    expect(html).toContain('aria-hidden="true"')
    expect(html.match(/dr-wk-confetti__piece/g)).toHaveLength(CONFETTI_PIECES)
    expect(renderToStaticMarkup(createElement(RevealConfetti, { seq: 3, reduced: true }))).toBe('')
    expect(renderToStaticMarkup(createElement(RevealConfetti, { seq: null, reduced: false }))).toBe('')
  })
})
