// Client state for private brainstorming (docs/WAVE3-CONTRACTS.md "private-notes"): one store per
// open board (per event stream), shared by the top-bar chip, the setup dialog and the "Private notes"
// panel. Framework-free (React subscribes through useSyncExternalStore), so it is unit-tested in Node.
//
// Authority: the API. The only draft texts this store ever holds are the caller's own (`myNotes`, from
// the caller's own responses); events carry the session and counts only, so a new or changed session
// triggers a refetch of the caller's own view, and every (re)connect refetches.

import {
  type AddPrivateNoteInput,
  PRIVATE_NOTES_EVENTS,
  type PrivateBrainstorm,
  PrivateBrainstormEvent,
  PrivateBrainstormState,
  type PrivateCounts,
  type PrivateNote,
  type StartPrivateBrainstormInput,
  type UpdatePrivateNoteInput,
} from '@draftroom/contracts'
import type { z } from 'zod'

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
/** The subset of ApiClient['request'] the store needs (tests pass a fake). */
export type RequestFn = <S extends z.ZodType | null>(
  method: Method,
  path: string,
  opts: { body?: unknown; schema: S },
) => Promise<S extends z.ZodType ? z.output<S> : undefined>

/** The subset of BoardEvents the store needs. */
export interface EventSource {
  on(type: string, listener: (data: unknown) => void): () => void
  onResync(listener: () => void): () => void
}

export interface ActionResult {
  ok: boolean
  /** User-safe message when !ok. */
  error?: string
  code?: string
}

export interface PrivateNotesSnapshot {
  loaded: boolean
  /** The last refresh failed (the UI keeps showing the previous state). */
  stale: boolean
  /** The board's active session (open or revealed), else null. */
  session: PrivateBrainstorm | null
  counts: PrivateCounts
  /** The caller's own drafts (nobody else's ever reach this store). */
  myNotes: PrivateNote[]
  canReveal: boolean
  /** The starter can no longer edit the board, so this person may end it (SEAM-07; editors only). */
  starterLeft: boolean
  /** The start dialog is open (from the top bar or the panel). */
  setupOpen: boolean
  /** A reveal or cancel sent from this tab is in flight. */
  busy: 'reveal' | 'cancel' | null
  /**
   * An open session someone else started, which this person has not written in or dismissed yet
   * (final review R2/R4): the canvas asks them to add their notes. Once per session per tab.
   */
  startNews: { sessionId: string } | null
  /**
   * The last session that ended while this tab watched it (placed or cancelled), until another one
   * starts: the panel says where its notes went instead of the intro (final review R2-03).
   */
  lastEnded: PrivateBrainstorm | null
  /** Bumped by requestComposeFocus: the composer takes the keyboard when it sees a new value. */
  composeFocus: number
}

/** A session that ended while this tab watched it (placed on the board, or cancelled). */
export interface SessionEnded {
  session: PrivateBrainstorm
  /** This tab asked for the reveal (it measures the notes' text afterwards, see fit.ts). */
  revealedHere: boolean
  /** This tab asked for the reveal or the cancel (it tidies up the empty frame it made, R2-01). */
  endedHere: boolean
}

/** How long a "focus the composer" request waits for the composer to appear. */
const COMPOSE_FOCUS_MS = 3_000

const ZERO: PrivateCounts = { notes: 0, people: 0 }
/** The board event the sharing feature publishes when grants, links or guests change. */
const SHARING_CHANGED = 'sharing.changed'

const errorOf = (e: unknown): ActionResult => {
  const err = e as { message?: unknown; code?: unknown } | null
  return {
    ok: false,
    error: typeof err?.message === 'string' && err.message ? err.message : 'That did not work. Try again.',
    code: typeof err?.code === 'string' ? err.code : undefined,
  }
}

const ended = (s: PrivateBrainstorm) => s.status === 'placed' || s.status === 'cancelled'

export class PrivateNotesStore {
  private readonly boardId: string
  private readonly request: RequestFn
  /** The signed-in person (the starter is never asked to add notes to their own session). */
  private readonly userId: string | null
  /** Sessions this tab already asked the person to write in (or that they started). */
  private readonly startSeen = new Set<string>()
  private startNews: PrivateNotesSnapshot['startNews'] = null
  private state: PrivateBrainstormState | null = null
  private loaded = false
  private stale = false
  private setupOpen = false
  private busy: PrivateNotesSnapshot['busy'] = null
  private seq = 0
  private appliedSeq = 0
  /** Sessions whose end was already announced (the event and a response can both report it). */
  private readonly announced = new Set<string>()
  private readonly revealedHere = new Set<string>()
  private readonly cancelledHere = new Set<string>()
  private lastEnded: PrivateBrainstorm | null = null
  private composeFocus = 0
  private composeFocusTaken = 0
  private composeFocusAt = 0
  private readonly listeners = new Set<() => void>()
  private readonly endListeners = new Set<(e: SessionEnded) => void>()
  private readonly unsubscribers: (() => void)[] = []
  private snap: PrivateNotesSnapshot

