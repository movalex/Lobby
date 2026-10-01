// Pure helpers for the voting UI: labels for results, CSV export, and the optimistic view of the
// caller's own ballot while casts are in flight. No editor, no DOM: unit-tested in Node.

import type { VoteResult, WorkshopVoteState } from '@draftroom/contracts'

const MAX_TEXT_NODES = 2_000
/** Rich-text nodes that end a line. */
const LINE_ENDS = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'])
/** Between the lines of a multi-line note in one-line labels and the CSV (round-2 F17). */
export const LINE_SEPARATOR = ' · '

/**
 * TipTap JSON -> one line of plain text: the note's lines joined by " · " ("Book review slots ·
 * Owner: producer"), empty lines dropped. Bounded; never throws.
 */
export function plainTextFromRichText(richText: unknown): string {
  const lines: string[] = []
  let line = ''
  let visited = 0
  const endLine = () => {
    lines.push(line)
    line = ''
  }
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 40 || visited++ > MAX_TEXT_NODES) return
    const n = node as { type?: unknown; text?: unknown; content?: unknown }
    if (typeof n.text === 'string') line += n.text
    if (n.type === 'hardBreak') endLine()
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child, depth + 1)
      if (typeof n.type === 'string' && LINE_ENDS.has(n.type)) endLine()
    }
  }
  walk(richText, 0)
  endLine()
  return lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(LINE_SEPARATOR)
}

const TYPE_NAMES: Record<string, string> = {
  note: 'Sticky note',
  text: 'Text',
  geo: 'Shape',
  frame: 'Frame',
  image: 'Image',
  video: 'Video',
  embed: 'Embed',
  bookmark: 'Link',
  'dr-file-card': 'File',
}

export const typeName = (type: string) => TYPE_NAMES[type] ?? type

/** What to call a voted object in the results list. */
export function shapeLabel(shape: { type: string; props?: unknown } | undefined): string {
  if (!shape) return 'Deleted object'
  const props = (shape.props ?? {}) as Record<string, unknown>
  const text = 'richText' in props ? plainTextFromRichText(props.richText) : ''
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text
  if (typeof props.name === 'string' && props.name.trim()) return props.name.trim()
  if (typeof props.altText === 'string' && props.altText.trim()) return props.altText.trim()
  return `Untitled ${typeName(shape.type).toLowerCase()}`
}

/**
 * "1 of 3 done · 6 votes cast" for the facilitator; before anyone joined or voted, "Waiting for
 * votes" rather than "0 of 0 done · 0 votes cast" (round-2 F17).
 */
export function describeProgress(v: {
  participants: number
  participantsDone: number
  totalVotesCast: number
}): string {
  if (v.participants === 0 && v.totalVotesCast === 0) return 'Waiting for votes'
  const votes = `${v.totalVotesCast} vote${v.totalVotesCast === 1 ? '' : 's'} cast`
  return `${v.participantsDone} of ${v.participants} done · ${votes}`
}

// ---- result badges on the board (round-2 F3) ----------------------------------------------------------

/** A result badge at a shape's top-right corner, in screen pixels. */
export interface BadgePlacement {
  shapeId: string
  x: number
  y: number
  rank: number
  /** Votes. */
  n: number
}

/** Badges that would overlap on screen, shown as one. */
export interface BadgeGroup {
  /** Where the best-ranked member's badge sits. */
  x: number
  y: number
  best: number
  votes: number
  /** Best rank first. */
  members: BadgePlacement[]
}

/** Badge size relative to full: full at 100% zoom and closer, shrinking with the zoom down to 60%. */
export function badgeScale(zoom: number): number {
  return Math.min(1, Math.max(0.6, zoom))
}

/** How close two badge corners may be (px at full size) before the badges overlap. */
const BADGE_SPAN = { x: 56, y: 32 }

/**
 * Groups badges that would overlap at `scale` (neighbours of neighbours included, so no two groups
 * overlap either). Zoomed in, every badge is its own group.
 */
export function clusterBadges(items: readonly BadgePlacement[], scale: number): BadgeGroup[] {
  const sorted = [...items].sort(
    (a, b) => a.rank - b.rank || b.n - a.n || (a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0),
  )
  const parent = sorted.map((_, i) => i)
  const root = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r] as number
    parent[i] = r
    return r
  }
  const dx = BADGE_SPAN.x * scale
  const dy = BADGE_SPAN.y * scale
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i] as BadgePlacement
      const b = sorted[j] as BadgePlacement
      if (Math.abs(a.x - b.x) < dx && Math.abs(a.y - b.y) < dy) {
        const [ra, rb] = [root(i), root(j)]
        // The better-ranked badge (the lower index) stays the root.
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
      }
    }
  }
  const groups = new Map<number, BadgeGroup>()
  sorted.forEach((b, i) => {
    const r = root(i)
    const g = groups.get(r)
    if (g) {
      g.members.push(b)
      g.votes += b.n
    } else groups.set(r, { x: b.x, y: b.y, best: b.rank, votes: b.n, members: [b] })
  })
  return [...groups.values()]
}

