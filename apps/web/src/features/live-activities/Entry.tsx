// OWNER: WS2 (wave V, V1). The Facilitate menu's "Poll or word cloud" entry (registered through
// workshops/ported/facilitate-entries.ts: nobody edits WorkshopBar.tsx), and the screen layer that draws the setup
// dialog wherever it was asked for (the menu, the panel, the palette).
//  - a facilitator: starts one (the setup dialog), or opens the panel while one is open or closed;
//  - everyone else: shown while an activity is open or revealed; opens the panel ("Answer the poll", "Poll results").
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import type { FacilitateEntryInput, FacilitateItemProps } from '../workshops/ported/facilitate-entries.ts'
import { ActivityIcon } from './ActivityPanel.tsx'
import { liveActivitiesOn, useActivity, useLiveActivitiesOn } from './hooks.ts'
import { SetupDialog } from './SetupDialog.tsx'
import { type ActivitySnapshot, existingActivityStore } from './store.ts'
import { ACTIVITY_PANEL_ID, answersText, kindLabel } from './words.ts'

type Ctx = CanvasFeatureContext

/** Whether the menu offers the entry now (pure: the store's last snapshot). */
export function entryShown(input: FacilitateEntryInput): boolean {
  if (!liveActivitiesOn()) return false
  const snap = existingActivityStore(input.ctx.events)?.getSnapshot()
  if (!snap || snap.absent) return false
  if (input.facilitator && !input.guest) return true
  return snap.status === 'open' || snap.status === 'closed' || snap.status === 'revealed'
}

/** The entry's words: its label and its meta ("Open · 12 answers"). */
export function entryWords(snap: ActivitySnapshot, facilitator: boolean): { label: string; meta: string } {
  const a = snap.activity
  if (!a || snap.status === 'cancelled' || snap.status === null)
    return { label: 'Poll or word cloud', meta: facilitator ? 'Start' : '' }
  const kind = kindLabel(a.kind)
  if (snap.status === 'open')
    return {
      label: facilitator || snap.myAnswer ? kind : `Answer the ${kind.toLowerCase()}`,
      meta: `Open · ${answersText(snap.answered)}`,
    }
  if (snap.status === 'closed') return { label: kind, meta: 'Closed' }
  return { label: `${kind} results`, meta: facilitator ? 'Start another' : '' }
}

export function ActivityEntry({ ctx, facilitator, guest, close }: FacilitateItemProps) {
  const { store, snap } = useActivity(ctx)
  const run = facilitator && !guest
  const { label, meta } = entryWords(snap, run)
  const current = snap.status === 'open' || snap.status === 'closed' || snap.status === 'revealed'
  return (
    <button
      type="button"
      role="menuitem"
      className="dr-wk-menu__item dr-la-entry"
      data-testid="facilitate-activities"
      data-status={snap.status ?? 'none'}
      onClick={() => {
        // the keyboard goes where the entry leads (the dialog or the panel), not back to the button
        close(false)
        if (run && !current) store.setSetupOpen(true)
        else ctx.openPanel(ACTIVITY_PANEL_ID)
      }}
    >
      <span className="dr-wk-menu__icon" aria-hidden="true">
        <ActivityIcon />
      </span>
      <span className="dr-wk-menu__label">{label}</span>
      {meta && <span className="dr-wk-menu__meta">{meta}</span>}
    </button>
  )
}

/** The setup dialog's layer (a screen overlay that takes no pointer itself). */
export function ActivityDialogsLayer({ ctx }: { ctx: Ctx }) {
  const on = useLiveActivitiesOn()
  if (!on) return null
  return <SetupHost ctx={ctx} />
}

function SetupHost({ ctx }: { ctx: Ctx }) {
  const { store, snap } = useActivity(ctx)
  if (!snap.setupOpen) return null
  return (
    <div className="dr-la-dialog-host">
      <SetupDialog ctx={ctx} store={store} onClose={() => store.setSetupOpen(false)} />
    </div>
  )
}
