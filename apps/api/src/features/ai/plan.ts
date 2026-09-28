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
  AI_IDEAS_MAX,
  AI_ITEM_MAX_CHARS,
  AI_OTHER_THEME,
  AI_OWNER_MAX_CHARS,
  AI_SUMMARY_MAX_CHARS,
  AI_THEME_NAME_MAX_CHARS,
  AI_THEMES_MAX,
  type AiActionItem,
  type AiTheme,
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
