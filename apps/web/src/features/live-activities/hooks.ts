// OWNER: WS2 (wave V, V1). The live activity store of a board page, and the React readers of it.
import { useSyncExternalStore } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { useValue } from '../../lib/signals.ts'
import { liveEnabled } from '../live/flags.ts'
import { canEditBoard } from '../workshops/workshop-context.ts'
import { ActivityStore, activityStoreOn } from './store.ts'

type Ctx = Pick<CanvasFeatureContext, 'board' | 'api' | 'events' | 'me'>

/** This board page's store (one per event stream), made on first use. */
export function activityStoreFor(ctx: Ctx): ActivityStore {
  return activityStoreOn(
    ctx.events,
    () =>
      new ActivityStore({
        boardId: ctx.board.id,
        request: ctx.api.request,
        events: ctx.events,
        userId: ctx.me.user.id,
      }),
  )
}

export function useActivity(ctx: Ctx) {
  const store = activityStoreFor(ctx)
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { store, snap }
}

/** The web switch and the api's (features/live): asked when drawn, redrawn when the api's answer arrives. */
export const liveActivitiesOn = () => liveEnabled('activities')
export const useLiveActivitiesOn = () => useValue('lobby-live-activities-on', liveActivitiesOn, [])

/**
 * May start and run one (UI hint: the api decides): an editor with an account, as for votes and brainstorms (a
 * name-only guest takes part only).
 */
export const mayFacilitate = (ctx: Pick<CanvasFeatureContext, 'role' | 'board' | 'me'>) =>
  canEditBoard(ctx) && knownUserKind(ctx.me.user.id) !== 'guest'

/** May answer: anyone who sees an ACTIVE board (viewers and guests too; the api decides). */
export const mayParticipate = (ctx: Pick<CanvasFeatureContext, 'board'>) => ctx.board.status === 'active'
