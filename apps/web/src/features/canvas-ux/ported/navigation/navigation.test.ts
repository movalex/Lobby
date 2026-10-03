// 3b's ported navigation over a small in-memory canvas (the LobbyCanvas members these modules use): the
// element adapters, board search, frame order writes, select by type, arrange as grid, paste as notes,
// the stored view and the deep links.
import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { describe, expect, it } from 'vitest'
import type {
  Bounds,
  CanvasElement,
  CanvasFeatureContext,
  LobbyCanvas,
  LobbyTx,
  Viewport,
} from '../../../../canvas/api/index.ts'
import { arrangeSelectionAsGrid, hasArrangeable } from './arrange-grid.ts'
import { analyzeBulkPaste, BULK_PASTE_HANDLER, pasteAsNotes, pasteGrid } from './bulk-paste.tsx'
import { boxOf } from './camera.ts'
import { chromeMayZoom } from './chrome-keys.ts'
import { linkToElements } from './copy-link.ts'
import { autoOrderWrites, presentOrderWrites } from './FramesPanel.tsx'
import { feature } from './index.tsx'
import { frameAt, frameRows, legacyTypeOf, lockedInCanvas, searchCanvas } from './model.ts'
import { keepOnlyCategory, selectAllOfCategory, selectionKeepOnlyChoices } from './select-by-type.ts'
import { navigateToDeepLink, parseStoredView, readBoardStartView, readStoredView } from './start-view.ts'
import { pendingPaste } from './state.ts'
import { codeSelectionBoxes, selectByCode, viewIsEmpty } from './view-helpers.ts'
import { wheelZoom, zoomAroundPoint } from './zoom.ts'

installServerTextMetrics()

// ---- a small canvas ------------------------------------------------------------------------------------

type El = Record<string, unknown> & { id: string; type: string }

function el(
  id: string,
  type: string,
  x: number,
  y: number,
  w = 100,
  h = 100,
  more: Record<string, unknown> = {},
): El {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    index: `a${id}`,
    boundElements: null,
    ...more,
  }
}
/** A note with its bound label. */
function note(id: string, x: number, y: number, text: string, more: Record<string, unknown> = {}): El[] {
  return [
    el(id, 'stickynote', x, y, 200, 200, { boundElements: [{ id: `${id}.t`, type: 'text' }], ...more }),
    el(`${id}.t`, 'text', x + 10, y + 10, 180, 30, {
      containerId: id,
      originalText: text,
      text,
      frameId: more.frameId ?? null,
      groupIds: more.groupIds ?? [],
    }),
  ]
}

interface Fake {
  canvas: LobbyCanvas
  ctx: CanvasFeatureContext
  els: Map<string, El>
  steps: string[]
  zooms: { bounds: Bounds; opts: unknown }[]
  notices: string[]
  doc: Map<string, unknown>
}

