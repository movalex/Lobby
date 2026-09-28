// Which local store changes can change the thumbnail. Pure: unit-tested in Node.

import type { TLRecord } from 'tldraw'
import { parseBoardStartView } from '../canvas-ux/board-start-view.ts'

/** Record types whose changes can change the picture. */
const CONTENT_TYPES: ReadonlySet<string> = new Set(['shape', 'binding', 'page', 'asset'])

export interface RecordsDiff {
  added: Record<string, TLRecord>
  updated: Record<string, [from: TLRecord, to: TLRecord]>
  removed: Record<string, TLRecord>
}

const startViewKey = (r: TLRecord) =>
  r.typeName === 'document' ? JSON.stringify(parseBoardStartView(r.meta)) : ''

/**
 * Shapes, bindings, pages, assets, or the board's start view (in the document record). Not the user
 * record tldraw writes when a board opens, and not other document settings (session settings).
 */
export function changesContent(changes: RecordsDiff): boolean {
  for (const r of Object.values(changes.added)) if (CONTENT_TYPES.has(r.typeName)) return true
  for (const r of Object.values(changes.removed)) if (CONTENT_TYPES.has(r.typeName)) return true
  for (const [from, to] of Object.values(changes.updated)) {
    if (CONTENT_TYPES.has(to.typeName)) return true
    if (to.typeName === 'document' && startViewKey(from) !== startViewKey(to)) return true
  }
  return false
}
