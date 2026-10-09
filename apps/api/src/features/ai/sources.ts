// What an AI call may read (docs/WAVE4-CONTRACTS.md §4 ai-assist): the text of the shapes the caller
// named, read by the api itself from the board's sync snapshot. Never client-sent text, never another
// board (one snapshot, one board), never comments or private-brainstorm drafts (they live in Postgres,
// not on the canvas, and are not read here), never file contents or file names (file cards, images,
// videos, embeds and bookmarks are skipped), never who wrote a note (only its text is read).
//
// A request names shape ids; a frame or a group stands for what is inside it (read through the
// snapshot's parent links, depth- and count-bounded). Each item gets a short alias (n1, n2, …) that is
// all the model ever sees of an id, so an answer can only point at items this call sent: any other id
// it writes (a real shape id copied from a hostile note, say) matches nothing.
//
// "Group into themes" sends ideas only: unlocked sticky notes with text, less a template's prompt and
// instruction notes (contracts splitThemeNotes, the same rule the web counts with; finding R9). Wave L's
// sort and score (L1-6) move notes the same way, so they send the same notes.
//
// Wave L (W1) adds three readers next to collectSources, all with the same bounds:
// - collectRecapSources (L1-2): the objects whose SERVER-stamped times (customData.lobbyServer createdAt or
//   lastEditedAt, of the object or of its label) are at or after `since`. A client-set `updated` is never
//   read: a client cannot move an old note into the window;
// - rankByQuery (L1-3): BM25-lite over the cleaned item text, case- and accent-folded, used by "Ask this
//   board" before the token-budget fill when the board holds more than fits;
// - collectIndex (L1-4): the compact index plain-language commands are planned from: per object its alias,
//   type, Lobby colour name, the alias of its frame, its tag names and its text cut to INDEX_TEXT_CHARS.
// An item's JSON line can carry extra facts (`votes`: a revealed vote's count, `theme`: the AI theme label
// above it): aggregates only, never who voted or who wrote what.
//
// Bounded work on untrusted records: at most MAX_VISITED records are looked at, rich text goes through
// board-ops plainTextOf (node, depth and length budgets), every item is cut at MAX_ITEM_CHARS, and the
// items stop at the caller's token budget (`truncated` then says so).

import { plainTextOf } from '@draftroom/board-ops'
import type { AiAction, AiNoteFacts } from '@draftroom/contracts'
import {
  AI_COLOR_NAMES,
  AI_PROMPT_META_KEY,
  AI_THEMES_MAX_NOTES,
  parseShapeTags,
  parseTagValue,
  splitThemeNotes,
} from '@draftroom/contracts'
import {
  isObject as isRecord,
  labelsByContainer,
  liveElements,
  lobbyOf,
  lobbyServerOf,
  lobbySnapshotOf,
  objectTypeOf,
  refOf,
  SINGLE_PAGE_ID,
  textOfElement,
} from '../../canvas/lobby-elements.ts'
import type { BoardSnapshotJson, RoomSnapshotJson } from '../../sync-internal.ts'
import { noteColorName, strokeColorName } from './colors.ts'

/** What the model is told an item is. The first four carry text; the rest appear in a command's index only. */
export type SourceKind =
  | 'note'
  | 'text'
  | 'shape'
  | 'arrow'
  | 'frame'
  | 'line'
  | 'drawing'
  | 'image'
  | 'video'
  | 'file'

/** Facts an item's JSON line may carry besides its alias, type and text (wave L). */
export interface ItemExtra {
  /** Votes the object received in the revealed votes the call reads (L1-2, L1-7). */
  votes?: number
  /** The AI theme label directly above the note, when there is one (L1-7). */
  theme?: string
  /** Its Lobby colour name, or null (L1-4). */
  color?: string | null
  /** The alias of the frame it is in, or null (L1-4). */
  frame?: string | null
  /** Its tag names (L1-4). */
  tags?: string[]
}