function fake(list: El[], opts: { readOnly?: boolean; role?: string } = {}): Fake {
  const els = new Map(list.map((e) => [e.id, e]))
  let selection: string[] = []
  let view: Viewport = { x: 0, y: 0, width: 1000, height: 600, zoom: 1 }
  const steps: string[] = []
  const zooms: { bounds: Bounds; opts: unknown }[] = []
  const notices: string[] = []
  const doc = new Map<string, unknown>()
  let next = 0
  const get = (id: string) => els.get(id) as unknown as CanvasElement | undefined
  const bounds = (id: string): Bounds | null => {
    const e = els.get(id)
    return e
      ? { x: e.x as number, y: e.y as number, width: e.width as number, height: e.height as number }
      : null
  }
  const live = () => [...els.values()].filter((e) => !e.isDeleted) as unknown as CanvasElement[]
  const union = (ids: readonly string[]) => {
    const bs = ids.map(bounds).filter((b): b is Bounds => !!b)
    if (!bs.length) return null
    const x = Math.min(...bs.map((b) => b.x))
    const y = Math.min(...bs.map((b) => b.y))
    return {
      x,
      y,
      width: Math.max(...bs.map((b) => b.x + b.width)) - x,
      height: Math.max(...bs.map((b) => b.y + b.height)) - y,
    }
  }
  const tx: LobbyTx = {
    // LobbyTx.insert (CR-2D-2, the wave-3 integration): not used by these tests
    insert() {
      throw new Error('insert: not in this in-memory canvas')
    },
    create(kind, props) {
      const id = (props.id as string | undefined) ?? `new${++next}`
      if (kind === 'note') {
        for (const e of note(id, props.x as number, props.y as number, String(props.text ?? '')))
          els.set(e.id, e)
      } else
        els.set(id, el(id, kind, props.x as number, props.y as number, 100, 30, { originalText: props.text }))
      return id
    },
    update(id, patch) {
      const e = els.get(id)
      if (!e) throw new Error(`no ${id}`)
      const out: El = { ...e, ...patch }
      if (patch.customData) {
        const lobby = { ...((e.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}) }
        for (const [k, v] of Object.entries((patch.customData as { lobby: Record<string, unknown> }).lobby)) {
          if (v === null) delete lobby[k]
          else lobby[k] = v
        }
        out.customData = { lobby }
      }
      els.set(id, out)
    },
    delete(id) {
      const e = els.get(id)
      if (e) els.set(id, { ...e, isDeleted: true })
    },
    createMany: () => [],
    reorder: () => {},
    setFrame(ids, frameId) {
      for (const id of ids) {
        const e = els.get(id)
        if (e) els.set(id, { ...e, frameId })
        const label = e?.boundElements as { id: string }[] | null
        for (const b of label ?? []) {
          const l = els.get(b.id)
          if (l) els.set(b.id, { ...l, frameId })
        }
      }
    },
    group: () => 'g',
    ungroup: () => {},
    bind: () => {},
    duplicate: () => new Map(),
  }
  const canvas = {
    items: live,
    get,
    bounds,
    boundsOf: (ids?: readonly string[]) => union(ids ?? selection),
    get selection() {
      return selection
    },
    select: (ids: readonly string[]) => {
      selection = [...ids]
    },
    isHidden: () => false,
    isLocked: (id: string) => {
      const e = get(id)
      return !!e && lockedInCanvas(e, get)
    },
    readOnly: () => opts.readOnly === true,
    editingId: () => null,
    tool: () => 'select',
    setTool: () => true,
    focus: () => {},
    container: () => null,
    transact<T>(label: string, fn: (t: LobbyTx) => T, o?: { joinPrevious?: boolean }): T {
      steps.push(o?.joinPrevious ? `${label} (joined)` : label)
      return fn(tx)
    },
    doc: {
      get: (k: string) => doc.get(k),
      set: (e: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(e)) doc.set(k, v)
      },
    },
    viewport: {
      get: () => view,
      set: (v: Partial<Viewport>) => {
        view = { ...view, ...v }
      },
      zoomTo: (b: Bounds, o: unknown) => {
        zooms.push({ bounds: b, opts: o })
      },
      limits: () => ({ min: 0.1, max: 8, steps: [0.1, 1, 8], fit: 1 }),
    },
  } as unknown as LobbyCanvas
  const ctx = {
    canvas,
    role: opts.role ?? 'owner',
    board: { id: 'b1', status: 'active' },
    notify: (n: { text: string }) => void notices.push(n.text),
    dismiss: () => {},
    openPanel: () => {},
    activePanel: null,
  } as unknown as CanvasFeatureContext
  return { canvas, ctx, els, steps, zooms, notices, doc }
}

const at = (f: Fake, id: string) => {
  const e = f.els.get(id) as El
  return { x: e.x as number, y: e.y as number }
}

// ---- element adapters and search -----------------------------------------------------------------------

