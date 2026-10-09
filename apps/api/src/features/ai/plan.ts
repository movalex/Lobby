// The model's answer is untrusted (docs/WAVE4-CONTRACTS.md §4 ai-assist): a note on the board can hold
// a prompt injection, and the model can simply be wrong. This turns an answer into the plan the client
// applies, or refuses it:
// - shapes: only zod-checked fields are read; everything else is ignored;
// - counts: arrays are looked at up to a bound and clamped to the contract's maxima;
// - text: control, zero-width and bidi characters removed, whitespace collapsed, cut to the contract's
//   lengths; empty and repeated entries dropped;
// - ids: only aliases this call sent (sources.ts) map to shape ids, and for themes only the notes that
//   were eligible (unlocked sticky notes); each note lands in one theme; notes the answer leaves out go
//   to "Other". Anything else the answer names (a real id copied from a note, a made-up one) is dropped.

import {
  AI_ACTION_ITEMS_MAX,
  AI_ANSWER_MAX_CHARS,
  AI_CITATION_MAX_IDS,
  AI_CITATIONS_MAX,
  AI_COMMAND_EXPLAIN_MAX_CHARS,
  AI_COMMAND_FIND_OPS,
  AI_COMMAND_FRAME_NAME_MAX_CHARS,
  AI_COMMAND_MAX_IDS_PER_OP,
  AI_COMMAND_MAX_OPS,
  AI_COMMAND_OP_NAMES,
  AI_DIAGRAM_EDGE_LABEL_MAX_CHARS,
  AI_DIAGRAM_LABEL_MAX_CHARS,
  AI_DIAGRAM_MAX_EDGES,
  AI_DIAGRAM_MAX_NODES,
  AI_DIAGRAM_NODE_KINDS,
  AI_IDEAS_MAX,
  AI_ITEM_MAX_CHARS,
  AI_OTHER_THEME,
  AI_OWNER_MAX_CHARS,
  AI_RECAP_ACTIONS_MAX,
  AI_RECAP_DECISIONS_MAX,
  AI_RECAP_LINE_MAX_CHARS,
  AI_RECAP_LINE_MAX_IDS,
  AI_RECAP_QUESTIONS_MAX,
  AI_RECAP_SUMMARY_MAX_CHARS,
  AI_RECAP_TITLE_MAX_CHARS,
  AI_SCORE_MAX,
  AI_SCORE_MIN,
  AI_SUMMARY_MAX_CHARS,
  AI_THEME_NAME_MAX_CHARS,
  AI_THEMES_MAX,
  type AiActionItem,
  type AiCitation,
  AiCommandOp,
  type AiDiagramEdge,
  type AiDiagramNode,
  type AiRecapAction,
  type AiRecapLine,
  type AiScore,
  type AiTheme,
  normalizeTagName,
  tagNameError,
} from '@draftroom/contracts'
import { z } from 'zod'
import { cleanText, type SourceItem } from './sources.ts'

export class BadOutput extends Error {}

/** Entries of any answer array looked at, whatever the answer claims (a flood is cut here). */
const LOOK_AT = 64
/** Ids looked at per theme. */
const IDS_PER_THEME = 400

const Summary = z.object({ summary: z.string() })
const Themes = z.object({ themes: z.array(z.unknown()) })
const Theme = z.object({ name: z.unknown(), note_ids: z.array(z.unknown()) })
const Actions = z.object({ items: z.array(z.unknown()) })
const Action = z.object({ task: z.unknown(), owner: z.unknown() })
const Ideas = z.object({ ideas: z.array(z.unknown()) })

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const key = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, ' ')