  constructor(deps: { boardId: string; request: RequestFn; events: EventSource; userId?: string }) {
    this.boardId = deps.boardId
    this.request = deps.request
    this.userId = deps.userId ?? null
    this.snap = this.compute()
    this.unsubscribers.push(
      deps.events.on(PRIVATE_NOTES_EVENTS.changed, (d) => this.onEvent(d)),
      deps.events.onResync(() => void this.refresh()),
      // Who may reveal depends on the people on the board: the starter can lose edit access or leave
      // (a guest who signed out), and then any editor with an account may end the session (SEAM-07).
      deps.events.on(SHARING_CHANGED, () => {
        if (this.state?.session) void this.refresh()
      }),
    )
  }

  dispose() {
    for (const u of this.unsubscribers.splice(0)) u()
    this.listeners.clear()
    this.endListeners.clear()
  }

  // ---- subscription ----------------------------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  getSnapshot = () => this.snap

  /** Called once per session that ends while this tab has the board open. */
  onSessionEnded(fn: (e: SessionEnded) => void): () => void {
    this.endListeners.add(fn)
    return () => void this.endListeners.delete(fn)
  }

  private emit() {
    this.snap = this.compute()
    for (const l of [...this.listeners]) l()
  }

  private compute(): PrivateNotesSnapshot {
    const s = this.state
    return {
      loaded: this.loaded,
      stale: this.stale,
      session: s?.session ?? null,
      counts: s?.counts ?? ZERO,
      myNotes: s?.myNotes ?? [],
      canReveal: s?.canReveal ?? false,
      starterLeft: s?.starterLeft ?? false,
      setupOpen: this.setupOpen,
      busy: this.busy,
      startNews: this.startNews,
      lastEnded: this.lastEnded,
      composeFocus: this.composeFocus,
    }
  }

  /**
   * Whether to ask this person to write (R2/R4): the first time this tab sees an open session that
   * someone else started and in which they have written nothing. Their own session, a session they
   * already wrote in, or one they already answered never asks again.
   */
  private noticeStart(s: PrivateBrainstormState) {
    const session = s.session
    if (this.startNews && this.startNews.sessionId !== session?.id) this.startNews = null
    if (session?.status !== 'open' || this.startSeen.has(session.id)) return
    this.startSeen.add(session.id)
    if (session.createdBy === this.userId || s.myNotes.length > 0) return
    this.startNews = { sessionId: session.id }
  }

  /** The person answered the "add your notes" prompt (or opened the panel). */
  dismissStartNews() {
    if (!this.startNews) return
    this.startNews = null
    this.emit()
  }

  private announceEnd(session: PrivateBrainstorm) {
    if (this.announced.has(session.id)) return
    this.announced.add(session.id)
    this.lastEnded = session
    this.emit()
    const revealedHere = this.revealedHere.has(session.id)
    const e: SessionEnded = {
      session,
      revealedHere,
      endedHere: revealedHere || this.cancelledHere.has(session.id),
    }
    for (const l of [...this.endListeners]) {
      try {
        l(e)
      } catch (err) {
        console.error('private-notes end listener failed', err)
      }
    }
  }

  // ---- loading and events ------------------------------------------------------------------------

  private path = (p: string) => `/api/boards/${encodeURIComponent(this.boardId)}${p}`

  async refresh(): Promise<void> {
    const seq = ++this.seq
    try {
      const s = await this.request('GET', this.path('/private-brainstorm'), {
        schema: PrivateBrainstormState,
      })
      this.apply(s, seq)
      this.stale = false
    } catch {
      this.stale = true
    }
    this.emit()
  }

  /** Applies a state from any response, unless a newer request's answer is already in. */
  private apply(s: PrivateBrainstormState, seq: number) {
    if (seq < this.appliedSeq) return
    this.appliedSeq = seq
    this.state = s
    this.loaded = true
    if (s.session && s.session.id !== this.lastEnded?.id) this.lastEnded = null
    this.noticeStart(s)
    if (s.placed) this.announceEnd(s.placed)
  }

