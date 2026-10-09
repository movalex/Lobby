// L4-3: the Mermaid paste handler (./MermaidPaste.tsx): asked before bulk paste (so before K7-2's outline paste),
// it takes only flowchart text, never for a read-only role or an 'insert'; "Paste as diagram" writes the diagram
// in one undo step without AI provenance, in an empty spot near the paste point (./place.ts).
import { describe, expect, it } from 'vitest'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { handlersFor } from '../../canvas/board/content.ts'
import { parseMermaidLite } from '../ai/diagram/mermaid-lite.ts'
import { BULK_PASTE_HANDLER } from '../canvas-ux/ported/navigation/bulk-paste.tsx'
import { MERMAID_PASTE_HANDLER, mermaidPromptText, pasteAsDiagram, pendingMermaid } from './MermaidPaste.tsx'
import { placeDiagram } from './place.ts'
import { fakeFlowCanvas } from './test-canvas.ts'

const CHART = 'flowchart TD\nA[Brief] --> B{OK?}\nB -->|yes| C((Ship))\nB -->|no| A'
const ctxOf = (f: ReturnType<typeof fakeFlowCanvas>) =>
  ({ canvas: f.canvas, notify: () => undefined }) as unknown as CanvasFeatureContext

describe('the Mermaid paste handler', () => {
  it('is asked before bulk paste (which offers the outline mind map)', () => {
    const order = handlersFor([BULK_PASTE_HANDLER, MERMAID_PASTE_HANDLER], { kind: 'text', text: CHART })
    expect(order.map((h) => h.id)).toEqual(['flow.mermaid-paste', 'navigation.bulk-paste'])
  })

  it('takes a flowchart (and asks); leaves anything else, a read-only role and an insert to the next handler', () => {
    const f = fakeFlowCanvas([])
    const ctx = ctxOf(f)
    expect(
      MERMAID_PASTE_HANDLER.handle({ kind: 'text', text: '# Plan\n- One\n- Two' }, ctx, null, 'paste'),
    ).toBe(false)
    expect(MERMAID_PASTE_HANDLER.handle({ kind: 'text', text: CHART }, ctx, null, 'insert')).toBe(false)
    expect(pendingMermaid(f.canvas).get()).toBeNull()
    expect(MERMAID_PASTE_HANDLER.handle({ kind: 'text', text: CHART }, ctx, { x: 10, y: 20 }, 'paste')).toBe(
      true,
    )
    expect(pendingMermaid(f.canvas).get()).toMatchObject({ text: CHART, center: { x: 10, y: 20 } })
    pendingMermaid(f.canvas).set(null)
    f.setReadOnly(true)
    expect(MERMAID_PASTE_HANDLER.handle({ kind: 'text', text: CHART }, ctx, null, 'paste')).toBe(false)
  })

  it('the prompt says what the paste makes and, before anything is written, what the caps shorten or leave out', () => {
    const f = fakeFlowCanvas([])
    const ctx = ctxOf(f)
    MERMAID_PASTE_HANDLER.handle({ kind: 'text', text: CHART }, ctx, null, 'paste')
    const plain = pendingMermaid(f.canvas).get()
    if (!plain) throw new Error('no prompt')
    expect(mermaidPromptText(plain)).toBe(
      'Paste this Mermaid flowchart as a diagram? 3 shapes, 3 connectors.',
    )
    const long = `flowchart TD\nA[${'word '.repeat(40)}] --> B\nB --> C[${'more '.repeat(40)}]\nA --> B\nB --> B`
    MERMAID_PASTE_HANDLER.handle({ kind: 'text', text: long }, ctx, null, 'paste')
    const capped = pendingMermaid(f.canvas).get()
    if (!capped) throw new Error('no prompt')
    expect(capped).toMatchObject({ shortened: 2, dropped: 2 })
    expect(mermaidPromptText(capped)).toBe(
      'Paste this Mermaid flowchart as a diagram? 3 shapes, 2 connectors. 2 long labels are shortened. 2 links are left out (repeated, or from a shape to itself).',
    )
    expect(mermaidPromptText({ ...capped, shortened: 1, dropped: 1 })).toContain(
      '1 long label is shortened. 1 link is left out',
    )
  })
})

describe('Paste as diagram', () => {
  it('one undo step, bound connectors, no AI provenance', () => {
    const f = fakeFlowCanvas([])
    const graph = parseMermaidLite(CHART)
    if (!graph) throw new Error('no graph')
    const ids = pasteAsDiagram(ctxOf(f), graph, { x: 0, y: 0 })
    expect(ids.length).toBe(3 * 2 + 3 + 2)
    const arrows = f.live().filter((e) => e.type === 'arrow')
    expect(arrows).toHaveLength(3)
    for (const a of arrows) expect(a.startBinding && a.endBinding).toBeTruthy()
    for (const e of f.live()) expect(e.customData).toBeUndefined()
    expect(f.steps()).toBe(1)
    f.undo()
    expect(f.live()).toHaveLength(0)
  })

  it('a dotted link is a dashed connector; an open link has no arrowhead', () => {
    const f = fakeFlowCanvas([])
    const graph = parseMermaidLite(
      ['flowchart LR', 'A[Brief] --> B{OK?}', 'B -->|yes| C((Ship))', 'B -. no .-> A', 'C --- A'].join('\n'),
    )
    if (!graph) throw new Error('no graph')
    pasteAsDiagram(ctxOf(f), graph, { x: 0, y: 0 })
    const arrows = f.live().filter((e) => e.type === 'arrow')
    expect(arrows).toHaveLength(4)
    expect(arrows.filter((e) => e.strokeStyle === 'dashed')).toHaveLength(1)
    expect(arrows.filter((e) => e.endArrowhead === null)).toHaveLength(1)
  })

  it('goes in an empty spot near the paste point, and into the frame under it when it fits', () => {
    const f = fakeFlowCanvas([{ id: 'block', type: 'rectangle', x: -100, y: -100, width: 200, height: 200 }])
    const spot = placeDiagram(f.canvas, { w: 300, h: 300 }, { x: 0, y: 0 })
    const hit =
      spot.origin.x < 100 && spot.origin.x + 300 > -100 && spot.origin.y < 100 && spot.origin.y + 300 > -100
    expect(hit).toBe(false)
    expect(spot.frameId).toBeNull()
    const g = fakeFlowCanvas([{ id: 'fr', type: 'frame', x: -500, y: -500, width: 1000, height: 1000 }])
    expect(placeDiagram(g.canvas, { w: 300, h: 300 }, { x: 0, y: 0 }).frameId).toBe('fr')
  })
})
