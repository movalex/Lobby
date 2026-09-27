// Per-person comment preferences and drafts in localStorage (conveniences only: never identity or
// access). Storage can be missing or throw (private windows, blocked site data): every access is
// guarded and a failure just means "no stored value".

import type { Draft } from './mentions.ts'

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function read(storage: KeyValueStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(storage: KeyValueStorage | null, key: string, value: string | null) {
  try {
    if (value === null) storage?.removeItem(key)
    else storage?.setItem(key, value)
  } catch {
    // not persisted; the in-memory value still applies for this tab
  }
}

/** Shift+C: comment markers hidden on the canvas, for this person on this browser (all boards). */
export const pinsHiddenKey = (userId: string) => `draftroom:comments:pins-hidden:${userId}`
export const showResolvedKey = (userId: string) => `draftroom:comments:show-resolved:${userId}`
export const draftsKey = (boardId: string, userId: string) => `draftroom:comments:drafts:${boardId}:${userId}`

export function readFlag(storage: KeyValueStorage | null, key: string): boolean {
  return read(storage, key) === '1'
}

export function writeFlag(storage: KeyValueStorage | null, key: string, on: boolean) {
  write(storage, key, on ? '1' : null)
}

const MAX_DRAFTS = 50
const MAX_DRAFT_CHARS = 6_000

/** Drafts per thread id (or 'new' for an unsent new comment), newest last. */
export function readDrafts(storage: KeyValueStorage | null, key: string): Map<string, Draft> {
  const out = new Map<string, Draft>()
  const raw = read(storage, key)
  if (!raw) return out
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return out
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const d = value as { text?: unknown; mentions?: unknown }
      if (typeof d?.text !== 'string' || !d.text) continue
      const mentions = Array.isArray(d.mentions)
        ? d.mentions.filter(
            (m): m is { userId: string; name: string } =>
              typeof m?.userId === 'string' &&
              typeof m?.name === 'string' &&
              /^usr_[0-9A-Za-z]{10,40}$/.test(m.userId),
          )
        : []
      out.set(id, { text: d.text.slice(0, MAX_DRAFT_CHARS), mentions })
    }
  } catch {
    // corrupt value: start over
  }
  return out
}

export function writeDrafts(
  storage: KeyValueStorage | null,
  key: string,
  drafts: ReadonlyMap<string, Draft>,
) {
  const entries = [...drafts.entries()].filter(([, d]) => d.text.trim().length > 0).slice(-MAX_DRAFTS)
  write(storage, key, entries.length ? JSON.stringify(Object.fromEntries(entries)) : null)
}