  private onEvent(data: unknown) {
    const p = PrivateBrainstormEvent.safeParse(data)
    if (!p.success) return
    const { session, counts } = p.data
    const current = this.state?.session ?? null
    if (ended(session)) {
      if (current?.id === session.id && this.state) {
        this.state = {
          ...this.state,
          session: null,
          counts: ZERO,
          myNotes: [],
          canReveal: false,
          starterLeft: false,
        }
        this.emit()
      }
      this.announceEnd(session)
      return
    }
    // A new session, or a status change (reveal): refetch this person's own view (drafts, rights).
    if (!this.state || current?.id !== session.id || current.status !== session.status) {
      void this.refresh()
      return
    }
    this.state = { ...this.state, session, counts }
    this.emit()
  }

  // ---- actions -------------------------------------------------------------------------------------

  private async mutate(method: Method, path: string, body?: unknown): Promise<ActionResult> {
    const seq = ++this.seq
    try {
      const s = await this.request(method, path, { body, schema: PrivateBrainstormState })
      this.apply(s, seq)
      this.emit()
      return { ok: true }
    } catch (e) {
      const r = errorOf(e)
      // The session moved on under us (revealed, ended, someone else started one): show what is true.
      if (r.code && r.code !== 'RATE_LIMITED' && r.code !== 'BAD_REQUEST') void this.refresh()
      return r
    }
  }

  start(input: StartPrivateBrainstormInput): Promise<ActionResult> {
    return this.mutate('POST', this.path('/private-brainstorm'), input)
  }

  private sessionPath(action: string): string | null {
    const sid = this.state?.session?.id
    return sid ? `/api/private-brainstorms/${encodeURIComponent(sid)}/${action}` : null
  }

  addNote(input: AddPrivateNoteInput): Promise<ActionResult> {
    const path = this.sessionPath('notes')
    if (!path) return Promise.resolve({ ok: false, error: 'There is no private brainstorm right now.' })
    return this.mutate('POST', path, input)
  }

  updateNote(id: string, patch: UpdatePrivateNoteInput): Promise<ActionResult> {
    return this.mutate('PATCH', `/api/private-notes/${encodeURIComponent(id)}`, patch)
  }

  deleteNote(id: string): Promise<ActionResult> {
    return this.mutate('DELETE', `/api/private-notes/${encodeURIComponent(id)}`)
  }

  /** Reveal, and "Place notes" when an earlier placement failed (the same idempotent request). */
  reveal(): Promise<ActionResult> {
    return this.finish('reveal')
  }

  cancel(): Promise<ActionResult> {
    return this.finish('cancel')
  }

  private async finish(action: 'reveal' | 'cancel'): Promise<ActionResult> {
    const sid = this.state?.session?.id
    const path = this.sessionPath(action)
    if (!sid || !path) return { ok: false, error: 'There is no private brainstorm right now.' }
    if (this.busy) return { ok: false, error: 'One moment: the last request is still running.' }
    if (action === 'reveal') this.revealedHere.add(sid)
    else this.cancelledHere.add(sid)
    this.busy = action
    this.emit()
    try {
      return await this.mutate('POST', path)
    } finally {
      this.busy = null
      this.emit()
    }
  }

  /**
   * "Add your notes" (the start prompt, the top-bar chip): the composer takes the keyboard as the
   * panel opens, so typing goes into the note and never into the board's shortcuts (A11Y2-01).
   */
  requestComposeFocus(now = Date.now()) {
    this.composeFocus++
    this.composeFocusAt = now
    this.emit()
  }

  /**
   * True once per requestComposeFocus, shortly after it: the composer that takes the keyboard for it.
   * A request nobody took at once (no composer: the person's notes are full) never fires later.
   */
  takeComposeFocus(now = Date.now()): boolean {
    if (this.composeFocusTaken >= this.composeFocus) return false
    this.composeFocusTaken = this.composeFocus
    return now - this.composeFocusAt <= COMPOSE_FOCUS_MS
  }

  setSetupOpen(open: boolean) {
    if (this.setupOpen === open) return
    this.setupOpen = open
    this.emit()
  }
}

const stores = new WeakMap<object, PrivateNotesStore>()

/** One store per board event stream (stable for the board session), created on first use. */
export function privateNotesStoreFor(
  events: EventSource & object,
  make: () => PrivateNotesStore,
): PrivateNotesStore {
  let s = stores.get(events)
  if (!s) {
    s = make()
    stores.set(events, s)
    void s.refresh()
  }
  return s
}
