// OWNER: WS4 (wave V, breakouts). One board page's breakout state: what GET /api/boards/:bid/breakouts last said,
// replaced by every `workshop.breakout` event and every action's answer that is not older (contracts
// isNewerBreakoutState), refetched on every (re)connect of the board's event stream. The store decides nothing the
// api decides: `canManage` and `myGroupId` come from the api (an event carries the members, from which this page reads
// its own group; a new session is refetched for the caller's own view).
//
// It also hands on what the page acts on: this person's group changed (the camera goes to its frame), a broadcast
// that reached this page (a toast) and a group summon this page obeys (follow the summoner): only a summon of this
// person's own group in this session, never their own (contracts breakoutSummonApplies: the web half of "follow never
// leaks across groups"; the api already sends a group's summon to that group's streams only).
import {
  BREAKOUT_EVENTS,
  type BreakoutState,
  breakoutSummonApplies,
  isNewerBreakoutState,
  WorkshopBreakoutBroadcastEvent,
  WorkshopBreakoutEvent,
  WorkshopBreakoutSummonEvent,
} from '@draftroom/contracts'
import { type Atom, atom } from '../../lib/signals.ts'
import type { BreakoutsClient, Outcome } from './client.ts'

export interface BreakoutStoreDeps {
  readonly client: BreakoutsClient
  readonly boardId: string
  readonly userId: string
  readonly events: {
    on(type: string, listener: (data: unknown) => void): () => void
    onResync(listener: () => void): () => void
  }
  /** this person is now in `groupId` of session `sessionId` (a new session, or moved): the camera goes there */
  onMyGroup?(state: BreakoutState, groupId: string): void
  onBroadcast?(event: WorkshopBreakoutBroadcastEvent): void
  onSummon?(event: WorkshopBreakoutSummonEvent): void
  now?(): number
}

export class BreakoutStore {
  /** the last state (null: none yet, or the api has no breakouts) */
  readonly state: Atom<BreakoutState | null>
  /** false once the api answered that it has no breakouts here (its switch off: a 404) */
  readonly available: Atom<boolean>
  /** this page saw the current session running (the chip says "Breakouts ended" only then) */
  readonly sawRunning: Atom<boolean>
  private offset = 0
  private readonly offs: (() => void)[] = []
  private lastGroupKey: string | null = null
  private inflight: AbortController | null = null
  private closed = false
  private readonly now: () => number
  private readonly deps: BreakoutStoreDeps

  constructor(deps: BreakoutStoreDeps) {
    this.deps = deps
    this.state = atom<BreakoutState | null>('lobby-breakouts-state', null)
    this.available = atom('lobby-breakouts-available', true)
    this.sawRunning = atom('lobby-breakouts-saw-running', false)
    this.now = deps.now ?? Date.now
  }

  /** Listens to the board's events and reads the state (now and on every reconnect). */
  connect(): () => void {
    const { events } = this.deps
    this.offs.push(
      events.on(BREAKOUT_EVENTS.state, (data) => {
        const p = WorkshopBreakoutEvent.safeParse(data)
        if (p.success) this.fromEvent(p.data)
      }),
      events.on(BREAKOUT_EVENTS.broadcast, (data) => {
        const p = WorkshopBreakoutBroadcastEvent.safeParse(data)
        if (!p.success) return
        // only one of this page's session (the api sends a group's line to that group only)
        const s = this.state.get()?.session
        if (s && p.data.sessionId !== s.id) return
        this.deps.onBroadcast?.(p.data)
      }),
      events.on(BREAKOUT_EVENTS.summon, (data) => {
        const p = WorkshopBreakoutSummonEvent.safeParse(data)
        if (!p.success) return
        if (!breakoutSummonApplies(p.data, this.self())) return
        this.deps.onSummon?.(p.data)
      }),
      events.onResync(() => void this.refresh()),
    )
    return () => this.close()
  }

  close(): void {
    this.closed = true
    this.inflight?.abort()
    for (const off of this.offs.splice(0)) off()
  }

  /** Who this page is, for breakoutSummonApplies. */
  self(): { userId: string; sessionId: string | null; groupId: string | null } {
    const s = this.state.get()
    const running = s?.session?.status === 'running'
    return {
      userId: this.deps.userId,
      sessionId: running ? (s?.session?.id ?? null) : null,
      groupId: running ? (s?.myGroupId ?? null) : null,
    }
  }

