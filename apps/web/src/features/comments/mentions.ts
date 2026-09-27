// Composer-side @mention logic (pure; unit-tested in Node). The textarea shows readable "@Name" text;
// the people picked from the autocomplete are kept alongside and turned into `@[Name](usr_…)` tokens
// only when the comment is sent. Editing the "@Name" text away drops the mention.

import { mentionTokenFor, parseMentionTokens } from '@draftroom/contracts'

export interface PickedMention {
  userId: string
  name: string
}

export interface Draft {
  text: string
  mentions: PickedMention[]
}

export const EMPTY_DRAFT: Draft = { text: '', mentions: [] }

export interface Mentionable {
  userId: string
  name: string
  handle: string | null
}

/** Stored comment body -> editable text + picked mentions (for editing an existing comment). */
export function draftFromBody(body: string, mentioned: readonly string[]): Draft {
  const tokens = parseMentionTokens(body)
  const mentions: PickedMention[] = []
  let text = ''
  let at = 0
  for (const t of tokens) {
    text += body.slice(at, t.index)
    text += `@${t.name}`
    if (mentioned.includes(t.userId) && !mentions.some((m) => m.userId === t.userId))
      mentions.push({ userId: t.userId, name: t.name })
    at = t.index + t.length
  }
  text += body.slice(at)
  return { text, mentions }
}

const isBoundaryBefore = (ch: string | undefined) => ch === undefined || /[\s([{"'.,;:!?]/.test(ch)
const isBoundaryAfter = (ch: string | undefined) => ch === undefined || !/[\p{L}\p{N}_]/u.test(ch)

/**
 * Editable text -> comment body: every "@Name" of a picked person (at a word boundary) becomes their
 * mention token. Longer names are matched first so "@Ann Lee" wins over "@Ann".
 */
export function bodyFromDraft(draft: Draft): string {
  const picked = [...draft.mentions].sort((a, b) => b.name.length - a.name.length)
  if (picked.length === 0) return draft.text
  const { text } = draft
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '@' && isBoundaryBefore(text[i - 1])) {
      const hit = picked.find(
        (m) => text.startsWith(m.name, i + 1) && isBoundaryAfter(text[i + 1 + m.name.length]),
      )
      if (hit) {
        out += mentionTokenFor(hit.name, hit.userId)
        i += 1 + hit.name.length
        continue
      }
    }
    out += text[i]
    i++
  }
  return out
}

export interface MentionQuery {
  /** Index of the "@" in the text. */
  start: number
  query: string
}

const MAX_QUERY = 40

/**
 * The @-query being typed at the caret, if any: an "@" at a word start followed by at most two words
 * (names have spaces) and no newline. A query that is exactly an already-picked name is a finished
 * mention, not a query (so Enter posts instead of re-picking it).
 */
export function activeMentionQuery(
  text: string,
  caret: number,
  picked: readonly PickedMention[] = [],
): MentionQuery | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0 || !isBoundaryBefore(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.length > MAX_QUERY || /[\n@[\]()]/.test(query) || /^\s/.test(query)) return null
  // A trailing space ends the query (and keeps a just-picked "@Name " from reopening the list).
  if (/\s$/.test(query) || (query.match(/\s+/g) ?? []).length > 2) return null
  if (picked.some((m) => m.name === query)) return null
  return { start: at, query }
}

const norm = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

/** People matching the query: name/handle prefix and word-start matches first, then substrings. */
export function matchMentionables(
  people: readonly Mentionable[],
  query: string,
  opts: { limit?: number; meId?: string } = {},
): Mentionable[] {
  const q = norm(query.trim())
  const scored: { p: Mentionable; score: number }[] = []
  for (const p of people) {
    const name = norm(p.name)
    const handle = norm(p.handle ?? '')
    let score = -1
    if (!q) score = 1
    else if (name.startsWith(q) || handle.startsWith(q)) score = 3
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 2
    else if (name.includes(q) || handle.includes(q)) score = 1
    if (score < 0) continue
    // Yourself last (mentioning yourself is allowed, as a reminder).
    if (p.userId === opts.meId) score -= 0.5
    scored.push({ p, score })
  }
  scored.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
  return scored.slice(0, opts.limit ?? 8).map((s) => s.p)
}

/** Replaces the active "@query" with "@Name " and records the pick. Returns the new caret too. */
export function applyMention(draft: Draft, q: MentionQuery, caret: number, person: Mentionable) {
  const insert = `@${person.name} `
  const text = draft.text.slice(0, q.start) + insert + draft.text.slice(caret)
  const mentions = draft.mentions.some((m) => m.userId === person.userId)
    ? draft.mentions
    : [...draft.mentions, { userId: person.userId, name: person.name }]
  return { draft: { text, mentions }, caret: q.start + insert.length }
}

/** Mentions whose "@Name" text is still present (so a draft does not keep stale picks forever). */
export function pruneMentions(draft: Draft): Draft {
  const mentions = draft.mentions.filter((m) => draft.text.includes(`@${m.name}`))
  return mentions.length === draft.mentions.length ? draft : { ...draft, mentions }
}

export type BodySegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; userId: string; name: string; me: boolean }

/**
 * A stored body split for rendering: tokens of people the comment actually mentioned become chips;
 * anything else renders as its plain "@Name" text.
 */
export function bodySegments(body: string, mentioned: readonly string[], meId: string): BodySegment[] {
  const out: BodySegment[] = []
  let at = 0
  const push = (text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last?.kind === 'text') last.text += text
    else out.push({ kind: 'text', text })
  }
  for (const t of parseMentionTokens(body)) {
    push(body.slice(at, t.index))
    if (mentioned.includes(t.userId))
      out.push({ kind: 'mention', userId: t.userId, name: t.name, me: t.userId === meId })
    else push(`@${t.name}`)
    at = t.index + t.length
  }
  push(body.slice(at))
  return out
}
