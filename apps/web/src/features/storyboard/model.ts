// OWNER: WS2 (wave T, storyboards). The storyboard's pure model, apart from React and the canvas so Node tests run it:
// a panel's geometry for each aspect (the header the shot chip sits in, the picture, the three field boxes), the grid
// a storyboard is laid out on (rows of `perRow`, each row as tall as its tallest panel), and the order maths of
// reorder, insert and duplicate (an order key between the neighbours, a rebalance past 48 characters). Shot numbers
// are canvas-schema's (`shotNumbers`: derived from `sb:pos`, never stored), so every tab agrees.
import {
  isOrderKey,
  panelPosBetween,
  rebalancedPositions,
  SB_DEFAULT_PER_ROW,
  SB_PER_ROW_MAX,
  SB_POS_KEY,
  SB_POS_MAX_CHARS,
  SB_POS_REBALANCE_CHARS,
  type StoryboardAspect,
} from '@draftroom/canvas-schema/planning'

/** The three field boxes of a panel, by their `customData.lobby.kind` (create-only, valid to every revision). */
export const FIELD_KINDS = ['sb-camera', 'sb-action', 'sb-dialogue'] as const
export type FieldKind = (typeof FIELD_KINDS)[number]
/** Two more kinds a panel may hold (a script's sound line; WS3's sheet reads them too). */
export const EXTRA_FIELD_KINDS = ['sb-sfx', 'sb-music'] as const
export const FIELD_CAPTIONS: Readonly<Record<FieldKind, string>> = {
  'sb-camera': 'CAMERA',
  'sb-action': 'ACTION',
  'sb-dialogue': 'DIALOGUE / VO',
}
/** The picture slot's kind (with `slot: 'image'`, the template slot marker an image dropped on it fills). */
export const PICTURE_KIND = 'sb-picture'
/** A field caption's kind. */
export const CAPTION_KIND = 'sb-caption'
/** The head's kind (its title text). */
export const HEAD_KIND = 'sb-title'

// ---- geometry (scene units) ----------------------------------------------------------------------------------

/** Inner padding of a panel. */
export const PANEL_PAD = 16
/** The band at the top of a panel the shot chip is drawn in (an overlay: nothing is stored there). */
export const PANEL_HEADER = 40
/** Between the picture and a field, and between fields. */
export const FIELD_GAP = 10
/** A caption's line, and the space under it. */
export const CAPTION_H = 16
export const CAPTION_GAP = 4
export const CAPTION_FONT = 12
/** A field's words. */
export const FIELD_FONT = 15
export const FIELD_LINE = FIELD_FONT * 1.25
/** Padding inside a field box. */
export const FIELD_PAD = 8
/** The least height of each field box: camera one line, action and dialogue two. */
export const FIELD_MIN_LINES: Readonly<Record<FieldKind, number>> = {
  'sb-camera': 1,
  'sb-action': 2,
  'sb-dialogue': 2,
}
/** Between panels in a row, and between rows. */
export const GAP_X = 48
export const GAP_Y = 56
/** The head (title) above the first row. */
export const HEAD_FONT = 36
export const HEAD_GAP = 28

export interface PictureSize {
  readonly w: number
  readonly h: number
}

/** The picture's size for an aspect (landscape ones 384 wide or more; portrait ones 384 tall at most). */
export function pictureSize(aspect: StoryboardAspect): PictureSize {
  switch (aspect) {
    case '16:9':
      return { w: 384, h: 216 }
    case '2.39:1':
      return { w: 430, h: 180 }
    case '1:1':
      return { w: 288, h: 288 }
    case '4:5':
      return { w: 256, h: 320 }
    case '9:16':
      return { w: 216, h: 384 }
  }
}

/** The width of a panel's content (the picture, or the fields' least width of 288 for a portrait picture). */
export const contentWidth = (aspect: StoryboardAspect): number => Math.max(288, pictureSize(aspect).w)
/** A panel frame's width. */
export const panelWidth = (aspect: StoryboardAspect): number => contentWidth(aspect) + 2 * PANEL_PAD

