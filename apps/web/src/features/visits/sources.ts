// OWNER: WS4 (wave N, N4-2). The two optional reads that sharpen "what changed since your last visit", each of which may
// be refused (a viewer, a name-only guest, an outsider on a link) and then simply adds nothing:
//  - the newest checkpoint made at or before the visit (the history list and one content read, ../history/api.ts), for
//    ./refine.ts;
//  - the names of the removed items ("Recently deleted", for editors with an account only: viewers see a count).
import type { HistoryApi } from '../history/api.ts'

/** The newest checkpoint made at or before `seenAt` (ms), by its server time; null when there is none. */
export function checkpointBefore(
  list: readonly { readonly id: string; readonly createdAt: string }[],
  seenAt: number,
): string | null {
  let best: { id: string; at: number } | null = null
  for (const c of list) {
    const at = Date.parse(c.createdAt)
    if (!Number.isFinite(at) || at > seenAt) continue
    if (!best || at > best.at) best = { id: c.id, at }
  }
  return best?.id ?? null
}

/**
 * The elements of the checkpoint before the visit, or null (no checkpoint, none readable, a refusal, an old-format
 * body). Two requests at most, and none when the history list is empty.
 */
export async function checkpointElementsBefore(
  api: Pick<HistoryApi, 'listCheckpoints' | 'checkpointContent'>,
  boardId: string,
  seenAt: number,
  signal?: AbortSignal,
): Promise<readonly unknown[] | null> {
  try {
    const id = checkpointBefore(await api.listCheckpoints(boardId, signal), seenAt)
    if (!id) return null
    const content = await api.checkpointContent(id, signal)
    return content.format === 'lobby-elements' && content.elements ? content.elements : null
  } catch {
    return null
  }
}

const TYPE_WORDS: Record<string, string> = {
  stickynote: 'Note',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  text: 'Text',
  arrow: 'Arrow',
  line: 'Line',
  freedraw: 'Drawing',
  image: 'Image',
  frame: 'Frame',
}

/** "Note “Ship it”" from a tombstone's type and what "Recently deleted" says it held. */
export function removedName(type: string, label: string): string {
  const word = TYPE_WORDS[type] ?? 'Object'
  const words = label.replace(/\s+/g, ' ').trim()
  const short = words.length > 40 ? `${words.slice(0, 39)}…` : words
  return short ? `${word} “${short}”` : word
}

/** What "Recently deleted" says of a removed item: its name, and the id of whoever deleted it (P-006). */
export interface DeletedInfo {
  readonly name: string
  readonly by: string
}

/** id → name and deleter for the removed items "Recently deleted" lists (its `shapeId` is `shape:<element id>`). */
export async function deletedNames(
  api: Pick<HistoryApi, 'listDeleted'>,
  boardId: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, DeletedInfo> | null> {
  try {
    const { entries } = await api.listDeleted(boardId, signal)
    const out = new Map<string, DeletedInfo>()
    for (const e of entries)
      out.set(e.shapeId.replace(/^shape:/, ''), { name: removedName(e.type, e.label), by: e.deletedBy.id })
    return out
  } catch {
    return null
  }
}
