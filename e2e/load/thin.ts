// A thin receive-only session for the load generator (docs/EXCALIDRAW-MIGRATION.md §8.3 B9, §2.13): the
// same socket, ticket, hello, reconnects and presence as O2's headless client, but no scene and no engine
// core. The server cannot tell it apart: it joins, gets the welcome (a reset with the snapshot frame, or a
// catch-up after a reconnect from its last clock), receives every `changes`, `presence` and `roster`
// frame, and sends presence at the watcher's rate. It never pushes.
//
// Why: a full engine core per session holds its own copy of the board and rebuilds the scene array for
// every remote change. Measured locally on the L1 board (3,798 elements): about 9 MB live heap and about
// 380 KB allocated per remote change per session; a 260-session L1 run with full cores reached 7.7 GB and
// a client event-loop p99 of 650-700 ms on the workstation, so on the NAS's 4 CPUs / 2 GB it would measure
// the load generator, not sync. So most receive-only watchers are thin (profiles.ts `thin`), and a sample
// of receive-only sessions keeps the full core for B10's echo check (0 pushes from receivers).
//
// Measurement is the meter's, at the socket, as for full sessions: bytes by channel, closes, welcomes,
// `changes` arrivals (A→B visibility) and the probe's cursor (presence delay).
import type { HeadlessClient, HeadlessClientOptions } from '../../apps/web/src/canvas/sync/types.ts'
import {
  ELEMENT_SCHEMA_VERSION,
  PROTO,
  type ServerMessage,
} from '../../packages/canvas-schema/src/protocol.ts'
import { type Meter, meteredWebSocket } from './meter.ts'
import type { ClientFactory } from './session.ts'

/** O2's transport backoff (apps/web/src/canvas/sync/transport/socket.ts DEFAULT_BACKOFF). */
const BACKOFF = [250, 500, 1000, 2000, 4000, 5000] as const

export const thinClientFactory: ClientFactory = (o) => createThinClient(o)

export function createThinClient(o: HeadlessClientOptions & { meter: Meter }): HeadlessClient {
  const Ws = meteredWebSocket(o.meter)
  const received: ServerMessage[] = []
  const url = `${o.syncUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/connect/${encodeURIComponent(o.boardId)}?${new URLSearchParams({ sessionId: o.tab, ticket: o.ticket })}`
  let ws: WebSocket | null = null
  let clock = 0
  let epoch: string | null = null
  let welcomed = false
  let closedByUs = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let onWelcome: ((w: unknown) => void) | null = null
  let onTerminal: ((e: Error) => void) | null = null

  const open = () => {
    const s = new Ws(url)
    s.binaryType = 'arraybuffer'
    ws = s
    welcomed = false
    s.addEventListener('open', () => {
      s.send(
        JSON.stringify({
          type: 'hello',
          proto: PROTO,
          schema: ELEMENT_SCHEMA_VERSION,
          since: clock,
          epoch,
          tab: o.tab,
        }),
      )
    })
    s.addEventListener('message', (e: MessageEvent) => {
      if (typeof e.data !== 'string') return // the reset's snapshot frame: counted by the meter, not decoded
      const head = e.data.slice(0, 80)
      if (head.startsWith('{"type":"changes"')) {
        const m = /"clock":(\d+)/.exec(head)
        if (m) clock = Math.max(clock, Number(m[1]))
        else clock = Math.max(clock, (JSON.parse(e.data) as { clock: number }).clock)
        return
      }
      if (head.startsWith('{"type":"welcome"') || head.startsWith('{"type":"notice"')) {
        const m = JSON.parse(e.data) as ServerMessage
        received.push(m)
        if (m.type === 'welcome') {
          clock = m.clock
          epoch = m.epoch
          welcomed = true
          failures = 0
          onWelcome?.(m)
          onWelcome = null
        }
      }
    })
    s.addEventListener('close', (e: CloseEvent) => {
      welcomed = false
      if (ws === s) ws = null
      if (e.code === 4099) {
        onTerminal?.(new Error(`closed 4099 ${e.reason}`))
        onTerminal = null
        return
      }
      if (closedByUs) return
      const ms = BACKOFF[Math.min(failures, BACKOFF.length - 1)] ?? 5000
      failures++
      timer = setTimeout(open, ms)
    })
  }

  const noop = () => () => {}
  const core = {
    onAck: noop,
    on: noop,
    onSaveStatus: noop,
    leaseConnect: () => ({ send() {}, close() {} }),
    pushLog: () => [],
    confirmed: () => undefined,
    saveStatus: { state: 'saved' },
    sendPresence(p: Record<string, unknown>) {
      if (ws && welcomed && ws.readyState === 1) ws.send(JSON.stringify({ type: 'presence', ...p }))
    },
    start() {},
    stop() {},
  }
  return {
    core: core as unknown as HeadlessClient['core'],
    scene: new Map(),
    connect() {
      return new Promise((resolve, reject) => {
        onWelcome = resolve as (w: unknown) => void
        onTerminal = reject
        open()
      })
    },
    edit() {
      throw new Error('thin client: receive-only')
    },
    saved: () => Promise.resolve(),
    received: () => received,
    sendRaw(frame) {
      ws?.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
    },
    async close() {
      closedByUs = true
      if (timer) clearTimeout(timer)
      ws?.close(1000, 'client closed')
    },
  }
}
