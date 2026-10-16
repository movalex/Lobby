// OWNER: WS4 (wave S, the client review page). The page's data hooks: the review (items, rounds, what the caller may do),
// kept current by the board events (REVIEW_ITEM_EVENT, REVIEW_ROUND_EVENT) and by a reload after every reconnect, and
// the canvas facts of an item (does its element exist, what is it called, where is it). The api's answers and the events
// are parsed with their contract schemas.
import {
  type GetReviewResponse,
  REVIEW_ITEM_EVENT,
  REVIEW_ROUND_EVENT,
  type ReviewItem,
  ReviewItemEvent,
} from '@draftroom/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { factsOf as fileFactsOf } from '../../file-card/ported/model.ts'
import { EMPTY_REVIEW, getReview } from './client.ts'
import type { ElementFacts } from './model.ts'

export interface ReviewData {
  readonly review: GetReviewResponse
  /** the first answer has come (an empty review before it is not "nothing to review") */
  readonly loaded: boolean
  /** puts an item the api just sent (a status answer, a conflict) in place */
  apply(item: ReviewItem): void
  reload(): void
}

/** Replaces or adds `item` (a removed one leaves the list), keeping the rest as it was. */
export function withItem(review: GetReviewResponse, item: ReviewItem): GetReviewResponse {
  const rest = review.items.filter((i) => i.id !== item.id)
  if (item.removedAt !== null) return { ...review, items: rest }
  const at = review.items.findIndex((i) => i.id === item.id)
  if (at < 0) return { ...review, items: [...rest, item] }
  const items = review.items.slice()
  // a late answer never undoes a newer one: an older statusSeq is ignored
  const current = items[at] as ReviewItem
  if (item.statusSeq < current.statusSeq) return review
  items[at] = item
  return { ...review, items }
}

export function useReviewData(ctx: CanvasFeatureContext): ReviewData {
  const [state, setState] = useState<{ review: GetReviewResponse; loaded: boolean }>({
    review: EMPTY_REVIEW,
    loaded: false,
  })
  const alive = useRef(true)
  const seq = useRef(0)
  const boardId = ctx.board.id

  const reload = useCallback(() => {
    const mine = ++seq.current
    void getReview(boardId).then((review) => {
      if (!alive.current || mine !== seq.current) return
      setState({ review, loaded: true })
    })
  }, [boardId])

  useEffect(() => {
    alive.current = true
    reload()
    const offs = [
      ctx.events.on(REVIEW_ITEM_EVENT, (data) => {
        const parsed = ReviewItemEvent.safeParse(data)
        if (parsed.success) setState((s) => ({ ...s, review: withItem(s.review, parsed.data.item) }))
      }),
      ctx.events.on(REVIEW_ROUND_EVENT, () => reload()),
      ctx.events.onResync(reload),
    ]
    return () => {
      alive.current = false
      for (const off of offs) off()
    }
  }, [ctx.events, reload])

  const apply = useCallback(
    (item: ReviewItem) => setState((s) => ({ ...s, review: withItem(s.review, item) })),
    [],
  )
  return { review: state.review, loaded: state.loaded, apply, reload }
}

/** What the canvas knows of an item's element (null: it is gone: the item is orphaned). Reactive when read in useValue. */
export function elementFacts(canvas: LobbyCanvas, elementId: string): ElementFacts | null {
  const el = canvas.get(elementId)
  if (!el || el.isDeleted) return null
  const file = fileFactsOf(el)
  const name = (el as { name?: unknown }).name
  return {
    type: el.type,
    frameName: el.type === 'frame' ? (typeof name === 'string' ? name : '') : null,
    file: file
      ? { assetId: file.assetId, versionId: file.versionId, kind: file.kind, name: file.name }
      : null,
    bounds: canvas.bounds(elementId),
  }
}
