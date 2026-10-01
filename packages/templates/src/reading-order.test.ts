// W5-59: inside every template frame the keyboard reads the heading first, then its instruction line, on
// both builds. The keyboard's order is tldraw's reading order (Tab, Ctrl+Arrow, Ctrl+Shift+Down into a frame
// on the tldraw page; Alt+Arrow and Ctrl+Shift+Down on the new canvas, which copies it): centres within
// 100 px make one row, read left to right. A heading as wide as its frame next to a narrower instruction
// line put the instruction's centre left of the heading's, so "a frame's subtitle is read before its title".

import type { WireElement } from '@draftroom/canvas-schema/elements'
import { describe, expect, it } from 'vitest'
import type { PlanFrame, PlanNode } from './builder.ts'
import { instantiateTemplate } from './index.ts'
import type { Rect } from './layout.ts'
import { planTemplate, TEMPLATE_INFOS } from './plan.ts'
import { alignedTemplate } from './scene/test-kit.ts'
import {
  byId,
  childrenOf,
  framesOf,
  keyboardReadingOrder,
  must,
  PAGE,
  pageRect,
  textOf,
} from './test-utils.ts'

const ORIGIN = { x: 0, y: 0 }

/** A frame's heading and, when the frame has one, the instruction line right after it (plan order). */
function headingAndInstruction(nodes: readonly PlanNode[], frame: PlanFrame): string[] {
  const kids = nodes.filter((n) => n.parent === frame)
  const [heading, second] = kids
  const out = heading?.kind === 'text' ? [heading.text] : []
  if (second?.kind === 'text' && second.locked && second.color === 'grey') out.push(second.text)
  return out
}

describe.each(TEMPLATE_INFOS.map((t) => [t.id] as const))('%s: reading order inside each frame', (id) => {
  it('on the tldraw page: the heading first, then its instruction line', () => {
    const plan = planTemplate(id, ORIGIN)
    const records = instantiateTemplate(id, { pageId: PAGE, origin: ORIGIN }).records
    const shapes = byId(records)
    for (const f of framesOf(records)) {
      const frame = must(
        plan.nodes.find((n): n is PlanFrame => n.kind === 'frame' && n.name === f.props.name),
      )
      const want = headingAndInstruction(plan.nodes, frame)
      const kids = childrenOf(records, f.id).filter((s) => s.type !== 'arrow')
      const order = keyboardReadingOrder(kids.map((s) => ({ s, rect: pageRect(s, shapes) })))
      expect(
        order.slice(0, want.length).map((o) => textOf(o.s)),
        f.props.name,
      ).toEqual(want)
    }
  })

  it('on the new canvas (measured text): the heading first, then its instruction line', () => {
    const { plan, elements } = alignedTemplate(id, ORIGIN)
    const rect = (e: WireElement): Rect => ({ x: e.x, y: e.y, w: e.width, h: e.height })
    const words = (e: WireElement) =>
      e.type === 'text'
        ? e.originalText
        : ((elements.find((l) => l.type === 'text' && l.containerId === e.id) as { originalText?: string })
            ?.originalText ?? '')
    for (const f of elements.filter((e) => e.type === 'frame')) {
      const name = f.type === 'frame' ? f.name : ''
      const frame = must(plan.nodes.find((n): n is PlanFrame => n.kind === 'frame' && n.name === name))
      const want = headingAndInstruction(plan.nodes, frame).map((t) => {
        const node = plan.nodes.find((n) => n.parent === frame && n.kind === 'text' && n.text === t)
        return node?.kind === 'text' ? node.scene.text : t
      })
      const kids = elements.filter(
        (e) => e.frameId === f.id && e.type !== 'arrow' && !(e.type === 'text' && e.containerId),
      )
      const order = keyboardReadingOrder(kids.map((e) => ({ e, rect: rect(e) })))
      expect(
        order.slice(0, want.length).map((o) => words(o.e)),
        String(name),
      ).toEqual(want)
    }
  })
})
