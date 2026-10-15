// Wave Q (WS4): the new kits (arrows, callouts, badges, sticky-note kits, devices, storyboard frames and the
// deliverable frames) say what they promise: the categories and their pieces, tags that find them, exact pixel
// sizes and labelled guides on the deliverable frames, free arrows bound to nothing, real sticky notes and image
// slots. The per-piece checks every piece passes (element check, invariants, kinds, groups, origin) are in
// ./pieces.test.ts, which runs over the whole catalogue.
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { describe, expect, it } from 'vitest'
import { instantiatePiece, PIECE_CATEGORIES, PIECES, type PieceId, searchPieces } from './index.ts'

installServerTextMetrics()

const make = (id: PieceId) => instantiatePiece(id, { origin: { x: 0, y: 0 } })
const by = (category: string) => PIECES.filter((p) => p.category === category).map((p) => p.id)
const lobbyOf = (e: { customData?: { lobby?: Record<string, unknown> } }) => e.customData?.lobby ?? {}

describe('the new categories', () => {
  it('are listed after the old four, each with its pieces', () => {
    expect(PIECE_CATEGORIES.map((c) => c.id)).toEqual([
      'flowchart',
      'wireframe',
      'org-chart',
      'agency',
      'arrows',
      'callouts',
      'badges',
      'sticky-kits',
      'devices',
      'storyboard',
      'deliverables',
    ])
    expect(by('arrows')).toEqual([
      'arrow-straight',
      'arrow-dashed',
      'arrow-curved',
      'arrow-double',
      'arrow-uturn',
      'arrow-pointer',
      'block-right',
      'block-left',
      'block-up',
      'block-down',
      'block-double',
      'chevron',
      'step-pentagon',
    ])
    expect(by('callouts')).toEqual([
      'speech',
      'speech-right',
      'thought',
      'burst',
      'callout-line',
      'callout-fold',
    ])
    expect(by('sticky-kits')).toEqual([
      'kit-retro',
      'kit-start-stop',
      'kit-matrix-2x2',
      'kit-swot',
      'kit-note-colours',
    ])
    expect(by('devices')).toEqual([
      'device-phone',
      'device-tablet',
      'device-laptop',
      'device-browser',
      'device-tv',
    ])
    expect(by('storyboard')).toEqual(['sb-16x9', 'sb-9x16', 'sb-sheet'])
    expect(by('deliverables')).toHaveLength(12)
    // 22 pieces before wave Q, 62 added
    expect(PIECES).toHaveLength(84)
  })

  it('find every piece by a word a person would type', () => {
    const finds: Record<string, PieceId> = {
      swot: 'kit-swot',
      retro: 'kit-retro',
      steam: 'steam-set',
      'title safe': 'deliver-fhd',
      reel: 'deliver-story',
      youtube: 'deliver-yt-banner',
      thought: 'thought',
      stamp: 'approved',
      'needs review': 'needs-review',
      ipad: 'device-tablet',
      animatic: 'sb-sheet',
      turn: 'arrow-uturn',
    }
    for (const [query, id] of Object.entries(finds))
      expect(
        searchPieces(query).map((p) => p.id),
        query,
      ).toContain(id)
    // a number badge by its number
    expect(searchPieces('number 7')[0]?.id).toBe('number-7')
  })
})

