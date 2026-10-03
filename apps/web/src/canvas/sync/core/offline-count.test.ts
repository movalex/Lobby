import { describe, expect, it } from 'vitest'
import { bump } from '../headless/scene.ts'
import { note, rect, text } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../testing/harness.ts'
import type { OfflineEntry, SceneElement } from '../types.ts'
import { createMemoryOfflineStore } from './offline-memory.ts'
import { computeSaveStatus } from './saved.ts'

// OFFLINE-COUNT (PROGRESS.md, wave 2C's finding): "Offline — N changes on this device" counted elements,
// so three notes typed offline read "3 changes", then "6 changes" once their labels were queued too. A
// container and its bound label are one change.

/** A note `id` with its bound label `<id>.t` (the label sorts after its container). */
function noteWithLabel(id: string, x: number, words: string): SceneElement[] {
  return [
    note(id, `a${x}`, { x: x * 300, boundElements: [{ id: `${id}.t`, type: 'text' }] }),
    text(`${id}.t`, `a${x}V`, {
      x: x * 300 + 20,
      y: 80,
      containerId: id,
      text: words,
      originalText: words,
      textAlign: 'center',
      verticalAlign: 'middle',
    }),
  ]
}

const offlineChanges = (c: TestClient) => c.core.saveStatus.offlineChanges

describe('OFFLINE-COUNT: offline changes are counted as the person counts them', () => {
  it('three notes made offline, each with its text, read "3 changes", not 6', async () => {
    const store = createMemoryOfflineStore()
    const h = createHarness()
    const a = h.client('alice', { offline: store })
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    a.edit((m) => {
      for (const [i, id] of ['n1', 'n2', 'n3'].entries())
        for (const el of noteWithLabel(id, i + 1, `idea ${i + 1}`)) m.set(el.id, el)
    })
    await Promise.resolve()
    expect(a.core.saveStatus.state).toBe('offline')
    expect(store.entries()).toHaveLength(6) // the queue still keeps each element
    expect(offlineChanges(a)).toBe(3)
    // typing into one of them is still that note's change
    a.change('n2.t', { text: 'idea two', originalText: 'idea two' })
    await Promise.resolve()
    expect(offlineChanges(a)).toBe(3)
    // a free text and a rectangle are a change each
    a.edit((m) => {
      m.set('t9', text('t9', 'b1', { x: 2000 }))
      m.set('r9', rect('r9', 'b2', { x: 2400 }))
    })
    await Promise.resolve()
    expect(offlineChanges(a)).toBe(5)
    // back online: they land, and Saved
    ;(a.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    expect(a.core.saveStatus).toMatchObject({ state: 'saved', offlineChanges: 0 })
    expect([...h.room.elements.keys()].sort()).toEqual(['n1', 'n1.t', 'n2', 'n2.t', 'n3', 'n3.t', 'r9', 't9'])
  })

  it('edits of the texts of existing notes made offline count one per note', () => {
    const seed = ['n1', 'n2'].flatMap((id, i) => noteWithLabel(id, i + 1, 'x')).map((el) => stored(el))
    const h = createHarness({ seed })
    const a = h.client('alice')
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    // each note moved (its label moves with it) and retyped: four elements, two notes
    a.edit((m) => {
      for (const id of ['n1', 'n2']) {
        const n = m.get(id) as SceneElement
        const t = m.get(`${id}.t`) as SceneElement
        m.set(id, bump(n, { y: 500 }))
        m.set(`${id}.t`, bump(t, { y: 580, text: 'moved', originalText: 'moved' }))
      }
    })
    expect(offlineChanges(a)).toBe(2)
  })

  it('a reloaded page offline counts the queue it loaded the same way (before any welcome)', async () => {
    const store = createMemoryOfflineStore()
    const h = createHarness()
    const a = h.client('alice', { offline: store })
    h.settle()
    h.room.cut(a.transport)
    h.settle()
    a.edit((m) => {
      for (const [i, id] of ['n1', 'n2', 'n3'].entries())
        for (const el of noteWithLabel(id, i + 1, `idea ${i + 1}`)) m.set(el.id, el)
    })
    await Promise.resolve()
    expect(store.entries()).toHaveLength(6)
    // the reload: a new page on the same queue, still offline
    const h2 = createHarness()
    const a2 = h2.client('alice', { offline: createMemoryOfflineStore(store.entries() as OfflineEntry[]) })
    h2.room.cut(a2.transport)
    await Promise.resolve()
    await Promise.resolve()
    expect(a2.core.saveStatus.state).toBe('offline')
    expect(offlineChanges(a2)).toBe(3)
  })

  it('computeSaveStatus: offlineItems is what offlineChanges reports when given; absent, elements as before', () => {
    const base = {
      connected: false,
      dirty: 6,
      inflightOps: 0,
      offlineQueued: 6,
      unavailableSince: null,
      lastReject: null,
      now: 0,
    }
    expect(computeSaveStatus(base).offlineChanges).toBe(6)
    expect(computeSaveStatus({ ...base, offlineItems: 3 })).toMatchObject({ offlineChanges: 3, pending: 12 })
    expect(computeSaveStatus({ ...base, connected: true, offlineItems: 3 }).offlineChanges).toBe(0)
  })
})
