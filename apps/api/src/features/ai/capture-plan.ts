// OWNER: WS5 (wave N, N5-1). A capture's answer is untrusted, like any model answer (plan.ts): a photo or a
// transcript can carry an injection, and the model can simply be wrong. This turns the answers into the contract's
// CaptureResult, or refuses them (BadOutput):
// - shapes: only checked fields are read; arrays are looked at up to a bound and cut to the contract's maxima;
// - text: plain text only (control, zero-width and bidi characters removed, Markdown marks dropped, whitespace
//   collapsed), cut to the contract's lengths; empty entries dropped;
// - boxes: numbers clamped into the photo (0..1), a box never running past its edge;
// - ids: the model's node ids map to the api's own (n1, n2, ...); an edge to a node it never named is dropped;
// - groups: indexes into the notes that were kept, each note in one group at most;
// - owners: a name the transcript never writes is one the model made up, and it is dropped (never linked to a user).
//
// A transcript is read in parts (transcriptChunks): each part's answer is merged here by normalised text (a theme by
// its name, a note, a decision or an action by its words), and the optional reduce call's themes regroup the notes
// of every part (reduceThemes). Pure: unit-tested.

import {
  AI_COLOR_NAMES,
  AI_DIAGRAM_EDGE_LABEL_MAX_CHARS,
  AI_DIAGRAM_LABEL_MAX_CHARS,
  AI_DIAGRAM_MAX_EDGES,
  AI_DIAGRAM_MAX_NODES,
  AI_ITEM_MAX_CHARS,
  AI_OTHER_THEME,
  AI_OWNER_MAX_CHARS,
  AI_THEME_NAME_MAX_CHARS,
  type AiColorName,
  CAPTURE_ACTIONS_MAX,
  CAPTURE_DECISIONS_MAX,
  CAPTURE_GROUPS_MAX,
  CAPTURE_NODE_SHAPES,
  CAPTURE_NOTE_MAX_CHARS,
  CAPTURE_NOTES_MAX,
  CAPTURE_THEME_NOTES_MAX,
  CAPTURE_THEMES_MAX,
  type CaptureActionItem,
  type CaptureBox,
  type CaptureEdge,
  type CaptureGroup,
  type CaptureMode,
  type CaptureNode,
  type CaptureNote,
  CaptureResult,
  type CaptureTheme,
} from '@draftroom/contracts'
import { BadOutput } from './plan.ts'
import { cleanText } from './sources.ts'

/** Entries of any answer array looked at, whatever the answer claims (a flood is cut here). */
const LOOK_AT = 240
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, LOOK_AT) : [])
const str = (v: unknown) => (typeof v === 'string' ? v : '')
/** Markdown emphasis, heading and list marks the model may add anyway: plain text on the board. */
const strip = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/^\s*(#+|[-*•]|\d+[.)])\s+/gm, '')
const line = (v: unknown, max: number) => cleanText(strip(str(v)), max, false)
const lines = (v: unknown, max: number) => cleanText(strip(str(v)), max, true)

/** The text two entries are the same by: case, accents' combining marks, punctuation and spacing ignored. */
export function normKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// ---- photos ------------------------------------------------------------------------------------------------------

const clamp01 = (v: unknown) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
  return Math.max(0, Math.min(1, n))
}
const round = (n: number) => Math.round(n * 10_000) / 10_000

/** A box inside the photo (0..1), never past its right or bottom edge; null when it is not an object. */
export function boxOf(v: unknown): CaptureBox | null {
  if (!isObj(v)) return null
  const x = clamp01(v.x)
  const y = clamp01(v.y)
  const w = Math.min(clamp01(v.w), 1 - x)
  const h = Math.min(clamp01(v.h), 1 - y)
  return { x: round(x), y: round(y), w: round(w), h: round(h) }
}

const colorOf = (v: unknown): AiColorName =>
  (AI_COLOR_NAMES as readonly string[]).includes(str(v)) ? (str(v) as AiColorName) : 'yellow'