describe('arrows', () => {
  it('are free arrows: bound to nothing, with the heads the name says', () => {
    const free = ['arrow-straight', 'arrow-dashed', 'arrow-curved', 'arrow-double', 'arrow-uturn'] as const
    for (const id of free) {
      const [a, ...rest] = make(id).elements
      expect(rest, id).toEqual([])
      expect(a, id).toMatchObject({ type: 'arrow', startBinding: null, endBinding: null, elbowed: false })
    }
    expect(make('arrow-straight').elements[0]).toMatchObject({ startArrowhead: null, endArrowhead: 'arrow' })
    expect(make('arrow-double').elements[0]).toMatchObject({ startArrowhead: 'arrow', endArrowhead: 'arrow' })
    expect(make('arrow-dashed').elements[0]).toMatchObject({ strokeStyle: 'dashed' })
    expect(make('arrow-pointer').elements[0]).toMatchObject({ startArrowhead: 'circle' })
  })

  it('curves are round arrows with three points or more', () => {
    for (const id of ['arrow-curved', 'arrow-uturn'] as const) {
      const a = make(id).elements[0] as { roundness: unknown; points: unknown[] }
      expect(a.roundness, id).toEqual({ type: 2 })
      expect(a.points.length, id).toBeGreaterThanOrEqual(3)
    }
    expect((make('arrow-straight').elements[0] as { roundness: unknown }).roundness).toBeNull()
  })

  it('block arrows are closed polygons with their word in a box over them, pointing the way they say', () => {
    /** the outline's points in the piece's space, with its box */
    const outline = (id: PieceId) => {
      const line = make(id).elements.find((e) => e.type === 'line')
      if (line?.type !== 'line') throw new Error(`${id} has no outline`)
      expect(line.polygon, id).toBe(true)
      expect(line.points.at(-1), id).toEqual(line.points[0])
      const pts = line.points.map(([x, y]) => [line.x + x, line.y + y] as const)
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const [minX, maxX] = [Math.min(...xs), Math.max(...xs)]
      const [minY, maxY] = [Math.min(...ys), Math.max(...ys)]
      return { pts, minX, maxX, minY, maxY }
    }
    const near = (a: number, b: number) => Math.abs(a - b) < 0.02
    // the tip of each is a point on the far edge, in the middle of the cross size
    const r = outline('block-right')
    expect(r.pts.some(([x, y]) => near(x, r.maxX) && near(y, (r.minY + r.maxY) / 2))).toBe(true)
    const l = outline('block-left')
    expect(l.pts.some(([x, y]) => near(x, l.minX) && near(y, (l.minY + l.maxY) / 2))).toBe(true)
    const d = outline('block-down')
    expect(d.pts.some(([x, y]) => near(y, d.maxY) && near(x, (d.minX + d.maxX) / 2))).toBe(true)
    const u = outline('block-up')
    expect(u.pts.some(([x, y]) => near(y, u.minY) && near(x, (u.minX + u.maxX) / 2))).toBe(true)
    const both = outline('block-double')
    expect(both.pts.some(([x, y]) => near(x, both.minX) && near(y, (both.minY + both.maxY) / 2))).toBe(true)
    expect(both.pts.some(([x, y]) => near(x, both.maxX) && near(y, (both.minY + both.maxY) / 2))).toBe(true)
  })
})

describe('badges', () => {
  it('has a number badge for 1 to 10, each saying its number, and a row of all ten', () => {
    for (let n = 1; n <= 10; n++) {
      const text = make(`number-${n}` as PieceId).elements.find((e) => e.type === 'text')
      expect(text, String(n)).toMatchObject({ originalText: String(n) })
    }
    const row = make('numbers-row').elements.filter((e) => e.type === 'text')
    expect(row.map((e) => (e as { originalText: string }).originalText)).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    )
  })

  it('has the six status stamps, each saying its word', () => {
    const word = (id: PieceId) =>
      (make(id).elements.find((e) => e.type === 'text') as { originalText: string }).originalText
    expect(word('approved')).toBe('APPROVED')
    expect(word('draft')).toBe('DRAFT')
    expect(word('needs-review')).toBe('NEEDS REVIEW')
    expect(word('priority')).toBe('PRIORITY')
    expect(word('done')).toBe('DONE')
    expect(word('wip')).toBe('WIP')
  })

  it('keeps every stamp on one line (a label that wraps would grow the pill)', () => {
    for (const id of by('badges')) {
      const text = make(id).elements.find((e) => e.type === 'text') as { text: string }
      expect(text.text.includes('\n'), id).toBe(false)
    }
  })
})

