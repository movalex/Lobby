// OWNER: WS4 (wave N, N4-2/N4-3, "Since your last visit"). The 'visits' feature on the Excalidraw board page: when a
// person comes back to a board, a chip says what others did while they were away ("Since you were here (Tue 3:40 pm):
// 5 added · 3 changed · 1 removed"), outlines mark the added and changed elements for 15 seconds, "Next change" walks the
// camera through them, and "Mark all seen" clears it.
//
// The visit time is the person's own, private, per board (the api's visit markers, ./client.ts; migration 0031):
// nobody else ever learns when they came. This page asks for it as the board opens (the api answers the PREVIOUS visit
// and stores this one), and when the page is hidden or left (visibilitychange to hidden, pagehide, or the board closing)
// it sends a "seen" beacon, so the next visit measures from here.
// A name-only guest keeps the device-local Catch me up window and makes no request at all. An api without the route
// (a 404), a refusal or a network error leaves the chip hidden and everything else as it was.
//
// Read-only on the board: the changes are computed from the scene's server stamps once the room is ready (./model.ts,
// ./run.ts), the outlines are an overlay and "Next change" moves the camera. Nothing is selected, nothing is written,
// and this tab pushes no element because of it. The same previous time is handed to Catch me up (ai/recap/window.ts
// noteServerVisit), so the chip and the recap agree.
import { VISIT_HIGHLIGHT_FADE_MS } from '@draftroom/contracts'
import { can } from '@draftroom/permissions'
import type { CanvasFeature, CanvasFeatureContext } from '../../canvas/api/index.ts'
import { roomReadyOf } from '../../canvas/api/room-ready.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { type Signal, subscribeValue } from '../../lib/signals.ts'
import { countUsage } from '../../lib/usage.ts'
import { noteServerVisit } from '../ai/recap/window.ts'
import { historyApi } from '../history/api.ts'
import { acknowledge, wasAcknowledged } from './ack.ts'
import { VisitsChip, VisitsOutlines } from './Chip.tsx'
import { fetchVisit, sendSeen } from './client.ts'
import type { VisitElement } from './model.ts'
import { computeHighlights, type HighlightDeps } from './run.ts'
import { checkpointElementsBefore, deletedNames } from './sources.ts'
import { nextStop, TOUR_ZOOM, tourStops, type VisitsView, visitsView } from './view.ts'
import './visits.css'

/** Resolves when `ready` is (or becomes) true. */
function untilReady(ready: Signal<boolean>): Promise<void> {
  if (ready.get()) return Promise.resolve()
  return new Promise((resolve) => {
    const off = subscribeValue(ready, () => {
      if (!ready.get()) return
      off()
      resolve()
    })
    if (ready.get()) {
      off()
      resolve()
    }
  })
}

/** The scene's deleted elements: the engine keeps its tombstones (CanvasPort.engine), the scene's items do not. */
function* tombstonesOf(ctx: CanvasFeatureContext): Iterable<VisitElement> {
  const all = ctx.canvas.engine?.elements()
  if (!all) return
  for (const el of all.values()) if (el.isDeleted) yield el as unknown as VisitElement
}

export function highlightDeps(ctx: CanvasFeatureContext): HighlightDeps {
  const { canvas } = ctx
  const history = historyApi(ctx.api)
  const boardId = ctx.board.id
  const account = knownUserKind(ctx.me.user.id) !== 'guest'
  return {
    roomReady: () => untilReady(roomReadyOf(canvas)),
    live: () => canvas.items() as unknown as readonly VisitElement[],
    tombstones: () => tombstonesOf(ctx),
    isHidden: (id) => canvas.isHidden(id),
    checkpointElements: (seenAt, signal) => checkpointElementsBefore(history, boardId, seenAt, signal),
    // "Recently deleted" is for editors with an account; viewers see a count
    ...(account && can(ctx.role, 'edit', ctx.board.status)
      ? { removedNames: (signal: AbortSignal) => deletedNames(history, boardId, signal) }
      : {}),
  }
}

