// K3 (wave K): a board-page context for rendering the workshops UI in Node tests (react-dom/server): an
// in-memory canvas (./test-kit.ts), a fake event stream, and an api whose answers the test sets
// (`serve`), recorded in `calls`. The stores are the real ones (storeFor / privateStoreFor), fed by them.
import {
  PrivateBrainstormState,
  type WorkshopState,
  WorkshopState as WorkshopStateSchema,
} from '@draftroom/contracts'
import type { z } from 'zod'
import type { CanvasElement, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import type { WorkshopStore } from '../store.ts'
import { storeFor } from '../workshop-context.ts'
import { fakeCanvas } from './test-kit.ts'

export const ME = 'usr_facilitator0001'
export const BOARD = 'b-k3kit00001'

export class KitEvents {
  readonly listeners = new Map<string, Set<(d: unknown) => void>>()
  readonly resync = new Set<() => void>()
  on(type: string, l: (d: unknown) => void) {
    const s = this.listeners.get(type) ?? new Set()
    s.add(l)
    this.listeners.set(type, s)
    return () => void s.delete(l)
  }
  onResync(l: () => void) {
    this.resync.add(l)
    return () => void this.resync.delete(l)
  }
  onAccessLost() {
    return () => {}
  }
  close() {}
  serverOffsetMs() {
    return 0
  }
  emit(type: string, data: unknown) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(data)
  }
}

export interface KitOptions {
  role?: 'owner' | 'editor' | 'commenter' | 'viewer'
  userId?: string
  /** the board's elements (the in-memory canvas) */
  elements?: CanvasElement[]
  /** who else is on the board (roster entries: canvas.collaborators()) */
  others?: { uid: string; name: string; role?: string; guest?: boolean }[]
  activePanel?: string | null
}

export interface Kit {
  ctx: CanvasFeatureContext
  store: WorkshopStore
  events: KitEvents
  calls: { method: string; path: string; body?: unknown }[]
  /** what GET /workshop answers (z.input: hands may be left out) */
  workshop: z.input<typeof WorkshopStateSchema>
  /** answer the next matching request with this (once), else the defaults */
  next(match: (method: string, path: string) => boolean, answer: (body: unknown) => unknown): void
  /** the panel ids `ctx.openPanel` was asked for */
  panels: (string | null)[]
}

export function workshopKit(opts: KitOptions = {}): Kit {
  const events = new KitEvents()
  const calls: Kit['calls'] = []
  const handlers: { match: (m: string, p: string) => boolean; answer: (b: unknown) => unknown }[] = []
  const kit = {
    workshop: { timer: null, vote: null, serverNow: new Date().toISOString() },
  } as Kit
  const request = async (method: string, path: string, o: { body?: unknown; schema: unknown }) => {
    calls.push({ method, path, body: o.body })
    const at = handlers.findIndex((h) => h.match(method, path))
    const parse = (v: unknown) => {
      const schema = o.schema as { parse(v: unknown): unknown } | null
      return schema ? schema.parse(v) : undefined
    }
    if (at >= 0) {
      const [h] = handlers.splice(at, 1)
      return parse(h?.answer(o.body))
    }
    if (method === 'GET' && path.endsWith('/workshop')) return parse(kit.workshop)
    if (method === 'GET' && path.endsWith('/private-brainstorm'))
      return parse(
        PrivateBrainstormState.parse({
          session: null,
          counts: { notes: 0, people: 0 },
          myNotes: [],
          canReveal: false,
        }),
      )
    if (method === 'GET' && path.endsWith('/votes')) return parse({ sessions: [] })
    throw new Error(`unexpected ${method} ${path}`)
  }
  const fake = fakeCanvas(opts.elements ?? [])
  const userId = opts.userId ?? ME
  const roster = [
    {
      uid: userId,
      sid: 'sid-me',
      name: 'Fay Facilitator',
      color: '#1d4ed8',
      guest: false,
      role: opts.role ?? 'owner',
    },
    ...(opts.others ?? []).map((o, i) => ({
      uid: o.uid,
      sid: `sid-${i}`,
      name: o.name,
      color: '#047857',
      guest: o.guest ?? false,
      role: o.role ?? 'editor',
    })),
  ]
  const canvas = Object.assign(fake.canvas, {
    collaborators: () => roster,
    presence: { peers: () => [], peer: () => null },
    editingId: () => null,
    tool: () => 'select',
    theme: () => 'light',
    saveStatus: () => ({ state: 'saved' }),
    on: () => () => {},
  })
  const panels: (string | null)[] = []
  const ctx = {
    board: { id: BOARD, title: 'Kit board', status: 'active' },
    role: opts.role ?? 'owner',
    me: { user: { id: userId, name: 'Fay Facilitator', color: '#1d4ed8' } },
    workspace: { id: 'ws_kit', name: 'Kit' },
    api: { request },
    events,
    canvas,
    notify: () => {},
    dismiss: () => {},
    openPanel: (id: string | null) => panels.push(id),
    activePanel: opts.activePanel ?? null,
  } as unknown as CanvasFeatureContext
  kit.ctx = ctx
  kit.events = events
  kit.calls = calls
  kit.panels = panels
  kit.next = (match, answer) => handlers.push({ match, answer })
  kit.store = storeFor(ctx)
  return kit
}

/** The kit's /workshop answer set and loaded into the store. */
export async function loadWorkshop(
  kit: Kit,
  state: z.input<typeof WorkshopStateSchema>,
): Promise<WorkshopState> {
  kit.workshop = state
  await kit.store.refresh()
  return WorkshopStateSchema.parse(state)
}