function strip(markdown: string): string {
  // Plain text on the board: drop Markdown emphasis and heading marks the model may add anyway.
  return markdown.replace(/\*\*|__|^#+\s*/gm, '')
}

export function summaryPlan(json: unknown): { summary: string } {
  const r = Summary.safeParse(json)
  if (!r.success) throw new BadOutput('summary: wrong shape')
  const summary = cleanText(strip(r.data.summary), AI_SUMMARY_MAX_CHARS)
  if (!summary) throw new BadOutput('summary: empty')
  return { summary }
}

export function themesPlan(json: unknown, sent: readonly SourceItem[]): { themes: AiTheme[] } {
  const r = Themes.safeParse(json)
  if (!r.success) throw new BadOutput('themes: wrong shape')
  const byAlias = new Map(sent.map((i) => [i.alias, i.id]))
  const placed = new Set<string>()
  const groups = new Map<string, AiTheme>()
  for (const raw of r.data.themes.slice(0, LOOK_AT)) {
    const t = Theme.safeParse(raw)
    if (!t.success) continue
    const ids: string[] = []
    for (const a of t.data.note_ids.slice(0, IDS_PER_THEME)) {
      const id = byAlias.get(str(a).trim())
      if (!id || placed.has(id)) continue
      placed.add(id)
      ids.push(id)
    }
    if (!ids.length) continue
    const name = cleanText(strip(str(t.data.name)), AI_THEME_NAME_MAX_CHARS, false) || 'Theme'
    const existing = groups.get(key(name))
    if (existing) existing.noteIds.push(...ids)
    else groups.set(key(name), { name, noteIds: ids })
  }
  if (!placed.size) throw new BadOutput('themes: no usable note ids')
  let themes = [...groups.values()]
  // Too many themes: the largest keep their names, the rest join "Other" (stable for equal sizes).
  if (themes.length > AI_THEMES_MAX) {
    const ranked = themes
      .map((t, i) => ({ t, i }))
      .sort((a, b) => b.t.noteIds.length - a.t.noteIds.length || a.i - b.i)
    const keep = new Set(ranked.slice(0, AI_THEMES_MAX - 1).map((x) => x.t))
    const rest = themes.filter((t) => !keep.has(t)).flatMap((t) => t.noteIds)
    themes = themes.filter((t) => keep.has(t))
    themes.push({ name: AI_OTHER_THEME, noteIds: rest })
  }
  const left = sent.map((i) => i.id).filter((id) => !placed.has(id))
  if (left.length) {
    const other = themes.find((t) => key(t.name) === key(AI_OTHER_THEME))
    if (other) other.noteIds.push(...left)
    else if (themes.length < AI_THEMES_MAX) themes.push({ name: AI_OTHER_THEME, noteIds: left })
    else themes[themes.length - 1]?.noteIds.push(...left)
  }
  return { themes }
}

export function actionsPlan(json: unknown): { items: AiActionItem[] } {
  const r = Actions.safeParse(json)
  if (!r.success) throw new BadOutput('actions: wrong shape')
  const items: AiActionItem[] = []
  const seen = new Set<string>()
  for (const raw of r.data.items.slice(0, LOOK_AT)) {
    if (items.length >= AI_ACTION_ITEMS_MAX) break
    const a = Action.safeParse(raw)
    if (!a.success) continue
    const text = cleanText(strip(str(a.data.task)), AI_ITEM_MAX_CHARS, false)
    if (!text || seen.has(key(text))) continue
    seen.add(key(text))
    const owner = cleanText(str(a.data.owner), AI_OWNER_MAX_CHARS, false)
    items.push({ text, owner: owner && key(owner) !== 'null' ? owner : null })
  }
  // An empty list is a valid answer ("nothing to do"); the client says so.
  return { items }
}

export function ideasPlan(json: unknown, count: number): { ideas: string[] } {
  const r = Ideas.safeParse(json)
  if (!r.success) throw new BadOutput('ideas: wrong shape')
  const want = Math.max(1, Math.min(AI_IDEAS_MAX, count))
  const ideas: string[] = []
  const seen = new Set<string>()
  for (const raw of r.data.ideas.slice(0, LOOK_AT)) {
    if (ideas.length >= want) break
    const text = cleanText(strip(str(raw)).replace(/^\s*(?:\d+[.)]|[-*•])\s+/, ''), AI_ITEM_MAX_CHARS, false)
    if (!text || seen.has(key(text))) continue
    seen.add(key(text))
    ideas.push(text)
  }
  if (!ideas.length) throw new BadOutput('ideas: none usable')
  return { ideas }
}

// ---- wave L (W1, L1-2 to L1-7) ----------------------------------------------------------------------------
//
// The same rules for every new answer: only zod-checked fields are read, arrays are looked at up to a bound
// and clamped to the contract's maxima, text is cleaned and cut, and ids come only from this call's aliases
// (one alias, one id; repeats dropped). What the server knows better than the model (vote tallies, the
// recap window, run ids) is never taken from the answer.

/** Ids looked at per answer line (a flood is cut here; each line keeps far fewer). */
const IDS_LOOKED_AT = 400
/** Diagram edges and scores looked at (their caps are above LOOK_AT). */
const EDGES_LOOKED_AT = 128
const SCORES_LOOKED_AT = 400

const aliasesOf = (sent: readonly SourceItem[]) => new Map(sent.map((i) => [i.alias, i.id]))

