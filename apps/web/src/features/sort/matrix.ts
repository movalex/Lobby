// L8-2: the 2x2 that "Place with AI" puts notes on. Two kinds are known, read from the board:
//  - a template's: K4-2's "2x2 prioritisation" is four square frames (Quick wins, Big bets, Fill-ins, Park it)
//    next to a frame of ideas, and each square's instruction line says where it sits ("High impact, low
//    effort."): the axis names and which square is which come from those lines, so the same reading serves a
//    template that words its squares the same way;
//  - one this feature made: a frame called `sort-matrix` with six axis texts (`sort-axis-*`) and a cross, which
//    a second run of "Place with AI" reads back instead of asking for the axes again.
// Anything else has no matrix: the person is asked for the two axes and one is made (./ai.ts).
//
// The first axis a matrix names runs across (positive scores to the right, the "high" end), the second runs
// up (positive scores up). A square's rectangle is the room notes may land in: the frame less its margins and
// the heading and instruction line at its top.
import type { AiScoreAxis } from '@draftroom/contracts'
import { type CanvasElement, items, type LobbyCanvas } from '../../canvas/api/index.ts'
import { FRAME_MARGIN } from '../ai/layout.ts'
import { boxOf, isBoundLabel, isFrame, isLive, unionRects } from './geom.ts'
import { QUADRANT_KEYS, type QuadrantKey, type Rect } from './layout.ts'

/** The `customData.lobby.kind` of a matrix frame this feature makes, its cross and its axis words. */
export const MATRIX_FRAME_KIND = 'sort-matrix'
export const AXIS_KINDS = {
  xName: 'sort-axis-x',
  xLow: 'sort-axis-xl',
  xHigh: 'sort-axis-xh',
  yName: 'sort-axis-y',
  yLow: 'sort-axis-yl',
  yHigh: 'sort-axis-yh',
} as const
export type AxisRole = keyof typeof AXIS_KINDS

/** The room a made matrix frame keeps: left for the up axis' words, under for the across axis' words. */
export const MATRIX_LEFT_BAND = 120
export const MATRIX_TOP_MARGIN = 32
export const MATRIX_RIGHT_MARGIN = 32
export const MATRIX_BOTTOM_BAND = 72

export interface MatrixQuadrant {
  /** the frame the notes of this square belong to */
  readonly frameId: string
  /** the room notes may land in, scene units */
  readonly area: Rect
}

export interface MatrixTarget {
  readonly source: 'template' | 'made'
  /** [across, up] */
  readonly axes: readonly [AiScoreAxis, AiScoreAxis]
  readonly quadrants: Readonly<Record<QuadrantKey, MatrixQuadrant>>
}

const lobbyKind = (el: CanvasElement) => {
  const k = items.lobbyValue(el, 'kind')
  return typeof k === 'string' ? k : null
}

const wordsOf = (el: CanvasElement) => String((el as { originalText?: string }).originalText ?? '').trim()