/** A field box's height for `lines` lines of words (at least its kind's least). */
export const fieldHeight = (kind: FieldKind, lines: number): number =>
  Math.ceil(Math.max(FIELD_MIN_LINES[kind], lines) * FIELD_LINE + 2 * FIELD_PAD)

export interface PanelBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface PanelGeometry {
  readonly width: number
  readonly height: number
  /** relative to the frame's top-left */
  readonly picture: PanelBox
  readonly fields: readonly { kind: FieldKind; caption: PanelBox; box: PanelBox }[]
}

/** Where everything of a panel goes, given each field's line count (relative to the frame's top-left). */
export function panelGeometry(
  aspect: StoryboardAspect,
  lines: Readonly<Partial<Record<FieldKind, number>>> = {},
): PanelGeometry {
  const pic = pictureSize(aspect)
  const cw = contentWidth(aspect)
  const picture = { x: PANEL_PAD + Math.round((cw - pic.w) / 2), y: PANEL_HEADER, w: pic.w, h: pic.h }
  let y = picture.y + picture.h
  const fields = FIELD_KINDS.map((kind) => {
    y += FIELD_GAP
    const caption = { x: PANEL_PAD, y, w: cw, h: CAPTION_H }
    y += CAPTION_H + CAPTION_GAP
    const h = fieldHeight(kind, lines[kind] ?? 0)
    const box = { x: PANEL_PAD, y, w: cw, h }
    y += h
    return { kind, caption, box }
  })
  return { width: panelWidth(aspect), height: y + PANEL_PAD, picture, fields }
}

// ---- the grid -------------------------------------------------------------------------------------------------

/** How many panels a row holds: the head's `perRow`, else 6; held to 1..12. */
export const perRowOf = (perRow: number | undefined): number =>
  Math.max(1, Math.min(SB_PER_ROW_MAX, Math.floor(perRow ?? SB_DEFAULT_PER_ROW)))

/** The layouts the Arrange menu offers: one row (up to 12), or a grid of 3, 4 or 6 per row. */
export const LAYOUTS: readonly { readonly id: string; readonly label: string; readonly perRow: number }[] = [
  { id: 'row', label: 'One row', perRow: SB_PER_ROW_MAX },
  { id: 'grid-3', label: 'Grid, 3 per row', perRow: 3 },
  { id: 'grid-4', label: 'Grid, 4 per row', perRow: 4 },
  { id: 'grid-6', label: 'Grid, 6 per row', perRow: 6 },
]

/**
 * The top-left of each panel (in order) on the grid from `origin`: rows of `perRow`, each column as wide as the
 * widest panel, each row as tall as its tallest.
 */
export function gridPositions(
  sizes: readonly { readonly w: number; readonly h: number }[],
  origin: { readonly x: number; readonly y: number },
  perRow: number,
): { x: number; y: number }[] {
  const n = perRowOf(perRow)
  const colW = Math.max(0, ...sizes.map((s) => s.w))
  const out: { x: number; y: number }[] = []
  let y = origin.y
  for (let start = 0; start < sizes.length; start += n) {
    const row = sizes.slice(start, start + n)
    row.forEach((_, i) => {
      out.push({ x: Math.round(origin.x + i * (colW + GAP_X)), y: Math.round(y) })
    })
    y += Math.max(0, ...row.map((s) => s.h)) + GAP_Y
  }
  return out
}

/** Whether two panel boxes overlap (the strip's "Panels overlap: Arrange" hint: concurrent layouts can collide). */
export function anyOverlap(boxes: readonly PanelBox[]): boolean {
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i] as PanelBox
      const b = boxes[j] as PanelBox
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true
    }
  return false
}

// ---- order ----------------------------------------------------------------------------------------------------

export interface OrderedPanel {
  readonly id: string
  /** its `sb:pos` */
  readonly pos: string
}

const posOf = (p: { customData?: unknown }): string => {
  const v = (p.customData as { lobby?: Record<string, unknown> } | null | undefined)?.lobby?.[SB_POS_KEY]
  return typeof v === 'string' ? v : ''
}

