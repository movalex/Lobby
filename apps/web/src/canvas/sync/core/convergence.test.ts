import { describe, expect, it } from 'vitest'
import { bump } from '../headless/scene.ts'
import { rect } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../testing/harness.ts'

// docs/EXCALIDRAW-MIGRATION.md §6.1: seeded random edit sequences between simulated clients, with
// latency, gestures and socket cuts, must end identical to the server (hash.ts over every element,
// tombstones included), with no echo from a receiving-only client.

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** The first differences between a client's map and the server's, for a failure message. */
function diffOf(c: TestClient, h: ReturnType<typeof createHarness>): string {
  const room = new Map(h.room.snapshot().map((e) => [e.id, e as Record<string, unknown>]))
  const mine = c.core.elements() as ReadonlyMap<string, Record<string, unknown>>
  const out: string[] = []
  for (const [id, e] of room) {
    const m = mine.get(id)
    if (!m) out.push(`missing ${id}`)
    else
      for (const k of new Set([...Object.keys(e), ...Object.keys(m)]))
        if (k !== 'status' && JSON.stringify(e[k]) !== JSON.stringify(m[k])) out.push(`${id}.${k}`)
  }
  for (const id of mine.keys()) if (!room.has(id)) out.push(`extra ${id}`)
  return `dirty=${c.core.dirtyIds().join(',')} diff=${out.slice(0, 8).join(' ')}`
}

const COLORS = ['#e03131', '#2f9e44', '#1971c2', '#f08c00', '#1e1e1e']

describe('engine core: random convergence through the protocol fake (§6.1)', () => {
  for (const seed of [1, 7, 42, 1234, 99999]) {
    it(`seed ${seed}: 4 editors x 150 steps with latency, gestures and cuts; a watcher pushes nothing`, async () => {
      const r = rng(seed)
      const seed0 = Array.from({ length: 6 }, (_, i) => stored(rect(`s${i}`, `a${i}`, { x: i * 120 })))
      const h = createHarness({ seed: seed0 })
      const editors: TestClient[] = Array.from({ length: 4 }, (_, i) =>
        h.client(`u${i}`, { latencyMs: Math.floor(r() * 200), tab: `t${i}` }),
      )
      const watcher = h.client('watcher', { latencyMs: 50 })
      h.settle()
      const cut = new Set<number>()
      let made = 0
      for (let step = 0; step < 150; step++) {
        const i = Math.floor(r() * editors.length)
        const c = editors[i] as TestClient
        const live = [...c.scene.map.values()].filter((e) => !e.isDeleted)
        const pick = live[Math.floor(r() * live.length)]
        const roll = r()
        if (roll < 0.06) {
          // a socket cut, or its restore
          if (cut.has(i)) {
            ;(c.transport as unknown as { reopen(): void }).reopen()
            cut.delete(i)
          } else {
            h.room.cut(c.transport)
            cut.add(i)
          }
        } else if (roll < 0.2 || !pick) {
          const id = `n${seed}-${made++}`
          const index = `a${9 + made}`
          c.edit((m) => m.set(id, rect(id, index, { x: Math.round(r() * 800), y: Math.round(r() * 600) })))
        } else if (roll < 0.45) {
          c.change(pick.id, { x: Math.round(r() * 800), y: Math.round(r() * 600) })
        } else if (roll < 0.65) {
          c.change(pick.id, { strokeColor: COLORS[Math.floor(r() * COLORS.length)] as string })
        } else if (roll < 0.75) {
          // a drag gesture: several moves, one push at the end
          const drag = { dragging: true, selectedElementIds: [pick.id] }
          for (let k = 0; k < 3; k++) {
            c.edit((m) => {
              const el = m.get(pick.id)
              if (el) m.set(pick.id, bump(el, { x: (el.x as number) + 7, y: (el.y as number) - 3 }))
            }, drag)
            h.clock.advance(Math.floor(r() * 40))
          }
          c.gesture()
        } else if (roll < 0.85) {
          c.change(pick.id, { isDeleted: true })
        } else if (roll < 0.93) {
          c.change(pick.id, { width: 50 + Math.round(r() * 200), height: 50 + Math.round(r() * 100) })
        } else {
          c.change(pick.id, {
            customData: { lobby: { [`plusOne:u${i}`]: true } },
          })
        }
        h.clock.advance(Math.floor(r() * 120))
      }
      for (const i of cut) ((editors[i] as TestClient).transport as unknown as { reopen(): void }).reopen()
      h.settle()
      h.clock.advance(20_000)
      h.settle()
      const want = await h.roomHash()
      for (const c of [...editors, watcher]) {
        expect(c.core.saveStatus.state, `${c.name} ${diffOf(c, h)}`).toBe('saved')
        expect(await c.hash(), `${c.name} ${diffOf(c, h)}`).toBe(want)
      }
      expect(watcher.core.pushLog()).toHaveLength(0)
      for (const c of [...editors, watcher])
        expect(
          c.logs.filter((l) => l.event === 'echo_suspect'),
          c.name,
        ).toEqual([])
    })
  }
})
