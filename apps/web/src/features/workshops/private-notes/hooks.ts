import { useSyncExternalStore } from 'react'
import type { FeatureContext } from '../../types.ts'
import { PrivateNotesStore, privateNotesStoreFor } from './store.ts'

export function privateStoreFor(ctx: FeatureContext): PrivateNotesStore {
  return privateNotesStoreFor(
    ctx.events,
    () =>
      new PrivateNotesStore({
        boardId: ctx.board.id,
        request: ctx.api.request,
        events: ctx.events,
        userId: ctx.me.user.id,
      }),
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

/**
 * The top-bar chip's words (round-2 F17): "3 notes from 2 people", never "3 from 2". Someone who can
 * write and has not yet (`invite`) reads "Add your notes", never "Waiting for notes", which sounds
 * like they wait for someone else (final review R4); the facilitator keeps the counts.
 */
export function chipCounts(status: string, c: { notes: number; people: number }, invite = false): string {
  if (status === 'revealed') return 'Revealing…'
  if (invite && status === 'open') return 'Add your notes'
  return c.notes === 0 ? 'Waiting for notes' : describeCounts(c)
}

/** The dock panel's id (FeaturePanel.id). */
export const PRIVATE_PANEL_ID = 'private-notes'
