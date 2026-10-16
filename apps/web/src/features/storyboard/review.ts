// OWNER: WS2 (wave T, storyboards). "Put panels in review": every panel of a storyboard becomes a wave S review item
// (a frame item) in storyboard order, through the review feature's own store and features/review/client.ts (the
// api decides who may: REVIEW_RULES; the review switch off or no manage right means no entry). Each item is labelled
// with its shot number and its frame's name, and its `position` is its shot number, so the review page lists them
// in the storyboard's order. A panel already in review keeps its item (its position is brought in line); the api's
// cap (200 items) answers REVIEW_FULL and the rest are left out, with a notice that says how many went in.
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { reviewOf } from '../review/bridge.ts'
import { patchReviewItem, ReviewRequestError } from '../review/client.ts'
import { shotLabel } from './model.ts'
import type { Sb } from './ops.ts'

/** Whether "Put panels in review" is offered: the review feature is on here and this person manages it. */
export function reviewOffered(canvas: LobbyCanvas): boolean {
  const r = reviewOf(canvas)
  return !!r && r.store.state.get().can.manage
}

/** The item label of a panel: "SH 03 · Kitchen" (its frame's name when it has one of its own). */
export function panelReviewLabel(n: number, name: string | null | undefined): string {
  const own = (name ?? '').trim()
  return own && own !== 'Panel' ? `${shotLabel(n)} · ${own}`.slice(0, 120) : shotLabel(n)
}

export async function putPanelsInReview(ctx: CanvasFeatureContext, sb: Sb): Promise<number> {
  const r = reviewOf(ctx.canvas)
  if (!r || !sb.panels.length) return 0
  let added = 0
  let full = false
  for (let i = 0; i < sb.panels.length; i++) {
    const p = sb.panels[i]
    if (!p) continue
    const frame = ctx.canvas.get(p.id)
    if (!frame || frame.isDeleted) continue
    try {
      const existing = r.store.itemOf(p.id)
      const item =
        existing ??
        (await r.store.mark({
          elementId: p.id,
          kind: 'frame',
          label: panelReviewLabel(i + 1, (frame as { name?: string | null }).name),
        }))
      if (!existing) added++
      if (item.position !== i + 1) await patchReviewItem(ctx.board.id, item.id, { position: i + 1 })
    } catch (e) {
      if (e instanceof ReviewRequestError && e.code === 'REVIEW_FULL') {
        full = true
        break
      }
      if (e instanceof ReviewRequestError && e.code === 'ALREADY_IN_REVIEW') continue
      ctx.notify({
        key: 'storyboard:review',
        tone: 'error',
        text: "Couldn't put every panel in review. Try again.",
      })
      return added
    }
  }
  ctx.notify({
    key: 'storyboard:review',
    testId: 'sb-review-done',
    text: full
      ? `${added} panels went into review: the board holds as many review items as it can.`
      : added
        ? `${added} ${added === 1 ? 'panel is' : 'panels are'} in review, in storyboard order.`
        : 'Every panel was in review already; their order is the storyboard’s.',
  })
  return added
}