/** The ids of `raw` (an answer's alias list) that this call sent, in order, without repeats, at most `max`. */
function mapIds(raw: unknown, byAlias: ReadonlyMap<string, string>, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const a of raw.slice(0, IDS_LOOKED_AT)) {
    if (out.length >= max) break
    const id = byAlias.get(str(a).trim())
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

const line = (raw: unknown, max: number) => cleanText(strip(str(raw)), max, false)
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Whether `owner` appears verbatim, as a whole word or phrase, in one of the items sent (L1-2): an owner the
 * items never name is one the model made up, and it is dropped.
 */
export function ownerIsVerbatim(owner: string, sent: readonly SourceItem[]): boolean {
  if (!owner) return false
  const esc = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u')
  return sent.some((i) => re.test(i.text))
}

const RecapAnswer = z.object({
  title: z.unknown(),
  summary: z.unknown(),
  decisions: z.array(z.unknown()),
  actions: z.array(z.unknown()),
  questions: z.array(z.unknown()),
})

export interface RecapLines {
  title: string
  summary: string
  decisions: AiRecapLine[]
  actions: AiRecapAction[]
  questions: AiRecapLine[]
}

/** A recap's lines (L1-2). topVoted and windowFrom are the server's, added by the caller. */
export function recapPlan(json: unknown, sent: readonly SourceItem[]): RecapLines {
  const r = RecapAnswer.safeParse(json)
  if (!r.success) throw new BadOutput('recap: wrong shape')
  const byAlias = aliasesOf(sent)
  const summary = cleanText(strip(str(r.data.summary)), AI_RECAP_SUMMARY_MAX_CHARS)
  if (!summary) throw new BadOutput('recap: empty')
  const lines = (raw: readonly unknown[], max: number, field: 'text' | 'task') => {
    const out: { text: string; ids: string[]; owner: unknown }[] = []
    const seen = new Set<string>()
    for (const entry of raw.slice(0, LOOK_AT)) {
      if (out.length >= max) break
      if (!isObj(entry)) continue
      const text = line(entry[field], AI_RECAP_LINE_MAX_CHARS)
      if (!text || seen.has(key(text))) continue
      seen.add(key(text))
      out.push({ text, ids: mapIds(entry.ids, byAlias, AI_RECAP_LINE_MAX_IDS), owner: entry.owner })
    }
    return out
  }
  const ownerOf = (raw: unknown): string | null => {
    const o = cleanText(str(raw), AI_OWNER_MAX_CHARS, false)
    return o && key(o) !== 'null' && ownerIsVerbatim(o, sent) ? o : null
  }
  return {
    title: line(r.data.title, AI_RECAP_TITLE_MAX_CHARS) || 'Recap',
    summary,
    decisions: lines(r.data.decisions, AI_RECAP_DECISIONS_MAX, 'text').map(({ text, ids }) => ({
      text,
      ids,
    })),
    actions: lines(r.data.actions, AI_RECAP_ACTIONS_MAX, 'task').map(({ text, ids, owner }) => ({
      task: text,
      owner: ownerOf(owner),
      ids,
    })),
    questions: lines(r.data.questions, AI_RECAP_QUESTIONS_MAX, 'text').map(({ text, ids }) => ({
      text,
      ids,
    })),
  }
}

const AskAnswer = z.object({
  answer: z.string(),
  found: z.enum(['yes', 'partial', 'no']),
  citations: z.array(z.unknown()),
})
/** `[n]` or `[n, m]`, with the space before it (which goes with a stripped marker). */
const MARKER = /(\s?)\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g

/**
 * A grounded answer (L1-3): citations map from this call's aliases only (at most AI_CITATIONS_MAX, each at
 * most AI_CITATION_MAX_IDS ids); a citation left with no id is dropped, the ones kept are renumbered, and
 * every [n] in the answer then points at a kept citation or is removed. `found` passes through.
 */
export function askPlan(
  json: unknown,
  sent: readonly SourceItem[],
): { answer: string; found: 'yes' | 'partial' | 'no'; citations: AiCitation[] } {
  const r = AskAnswer.safeParse(json)
  if (!r.success) throw new BadOutput('ask: wrong shape')
  const byAlias = aliasesOf(sent)
  const citations: AiCitation[] = []
  /** The model's citation number (from 1) → ours. */
  const renumber = new Map<number, number>()
  for (const [i, raw] of r.data.citations.slice(0, LOOK_AT).entries()) {
    if (citations.length >= AI_CITATIONS_MAX) break
    const ids = isObj(raw) ? mapIds(raw.ids, byAlias, AI_CITATION_MAX_IDS) : []
    if (!ids.length) continue
    citations.push({ ids })
    renumber.set(i + 1, citations.length)
  }
  const marked = r.data.answer.replace(MARKER, (_m, space: string, list: string) => {
    const kept = [
      ...new Set(
        list
          .split(',')
          .map((n) => renumber.get(Number(n.trim())))
          .filter((n): n is number => n !== undefined),
      ),
    ]
    return kept.length ? `${space}[${kept.join(', ')}]` : ''
  })
  const answer = cleanText(strip(marked), AI_ANSWER_MAX_CHARS)
  if (!answer && r.data.found !== 'no') throw new BadOutput('ask: empty')
  return { answer, found: r.data.found, citations }
}

const CommandAnswer = z.object({ ops: z.array(z.unknown()), explain: z.unknown() })
const FIND_OPS: ReadonlySet<string> = new Set(AI_COMMAND_FIND_OPS)
const OP_NAMES: ReadonlySet<string> = new Set(AI_COMMAND_OP_NAMES)

/**
 * A plain-language command's ops (L1-4): only the closed AiCommandOp set (an op outside it, a delete or an
 * unlock, is dropped), ids from this call's aliases only (at most AI_COMMAND_MAX_IDS_PER_OP per op), at
 * most AI_COMMAND_MAX_OPS ops; in 'find' mode only select and zoomTo. A tag must be a valid tag name.
 */
export function commandPlan(
  json: unknown,
  sent: readonly SourceItem[],
  mode: 'find' | 'do',
): { mode: 'find' | 'do'; ops: AiCommandOp[]; explain: string } {
  const r = CommandAnswer.safeParse(json)
  if (!r.success) throw new BadOutput('command: wrong shape')
  const byAlias = aliasesOf(sent)
  const ops: AiCommandOp[] = []
  for (const raw of r.data.ops.slice(0, LOOK_AT)) {
    if (ops.length >= AI_COMMAND_MAX_OPS) break
    if (!isObj(raw)) continue
    const op = str(raw.op)
    if (!OP_NAMES.has(op) || (mode === 'find' && !FIND_OPS.has(op))) continue
    const ids = mapIds(raw.ids, byAlias, AI_COMMAND_MAX_IDS_PER_OP)
    if (!ids.length) continue
    const candidate: Record<string, unknown> = { op, ids }
    switch (op) {
      case 'recolor':
        candidate.color = str(raw.color).trim()
        break
      case 'setFill':
        candidate.fill = str(raw.fill).trim()
        break
      case 'align':
        candidate.edge = str(raw.edge).trim()
        break
      case 'distribute':
        candidate.axis = str(raw.axis).trim()
        break
      case 'tag': {
        const tag = normalizeTagName(cleanText(str(raw.tag), 64, false))
        if (tagNameError(tag) !== null) continue
        candidate.tag = tag
        break
      }
      case 'wrapInFrame':
        candidate.name = line(raw.name, AI_COMMAND_FRAME_NAME_MAX_CHARS)
        break
    }
    const parsed = AiCommandOp.safeParse(candidate)
    if (parsed.success) ops.push(parsed.data)
  }
  return { mode, ops, explain: line(r.data.explain, AI_COMMAND_EXPLAIN_MAX_CHARS) }
}

const DiagramAnswer = z.object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) })
const NODE_KINDS: ReadonlySet<string> = new Set(AI_DIAGRAM_NODE_KINDS)

