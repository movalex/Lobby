// OWNER: 3c (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'present-live' feature on the Excalidraw board
// page: present to everyone (docs/WAVE4-CONTRACTS.md "present-live"; checklist PRS-07, PRS-12's hand-off):
// the invitation on the board ("Chase is presenting · Join / Not now"), the top-bar chip that rejoins (or,
// for the presenter's other tabs, "Present here"), and the live controller that keeps this tab's
// presentation in step with the api's. The presentation itself (slides, chrome, full screen) is present
// mode's (3e): ./present-mode.ts offers its presenter (./presenter.ts `provideLivePresenter`) to the live
// controller and `LiveTop` / `LiveBarControls` (./LiveUi.tsx) to its chrome (the wave-3 integration).

import type { CanvasFeature, CanvasFeatureContext } from '../../../../canvas/api/index.ts'
import { react, untracked } from '../../../../lib/signals.ts'
import { mountLive } from './controller.ts'
import { LiveChip, LiveInvite, LiveSync } from './LiveUi.tsx'
import { joinPresentMode } from './present-mode.ts'
import { presenterSlot } from './presenter.ts'

export { getLive, type LiveController } from './controller.ts'
export { LiveBarControls, LiveTop, useLive } from './LiveUi.tsx'
export { type LivePresenter, provideLivePresenter } from './presenter.ts'

function LiveChipItem({ ctx }: { ctx: CanvasFeatureContext }) {
  return <LiveChip ctx={ctx} />
}

/** Keeps the controller's copy of the caller's role and guest status current, also while presenting. */
function LiveSyncLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  return <LiveSync ctx={ctx} />
}

function LiveInviteLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  return <LiveInvite ctx={ctx} />
}

/** Mounts the live controller on present mode's presenter, whenever one is provided. */
function mount(ctx: CanvasFeatureContext): () => void {
  // present mode's presenter and this feature's chrome, joined (./present-mode.ts, the wave-3 integration)
  const leave = joinPresentMode(ctx)
  let current: { presenter: unknown; unmount: () => void } | null = null
  const stop = react('dr-live-presenter-watch', () => {
    const presenter = presenterSlot(ctx.registries).get()
    if (current?.presenter === presenter) return
    current?.unmount()
    current = presenter ? { presenter, unmount: untracked(() => mountLive(ctx, presenter)) } : null
  })
  return () => {
    stop()
    current?.unmount()
    current = null
    leave()
  }
}

export const feature: CanvasFeature = {
  id: 'present-live',
  // before the people list in the bar, as on the tldraw page
  topBar: [{ id: 'present-live', order: 5, pinned: true, component: LiveChipItem }],
  overlays: [
    {
      id: 'present-live.sync',
      layer: 'screen',
      order: 1,
      pointer: 'none',
      focusMode: 'show',
      component: LiveSyncLayer,
    },
    { id: 'present-live.invite', layer: 'screen', order: 60, pointer: 'auto', component: LiveInviteLayer },
  ],
  onMount: mount,
}