/** Notes and groups (see the header). Notes whose words could not be read are dropped. */
export function notesResult(json: unknown): Extract<CaptureResult, { kind: 'notes' }> {
  if (!isObj(json) || !Array.isArray(json.notes) || !Array.isArray(json.groups))
    throw new BadOutput('capture notes: wrong shape')
  const notes: CaptureNote[] = []
  /** the model's index → the kept note's */
  const kept = new Map<number, number>()
  arr(json.notes).forEach((raw, i) => {
    if (notes.length >= CAPTURE_NOTES_MAX || !isObj(raw)) return
    const text = lines(raw.text, CAPTURE_NOTE_MAX_CHARS)
    if (!text) return
    kept.set(i, notes.length)
    notes.push({ text, color: colorOf(raw.color), box: boxOf(raw.box) ?? { x: 0, y: 0, w: 0, h: 0 } })
  })
  const groups: CaptureGroup[] = []
  const placed = new Set<number>()
  for (const raw of arr(json.groups)) {
    if (groups.length >= CAPTURE_GROUPS_MAX) break
    if (!isObj(raw)) continue
    const members: number[] = []
    for (const v of arr(raw.notes)) {
      const at = typeof v === 'number' && Number.isInteger(v) ? kept.get(v) : undefined
      if (at === undefined || placed.has(at)) continue
      placed.add(at)
      members.push(at)
    }
    if (!members.length) continue
    groups.push({ name: line(raw.name, AI_THEME_NAME_MAX_CHARS) || 'Group', notes: members })
  }
  return { kind: 'notes', notes, groups }
}

const SHAPES = new Set<string>(CAPTURE_NODE_SHAPES)

/** A diagram's nodes and edges (see the header): node ids are the api's own, n1 to n40. */
export function diagramResult(json: unknown): Extract<CaptureResult, { kind: 'diagram' }> {
  if (!isObj(json) || !Array.isArray(json.nodes) || !Array.isArray(json.edges))
    throw new BadOutput('capture diagram: wrong shape')
  const ours = new Map<string, string>()
  const nodes: CaptureNode[] = []
  for (const raw of arr(json.nodes)) {
    if (nodes.length >= AI_DIAGRAM_MAX_NODES) break
    if (!isObj(raw)) continue
    const theirs = str(raw.id).trim()
    const label = line(raw.label, AI_DIAGRAM_LABEL_MAX_CHARS)
    if (!theirs || ours.has(theirs) || !label) continue
    const id = `n${nodes.length + 1}`
    ours.set(theirs, id)
    const box = boxOf(raw.box)
    const shape = SHAPES.has(str(raw.shape)) ? (str(raw.shape) as CaptureNode['shape']) : 'rect'
    nodes.push({ id, label, shape, ...(box && box.w > 0 && box.h > 0 ? { box } : {}) })
  }
  const edges: CaptureEdge[] = []
  const pairs = new Set<string>()
  for (const raw of arr(json.edges)) {
    if (edges.length >= AI_DIAGRAM_MAX_EDGES) break
    if (!isObj(raw)) continue
    const from = ours.get(str(raw.from).trim())
    const to = ours.get(str(raw.to).trim())
    if (!from || !to || from === to || pairs.has(`${from}>${to}`)) continue
    pairs.add(`${from}>${to}`)
    const label = line(raw.label, AI_DIAGRAM_EDGE_LABEL_MAX_CHARS)
    edges.push({ from, to, kind: raw.kind === 'line' ? 'line' : 'arrow', ...(label ? { label } : {}) })
  }
  return { kind: 'diagram', nodes, edges }
}

/** A photo's answer for `mode` ('auto': the kind the model says, notes when it says nothing usable). */
export function photoResult(mode: CaptureMode, json: unknown): CaptureResult {
  let out: CaptureResult
  if (mode === 'notes') out = notesResult(json)
  else if (mode === 'diagram') out = diagramResult(json)
  else {
    if (!isObj(json)) throw new BadOutput('capture auto: wrong shape')
    out = json.kind === 'diagram' ? diagramResult(json) : notesResult(json)
  }
  // the contract is the last gate: an answer the web could not parse is never sent
  const checked = CaptureResult.safeParse(out)
  if (!checked.success) throw new BadOutput('capture: not a capture result')
  return checked.data
}

