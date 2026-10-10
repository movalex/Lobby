/**
 * M6-2 (wave M, PWR-4): a new echo source and its rule. A page that opens from the board cache paints the cached
 * copy into the scene before its core has any server state. The rule (engine.ts `startFromCache`): the painted
 * copies are taken as another core's are (DEF-GAPS-1's `preScene`): seen, never classified before the first
 * welcome, which rebuilds the whole scene from the server's state. So a receive-only client that opened from the
 * cache pushes NOTHING: not at the welcome, not for a write the scene makes before it (a re-measure, an image
 * status), and not through 50 remote changes after it; paint only and with the resume (M6-3) alike.
 */
import { CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { bump } from '../headless/scene.ts'
import { closePage, openFromCache, recordOf } from '../testing/cached.ts'
import { arrow, note, rect, text } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness } from '../testing/harness.ts'
import type { SceneElement } from '../types.ts'

const seed = () => [
  stored(rect('r1', 'a0', { x: 10 })),
  stored(rect('r2', 'a1', { x: 20 })),
  stored(note('n1', 'a2', { x: 300 })),
  stored(text('t1', 'a3', { x: 600, text: 'hello', originalText: 'hello' })),
  stored(arrow('ar', 'a4')),
]

/** Bob makes 50 remote changes of every kind: moves, recolours, resizes, creates, deletes, a reorder, words. */
function fiftyRemoteChanges(b: ReturnType<ReturnType<typeof createHarness>['client']>, settle: () => void) {
  let n = 0
  const step = (fn: () => void) => {
    fn()
    settle()
    n++
  }
  for (let i = 0; i < 12; i++) step(() => b.change('r1', { x: 100 + i }))
  for (let i = 0; i < 8; i++) step(() => b.change('r2', { strokeColor: i % 2 ? '#e03131' : '#2f9e44' }))
  for (let i = 0; i < 6; i++) step(() => b.change('n1', { width: 200 + i * 10 }))
  for (let i = 0; i < 10; i++)
    step(() => b.edit((m) => m.set(`c${i}`, rect(`c${i}`, `b${i}`, { x: i * 40 }))))
  for (let i = 0; i < 5; i++) step(() => b.change(`c${i}`, { isDeleted: true }))
  step(() => b.change('r2', { index: 'Zz' }))
  for (let i = 0; i < 4; i++) step(() => b.change('t1', { text: `hello ${i}`, originalText: `hello ${i}` }))
  for (let i = 0; i < 4; i++) step(() => b.change('ar', { strokeWidth: 1 + i }))
  return n
}

describe('M6-2: a receive-only client that opened from the cache pushes nothing', () => {
  for (const resume of [false, true])
    it(`${resume ? 'resumed (catch-up)' : 'paint only (reset snapshot)'}: 0 ops through the welcome and 50 remote changes`, async () => {
      const h = createHarness({ seed: seed() })
      h.room.contractsRev = CONTRACTS_REV
      const a = h.client('alice')
      h.settle()
      // alice's own last edit: her copy is at a clock past the seed
      a.change('r2', { y: 5 })
      h.settle()
      const record = recordOf(a)
      closePage(a)
      const b = h.client('bob', { tab: 'tb' })
      h.settle()
      // a change made while alice's page was closed: the cached copy is stale
      b.change('r1', { x: 77 })
      h.settle()
      const p = openFromCache(h, record, {
        resume,
        // the scene writes a cached copy before the welcome (a re-measure of the note, an image status)
        beforeStart: ({ scene, core }) => {
          scene.map.set('n1', bump(scene.map.get('n1') as SceneElement, { height: 211 }))
          scene.map.set('t1', bump(scene.map.get('t1') as SceneElement, { width: 61, status: 'saved' }))
          core.onSceneChange(scene.read())
        },
      })
      expect(p.started).toBe(true)
      h.settle()
      expect(p.core.welcome?.reset).toBe(!resume)
      expect(p.ops(), 'nothing at the welcome').toBe(0)
      expect(p.scene.map.get('r1')?.x).toBe(77)
      expect(p.scene.map.get('n1')).toEqual(h.room.elements.get('n1'))
      const changes = fiftyRemoteChanges(b, () => h.settle())
      expect(changes).toBe(50)
      h.settle()
      expect(p.ops(), 'nothing through 50 remote changes').toBe(0)
      expect(p.core.saveStatus).toMatchObject({ state: 'saved', pending: 0, lastReject: null })
      expect(p.events.filter((e) => e.kind === 'echo_suspect')).toEqual([])
      expect(await p.core.elements().size).toBe(h.room.elements.size)
      // its map is the server's, exactly (tombstones included)
      const { hashElements } = await import('@draftroom/canvas-schema/hash')
      expect(await hashElements(p.core.elements().values())).toBe(await h.roomHash())
    })

  it('a read-only (viewer) page from the cache: nothing sent, no "Change not saved"', async () => {
    const h = createHarness({ seed: seed() })
    const a = h.client('alice')
    h.settle()
    const record = recordOf(a)
    closePage(a)
    const p = openFromCache(h, record, {
      readonly: true,
      beforeStart: ({ scene, core }) => {
        scene.map.set('r2', bump(scene.map.get('r2') as SceneElement, { width: 101 }))
        core.onSceneChange(scene.read())
      },
    })
    h.settle()
    expect(p.core.readonly).toBe(true)
    expect(p.pushes()).toBe(0)
    expect(p.events.filter((e) => e.kind === 'reject')).toEqual([])
    expect(p.scene.map.get('r2')).toEqual(h.room.elements.get('r2'))
  })
})
