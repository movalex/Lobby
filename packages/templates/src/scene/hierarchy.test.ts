// Decision D3 (docs/research/excalidraw/REVIEW-W5-EARLY.md §9, W5-16 and W5-17): the new canvas has no bold
// and gets no new fonts, so a template's hierarchy comes from size, colour and Excalidraw's display face,
// Lilita One (fontFamily 7), for headings and title cards. The face is used once the server's element check
// accepts it (2A's font allowlist and text metrics); until then those texts are Nunito and size and colour
// carry the hierarchy alone. ./display-face.test.ts runs the same templates with the face accepted.

import { lobbyColor } from '@draftroom/board-ops/elements'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import { describe, expect, it } from 'vitest'
import type { PlanFrame } from '../builder.ts'
import { TEMPLATE_INFOS } from '../plan.ts'
import {
  DISPLAY_FACE_AVAILABLE,
  DISPLAY_FONT_FAMILY_ID,
  FONT_FAMILY,
  instantiateSceneTemplate,
  sceneFontLoads,
} from './index.ts'
import { alignedTemplate, labelOf, metrics } from './test-kit.ts'

const ORIGIN = { x: 0, y: 0 }
const text = (e: WireElement | undefined) => (e?.type === 'text' ? e : undefined)

describe.each(TEMPLATE_INFOS.map((t) => [t.id] as const))('%s: hierarchy without bold (D3)', (id) => {
  const { plan, elements, idOf } = alignedTemplate(id, ORIGIN)
  const el = (n: (typeof plan.nodes)[number]) => elements.find((e) => e.id === idOf.get(n))

  it("sets each frame's heading in the display face, as large as any text of its frame, in a strong ink", () => {
    for (const frame of plan.nodes.filter((n): n is PlanFrame => n.kind === 'frame')) {
      const kids = plan.nodes.filter((n) => n.parent === frame)
      const headingNode = kids[0]
      expect(headingNode?.kind === 'text' && headingNode.heading, frame.name).toBe(true)
      const heading = text(el(headingNode as never))
      if (!heading) throw new Error(`no heading in ${frame.name}`)
      expect([heading.fontFamily, heading.locked], frame.name).toEqual([FONT_FAMILY.display, true])
      expect([lobbyColor('black').solid, lobbyColor('orange').solid]).toContain(heading.strokeColor)
      for (const k of kids.slice(1)) {
        const t = text(el(k))
        if (t) expect(t.fontSize, `${frame.name}: "${t.originalText}"`).toBeLessThanOrEqual(heading.fontSize)
      }
      // the instruction line under it: smaller, grey, the body face
      const intro =
        kids[1]?.kind === 'text' && kids[1].color === 'grey' && kids[1].locked ? text(el(kids[1])) : null
      if (intro) {
        expect(intro.fontSize).toBeLessThan(heading.fontSize)
        expect([intro.strokeColor, intro.fontFamily]).toEqual([lobbyColor('grey').solid, FONT_FAMILY.sans])
      }
    }
  })

  it('sets every heading text and title card in the display face, and every other text in Nunito', () => {
    for (const node of plan.nodes) {
      if (node.kind === 'text') {
        const t = text(el(node))
        const want = FONT_FAMILY[node.scene.font]
        expect(t?.fontFamily, node.text).toBe(want)
        if (node.heading) expect(want).toBe(FONT_FAMILY.display)
      }
      if (node.kind === 'geo' && node.scene.text) {
        const label = text(labelOf(elements, idOf.get(node) ?? ''))
        expect(label?.fontFamily, node.text).toBe(node.heading ? FONT_FAMILY.display : FONT_FAMILY.sans)
      }
    }
    // the templates set no text in Excalifont or Comic Shanns any more (W5-17: no comic face as "mono")
    const families = new Set(elements.flatMap((e) => (e.type === 'text' ? [e.fontFamily] : [])))
    for (const f of families) expect([FONT_FAMILY.sans, FONT_FAMILY.display]).toContain(f)
  })

  it('marks the template titles: themes, column headers and shortcut keys are title cards', () => {
    const titles = plan.nodes
      .filter((n) => n.kind === 'geo' && n.heading)
      .map((n) => (n.kind === 'geo' ? n.text : ''))
    if (id === 'brainstorm') expect(titles).toHaveLength(4)
    if (id === 'lobby-tour') {
      expect(titles).toEqual(
        expect.arrayContaining(['Gameplay', 'Story', 'Community', 'Went well', 'N\nSticky note']),
      )
      // themes, the Welcome frame's pillar titles (K4-3), the retro columns and the shortcut keys
      expect(titles).toHaveLength(3 + 3 + 3 + 16)
    }
  })
})

describe('the display face (Lilita One, fontFamily 7)', () => {
  it('is used exactly when the server accepts it; Nunito stands in until then', () => {
    expect(DISPLAY_FONT_FAMILY_ID).toBe(7)
    expect(FONT_FAMILY.display).toBe(DISPLAY_FACE_AVAILABLE ? 7 : 6)
  })

  it('is among the faces a browser loads before it builds a scene', () => {
    expect(sceneFontLoads()).toEqual(
      DISPLAY_FACE_AVAILABLE ? ['20px "Nunito"', '20px "Lilita One"'] : ['20px "Nunito"'],
    )
  })

  // Decision D3: canvas-schema's element check accepts fontFamily 7 (Lilita One) since 2A's wave-5 allowlist
  // change, with the server's text metrics for it; the template headings use it.
  it("the server's element check accepts the display face (2A's font allowlist, D3)", () => {
    expect(DISPLAY_FACE_AVAILABLE).toBe(true)
  })

  it.skipIf(!DISPLAY_FACE_AVAILABLE)('is measured by the server text metrics (not as Nunito)', () => {
    const before = metrics.stats.unknownFamilies
    instantiateSceneTemplate('lobby-tour', { origin: ORIGIN })
    expect(metrics.stats.unknownFamilies).toBe(before)
  })
})
