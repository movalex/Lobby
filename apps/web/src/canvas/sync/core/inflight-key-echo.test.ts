/**
 * SYNC-4 (B11's one divergence, docs/research/excalidraw/spike-b/B11.md): a key this tab holds in its scene
 * but the server has not confirmed (its create's, or a reorder's, still in flight or unsent) must never make
 * Excalidraw re-key someone else's confirmed element.
 *
 * The frame order is browser A's in B11 run 1 at 017f76d (its relay frames, kept in that run's Playwright
 * trace): A's create X is in flight; another user's create lands first at X's key, so the index pre-pass
 * re-keys X locally (in flight: local only); then ONE `changes` batch confirms a third user's create Z at
 * exactly that local key and X itself (at the server's fixed key), before X's ack. X was no longer "own
 * unacknowledged" (the server's copy had arrived), so the pre-pass did not run and X kept its local key; the
 * array went to `updateScene` with X and Z on one key, and Excalidraw's `syncInvalidIndices` re-keyed Z in
 * place with a version bump (`echo_suspect`). At 017f76d the ack that followed rebuilt the scene before any
 * scan and took Z's bumped version as known: A showed Saved with Z's index, version, versionNonce and
 * updated different from the server's (the divergence). Since 319d532 every server message first scans the
 * live scene (`syncLive`), so the core saw the bump and pushed Z's new key: no divergence, but an echo (A
 * wrote another user's element). Here neither happens: the pre-pass counts an element whose scene key is
 * this tab's unconfirmed write as its own, and re-keys it.
 *
 * The scene does what `updateScene` does to indices (`Scene.replaceAllElements` → `syncInvalidIndices`,
 * in place, version + 1; ../index-keys.test.ts reproduces it), so an echo shows exactly as in a browser.
 */
import { hashElements } from '@draftroom/canvas-schema/hash'
import type { ClientMessage } from '@draftroom/canvas-schema/protocol'
import { syncInvalidIndices } from '@excalidraw/element'
import { beforeAll, describe, expect, it } from 'vitest'
import { bump } from '../headless/scene.ts'
import { rect } from '../testing/elements.ts'
import { FakeRoom, stored } from '../testing/fakeRoom.ts'
import { createManualClock } from '../testing/manualClock.ts'
import type { SceneAdapter, SceneElement, ServerInbound, Transport } from '../types.ts'
import { IDLE_GESTURE } from '../types.ts'
import { LobbyEngineCore } from './engine.ts'

beforeAll(() => {
  // `syncInvalidIndices` reads `window` (Node has none; a browser has one without the debug flag)
  ;(globalThis as { window?: unknown }).window ??= {}
})

type Push = Extract<ClientMessage, { type: 'push' }>

/**
 * One client: the core on a scene that re-keys like `updateScene`, welcomed by the protocol fake (seeded
 * with `seed`); then the test plays the server: the client's pushes stay with the test (`pushes`) and the
 * test delivers the frames (`deliver`).
 */