/** The top of the ranking (ties at the cut-off are included, so nobody sharing 3rd place is hidden). */
export function topResults(results: readonly VoteResult[], n = 3): VoteResult[] {
  const cut = results[n - 1]
  if (!cut) return [...results]
  return results.filter((r, i) => i < n || r.rank <= cut.rank)
}

/** RFC 4180 cell, with spreadsheet formula neutralization (cells starting with = + - @ tab CR). */
export function csvCell(value: string | number): string {
  let s = String(value)
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function resultsCsv(
  results: readonly VoteResult[],
  describe: (shapeId: string) => { type: string; label: string },
): string {
  const lines = [['Rank', 'Votes', 'Object type', 'Text', 'Object id'].join(',')]
  for (const r of results) {
    const d = describe(r.shapeId)
    lines.push([r.rank, r.count, csvCell(d.type), csvCell(d.label), csvCell(r.shapeId)].join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

export interface PendingCast {
  shapeId: string
  delta: 1 | -1
}

/** The caller's ballot as the UI should show it: server state plus casts still in flight. */
export function optimisticBallot(
  vote: Pick<WorkshopVoteState, 'myVotes' | 'myRemaining'>,
  pending: readonly PendingCast[],
): { myVotes: Record<string, number>; myRemaining: number } {
  const myVotes = { ...vote.myVotes }
  let remaining = vote.myRemaining
  for (const p of pending) {
    const cur = myVotes[p.shapeId] ?? 0
    const next = Math.max(0, cur + p.delta)
    remaining -= next - cur
    if (next === 0) delete myVotes[p.shapeId]
    else myVotes[p.shapeId] = next
  }
  return { myVotes, myRemaining: Math.max(0, remaining) }
}

/**
 * What a plain click while voting does (W5-03). The topmost object under the pointer (the one a click
 * would select) decides: the vote takes it, so it gets the vote; or the vote does not take it, so nothing
 * is cast, even when an object the vote takes lies hidden under it (a click never votes for something the
 * person cannot see); or there is nothing there.
 */
export type VoteClick<T> = { kind: 'vote'; target: T } | { kind: 'not-in-vote'; target: T } | { kind: 'none' }

export function voteClick<T>(top: T | null | undefined, inVote: (target: T) => boolean): VoteClick<T> {
  if (top === null || top === undefined) return { kind: 'none' }
  return inVote(top) ? { kind: 'vote', target: top } : { kind: 'not-in-vote', target: top }
}

/**
 * The notice for a click on an object the open vote does not take (W5-03): "Not part of this vote: only
 * sticky notes in “Ideas” take votes." `frameName` names the vote's frame (frame scope).
 */
export function notInVoteText(
  rule: { scope: 'board' | 'frame'; shapeTypes: readonly string[] | null },
  frameName: string | null,
): string {
  const notesOnly = rule.shapeTypes?.length === 1 && rule.shapeTypes[0] === 'note'
  const where = rule.scope === 'frame' ? ` in “${frameName?.trim() || 'the frame'}”` : ''
  if (!notesOnly && !where) return 'Not part of this vote.'
  return `Not part of this vote: only ${notesOnly ? 'sticky notes' : 'objects'}${where} take votes.`
}

/**
 * Whether a +1/-1 can be offered locally (the server decides; this avoids sending requests that are
 * certain to fail, like a 6th vote of 5 or a second dot where one per object is allowed).
 */
export function localCastCheck(
  ballot: { myVotes: Record<string, number>; myRemaining: number },
  shapeId: string,
  delta: 1 | -1,
  onePerObject: boolean,
): { ok: true } | { ok: false; reason: string } {
  const cur = ballot.myVotes[shapeId] ?? 0
  if (delta === -1) return cur > 0 ? { ok: true } : { ok: false, reason: "You haven't voted on that." }
  if (ballot.myRemaining <= 0) return { ok: false, reason: "You've used all your votes." }
  if (onePerObject && cur >= 1) return { ok: false, reason: 'One vote per object in this vote.' }
  return { ok: true }
}

export interface ReadingItem {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * Objects in reading order (rows top to bottom, each row left to right), for stepping through the
 * objects of a vote with the keyboard. Objects whose vertical middles are within half the shorter
 * one's height of each other share a row.
 */
export function readingOrder<T extends ReadingItem>(items: readonly T[]): T[] {
  const byTop = [...items].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x)
  const rows: T[][] = []
  for (const item of byTop) {
    const mid = item.y + item.h / 2
    const row = rows[rows.length - 1]
    const ref = row?.[0]
    if (row && ref && Math.abs(ref.y + ref.h / 2 - mid) <= Math.min(ref.h, item.h) / 2) row.push(item)
    else rows.push([item])
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id)))
}
