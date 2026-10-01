import { hashElements } from '@draftroom/canvas-schema/hash'
import { type ClientMessage, encodeSnapshotFrame } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { rect } from '../testing/elements.ts'
import { FakeRoom, stored } from '../testing/fakeRoom.ts'
import type { ManualClock } from '../testing/manualClock.ts'
import type { SceneElement, ServerInbound } from '../types.ts'
import { bump, createHeadlessClient, createLobbyHeadlessClient } from './index.ts'

// The headless client over a WebSocket (docs/EXCALIDRAW-MIGRATION.md §6.2): the protocol fake behind a
// fake socket that speaks the real wire (JSON text frames, the binary gzip snapshot), on real timers.

const realClock = {
  now: () => Date.now(),
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
} as unknown as ManualClock

/** A WebSocket class whose "network" is a FakeRoom: `new FakeWS(url)` connects as `ticket`'s user. */
function fakeSocketClass(room: FakeRoom) {
  return class FakeWS {
    static readonly all: FakeWS[] = []
    readyState = 0
    binaryType = 'blob'
    onopen: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: ((ev: { code: number; reason: string }) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    private readonly t: ReturnType<FakeRoom['connect']>
    constructor(url: string) {
      const u = new URL(url)
      const tab = u.searchParams.get('sessionId') ?? 'tab'
      const uid = u.searchParams.get('ticket') ?? 'anon'
      if (!u.pathname.startsWith('/connect/')) throw new Error(`bad path ${u.pathname}`)
      this.t = room.connect({ uid, tab })
      FakeWS.all.push(this)
      this.t.onState((s, c) => {
        if (s === 'open') {
          this.readyState = 1
          this.onopen?.({})
        } else if (s === 'closed') {
          this.readyState = 3
          this.onclose?.({ code: c?.code ?? 1006, reason: c?.reason ?? '' })
        }
      })
      this.t.onMessage((m: ServerInbound) => {
        if (m.type === 'snapshot') {
          void encodeSnapshotFrame(m).then((bytes) =>
            this.onmessage?.({
              data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            }),
          )
        } else this.onmessage?.({ data: JSON.stringify(m) })
      })
    }
    send(data: string) {
      this.t.send(JSON.parse(data) as ClientMessage)
    }
    close(code?: number, reason?: string) {
      this.t.close(code, reason)
    }
    /** the network drops the socket (not a terminal close) */
    drop() {
      this.t.close(1006, 'dropped')
    }
  }
}

const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('headless client (Node, WebSocket)', () => {
  it('connects, gets the binary snapshot, edits, is Saved, and hashes equal to the server', async () => {
    const room = new FakeRoom({ clock: realClock })
    room.seed([stored(rect('r1', 'a0'))])
    const WS = fakeSocketClass(room)
    const a = createHeadlessClient({
      syncUrl: 'http://127.0.0.1:1',
      boardId: 'b1',
      tab: 't1',
      ticket: 'alice',
      WebSocketImpl: WS,
    })
    const b = createHeadlessClient({
      syncUrl: 'http://127.0.0.1:1',
      boardId: 'b1',
      tab: 't2',
      ticket: 'bob',
      WebSocketImpl: WS,
    })
    const wa = await a.connect()
    await b.connect()
    expect(wa.reset).toBe(true)
    expect(a.scene.get('r1')?.id).toBe('r1')
    a.edit((m) => m.set('r1', { ...(m.get('r1') as SceneElement), x: 42 })) // version bumped by `edit`
    a.edit((m) => m.set('r2', rect('r2', 'a1')))
    await a.saved()
    await until(() => b.scene.get('r2') !== undefined && b.scene.get('r1')?.x === 42)
    const h = await hashElements(room.snapshot())
    expect(await hashElements(a.core.elements().values())).toBe(h)
    expect(await hashElements(b.core.elements().values())).toBe(h)
    expect(b.core.pushLog()).toHaveLength(0)
    expect(a.received().some((m) => m.type === 'snapshot')).toBe(true)
    await a.close()
    await b.close()
  })

  it('reconnects after a socket drop with its since and epoch (a catch-up) and replays the edit made meanwhile', async () => {
    const room = new FakeRoom({ clock: realClock })
    room.seed([stored(rect('r1', 'a0'))])
    const WS = fakeSocketClass(room)
    const a = createLobbyHeadlessClient({
      syncUrl: 'http://127.0.0.1:1',
      boardId: 'b1',
      tab: 't1',
      ticket: 'alice',
      WebSocketImpl: WS,
    })
    await a.connect()
    WS.all.at(-1)?.drop()
    await until(() => a.core.saveStatus.state === 'offline')
    a.change('r1', { x: 5 })
    expect(a.core.saveStatus).toMatchObject({ state: 'offline', offlineChanges: 1 })
    await until(() => a.transport.attempts === 2 && a.core.saveStatus.state === 'saved', 5000)
    const hello = room.sessions.get('alice:t1')?.received.find((m) => m.type === 'hello')
    expect(hello).toMatchObject({ type: 'hello', since: 0 })
    const again = room.sessions.get('alice:t1')?.received.filter((m) => m.type === 'hello') ?? []
    expect(again.at(-1)).toMatchObject({ epoch: 'epoch1' })
    expect(room.elements.get('r1')?.x).toBe(5)
    const replay = a.core.pushLog().at(-1)?.ops[0] as { off?: number }
    expect(replay.off).toBeGreaterThanOrEqual(0)
    expect(await hashElements(a.core.elements().values())).toBe(await hashElements(room.snapshot()))
    await a.close()
  })

  it('sendRaw sends any frame (forged frames); received() lists every decoded server frame', async () => {
    const room = new FakeRoom({ clock: realClock })
    const a = createHeadlessClient({
      syncUrl: 'http://127.0.0.1:1',
      boardId: 'b1',
      tab: 't1',
      ticket: 'alice',
      WebSocketImpl: fakeSocketClass(room),
    })
    await a.connect()
    a.sendRaw({ type: 'ping', n: 7 })
    await until(() => a.received().some((m) => m.type === 'pong'))
    expect(a.received().find((m) => m.type === 'pong')).toEqual({ type: 'pong', n: 7 })
    void bump
    await a.close()
  })
})
