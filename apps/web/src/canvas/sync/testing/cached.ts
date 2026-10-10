/**
 * Wave M (M6): test helpers for a core that starts from the board cache: the record a client's session would
 * write (adapter/snapshot-cache.ts `cacheRecordOf` over `core.cacheContent()`), and a new page's core on a fresh
 * scene that starts from it, on a new socket of the protocol fake.
 *
 * NODE-SAFE (CONTRACTS.md).
 */

import type { ClientMessage } from '@draftroom/canvas-schema/protocol'
import { type CachedBoard, cacheRecordOf } from '../adapter/snapshot-cache.ts'
import { type CoreEvent, LobbyEngineCore } from '../core/engine.ts'
import { createMapScene, type MapScene } from '../headless/scene.ts'
import type { OfflineQueueStore, ServerInbound } from '../types.ts'
import type { Harness, TestClient } from './harness.ts'

/** The record `c`'s session would write now (throws when the core has nothing to write). */
export function recordOf(
  c: Pick<TestClient, 'core'>,
  boardId = 'b1',
  uid = 'alice',
  savedAt = 1,
): CachedBoard {
  const content = c.core.cacheContent()
  if (!content) throw new Error('nothing to cache yet')
  const r = cacheRecordOf(boardId, uid, content, savedAt)
  if (!r) throw new Error('over the budget')
  return r
}

export interface CachedPage {
  readonly core: LobbyEngineCore
  readonly scene: MapScene
  readonly transport: ReturnType<Harness['room']['connect']>
  readonly events: CoreEvent[]
  readonly logs: { event: string; detail: Readonly<Record<string, unknown>> }[]
  /** whether `startFromCache` took the copy */
  readonly started: boolean
  /** frames this page's socket sent */
  sent(): ClientMessage[]
  /** frames the room sent this page's socket */
  got(): ServerInbound[]
  /** pushes this page sent */
  pushes(): number
  /** ops in this page's pushes */
  ops(): number
}

/**
 * A new page of `uid` (a fresh scene, a new core and socket) that starts from `record` (paint only, or with the
 * resume), then `beforeStart` (a write the scene makes before the welcome), then `start()`.
 */
export function openFromCache(
  h: Harness,
  record: CachedBoard | null,
  o: {
    uid?: string
    tab?: string
    resume?: boolean
    readonly?: boolean
    offline?: OfflineQueueStore
    beforeStart?: (p: { scene: MapScene; core: LobbyEngineCore }) => void
  } = {},
): CachedPage {
  const uid = o.uid ?? 'alice'
  const tab = o.tab ?? 'tab2'
  const scene = createMapScene()
  const transport = h.room.connect({ uid, tab, readonly: o.readonly })
  const events: CoreEvent[] = []
  const logs: CachedPage['logs'] = []
  const core = new LobbyEngineCore({
    transport,
    scene,
    tab,
    offline: o.offline,
    now: h.clock.now,
    setTimer: h.clock.setTimer,
    clearTimer: h.clock.clearTimer,
    log: (event, detail) => logs.push({ event, detail }),
  })
  core.on((e) => events.push(e))
  const started = record ? core.startFromCache(record, { resume: o.resume ?? true }) : false
  o.beforeStart?.({ scene, core })
  core.start()
  const sent = () => transport.session.received as ClientMessage[]
  const pushes = () => sent().filter((m) => m.type === 'push') as Extract<ClientMessage, { type: 'push' }>[]
  return {
    core,
    scene,
    transport,
    events,
    logs,
    started,
    sent,
    got: () => transport.session.sent,
    pushes: () => pushes().length,
    ops: () => pushes().reduce((n, p) => n + p.ops.length + (p.doc ? 1 : 0), 0),
  }
}

/** The page of `c` goes away (its offline queue written, its core stopped, its socket closed). */
export function closePage(c: TestClient): void {
  c.core.persistNow()
  c.core.stop()
  c.transport.close(1000, 'page closed')
}
