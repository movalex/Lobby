import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLSocketRoom } from '@tldraw/sync-core'
import { type TLRecord, type TLShape, toRichText } from '@tldraw/tlschema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomRegistry, type SessionMeta } from '../../src/rooms.ts'
import { note } from './fixtures.ts'

type Room = TLSocketRoom<TLRecord, SessionMeta>
type Msg = { type: string; data?: unknown; clientClock?: number; action?: unknown }

/** An in-process client speaking the sync protocol to the room through the same entry points the server uses. */
class Client {
  readonly msgs: Msg[] = []
  readonly sessionId: string
  private clock = 0
  private readonly room: Room
  private open = true
  constructor(room: Room, userId: string, tab: string, isReadonly = false) {
    this.room = room
    this.sessionId = `${userId}:${tab}` // the server namespaces the tab id by user the same way
    room.handleSocketConnect({
      sessionId: this.sessionId,
      isReadonly,
      meta: { userId },
      socket: {
        send: (d: string) => {
          this.msgs.push(JSON.parse(d))
        },
        close: () => {
          this.open = false
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
  get custom(): unknown[] {
    return this.msgs.filter((m) => m.type === 'custom').map((m) => m.data)
  }
  get isOpen() {
    return this.open
  }
  async connect() {
    this.room.handleSocketMessage(
      this.sessionId,
      JSON.stringify({
        type: 'connect',
        connectRequestId: `c-${this.sessionId}`,
        lastServerClock: 0,
        protocolVersion: 8, // TLSYNC_PROTOCOL_VERSION in 5.4.2 (getTlsyncProtocolVersion is @internal)
        schema: draftroomSchema.serialize(),
      }),
    )
    await until(() => this.msgs.some((m) => m.type === 'connect'))
  }
  /** Pushes a document diff; resolves with the server's push_result action. */
  async push(diff: Record<string, unknown>): Promise<unknown> {
    const clientClock = ++this.clock
    this.room.handleSocketMessage(this.sessionId, JSON.stringify({ type: 'push', clientClock, diff }))
    await until(() => this.events.some((e) => e.type === 'push_result' && e.clientClock === clientClock))
    return this.events.find((e) => e.type === 'push_result' && e.clientClock === clientClock)?.action
  }
  setText(shape: TLShape, text: string) {
    return this.push({ [shape.id]: ['patch', { props: ['patch', { richText: ['put', toRichText(text)] }] }] })
  }
  move(shape: TLShape, x: number) {
    return this.push({ [shape.id]: ['patch', { x: ['put', x] }] })
  }
  remove(shape: TLShape) {
    return this.push({ [shape.id]: ['remove'] })
  }
  put(shape: TLShape) {
    return this.push({ [shape.id]: ['put', shape] })
  }
}

async function until(check: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const textOf = (room: Room, shape: TLShape) =>
  JSON.stringify((room.getRecord(shape.id) as TLShape | undefined)?.props)?.match(/"text":"([^"]*)"/)?.[1]

let dataDir: string
let registry: RoomRegistry
let room: Room
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'dr-lease-'))
  registry = new RoomRegistry({ dataDir, schema: draftroomSchema, textLeaseMs: 60_000, idleEvictMs: 60_000 })
  room = registry.getOrCreate('lease-board')
})
afterEach(() => {
  registry.closeAll()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('text lease wired into the room (authorizeRecord)', () => {
  it('vetoes another user’s text edit and delete, tells only the denied session, allows moves', async () => {
    const a1 = new Client(room, 'alice', 'tab1')
    const b1 = new Client(room, 'bob', 'tab1')
    const b2 = new Client(room, 'bob', 'tab2')
    for (const c of [a1, b1, b2]) await c.connect()
    const n = note('start')

    expect(await a1.put(n)).toBe('commit') // create: allowed, no lease
    expect(await a1.setText(n, 'alice typing')).toBe('commit') // alice takes the lease
    expect(textOf(room, n)).toBe('alice typing')

    expect(await b1.setText(n, 'bob typing')).toBe('discard') // client reverts
    expect(textOf(room, n)).toBe('alice typing')
    await until(() => b1.custom.length === 1)
    expect(b1.custom[0]).toEqual({
      type: 'text-lease-denied',
      shapeId: n.id,
      holderUserId: 'alice',
      expiresInMs: expect.any(Number),
    })
    const { expiresInMs } = b1.custom[0] as { expiresInMs: number }
    expect(expiresInMs).toBeGreaterThan(0)
    expect(expiresInMs).toBeLessThanOrEqual(60_000)

    expect(await b1.move(n, 321)).not.toBe('discard') // geometry only: allowed while held
    expect((room.getRecord(n.id) as TLShape).x).toBe(321)
    expect(textOf(room, n)).toBe('alice typing')

    expect(await b1.remove(n)).toBe('discard')
    expect(room.getRecord(n.id)).toBeDefined()
    await until(() => b1.custom.length === 2)

    expect(b2.custom).toEqual([]) // same user, other tab: not the denied session
    expect(a1.custom).toEqual([])
  })

  it('releases a user’s leases only when their last session in the room is gone', async () => {
    const a1 = new Client(room, 'alice', 'tab1')
    const a2 = new Client(room, 'alice', 'tab2')
    const b1 = new Client(room, 'bob', 'tab1')
    for (const c of [a1, a2, b1]) await c.connect()
    const n = note('start')
    await a1.put(n)
    expect(await a1.setText(n, 'alice')).toBe('commit')

    room.closeSession(a1.sessionId) // one of alice's tabs leaves: she still holds it
    expect(a1.isOpen).toBe(false)
    expect(await b1.setText(n, 'bob')).toBe('discard')

    // the last tab's socket closes; the room removes the session after its grace period
    room.handleSocketClose(a2.sessionId)
    await until(() => !room.getSessions().some((s) => s.meta.userId === 'alice'), 15_000)
    expect(await b1.setText(n, 'bob')).toBe('commit')
    expect(textOf(room, n)).toBe('bob')
  })

  it('a delete by the holder drops the lease, so a re-created shape is editable by anyone', async () => {
    const a1 = new Client(room, 'alice', 'tab1')
    const b1 = new Client(room, 'bob', 'tab1')
    for (const c of [a1, b1]) await c.connect()
    const n = note('start')
    await a1.put(n)
    expect(await b1.setText(n, 'bob')).toBe('commit') // bob holds it (60 s)
    expect(await b1.remove(n)).toBe('commit') // the holder may delete
    expect(room.getRecord(n.id)).toBeUndefined()

    expect(await a1.put(note('restored'))).toBe('commit') // e.g. undo re-creates the same id
    expect(await a1.setText(n, 'alice')).toBe('commit') // not blocked by bob's old lease
    expect(textOf(room, n)).toBe('alice')
  })

  it('leases are per room: a lease in one board never blocks the same shape id in another', async () => {
    const other = registry.getOrCreate('lease-board-2')
    const a1 = new Client(room, 'alice', 'tab1')
    const b1 = new Client(other, 'bob', 'tab1')
    const a1b = new Client(other, 'alice', 'tab1')
    for (const c of [a1, b1, a1b]) await c.connect()
    const n = note('start')
    await a1.put(n)
    await a1b.put(n)
    expect(await a1.setText(n, 'alice')).toBe('commit')
    expect(await b1.setText(n, 'bob')).toBe('commit')
  })
})
