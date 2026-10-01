// The workshop state the spike features read (docs/EXCALIDRAW-MIGRATION.md §4.4; checks R2, F13, B12):
// the open dot vote with my ballot, and the shared timer, from `GET /api/boards/:bid/workshop` and the
// board event stream (`workshop.vote`, `workshop.timer`). Votes are cast through the api (never on the
// canvas); the api tells sync when a vote opens or closes (A2), so sync refuses +1s meanwhile.
import {
  WORKSHOP_EVENTS,
  type WorkshopState,
  type WorkshopTimer,
  type WorkshopVoteState,
} from '@draftroom/contracts'
import type { FeatureRuntime } from './runtime.ts'

type Listener = () => void

export class WorkshopStore {
  private readonly rt: FeatureRuntime
  private vote: WorkshopVoteState | null = null
  private timer: WorkshopTimer | null = null
  /** server clock minus ours (ms), from the last state read */
  private skew = 0
  private readonly listeners = new Set<Listener>()
  private offs: (() => void)[] = []
  private loading: Promise<void> | null = null
  private loadedOnce = false

  constructor(rt: FeatureRuntime) {
    this.rt = rt
  }

  start(): void {
    if (!this.rt.boardId) return
    void this.refresh()
    // Events carry aggregates; my ballot and the session come from a fresh read (cheap, one GET).
    this.offs.push(this.rt.onEvent(WORKSHOP_EVENTS.vote, () => void this.refresh()))
    this.offs.push(this.rt.onEvent(WORKSHOP_EVENTS.results, () => void this.refresh()))
    this.offs.push(this.rt.onEvent(WORKSHOP_EVENTS.timer, () => void this.refresh()))
    this.offs.push(this.rt.onEvent('hello', () => void this.refresh()))
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off()
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  private emit() {
    for (const l of [...this.listeners]) l()
  }

  get ready(): boolean {
    return this.loadedOnce
  }
  get voteState(): WorkshopVoteState | null {
    return this.vote
  }
  /** The open vote (not closed, not revealed), or null. */
  get openVote(): WorkshopVoteState | null {
    return this.vote && this.vote.session.status === 'open' ? this.vote : null
  }
  get timerState(): WorkshopTimer | null {
    return this.timer
  }
  /** Remaining timer ms now (a running timer counts down from `endsAt` on the server's clock). */
  remainingMs(now = Date.now()): number | null {
    const t = this.timer
    if (!t || t.status === 'stopped') return null
    if (t.status === 'finished') return 0
    if (t.status === 'running' && t.endsAt) return Math.max(0, Date.parse(t.endsAt) - (now + this.skew))
    return t.remainingMs
  }

  refresh(): Promise<void> {
    if (!this.rt.boardId) return Promise.resolve()
    if (this.loading) return this.loading
    const bid = encodeURIComponent(this.rt.boardId)
    this.loading = this.rt
      .request<WorkshopState>('GET', `/api/boards/${bid}/workshop`)
      .then((s) => {
        this.vote = s.vote
        this.timer = s.timer
        this.skew = Date.parse(s.serverNow) - Date.now()
        this.loadedOnce = true
        this.emit()
      })
      .catch(() => {})
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }

  /** Casts (+1) or takes back (-1) one of my dots on `shapeRef` (`shape:<elementId>`). */
  async cast(shapeRef: string, delta: 1 | -1): Promise<{ ok: true } | { ok: false; code: string }> {
    const v = this.openVote
    if (!v) return { ok: false, code: 'NO_VOTE' }
    try {
      this.vote = await this.rt.request<WorkshopVoteState>('POST', `/api/votes/${v.session.id}/cast`, {
        shapeId: shapeRef,
        delta,
      })
      this.emit()
      return { ok: true }
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? 'ERROR' }
    }
  }

  /** Facilitators: start a board-wide vote (5 dots) or end the open one. */
  async startVote(opts: { votesPerPerson?: number; shapeTypes?: string[] } = {}): Promise<void> {
    if (!this.rt.boardId) return
    this.vote = await this.rt.request<WorkshopVoteState>(
      'POST',
      `/api/boards/${encodeURIComponent(this.rt.boardId)}/votes`,
      {
        title: 'Dot vote',
        votesPerPerson: opts.votesPerPerson ?? 5,
        onePerObject: false,
        scope: 'board',
        ...(opts.shapeTypes ? { shapeTypes: opts.shapeTypes } : {}),
      },
    )
    this.emit()
  }
  async closeVote(): Promise<void> {
    const v = this.openVote
    if (!v) return
    this.vote = await this.rt.request<WorkshopVoteState>('POST', `/api/votes/${v.session.id}/close`)
    this.emit()
  }

  /** Facilitators: start (or stop) the shared timer. */
  async timerAction(action: { action: 'start'; durationMs: number } | { action: 'stop' }): Promise<void> {
    if (!this.rt.boardId) return
    const r = await this.rt.request<{ timer: WorkshopTimer | null; serverNow: string }>(
      'POST',
      `/api/boards/${encodeURIComponent(this.rt.boardId)}/timer`,
      action,
    )
    this.timer = r.timer
    this.skew = Date.parse(r.serverNow) - Date.now()
    this.emit()
  }
}

/** mm:ss of a duration (ceil to the second, as a countdown shows it). */
export function formatCountdown(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
