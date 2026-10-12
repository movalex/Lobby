// The vector page's reading of an exported SVG (wave N, N6-3/N6-4): the tree flattened into the list of things it
// draws, in paint order, each with everything it inherits resolved (its transform to the root, its style, its
// opacity and the clip paths and masks above it), and the probe: every feature the PDF drawing does not reproduce
// faithfully is named in `problems`, and a page with any problem is drawn as an image instead (today's raster
// page), never as a vector page that looks different. Pure (no DOM), so it runs in a worker and in Node.
//
// What the canvas's SVG holds (Excalidraw 0.18's exportToSvg and Lobby's passes over it): groups with
// `translate(…) rotate(…)` transforms; roughjs paths (dashes as stroke-dasharray); text as one <text> per line with
// `white-space: pre`; images as a <symbol> with one data: <image> used by <use>, under a crop <mask> and a
// rounded-corner <clipPath>; frame clips (<clipPath> of a <rect>); an arrow's label hole (a <mask> of a white rect
// minus a black one); the vote badges (a <text> with <tspan>s); and Lobby's soft note shadow (one <filter>,
// export-svg-notes.ts), which the PDF draws as a light offset copy of the note. Opacity is folded into each paint,
// which is exact for Excalidraw's shapes (fill-opacity and stroke-opacity) but not for an `opacity` over more than
// one paint (a semi-transparent sticky note's group): such a page is an image page (`paintCount`).

import { idMap, parseXml, refId, type XElement } from './svg-tree.ts'

/** SVG's affine matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f (y down). */
export type Matrix = readonly [number, number, number, number, number, number]
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** m × n: n applies first. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  const [a, b, c, d, e, f] = m
  const [a2, b2, c2, d2, e2, f2] = n
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ]
}

export const applyMatrix = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
]

export const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]
export const scaling = (x: number, y = x): Matrix => [x, 0, 0, y, 0, 0]

