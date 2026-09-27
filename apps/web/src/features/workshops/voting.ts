// Pure helpers for the voting UI: labels for results, CSV export, and the optimistic view of the
// caller's own ballot while casts are in flight. No editor, no DOM: unit-tested in Node.

import type { VoteResult, WorkshopVoteState } from '@draftroom/contracts'

const MAX_TEXT_NODES = 2_000

/** TipTap JSON -> plain text (paragraphs joined by spaces). Bounded; never throws. */
export function plainTextFromRichText(richText: unknown): string {
  const out: string[] = []
  let visited = 0
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 40 || visited++ > MAX_TEXT_NODES) return
    const n = node as { type?: unknown; text?: unknown; content?: unknown }
    if (typeof n.text === 'string') out.push(n.text)
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child, depth + 1)
      if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') out.push(' ')
    }
  }
  walk(richText, 0)
  return out.join('').replace(/\s+/g, ' ').trim()
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