// ---- transcripts --------------------------------------------------------------------------------------------------

/**
 * The transcript in at most `maxParts` parts, each at most `maxBytes` UTF-8 bytes, split at line ends (a line
 * longer than a part is split at a space, else anywhere). What does not fit in `maxParts` parts is left out
 * (`truncated`).
 */
export function transcriptChunks(
  text: string,
  maxBytes: number,
  maxParts: number,
): { parts: string[]; truncated: boolean } {
  const budget = Math.max(64, Math.floor(maxBytes))
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
  const pieces: string[] = []
  for (const l of text.split('\n')) {
    let rest = l
    while (bytes(rest) > budget) {
      // the longest prefix within the budget (a binary search), cut at the last space when there is one
      let lo = 1
      let hi = Math.min(rest.length, budget)
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (bytes(rest.slice(0, mid)) <= budget) lo = mid
        else hi = mid - 1
      }
      const n = lo
      const space = rest.lastIndexOf(' ', n)
      const cut = space > n / 2 ? space : n
      pieces.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^ /, '')
    }
    pieces.push(rest)
  }
  const parts: string[] = []
  let current = ''
  let truncated = false
  for (const p of pieces) {
    const next = current ? `${current}\n${p}` : p
    if (bytes(next) <= budget) {
      current = next
      continue
    }
    if (current.trim()) parts.push(current)
    current = p
    if (parts.length >= maxParts) {
      truncated = true
      current = ''
      break
    }
  }
  if (!truncated && current.trim()) {
    if (parts.length < maxParts) parts.push(current)
    else truncated = true
  }
  return { parts, truncated }
}

/** One map call's answer, cleaned (not yet merged or cut to the contract's maxima). */
export interface MeetingPart {
  themes: { name: string; notes: string[] }[]
  decisions: string[]
  actions: { text: string; owner: string | null }[]
}

/** Whether `name` appears in the transcript as a whole word or phrase (case ignored). */
function named(name: string, transcriptKey: string): boolean {
  const k = normKey(name)
  return !!k && ` ${transcriptKey} `.includes(` ${k} `)
}

/** One map call's answer (see the header). `transcriptKey`: normKey of the transcript, for the owners. */
export function meetingPart(json: unknown, transcriptKey: string): MeetingPart {
  if (
    !isObj(json) ||
    !Array.isArray(json.themes) ||
    !Array.isArray(json.decisions) ||
    !Array.isArray(json.actions)
  )
    throw new BadOutput('capture transcript: wrong shape')
  const themes: MeetingPart['themes'] = []
  for (const raw of arr(json.themes)) {
    if (!isObj(raw)) continue
    const name = line(raw.name, AI_THEME_NAME_MAX_CHARS)
    const notes = arr(raw.notes)
      .map((n) => line(n, CAPTURE_NOTE_MAX_CHARS))
      .filter(Boolean)
    if (name && notes.length) themes.push({ name, notes })
  }
  const decisions = arr(json.decisions)
    .map((d) => line(d, AI_ITEM_MAX_CHARS))
    .filter(Boolean)
  const actions: MeetingPart['actions'] = []
  for (const raw of arr(json.actions)) {
    if (!isObj(raw)) continue
    const text = line(raw.text, AI_ITEM_MAX_CHARS)
    if (!text) continue
    const owner = line(raw.owner, AI_OWNER_MAX_CHARS)
    actions.push({ text, owner: owner && named(owner, transcriptKey) ? owner : null })
  }
  return { themes, decisions, actions }
}

