// The save tracker's state machine against a scripted socket (the browser proof is
// e2e/tests/saving.spec.ts), plus the upgrade guard for the @internal engine surface it relies on.

import type { TLPersistentClientSocket, TLSocketStatusChangeEvent } from '@tldraw/sync'
import * as tlsync from '@tldraw/sync'
import {
  createTLStore,
  DocumentRecordType,
  defaultShapeUtils,
  PageRecordType,
  TLDOCUMENT_ID,
  type TLPageId,
  type TLStore,
} from 'tldraw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type SaveState, SaveTracker, SUPPORTED_PROTOCOL_VERSION } from './saveTracker.ts'

describe('save indicator internals (re-check on every tldraw upgrade)', () => {
  it('@tldraw/sync still exports ClientWebSocketAdapter and speaks protocol v8', () => {
    const internals = tlsync as unknown as {
      ClientWebSocketAdapter?: unknown
      getTlsyncProtocolVersion?: () => number
    }
    expect(typeof internals.ClientWebSocketAdapter).toBe('function') // @internal, runtime export
    expect(internals.getTlsyncProtocolVersion?.()).toBe(8) // @internal, protocol.ts
    expect(SUPPORTED_PROTOCOL_VERSION).toBe(internals.getTlsyncProtocolVersion?.())
  })
})

type Msg = Record<string, unknown> & { type: string }

/** A socket the test drives by hand: status changes and server messages. */
class ScriptedSocket {
  connectionStatus: 'online' | 'offline' | 'error' = 'offline'
  readonly sent: Msg[] = []
  private readonly onMessage = new Set<(m: Msg) => void>()
  private readonly onStatus = new Set<(e: TLSocketStatusChangeEvent) => void>()
  sendMessage(m: Msg) {
    this.sent.push(m)
  }
  onReceiveMessage(cb: (m: Msg) => void) {
    this.onMessage.add(cb)
    return () => void this.onMessage.delete(cb)
  }
  onStatusChange(cb: (e: TLSocketStatusChangeEvent) => void) {
    this.onStatus.add(cb)
    return () => void this.onStatus.delete(cb)
  }
  restart() {}
  close() {}
  setStatus(status: 'online' | 'offline') {
    this.connectionStatus = status
    for (const cb of this.onStatus) cb({ status })
  }
  receive(m: Msg) {
    for (const cb of this.onMessage) cb(m)
  }
}

const P1 = PageRecordType.createId('p1')
const P2 = PageRecordType.createId('p2')
const page = (id: TLPageId, name: string) => PageRecordType.create({ id, name, index: 'a1' as never })

let socket: ScriptedSocket
let tracker: SaveTracker
let store: TLStore
let states: SaveState[]
let clock = 0

/** The client pushes (in the app, TLSyncClient does this through tracker.socket). */
function push(diff?: Record<string, unknown>) {
  clock++
  tracker.socket.sendMessage({
    type: 'push',
    clientClock: clock,
    ...(diff ? { diff } : {}),
    presence: {},
  } as never)
  return clock
}
const result = (clientClock: number, action: unknown) =>
  socket.receive({ type: 'push_result', clientClock, action })
