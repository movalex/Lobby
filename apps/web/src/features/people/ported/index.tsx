// OWNER: 3c (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'people' feature on the Excalidraw board page
// (the tldraw page's ../index.tsx; docs/WAVE4-CONTRACTS.md "present-live": the people list; checklist
// WRK-02, FAC-01, FAC-07..10's per-person "Bring to me"): the top-bar item `people` (the board page's own
// avatar list steps aside for it, canvas/board/chrome.tsx `featureHasPeople`), and the overlay that names
// whom you follow.
//
// Following is the canvas's (`canvas.follow`, canvas/api/parts/follow.ts): on the tldraw page tldraw drew
// the coloured frame around a follower's canvas and its own "Stop following" button; here this overlay
// draws both.

import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { CanvasFeature, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { PersonName } from '../../workshops/Hands.tsx'
import { usePresenting } from '../../workshops/presenting.ts'
import { WorkshopStore, workshopStoreFor } from '../../workshops/store.ts'
import { PeopleTopBar } from './PeopleBar.tsx'
import '../people.css'
import './people-ported.css'

function useSummoned(ctx: CanvasFeatureContext): boolean {
  const store = workshopStoreFor(
    ctx.events,
    () =>
      new WorkshopStore({
        boardId: ctx.board.id,
        userId: ctx.me.user.id,
        request: ctx.api.request,
        events: ctx.events,
      }),
  )
  const snap = useSyncSnapshot(store)
  return !!snap.summonedBy
}

function useSyncSnapshot(store: WorkshopStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** Space between the "is presenting" invitation and the label under it (px). */
const BELOW_INVITE_GAP = 8

/**
 * Where the label goes while present-live's "is presenting" invitation shows (W5-23): its top just below
 * the invitation (px from the top of the canvas region, where both overlay layers start), else null (the
 * label's own place at the top). Read from the invitation's layout box, so its slide-in does not count;
 * kept current while it appears, goes, wraps or the canvas is resized.
 */
function useBelowInvite(ctx: CanvasFeatureContext, active: boolean): number | null {
  const { canvas } = ctx
  const [top, setTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!active) {
      setTop(null)
      return
    }
    const root = canvas.container()
    if (!root) return
    // present-live's invitation layer (canvas/board/chrome.tsx FeatureLayer), else the whole region
    const scope = root.querySelector('[data-lobby-overlay="present-live.invite"]') ?? root
    let sized: ResizeObserver | null = null
    let watched: HTMLElement | null = null
    const measure = () => {
      const invite = scope.querySelector<HTMLElement>('[data-testid="live-invite"]')
      if (invite !== watched) {
        sized?.disconnect()
        sized = null
        watched = invite
        if (invite) {
          sized = new ResizeObserver(measure)
          sized.observe(invite)
        }
      }
      setTop(invite ? Math.round(invite.offsetTop + invite.offsetHeight + BELOW_INVITE_GAP) : null)
    }
    const changes = new MutationObserver(measure)
    changes.observe(scope, { childList: true, subtree: true })
    const offResize = canvas.on('resize', measure)
    measure()
    return () => {
      changes.disconnect()
      sized?.disconnect()
      offResize()
    }
  }, [canvas, active])
  return top
}

/**
 * FAC-01: "Following Bob" in Bob's colour while your view follows someone (an avatar click, the people
 * list), with a frame in that colour around the canvas and "Stop following" (RETRO-11: the one way out on
 * screen). After "Gather everyone" the workshops notice says whom you follow, so the label is the "Stop
 * following" button alone (the tldraw page had its own button for it, which the notice points to; the
 * wave-3 integration). A presentation of this tab's own shows its own.
 *
 * W5-23: when someone starts presenting to everyone, the label moves under their invitation instead of
 * giving it the spot: a follower who stayed on after Gather is still following until they Join (present
 * mode then stops this follow), say Not now or stop. W5-51: "Stop following" is one flat button, never an
 * outlined button inside the coloured pill.
 */
function FollowingLabel({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const presenting = usePresenting()
  const summoned = useSummoned(ctx)
  const who = useValue('dr-people-following', () => {
    const sid = canvas.follow.current()
    if (!sid) return null
    const r = canvas.collaborators().find((x) => x.sid === sid)
    return r ? `${r.color}|${r.name}` : null
  }, [canvas])
  const shown = !!who && !presenting
  const belowInvite = useBelowInvite(ctx, shown)
  if (!who || !shown) return null
  const [color = '', ...rest] = who.split('|')
  const name = rest.join('|')
  return (
    <>
      <div className="dr-people-following-frame" aria-hidden="true" style={{ borderColor: color }} />
      <div
        className="dr-people-following dr-people-following--ported"
        data-testid="following-label"
        data-summoned={summoned ? 'true' : 'false'}
        data-below-invite={belowInvite !== null ? 'true' : undefined}
        style={{ background: color, ...(belowInvite !== null ? { top: belowInvite } : {}) }}
        role="status"
      >
        {summoned ? null : (
          <span className="dr-people-following__text">
            Following <PersonName name={name} className="dr-people-following__name" />
          </span>
        )}
        <button
          type="button"
          className="dr-people-following__stop"
          data-testid="following-stop"
          // the name is its text, "Stop following", as tldraw's one button (RETRO-11); the label beside it
          // names the person (the wave-3 integration)
          onClick={() => canvas.follow.stop()}
        >
          Stop following
        </button>
      </div>
    </>
  )
}

function PeopleItem({ ctx }: { ctx: CanvasFeatureContext }) {
  return <PeopleTopBar ctx={ctx} />
}

export const feature: CanvasFeature = {
  id: 'people',
  // where the board page's own list was: the first of the feature controls, in the bar on every width
  topBar: [{ id: 'people', order: 10, pinned: true, component: PeopleItem }],
  overlays: [
    { id: 'people.following', layer: 'screen', order: 40, pointer: 'none', component: FollowingLabel },
  ],
}