/** Panels as the order maths reads them (their ids and keys, in storyboard order). */
export const orderedOf = (panels: readonly { id: string; customData?: unknown }[]): OrderedPanel[] =>
  panels.map((p) => ({ id: p.id, pos: posOf(p) }))

/**
 * The `sb:pos` writes that put a new panel at `index` (0 = first, panels.length = last): one key between its
 * neighbours, or, when that key would pass 48 characters (or a neighbour's is not a valid key), fresh keys for every
 * panel with the new one at `index` (the actor's rebalance, in the same step). `newKey` is the new panel's key.
 */
export function insertKeys(
  panels: readonly OrderedPanel[],
  index: number,
): { newKey: string; rewrites: ReadonlyMap<string, string> } {
  const at = Math.max(0, Math.min(panels.length, index))
  const before = panels[at - 1]?.pos ?? null
  const after = panels[at]?.pos ?? null
  const valid = (k: string | null) => k === null || isOrderKey(k)
  // two panels with the same key (a copy): no key fits between them, so the whole storyboard is rebalanced
  const ordered = before === null || after === null || before < after
  if (valid(before) && valid(after) && ordered) {
    const key = panelPosBetween(before, after)
    if (key.length <= SB_POS_REBALANCE_CHARS) return { newKey: key, rewrites: new Map() }
  }
  const keys = rebalancedPositions(panels.length + 1)
  const rewrites = new Map<string, string>()
  let k = 0
  let newKey = ''
  for (let i = 0; i <= panels.length; i++) {
    const key = keys[k++] as string
    if (i === at) {
      newKey = key
      continue
    }
    const p = panels[i < at ? i : i - 1] as OrderedPanel
    if (p.pos !== key) rewrites.set(p.id, key)
  }
  return { newKey, rewrites }
}

/**
 * The `sb:pos` writes that move the panel at `from` to `to` (indices in the order as it is; `to` is where it ends
 * up): the moved panel's key only, or a rebalance of all (see insertKeys).
 */
export function moveKeys(
  panels: readonly OrderedPanel[],
  from: number,
  to: number,
): ReadonlyMap<string, string> {
  const moved = panels[from]
  if (!moved || from === to) return new Map()
  const rest = panels.filter((_, i) => i !== from)
  const { newKey, rewrites } = insertKeys(rest, Math.max(0, Math.min(rest.length, to)))
  const out = new Map(rewrites)
  out.set(moved.id, newKey)
  return out
}

// ---- locked panels -------------------------------------------------------------------------------------------
// A locked panel takes no write (no lock exemption: the room refuses its `sb:pos` and its move, LOCKED). So with one
// in a storyboard, a move, an insert and a duplicate keep every locked panel at its place in the order (and so in its
// grid slot) and key the others around it: a locked key never changes.

/**
 * The order after a reorder of the UNLOCKED panels: `order` is the storyboard as it is, `unlockedNext` the unlocked
 * panels (and a new one) in their new order. Each locked panel keeps its index; the others fill the rest in order.
 */
export function aroundLocked<T>(
  order: readonly T[],
  locked: (t: T) => boolean,
  unlockedNext: readonly T[],
): T[] {
  const fixed = new Map<number, T>()
  order.forEach((t, i) => {
    if (locked(t)) fixed.set(i, t)
  })
  const total = fixed.size + unlockedNext.length
  const out: T[] = []
  let u = 0
  for (let i = 0; i < total; i++) {
    const f = fixed.get(i)
    if (f !== undefined) out.push(f)
    else if (u < unlockedNext.length) out.push(unlockedNext[u++] as T)
  }
  // a locked panel past the end (fewer panels than its index) stays last, in order
  for (const [i, f] of [...fixed].sort((a, b) => a[0] - b[0])) if (i >= total) out.push(f)
  return out
}

/** `n` order keys strictly between `lo` and `hi` (null for an open end), ascending, by bisection (short keys). */
export function keysBetween(lo: string | null, hi: string | null, n: number): string[] {
  if (n <= 0) return []
  const mid = Math.floor((n - 1) / 2)
  const k = panelPosBetween(lo, hi)
  return [...keysBetween(lo, k, mid), k, ...keysBetween(k, hi, n - mid - 1)]
}

