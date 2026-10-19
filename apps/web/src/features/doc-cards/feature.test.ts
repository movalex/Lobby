// The doc cards feature in Node: what it offers with its switch off and on, the two writes that make a card (one
// transact each), the face's React nodes (never HTML), and the export layer (marks taken out, the face never drawn).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import { setFormatsOffer } from '../formats/flags.ts'
import { DocBlocks } from './DocBlocks.tsx'
import { docCardSvg, segmentsOf } from './export.ts'
import { COMMANDS, feature, OVERLAYS, PANELS } from './index.tsx'
import { parseMarkdownLite } from './markdown-lite.ts'
import {
  DOC_CARD_H,
  DOC_CARD_KIND,
  DOC_CARD_W,
  docCardFromText,
  docCardOf,
  fromTextTarget,
  insertDocCard,
  isDocCard,
} from './model.ts'

afterEach(() => setFormatsOffer(null))

interface Tx {
  label: string
  creates: { kind: string; props: Record<string, unknown> }[]
  updates: { id: string; patch: Record<string, unknown> }[]
  deletes: string[]
}

/** A canvas with the members the model uses: every transact is recorded, creates land in `els`. */
function fakeCanvas(initial: Record<string, unknown>[] = [], o: { readOnly?: boolean } = {}) {
  const els = new Map<string, Record<string, unknown>>(initial.map((e) => [e.id as string, e]))
  const txs: Tx[] = []
  let selection: string[] = []
  const canvas = {
    readOnly: () => o.readOnly ?? false,
    get: (id: string) => els.get(id) as CanvasElement | undefined,
    items: () => [...els.values()].filter((e) => !e.isDeleted) as unknown as CanvasElement[],
    bounds: (id: string) => {
      const e = els.get(id)
      return e
        ? { x: e.x as number, y: e.y as number, width: e.width as number, height: e.height as number }
        : null
    },
    isLocked: (id: string) => !!els.get(id)?.locked,
    isHidden: () => false,
    leaseHolder: () => null,
    editingId: () => null,
    get selection() {
      return selection
    },
    select: (ids: string[]) => {
      selection = ids
    },
    viewport: {
      get: () => ({ x: 0, y: 0, width: 1600, height: 900, zoom: 1 }),
      screenRect: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
      limits: () => ({ min: 0.1, max: 4 }),
      set: () => {},
    },
    boundsOf: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    container: () => null,
    index: {
      byKind: (k: string) =>
        [...els.values()].filter((e) => (e.customData as { lobby?: { kind?: string } })?.lobby?.kind === k),
    },
    transact(label: string, fn: (tx: unknown) => unknown) {
      const t: Tx = { label, creates: [], updates: [], deletes: [] }
      const r = fn({
        create: (kind: string, props: Record<string, unknown>) => {
          t.creates.push({ kind, props })
          els.set(props.id as string, { type: kind, ...props })
          return props.id
        },
        update: (id: string, patch: Record<string, unknown>) => {
          t.updates.push({ id, patch })
          els.set(id, { ...(els.get(id) ?? {}), ...patch })
        },
        delete: (id: string) => {
          t.deletes.push(id)
          els.set(id, { ...(els.get(id) ?? {}), isDeleted: true })
        },
      })
      txs.push(t)
      return r
    },
  }
  return { canvas: canvas as unknown as LobbyCanvas, txs, els }
}

describe('the switch', () => {
  it('off: no command offered, no face drawn, no panel listed', () => {
    setFormatsOffer({ docCards: false })
    for (const c of COMMANDS) expect(c.available?.({} as never), c.id).toBe(false)
    expect(PANELS[0]?.visible?.({ canvas: fakeCanvas().canvas } as never)).toBe(false)
    expect(feature.id).toBe('doc-cards')
    expect(OVERLAYS.map((o) => o.id)).toEqual(['doc-cards.faces'])
  })

  it('the shipped web switch keeps it off even when the api offers it (the lead turns FORMATS_FLAGS.docCards on)', () => {
    setFormatsOffer({ docCards: true })
    for (const c of COMMANDS) expect(c.available?.({} as never), c.id).toBe(false)
  })
})

