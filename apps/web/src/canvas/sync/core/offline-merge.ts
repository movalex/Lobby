/**
 * Merging offline queues (docs/EXCALIDRAW-MIGRATION.md §2.5.6): a tab that loads its own queue and adopts
 * the queues closed tabs left (adapter/offline-idb.ts) keeps one entry per element. Pure, so the merge is
 * tested in Node.
 *
 *  - element entries of the same id: the dirty groups and the lost pushes of both, the earliest time, and
 *    the later queue's copy of the element (its own queue's over an adopted one);
 *  - the `#doc` entry (board-document writes, engine.ts DOC_ENTRY_ID): the keys of both, the later queue's
 *    value of a key both set, and the lost doc writes of both. Before, the `#doc` entries were merged as
 *    if they were one element, so one tab's pending tag definitions were dropped and its tagged element
 *    was then refused INVALID (V1 re-check, P16).
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import type { OfflineEntry } from '../types.ts'

/** The `#doc` pseudo-element's id (engine.ts DOC_ENTRY_ID; repeated here so this module stays a leaf). */
const DOC_ID = '#doc'

/** Merges queues given oldest first (adopted ones, then this tab's own): later entries win their element. */
export function mergeOfflineQueues(queues: readonly (readonly OfflineEntry[])[]): OfflineEntry[] {
  const byId = new Map<string, OfflineEntry>()
  for (const queue of queues)
    for (const e of queue) {
      const prev = byId.get(e.element.id)
      if (!prev) {
        byId.set(e.element.id, e)
        continue
      }
      if (e.element.id === DOC_ID) {
        const set = {
          ...((prev.element as unknown as { set?: Record<string, unknown> }).set ?? {}),
          ...((e.element as unknown as { set?: Record<string, unknown> }).set ?? {}),
        }
        const lostDoc = [...(prev.lostDoc ?? []), ...(e.lostDoc ?? [])]
        byId.set(DOC_ID, {
          ...e,
          element: { ...e.element, set } as unknown as OfflineEntry['element'],
          queuedAt: Math.min(prev.queuedAt, e.queuedAt),
          ...(lostDoc.length ? { lostDoc } : {}),
        })
        continue
      }
      const lost = [...(prev.lost ?? []), ...(e.lost ?? [])]
      byId.set(e.element.id, {
        ...e,
        groups: [...new Set([...prev.groups, ...e.groups])],
        queuedAt: Math.min(prev.queuedAt, e.queuedAt),
        ...(lost.length ? { lost } : {}),
      })
    }
  return [...byId.values()]
}
