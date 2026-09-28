// Present to everyone (present-live): this browser's copy of the board's live presentation, kept in
// step with the api (docs/WAVE4-CONTRACTS.md "present-live"). The api is the authority; this store
// applies its states in version order (an event, a response and a refetch can arrive in any order),
// sends the presenter's slide changes (coalesced: one request in flight, the latest slide wins) and
// remembers this person's choice per presentation ("following" or "not now") for the tab's lifetime.
//
// Plain tldraw atoms, no React: live/controller.ts reacts to them and the UI reads them with useValue.

import {
  isNewerLive,
  type LivePresentation,
  PRESENT_LIVE_EVENTS,
  type PresentChange,
  PresentLiveEvent,
  PresentLiveState,
  type PresentLiveVersion,
  type PresentSlide,
} from '@draftroom/contracts'
import { type Atom, atom, transact } from 'tldraw'
import type { z } from 'zod'

type Method = 'GET' | 'POST'
/** The subset of ApiClient['request'] the store needs (tests pass a fake). */
export type LiveRequest = <S extends z.ZodType | null>(
  method: Method,
  path: string,
  opts: { body?: unknown; schema: S },
) => Promise<S extends z.ZodType ? z.output<S> : undefined>

/** The subset of BoardEvents the store needs. */
export interface LiveEvents {
  on(type: string, listener: (data: unknown) => void): () => void
  onResync(listener: () => void): () => void
}

/** A small key-value store (sessionStorage in the browser, a Map in tests). */
export interface LiveStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type LiveIntent = 'following' | 'declined'

export type LiveResult = { ok: true } | { ok: false; code: string; message: string }

/** After an api restart, how long followers wait for the presenter's tab to put the presentation back. */
export const RESTART_WAIT_MS = 10_000
/** A slide that failed to send (no network) is sent again after this long. */
export const SLIDE_RETRY_MS = 1_000
/** A follower the api does not count follows again at most this often. */
export const FOLLOW_AGAIN_MS = 2_000

export interface LiveStoreDeps {
  boardId: string
  userId: string
  /** This tab's id (tab.ts). */
  tab: string
  request: LiveRequest
  events: LiveEvents
  storage?: LiveStorage | null
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

const resultOf = (e: unknown): LiveResult => {
  const err = e as { message?: unknown; code?: unknown } | null
  return {
    ok: false,
    code: typeof err?.code === 'string' ? err.code : 'ERROR',
    message: typeof err?.message === 'string' && err.message ? err.message : 'That did not work. Try again.',
  }
}

const sameSlide = (p: LivePresentation, s: PresentSlide) =>
  p.slideId === s.slideId && p.index === s.index && p.count === s.count

export class LiveStore {
  /** The board's live presentation as the api last said (null: nobody presents). */
  readonly presentation: Atom<LivePresentation | null>
  /** What the last applied state changed (for the words shown when a presentation ends). */
  readonly lastChange: Atom<PresentChange | null>
  /** This person's choice for one presentation id (following, or "Not now"). */
  readonly intent: Atom<{ id: string; intent: LiveIntent } | null>
  /**
   * The presentation this browser had when the api restarted (its state is gone): the presenter's tab
   * puts it back with the same id, and followers keep following meanwhile, for RESTART_WAIT_MS.
   */
  readonly restartLost: Atom<LivePresentation | null>
  /** The first state arrived. */
  readonly loaded: Atom<boolean>

  private readonly deps: LiveStoreDeps
  private version: PresentLiveVersion | null = null
  private readonly offs: (() => void)[] = []
  private disposed = false
  private restartTimer: unknown = null
  // slide sender
  private wantSlide: PresentSlide | null = null
  private sending = false
  private followInFlight = 0
  private lastFollowAt = 0
  private retryTimer: unknown = null
  private readonly storageKey: string