export interface KeyedSlot {
  /** a panel's id, or null for the one being made */
  readonly id: string | null
  /** its `sb:pos` now ('' for a new panel) */
  readonly pos: string
  readonly locked: boolean
}

/**
 * The `sb:pos` writes that put `next` (the order wanted, locked panels where they stand) in order without writing
 * a locked panel: between two locked neighbours each run of the others keeps the keys that still ascend (short and
 * valid), and the rest get keys between the kept ones; a run whose new keys would pass 48 characters is keyed afresh
 * between its locked neighbours (the rebalance, around them). `newKey` is the new panel's. Null when no valid key
 * fits (two locked panels with equal keys and a panel between them, or keys past 64 characters).
 */
export function keysAroundLocked(
  next: readonly KeyedSlot[],
): { newKey: string | null; rewrites: ReadonlyMap<string, string> } | null {
  const rewrites = new Map<string, string>()
  let newKey: string | null = null
  const assign = (s: KeyedSlot, key: string) => {
    if (s.id === null) newKey = key
    else if (s.pos !== key) rewrites.set(s.id, key)
  }
  let lo: string | null = null
  let start = 0
  for (let i = 0; i <= next.length; i++) {
    const s = next[i]
    if (s && !s.locked) continue
    const hi = s ? s.pos : null
    const run = next.slice(start, i)
    if (run.length) {
      if (lo !== null && hi !== null && !(lo < hi)) return null
      const keys = keyRun(run, lo, hi)
      if (!keys) return null
      run.forEach((r, j) => {
        assign(r, keys[j] as string)
      })
    }
    // (locked panels keep their order with each other: the storyboard's order is by key)
    if (s) lo = s.pos
    start = i + 1
  }
  return { newKey, rewrites }
}

/** The keys of a run of unlocked slots between `lo` and `hi`: kept where they still ascend, else new. */
function keyRun(run: readonly KeyedSlot[], lo: string | null, hi: string | null): string[] | null {
  const short = (k: string) => isOrderKey(k) && k.length <= SB_POS_REBALANCE_CHARS
  const kept: (string | null)[] = []
  let prev = lo
  for (const r of run) {
    const ok = r.id !== null && short(r.pos) && (prev === null || r.pos > prev) && (hi === null || r.pos < hi)
    kept.push(ok ? r.pos : null)
    if (ok) prev = r.pos
  }
  const out: string[] = []
  for (let i = 0; i < run.length; ) {
    const k = kept[i]
    if (k !== null && k !== undefined) {
      out.push(k)
      i++
      continue
    }
    let j = i
    while (j < run.length && kept[j] === null) j++
    const left = out.length ? (out[out.length - 1] as string) : lo
    const right = kept[j] ?? hi
    out.push(...keysBetween(left, right, j - i))
    i = j
  }
  if (out.every(short)) return out
  // a fresh, evenly spread run between the locked neighbours (the rebalance, around them)
  const fresh = keysBetween(lo, hi, run.length)
  return fresh.every((k) => isOrderKey(k) && k.length <= SB_POS_MAX_CHARS) ? fresh : null
}

/** `list` with the item at `from` moved to `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  const [x] = out.splice(from, 1)
  if (x === undefined) return out
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x)
  return out
}

// ---- words ----------------------------------------------------------------------------------------------------

/** "SH 03": a shot number as the chip writes it (two digits at least). */
export const shotLabel = (n: number): string => `SH ${String(n).padStart(2, '0')}`

/** Greedy word wrap of `text` to `maxWidth` (by `width`), keeping the line breaks it has; a long word is split. */
export function wrapWords(text: string, maxWidth: number, width: (s: string) => number): string {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (width(next) <= maxWidth) {
        line = next
        continue
      }
      if (line) out.push(line)
      // the word alone, split when it is wider than a line
      let rest = word
      while (rest.length > 1 && width(rest) > maxWidth) {
        let cut = rest.length - 1
        while (cut > 1 && width(rest.slice(0, cut)) > maxWidth) cut--
        out.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      line = rest
    }
    out.push(line)
  }
  return out.join('\n')
}