function rotation(deg: number, cx = 0, cy = 0): Matrix {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const rot: Matrix = [cos, sin, -sin, cos, 0, 0]
  return cx || cy ? multiply(multiply(translation(cx, cy), rot), translation(-cx, -cy)) : rot
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/** A plain number (no unit, or px), or null. */
export function num(v: string | undefined): number | null {
  if (v === undefined) return null
  const s = v.trim().replace(/px$/, '')
  if (!NUMBER.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Parses a transform list (`translate(10 20) rotate(45 5 5) scale(-1 1) matrix(…)`); null when it cannot. */
export function parseTransform(list: string | undefined): Matrix | null {
  if (!list?.trim()) return IDENTITY
  let m = IDENTITY
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy
  let at = 0
  for (;;) {
    re.lastIndex = at
    const hit = re.exec(list)
    if (!hit) break
    at = re.lastIndex
    const args = (hit[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (args.some((a) => !Number.isFinite(a))) return null
    const [p = 0, q, r, s, t, u] = args
    let step: Matrix
    switch (hit[1]) {
      case 'matrix':
        if (args.length !== 6) return null
        step = [p, q as number, r as number, s as number, t as number, u as number]
        break
      case 'translate':
        if (args.length < 1 || args.length > 2) return null
        step = translation(p, q ?? 0)
        break
      case 'scale':
        if (args.length < 1 || args.length > 2) return null
        step = scaling(p, q ?? p)
        break
      case 'rotate':
        if (args.length !== 1 && args.length !== 3) return null
        step = rotation(p, q ?? 0, r ?? 0)
        break
      case 'skewX':
        if (args.length !== 1) return null
        step = [1, 0, Math.tan((p * Math.PI) / 180), 1, 0, 0]
        break
      default:
        if (args.length !== 1) return null
        step = [1, Math.tan((p * Math.PI) / 180), 0, 1, 0, 0]
    }
    m = multiply(m, step)
  }
  return list.slice(at).trim() ? null : m
}

/** Presentation properties a child inherits (SVG 1.1), the ones the PDF drawing reads. */
const INHERITED = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'visibility',
  'white-space',
  'direction',
  'letter-spacing',
  'word-spacing',
] as const

/** Properties of the element itself (never inherited) the reading checks. */
const OWN = [
  'opacity',
  'display',
  'dominant-baseline',
  'mix-blend-mode',
  'filter',
  'clip-path',
  'mask',
] as const

export type Style = Readonly<Record<string, string>>

/** An element's own properties: its attributes, then its `style=""` declarations (which win). */
export function ownStyle(el: XElement): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of [...INHERITED, ...OWN]) {
    const v = el.attrs[k]
    if (v !== undefined) out[k] = v.trim()
  }
  const style = el.attrs.style
  if (style)
    for (const decl of style.split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      const key = decl.slice(0, i).trim().toLowerCase()
      const value = decl
        .slice(i + 1)
        .replace(/!important/i, '')
        .trim()
      if (key && value) out[key] = value
    }
  return out
}

/** The id of Lobby's soft note shadow (canvas/api/parts/export-svg-notes.ts NOTE_SHADOW_FILTER_ID; a test pins it). */
export const NOTE_SHADOW_FILTER = 'lobby-note-shadow'

export interface ClipRef {
  readonly kind: 'clip-path' | 'mask'
  /** the <clipPath> or <mask> */
  readonly el: XElement
  /** root user space ← the user space of the element that refers to it */
  readonly ctm: Matrix
}

/** One thing the page draws. */
export interface Leaf {
  readonly el: XElement
  /** root user space ← the element's own user space (its transform included; a <use>'s x/y too) */
  readonly ctm: Matrix
  /** the inherited and own properties, resolved */
  readonly style: Style
  /** the product of `opacity` from the root down, the element's own included */
  readonly opacity: number
  /** the clip paths and masks above it (and its own), outermost first */
  readonly clips: readonly ClipRef[]
  /** Lobby's soft note shadow was on it: the PDF draws a light offset copy under it */
  readonly noteShadow: boolean
}

export interface SvgScene {
  readonly viewBox: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly ids: ReadonlyMap<string, XElement>
  readonly leaves: readonly Leaf[]
  /** why the page cannot be a faithful vector page ([] when it can) */
  readonly problems: readonly string[]
  /** the <metadata> elements' text by id (the face table: canvas/export/fonts.ts FACES_METADATA_ID) */
  readonly metadata: ReadonlyMap<string, string>
}

const DRAWN = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'use',
  'image',
])
const CONTAINERS = new Set(['g', 'a'])
/** Never drawn where they stand: referenced (or ignored) only. */
const RESOURCES = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'filter',
  'metadata',
  'style',
  'title',
  'desc',
])