const update = (ctx: CanvasFeatureContext, patch: Partial<VisitsView>) => {
  const slot = visitsView(ctx.canvas)
  const cur = slot.get()
  if (cur) slot.set({ ...cur, ...patch })
}

export const feature: CanvasFeature = {
  id: 'visits',
  overlays: [
    { id: 'visits.outlines', layer: 'scene', order: 6, pointer: 'none', component: VisitsOutlines },
    {
      id: 'visits.chip',
      layer: 'screen',
      order: 54,
      pointer: 'none',
      component: ({ ctx }) => <VisitsChip ctx={ctx} actions={actionsOf(ctx)} />,
    },
  ],
  onMount(ctx) {
    const boardId = ctx.board.id
    // a name-only guest keeps the device-local window, and asks for nothing
    if (knownUserKind(ctx.me.user.id) === 'guest') return undefined
    noteServerVisit(boardId, null) // what an earlier open of this board on this page was told is not this open's
    const abort = new AbortController()
    let alive = true
    /** the api took this open's visit: only then is there anything to say "seen" about */
    let visited = false
    let fade: ReturnType<typeof setTimeout> | null = null
    const leave = () => {
      if (visited) sendSeen(boardId)
    }
    const doc = ctx.canvas.container()?.ownerDocument
    const win = doc?.defaultView ?? globalThis
    // pagehide alone is not enough: phones (iOS Safari, Android app switching) often fire none of it, and a background
    // tab the browser discards (Memory Saver) or a crash never does. The page turning hidden is the last moment that
    // is reliably seen, so it says "seen" too (the api writes at most once per 10 s per person and board).
    const hide = () => {
      if (doc?.visibilityState === 'hidden') leave()
    }
    win.addEventListener?.('pagehide', leave)
    doc?.addEventListener?.('visibilitychange', hide)

    void (async () => {
      const answer = await fetchVisit(boardId)
      if (!alive || !answer) return
      visited = true
      noteServerVisit(boardId, answer.previousSeenAt)
      // a reload inside the api's write interval is answered with the visit it already answered: if this tab
      // marked that one seen, it is seen
      if (answer.previousSeenAt !== null && wasAcknowledged(boardId, answer.seenAt)) return
      const found = await computeHighlights(highlightDeps(ctx), answer, abort.signal).catch(() => null)
      if (!alive || !found) return
      visitsView(ctx.canvas).set({
        changes: found.changes,
        visitSeenAt: answer.seenAt,
        tour: -1,
        outlines: true,
        hidden: false,
        removedOpen: false,
      })
      fade = setTimeout(() => {
        fade = null
        update(ctx, { outlines: false })
      }, VISIT_HIGHLIGHT_FADE_MS)
    })()

    return () => {
      alive = false
      abort.abort()
      if (fade) clearTimeout(fade)
      win.removeEventListener?.('pagehide', leave)
      doc?.removeEventListener?.('visibilitychange', hide)
      leave()
      visitsView(ctx.canvas).set(null)
      noteServerVisit(boardId, null)
    }
  },
}

// ---- the chip's actions ------------------------------------------------------------------------------------------

export function actionsOf(ctx: CanvasFeatureContext) {
  return {
    next() {
      const view = visitsView(ctx.canvas).get()
      if (!view) return
      const stops = tourStops(view.changes, (id) => ctx.canvas.bounds(id))
      const at = nextStop(view.tour, stops.length)
      const stop = stops[at]
      if (!stop) return
      countUsage('visits.tour')
      update(ctx, { tour: at })
      ctx.canvas.viewport.zoomTo(stop.bounds, TOUR_ZOOM)
    },
    markSeen() {
      countUsage('visits.markseen')
      sendSeen(ctx.board.id)
      const view = visitsView(ctx.canvas).get()
      if (view) acknowledge(ctx.board.id, view.visitSeenAt)
      update(ctx, { hidden: true, outlines: false, tour: -1 })
    },
    hide() {
      update(ctx, { hidden: true, outlines: false })
    },
    toggleRemoved() {
      const view = visitsView(ctx.canvas).get()
      if (view) update(ctx, { removedOpen: !view.removedOpen })
    },
  }
}