/** The parts' answers as one (see the header): every entry once, by its normalised words, in the order first seen. */
export function mergeMeeting(parts: readonly MeetingPart[]): MeetingPart {
  const themes = new Map<string, { name: string; notes: string[] }>()
  const seenNotes = new Set<string>()
  const decisions = new Map<string, string>()
  const actions = new Map<string, { text: string; owner: string | null }>()
  for (const p of parts) {
    for (const t of p.themes) {
      const k = normKey(t.name)
      let theme = themes.get(k)
      if (!theme) {
        theme = { name: t.name, notes: [] }
        themes.set(k, theme)
      }
      for (const n of t.notes) {
        const nk = normKey(n)
        if (!nk || seenNotes.has(nk)) continue
        seenNotes.add(nk)
        theme.notes.push(n)
      }
    }
    for (const d of p.decisions) {
      const k = normKey(d)
      if (k && !decisions.has(k)) decisions.set(k, d)
    }
    for (const a of p.actions) {
      const k = normKey(a.text)
      if (!k) continue
      const seen = actions.get(k)
      if (!seen) actions.set(k, { ...a })
      else if (!seen.owner && a.owner) seen.owner = a.owner
    }
  }
  return {
    themes: [...themes.values()].filter((t) => t.notes.length),
    decisions: [...decisions.values()],
    actions: [...actions.values()],
  }
}

/** The notes of a merged meeting as the reduce call's items (t1, t2, ...), at most `max` of them. */
export function reduceItems(m: MeetingPart, max: number): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = []
  for (const t of m.themes)
    for (const n of t.notes) {
      if (out.length >= max) return out
      out.push({ id: `t${out.length + 1}`, text: n })
    }
  return out
}

/**
 * The reduce call's themes over the notes it was sent (`items`): each note in one theme at most, notes it left out
 * in "Other"; notes never sent keep their own theme. Throws BadOutput for a wrong shape or no theme at all (the caller
 * then keeps the merged themes).
 */
export function reduceThemes(
  json: unknown,
  merged: MeetingPart,
  items: readonly { id: string; text: string }[],
): MeetingPart['themes'] {
  if (!isObj(json) || !Array.isArray(json.themes)) throw new BadOutput('capture themes: wrong shape')
  const byId = new Map(items.map((i) => [i.id, i.text]))
  const placed = new Set<string>()
  const themes: MeetingPart['themes'] = []
  for (const raw of arr(json.themes)) {
    if (!isObj(raw)) continue
    const name = line(raw.name, AI_THEME_NAME_MAX_CHARS)
    const notes: string[] = []
    for (const v of arr(raw.note_ids)) {
      const id = str(v).trim()
      const text = byId.get(id)
      if (text === undefined || placed.has(id)) continue
      placed.add(id)
      notes.push(text)
    }
    if (name && notes.length) themes.push({ name, notes })
  }
  if (!themes.length) throw new BadOutput('capture themes: none')
  const left = items.filter((i) => !placed.has(i.id)).map((i) => i.text)
  if (left.length) themes.push({ name: AI_OTHER_THEME, notes: left })
  // notes past what was sent keep the theme they came in
  const sent = new Set(items.map((i) => normKey(i.text)))
  for (const t of merged.themes) {
    const rest = t.notes.filter((n) => !sent.has(normKey(n)))
    if (rest.length) themes.push({ name: t.name, notes: rest })
  }
  return themes
}

/** A merged meeting cut to the contract's maxima, as its CaptureResult. */
export function transcriptResult(m: MeetingPart): Extract<CaptureResult, { kind: 'transcript' }> {
  const themes: CaptureTheme[] = m.themes
    .slice(0, CAPTURE_THEMES_MAX)
    .map((t) => ({ name: t.name, notes: t.notes.slice(0, CAPTURE_THEME_NOTES_MAX) }))
  const actions: CaptureActionItem[] = m.actions
    .slice(0, CAPTURE_ACTIONS_MAX)
    .map((a) => ({ text: a.text, ...(a.owner ? { owner: a.owner } : {}) }))
  const out: CaptureResult = {
    kind: 'transcript',
    themes,
    decisions: m.decisions.slice(0, CAPTURE_DECISIONS_MAX),
    actions,
  }
  const checked = CaptureResult.safeParse(out)
  if (!checked.success || checked.data.kind !== 'transcript')
    throw new BadOutput('capture transcript: not a capture result')
  return checked.data
}