function connect(isReadonly = false) {
  socket.setStatus('online')
  tracker.socket.sendMessage({
    type: 'connect',
    connectRequestId: `c${clock}`,
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
  } as never)
  socket.receive({ type: 'connect', connectRequestId: `c${clock}`, isReadonly })
}
/** Lets the tracker's verification run: past verifyAfterMs, and a few frames. */
async function afterVerification() {
  await vi.advanceTimersByTimeAsync(1500)
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) =>
    setTimeout(() => cb(performance.now()), 16),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  clock = 0
  socket = new ScriptedSocket()
  tracker = new SaveTracker('store-under-test', socket as unknown as TLPersistentClientSocket<never, never>)
  store = createTLStore({ id: 'store-under-test', shapeUtils: defaultShapeUtils })
  // What the server's first connect loads: a usable document. (Without it, the store's own integrity
  // check would add a document and page as 'user' changes after the first remote merge.)
  store.mergeRemoteChanges(() =>
    store.put([
      DocumentRecordType.create({ id: TLDOCUMENT_ID }),
      page(PageRecordType.createId('base'), 'Page 1'),
    ]),
  )
  tracker.attachStore(store)
  states = [tracker.getSnapshot().state]
  tracker.subscribe(() => {
    const s = tracker.getSnapshot().state
    if (states.at(-1) !== s) states.push(s)
  })
})
afterEach(() => {
  tracker.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SaveTracker', () => {
  it('says Saved only after the server committed the push that carried the change', () => {
    connect()
    expect(tracker.getSnapshot().state).toBe('saved')
    store.put([page(P1, 'Sprint')]) // a user change (source 'user', document scope)
    expect(tracker.getSnapshot().state).toBe('saving')
    const c = push({ [P1]: ['put', page(P1, 'Sprint')] })
    expect(tracker.getSnapshot()).toMatchObject({ state: 'saving', inFlight: 1, unsent: false })
    result(c, 'commit')
    expect(tracker.getSnapshot().state).toBe('saved')
    expect(states).toEqual(['connecting', 'saved', 'saving', 'saved'])
  })

  it('ignores presence-only pushes and their commits', () => {
    connect()
    for (let i = 0; i < 20; i++) result(push(), 'commit')
    expect(states).toEqual(['connecting', 'saved'])
  })

  it('holds unacknowledged changes as "offline-pending" and resolves them on the first push after reconnect', () => {
    connect()
    store.put([page(P1, 'Sprint')])
    push({ [P1]: ['put', page(P1, 'Sprint')] })
    socket.setStatus('offline') // the push was never answered
    expect(tracker.getSnapshot().state).toBe('offline-pending')
    store.put([page(P2, 'Offline edit')]) // made while disconnected
    expect(tracker.getSnapshot()).toMatchObject({ state: 'offline-pending', offlineChanges: true })
    connect()
    expect(tracker.getSnapshot().state).toBe('saving') // waiting for the re-push
    const c = push({ [P1]: ['put', page(P1, 'Sprint')], [P2]: ['put', page(P2, 'Offline edit')] })
    result(c, 'commit')
    expect(tracker.getSnapshot().state).toBe('saved')
    expect(states).toEqual(['connecting', 'saved', 'saving', 'offline-pending', 'saving', 'saved'])
  })

  it('resolves to Saved when the reconnect push carries nothing (the server already had it: ack lost)', () => {
    connect()
    store.put([page(P1, 'Sprint')])
    push({ [P1]: ['put', page(P1, 'Sprint')] })
    socket.setStatus('offline')
    connect()
    expect(tracker.getSnapshot().state).toBe('saving')
    result(push(), 'commit')
    expect(tracker.getSnapshot().state).toBe('saved')
  })

  it('reports a vetoed change as rejected and never says Saved for it', async () => {
    connect()
    store.put([page(P1, 'Forged')])
    const c = push({ [P1]: ['put', page(P1, 'Forged')] })
    result(c, 'discard')
    socket.receive({ type: 'custom', data: { type: 'write-vetoed' } })
    // The client's rebase removes the discarded record.
    store.mergeRemoteChanges(() => store.remove([P1]))
    expect(tracker.getSnapshot().state).toBe('saving') // verifying, not Saved
    await afterVerification()
    const snap = tracker.getSnapshot()
    expect(snap.state).toBe('rejected')
    expect(snap.rejection).toMatchObject({
      records: [{ id: P1, typeName: 'page', kind: 'vetoed' }],
      serverMessage: { type: 'write-vetoed' },
    })
    expect(states).toEqual(['connecting', 'saved', 'saving', 'rejected'])
    // Held for 8 s, then back to Saved.
    await vi.advanceTimersByTimeAsync(8100)
    expect(tracker.getSnapshot().state).toBe('saved')
  })

  it('treats a discarded no-op (the server already had that value) as saved', async () => {
    connect()
    store.mergeRemoteChanges(() => store.put([page(P1, 'Same')]))
    store.put([{ ...page(P1, 'Same'), meta: { touched: true } }])
    store.put([page(P1, 'Same')]) // edited back: the value the server holds
    const c = push({ [P1]: ['patch', { name: ['put', 'Same'] }] })
    result(c, 'discard')
    await afterVerification()
    expect(tracker.getSnapshot().state).toBe('saved')
    expect(states).not.toContain('rejected')
  })

  it('reports an edit to a record someone else deleted as deleted-remotely', async () => {
    connect()
    store.mergeRemoteChanges(() => store.put([page(P1, 'Theirs')]))
    store.put([page(P1, 'Mine')])
    const c = push({ [P1]: ['patch', { name: ['put', 'Mine'] }] })
    store.mergeRemoteChanges(() => store.remove([P1]))
    result(c, 'discard')
    await afterVerification()
    expect(tracker.getSnapshot().rejection?.records).toEqual([
      { id: P1, typeName: 'page', kind: 'deleted-remotely' },
    ])
  })

  it('fails safe on an unknown protocol version: never Saved', () => {
    socket.setStatus('online')
    tracker.socket.sendMessage({ type: 'connect', connectRequestId: 'x', protocolVersion: 9 } as never)
    socket.receive({ type: 'connect', connectRequestId: 'x', isReadonly: false })
    expect(tracker.getSnapshot().state).toBe('unsupported')
  })

  it('marks a read-only session so the display can say "View only"', () => {
    connect(true)
    expect(tracker.getSnapshot()).toMatchObject({ state: 'saved', readonly: true })
  })
})