const trimTo = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`)

/** "impact" → "Impact". */
const capital = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s)

/** The axis a matrix names, as the api takes it (the lengths its contract allows). */
export function axisOf(name: string, low = 'Low', high = 'High'): AiScoreAxis {
  return { name: trimTo(name.trim(), 24), low: trimTo(low.trim(), 16), high: trimTo(high.trim(), 16) }
}

// ---- a made matrix ------------------------------------------------------------------------------------------

/** The squares of a made matrix frame of size w by h (the formula ./ai.ts lays the frame out by). */
export function madeQuadrantAreas(frame: Rect): Record<QuadrantKey, Rect> {
  const qw = (frame.w - MATRIX_LEFT_BAND - MATRIX_RIGHT_MARGIN) / 2
  const qh = (frame.h - MATRIX_TOP_MARGIN - MATRIX_BOTTOM_BAND) / 2
  const x0 = frame.x + MATRIX_LEFT_BAND
  const y0 = frame.y + MATRIX_TOP_MARGIN
  return {
    'low-high': { x: x0, y: y0, w: qw, h: qh },
    'high-high': { x: x0 + qw, y: y0, w: qw, h: qh },
    'low-low': { x: x0, y: y0 + qh, w: qw, h: qh },
    'high-low': { x: x0 + qw, y: y0 + qh, w: qw, h: qh },
  }
}

/** The matrix a frame this feature made is, or null (not one, or an axis word was deleted). */
export function readMadeMatrix(canvas: LobbyCanvas, frame: CanvasElement): MatrixTarget | null {
  if (!isFrame(frame) || lobbyKind(frame) !== MATRIX_FRAME_KIND) return null
  const words: Partial<Record<AxisRole, string>> = {}
  for (const el of canvas.items()) {
    if (!isLive(el) || el.type !== 'text' || el.frameId !== frame.id) continue
    const kind = lobbyKind(el)
    const role = (Object.keys(AXIS_KINDS) as AxisRole[]).find((r) => AXIS_KINDS[r] === kind)
    if (role && wordsOf(el)) words[role] = wordsOf(el)
  }
  if (!words.xName || !words.yName) return null
  const axes = [
    axisOf(words.xName, words.xLow ?? 'Low', words.xHigh ?? 'High'),
    axisOf(words.yName, words.yLow ?? 'Low', words.yHigh ?? 'High'),
  ] as const
  const areas = madeQuadrantAreas({ x: frame.x, y: frame.y, w: frame.width, h: frame.height })
  const quadrants = Object.fromEntries(
    QUADRANT_KEYS.map((k) => [k, { frameId: frame.id, area: areas[k] }]),
  ) as Record<QuadrantKey, MatrixQuadrant>
  return { source: 'made', axes, quadrants }
}

// ---- a template's -----------------------------------------------------------------------------------------

/** "High impact, low effort. Do these first.": the two ends a square stands for. */
const INTRO = /^\s*(high|low)\s+([^,.]{1,24}?)\s*,\s*(high|low)\s+([^,.]{1,24}?)\s*\./i

interface Square {
  frame: CanvasElement
  /** the first axis the line names, and the end it says */
  a: { name: string; end: 'high' | 'low' }
  b: { name: string; end: 'high' | 'low' }
}

function squareOf(canvas: LobbyCanvas, frame: CanvasElement): Square | null {
  for (const el of canvas.items()) {
    if (!isLive(el) || el.type !== 'text' || isBoundLabel(el) || el.frameId !== frame.id) continue
    const m = INTRO.exec(wordsOf(el))
    if (!m) continue
    return {
      frame,
      a: {
        name: (m[2] as string).trim().toLowerCase(),
        end: (m[1] as string).toLowerCase() as 'high' | 'low',
      },
      b: {
        name: (m[4] as string).trim().toLowerCase(),
        end: (m[3] as string).toLowerCase() as 'high' | 'low',
      },
    }
  }
  return null
}

const centreOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** The room in a square: its frame less the margins and less its heading and instruction line. */
export function squareArea(canvas: LobbyCanvas, frame: CanvasElement): Rect {
  const f = boxOf(frame)
  const headerLimit = f.y + f.h * 0.35
  const headers = canvas
    .items()
    .filter(
      (e) =>
        isLive(e) && e.type === 'text' && !isBoundLabel(e) && e.frameId === frame.id && e.y < headerLimit,
    )
    .map((e) => e.y + e.height)
  const top = Math.max(f.y + FRAME_MARGIN, ...headers.map((b) => b + 24))
  return {
    x: f.x + FRAME_MARGIN,
    y: top,
    w: Math.max(0, f.w - 2 * FRAME_MARGIN),
    h: Math.max(0, f.y + f.h - FRAME_MARGIN - top),
  }
}

/**
 * The four squares of a template 2x2 nearest `near` (a point or a box in scene units), with the axes their
 * instruction lines name; null when there are not four squares that make the four combinations.
 */
export function readTemplateMatrix(canvas: LobbyCanvas, near: Rect): MatrixTarget | null {
  const squares: Square[] = []
  for (const el of canvas.items()) {
    if (!isLive(el) || !isFrame(el) || canvas.isHidden(el.id)) continue
    const sq = squareOf(canvas, el)
    if (sq) squares.push(sq)
  }
  if (squares.length < 4) return null
  const c = centreOf(near)
  const dist = (s: Square) => {
    const m = centreOf(boxOf(s.frame))
    return Math.hypot(m.x - c.x, m.y - c.y)
  }
  squares.sort((p, q) => dist(p) - dist(q))
  const head = squares[0] as Square
  const same = squares.filter((s) => s.a.name === head.a.name && s.b.name === head.b.name)
  const pick = new Map<string, Square>()
  for (const s of same) {
    const k = `${s.a.end}-${s.b.end}`
    if (!pick.has(k)) pick.set(k, s)
  }
  if (pick.size !== 4) return null
  const get = (a: 'high' | 'low', b: 'high' | 'low') => pick.get(`${a}-${b}`) as Square
  // which axis runs across: the one whose high squares sit to the side of its low squares rather than above
  const mid = (a: Square, b: Square) => {
    const p = centreOf(boxOf(a.frame))
    const q = centreOf(boxOf(b.frame))
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
  }
  const aHigh = mid(get('high', 'high'), get('high', 'low'))
  const aLow = mid(get('low', 'high'), get('low', 'low'))
  const aAcross = Math.abs(aHigh.x - aLow.x) > Math.abs(aHigh.y - aLow.y)
  const across = aAcross ? head.a.name : head.b.name
  const up = aAcross ? head.b.name : head.a.name
  const quadrants = {} as Record<QuadrantKey, MatrixQuadrant>
  for (const s of pick.values()) {
    const xEnd = aAcross ? s.a.end : s.b.end
    const yEnd = aAcross ? s.b.end : s.a.end
    quadrants[`${xEnd}-${yEnd}` as QuadrantKey] = { frameId: s.frame.id, area: squareArea(canvas, s.frame) }
  }
  return {
    source: 'template',
    axes: [axisOf(capital(across)), axisOf(capital(up))],
    quadrants,
  }
}

// ---- finding the matrix for some notes ----------------------------------------------------------------------------

/**
 * The matrix `notes` belong with: a made matrix when they sit in one, else the template 2x2 nearest them,
 * else null (the person names the axes and one is made).
 */
export function detectMatrix(canvas: LobbyCanvas, notes: readonly CanvasElement[]): MatrixTarget | null {
  const counts = new Map<string, number>()
  for (const n of notes) if (n.frameId) counts.set(n.frameId, (counts.get(n.frameId) ?? 0) + 1)
  const frames = [...counts.entries()].sort((a, b) => b[1] - a[1])
  for (const [id] of frames) {
    const f = canvas.get(id)
    const made = f && isLive(f) ? readMadeMatrix(canvas, f) : null
    if (made) return made
  }
  const box = unionRects(notes.map(boxOf))
  return box ? readTemplateMatrix(canvas, box) : null
}
