// OWNER: W5 (wave L, L5-2 spotlight). The spotlight on the board page: the rest of the board is dimmed around
// what a facilitator is talking about, for everyone, without taking anyone's camera (summon and present stay
// for a full takeover).
//  - `SpotlightLayer` (scene overlay): an SVG mask with a rounded cut-out of the objects' live union bounds plus
//    24 px, re-projected on every camera change and element move; a pulsing ring (still under reduced motion);
//    a bar with who is spotlighting and the buttons (Hide for me, End for everyone); the facilitator's
//    "N of M looking", computed here from the presence views; "The spotlit items were removed" when they are gone.
//  - `bringEveryone` eases the view to them once (not a follow);
//  - Esc dims it only for this person (the key is registered in ./index.tsx while a spotlight shows).
// Nothing is written to the board: the state is the api's (../store.ts), presence stays ephemeral.

import { useEffect, useId, useMemo, useRef } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { useMediaQuery } from '../../../ui/useMedia.ts'
import { announcerFor } from '../../a11y/ported/announcer.ts'
import { spotlightKey, type WorkshopStore } from '../store.ts'
import { storeFor, useWorkshop } from '../workshop-context.ts'
import { REDUCED_MOTION_QUERY } from './Reactions.tsx'
import {
  bringOnce,
  endedText,
  type LookingPeer,
  lookingCount,
  lookingText,
  type SpotlightShape,
  showScene,
  spotlightRefsOf,
  spotlightShape,
  spotlightText,
  startRefusedText,
  viewsIntersect,
} from './spotlight.ts'

type Ctx = CanvasFeatureContext

// ---- starting and ending it -------------------------------------------------------------------------------------

/** The most objects one spotlight takes, in words. */
const TOO_MANY = 'Select up to 200 objects to spotlight.'

/**
 * Spotlights these elements (a selection, a menu's target, a command's ids) for everyone, and eases everyone's
 * view to them once. Says what went wrong in a notice. Returns whether it started.
 */
export async function spotlightIds(ctx: Ctx, ids: readonly string[]): Promise<boolean> {
  const note = (text: string) =>
    ctx.notify({ key: 'spotlight', text, testId: 'spotlight-toast', timeoutMs: 4000 })
  const { refs, tooMany } = spotlightRefsOf(ctx.canvas, ids)
  if (tooMany) {
    note(TOO_MANY)
    return false
  }
  if (refs.length === 0) {
    note('Select something to spotlight first.')
    return false
  }
  const r = await storeFor(ctx).startSpotlight(refs, true)
  if (!r.ok) note(startRefusedText(r.code, r.error))
  return r.ok
}

/** Ends the board's spotlight for everyone (the starter, or an owner: the api decides). */
export async function endSpotlight(ctx: Ctx): Promise<boolean> {
  const r = await storeFor(ctx).endSpotlight()
  if (!r.ok)
    ctx.notify({
      key: 'spotlight',
      text: r.error ?? 'The spotlight could not be ended.',
      testId: 'spotlight-toast',
      timeoutMs: 4000,
    })
  return r.ok
}

/** Whether this person may end the board's current spotlight (UI hint: the api decides). */
export const mayEndSpotlight = (ctx: Pick<Ctx, 'me' | 'role'>, s: { by: { userId: string } } | null) =>
  !!s && (s.by.userId === ctx.me.user.id || ctx.role === 'owner')

// ---- the layer ----------------------------------------------------------------------------------------------------

/** What the layer draws, from the spotlight and where its objects are now. */
interface Placed {
  shape: SpotlightShape
  /** the objects are on screen (wholly or partly) */
  inView: boolean
}

function placementOf(ctx: Ctx, refs: readonly string[]): Placed {
  const shape = spotlightShape(ctx.canvas, refs)
  const v = ctx.canvas.viewport.get()
  const inView =
    !!shape.scene && viewsIntersect({ x: v.x, y: v.y, width: v.width, height: v.height }, shape.scene)
  return { shape, inView }
}

/** `workshops-spotlight` (scene overlay). */
export function SpotlightLayer({ ctx }: { ctx: Ctx }) {
  const { store, snap } = useWorkshop(ctx)
  const s = snap.spotlight
  const me = ctx.me.user.id
  const refsKey = s ? s.refs.join(',') : ''
  const key = s ? spotlightKey(s) : null
  // serialized: the camera and the presence frames move often, the cut-out only when it really moves
  const placedKey = useValue('dr-wk-spot-placed', () => (s ? JSON.stringify(placementOf(ctx, s.refs)) : ''), [
    ctx.canvas,
    refsKey,
  ])
  const placed = useMemo(() => (placedKey ? (JSON.parse(placedKey) as Placed) : null), [placedKey])
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY)
  const hidden = snap.spotlightHidden
  const starter = !!s && s.by.userId === me

  // One polite announcement per spotlight, through the board's one announcer (the canvas has no live region of its
  // own to add: a11y-audit), not per camera move; the person who started it knows.
  useEffect(() => {
    if (s && key && !starter) announcerFor(ctx.canvas).sayPolitely(`${spotlightText(s, me)}.`)
    // said once per spotlight (a new one has a new key), not when its objects move
  }, [key, starter])

  // bring everyone to it, once, but not the person who started it
  const scene = placed?.shape.scene ?? null
  useEffect(() => {
    if (s?.bringEveryone && !starter && key && scene) bringOnce(ctx.canvas, key, scene)
  }, [ctx.canvas, s?.bringEveryone, starter, key, scene])

  // a notice when a spotlight ends in front of this tab (not on mount: only what happens while it is open)
  const seen = useRef(snap.spotlightEnded?.seq ?? 0)
  useEffect(() => {
    const e = snap.spotlightEnded
    if (!e || e.seq === seen.current) return
    seen.current = e.seq
    ctx.notify({ key: 'spotlight', text: endedText(e), testId: 'spotlight-ended-toast', timeoutMs: 5000 })
  }, [snap.spotlightEnded, ctx])

  const rect = placed?.shape.rect ?? null
  const dim = !!s && !hidden && !!placed && placed.shape.found > 0 && placed.inView && !!rect
  return (
    <div
      className="dr-wk-spot"
      data-testid="spotlight-layer"
      data-active={s && !hidden ? 'true' : 'false'}
      data-motion={reduced ? 'still' : 'pulse'}
    >
      {dim && rect && <Dim rect={rect} />}
      {s && !hidden && placed && <SpotlightBar ctx={ctx} store={store} placed={placed} />}
      {s && hidden && (
        <button
          type="button"
          className="dr-wk-spot__chip"
          data-testid="spotlight-show"
          onClick={() => {
            store.showSpotlight()
            ctx.canvas.focus({ preventScroll: true })
          }}
        >
          Show the spotlight
        </button>
      )}
    </div>
  )
}