export interface SourceItem {
  /** What the model sees instead of the id: n1, n2, … in reading order. */
  alias: string
  /** The real shape id (never sent to the model). */
  id: string
  kind: SourceKind
  text: string
  /** Extra facts of its JSON line (wave L). */
  extra?: ItemExtra
}

export interface Sources {
  items: SourceItem[]
  /** Names of the frames the items are in, or that were named (context only; at most MAX_FRAME_NAMES). */
  frames: string[]
  /** Eligible items were left out: the token budget, MAX_ITEMS or the notes cap was reached. */
  truncated: boolean
}

/** Records looked at per request, expansion of frames and groups included. */
export const MAX_VISITED = 5_000
/** Items one call can carry (before the token budget). */
export const MAX_ITEMS = 400
/** Characters of one item (long text shapes are cut). */
export const MAX_ITEM_CHARS = 1_000
/** Characters of one item's text in a command's index (L1-4). */
export const INDEX_TEXT_CHARS = 120
/** Characters of a theme label sent with a voted note (L1-7). */
const THEME_LABEL_CHARS = 40
const MAX_FRAME_NAMES = 5
const MAX_FRAME_NAME_CHARS = 120
const MAX_DEPTH = 32
/** A label "directly above" a note may overlap the note's top by this much (scene units). */
const LABEL_OVERLAP = 8

export interface ShapeRec {
  id: string
  type: string
  parentId: string
  x: number
  y: number
  /** Width and height (0 when unknown). */
  w: number
  h: number
  isLocked: boolean
  props: Record<string, unknown>
  meta: Record<string, unknown>
  /** Excalidraw engine: the object's plain text (its label's), read from the elements */
  text?: string
  /** Excalidraw engine: `x`, `y` are scene coordinates (no parent offsets to add) */
  absolute?: boolean
  /** Excalidraw engine: what "Group into themes" asks of a note (contracts AiNoteFacts) */
  facts?: AiNoteFacts
  /** Its Lobby colour name (a note's fill, else its stroke), or null. */
  color: string | null
  /** Its tag names (valid tags only). */
  tags: string[]
  /** Excalidraw engine: `customData.lobby.kind` (e.g. 'ai-theme-label'), else null. */
  aiKind: string | null
  /**
   * Excalidraw engine: the latest SERVER-stamped time of the object and its label (lobbyServer createdAt
   * and lastEditedAt, ms since the epoch); null when it has none (a tldraw record).
   */
  editedAt: number | null
}

/** A board's objects by `shape:` id: what every reader here works from (read once per call). */
export type ShapeMap = Map<string, ShapeRec>

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const time = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null
const latest = (...ts: (number | null)[]): number | null => {
  let out: number | null = null
  for (const t of ts) if (t !== null && (out === null || t > out)) out = t
  return out
}
const COLOR_NAMES: ReadonlySet<string> = new Set(AI_COLOR_NAMES)

/** The tag names of an element's `customData.lobby` (`tag:<key>` → {name, color}), valid ones only. */
function elementTags(lobby: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(lobby)) {
    if (!k.startsWith('tag:') || out.length >= 10) continue
    const def = parseTagValue(k.slice('tag:'.length), v)
    if (def) out.push(def.name)
  }
  return out
}

/**
 * The objects of a board of the Excalidraw engine (`lobby-elements`), as the shape records the rules
 * below read: `shape:<elementId>` ids, the api's object types, frames as parents (`frameId`), a note's
 * text from its bound label, and its theme facts from customData (the prompt marker, a revealed private
 * note, an AI note, who last typed its label).
 */
