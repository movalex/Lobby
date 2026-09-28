// Records and an in-process protocol client for the "Recently deleted" and backup tests. Every record
// is validated against the shared schema at creation, so a schema change breaks fixtures loudly.
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLSocketRoom } from '@tldraw/sync-core'
import {
  createBindingId,
  createShapeId,
  type TLBinding,
  type TLRecord,
  type TLShape,
  toRichText,
} from '@tldraw/tlschema'
import type { SessionMeta } from '../../src/rooms.ts'

export const PAGE = 'page:page'

const base = (id: string, type: string, over: Partial<TLShape> = {}) => ({
  id: id.startsWith('shape:') ? id : createShapeId(id),
  typeName: 'shape',
  type,
  x: 0,
  y: 0,
  rotation: 0,
  index: 'a1',
  parentId: PAGE,
  isLocked: false,
  opacity: 1,
  meta: {},
  ...over,
})

const shape = (rec: object) => draftroomSchema.types.shape.validate(rec) as TLShape

export function note(id: string, text: string, over: Partial<TLShape> = {}): TLShape {
  return shape({
    ...base(id, 'note', over),
    props: {
      color: 'yellow',
      labelColor: 'black',
      size: 'm',
      font: 'draw',
      fontSizeAdjustment: 1,
      align: 'middle',
      verticalAlign: 'middle',
      growY: 0,
      url: '',
      richText: toRichText(text),
      scale: 1,
      textLastEditedBy: null,
    },
  })
}

export function geo(id: string, over: Partial<TLShape> = {}, text = ''): TLShape {
  return shape({
    ...base(id, 'geo', over),
    props: {
      geo: 'rectangle',
      dash: 'draw',
      url: '',
      w: 100,
      h: 100,
      growY: 0,
      scale: 1,
      flipX: false,
      flipY: false,
      labelColor: 'black',
      color: 'black',
      fill: 'none',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      richText: toRichText(text),
    },
  })
}

export function frame(id: string, name: string, over: Partial<TLShape> = {}): TLShape {
  return shape({ ...base(id, 'frame', over), props: { w: 400, h: 300, name, color: 'black' } })
}

export function group(id: string, over: Partial<TLShape> = {}): TLShape {
  return shape({ ...base(id, 'group', over), props: {} })
}

export function arrow(id: string, over: Partial<TLShape> = {}): TLShape {
  return shape({
    ...base(id, 'arrow', over),
    props: {
      kind: 'arc',
      labelColor: 'black',
      color: 'black',
      fill: 'none',
      dash: 'draw',
      size: 'm',
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      font: 'draw',
      start: { x: 0, y: 0 },
      end: { x: 200, y: 0 },
      bend: 0,
      richText: toRichText(''),
      labelPosition: 0.5,
      scale: 1,
      elbowMidPoint: 0.5,
    },
  })
}

export function arrowBinding(
  id: string,
  arrowId: string,
  toId: string,
  terminal: 'start' | 'end',
): TLBinding {
  return draftroomSchema.types.binding.validate({
    id: createBindingId(id),
    typeName: 'binding',
    type: 'arrow',
    fromId: arrowId,
    toId,
    meta: {},
    props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
  }) as TLBinding
}

type Room = TLSocketRoom<TLRecord, SessionMeta>
type Msg = { type: string; data?: unknown; clientClock?: number; action?: unknown; hydrationType?: string }

/** An in-process client speaking the sync protocol through the same entry points the server uses. */
export class RoomClient {
  readonly msgs: Msg[] = []
  readonly sessionId: string
  closed: { code?: number; reason?: string } | null = null
  private clock = 0
  private readonly room: Room
  constructor(room: Room, userId: string, opts: { tab?: string; readonly?: boolean; name?: string } = {}) {
    this.room = room
    this.sessionId = `${userId}:${opts.tab ?? 'tab1'}`
    room.handleSocketConnect({
      sessionId: this.sessionId,
      isReadonly: opts.readonly ?? false,
      meta: {
        userId,
        role: opts.readonly ? 'viewer' : 'editor',
        name: opts.name ?? userId,
        color: '#1d4ed8',
      },
      socket: {
        send: (d: string) => {
          this.msgs.push(JSON.parse(d))
        },
        close: (code?: number, reason?: string) => {
          this.closed = { code, reason }
        },
        get readyState() {
          return 1
        },
      },
    })
  }
  get events(): Msg[] {
    return this.msgs.flatMap((m) => (m.type === 'data' ? (m.data as Msg[]) : [m]))
  }
  async connect(lastServerClock = 0): Promise<Msg> {
    this.room.handleSocketMessage(
      this.sessionId,
      JSON.stringify({
        type: 'connect',
        connectRequestId: `c-${this.sessionId}`,
        lastServerClock,
        protocolVersion: 8, // TLSYNC_PROTOCOL_VERSION in 5.4.2
        schema: draftroomSchema.serialize(),
      }),
    )
    await until(() => this.msgs.some((m) => m.type === 'connect'))
    return this.msgs.find((m) => m.type === 'connect') as Msg
  }
  /** Pushes a document diff; resolves with the server's push_result action (or 'closed'). */
  async push(diff: Record<string, unknown>): Promise<unknown> {
    const clientClock = ++this.clock
    this.room.handleSocketMessage(this.sessionId, JSON.stringify({ type: 'push', clientClock, diff }))
    await until(
      () =>
        this.closed !== null ||
        this.events.some((e) => e.type === 'push_result' && e.clientClock === clientClock),
    )
    return (
      this.events.find((e) => e.type === 'push_result' && e.clientClock === clientClock)?.action ?? 'closed'
    )
  }
  put(...records: TLRecord[]) {
    return this.push(Object.fromEntries(records.map((r) => [r.id, ['put', r]])))
  }
  remove(...ids: string[]) {
    return this.push(Object.fromEntries(ids.map((id) => [id, ['remove']])))
  }
}

export async function until(check: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** A distinct valid fractional index key per i (order does not matter to these tests). */
export function indexFor(i: number): TLShape['index'] {
  let n = i
  let digits = ''
  do {
    digits = B62[n % 62] + digits
    n = Math.floor(n / 62)
  } while (n > 0)
  return `a1${digits}V` as TLShape['index']
}