/** Path data the PDF's path parser reads exactly: commands with the right number of finite arguments. */
const PATH_ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
export function pathDataOk(d: string): boolean {
  const s = d.trim()
  if (!s) return true
  if (!/^[Mm]/.test(s)) return false
  if (/[^MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]/.test(s)) return false
  const tokens = s.match(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []
  // everything must be a token (no stray "e", "..", "-" left over)
  const rebuilt = s.replace(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[\s,]+/g, '')
  if (rebuilt) return false
  let need = 0
  let count = 0
  let cmd = ''
  for (const t of tokens) {
    if (/[A-Za-z]/.test(t)) {
      if (cmd && need > 0 && (count === 0 || count % need !== 0)) return false
      cmd = t.toUpperCase()
      need = PATH_ARGS[cmd] ?? -1
      if (need < 0) return false
      count = 0
      continue
    }
    if (!Number.isFinite(Number(t))) return false
    if (need === 0) return false
    count++
  }
  return !(cmd && need > 0 && (count === 0 || count % need !== 0))
}

const isWhite = (v: string | undefined) =>
  !!v && /^(#fff|#ffffff|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/i.test(v)
const isBlack = (v: string | undefined) =>
  !!v && /^(#000|#000000|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(v)

/** Why a <mask> is not one the page reproduces as a clip (white rects, optionally minus black rects), or null. */
export function maskProblem(mask: XElement): string | null {
  const units = mask.attrs.maskContentUnits
  if (units && units !== 'userSpaceOnUse') return 'a mask in bounding-box units'
  let white = 0
  for (const c of mask.children) {
    if (typeof c === 'string') {
      if (c.trim()) return 'text in a mask'
      continue
    }
    if (c.name === 'title' || c.name === 'desc') continue
    if (c.name !== 'rect') return `a mask of <${c.name}>`
    const st = ownStyle(c)
    const fill = st.fill ?? ownStyle(mask).fill ?? 'black'
    const op = num(st.opacity ?? '1') ?? 1
    const fo = num(st['fill-opacity'] ?? '1') ?? 1
    if (op !== 1 || fo !== 1) return 'a partly transparent mask'
    if (st.stroke && st.stroke !== 'none') return 'a stroked mask'
    if (isWhite(fill)) white++
    else if (!isBlack(fill)) return 'a mask in shades of grey'
    for (const k of ['x', 'y', 'width', 'height'] as const)
      if (c.attrs[k] !== undefined && num(c.attrs[k]) === null) return 'a mask with relative sizes'
    if (parseTransform(c.attrs.transform) === null) return 'a mask with a transform it cannot read'
  }
  return white === 1 ? null : 'a mask that is not one white area'
}

/** Why a <clipPath> is not one the page reproduces (rects, paths, circles and ellipses), or null. */
export function clipPathProblem(clip: XElement): string | null {
  const units = clip.attrs.clipPathUnits
  if (units && units !== 'userSpaceOnUse') return 'a clip path in bounding-box units'
  if (clip.attrs['clip-path']) return 'a clipped clip path'
  let shapes = 0
  for (const c of clip.children) {
    if (typeof c === 'string') continue
    if (c.name === 'title' || c.name === 'desc') continue
    if (!['rect', 'path', 'circle', 'ellipse'].includes(c.name)) return `a clip path of <${c.name}>`
    if (parseTransform(c.attrs.transform) === null) return 'a clip path with a transform it cannot read'
    if (c.name === 'path' && !pathDataOk(c.attrs.d ?? '')) return 'a clip path it cannot read'
    for (const k of ['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r'] as const)
      if (c.attrs[k] !== undefined && num(c.attrs[k]) === null) return 'a clip path with relative sizes'
    shapes++
  }
  return shapes > 0 ? null : 'an empty clip path'
}

/** The <image> of a symbol a <use> shows (Excalidraw's image symbols), or null. */
export function symbolImage(symbol: XElement): XElement | null {
  if (symbol.name !== 'symbol') return null
  let image: XElement | null = null
  for (const c of symbol.children) {
    if (typeof c === 'string') {
      if (c.trim()) return null
      continue
    }
    if (c.name === 'title' || c.name === 'desc') continue
    if (c.name !== 'image' || image) return null
    image = c
  }
  return image
}

const IMAGE_HREF = /^data:image\/(png|jpeg|jpg|webp|gif|avif|bmp);base64,/i
export const hrefOf = (el: XElement) => el.attrs.href ?? el.attrs['xlink:href'] ?? ''

/** Why the text of a <text> cannot be laid out exactly (positions per glyph, a path, right-to-left…), or null. */
export function textProblem(text: XElement, style: Style): string | null {
  if (style.direction === 'rtl') return 'right-to-left text'
  for (const k of ['rotate', 'textLength', 'lengthAdjust', 'dx', 'dy'] as const)
    if (text.attrs[k] !== undefined) return `text with ${k}`
  for (const k of ['x', 'y'] as const)
    if (text.attrs[k] !== undefined && num(text.attrs[k]) === null) return 'text placed glyph by glyph'
  for (const k of ['letter-spacing', 'word-spacing'] as const) {
    const v = style[k]
    if (v && v !== 'normal' && num(v) !== 0) return `text with ${k}`
  }
  for (const c of text.children) {
    if (typeof c === 'string') continue
    if (c.name === 'title' || c.name === 'desc') continue
    if (c.name !== 'tspan') return `text with <${c.name}>`
    for (const k of ['x', 'y', 'dy', 'rotate', 'textLength'] as const)
      if (c.attrs[k] !== undefined) return `a text span with ${k}`
    if (c.attrs.dx !== undefined && num(c.attrs.dx) === null) return 'a text span placed glyph by glyph'
    if (c.children.some((g) => typeof g !== 'string')) return 'nested text spans'
    const st = ownStyle(c)
    if (st.direction === 'rtl') return 'right-to-left text'
    for (const k of ['filter', 'mask', 'clip-path', 'mix-blend-mode'] as const)
      if (st[k]) return `a text span with ${k}`
  }
  return null
}

const painted = (v: string | undefined, initial: boolean) => (v === undefined ? initial : v !== 'none')

/**
 * How many times a leaf paints (its fill and its stroke are two; an image, one; Lobby's soft note shadow adds its
 * light copy). The page folds an element's `opacity` into each paint, where a browser composites the element (and
 * a group with everything in it) once: equal only when one paint is all there is under it.
 */
export function paintCount(leaf: Pick<Leaf, 'el' | 'style' | 'noteShadow'>): number {
  const { el, style } = leaf
  let n: number
  if (el.name === 'use' || el.name === 'image') n = 1
  else n = (el.name !== 'line' && painted(style.fill, true) ? 1 : 0) + (painted(style.stroke, false) ? 1 : 0)
  return n + (leaf.noteShadow ? 1 : 0)
}

/** Reads an exported SVG into the page's draw list and its problems. Throws SvgReadError when it is not XML. */
export function readScene(svgText: string): SvgScene {
  const root = parseXml(svgText)
  const problems: string[] = []
  const note = (p: string) => {
    if (!problems.includes(p)) problems.push(p)
  }
  if (root.name !== 'svg') note('the document is not an SVG')
  const vb = (root.attrs.viewBox ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const width = num(root.attrs.width)
  const height = num(root.attrs.height)
  const viewBox =
    vb.length === 4 && vb.every(Number.isFinite) && (vb[2] as number) > 0 && (vb[3] as number) > 0
      ? { x: vb[0] as number, y: vb[1] as number, width: vb[2] as number, height: vb[3] as number }
      : width && height
        ? { x: 0, y: 0, width, height }
        : null
  if (!viewBox) note('an SVG without a size')
  if (root.attrs.preserveAspectRatio && root.attrs.preserveAspectRatio !== 'xMidYMid meet')
    note('an SVG with its own aspect rule')
  const ids = idMap(root)
  const metadata = new Map<string, string>()
  const leaves: Leaf[] = []

  const checkStyleSheet = (el: XElement) => {
    // only @font-face rules (the 'embedded' fonts) are allowed: a class rule would style elements unseen
    const css = el.children
      .map((c) => (typeof c === 'string' ? c : ''))
      .join('')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@font-face\s*\{[^}]*\}/g, '')
    if (css.trim()) note('a style sheet')
  }

  const walkResources = (el: XElement) => {
    if (el.name === 'style') checkStyleSheet(el)
    else if (el.name === 'metadata') {
      const id = el.attrs.id
      if (id) metadata.set(id, el.children.map((c) => (typeof c === 'string' ? c : '')).join(''))
    }
    for (const c of el.children) if (typeof c !== 'string') walkResources(c)
  }

  const visit = (
    el: XElement,
    parentCtm: Matrix,
    inherited: Style,
    opacity: number,
    clips: readonly ClipRef[],
  ) => {
    if (RESOURCES.has(el.name)) {
      walkResources(el)
      return
    }
    if (el.name === 'svg') {
      note('a nested SVG')
      return
    }
    if (!CONTAINERS.has(el.name) && !DRAWN.has(el.name)) {
      note(`<${el.name}>`)
      return
    }
    const own = ownStyle(el)
    if (own.display === 'none') return
    const style: Record<string, string> = { ...inherited }
    for (const k of INHERITED) if (own[k] !== undefined && own[k] !== 'inherit') style[k] = own[k] as string
    for (const k of OWN) if (own[k] !== undefined) style[k] = own[k] as string
    const t = parseTransform(el.attrs.transform)
    if (!t) {
      note('a transform it cannot read')
      return
    }
    let ctm = multiply(parentCtm, t)
    const ownOpacity = Math.min(1, Math.max(0, num(own.opacity ?? '1') ?? 1))
    const op = opacity * ownOpacity
    // group opacity (Excalidraw's on a semi-transparent sticky note) over more than one paint: a browser composites
    // the group once (a note hides its own shadow), the page each paint (the shadow would show through)
    const first = leaves.length
    const groupOpacityCheck = () => {
      if (ownOpacity >= 1) return
      let paints = 0
      for (let i = first; i < leaves.length; i++) paints += paintCount(leaves[i] as Leaf)
      if (paints > 1) note('a partly transparent group')
    }
    if (own['mix-blend-mode'] && own['mix-blend-mode'] !== 'normal') note('a blend mode')
    let noteShadow = false
    if (own.filter && own.filter !== 'none') {
      if (refId(own.filter) === NOTE_SHADOW_FILTER && el.name === 'path') noteShadow = true
      else note('a filter')
    }
    const here: ClipRef[] = [...clips]
    for (const kind of ['clip-path', 'mask'] as const) {
      const v = own[kind]
      if (!v || v === 'none') continue
      const target = ids.get(refId(v) ?? '')
      if (!target || target.name !== (kind === 'mask' ? 'mask' : 'clipPath')) {
        note(`a ${kind} it cannot find`)
        continue
      }
      const why = kind === 'mask' ? maskProblem(target) : clipPathProblem(target)
      if (why) note(why)
      else here.push({ kind, el: target, ctm })
    }
    for (const k of ['fill', 'stroke'] as const)
      if (/^url\(/i.test(own[k] ?? '')) note('a gradient or pattern')
    if (CONTAINERS.has(el.name)) {
      for (const c of el.children) if (typeof c !== 'string') visit(c, ctm, style, op, here)
      groupOpacityCheck()
      return
    }
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return
    switch (el.name) {
      case 'path':
        if (!pathDataOk(el.attrs.d ?? '')) note('a path it cannot read')
        break
      case 'text': {
        const why = textProblem(el, style)
        if (why) note(why)
        break
      }
      case 'use': {
        const target = ids.get(refId(hrefOf(el)) ?? '')
        const image = target ? symbolImage(target) : null
        if (!image) {
          note('a reused element that is not an image')
          return
        }
        if (!IMAGE_HREF.test(hrefOf(image))) note('an image that is not embedded')
        const x = num(el.attrs.x ?? '0')
        const y = num(el.attrs.y ?? '0')
        if (x === null || y === null) note('an image placed in relative units')
        else ctm = multiply(ctm, translation(x, y))
        break
      }
      case 'image':
        if (!IMAGE_HREF.test(hrefOf(el))) note('an image that is not embedded')
        break
      default:
        for (const k of [
          'x',
          'y',
          'width',
          'height',
          'cx',
          'cy',
          'r',
          'rx',
          'ry',
          'x1',
          'y1',
          'x2',
          'y2',
        ] as const) {
          const v = el.attrs[k]
          if (v !== undefined && num(v) === null) note(`a <${el.name}> in relative units`)
        }
        if (
          (el.name === 'polyline' || el.name === 'polygon') &&
          !/^[\d\s,.eE+-]*$/.test(el.attrs.points ?? '')
        )
          note(`a <${el.name}> it cannot read`)
    }
    leaves.push({ el, ctm, style, opacity: op, clips: here, noteShadow })
    groupOpacityCheck()
  }

  for (const c of root.children) if (typeof c !== 'string') visit(c, IDENTITY, {}, 1, [])
  return {
    viewBox: viewBox ?? { x: 0, y: 0, width: 1, height: 1 },
    ids,
    leaves,
    problems,
    metadata,
  }
}
