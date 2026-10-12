// Wave N.1 review (a guard, no bug today): undo's baseline for an element the core installs as "the same row"
// (`applied.same`: a clean element rebuilt from a server copy of the same id, version and versionNonce) is the copy
// undo already keeps, and an element new to the scene that is a copy of its server row takes that row object
// (controller.ts `adopt`). Both are right only while the server gives every content write a new version (the sync's
// side: apps/sync/test/contracts/version-bump.test.ts). Here, through a reconnect's reset snapshot, a warm open from
// the board cache and remote edits around them: every `same` id's new scene copy deep-equals what undo keeps for it,
// and every adopted row the element it stands for, in every field undo records and writes (not the server-owned
// ones, which no step takes in, nor the local-only ones: an image's `status`).
import { describe, expect, it } from 'vitest'
import type { CoreEvent, LobbyEngineCore } from '../sync/core/engine.ts'
import { bump, type MapScene } from '../sync/headless/scene.ts'
import { closePage, openFromCache, recordOf } from '../sync/testing/cached.ts'
import { arrow, note, rect, text } from '../sync/testing/elements.ts'
import { stored } from '../sync/testing/fakeRoom.ts'
import { createHarness } from '../sync/testing/harness.ts'
import { UndoController } from './controller.ts'
import { LOCAL_ONLY, SERVER_OWNED } from './fields.ts'

const seed = () => [
  stored(rect('r1', 'a0', { x: 10 })),
  stored(rect('r2', 'a1', { x: 20 })),
  stored(note('n1', 'a2', { x: 300 })),
  stored(text('t1', 'a3', { x: 600, text: 'hello', originalText: 'hello' })),
  stored(arrow('ar', 'a4')),
]

/**
 * What undo records and writes of an element: every field but the server-owned ones (id, type, version, nonce,
 * stamps and `customData.lobbyServer`: taken in by no step, written by no undo) and the local-only ones.
 */
const undoFields = (el: unknown) => {
  if (!el) return el
  const out: Record<string, unknown> = { ...(el as Record<string, unknown>) }
  for (const f of [...SERVER_OWNED, ...LOCAL_ONLY]) delete out[f]
  const cd = out.customData as Record<string, unknown> | undefined
  if (cd && 'lobbyServer' in cd) {
    const { lobbyServer: _server, ...rest } = cd
    out.customData = rest
  }
  return out
}

/**
 * Undo on `core` and `scene`, and the ids to check: each `same` id of an apply, and each element new to the scene
 * whose undo copy is its server row. `verify()` (after the room settles: a first welcome's reset is taken in by undo
 * after its apply) says which of them undo does not keep field for field as the scene shows it.
 */
function watch(core: LobbyEngineCore, scene: MapScene) {
  const ctl = new UndoController({ core, scene, bump })
  const checked = { same: 0, adopted: 0 }
  const pending = new Map<string, 'same' | 'adopted'>()
  // registered after the controller's own listener: it runs once undo has taken the apply in
  core.on((e: CoreEvent) => {
    if (e.kind !== 'applied') return
    for (const id of e.ids) {
      const kept = ctl.history.lastLocalOf(id)
      if (e.same?.has(id)) {
        checked.same++
        pending.set(id, 'same')
      } else if (!e.before.get(id) && !!kept && kept === core.confirmed(id)) {
        checked.adopted++
        pending.set(id, 'adopted')
      }
    }
  })
  const verify = () => {
    const problems: string[] = []
    for (const [id, how] of pending) {
      const kept = ctl.history.lastLocalOf(id)
      try {
        expect(kept, 'undo keeps a copy').toBeDefined()
        expect(undoFields(kept)).toEqual(undoFields(scene.map.get(id)))
      } catch {
        problems.push(`${id} (${how})`)
      }
    }
    pending.clear()
    return problems
  }
  return { ctl, checked, verify }
}

describe('undo keeps the same row as the scene (applied.same, adopt)', () => {
  it('a reconnect answered with a reset snapshot over the copy the scene holds', async () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    const b = h.client('bob', { tab: 'tb' })
    h.settle()
    const w = watch(a.core, a.scene)
    // alice's own step first, and someone else's edits, so undo keeps copies of every kind
    a.change('r2', { y: 5 })
    w.ctl.boundary()
    b.change('n1', { backgroundColor: '#ffc9c9' })
    b.change('t1', { text: 'hello there', originalText: 'hello there' })
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    b.change('r1', { x: 55 })
    h.settle()
    // past the room's horizon: the reconnect is answered with a reset snapshot
    h.room.horizon = h.room.clock + 1
    ;(a.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    expect(a.core.welcome?.reset).toBe(true)
    expect(w.checked.same, 'the unchanged rows come back as the same rows').toBeGreaterThanOrEqual(4)
    expect(w.verify()).toEqual([])
    // and undo still takes back alice's own step, over the reset
    w.ctl.undo()
    h.settle()
    expect(h.room.elements.get('r2')?.y).toBe(0)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('a warm open from the board cache: the painted rows the snapshot equals, and the rows new to the scene', async () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const record = recordOf(a)
    closePage(a)
    const b = h.client('bob', { tab: 'tb' })
    h.settle()
    b.change('r1', { x: 77 })
    b.edit((m) => m.set('r3', stored(rect('r3', 'a5', { x: 900 }))))
    h.settle()
    let w: ReturnType<typeof watch> | null = null
    const p = openFromCache(h, record, {
      resume: false,
      diff: false,
      beforeStart: ({ scene, core }) => {
        w = watch(core, scene)
      },
    })
    h.settle()
    expect(p.core.welcome?.reset).toBe(true)
    const watched = w as unknown as ReturnType<typeof watch>
    expect(watched.checked.same + watched.checked.adopted).toBeGreaterThanOrEqual(4)
    expect(watched.verify()).toEqual([])
    // remote edits after it are taken in as before (never "the same row": each has a new version)
    for (let i = 0; i < 5; i++) {
      b.change('n1', { width: 200 + i * 10 })
      b.change('t1', { text: `hello ${i}`, originalText: `hello ${i}` })
      h.settle()
    }
    expect(watched.verify()).toEqual([])
    expect(p.ops()).toBe(0)
  })
})