  constructor(deps: LiveStoreDeps) {
    this.deps = deps
    this.presentation = atom('dr-live-presentation', null)
    this.lastChange = atom('dr-live-last-change', null)
    this.restartLost = atom('dr-live-restart-lost', null)
    this.loaded = atom('dr-live-loaded', false)
    this.storageKey = `draftroom:present-live:${deps.boardId}`
    this.intent = atom('dr-live-intent', this.readIntent())
    this.offs.push(
      deps.events.on(PRESENT_LIVE_EVENTS.changed, (data) => {
        const parsed = PresentLiveEvent.safeParse(data)
        if (!parsed.success) return
        // The presentation back after an api restart (or a change while we were not counted).
        if (this.apply(parsed.data, parsed.data.change)) this.ensureFollowing()
      }),
      // Every (re)connect: the api may have restarted, or changed things while this stream was down.
      deps.events.onResync(() => void this.refresh()),
    )
  }

  get tab(): string {
    return this.deps.tab
  }

  private get base() {
    return `/api/boards/${encodeURIComponent(this.deps.boardId)}/presentation`
  }

  /**
   * Applies a state if it is not older than the one shown. Returns whether it was applied. A change
   * (from an event) says what happened; a state from a response or a refetch has none.
   */
  apply(
    state: { presentation: LivePresentation | null; version: PresentLiveVersion },
    change?: PresentChange,
  ) {
    if (this.disposed || !isNewerLive(this.version, state.version)) return false
    const before = this.presentation.get()
    const restarted = !!this.version && this.version.epoch !== state.version.epoch
    this.version = state.version
    transact(() => {
      const lost = this.restartLost.get()
      if (state.presentation) {
        if (lost) this.clearRestart()
      } else if (restarted && before && !lost) {
        // The api restarted and forgot the presentation: give its presenter's tab a moment.
        this.restartLost.set(before)
        this.restartTimer = this.timeout(() => {
          this.restartTimer = null
          if (!this.presentation.get()) {
            this.lastChange.set({ kind: 'ended', reason: null, byUserId: null, byName: null })
          }
          this.restartLost.set(null)
        }, RESTART_WAIT_MS)
      }
      if (change) this.lastChange.set(change)
      else if (before && !state.presentation && !restarted) {
        // A refetch found it gone (it ended while this stream was down).
        this.lastChange.set({ kind: 'ended', reason: null, byUserId: null, byName: null })
      }
      this.presentation.set(state.presentation)
      this.loaded.set(true)
    })
    return true
  }

  async refresh(): Promise<void> {
    try {
      const s = await this.deps.request('GET', this.base, { schema: PresentLiveState })
      this.apply(s)
      this.ensureFollowing()
      // A slide that could not be sent while offline goes now.
      this.pumpSlides()
    } catch {
      // The stream's next resync tries again; the UI keeps the last state.
    }
  }

  // ---- intent -------------------------------------------------------------------------------------------

  /** This person's choice for presentation `id` (null: not asked yet). */
  intentFor(id: string): LiveIntent | null {
    const i = this.intent.get()
    return i?.id === id ? i.intent : null
  }

  setIntent(id: string, intent: LiveIntent) {
    const cur = this.intent.get()
    if (cur?.id === id && cur.intent === intent) return
    this.intent.set({ id, intent })
    try {
      this.deps.storage?.setItem(this.storageKey, JSON.stringify({ id, intent }))
    } catch {
      // storage full or blocked: the choice lasts for this page only
    }
  }

  private readIntent(): { id: string; intent: LiveIntent } | null {
    try {
      const raw = this.deps.storage?.getItem(this.storageKey)
      if (!raw) return null
      const v = JSON.parse(raw) as { id?: unknown; intent?: unknown }
      if (typeof v.id !== 'string' || (v.intent !== 'following' && v.intent !== 'declined')) return null
      return { id: v.id, intent: v.intent }
    } catch {
      return null
    }
  }

  // ---- actions ----------------------------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<LiveResult> {
    try {
      const s = await this.deps.request('POST', `${this.base}${path}`, { body, schema: PresentLiveState })
      this.apply(s)
      return { ok: true }
    } catch (e) {
      const r = resultOf(e)
      // The presentation moved on (ended, handed over, taken over): show what is true now.
      if (!r.ok && ['NOT_PRESENTING', 'NOT_PRESENTER', 'OTHER_TAB', 'ALREADY_PRESENTING'].includes(r.code))
        void this.refresh()
      return r
    }
  }

  /** Present to everyone from this tab (also: take a hand-off, move to this tab, resume, take over). */
  start(input: { slide: PresentSlide; resumeId?: string; takeOver?: boolean }): Promise<LiveResult> {
    return this.post('', {
      tab: this.deps.tab,
      ...input.slide,
      ...(input.resumeId ? { resumeId: input.resumeId } : {}),
      ...(input.takeOver ? { takeOver: true } : {}),
    })
  }

