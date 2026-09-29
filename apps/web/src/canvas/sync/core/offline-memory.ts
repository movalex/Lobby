/**
 * The in-memory offline queue (docs/EXCALIDRAW-MIGRATION.md §2.5.6): Node (the headless client), guests
 * (no offline persistence) and tests. The browser's per-tab IndexedDB store with its Web Locks lock is
 * `../adapter/offline-idb.ts`.
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import type { OfflineEntry, OfflineQueueStore } from '../types.ts'

export function createMemoryOfflineStore(initial: readonly OfflineEntry[] = []): OfflineQueueStore & {
  entries(): readonly OfflineEntry[]
} {
  let entries: OfflineEntry[] = [...initial]
  return {
    load: async () => structuredClone(entries),
    save: async (next) => {
      entries = structuredClone([...next])
    },
    clear: async () => {
      entries = []
    },
    entries: () => entries,
  }
}
