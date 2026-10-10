/**
 * O2's headless client (docs/EXCALIDRAW-MIGRATION.md §6.2, §8.6.3): the engine core on a Map-backed scene
 * and a real WebSocket, for Node. It is the client of O1's protocol tests and of O3's load generator, and
 * it runs the client code the browser runs: local edits go through the scene and `core.onSceneChange`,
 * exactly as the Excalidraw adapter feeds `onChange`.
 *
 *   const c = createHeadlessClient({ syncUrl: 'http://127.0.0.1:7860', boardId, tab: 'load-1', ticket })
 *   await c.connect()                                 // hello → welcome (+ snapshot) applied
 *   c.edit((m) => m.set(id, bump(m.get(id)!, { x: 10 })))   // one local step (a new object per change)
 *   await c.saved()                                   // nothing dirty, nothing in flight, all acked
 *   c.core.pushLog(); c.received(); await c.close()
 *
 * `edit` bumps `version` (and draws a new `versionNonce`) on every element whose object changed and whose
 * version did not, so a test can write plain objects. Mutating an element in place is not seen (the core
 * finds edits by version, as it does in the browser).
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import type { Welcome } from '@draftroom/canvas-schema/protocol'
import { LobbyEngineCore } from '../core/engine.ts'
import { createMemoryOfflineStore } from '../core/offline-memory.ts'
import {
  connectQuery,
  createSocketTransport,
  type SocketTransport,
  type WebSocketCtor,
} from '../transport/socket.ts'
import type {
  CreateHeadlessClient,
  GestureState,
  HeadlessClient,
  HeadlessClientOptions,
  SceneElement,
  ServerInbound,
} from '../types.ts'
import { IDLE_GESTURE } from '../types.ts'
import { bump, createMapScene, type MapScene, nextNonce } from './scene.ts'

export { bump, createMapScene, type MapScene, nextNonce } from './scene.ts'

/** Options beyond the frozen ones (all optional; the load generator and long protocol tests use them). */
export interface HeadlessExtras {
  /** a fresh ticket for each reconnect (a ticket lives 60 s); default: the first one again */
  readonly refreshTicket?: () => Promise<string>
  /** reconnect after a non-terminal close (default true) */
  readonly reconnect?: boolean
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
}

export interface LobbyHeadlessClient extends HeadlessClient {
  readonly core: LobbyEngineCore
  readonly scene: Map<string, SceneElement>
  readonly transport: SocketTransport
  /** the Map-backed scene adapter (gesture flags included) */
  readonly mapScene: MapScene
  /** sets the gesture flags and scans (a gesture ends when called with none) */
  gesture(g?: Partial<GestureState>): void
  /** changes one element as a local edit (a new object, version + 1, a new nonce) */
  change(id: string, patch: Readonly<Record<string, unknown>>, gesture?: Partial<GestureState>): void
}

function connectUrl(syncUrl: string, boardId: string, tab: string, ticket: string): string {
  const base = syncUrl.replace(/^http(s?):/, 'ws$1:').replace(/\/+$/, '')
  return `${base}/connect/${encodeURIComponent(boardId)}?${connectQuery(tab, { ticket })}`
}

export const createHeadlessClient: CreateHeadlessClient = (options) =>
  createLobbyHeadlessClient(options as HeadlessClientOptions & HeadlessExtras)

export function createLobbyHeadlessClient(o: HeadlessClientOptions & HeadlessExtras): LobbyHeadlessClient {
  const WebSocketImpl = (o.WebSocketImpl ?? (globalThis as { WebSocket?: unknown }).WebSocket) as
    | WebSocketCtor
    | undefined
  if (!WebSocketImpl) throw new Error('createHeadlessClient: no WebSocket (Node 24 has a global one)')
  const scene = createMapScene()
  const received: ServerInbound[] = []
  let ticket = o.ticket
  let first = true
  const transport = createSocketTransport({
    url: async () => {
      if (!first && o.refreshTicket) ticket = await o.refreshTicket()
      first = false
      return connectUrl(o.syncUrl, o.boardId, o.tab, ticket)
    },
    WebSocketImpl,
    reconnect: o.reconnect,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
    onRaw: (m) => received.push(m),
    log: o.log,
  })
  const core = new LobbyEngineCore({
    transport,
    scene,
    tab: o.tab,
    offline: createMemoryOfflineStore(),
    now: o.now,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
    log: o.log,
  })

  const edit = (fn: (m: Map<string, SceneElement>) => void, gesture?: Partial<GestureState>) => {
    const before = new Map(scene.map)
    fn(scene.map)
    for (const [id, el] of scene.map) {
      const prev = before.get(id)
      if (prev === el) continue
      if (prev && prev.version === el.version)
        scene.map.set(id, { ...el, version: prev.version + 1, versionNonce: nextNonce() })
    }
    scene.gesture = { ...IDLE_GESTURE, ...(gesture ?? {}) }
    core.onSceneChange(scene.read())
  }

  const client: LobbyHeadlessClient = {
    core,
    scene: scene.map,
    mapScene: scene,
    transport,
    connect() {
      return new Promise<Welcome>((resolve, reject) => {
        const off = core.on((e) => {
          if (e.kind === 'welcome') {
            off()
            resolve(e.welcome)
          } else if (e.kind === 'transport' && e.state === 'closed' && e.close?.code === 4099) {
            off()
            reject(new Error(`closed 4099 ${e.close.reason}`))
          }
        })
        core.start()
        transport.connect()
      })
    },
    edit,
    gesture(g) {
      scene.gesture = { ...IDLE_GESTURE, ...(g ?? {}) }
      core.onSceneChange(scene.read())
    },
    change(id, patch, gesture) {
      edit((m) => {
        const el = m.get(id)
        if (!el) throw new Error(`headless: no element ${id}`)
        m.set(id, bump(el, patch))
      }, gesture)
    },
    saved(timeoutMs = 10_000) {
      return new Promise<void>((resolve, reject) => {
        const done = () => core.saveStatus.state === 'saved'
        if (done()) {
          resolve()
          return
        }
        const t = setTimeout(() => {
          off()
          reject(new Error(`headless: not saved after ${timeoutMs} ms (${JSON.stringify(core.saveStatus)})`))
        }, timeoutMs)
        const off = core.onSaveStatus(() => {
          if (!done()) return
          clearTimeout(t)
          off()
          resolve()
        })
      })
    },
    received: () => received,
    sendRaw: (frame) => transport.sendRaw(frame),
    async close() {
      core.stop()
      transport.close(1000, 'client closed')
    },
  }
  return client
}