describe('what an element is called', () => {
  it('maps elements to the tldraw shape types of the search filters and categories', () => {
    const f = fake([
      ...note('n', 0, 0, 'hello'),
      el('t', 'text', 0, 0),
      el('r', 'rectangle', 0, 0),
      el('e', 'ellipse', 0, 0),
      el('a', 'arrow', 0, 0),
      el('f', 'frame', 0, 0),
      el('i', 'image', 0, 0),
      el('p', 'image', 0, 0, 1, 1, { customData: { lobby: { file: { kind: 'pdf' } } } }),
      el('v', 'image', 0, 0, 1, 1, { customData: { lobby: { file: { kind: 'video' } } } }),
      el('d', 'freedraw', 0, 0),
      el('h', 'freedraw', 0, 0, 1, 1, { customData: { lobby: { kind: 'highlight' } } }),
    ])
    const type = (id: string) => legacyTypeOf(f.canvas.get(id) as CanvasElement)
    expect(['n', 'n.t', 't', 'r', 'e', 'a', 'f', 'i', 'p', 'v', 'd', 'h'].map(type)).toEqual([
      'note',
      null,
      'text',
      'geo',
      'geo',
      'arrow',
      'frame',
      'image',
      FILE_CARD_TYPE,
      'video',
      'draw',
      'highlight',
    ])
  })

  it('a shape inside a locked frame is locked; a label follows its container', () => {
    const f = fake([
      el('f', 'frame', 0, 0, 500, 500, { locked: true }),
      ...note('n', 10, 10, 'x', { frameId: 'f' }),
    ])
    const get = (id: string) => f.canvas.get(id)
    expect(lockedInCanvas(f.canvas.get('n') as CanvasElement, get)).toBe(true)
    expect(lockedInCanvas(f.canvas.get('n.t') as CanvasElement, get)).toBe(true)
  })

  it('searches labels, names and file names; filters narrow; hidden hits leave', () => {
    const f = fake([
      ...note('whale', 0, 0, 'Blue whale sketch'),
      ...note('fox', 300, 0, 'Red fox'),
      el('period', 'frame', 0, 700, 400, 300, { name: 'Blue period' }),
      el('img', 'image', 900, 0, 100, 100, {
        customData: { lobby: { file: { kind: 'image', name: 'blue-lagoon.png' } } },
      }),
    ])
    const all = (filter: 'all' | 'frames' | 'images' | 'notes', hidden = new Set<string>()) =>
      searchCanvas(f.canvas.items(), 'blue', { limit: 50, filter, isHidden: (id) => hidden.has(id) })
        .map((h) => h.id)
        .sort()
    expect(all('all')).toEqual(['img', 'period', 'whale'])
    expect(all('frames')).toEqual(['period'])
    expect(all('images')).toEqual(['img'])
    expect(all('notes', new Set(['whale']))).toEqual([])
    expect(searchCanvas(f.canvas.items(), '  ', { limit: 5, filter: 'all', isHidden: () => false })).toEqual(
      [],
    )
  })
})

// ---- frames -------------------------------------------------------------------------------------------------