/**
 * A diagram's graph (L1-5): at most AI_DIAGRAM_MAX_NODES nodes with cleaned labels, the model's node ids
 * remapped to n1, n2, … (a repeated id keeps its first node); at most AI_DIAGRAM_MAX_EDGES edges between
 * known nodes, no self-loops, no repeats of the same from and to. Fewer than two nodes is no diagram.
 */
export function diagramPlan(
  json: unknown,
  direction: 'down' | 'right',
): { direction: 'down' | 'right'; nodes: AiDiagramNode[]; edges: AiDiagramEdge[] } {
  const r = DiagramAnswer.safeParse(json)
  if (!r.success) throw new BadOutput('diagram: wrong shape')
  const ours = new Map<string, string>()
  const nodes: AiDiagramNode[] = []
  for (const raw of r.data.nodes.slice(0, LOOK_AT)) {
    if (nodes.length >= AI_DIAGRAM_MAX_NODES) break
    if (!isObj(raw)) continue
    const theirs = str(raw.id).trim()
    const label = line(raw.label, AI_DIAGRAM_LABEL_MAX_CHARS)
    if (!theirs || ours.has(theirs) || !label) continue
    const kind = NODE_KINDS.has(str(raw.kind)) ? (str(raw.kind) as AiDiagramNode['kind']) : 'process'
    const id = `n${nodes.length + 1}`
    ours.set(theirs, id)
    nodes.push({ id, label, kind })
  }
  if (nodes.length < 2) throw new BadOutput('diagram: fewer than two nodes')
  const edges: AiDiagramEdge[] = []
  const pairs = new Set<string>()
  for (const raw of r.data.edges.slice(0, EDGES_LOOKED_AT)) {
    if (edges.length >= AI_DIAGRAM_MAX_EDGES) break
    if (!isObj(raw)) continue
    const from = ours.get(str(raw.from).trim())
    const to = ours.get(str(raw.to).trim())
    if (!from || !to || from === to || pairs.has(`${from}>${to}`)) continue
    pairs.add(`${from}>${to}`)
    edges.push({ from, to, label: line(raw.label, AI_DIAGRAM_EDGE_LABEL_MAX_CHARS) })
  }
  return { direction, nodes, edges }
}

