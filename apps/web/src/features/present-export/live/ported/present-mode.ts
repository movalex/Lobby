// Wave-3 integration: present to everyone (3c, this folder) on present mode (3e, ../../ported). Each owner
// built one side of the seam: 3c's live controller mounts on a presenter offered through
// `provideLivePresenter(registries, …)` (./presenter.ts, CR-3C-2), and 3e's presentation chrome renders the
// live controls offered through `providePresentLive(canvas, …)` and exposes its presenter as
// `presenterOf(canvas)` (../../ported/live-slots.ts, controller.ts). This joins the two, as the tldraw page's
// present-export feature did in one call (`mountLive(ctx, controller.presenter)` and PresentOverlay's
// LiveTop / LiveBarControls).
import type { CanvasFeatureContext } from '../../../../canvas/api/index.ts'
import { presenterOf, providePresentLive } from '../../ported/index.tsx'
import type { Presenter } from '../../ported/presenter.ts'
import { getLive } from './controller.ts'
import { LiveBarControls, LiveTop, liveBannerShown } from './LiveUi.tsx'
import { type LivePresenter, provideLivePresenter } from './presenter.ts'

/** Present mode's presenter as the live controller sees it (slide ids are element ids on both sides). */
export function livePresenterOf(presenter: Presenter): LivePresenter {
  return {
    state: presenter.state,
    current() {
      const c = presenter.current()
      return { index: c.index, slideId: c.slide?.id ?? null, count: c.count }
    },
    isPresenting: () => presenter.isPresenting(),
    start: (opts) => presenter.start(opts),
    stop: (opts) => presenter.stop(opts),
    role: () => presenter.role(),
    setRole: (role, leader) => presenter.setRole(role, leader),
    follow: (slideId, index) => presenter.follow(slideId, index),
    onStop: (listener) => presenter.onStop(listener),
  }
}

/** Offers present mode's presenter to present-live and present-live's chrome to present mode. */
export function joinPresentMode(ctx: CanvasFeatureContext): () => void {
  const offPresenter = provideLivePresenter(ctx.registries, livePresenterOf(presenterOf(ctx.canvas)))
  const offChrome = providePresentLive(ctx.canvas, {
    Top: LiveTop,
    Bar: LiveBarControls,
    presentingLive: () => getLive(ctx.registries)?.presentingLive.get() ?? false,
    banner: () => liveBannerShown(getLive(ctx.registries)),
    onLocalStart: () => void getLive(ctx.registries)?.offerToEveryone(),
    audience: () => getLive(ctx.registries)?.offerAudience() ?? 0,
  })
  return () => {
    offChrome()
    offPresenter()
  }
}