describe('frame order', () => {
  const frames = () =>
    fake([
      el('f1', 'frame', 0, 0, 400, 300, { name: 'Intro' }),
      el('f2', 'frame', 700, 0, 400, 300, { name: 'Conflict' }),
      el('f3', 'frame', 1400, 0, 400, 300, {
        name: 'Resolution',
        customData: { lobby: { present: { skip: true } } },
      }),
    ])

  it('rows follow the layout, then an explicit order writes present.index on every frame, keeping skip', () => {
    const f = frames()
    const rows = frameRows(f.canvas.items())
    expect(rows.map((r) => r.id)).toEqual(['f1', 'f2', 'f3'])
    expect(rows.map((r) => r.skip)).toEqual([false, false, true])
    const writes = presentOrderWrites(rows, ['f3', 'f1', 'f2'])
    expect(writes).toEqual([
      { id: 'f3', present: { index: 0, skip: true } },
      { id: 'f1', present: { index: 1 } },
      { id: 'f2', present: { index: 2 } },
    ])
    for (const w of writes)
      f.canvas.transact('x', (tx) => tx.update(w.id, { customData: { lobby: { present: w.present } } }))
    expect(frameRows(f.canvas.items()).map((r) => r.id)).toEqual(['f3', 'f1', 'f2'])
    // auto-order clears the indices (skip stays) and the order follows the layout again
    for (const w of autoOrderWrites(frameRows(f.canvas.items())))
      f.canvas.transact('x', (tx) => tx.update(w.id, { customData: { lobby: { present: w.present } } }))
    expect(frameRows(f.canvas.items()).map((r) => [r.id, r.presentIndex, r.skip])).toEqual([
      ['f1', null, false],
      ['f2', null, false],
      ['f3', null, true],
    ])
  })

  it('a locked frame keeps its place (the server refuses customData on locked elements)', () => {
    const f = fake([
      el('f1', 'frame', 0, 0, 400, 300, { name: 'A' }),
      el('f2', 'frame', 700, 0, 400, 300, { name: 'B', locked: true }),
    ])
    const writes = presentOrderWrites(frameRows(f.canvas.items()), ['f2', 'f1'])
    expect(writes.map((w) => w.id)).toEqual(['f1'])
  })

  it('finds the unlocked frame under a point', () => {
    const f = fake([
      el('big', 'frame', 0, 0, 1000, 1000),
      el('small', 'frame', 100, 100, 200, 200),
      el('lk', 'frame', 2000, 0, 100, 100, { locked: true }),
    ])
    expect(frameAt(f.canvas, { x: 150, y: 150 })?.id).toBe('small')
    expect(frameAt(f.canvas, { x: 900, y: 900 })?.id).toBe('big')
    expect(frameAt(f.canvas, { x: 2050, y: 50 })).toBeNull()
  })
})

// ---- select by type --------------------------------------------------------------------------------------

describe('select by type', () => {
  it('selects every note on the board (inside frames too), never a locked one; keep only narrows', () => {
    const f = fake([
      el('fr', 'frame', 0, 0, 1000, 1000),
      ...note('n1', 10, 10, 'a', { frameId: 'fr' }),
      ...note('n2', 400, 10, 'b'),
      ...note('n3', 800, 10, 'c', { locked: true }),
      el('img', 'image', 0, 600, 100, 100),
    ])
    expect(selectAllOfCategory(f.ctx, 'notes')).toBe(2)
    expect([...f.canvas.selection].sort()).toEqual(['n1', 'n2'])
    expect(f.notices.at(-1)).toBe('2 notes selected.')
    // a selected frame with a note in it: keep only notes picks the note inside
    f.canvas.select(['fr', 'img'])
    expect(selectionKeepOnlyChoices(f.canvas).map((c) => [c.id, c.count])).toEqual([
      ['notes', 1],
      ['images', 1],
      ['frames', 1],
    ])
    expect(keepOnlyCategory(f.ctx, 'images')).toBe(1)
    expect(f.canvas.selection).toEqual(['img'])
    expect(f.notices.at(-1)).toBe('1 image selected.')
  })
})

// ---- arrange as grid ----------------------------------------------------------------------------------------