/** Sort by a lens (L1-6): the themes' rules exactly (AI_THEMES_MAX, 'Other', each note once). */
export function sortPlan(json: unknown, sent: readonly SourceItem[]): { themes: AiTheme[] } {
  try {
    return themesPlan(json, sent)
  } catch (e) {
    if (e instanceof BadOutput) throw new BadOutput(`sort: ${e.message}`)
    throw e
  }
}

const ScoreAnswer = z.object({ scores: z.array(z.unknown()) })
const clampScore = (v: number) => Math.max(AI_SCORE_MIN, Math.min(AI_SCORE_MAX, Math.round(v))) + 0 // no -0

/**
 * 2x2 scores (L1-6): one entry per note sent, in the order sent; x and y whole numbers clamped to
 * AI_SCORE_MIN..AI_SCORE_MAX; a note the answer left out (or scored with something that is not a number)
 * is 0,0 with `unscored`. Aliases not sent are dropped; a note scored twice keeps its first score.
 */
export function scorePlan(json: unknown, sent: readonly SourceItem[]): { scores: AiScore[] } {
  const r = ScoreAnswer.safeParse(json)
  if (!r.success) throw new BadOutput('score: wrong shape')
  const byAlias = aliasesOf(sent)
  const got = new Map<string, { x: number; y: number }>()
  for (const raw of r.data.scores.slice(0, SCORES_LOOKED_AT)) {
    if (!isObj(raw)) continue
    const id = byAlias.get(str(raw.id).trim())
    const { x, y } = raw
    if (!id || got.has(id) || typeof x !== 'number' || typeof y !== 'number') continue
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    got.set(id, { x: clampScore(x), y: clampScore(y) })
  }
  if (!got.size) throw new BadOutput('score: no usable scores')
  return {
    scores: sent.map((i) => {
      const s = got.get(i.id)
      return s ? { id: i.id, x: s.x, y: s.y } : { id: i.id, x: 0, y: 0, unscored: true as const }
    }),
  }
}

const VotedAction = z.object({ task: z.unknown(), owner: z.unknown(), ids: z.unknown() })

/**
 * Vote-weighted action items (L1-7): today's actions rules, each item carrying `votes`, the most votes of
 * the items it names (the server's tallies, never the model's), and the list re-sorted by them, most first
 * (the model's order among equals).
 */
export function votedActionsPlan(
  json: unknown,
  sent: readonly SourceItem[],
  votes: ReadonlyMap<string, number>,
): { items: AiActionItem[] } {
  const r = Actions.safeParse(json)
  if (!r.success) throw new BadOutput('actions: wrong shape')
  const byAlias = aliasesOf(sent)
  const items: AiActionItem[] = []
  const seen = new Set<string>()
  for (const raw of r.data.items.slice(0, LOOK_AT)) {
    if (items.length >= AI_ACTION_ITEMS_MAX) break
    const a = VotedAction.safeParse(raw)
    if (!a.success) continue
    const text = cleanText(strip(str(a.data.task)), AI_ITEM_MAX_CHARS, false)
    if (!text || seen.has(key(text))) continue
    seen.add(key(text))
    const owner = cleanText(str(a.data.owner), AI_OWNER_MAX_CHARS, false)
    const cited = mapIds(a.data.ids, byAlias, IDS_LOOKED_AT)
    const n = cited.reduce((m, id) => Math.max(m, votes.get(id) ?? 0), 0)
    items.push({ text, owner: owner && key(owner) !== 'null' ? owner : null, votes: n })
  }
  // Array.prototype.sort is stable: equal votes keep the model's order.
  return { items: items.sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0)) }
}