function shapesOfElements(elements: readonly unknown[]): ShapeMap {
  const out: ShapeMap = new Map()
  const live = liveElements(elements)
  const labels = labelsByContainer(live)
  for (const el of live) {
    const type = objectTypeOf(el)
    const id = refOf(el.id)
    if (!type || !id || out.has(id)) continue
    const lobby = lobbyOf(el)
    const server = lobbyServerOf(el)
    const label = labels.get(el.id)
    const labelServer = label ? lobbyServerOf(label) : {}
    const editedBy = label ? labelServer.lastEditedBy : undefined
    out.set(id, {
      id,
      type,
      parentId: (typeof el.frameId === 'string' && refOf(el.frameId)) || SINGLE_PAGE_ID,
      x: finite(el.x),
      y: finite(el.y),
      w: Math.abs(finite(el.width)),
      h: Math.abs(finite(el.height)),
      isLocked: el.locked === true,
      props: type === 'frame' ? { name: typeof el.name === 'string' ? el.name : '' } : {},
      meta: {},
      text: textOfElement(el, labels),
      absolute: true,
      facts: {
        meta: {
          [AI_PROMPT_META_KEY]: lobby.prompt,
          drPrivateNote: server.privateNote,
          drAi: lobby.ai,
        },
        textLastEditedBy: isRecord(editedBy) && typeof editedBy.uid === 'string' ? editedBy.uid : null,
      },
      color:
        type === 'note'
          ? noteColorName(el.backgroundColor)
          : type === 'frame' || type === 'image' || type === 'video' || type === 'dr-file-card'
            ? null
            : strokeColorName(el.strokeColor),
      tags: elementTags(lobby),
      aiKind: typeof lobby.kind === 'string' ? lobby.kind : null,
      editedAt: latest(
        time(server.createdAt),
        time(server.lastEditedAt),
        time(labelServer.createdAt),
        time(labelServer.lastEditedAt),
      ),
    })
  }
  return out
}

/** The snapshot's shape records by id (anything malformed is skipped). */
export function shapesOf(snapshot: BoardSnapshotJson): ShapeMap {
  const lobby = lobbySnapshotOf(snapshot)
  if (lobby) return shapesOfElements(lobby.elements)
  const out: ShapeMap = new Map()
  const tl = snapshot as RoomSnapshotJson
  const docs = Array.isArray(tl?.documents) ? tl.documents : []
  for (const doc of docs) {
    const s = isObject(doc) ? doc.state : undefined
    if (!isObject(s) || s.typeName !== 'shape') continue
    if (typeof s.id !== 'string' || typeof s.type !== 'string' || typeof s.parentId !== 'string') continue
    if (out.has(s.id)) continue
    const props = isObject(s.props) ? s.props : {}
    const meta = isObject(s.meta) ? s.meta : {}
    out.set(s.id, {
      id: s.id,
      type: s.type,
      parentId: s.parentId,
      x: finite(s.x),
      y: finite(s.y),
      w: Math.abs(finite(props.w)),
      h: Math.abs(finite(props.h)),
      isLocked: s.isLocked === true,
      props,
      meta,
      color: typeof props.color === 'string' && COLOR_NAMES.has(props.color) ? props.color : null,
      tags: parseShapeTags(meta).map((t) => t.name),
      aiKind: null,
      editedAt: null,
    })
  }
  return out
}

const shapeMapOf = (board: BoardSnapshotJson | ShapeMap): ShapeMap =>
  board instanceof Map ? board : shapesOf(board)

/** Every object of the board (what an empty selection stands for: "the whole board"). */
export const allShapeIds = (shapes: ShapeMap): string[] => [...shapes.keys()]

/**
 * Code points never passed on: C0 controls but tab and line feed, DEL and C1, the soft hyphen,
 * zero-width characters and marks, line/paragraph separators, bidi embeddings, overrides and isolates,
 * invisible operators, and the byte-order mark. (Tab becomes a space; carriage returns go.)
 */
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
]
const isInvisible = (cp: number) => INVISIBLE.some(([a, b]) => cp >= a && cp <= b)

/**
 * Plain text for the model: control characters (bidi overrides and zero-width ones included) removed,
 * spaces collapsed within lines, at most two line breaks in a row, trimmed, cut at `max` code points.
 */
