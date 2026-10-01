// The templates once the server accepts Lilita One (decision D3; 2A's font allowlist). canvas-schema's element
// check is simulated here to accept fontFamily 7 the way it accepts 6, so the emitter's display path runs on
// this branch before the allowlist lands: headings and title cards in Lilita One, body text in Nunito, and the
// tour's type samples named after the faces they are set in. ./hierarchy.test.ts runs the real check.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@draftroom/canvas-schema/elements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@draftroom/canvas-schema/elements')>()
  const asNunito = (raw: unknown) =>
    raw && typeof raw === 'object' && (raw as { fontFamily?: unknown }).fontFamily === 7
      ? { ...(raw as object), fontFamily: 6 }
      : raw
  return { ...actual, checkElement: (raw: unknown) => actual.checkElement(asNunito(raw)) }
})

const { TEMPLATE_INFOS } = await import('../plan.ts')
const { DISPLAY_FACE_AVAILABLE, FONT_FAMILY, instantiateSceneTemplate, sceneFontLoads } = await import(
  './index.ts'
)
const { labelOf, wordsOf } = await import('./test-kit.ts')
const { rectContains, rectsOverlap } = await import('../test-utils.ts')

const ORIGIN = { x: 0, y: 0 }

describe('with the display face accepted (2A allowlist simulated)', () => {
  it('resolves the display face to Lilita One, which a browser loads before it builds a scene', () => {
    expect(DISPLAY_FACE_AVAILABLE).toBe(true)
    expect(FONT_FAMILY.display).toBe(7)
    expect(sceneFontLoads()).toEqual(['20px "Nunito"', '20px "Lilita One"'])
  })

  it.each(TEMPLATE_INFOS.map((t) => [t.id] as const))(
    '%s: headings and title cards in Lilita One, everything else in Nunito',
    (id) => {
      const { elements } = instantiateSceneTemplate(id, { origin: ORIGIN })
      const frames = elements.filter((e) => e.type === 'frame')
      for (const f of frames) {
        const heading = elements.find((e) => e.frameId === f.id)
        expect(heading?.type === 'text' && heading.fontFamily, wordsOf(elements, f)).toBe(7)
      }
      const families = new Set(elements.flatMap((e) => (e.type === 'text' ? [e.fontFamily] : [])))
      expect(families).toEqual(new Set([6, 7]))
      // and the words that name a face still fit: inside their frames, apart from each other
      const box = (e: (typeof elements)[number]) => ({ x: e.x, y: e.y, w: e.width, h: e.height })
      for (const f of frames) {
        const solids = elements.filter(
          (e) => e.frameId === f.id && e.type !== 'arrow' && !(e.type === 'text' && e.containerId),
        )
        for (const k of solids) expect(rectContains(box(f), box(k)), wordsOf(elements, k)).toBe(true)
        for (let i = 0; i < solids.length; i++)
          for (let j = i + 1; j < solids.length; j++) {
            const [a, b] = [solids[i], solids[j]]
            if (a && b)
              expect(rectsOverlap(box(a), box(b)), `${wordsOf(elements, a)} / ${wordsOf(elements, b)}`).toBe(
                false,
              )
          }
      }
    },
  )

  it("the tour's type samples pair Lilita One with Nunito, and say so", () => {
    const { elements } = instantiateSceneTemplate('lobby-tour', { origin: ORIGIN })
    const words = elements.map((e) => wordsOf(elements, e))
    const roles = words.filter((w) => /^(Display|Body|HUD) · /.test(w))
    expect(roles).toEqual(['Display · Lilita One', 'Body · Nunito', 'HUD · Lilita One'])
    const sample = (w: string) => elements.find((e) => e.type === 'text' && e.originalText === w)
    expect(sample('Rise from the ashes')).toMatchObject({ fontFamily: 7, fontSize: 44 })
    expect(sample('PRESS START · 03:14 · ARENA 7')).toMatchObject({ fontFamily: 7 })
    expect(sample('Plain words in sans, easy to read on a phone.')).toMatchObject({ fontFamily: 6 })
    // the key cards: the key over what it does, the whole label in the display face
    const keyCard = elements.find((e) => wordsOf(elements, e) === 'F6\nKeyboard to the board')
    expect(keyCard?.type).toBe('rectangle')
    expect(labelOf(elements, keyCard?.id ?? '')).toMatchObject({ fontFamily: 7 })
  })
})