describe('sticky-note kits', () => {
  const notes = (id: PieceId) => make(id).elements.filter((e) => e.type === 'stickynote')

  it('hold real sticky notes', () => {
    expect(notes('kit-retro')).toHaveLength(6)
    expect(notes('kit-start-stop')).toHaveLength(6)
    expect(notes('kit-matrix-2x2')).toHaveLength(4)
    expect(notes('kit-swot')).toHaveLength(8)
    expect(notes('kit-note-colours')).toHaveLength(6)
    // a template's prompt marker is for a template's own instructions: these are notes to type over
    for (const id of by('sticky-kits'))
      for (const n of notes(id)) expect(lobbyOf(n).prompt, id).toBeUndefined()
  })

  it('name the columns and the quadrants', () => {
    const words = (id: PieceId) =>
      make(id)
        .elements.filter((e) => e.type === 'text')
        .map((e) => (e as { originalText: string }).originalText)
    expect(words('kit-retro')).toEqual(expect.arrayContaining(['Went well', 'To improve', 'Actions']))
    expect(words('kit-start-stop')).toEqual(expect.arrayContaining(['Start', 'Stop', 'Continue']))
    expect(words('kit-swot')).toEqual(
      expect.arrayContaining(['Strengths', 'Weaknesses', 'Opportunities', 'Threats']),
    )
    expect(words('kit-matrix-2x2')).toEqual(
      expect.arrayContaining(['Quick wins', 'Big bets', 'Fill-ins', 'Time sinks']),
    )
  })
})

describe('devices and storyboard panels', () => {
  const slots = (id: PieceId) => make(id).elements.filter((e) => lobbyOf(e).slot === 'image')

  it('give each device one screen to drop a picture on, never a picture', () => {
    for (const id of by('devices')) {
      expect(slots(id), id).toHaveLength(1)
      expect(make(id).elements.some((e) => e.type === 'image')).toBe(false)
    }
  })

  it('keeps the panels’ pictures to their aspect ratio', () => {
    const wide = slots('sb-16x9')[0]
    expect((wide?.width ?? 0) / (wide?.height ?? 1)).toBeCloseTo(16 / 9, 1)
    const tall = slots('sb-9x16')[0]
    expect((tall?.width ?? 0) / (tall?.height ?? 1)).toBeCloseTo(9 / 16, 1)
  })

  it('puts six 16:9 panels with their notes on a sheet that is a frame', () => {
    const sheet = make('sb-sheet')
    expect(sheet.frame).toBe(true)
    expect(sheet.elements.filter((e) => e.type === 'frame')).toHaveLength(1)
    const six = sheet.elements.filter((e) => lobbyOf(e).slot === 'image')
    expect(six).toHaveLength(6)
    for (const s of six) {
      expect(s.width / s.height).toBeCloseTo(16 / 9, 1)
      expect(s.frameId).toBe(sheet.elements.find((e) => e.type === 'frame')?.id)
    }
  })
})