function client(seed: SceneElement[]) {
  const clock = createManualClock()
  const room = new FakeRoom({ clock })
  room.seed(seed)
  const raw = room.connect({ uid: 'alice', tab: 't1' })
  const listeners = new Set<(m: ServerInbound) => void>()
  raw.onMessage((m) => {
    for (const l of [...listeners]) l(m)
  })
  const pushes: Push[] = []
  let scripted = false
  const transport: Transport = {
    get state() {
      return raw.state
    },
    send(m) {
      if (scripted && m.type === 'push') pushes.push(m)
      else if (!scripted) raw.send(m)
    },
    onMessage(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    onState: (l) => raw.onState(l),
    close: (c, r) => raw.close(c, r),
  }
  const map = new Map<string, SceneElement>()
  const scene: SceneAdapter = {
    read: () => ({ elements: [...map.values()], gesture: IDLE_GESTURE }),
    apply(elements) {
      syncInvalidIndices(elements as never)
      map.clear()
      for (const el of elements) map.set(el.id, el)
    },
  }
  const logs: { event: string; detail: Readonly<Record<string, unknown>> }[] = []
  const core = new LobbyEngineCore({
    transport,
    scene,
    tab: 't1',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (event, detail) => logs.push({ event, detail }),
  })
  core.start()
  clock.runAll()
  scripted = true
  return {
    core,
    map,
    pushes,
    logs,
    /** a local edit, scanned as Excalidraw's onChange would report it, then every timer run */
    edit(fn: (m: Map<string, SceneElement>) => void) {
      fn(map)
      core.onSceneChange(scene.read())
      clock.runAll()
    },
    deliver(m: unknown) {
      for (const l of [...listeners]) l(m as ServerInbound)
      clock.runAll()
    },
    /** another user's element as the server stores and sends it */
    server: (id: string, index: string, versionNonce: number) => ({
      ...stored(rect(id, index)),
      versionNonce,
    }),
    /** the ops of every push that named `id` */
    pushedFor: (id: string) =>
      pushes.flatMap((p) => p.ops).filter((op) => (op.k === 'c' ? op.el.id === id : op.id === id)),
  }
}

describe('SYNC-4: an unconfirmed local key never makes Excalidraw re-key a confirmed element', () => {
  it("B11 run 1's frame order: X's create confirmed in a batch before its ack, Z on X's local key", async () => {
    const a = client([stored(rect('S', 'a0'))])
    // A creates X at the top; the push goes out and stays in flight
    a.edit((m) => m.set('X1', rect('X1', 'a1')))
    const push = a.pushes[0] as Push
    expect(push.ops).toMatchObject([{ k: 'c', el: { id: 'X1', index: 'a1' } }])
    // another user's create at a1 lands first: the pre-pass moves X above it, locally
    a.deliver({ type: 'changes', clock: 1, ops: [{ k: 'c', el: a.server('y1', 'a1', 11) }] })
    const local = a.map.get('X1')?.index as string
    expect(local > 'a1').toBe(true)
    // one batch: a third user's create at exactly X's local key, and X at the server's own fix
    a.deliver({
      type: 'changes',
      clock: 2,
      ops: [
        { k: 'c', el: a.server('z1', local, 22) },
        { k: 'c', el: a.server('X1', 'a1V', 33) },
      ],
    })
    // Z is the server's copy, untouched by the apply (no in-place re-key, no version bump)
    expect(a.logs.filter((l) => l.event === 'echo_suspect')).toEqual([])
    expect(a.map.get('z1')).toMatchObject({ index: local, version: 1, versionNonce: 22 })
    a.deliver({
      type: 'ack',
      seq: push.seq,
      clock: 2,
      r: [{ id: 'X1', ok: true, v: 1, fix: { index: 'a1V' } }],
    })
    // X ends on the server's key; nothing of Z was ever pushed (no echo); Saved, equal to the server
    expect(a.map.get('X1')?.index).toBe('a1V')
    expect(a.pushedFor('z1')).toEqual([])
    expect(a.pushes).toHaveLength(1)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await hashElements(a.core.elements().values())).toBe(
      await hashElements(a.core.confirmedElements().values()),
    )
  })

  it('a reorder not pushed yet and another user’s create on its key: the reorder moves, the create stays', async () => {
    const a = client([stored(rect('E1', 'a0')), stored(rect('S', 'a1'))])
    // A brings E to the front (a new key above S); the change waits for the push's coalescing window
    a.map.set('E1', bump(a.map.get('E1') as SceneElement, { index: 'a2' }))
    a.core.onSceneChange({ elements: [...a.map.values()], gesture: IDLE_GESTURE })
    // before it goes out, another user's create lands on the same key
    a.deliver({ type: 'changes', clock: 1, ops: [{ k: 'c', el: a.server('w1', 'a2', 44) }] })
    expect(a.logs.filter((l) => l.event === 'echo_suspect')).toEqual([])
    expect(a.map.get('w1')).toMatchObject({ index: 'a2', version: 1, versionNonce: 44 })
    // the reorder goes out above w1 (E stays in front), and nothing of w1 is pushed
    const e = a.pushedFor('E1')
    expect(e).toHaveLength(1)
    const key = (e[0] as { g?: { z?: { index?: string } } }).g?.z?.index as string
    expect(key > 'a2').toBe(true)
    expect(a.map.get('E1')?.index).toBe(key)
    expect(a.pushedFor('w1')).toEqual([])
  })
})