describe('arrange as grid', () => {
  it('four scattered notes become a 2 × 2 grid at their top-left, labels moving with their notes, one step', () => {
    const f = fake([
      ...note('a', 0, 0, 'a'),
      ...note('b', 900, 40, 'b'),
      ...note('c', 30, 700, 'c'),
      ...note('d', 1000, 800, 'd'),
      el('arrow', 'arrow', 0, 0, 10, 10, { startBinding: { elementId: 'a' }, endBinding: null }),
    ])
    f.canvas.select(['a', 'b', 'c', 'd', 'arrow'])
    expect(hasArrangeable(f.canvas)).toBe(true)
    const out = arrangeSelectionAsGrid(f.canvas)
    expect(out).toMatchObject({ moved: 4, columns: 2, rows: 2, locked: 0 })
    expect(f.steps).toEqual(['arrange as grid'])
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => at(f, id)) as { x: number; y: number }[]
    expect(a).toEqual({ x: 0, y: 0 })
    expect(b?.y).toBe(a?.y)
    expect(c?.x).toBe(a?.x)
    expect(d).toEqual({ x: b?.x, y: c?.y })
    // each label moved by its note's delta
    expect(at(f, 'b.t')).toEqual({ x: (b?.x ?? 0) + 10, y: (b?.y ?? 0) + 10 })
    // the bound connector did not move (the server re-snaps it)
    expect(at(f, 'arrow')).toEqual({ x: 0, y: 0 })
  })

  it('a locked note stays and is counted; a grouped pair moves as one; fewer than two units is nothing', () => {
    const f = fake([
      ...note('a', 0, 0, 'a', { groupIds: ['g1'] }),
      ...note('b', 220, 0, 'b', { groupIds: ['g1'] }),
      ...note('c', 900, 900, 'c'),
      ...note('lk', 2000, 0, 'lk', { locked: true }),
    ])
    f.canvas.select(['a', 'b', 'lk'])
    expect(hasArrangeable(f.canvas)).toBe(false)
    expect(arrangeSelectionAsGrid(f.canvas)).toBeNull()
    f.canvas.select(['a', 'b', 'c', 'lk'])
    const out = arrangeSelectionAsGrid(f.canvas)
    expect(out).toMatchObject({ moved: 2, locked: 1 })
    expect(at(f, 'lk')).toEqual({ x: 2000, y: 0 })
    // the group kept its shape
    expect(at(f, 'b').x - at(f, 'a').x).toBe(220)
  })

  it('inside a frame the grid stays in it, and a too-small frame grows', () => {
    const f = fake([
      el('fr', 'frame', 1000, 1000, 300, 300),
      ...['a', 'b', 'c', 'd', 'e', 'f'].flatMap((id, i) =>
        note(id, 1010 + i * 5, 1010 + i * 5, id, { frameId: 'fr' }),
      ),
    ])
    f.canvas.select(['a', 'b', 'c', 'd', 'e', 'f'])
    const out = arrangeSelectionAsGrid(f.canvas)
    expect(out?.frameGrew).toBe(true)
    const fr = f.els.get('fr') as El
    expect(fr.width as number).toBeGreaterThan(300)
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const p = at(f, id)
      expect(p.x).toBeGreaterThanOrEqual(1000)
      expect(p.y).toBeGreaterThanOrEqual(1000)
      expect((f.els.get(id) as El).frameId).toBe('fr')
    }
  })
})

// ---- paste as notes -----------------------------------------------------------------------------------------

describe('paste as notes', () => {
  const TSV = 'Setup\tConflict\tPayoff\nHero\t\tVillain\nCity\tStorm\tHome'

  it('asks only for more than one cell', () => {
    expect(analyzeBulkPaste('one idea, stated once')).toBeNull()
    expect(analyzeBulkPaste(TSV)).toEqual({ cells: 8, rows: 3 })
    const f = fake([])
    expect(BULK_PASTE_HANDLER.handle({ kind: 'text', text: 'one line' }, f.ctx, null, 'paste')).toBe(false)
    expect(BULK_PASTE_HANDLER.handle({ kind: 'text', text: TSV }, f.ctx, { x: 10, y: 20 }, 'paste')).toBe(
      true,
    )
    expect(pendingPaste(f.canvas).get()).toMatchObject({ cells: 8, center: { x: 10, y: 20 } })
    const ro = fake([], { readOnly: true })
    expect(BULK_PASTE_HANDLER.handle({ kind: 'text', text: TSV }, ro.ctx, null, 'paste')).toBe(false)
  })

  it('keeps the source layout (the empty cell stays a gap) and reflows a long column', () => {
    const { cells } = pasteGrid(TSV)
    expect(cells.map((c) => c.text)).toEqual([
      'Setup',
      'Conflict',
      'Payoff',
      'Hero',
      'Villain',
      'City',
      'Storm',
      'Home',
    ])
    const xs = [...new Set(cells.map((c) => c.x))]
    const ys = [...new Set(cells.map((c) => c.y))]
    expect([xs.length, ys.length]).toEqual([3, 3])
    const col = pasteGrid(['a', 'b', 'c', 'd', 'e'].join('\n')).cells
    expect(new Set(col.map((c) => c.x)).size).toBe(3) // ceil(sqrt(5)) columns
  })

  it('makes one note per cell in one step, selected, clear of what is there', () => {
    const f = fake([...note('there', -100, -100, 'Already here')])
    const ids = pasteAsNotes(f.ctx, TSV, { x: 0, y: 0 })
    expect(ids).toHaveLength(8)
    expect(f.steps).toEqual(['paste as notes'])
    expect([...f.canvas.selection]).toEqual(ids)
    const there = { x: -100, y: -100, w: 200, h: 200 }
    for (const id of ids) {
      const p = at(f, id)
      const overlaps =
        p.x < there.x + there.w && there.x < p.x + 200 && p.y < there.y + there.h && there.y < p.y + 200
      expect(overlaps).toBe(false)
    }
  })

  it('goes into the frame under the paste point when it fits', () => {
    const f = fake([el('fr', 'frame', 0, 0, 2000, 2000)])
    const ids = pasteAsNotes(f.ctx, 'a\nb\nc', { x: 1000, y: 1000 })
    expect(ids.map((id) => (f.els.get(id) as El).frameId)).toEqual(['fr', 'fr', 'fr'])
    expect(ids.map((id) => (f.els.get(`${id}.t`) as El).frameId)).toEqual(['fr', 'fr', 'fr'])
    // one undo step: the frame membership is folded into the paste
    expect(f.steps).toEqual(['paste as notes', 'paste as notes (joined)'])
  })
})

