// OWNER: WS1 (wave S, review status). One board page's review state (WS4's review page reads it too): the items,
// rounds and what this person may do, from GET /api/boards/:bid/review, kept current by the board events
// REVIEW_ITEM_EVENT and REVIEW_ROUND_EVENT (the same payload for every viewer) and refetched on every (re)connect.
// Writes go through ./client.ts and apply their answer at once; the event that follows is the same item again.
// Nothing here touches the canvas: badges are an overlay, never elements.

import {
  type AddReviewItemInput,
  type GetReviewResponse,
  REVIEW_ITEM_EVENT,
  REVIEW_ROUND_EVENT,
  type ReviewItem,
  ReviewItemEvent,
  type ReviewRound,
  ReviewRoundEvent,
  type SetReviewStatusInput,
  type SetReviewStatusResponse,
  type StartReviewRoundInput,
} from '@draftroom/contracts'
import { type Atom, atom, transact } from '../../lib/signals.ts'
import type { BoardEvents } from '../events.ts'
import {
  addReviewItem,
  closeReviewRound,
  EMPTY_REVIEW,
  getReview,
  patchReviewItem,
  removeReviewItem,
  setReviewStatus,
  startReviewRound,
} from './client.ts'

export interface ReviewClient {
  getReview: typeof getReview
  addReviewItem: typeof addReviewItem
  patchReviewItem: typeof patchReviewItem
  removeReviewItem: typeof removeReviewItem
  setReviewStatus: typeof setReviewStatus
  startReviewRound: typeof startReviewRound
  closeReviewRound: typeof closeReviewRound
}

const LIVE: ReviewClient = {
  getReview,
  addReviewItem,
  patchReviewItem,
  removeReviewItem,
  setReviewStatus,
  startReviewRound,
  closeReviewRound,
}

/** Which item's popover is open (one per board page), and where it was asked from. */
export interface OpenPopover {
  readonly itemId: string
  readonly from: 'badge' | 'panel' | 'viewer'
}

export class ReviewStore {
  readonly state: Atom<GetReviewResponse>
  readonly loaded: Atom<boolean>
  readonly popover: Atom<OpenPopover | null>
  private stopped = false
  private seq = 0
  readonly boardId: string
  private readonly client: ReviewClient

  constructor(boardId: string, client: ReviewClient = LIVE) {
    this.boardId = boardId
    this.client = client
    this.state = atom<GetReviewResponse>(`review.state:${boardId}`, EMPTY_REVIEW)
    this.loaded = atom(`review.loaded:${boardId}`, false)
    this.popover = atom<OpenPopover | null>(`review.popover:${boardId}`, null)
  }

  /** Listens to the board's events and loads now (and on every reconnect). Returns the stop. */
  start(events: BoardEvents): () => void {
    const offs = [
      events.on(REVIEW_ITEM_EVENT, (data) => {
        const parsed = ReviewItemEvent.safeParse(data)
        if (parsed.success) this.applyItem(parsed.data.item)
      }),
      events.on(REVIEW_ROUND_EVENT, (data) => {
        const parsed = ReviewRoundEvent.safeParse(data)
        if (parsed.success) this.applyRound(parsed.data.round)
      }),
      events.onResync(() => void this.refresh()),
    ]
    return () => {
      this.stopped = true
      for (const off of offs) off()
    }
  }

  async refresh(): Promise<void> {
    const mine = ++this.seq
    const next = await this.client.getReview(this.boardId)
    // a later refresh (or the page leaving) wins
    if (this.stopped || mine !== this.seq) return
    transact(() => {
      this.state.set(next)
      this.loaded.set(true)
    })
  }

  // ---- reads ----------------------------------------------------------------------------------------------

  items(): readonly ReviewItem[] {
    return this.state.get().items
  }

  itemOf(elementId: string): ReviewItem | null {
    return this.state.get().items.find((i) => i.elementId === elementId && i.removedAt === null) ?? null
  }

  item(itemId: string): ReviewItem | null {
    return this.state.get().items.find((i) => i.id === itemId) ?? null
  }

  openRound(): ReviewRound | null {
    const s = this.state.get()
    return s.rounds.find((r) => r.id === s.openRoundId) ?? null
  }

  // ---- applying answers and events ------------------------------------------------------------------------

  /** An item as the server has it now: replaced in place, added, or dropped when it left review. */
  applyItem(item: ReviewItem): void {
    if (item.boardId !== this.boardId) return
    this.state.update((s) => {
      const rest = s.items.filter((i) => i.id !== item.id)
      if (item.removedAt !== null) return { ...s, items: rest }
      const at = s.items.findIndex((i) => i.id === item.id)
      const items = at < 0 ? [...rest, item] : s.items.map((i) => (i.id === item.id ? item : i))
      return { ...s, items }
    })
    if (item.removedAt !== null && this.popover.get()?.itemId === item.id) this.popover.set(null)
  }

  applyRound(round: ReviewRound): void {
    if (round.boardId !== this.boardId) return
    this.state.update((s) => {
      const rounds = s.rounds.some((r) => r.id === round.id)
        ? s.rounds.map((r) => (r.id === round.id ? round : r))
        : [...s.rounds, round].sort((a, b) => a.number - b.number)
      const openRoundId =
        round.closedAt === null ? round.id : s.openRoundId === round.id ? null : s.openRoundId
      return { ...s, rounds, openRoundId }
    })
  }

  // ---- writes (each rejects ReviewRequestError) -----------------------------------------------------------

  async mark(input: AddReviewItemInput): Promise<ReviewItem> {
    const { item } = await this.client.addReviewItem(this.boardId, input)
    this.applyItem(item)
    return item
  }

  async unmark(itemId: string): Promise<void> {
    const item = this.item(itemId)
    await this.client.removeReviewItem(this.boardId, itemId)
    if (item) this.applyItem({ ...item, removedAt: new Date().toISOString() })
  }

  async relabel(itemId: string, label: string): Promise<void> {
    const { item } = await this.client.patchReviewItem(this.boardId, itemId, { label })
    this.applyItem(item)
  }

  async move(itemId: string, position: number | null): Promise<void> {
    const { item } = await this.client.patchReviewItem(this.boardId, itemId, { position })
    this.applyItem(item)
  }

  async setStatus(itemId: string, input: SetReviewStatusInput): Promise<SetReviewStatusResponse> {
    const res = await this.client.setReviewStatus(this.boardId, itemId, input)
    this.applyItem(res.item)
    return res
  }

  async startRound(input: StartReviewRoundInput): Promise<ReviewRound> {
    const res = await this.client.startReviewRound(this.boardId, input)
    transact(() => {
      this.applyRound(res.round)
      for (const i of res.items) this.applyItem(i)
    })
    return res.round
  }

  async closeRound(roundId: string): Promise<void> {
    const res = await this.client.closeReviewRound(this.boardId, roundId)
    this.applyRound(res.round)
  }
}
