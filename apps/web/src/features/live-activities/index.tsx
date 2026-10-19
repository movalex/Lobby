// OWNER: WS2 (wave V; docs/WAVE-V-CONTRACTS.md §2). The 'live-activities' feature on the Excalidraw board page: polls,
// scales and word clouds (V1).
//  - the dock panel "Poll or word cloud" (./ActivityPanel.tsx): the answer sheet (a full-width sheet on a phone), live
//    and revealed results, the facilitator's controls, moderation, Results to board (./to-board.ts: one
//    canvas.transact, kind 'poll-chart' / 'word-cloud');
//  - the setup dialog (./SetupDialog.tsx), drawn by a screen layer wherever it is asked for;
//  - the Facilitate menu entry 'activities' and its pill part (workshops/ported/facilitate-entries.ts), the palette
//    command 'activities.start', and Wrap up's sections 'activities' and 'word-clouds' (ai/recap/sources.ts);
//  - notices: someone else's activity started (with "Answer"), the results came in (with "See results").
//
// Its switch: features/live LIVE_FLAGS.activities AND the api's DRAFTROOM_LIVE_ACTIVITIES (liveEnabled). While either is
// off the feature offers nothing: the panel is not in the dock, the entry and the command are not offered, no store
// is made and nothing is fetched.
import { ACTIVITY_KIND_LABELS } from '@draftroom/contracts'
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CanvasPanelSpec,
  CommandSpec,
} from '../../canvas/api/index.ts'
import { react, untracked } from '../../lib/signals.ts'
import { registerRecapSource } from '../ai/recap/sources.ts'
import { registerFacilitateEntry, setFacilitatePill } from '../workshops/ported/facilitate-entries.ts'
import { PANELS_CHANGED_EVENT } from '../workshops/ported/index.tsx'
import { ActivityIcon, ActivityPanel } from './ActivityPanel.tsx'
import { clip } from './board-plan.ts'
import { ActivityDialogsLayer, ActivityEntry, entryShown } from './Entry.tsx'
import { activityStoreFor, liveActivitiesOn, mayFacilitate } from './hooks.ts'
import { recapSourcesOf } from './recap.ts'
import { type ActivitySnapshot, existingActivityStore, forgetActivityStore } from './store.ts'
import { ACTIVITY_PANEL_ID, PILL_SPOKEN, PILL_TEXT } from './words.ts'

type Ctx = CanvasFeatureContext

/** Whether the dock shows the panel: the feature is on here, and the person runs sessions or one is going on. */
export function panelVisible(
  ctx: Ctx,
  snap: ActivitySnapshot | null = existingActivityStore(ctx.events)?.getSnapshot() ?? null,
): boolean {
  if (!liveActivitiesOn() || !snap || snap.absent) return false
  if (mayFacilitate(ctx)) return true
  return snap.activity !== null && snap.status !== 'cancelled'
}

export const activityPanel: CanvasPanelSpec = {
  id: ACTIVITY_PANEL_ID,
  label: 'Poll or word cloud',
  icon: ActivityIcon,
  // after Voting (40) and Private brainstorm (45)
  order: 47,
  visible: (ctx) => panelVisible(ctx),
  component: ActivityPanel,
}

export const START_COMMAND: CommandSpec = {
  id: 'activities.start',
  label: 'Start a poll or word cloud',
  group: 'Facilitate',
  keywords: ['poll', 'survey', 'scale', 'rating', 'word cloud', 'question', 'quiz', 'ask the room'],
  available: () => liveActivitiesOn(),
  disabledReason: (ctx) =>
    ctx.board.status !== 'active'
      ? 'This board is archived'
      : !mayFacilitate(ctx)
        ? 'Polls are run by editors with an account'
        : null,
  run: (ctx) => {
    const store = activityStoreFor(ctx)
    const s = store.getSnapshot().status
    if (s === 'open' || s === 'closed') ctx.openPanel(ACTIVITY_PANEL_ID)
    else store.setSetupOpen(true)
  },
}

/** The pill part for a snapshot: the open activity's kind, else none. */
export function pillOf(snap: ActivitySnapshot): { text: string; spoken: string } | null {
  if (snap.status !== 'open' || !snap.activity) return null
  return { text: PILL_TEXT[snap.activity.kind], spoken: PILL_SPOKEN[snap.activity.kind] }
}

const announcePanels = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PANELS_CHANGED_EVENT))
}

/** Everything the feature does while it is on (the switch's react below mounts and unmounts it). */
function mountOn(ctx: Ctx, late: boolean): () => void {
  const store = activityStoreFor(ctx)
  // the switches arrived after the board page mounted: the stream's first resync is gone, ask now
  if (late && !store.refreshAsked()) void store.refresh()
  const offs: (() => void)[] = []
  offs.push(registerFacilitateEntry({ id: 'activities', order: 100, shown: entryShown, Item: ActivityEntry }))
  for (const s of recapSourcesOf()) offs.push(registerRecapSource(s))

  let lastPill = ''
  let lastPanel = panelVisible(ctx, store.getSnapshot())
  const update = () => {
    const snap = store.getSnapshot()
    const pill = pillOf(snap)
    const pillKey = pill ? `${pill.text}|${pill.spoken}` : ''
    if (pillKey !== lastPill) {
      lastPill = pillKey
      setFacilitatePill(ctx.canvas, 'activities', pill)
    }
    const visible = panelVisible(ctx, snap)
    if (visible !== lastPanel) {
      lastPanel = visible
      announcePanels()
    }
  }
  offs.push(store.subscribe(update))
  update()

  offs.push(
    store.onNews((n) => {
      const kind = ACTIVITY_KIND_LABELS[n.activity.kind]
      if (n.kind === 'started')
        ctx.notify({
          key: 'live-activities',
          text: `${kind}: ${clip(n.activity.prompt, 90)}`,
          testId: 'la-start-toast',
          timeoutMs: 20_000,
          action: {
            label: 'Answer',
            testId: 'la-start-toast-answer',
            onClick: () => ctx.openPanel(ACTIVITY_PANEL_ID),
          },
        })
      else
        ctx.notify({
          key: 'live-activities',
          text: `${kind} results are in: ${clip(n.activity.prompt, 80)}`,
          testId: 'la-results-toast',
          timeoutMs: 15_000,
          action: {
            label: 'See results',
            testId: 'la-results-toast-open',
            onClick: () => ctx.openPanel(ACTIVITY_PANEL_ID),
          },
        })
    }),
  )
  return () => {
    for (const off of offs.splice(0).reverse()) off()
    setFacilitatePill(ctx.canvas, 'activities', null)
    forgetActivityStore(ctx.events)
    announcePanels()
  }
}

/** On the board page's mount: follows the switch (it can arrive after the page mounted: GET /api/auth/config). */
export function mountLiveActivities(ctx: Ctx): () => void {
  let live: (() => void) | null = null
  let first = true
  const stop = react('lobby-live-activities-switch', () => {
    const on = liveActivitiesOn()
    const late = !first
    first = false
    untracked(() => {
      if (on && !live) {
        live = mountOn(ctx, late)
        announcePanels()
      } else if (!on && live) {
        live()
        live = null
      }
    })
  })
  return () => {
    stop()
    live?.()
    live = null
  }
}

export const feature: CanvasFeature = {
  id: 'live-activities',
  panels: [activityPanel],
  commands: [START_COMMAND],
  overlays: [
    {
      id: 'live-activities-dialogs',
      layer: 'screen',
      order: 64,
      pointer: 'none',
      focusMode: 'hide',
      component: ActivityDialogsLayer,
    },
  ],
  onMount: mountLiveActivities,
}