describe('deliverable frames', () => {
  /** id → the pixel size of its frame (the format's own) */
  const SIZES: Record<string, [number, number]> = {
    'deliver-fhd': [1920, 1080],
    'deliver-4k': [3840, 2160],
    'deliver-square': [1080, 1080],
    'deliver-portrait': [1080, 1350],
    'deliver-story': [1080, 1920],
    'deliver-link': [1200, 628],
    'deliver-yt-banner': [2560, 1440],
    'steam-main': [1232, 706],
    'steam-header': [920, 430],
    'steam-small': [462, 174],
    'steam-vertical': [748, 896],
  }

  it('is a frame of the exact pixel size, named with it', () => {
    for (const [id, [w, h]] of Object.entries(SIZES)) {
      const piece = make(id as PieceId)
      const frames = piece.elements.filter((e) => e.type === 'frame')
      expect(frames, id).toHaveLength(1)
      const frame = frames[0]
      expect([frame?.width, frame?.height], id).toEqual([w, h])
      expect((frame as { name: string }).name, id).toContain(`${w} x ${h}`)
      expect(frame?.locked, id).toBe(false)
      expect(piece.frame, id).toBe(true)
      const info = PIECES.find((p) => p.id === id)
      expect([info?.w, info?.h], id).toEqual([w, h])
    }
  })

  it('draws its guides inside the frame: locked, dashed, each with a label', () => {
    for (const id of Object.keys(SIZES)) {
      const piece = make(id as PieceId)
      const frame = piece.elements.find((e) => e.type === 'frame')
      const guides = piece.elements.filter((e) => e.type === 'rectangle')
      const labels = piece.elements.filter((e) => e.type === 'text')
      expect(guides.length, id).toBeGreaterThan(0)
      expect(labels, id).toHaveLength(guides.length)
      for (const g of guides) {
        expect(g.frameId, id).toBe(frame?.id)
        expect(g.locked, id).toBe(true)
        expect(g.strokeStyle, id).toBe('dashed')
        // inside the frame
        expect(g.x, id).toBeGreaterThanOrEqual(0)
        expect(g.y, id).toBeGreaterThanOrEqual(0)
        expect(g.x + g.width, id).toBeLessThanOrEqual(frame?.width ?? 0)
        expect(g.y + g.height, id).toBeLessThanOrEqual(frame?.height ?? 0)
      }
      for (const t of labels) {
        expect(t.frameId, id).toBe(frame?.id)
        expect(t.locked, id).toBe(true)
        expect((t as { originalText: string }).originalText.length, id).toBeGreaterThan(3)
      }
    }
  })

  it('marks the broadcast areas at 93% and 90%, centred', () => {
    for (const [id, [w, h]] of [
      ['deliver-fhd', [1920, 1080]],
      ['deliver-4k', [3840, 2160]],
    ] as const) {
      const [action, title] = make(id).elements.filter((e) => e.type === 'rectangle')
      expect(action?.width).toBe(Math.round(w * 0.93))
      expect(action?.height).toBe(Math.round(h * 0.93))
      expect(title?.width).toBe(Math.round(w * 0.9))
      expect(title?.height).toBe(Math.round(h * 0.9))
      for (const g of [action, title]) {
        // centred, to a unit (the sizes are rounded to whole pixels)
        expect(Math.abs((g?.x ?? 0) * 2 + (g?.width ?? 0) - w), id).toBeLessThanOrEqual(1)
        expect(Math.abs((g?.y ?? 0) * 2 + (g?.height ?? 0) - h), id).toBeLessThanOrEqual(1)
      }
    }
  })

  it('marks the UI areas of a story and a reel', () => {
    const rects = make('deliver-story').elements.filter((e) => e.type === 'rectangle')
    // top 250 and bottom 340 keep-clear bands across the full width, then the two safe areas
    expect(rects[0]).toMatchObject({ x: 0, y: 0, width: 1080, height: 250 })
    expect(rects[1]).toMatchObject({ x: 0, y: 1920 - 340, width: 1080, height: 340 })
    expect(rects[2]).toMatchObject({ x: 60, y: 250, width: 960, height: 1920 - 250 - 340 })
    expect(rects[3]).toMatchObject({ x: 60, y: 250, width: 960, height: 1920 - 250 - 670 })
  })

  it('marks the YouTube banner’s safe area (1546 x 423) centred, with the tablet and desktop bands', () => {
    const [desktop, tablet, safe] = make('deliver-yt-banner').elements.filter((e) => e.type === 'rectangle')
    expect([desktop?.width, desktop?.height]).toEqual([2560, 423])
    expect([tablet?.width, tablet?.height]).toEqual([1855, 423])
    expect([safe?.width, safe?.height]).toEqual([1546, 423])
    expect(safe?.x).toBe(507)
    expect(safe?.y).toBe(508)
    expect(tablet?.x).toBeCloseTo(352.5, 1)
  })

  it('lays the Steam capsule set out as its four frames, apart', () => {
    const frames = make('steam-set').elements.filter((e) => e.type === 'frame')
    expect(frames.map((f) => [f.width, f.height])).toEqual([
      [1232, 706],
      [920, 430],
      [462, 174],
      [748, 896],
    ])
    for (const [i, a] of frames.entries())
      for (const b of frames.slice(i + 1)) {
        const apart =
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
        expect(apart, `${(a as { name: string }).name} and ${(b as { name: string }).name}`).toBe(true)
      }
  })
})
