// The shared runtime of O5's spike B features: the board id, who I am (from the sync `welcome`), a small
// same-origin api client, one board event stream (SSE) shared by the features, and a toast. Features
// write the canvas only through `CanvasPort.transact` (and doc keys through the engine core's `setDoc`,
// the CR on sync/types.ts), and talk to the api only through `/api` on the page's own origin.
import type { CanvasPort } from '../../port.ts'
import type { CanvasRegistries } from '../../registries.ts'

export interface Me {
  readonly uid: string
  readonly name: string
  readonly role: 'owner' | 'editor' | 'commenter' | 'viewer'
  readonly guest: boolean
}

export class SpikeApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface BoardEvent {
  readonly type: string
  readonly data: unknown
}

type Listener = () => void

export class FeatureRuntime {
  readonly port: CanvasPort
  readonly registries: CanvasRegistries
  readonly boardId: string | null
  private stream: EventSource | null = null
  private readonly eventListeners = new Map<string, Set<(data: unknown) => void>>()
  private readonly toastListeners = new Set<Listener>()
  private toastText: string | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(port: CanvasPort, registries: CanvasRegistries, boardId: string | null) {
    this.port = port
    this.registries = registries
    this.boardId = boardId
  }

  /** Who I am on this board (null before the sync `welcome`). */
  me(): Me | null {
    const you = this.port.engine?.welcome?.you
    return you ? { uid: you.uid, name: you.name, role: you.role, guest: you.guest } : null
  }

  /** Whether I may edit the canvas (owners and editors; commenters, viewers and limited guests may not). */
  canEdit(): boolean {
    const role = this.me()?.role
    return role === 'owner' || role === 'editor'
  }

  /** A facilitator: may start votes and the timer (an editor with an account, never a name-only guest). */
  canFacilitate(): boolean {
    const me = this.me()
    return !!me && !me.guest && (me.role === 'owner' || me.role === 'editor')
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error
      throw new SpikeApiError(
        res.status,
        err?.code ?? `HTTP_${res.status}`,
        err?.message ?? 'Request failed.',
      )
    }
    return json as T
  }

  /** Listens to one type of the board's event stream (opened on first use, shared). */
  onEvent(type: string, fn: (data: unknown) => void): () => void {
    const set = this.eventListeners.get(type) ?? new Set()
    set.add(fn)
    this.eventListeners.set(type, set)
    this.ensureStream()
    return () => set.delete(fn)
  }

  private ensureStream(): void {
    if (this.stream || this.disposed || !this.boardId || typeof EventSource !== 'function') return
    const es = new EventSource(`/api/boards/${encodeURIComponent(this.boardId)}/events`)
    es.onmessage = (m) => {
      let ev: BoardEvent | null = null
      try {
        ev = JSON.parse(m.data) as BoardEvent
      } catch {
        return
      }
      for (const fn of [...(this.eventListeners.get(ev.type) ?? [])]) fn(ev.data)
      for (const fn of [...(this.eventListeners.get('*') ?? [])]) fn(ev)
    }
    this.stream = es
  }

  /** A short status line (the features' toasts: "+1 is off while a vote runs", "Voted", …). */
  toast(text: string): void {
    this.toastText = text
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      this.toastText = null
      for (const l of [...this.toastListeners]) l()
    }, 2_500)
    for (const l of [...this.toastListeners]) l()
  }
  currentToast(): string | null {
    return this.toastText
  }
  onToast(l: Listener): () => void {
    this.toastListeners.add(l)
    return () => this.toastListeners.delete(l)
  }

  dispose(): void {
    this.disposed = true
    this.stream?.close()
    this.stream = null
    this.eventListeners.clear()
    if (this.toastTimer) clearTimeout(this.toastTimer)
  }
}

/** `/b/:boardId` of the page URL, or null. */
export function boardIdFromPath(pathname: string): string | null {
  const m = /^\/b\/([a-z0-9][a-z0-9_-]{2,63})(?:\/|$)/.exec(pathname)
  return m?.[1] ?? null
}