  /** The server's clock now (ms), from the last answer's serverNow. */
  serverNow(): number {
    return this.now() + this.offset
  }

  async refresh(): Promise<void> {
    if (this.closed) return
    this.inflight?.abort()
    const ctl = new AbortController()
    this.inflight = ctl
    const out = await this.deps.client.state(this.deps.boardId, ctl.signal)
    if (ctl.signal.aborted || this.closed) return
    this.inflight = null
    if (out.ok) this.accept(out.value)
    else if (out.unavailable) {
      this.available.set(false)
      this.state.set(null)
    }
  }

  /** An answer of the api (GET or an action): taken unless it is older than what this page has. */
  accept(next: BreakoutState): void {
    const t = Date.parse(next.serverNow)
    if (Number.isFinite(t)) this.offset = t - this.now()
    this.available.set(true)
    if (!isNewerBreakoutState(this.state.get(), next)) return
    this.set(next)
  }

  private fromEvent(ev: WorkshopBreakoutEvent): void {
    const cur = this.state.get()
    const sameSession = !!cur?.session && !!ev.session && cur.session.id === ev.session.id
    if (!sameSession) {
      // a new session (or none): this person's own view (their group, whether they manage it) is the api's
      void this.refresh()
      return
    }
    if (!isNewerBreakoutState(cur, ev)) return
    const running = ev.session?.status === 'running'
    const mine = ev.members.find((m) => m.userId === this.deps.userId)?.groupId ?? null
    this.set({
      session: ev.session,
      members: ev.members,
      myGroupId: running ? mine : null,
      canManage: running && (cur?.canManage ?? false),
      serverNow: new Date(this.serverNow()).toISOString(),
    })
  }

  private set(next: BreakoutState): void {
    const prev = this.state.get()
    if (prev?.session?.id !== next.session?.id) this.sawRunning.set(false)
    if (next.session?.status === 'running') this.sawRunning.set(true)
    this.state.set(next)
    const key =
      next.session?.status === 'running' && next.myGroupId ? `${next.session.id}/${next.myGroupId}` : null
    if (key && key !== this.lastGroupKey) {
      this.lastGroupKey = key
      this.deps.onMyGroup?.(next, next.myGroupId as string)
    } else if (!key) this.lastGroupKey = null
  }

  // ---- actions (each answer replaces the state; the api decides) --------------------------------------------------

  private async act(fn: () => Promise<Outcome<BreakoutState>>): Promise<Outcome<BreakoutState>> {
    const out = await fn()
    if (out.ok) this.accept(out.value)
    else if (out.code === 'BREAKOUTS_ENDED' || out.code === 'BREAKOUTS_RUNNING') void this.refresh()
    return out
  }

  private sessionId(): string {
    return this.state.get()?.session?.id ?? ''
  }

  start(input: Parameters<BreakoutsClient['start']>[1]) {
    return this.act(() => this.deps.client.start(this.deps.boardId, input))
  }
  assign(moves: Parameters<BreakoutsClient['assign']>[1]) {
    return this.act(() => this.deps.client.assign(this.sessionId(), moves))
  }
  shuffle() {
    return this.act(() => this.deps.client.shuffle(this.sessionId()))
  }
  join(groupId: string) {
    return this.act(() => this.deps.client.join(this.sessionId(), groupId))
  }
  extend(addMs: number) {
    return this.act(() => this.deps.client.extend(this.sessionId(), addMs))
  }
  end() {
    return this.act(() => this.deps.client.end(this.sessionId()))
  }
  broadcast(text: string, groupId: string | null) {
    return this.deps.client.broadcast(this.sessionId(), { text, groupId })
  }
  summon(groupId: string, screen?: { w: number; h: number }) {
    return this.deps.client.summon(this.sessionId(), { groupId, ...(screen ? { screen } : {}) })
  }
}

// One store per board page (canvas), made when the feature mounts.
const stores = new WeakMap<object, BreakoutStore>()
export const breakoutStoreOf = (canvas: object): BreakoutStore | null => stores.get(canvas) ?? null
export function setBreakoutStore(canvas: object, store: BreakoutStore | null): void {
  if (store) stores.set(canvas, store)
  else stores.delete(canvas)
}