describe('making a doc card', () => {
  it('insert: a 640 × 400 rectangle of kind doc-card and its top-left label, in ONE transact, selected', () => {
    const { canvas, txs } = fakeCanvas()
    const id = insertDocCard(canvas, { at: { x: 1000, y: 500 } })
    expect(id).toBeTruthy()
    expect(txs).toHaveLength(1)
    const [card, label] = txs[0]?.creates ?? []
    expect(card?.kind).toBe('rectangle')
    expect(card?.props).toMatchObject({
      id,
      width: DOC_CARD_W,
      height: DOC_CARD_H,
      x: 1000 - DOC_CARD_W / 2,
      y: 500 - DOC_CARD_H / 2,
      backgroundColor: '#ffffff',
      strokeWidth: 1,
      customData: { lobby: { kind: DOC_CARD_KIND } },
    })
    expect(label?.kind).toBe('text')
    expect(label?.props).toMatchObject({
      containerId: id,
      textAlign: 'left',
      verticalAlign: 'top',
      fontFamily: 6,
      originalText: '# Untitled doc\n\n',
    })
    expect(card?.props.boundElements).toEqual([{ id: label?.props.id, type: 'text' }])
    expect(canvas.selection).toEqual([id])
    expect(isDocCard(canvas.get(id as string))).toBe(true)
    expect(docCardOf(canvas, canvas.get(label?.props.id as string))?.id).toBe(id)
  })

  it('insert on a read-only board writes nothing', () => {
    const { canvas, txs } = fakeCanvas([], { readOnly: true })
    expect(insertDocCard(canvas)).toBeNull()
    expect(txs).toEqual([])
  })

  it('from text: the card holds the text’s words where it was, the text removed, in ONE transact', () => {
    const text = {
      id: 't1',
      type: 'text',
      x: 100,
      y: 200,
      width: 300,
      height: 40,
      text: '# Notes\n- a',
      originalText: '# Notes\n- a',
      containerId: null,
    }
    const { canvas, txs } = fakeCanvas([text])
    expect(fromTextTarget(canvas, ['t1'])?.id).toBe('t1')
    const r = docCardFromText(canvas, ['t1'])
    expect(r.ok).toBe(true)
    expect(txs).toHaveLength(1)
    expect(txs[0]?.deletes).toEqual(['t1'])
    expect(txs[0]?.creates.map((c) => c.kind)).toEqual(['rectangle', 'text'])
    expect(txs[0]?.creates[1]?.props.originalText).toBe('# Notes\n- a')
    expect(txs[0]?.creates[0]?.props).toMatchObject({ x: 95, y: 195 })
    // a bound label, a sticky note or nothing selected is not a target
    expect(fromTextTarget(canvas, [])).toBeNull()
    expect(fromTextTarget(canvas, ['t1', 'x'])).toBeNull()
  })
})

describe('the face draws React nodes, never HTML', () => {
  const html = (words: string, onToggle: ((l: number) => void) | null = null) =>
    renderToStaticMarkup(createElement(DocBlocks, { doc: parseMarkdownLite(words), mode: 'face', onToggle }))

  it('typed tags are text, a refused link has no href, a safe one opens with noopener', () => {
    const out = html(
      '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[bad](javascript:alert`1`)\n[ok](https://example.com)\n[board](/b/brd_1)',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('href="https://example.com/"')
    expect(out).toContain('href="/b/brd_1"')
    expect(out).toMatch(/rel="noopener noreferrer"/)
    expect(out).toContain('data-testid="doc-card-nolink"')
  })

  it('headings, lists and checklists are real structure; boxes are inputs only for editors', () => {
    const words = '# Title\n- [x] done\n- [ ] todo\n1. one'
    const ro = html(words)
    expect(ro).toContain('<h2 class="lobby-doc__heading" data-level="1">Title</h2>')
    expect(ro).toContain('<ul')
    expect(ro).toContain('<ol')
    expect(ro).not.toContain('<input')
    expect(ro).toContain('aria-label="Done"')
    expect(html(words, () => {})).toContain('type="checkbox"')
  })
})

describe('the export layer takes the marks out and never draws the face', () => {
  const card = {
    id: 'c',
    type: 'rectangle',
    x: 100,
    y: 100,
    width: 640,
    height: 400,
    backgroundColor: '#ffffff',
    fillStyle: 'solid',
    customData: { lobby: { kind: 'doc-card' } },
  } as unknown as CanvasElement
  const words = '# Plan\n- [ ] **ship** it\n> quote <b>\n---\n[docs](https://a.b)'
  const label = {
    id: 'c.t',
    type: 'text',
    x: 105,
    y: 105,
    width: 630,
    height: 125,
    text: words,
    originalText: words,
    fontSize: 16,
    fontFamily: 6,
    lineHeight: 1.25,
    strokeColor: '#1b2330',
    containerId: 'c',
  } as unknown as CanvasElement

  it('covers the label with the card’s fill and draws the words without # ** [ ] marks', () => {
    const svg = docCardSvg(card, label, { x: 100, y: 100 })
    expect(svg.startsWith('<rect x="4" y="4" width="632" height="127" fill="#ffffff"/>')).toBe(true)
    const words = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]).join('|')
    expect(words).toBe('Plan|☐ |ship| it|quote &lt;b&gt;|docs')
    expect(svg).not.toMatch(/\*\*|# |\[ \]|\]\(/)
    expect(svg).toContain('font-weight="700"')
    expect(svg).toContain('text-decoration="underline"')
    expect(svg).not.toContain('href')
    expect(svg).not.toContain('<foreignObject')
  })

  it('a transparent card keeps the engine’s plain words (nothing to cover them with)', () => {
    expect(
      docCardSvg({ ...card, backgroundColor: 'transparent' } as CanvasElement, label, { x: 0, y: 0 }),
    ).toBe('')
  })

  it('maps the wrapped lines onto the source lines (a long line wraps in two)', () => {
    expect(segmentsOf('# A\nlong words here', '# A\nlong words\nhere')).toEqual([
      { line: 0, from: 0, to: 3, first: true },
      { line: 1, from: 0, to: 10, first: true },
      { line: 1, from: 11, to: 15, first: false },
    ])
    expect(segmentsOf('a\n\nb', 'a\n\nb')).toHaveLength(3)
    // a stale layout: one segment per source line
    expect(segmentsOf('abc', 'xyz')).toEqual([{ line: 0, from: 0, to: 3, first: true }])
  })
})
