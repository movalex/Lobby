import { useSyncExternalStore } from 'react'
import type { FeatureContext } from '../../types.ts'
import { PrivateNotesStore, privateNotesStoreFor } from './store.ts'

export function privateStoreFor(ctx: FeatureContext): PrivateNotesStore {
  return privateNotesStoreFor(
    ctx.events,
    () => new PrivateNotesStore({ boardId: ctx.board.id, request: ctx.api.request, events: ctx.events }),
  )
}

export function usePrivateNotes(ctx: FeatureContext) {
  const store = privateStoreFor(ctx)
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { store, snap }
}

/** "7 notes from 4 people" (what everyone sees while people write). */
export function describeCounts(c: { notes: number; people: number }): string {
  if (c.notes === 0) return 'No notes yet'
  const notes = `${c.notes} note${c.notes === 1 ? '' : 's'}`
  return `${notes} from ${c.people} ${c.people === 1 ? 'person' : 'people'}`
}

/** The dock panel's id (FeaturePanel.id). */
export const PRIVATE_PANEL_ID = 'private-notes'
