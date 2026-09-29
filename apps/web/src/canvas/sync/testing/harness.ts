/**
 * Several engine cores on Map-backed scenes against the protocol fake (./fakeRoom.ts), all on one manual
 * clock: the Node harness of the engine core's tests (docs/EXCALIDRAW-MIGRATION.md §6.1, "seeded random
 * edit sequences between simulated clients that must end identical to the server").
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import { hashElements } from '@draftroom/canvas-schema/hash'
import { LobbyEngineCore } from '../core/engine.ts'
import { bump, createMapScene, type MapScene } from '../headless/scene.ts'
import type { GestureState, OfflineQueueStore, SceneElement } from '../types.ts'
import { IDLE_GESTURE } from '../types.ts'
import { FakeRoom } from './fakeRoom.ts'
import { createManualClock, type ManualClock } from './manualClock.ts'

export interface TestClient {
  readonly name: string
  readonly core: LobbyEngineCore
  readonly scene: MapScene
  readonly transport: ReturnType<FakeRoom['connect']>
  readonly logs: { event: string; detail: Readonly<Record<string, unknown>> }[]
  /** one local step: `fn` edits the map (use `bump`), then the core scans with `gesture` */
  edit(fn: (m: Map<string, SceneElement>) => void, gesture?: Partial<GestureState>): void
  /** sets the gesture flags and scans (a gesture ends when this is called with none) */
  gesture(g?: Partial<GestureState>): void
  get(id: string): SceneElement | undefined
  /** changes one element as a local edit (version + 1, new nonce) */
  change(id: string, patch: Readonly<Record<string, unknown>>, gesture?: Partial<GestureState>): void
  hash(): Promise<string>
}

export interface Harness {
  readonly clock: ManualClock
  readonly room: FakeRoom
  client(
    name: string,
    o?: { readonly?: boolean; latencyMs?: number; offline?: OfflineQueueStore; tab?: string },
  ): TestClient
  /** runs every queued frame and timer */
  settle(): void
  roomHash(): Promise<string>
}

export function createHarness(o: { seed?: readonly Record<string, unknown>[] } = {}): Harness {
  const clock = createManualClock()
  const room = new FakeRoom({ clock })
  if (o.seed) room.seed(o.seed)
  return {
    clock,
    room,
    client(name, co = {}) {
      const scene = createMapScene()
      const transport = room.connect({
        uid: name,
        tab: co.tab ?? 'tab1',
        readonly: co.readonly,
        latencyMs: co.latencyMs,
      })
      const logs: TestClient['logs'] = []
      const core = new LobbyEngineCore({
        transport,
        scene,
        tab: co.tab ?? 'tab1',
        offline: co.offline,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        log: (event, detail) => logs.push({ event, detail }),
      })
      core.start()
      const c: TestClient = {
        name,
        core,
        scene,
        transport,
        logs,
        edit(fn, gesture) {
          fn(scene.map)
          scene.gesture = { ...IDLE_GESTURE, ...(gesture ?? {}) }
          core.onSceneChange(scene.read())
        },
        gesture(g) {
          scene.gesture = { ...IDLE_GESTURE, ...(g ?? {}) }
          core.onSceneChange(scene.read())
        },
        get: (id) => scene.map.get(id),
        change(id, patch, gesture) {
          c.edit((m) => {
            const el = m.get(id)
            if (!el) throw new Error(`no ${id} in ${name}'s scene`)
            m.set(id, bump(el, patch))
          }, gesture)
        },
        hash: () => hashElements(core.elements().values()),
      }
      return c
    },
    settle: () => clock.runAll(),
    roomHash: () => hashElements(room.snapshot()),
  }
}