/** The dimming: a mask with a rounded cut-out, the ring on its edge. */
function Dim({ rect }: { rect: { x: number; y: number; w: number; h: number } }) {
  const id = `wk-spot-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const radius = 16
  return (
    <>
      <svg
        className="dr-wk-spot__dim"
        data-testid="spotlight-mask"
        data-rect={`${rect.x},${rect.y},${rect.w},${rect.h}`}
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <defs>
          <mask id={id}>
            <rect width="100%" height="100%" fill="#fff" />
            <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={radius} fill="#000" />
          </mask>
        </defs>
        <rect className="dr-wk-spot__shade" width="100%" height="100%" mask={`url(#${id})`} />
      </svg>
      <div
        className="dr-wk-spot__ring"
        data-testid="spotlight-ring"
        aria-hidden="true"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderRadius: radius }}
      />
    </>
  )
}

/** Who is spotlighting, "N of M looking" for the starter, and the buttons. */
function SpotlightBar({ ctx, store, placed }: { ctx: Ctx; store: WorkshopStore; placed: Placed }) {
  const snap = store.getSnapshot()
  const s = snap.spotlight
  const me = ctx.me.user.id
  const canvas = ctx.canvas
  const scene = placed.shape.scene
  const starter = !!s && s.by.userId === me
  const counts = useValue(
    'dr-wk-spot-looking',
    () =>
      starter
        ? JSON.stringify(
            lookingCount({
              peers: canvas.presence.peers().map((p): LookingPeer => ({ uid: p.uid, view: p.view })),
              roster: canvas.collaborators().map((c) => c.uid),
              me,
              scene,
            }),
          )
        : '',
    [canvas, starter, scene?.x, scene?.y, scene?.width, scene?.height],
  )
  if (!s) return null
  const removed = placed.shape.found === 0
  const back = () => canvas.focus({ preventScroll: true })
  return (
    <section className="dr-wk-spot__bar" data-testid="spotlight-bar" aria-label="Spotlight">
      <span className="dr-wk-spot__text" data-testid="spotlight-text">
        {removed ? 'The spotlit items were removed' : spotlightText(s, me)}
      </span>
      {starter && counts && !removed && (
        <span className="dr-wk-spot__looking" data-testid="spotlight-looking">
          {lookingText(JSON.parse(counts) as { looking: number; total: number })}
        </span>
      )}
      {!removed && !placed.inView && scene && (
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="spotlight-go"
          onClick={() => {
            showScene(canvas, scene)
            back()
          }}
        >
          Show me
        </button>
      )}
      <button
        type="button"
        className="dr-btn dr-btn--sm"
        data-testid="spotlight-hide"
        aria-keyshortcuts="Escape"
        title="Hide the dimming for you only (Esc)"
        onClick={() => {
          store.hideSpotlight()
          back()
        }}
      >
        Hide
      </button>
      {mayEndSpotlight(ctx, s) && (
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--primary"
          data-testid="spotlight-end"
          title="End the spotlight for everyone"
          onClick={() => {
            void endSpotlight(ctx)
            back()
          }}
        >
          End for everyone
        </button>
      )}
    </section>
  )
}

// ---- the selection bar -----------------------------------------------------------------------------------------

export function SpotlightIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <rect
        x="3.5"
        y="3.5"
        width="17"
        height="17"
        rx="3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity="0.45"
      />
      <rect x="8" y="8" width="8" height="8" rx="2.2" fill="currentColor" />
    </svg>
  )
}

/** The selection bar's button: spotlight what is selected. */
export function SpotlightSelectionButton({ ctx, selection }: { ctx: Ctx; selection: readonly string[] }) {
  return (
    <button
      type="button"
      className="dr-cux-selbar__btn"
      data-testid="selection-spotlight"
      aria-label="Spotlight for everyone"
      title="Spotlight for everyone: dim the rest of the board for everyone"
      onClick={() => {
        void spotlightIds(ctx, selection)
        ctx.canvas.focus({ preventScroll: true })
      }}
    >
      <SpotlightIcon />
    </button>
  )
}
