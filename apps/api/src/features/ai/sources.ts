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
// instruction notes (contracts splitThemeNotes, the same rule the web counts with; finding R9).
//
// Bounded work on untrusted records: at most MAX_VISITED records are looked at, rich text goes through
// board-ops plainTextOf (node, depth and length budgets), every item is cut at MAX_ITEM_CHARS, and the
// items stop at the caller's token budget (`truncated` then says so).

import { plainTextOf } from '@draftroom/board-ops'
import type { AiAction, AiNoteFacts } from '@draftroom/contracts'
import { AI_PROMPT_META_KEY, AI_THEMES_MAX_NOTES, splitThemeNotes } from '@draftroom/contracts'
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

export type SourceKind = 'note' | 'text' | 'shape' | 'arrow'

export interface SourceItem {
  /** What the model sees instead of the id: n1, n2, … in reading order. */
  alias: string
  /** The real shape id (never sent to the model). */
  id: string
  kind: SourceKind
  text: string
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
const MAX_FRAME_NAMES = 5
const MAX_FRAME_NAME_CHARS = 120
const MAX_DEPTH = 32

interface ShapeRec {
  id: string
  type: string
  parentId: string
  x: number
  y: number
  isLocked: boolean
  props: Record<string, unknown>
  meta: Record<string, unknown>
  /** Excalidraw engine: the object's plain text (its label's), read from the elements */
  text?: string
  /** Excalidraw engine: `x`, `y` are scene coordinates (no parent offsets to add) */
  absolute?: boolean
  /** Excalidraw engine: what "Group into themes" asks of a note (contracts AiNoteFacts) */
  facts?: AiNoteFacts
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * The objects of a board of the Excalidraw engine (`lobby-elements`), as the shape records the rules
 * below read: `shape:<elementId>` ids, the api's object types, frames as parents (`frameId`), a note's
 * text from its bound label, and its theme facts from customData (the prompt marker, a revealed private
 * note, an AI note, who last typed its label).
 */
function shapesOfElements(elements: readonly unknown[]): Map<string, ShapeRec> {
  const out = new Map<string, ShapeRec>()
  const live = liveElements(elements)
  const labels = labelsByContainer(live)
  for (const el of live) {
    const type = objectTypeOf(el)
    const id = refOf(el.id)
    if (!type || !id || out.has(id)) continue
    const lobby = lobbyOf(el)
    const label = labels.get(el.id)
    const editedBy = label ? lobbyServerOf(label).lastEditedBy : undefined
    out.set(id, {
      id,
      type,
      parentId: (typeof el.frameId === 'string' && refOf(el.frameId)) || SINGLE_PAGE_ID,
      x: finite(el.x),
      y: finite(el.y),
      isLocked: el.locked === true,
      props: type === 'frame' ? { name: typeof el.name === 'string' ? el.name : '' } : {},
      meta: {},
      text: textOfElement(el, labels),
      absolute: true,
      facts: {
        meta: {
          [AI_PROMPT_META_KEY]: lobby.prompt,
          drPrivateNote: lobbyServerOf(el).privateNote,
          drAi: lobby.ai,
        },
        textLastEditedBy: isRecord(editedBy) && typeof editedBy.uid === 'string' ? editedBy.uid : null,
      },
    })
  }
  return out
}

/** The snapshot's shape records by id (anything malformed is skipped). */
export function shapesOf(snapshot: BoardSnapshotJson): Map<string, ShapeRec> {
  const lobby = lobbySnapshotOf(snapshot)
  if (lobby) return shapesOfElements(lobby.elements)
  const out = new Map<string, ShapeRec>()
  const tl = snapshot as RoomSnapshotJson
  const docs = Array.isArray(tl?.documents) ? tl.documents : []
  for (const doc of docs) {
    const s = isObject(doc) ? doc.state : undefined
    if (!isObject(s) || s.typeName !== 'shape') continue
    if (typeof s.id !== 'string' || typeof s.type !== 'string' || typeof s.parentId !== 'string') continue
    if (out.has(s.id)) continue
    out.set(s.id, {
      id: s.id,
      type: s.type,
      parentId: s.parentId,
      x: finite(s.x),
      y: finite(s.y),
      isLocked: s.isLocked === true,
      props: isObject(s.props) ? s.props : {},
      meta: isObject(s.meta) ? s.meta : {},
    })
  }
  return out
}

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

function textOf(shape: ShapeRec): string {
  switch (shape.type) {
    case 'note':
    case 'text':
    case 'geo':
    case 'arrow':
      return cleanText(
        shape.text !== undefined ? shape.text : plainTextOf(shape.props.richText),
        MAX_ITEM_CHARS,
      )
    default:
      return ''
  }
}

const KIND: Record<string, SourceKind> = { note: 'note', text: 'text', geo: 'shape', arrow: 'arrow' }

/** Conservative token estimate (UTF-8 bytes / 3: English runs about 4 characters a token). */
export function estimateTokens(s: string): number {
  return Math.ceil(Buffer.byteLength(s, 'utf8') / 3)
}

/** The JSON line an item is sent as (and costed by). */
export function itemJson(item: SourceItem): string {
  return JSON.stringify({ id: item.alias, type: item.kind, text: item.text })
}

export interface CollectOptions {
  action: AiAction
  /** Tokens the items together may take (the caller subtracts its instructions from the input cap). */
  tokenBudget: number
}

export function collectSources(
  snapshot: BoardSnapshotJson,
  requested: readonly string[],
  opts: CollectOptions,
): Sources {
  const shapes = shapesOf(snapshot)
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

  // The named shapes, frames and groups opened up (breadth first, bounded).
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

  const themes = opts.action === 'themes'
  let eligible: { s: ShapeRec; text: string; at: { x: number; y: number } }[] = []
  for (const s of picked) {
    if (themes && (s.type !== 'note' || lockedOrAncestor(s))) continue
    if (!KIND[s.type]) continue
    const text = textOf(s)
    if (!text) continue
    eligible.push({ s, text, at: position(s) })
  }
  // Themes group ideas only: a template's prompt and instruction notes stay where they are (R9).
  if (themes)
    eligible = splitThemeNotes(
      eligible,
      (e) => e.s.facts ?? { meta: e.s.meta, textLastEditedBy: e.s.props.textLastEditedBy },
    ).ideas
  // Reading order: rows about a note tall, left to right.
  eligible.sort((a, b) => Math.floor(a.at.y / 120) - Math.floor(b.at.y / 120) || a.at.x - b.at.x)
  for (const e of eligible) addFrameName(shapes.get(e.s.parentId))

  const cap = themes ? Math.min(MAX_ITEMS, AI_THEMES_MAX_NOTES) : MAX_ITEMS
  const items: SourceItem[] = []
  let spent = 0
  for (const e of eligible) {
    if (items.length >= cap) {
      truncated = true
      break
    }
    const item: SourceItem = {
      alias: `n${items.length + 1}`,
      id: e.s.id,
      kind: KIND[e.s.type] as SourceKind,
      text: e.text,
    }
    const cost = estimateTokens(itemJson(item)) + 1
    if (spent + cost > opts.tokenBudget) {
      truncated = true
      break
    }
    spent += cost
    items.push(item)
  }
  return { items, frames: frameNames, truncated }
}