// ---- the first view ------------------------------------------------------------------------------------------

describe('the stored view and the deep links', () => {
  it('reads the new view, else a tldraw camera moved by its page offset', () => {
    expect(parseStoredView('{"x":-10,"y":20,"zoom":0.5}')).toEqual({ x: -10, y: 20, zoom: 0.5 })
    for (const bad of ['', 'nope', '{"x":1,"y":2}', '{"x":1,"y":2,"zoom":0}', '{"x":"1","y":2,"zoom":1}'])
      expect(parseStoredView(bad)).toBeNull()
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    try {
      const f = fake([])
      f.doc.set('import', {
        legacyPages: { 'page:page': { dx: 0, dy: 0 }, 'page:two': { dx: 5000, dy: -40 } },
      })
      store.set('draftroom:camera:v1:u1:b1', JSON.stringify({ pageId: 'page:two', x: -100, y: -200, z: 0.5 }))
      expect(readStoredView(f.canvas, 'b1', 'u1')).toEqual({ x: 5100, y: 160, zoom: 0.5 })
      store.set('draftroom:camera:v2:u1:b1', JSON.stringify({ x: 1, y: 2, zoom: 3 }))
      expect(readStoredView(f.canvas, 'b1', 'u1')).toEqual({ x: 1, y: 2, zoom: 3 })
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })

  it('reads the board start view (lb_doc.startView)', () => {
    const f = fake([])
    expect(readBoardStartView(f.canvas)).toBeNull()
    f.doc.set('startView', { x: 1, y: 2, w: 300, h: 200, frameId: 'fr' })
    expect(readBoardStartView(f.canvas)).toEqual({ x: 1, y: 2, w: 300, h: 200, frameId: 'fr' })
    f.doc.set('startView', { x: 1, y: 2, w: 0, h: 200 })
    expect(readBoardStartView(f.canvas)).toBeNull()
  })

  it('a legacy shapes link selects the live elements it names (through legacyIds) and fits them at ≤ 100%', () => {
    const f = fake([...note('n1', 0, 0, 'a'), ...note('xk3', 500, 0, 'b')])
    f.doc.set('import', { legacyIds: { 'shape:we!rd': 'xk3' } })
    navigateToDeepLink(f.canvas, { kind: 'legacy-shapes', parts: ['n1', 'gone', 'we!rd'] })
    expect([...f.canvas.selection]).toEqual(['n1', 'xk3'])
    expect(f.zooms.at(-1)).toMatchObject({
      bounds: { x: 0, y: 0, width: 700, height: 200 },
      opts: { maxZoom: 1 },
    })
    // nothing it names is there: all content at no more than 100%
    f.canvas.select([])
    navigateToDeepLink(f.canvas, { kind: 'elements', ids: ['gone'] })
    expect(f.canvas.selection).toEqual([])
    expect(f.zooms.at(-1)?.opts).toMatchObject({ maxZoom: 1 })
    // a view link: exactly that rectangle
    navigateToDeepLink(f.canvas, { kind: 'view', bounds: { x: 10, y: 20, w: 300, h: 100 } })
    expect(f.zooms.at(-1)).toMatchObject({
      bounds: { x: 10, y: 20, width: 300, height: 100 },
      opts: { inset: 0 },
    })
  })

  it('copy link builds ?el= on the board URL', () => {
    expect(linkToElements(['a', 'b.t'], 'https://x.example/b/brd1?d=old#h')).toBe(
      'https://x.example/b/brd1?el=a,b.t',
    )
    expect(linkToElements([], 'https://x.example/b/brd1?el=a')).toBe('https://x.example/b/brd1')
  })
})

describe('wave 3b: the zoom wheel below 0.1, the camera keys from the chrome, one-pass boxes', () => {
  const limits = { min: 0.02, max: 8 }

  it('the wheel below 0.1: 10% per notch around the floor, the engine’s own wheel from 0.1 up', () => {
    // zooming out at the engine's floor: Lobby's, down to the whole-board fit
    expect(wheelZoom(0.1, { deltaY: 100, deltaMode: 0 }, limits)).toBeCloseTo(0.09)
    expect(wheelZoom(0.05, { deltaY: 3, deltaMode: 0 }, limits)).toBeCloseTo(0.0485)
    expect(wheelZoom(0.021, { deltaY: 100, deltaMode: 0 }, limits)).toBe(0.02)
    expect(wheelZoom(0.02, { deltaY: 100, deltaMode: 0 }, limits)).toBe(0.02)
    // lines (Firefox): 16 px each, still one step at most
    expect(wheelZoom(0.1, { deltaY: 3, deltaMode: 1 }, limits)).toBeCloseTo(0.09)
    // zooming in from below 0.1 is Lobby's; from 0.1 it is the engine's
    expect(wheelZoom(0.05, { deltaY: -100, deltaMode: 0 }, limits)).toBeCloseTo(0.055)
    expect(wheelZoom(0.1, { deltaY: -100, deltaMode: 0 }, limits)).toBeNull()
    expect(wheelZoom(0.5, { deltaY: 100, deltaMode: 0 }, limits)).toBeNull()
    // a board that fits at 0.1 has no floor below it: the engine's wheel everywhere
    expect(wheelZoom(0.1, { deltaY: 100, deltaMode: 0 }, { min: 0.1, max: 8 })).toBeNull()
    expect(wheelZoom(0.1, { deltaY: 0, deltaMode: 0 }, limits)).toBeNull()
  })

  it('a zoom around a point keeps that point where it is', () => {
    const to = zoomAroundPoint({ x: 0, y: 0, zoom: 0.1 }, { x: 5000, y: 3000 }, 0.05)
    expect((5000 - to.x) * 0.05).toBeCloseTo(5000 * 0.1)
    expect((3000 - to.y) * 0.05).toBeCloseTo(3000 * 0.1)
  })

  it('the camera keys act from the chrome, never from a field, a menu, a dialog or the canvas', () => {
    const spot = { textEntry: false, ownsKeys: false, modalOpen: false, onCanvas: false }
    expect(chromeMayZoom(spot)).toBe(true)
    expect(chromeMayZoom({ ...spot, textEntry: true })).toBe(false)
    expect(chromeMayZoom({ ...spot, ownsKeys: true })).toBe(false)
    expect(chromeMayZoom({ ...spot, modalOpen: true })).toBe(false)
    expect(chromeMayZoom({ ...spot, onCanvas: true })).toBe(false)
  })

  it('an element box from its fields (the whole-board loops no longer call the port’s per-id bounds)', () => {
    const [n] = note('n1', 100, 50, 'x')
    expect(boxOf(n as unknown as CanvasElement)).toEqual({ x: 100, y: 50, width: 200, height: 200 })
  })
})

describe('wave 5 review (W5-19, W5-33, W5-39, W5-54)', () => {
  it('W5-19: the wheel below 0.1 never zooms in on an out gesture and steps in proportion', () => {
    // below the floor (the board grew back smaller after a fit, a follow put the camera there): out stays
    expect(wheelZoom(0.03, { deltaY: 100, deltaMode: 0 }, { min: 0.05, max: 8 })).toBe(0.03)
    // below 0.1 on a board that fits at 0.1: the engine's wheel would snap out to 0.1 and step in by +0.1
    expect(wheelZoom(0.069, { deltaY: 100, deltaMode: 0 }, { min: 0.1, max: 8 })).toBe(0.069)
    expect(wheelZoom(0.069, { deltaY: -100, deltaMode: 0 }, { min: 0.1, max: 8 })).toBeCloseTo(0.0759)
    // a trackpad pinch's small deltas: a small proportional step either way
    expect(wheelZoom(0.069, { deltaY: -2, deltaMode: 0 }, { min: 0.1, max: 8 })).toBeCloseTo(0.069 * 1.02)
  })

  it('W5-33: the board menu has a View submenu with the zoom commands and the minimap', () => {
    const view = (feature.mainMenu ?? []).filter((e) => e.group === 'view')
    expect(view.map((e) => e.command ?? e.id)).toEqual([
      'navigation.zoom-in',
      'navigation.zoom-out',
      'navigation.zoom-to-100',
      'navigation.zoom-to-fit',
      'navigation.zoom-to-selection',
      'navigation.view.minimap',
    ])
    const commands = new Set((feature.commands ?? []).map((c) => c.id))
    for (const e of view) if (e.command) expect(commands.has(e.command), e.command).toBe(true)
    const f = fake(note('n1', 0, 0, 'x'))
    const sel = view.find((e) => e.command === 'navigation.zoom-to-selection')
    const target = { ids: [], point: null, hit: null }
    expect(sel?.disabled?.(f.ctx, target)).toBe(true)
    f.canvas.select(['n1'])
    expect(sel?.disabled?.(f.ctx, target)).toBe(false)
  })

  it('W5-39: a connector selected by a link or a search result gets an outline while that selection stands', () => {
    const f = fake([
      el('a1', 'arrow', 100, 100, 200, 0, {
        points: [
          [0, 0],
          [200, 0],
        ],
      }),
      ...note('n1', 500, 0, 'x'),
    ])
    Object.assign(f.canvas, { sceneToOverlay: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }) })
    selectByCode(f.canvas, ['a1', 'n1'])
    expect(f.canvas.selection).toEqual(['a1', 'n1'])
    // only the connector: the engine draws the note's own selection box
    expect(codeSelectionBoxes(f.canvas)).toEqual([{ id: 'a1', x: 92, y: 92, w: 216, h: 16 }])
    f.canvas.select(['a1'])
    expect(codeSelectionBoxes(f.canvas)).toEqual([])
    // CR 3b-11: a lone connector selected by code has the engine's own point handles, so no outline
    selectByCode(f.canvas, ['a1'])
    expect(f.canvas.selection).toEqual(['a1'])
    expect(codeSelectionBoxes(f.canvas)).toEqual([])
  })

  it('W5-54: "Back to content" shows only when the board has content and none of it is in view', () => {
    const f = fake(note('n1', 0, 0, 'x'))
    expect(viewIsEmpty(f.canvas)).toBe(false)
    f.canvas.viewport.set({ x: 50_000, y: 50_000 })
    expect(viewIsEmpty(f.canvas)).toBe(true)
    expect(viewIsEmpty(fake([]).canvas)).toBe(false)
  })
})