  /** Ends the current presentation for everyone. */
  stop(): Promise<LiveResult> {
    const p = this.presentation.get()
    if (!p) return Promise.resolve({ ok: true })
    this.wantSlide = null
    return this.post('/stop', { id: p.id })
  }

  handOff(userId: string): Promise<LiveResult> {
    const p = this.presentation.get()
    if (!p)
      return Promise.resolve({ ok: false, code: 'NOT_PRESENTING', message: 'This presentation has ended.' })
    return this.post('/handoff', { id: p.id, userId })
  }

  /** Follow the current presentation, or step out of it. */
  follow(following: boolean): Promise<LiveResult> {
    const p = this.presentation.get()
    if (!p) return Promise.resolve({ ok: true })
    this.lastFollowAt = Date.now()
    this.followInFlight++
    return this.post('/follow', { id: p.id, following }).finally(() => {
      this.followInFlight--
    })
  }

  /**
   * Following, but the api does not count us (it restarted, or dropped us while this stream was down
   * longer than its grace): follow again. At most every FOLLOW_AGAIN_MS, never while a follow request
   * is on its way, and only when the api's list is complete (it names everyone it counts).
   */
  private ensureFollowing() {
    const p = this.presentation.get()
    const intent = this.intent.get()
    if (!p || intent?.id !== p.id || intent.intent !== 'following') return
    if (p.presenter.userId === this.deps.userId || this.followInFlight > 0) return
    if (p.followers.length !== p.followerCount) return
    if (p.followers.some((f) => f.userId === this.deps.userId)) return
    if (Date.now() - this.lastFollowAt < FOLLOW_AGAIN_MS) return
    void this.follow(true)
  }

  /**
   * The presenting tab's slide. Coalesced: while a request is in flight only the latest slide waits,
   * and a slide the api already has is not sent. Nothing is sent unless this tab presents.
   */
  sendSlide(slide: PresentSlide) {
    this.wantSlide = slide
    this.pumpSlides()
  }

  private pumpSlides() {
    // A failed send waits for its retry (the network is down; the latest slide goes then).
    if (this.sending || this.retryTimer || !this.wantSlide || this.disposed) return
    const p = this.presentation.get()
    if (!p || p.presenter.userId !== this.deps.userId || p.tab !== this.deps.tab) {
      this.wantSlide = null
      return
    }
    const slide = this.wantSlide
    this.wantSlide = null
    if (sameSlide(p, slide)) return
    this.sending = true
    this.deps
      .request('POST', `${this.base}/slide`, {
        body: { id: p.id, tab: this.deps.tab, ...slide },
        schema: PresentLiveState,
      })
      .then(
        (s) => {
          this.apply(s)
        },
        (e) => {
          const r = resultOf(e)
          if (!r.ok && (r.code === 'NETWORK' || r.code.startsWith('HTTP_5') || r.code === 'RATE_LIMITED')) {
            // Not delivered: the latest slide goes again shortly (unless a newer one is already waiting).
            this.wantSlide ??= slide
            if (!this.retryTimer)
              this.retryTimer = this.timeout(() => {
                this.retryTimer = null
                this.pumpSlides()
              }, SLIDE_RETRY_MS)
          } else void this.refresh()
        },
      )
      .finally(() => {
        this.sending = false
        this.pumpSlides()
      })
  }

  // ---- lifetime -----------------------------------------------------------------------------------------

  private clearRestart() {
    this.clear(this.restartTimer)
    this.restartTimer = null
    this.restartLost.set(null)
  }

  private clear(handle: unknown) {
    if (!handle) return
    if (this.deps.clearTimeout) this.deps.clearTimeout(handle)
    else clearTimeout(handle as ReturnType<typeof setTimeout>)
  }

  private timeout(fn: () => void, ms: number): unknown {
    return this.deps.setTimeout ? this.deps.setTimeout(fn, ms) : setTimeout(fn, ms)
  }

  dispose() {
    this.disposed = true
    for (const off of this.offs.splice(0)) off()
    this.clear(this.restartTimer)
    this.clear(this.retryTimer)
  }
}
