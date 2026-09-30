// What the workshops feature needs from a board page, on either engine: the tldraw page's FeatureContext
// (features/types.ts) and the Excalidraw page's CanvasFeatureContext (canvas/api/feature.ts) both have
// these members (the canvas itself is not here: `editor` on one page, `canvas` on the other). The
// engine-neutral hooks below take this type, so the shared UI (Hands.tsx, the stores) serves both pages
// until wave 4 (docs/EXCALIDRAW-CONTRACTS.md §1).

import type { Board, Me } from '@draftroom/contracts'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ApiClient } from '../../api/client.ts'
import type { NoticeInput } from '../../board/board-context.ts'
import { useUserKind } from '../../invite/guest.tsx'
import { type BoardRole, can } from '../../lib/permissions.ts'
import type { BoardEvents } from '../events.ts'
import { WorkshopStore, workshopStoreFor } from './store.ts'

export interface WorkshopContext {
  readonly board: Board
  /** the caller's current role (UI hints only: the servers enforce) */
  readonly role: BoardRole
  readonly me: Me
  readonly workspace: { readonly id: string; readonly name: string }
  readonly api: ApiClient
  readonly events: BoardEvents
  notify(n: NoticeInput): void
  dismiss(key: string): void
  openPanel(panelId: string | null): void
  readonly activePanel: string | null
}

export function storeFor(ctx: WorkshopContext): WorkshopStore {
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

export function useWorkshop(ctx: WorkshopContext) {
  const store = storeFor(ctx)
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { store, snap }
}

/** May take part by editing (write private notes): owners, editors and guest editors. */
export const canEditBoard = (ctx: Pick<WorkshopContext, 'role' | 'board'>) =>
  can(ctx.role, 'edit', ctx.board.status)

/**
 * Facilitator = an editor with an account (final review R3): runs the timer, votes, private
 * brainstorms and "Gather everyone", and lowers other people's hands. A name-only guest on a workshop
 * link takes part only. While the kind is still unknown an editor counts as one (a join seeds a
 * guest's kind before the board opens). UI hint only: the API enforces it.
 */
export function useIsFacilitator(ctx: Pick<WorkshopContext, 'role' | 'board'>): boolean {
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