export function cleanText(raw: string, max: number, multiline = true): string {
  let s = ''
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0x09) s += ' '
    else if (!isInvisible(cp)) s += ch
  }
  s = multiline
    ? s
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
    : s.replace(/\s+/g, ' ')
  s = s.trim()
  const points = Array.from(s)
  return points.length > max
    ? `${points
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : s
}

function textOf(shape: ShapeRec, max = MAX_ITEM_CHARS): string {
  switch (shape.type) {
    case 'note':
    case 'text':
    case 'geo':
    case 'arrow':
      return cleanText(shape.text !== undefined ? shape.text : plainTextOf(shape.props.richText), max)
    default:
      return ''
  }
}

const KIND: Record<string, SourceKind> = { note: 'note', text: 'text', geo: 'shape', arrow: 'arrow' }
/** What a command's index calls each object type (files are 'file': never their names). */
const INDEX_KIND: Record<string, SourceKind> = {
  ...KIND,
  frame: 'frame',
  line: 'line',
  draw: 'drawing',
  highlight: 'drawing',
  image: 'image',
  video: 'video',
  'dr-file-card': 'file',
}

/** Conservative token estimate (UTF-8 bytes / 3: English runs about 4 characters a token). */
export function estimateTokens(s: string): number {
  return Math.ceil(Buffer.byteLength(s, 'utf8') / 3)
}

/** The JSON line an item is sent as (and costed by). */
export function itemJson(item: SourceItem): string {
  return JSON.stringify({ id: item.alias, type: item.kind, text: item.text, ...item.extra })
}

// ---- ranking (L1-3 "Ask this board") ---------------------------------------------------------------------

/** Words too common to rank by (the folded forms). */
const STOP = new Set(
  'a an and are as at be by do does for from has have how i in is it its me my no not of on or our so that the their them then there these they this to us was we were what when where which who why will with you your'.split(
    ' ',
  ),
)

/** Lower case, accents folded (NFKD less combining marks), split into letter and digit runs. */
export function foldTerms(text: string): string[] {
  const folded = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US')
  const out: string[] = []
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0]
    if (t.length < 2 && !/\p{N}/u.test(t)) continue
    if (STOP.has(t)) continue
    out.push(t)
  }
  return out
}

/**
 * BM25-lite: the indices of `texts` from most to least relevant to `query` (k1 1.2, b 0.75; ties and texts
 * that match nothing keep their order). Bounded: each text is folded once.
 */
export function rankByQuery(query: string, texts: readonly string[]): number[] {
  const q = [...new Set(foldTerms(query))]
  const order = texts.map((_, i) => i)
  if (!q.length || !texts.length) return order
  const docs = texts.map((t) => foldTerms(t))
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d)) if (q.includes(t)) df.set(t, (df.get(t) ?? 0) + 1)
  const N = docs.length
  const k1 = 1.2
  const b = 0.75
  const scores = docs.map((d) => {
    if (!d.length) return 0
    const tf = new Map<string, number>()
    for (const t of d) if (q.includes(t)) tf.set(t, (tf.get(t) ?? 0) + 1)
    let s = 0
    for (const [t, f] of tf) {
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      s += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.length) / avg))
    }
    return s
  })
  return order.sort((i, j) => (scores[j] ?? 0) - (scores[i] ?? 0) || i - j)
}

// ---- the shared reader ---------------------------------------------------------------------------------

export interface CollectOptions {
  action: AiAction
  /** Tokens the items together may take (the caller subtracts its instructions from the input cap). */
  tokenBudget: number
  /**
   * L1-3: when the eligible items do not all fit (MAX_ITEMS or the token budget), they are ranked against
   * this text before the fill, most relevant first; `truncated` still reports the cut.
   */
  query?: string
  /** Only shapes this accepts are sent (L1-7: the voted objects). */
  only?: (s: ShapeRec) => boolean
  /** Extra facts for an item's JSON line (L1-2, L1-7). */
  extraOf?: (s: ShapeRec) => ItemExtra | undefined
}

/** Actions that move notes and so send ideas only (themes, and wave L's sort and score). */
const NOTE_MOVERS: ReadonlySet<AiAction> = new Set<AiAction>(['themes', 'sort', 'score'])

interface Eligible {
  s: ShapeRec
  text: string
  at: { x: number; y: number }
}

function readerOf(shapes: ShapeMap) {
  let children: Map<string, ShapeRec[]> | null = null
  const childrenOf = (id: string): ShapeRec[] => {
    if (!children) {
      children = new Map()
      for (const s of shapes.values()) {
        const list = children.get(s.parentId) ?? []
        list.push(s)
        children.set(s.parentId, list)
      }
    }
    return children.get(id) ?? []
  }
  /** Page position (ancestor offsets added up; rotation ignored: only used to order items). */
  const position = (s: ShapeRec) => {
    if (s.absolute) return { x: s.x, y: s.y }
    let x = s.x
    let y = s.y
    let p = shapes.get(s.parentId)
    for (let d = 0; p && d < MAX_DEPTH; d++) {
      x += p.x
      y += p.y
      p = shapes.get(p.parentId)
    }
    return { x, y }
  }
  const lockedOrAncestor = (s: ShapeRec) => {
    let cur: ShapeRec | undefined = s
    for (let d = 0; cur && d < MAX_DEPTH; d++) {
      if (cur.isLocked) return true
      cur = shapes.get(cur.parentId)
    }
    return false
  }
  const frameNames: string[] = []
  const addFrameName = (s: ShapeRec | undefined) => {
    if (s?.type !== 'frame' || frameNames.length >= MAX_FRAME_NAMES) return
    const name = cleanText(typeof s.props.name === 'string' ? s.props.name : '', MAX_FRAME_NAME_CHARS, false)
    if (name && !frameNames.includes(name)) frameNames.push(name)
  }
  /**
   * The named shapes with frames and groups opened up (breadth first, bounded). `keepContainers`: frames
   * and groups are items too (a command's index), not only what is inside them.
   */
  const expand = (requested: readonly string[], keepContainers = false) => {
    const picked: ShapeRec[] = []
    const seen = new Set<string>()
    let visited = 0
    let truncated = false
    const queue: { s: ShapeRec; depth: number }[] = []
    for (const id of requested) {
      const s = shapes.get(id)
      if (s && !seen.has(id)) {
        seen.add(id)
        queue.push({ s, depth: 0 })
      }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const next = queue[qi]
      if (!next) break
      if (++visited > MAX_VISITED) {
        truncated = true
        break
      }
      const { s, depth } = next
      if (s.type === 'frame' || s.type === 'group') {
        if (s.type === 'frame' && depth === 0) addFrameName(s)
        if (keepContainers && s.type === 'frame') picked.push(s)
        if (depth >= MAX_DEPTH) continue
        for (const c of childrenOf(s.id)) {
          if (seen.has(c.id)) continue
          seen.add(c.id)
          queue.push({ s: c, depth: depth + 1 })
        }
        continue
      }
      picked.push(s)
    }
    return { picked, truncated }
  }
  /** Reading order: rows about a note tall, left to right. */
  const readingOrder = (a: Eligible, b: Eligible) =>
    Math.floor(a.at.y / 120) - Math.floor(b.at.y / 120) || a.at.x - b.at.x
  return { childrenOf, position, lockedOrAncestor, frameNames, addFrameName, expand, readingOrder }
}

/** Items in order until `cap` or the token budget (aliases n1, n2, … in that order). */
function fill(
  eligible: readonly Eligible[],
  opts: { cap: number; tokenBudget: number; extraOf?: (s: ShapeRec) => ItemExtra | undefined },
): { items: SourceItem[]; truncated: boolean } {
  const items: SourceItem[] = []
  let spent = 0
  let truncated = false
  for (const e of eligible) {
    if (items.length >= opts.cap) {
      truncated = true
      break
    }
    const extra = opts.extraOf?.(e.s)
    const item: SourceItem = {
      alias: `n${items.length + 1}`,
      id: e.s.id,
      kind: KIND[e.s.type] as SourceKind,
      text: e.text,
      ...(extra && Object.keys(extra).length ? { extra } : {}),
    }
    const cost = estimateTokens(itemJson(item)) + 1
    if (spent + cost > opts.tokenBudget) {
      truncated = true
      break
    }
    spent += cost
    items.push(item)
  }
  return { items, truncated }
}

export function collectSources(
  snapshot: BoardSnapshotJson | ShapeMap,
  requested: readonly string[],
  opts: CollectOptions,
): Sources {
  const shapes = shapeMapOf(snapshot)
  const r = readerOf(shapes)
  const { picked, truncated: cut } = r.expand(requested)
  const truncated = cut

  const movesNotes = NOTE_MOVERS.has(opts.action)
  let eligible: Eligible[] = []
  for (const s of picked) {
    if (movesNotes && (s.type !== 'note' || r.lockedOrAncestor(s))) continue
    if (!KIND[s.type]) continue
    if (opts.only && !opts.only(s)) continue
    const text = textOf(s)
    if (!text) continue
    eligible.push({ s, text, at: r.position(s) })
  }
  // Themes group ideas only: a template's prompt and instruction notes stay where they are (R9).
  if (movesNotes)
    eligible = splitThemeNotes(
      eligible,
      (e) => e.s.facts ?? { meta: e.s.meta, textLastEditedBy: e.s.props.textLastEditedBy },
    ).ideas
  eligible.sort(r.readingOrder)
  for (const e of eligible) r.addFrameName(shapes.get(e.s.parentId))

  const cap = movesNotes ? Math.min(MAX_ITEMS, AI_THEMES_MAX_NOTES) : MAX_ITEMS
  // L1-3: more than fits, so the most relevant go first.
  if (opts.query !== undefined && !fitsWhole(eligible, cap, opts)) {
    const order = rankByQuery(
      opts.query,
      eligible.map((e) => e.text),
    )
    eligible = order.map((i) => eligible[i] as Eligible)
  }
  const filled = fill(eligible, { cap, tokenBudget: opts.tokenBudget, extraOf: opts.extraOf })
  return { items: filled.items, frames: r.frameNames, truncated: truncated || filled.truncated }
}

/** Whether every eligible item fits under the cap and the budget (aliases as `fill` would give them). */
function fitsWhole(eligible: readonly Eligible[], cap: number, opts: CollectOptions): boolean {
  if (eligible.length > cap) return false
  let spent = 0
  for (const [i, e] of eligible.entries()) {
    const extra = opts.extraOf?.(e.s)
    spent +=
      estimateTokens(
        itemJson({ alias: `n${i + 1}`, id: e.s.id, kind: KIND[e.s.type] as SourceKind, text: e.text, extra }),
      ) + 1
    if (spent > opts.tokenBudget) return false
  }
  return true
}

// ---- recap (L1-2) ----------------------------------------------------------------------------------------

export interface RecapOptions {
  /** Ms since the epoch: objects whose server-stamped times are at or after it. */
  since: number
  tokenBudget: number
  extraOf?: (s: ShapeRec) => ItemExtra | undefined
}

/**
 * What a "since" recap reads: every object with text (notes, texts, shape and arrow labels) whose own or
 * whose label's server-stamped createdAt or lastEditedAt is at or after `since`, in reading order, with the
 * names of their frames and of frames made or renamed in the window. Never a client-set time.
 */
export function collectRecapSources(snapshot: BoardSnapshotJson | ShapeMap, opts: RecapOptions): Sources {
  const shapes = shapeMapOf(snapshot)
  const r = readerOf(shapes)
  const inWindow = (s: ShapeRec) => s.editedAt !== null && s.editedAt >= opts.since
  const eligible: Eligible[] = []
  let visited = 0
  let truncated = false
  for (const s of shapes.values()) {
    if (++visited > MAX_VISITED) {
      truncated = true
      break
    }
    if (!KIND[s.type] || !inWindow(s)) continue
    const text = textOf(s)
    if (!text) continue
    eligible.push({ s, text, at: r.position(s) })
  }
  eligible.sort(r.readingOrder)
  for (const e of eligible) r.addFrameName(shapes.get(e.s.parentId))
  for (const s of shapes.values()) if (s.type === 'frame' && inWindow(s)) r.addFrameName(s)
  const filled = fill(eligible, { cap: MAX_ITEMS, tokenBudget: opts.tokenBudget, extraOf: opts.extraOf })
  return { items: filled.items, frames: r.frameNames, truncated: truncated || filled.truncated }
}

// ---- a command's index (L1-4) ------------------------------------------------------------------------------

/**
 * The compact index a plain-language command is planned from: the named objects (or the whole board) with
 * frames as items of their own, frames first, then reading order; per item its type, Lobby colour name, the
 * alias of its frame (when that frame is in the index), its tag names and its text cut to INDEX_TEXT_CHARS.
 * Objects without text count too (a command can recolour or select them); files never show their names.
 */
export function collectIndex(
  snapshot: BoardSnapshotJson | ShapeMap,
  requested: readonly string[],
  opts: { tokenBudget: number },
): Sources {
  const shapes = shapeMapOf(snapshot)
  const r = readerOf(shapes)
  const { picked, truncated: cut } = r.expand(requested, true)
  const eligible: Eligible[] = []
  for (const s of picked) {
    if (!INDEX_KIND[s.type]) continue
    const text =
      s.type === 'frame'
        ? cleanText(typeof s.props.name === 'string' ? s.props.name : '', INDEX_TEXT_CHARS, false)
        : textOf(s, INDEX_TEXT_CHARS)
    eligible.push({ s, text, at: r.position(s) })
  }
  eligible.sort((a, b) => Number(b.s.type === 'frame') - Number(a.s.type === 'frame') || r.readingOrder(a, b))
  for (const e of eligible) if (e.s.type === 'frame') r.addFrameName(e.s)

  const items: SourceItem[] = []
  const frameAlias = new Map<string, string>()
  let spent = 0
  let truncated = cut
  for (const e of eligible) {
    if (items.length >= MAX_ITEMS) {
      truncated = true
      break
    }
    const alias = `n${items.length + 1}`
    const item: SourceItem = {
      alias,
      id: e.s.id,
      kind: INDEX_KIND[e.s.type] as SourceKind,
      text: e.text,
      extra: {
        color: e.s.color,
        frame: frameAlias.get(e.s.parentId) ?? null,
        tags: e.s.tags,
      },
    }
    const cost = estimateTokens(itemJson(item)) + 1
    if (spent + cost > opts.tokenBudget) {
      truncated = true
      break
    }
    spent += cost
    items.push(item)
    if (e.s.type === 'frame') frameAlias.set(e.s.id, alias)
  }
  return { items, frames: r.frameNames, truncated }
}

// ---- theme labels (L1-7) -----------------------------------------------------------------------------------

/**
 * The AI theme label of a note: the 'ai-theme-label' text of the same frame directly above it (its span
 * overlapping the note's, its bottom no lower than the note's top), the nearest one; '' when none. The web's
 * "Group into themes" puts each cluster's label right above its notes (web ported/apply.ts).
 */
export function themeLabelOf(shapes: ShapeMap, note: ShapeRec): string {
  let best: ShapeRec | null = null
  for (const s of shapes.values()) {
    if (s.type !== 'text' || s.aiKind !== 'ai-theme-label' || s.parentId !== note.parentId) continue
    const overlaps = s.x < note.x + note.w && s.x + s.w > note.x
    const above = s.y + s.h <= note.y + LABEL_OVERLAP
    if (!overlaps || !above) continue
    if (!best || s.y > best.y) best = s
  }
  return best ? textOf(best, THEME_LABEL_CHARS) : ''
}
