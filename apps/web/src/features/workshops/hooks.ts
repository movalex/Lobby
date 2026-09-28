import type { VoteShapeInfo } from '@draftroom/contracts'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { useUserKind } from '../../invite/guest.tsx'
import { can } from '../../lib/permissions.ts'
import type { FeatureContext } from '../types.ts'
import { WorkshopStore, workshopStoreFor } from './store.ts'

export function storeFor(ctx: FeatureContext): WorkshopStore {
  return workshopStoreFor(
    ctx.events,
    () =>
      new WorkshopStore({
        boardId: ctx.board.id,
        userId: ctx.me.user.id,
        request: ctx.api.request,
        events: ctx.events,
      }),
  )
}

export function useWorkshop(ctx: FeatureContext) {
  const store = storeFor(ctx)
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { store, snap }
}

/** May take part by editing (write private notes): owners, editors and guest editors. */
export const canEditBoard = (ctx: FeatureContext) => can(ctx.role, 'edit', ctx.board.status)

/**
 * Facilitator = an editor with an account (final review R3): runs the timer, votes, private
 * brainstorms and "Gather everyone", and lowers other people's hands. A name-only guest on a workshop
 * link takes part only. While the kind is still unknown an editor counts as one (a join seeds a
 * guest's kind before the board opens). UI hint only: the API enforces it.
 */
export function useIsFacilitator(ctx: FeatureContext): boolean {
  const kind = useUserKind()
  return canEditBoard(ctx) && kind !== 'guest'
}

/**
 * Re-renders every `intervalMs` while `active`, returning Date.now(). Callers compute what to show
 * from the server's timestamps on every render, so a late or skipped tick cannot drift the clock.
 */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    const onVisible = () => setNow(Date.now())
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, intervalMs])
  return active ? now : Date.now()
}

/** Shape lookup for the shared eligibility rule (packages/contracts isVoteEligible). */
export function editorLookup(editor: Editor): (id: string) => VoteShapeInfo | undefined {
  return (id) => {
    const s = editor.getShape(id as TLShapeId)
    return s ? { id: s.id, type: s.type, parentId: s.parentId } : undefined
  }
}
