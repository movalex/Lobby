// Wave K (K4-3): the Lobby tour's Welcome frame is the first thing colleagues open. Its cards used to be three
// fills at three sizes (an orange card, a neutral card, an orange card; a yellow, an orange and a blue
// sticky), so they read as uneven. They now share one style: one fill family and one set of font sizes per
// kind of card. The plan test pins it on the plan (both canvases emit from it) and on the elements the new
// canvas stores.

import type { WireElement } from '@draftroom/canvas-schema/elements'
import { describe, expect, it } from 'vitest'
import { must } from '../../../tldraw-import/src/templates/test-utils.ts'
import type { PlanFrame, PlanGeo, PlanNote, PlanText } from '../builder.ts'
import { WELCOME_NOTE_SCALE, WELCOME_TITLE_H } from '../templates/lobby-tour.ts'
import { alignedTemplate, labelOf } from './test-kit.ts'

const { plan, elements, idOf } = alignedTemplate('lobby-tour')
const welcome = must(
  plan.nodes.find((n): n is PlanFrame => n.kind === 'frame' && n.name === '1 · Welcome'),
  'the Welcome frame',
)
const inWelcome = plan.nodes.filter((n) => n.parent === welcome)
/** The three pillar title cards. */
const pillars = inWelcome.filter((n): n is PlanGeo => n.kind === 'geo')
/** The sentence under each pillar: body-size text, in the dark ink. */
const sentences = inWelcome.filter(
  (n): n is PlanText => n.kind === 'text' && !n.heading && n.color === 'black' && n.size === 'm',
)
const tries = inWelcome.filter((n): n is PlanNote => n.kind === 'note')
const el = (n: PlanGeo | PlanNote | PlanText): WireElement =>
  must(
    elements.find((e) => e.id === idOf.get(n)),
    n.kind,
  )

describe('the Welcome frame of the Lobby tour: its cards share one style', () => {
  it('has three pillar title cards, a sentence under each, and three “try this” stickies', () => {
    expect(pillars.map((p) => p.text)).toEqual(['Kick off', 'Make', 'Review'])
    expect(sentences).toHaveLength(3)
    expect(tries).toHaveLength(3)
  })

  it('gives the pillar cards one fill family, one label colour, one size and one box', () => {
    const style = (p: PlanGeo) => ({
      color: p.color,
      fill: p.fill,
      labelColor: p.labelColor,
      size: p.size,
      heading: p.heading,
      w: p.w,
      h: p.h,
      y: p.page.y,
      geo: p.geo,
      dash: p.dash,
    })
    const first = style(must(pillars[0]))
    for (const p of pillars) expect(style(p), p.text).toEqual(first)
    expect(first).toMatchObject({
      color: 'orange',
      fill: 'solid',
      labelColor: 'black',
      h: WELCOME_TITLE_H,
      heading: true,
    })
    // evenly spaced across the frame
    const xs = pillars.map((p) => p.page.x)
    expect(must(xs[1]) - must(xs[0])).toBeCloseTo(must(xs[2]) - must(xs[1]), 6)
  })

  it('gives the sentences one size, one ink and one width, each right under its card', () => {
    pillars.forEach((p, i) => {
      const s = must(sentences[i])
      expect([s.size, s.color, s.w, s.locked, s.align]).toEqual(['m', 'black', p.w, true, 'start'])
      expect(s.page.x).toBe(p.page.x)
      expect(s.page.y).toBeGreaterThan(p.page.y + p.h)
      expect(s.page.y - (p.page.y + p.h)).toBe(must(sentences[0]).page.y - (must(pillars[0]).page.y + p.h))
    })
  })

  it('gives the stickies one colour, one scale and one row, each centred under its pillar', () => {
    for (const n of tries)
      expect([n.color, n.scale, n.size, n.prompt, n.page.y]).toEqual([
        'yellow',
        WELCOME_NOTE_SCALE,
        's',
        false,
        must(tries[0]).page.y,
      ])
    tries.forEach((n, i) => {
      const p = must(pillars[i])
      expect(n.page.x + n.page.w / 2).toBeCloseTo(p.page.x + p.page.w / 2, 6)
    })
  })

  it('sets the same font size and face on every pillar title, sentence and sticky, on the new canvas', () => {
    const labelStyle = (e: WireElement) => {
      const label = labelOf(elements, e.id)
      return label?.type === 'text' ? [label.fontSize, label.fontFamily, label.strokeColor] : null
    }
    const textStyle = (e: WireElement) =>
      e.type === 'text' ? [e.fontSize, e.fontFamily, e.strokeColor] : null
    const pillarEls = pillars.map(el)
    const sentenceEls = sentences.map(el)
    const noteEls = tries.map(el)
    for (const e of pillarEls) {
      expect([e.backgroundColor, e.strokeColor, e.strokeWidth, e.width, e.height]).toEqual([
        pillarEls[0]?.backgroundColor,
        pillarEls[0]?.strokeColor,
        pillarEls[0]?.strokeWidth,
        pillarEls[0]?.width,
        pillarEls[0]?.height,
      ])
      expect(labelStyle(e)).toEqual(labelStyle(must(pillarEls[0])))
    }
    for (const e of sentenceEls) expect(textStyle(e)).toEqual(textStyle(must(sentenceEls[0])))
    for (const e of noteEls) {
      expect([e.backgroundColor, e.width, e.height]).toEqual([
        noteEls[0]?.backgroundColor,
        noteEls[0]?.width,
        noteEls[0]?.height,
      ])
      expect(labelStyle(e)).toEqual(labelStyle(must(noteEls[0])))
    }
  })

  it('says it in tight words: press N, click, type; no editor-only promise without “Can edit?”', () => {
    expect(must(tries[0]).text).toBe('Can edit? Press N and click to add a sticky. Type to fill it in.')
    expect(must(tries[1]).text).toMatch(/^Press C, then click this note to leave a comment\.$/)
    expect(must(tries[2]).text).toMatch(/^Click Present at the top/)
    const texts = inWelcome.filter((n) => n.kind === 'text').map((n) => (n.kind === 'text' ? n.text : ''))
    expect(texts.join(' ')).not.toMatch(/Everyone can comment/)
    for (const t of texts) expect(t.length, t).toBeLessThan(140)
  })
})
