// FACADE-setDoc (wave C, C5): the test facade's board-document verbs. `doc(key)` reads the engine core's
// document (the server's copy with this tab's own writes on top) as a copy, and `setDoc(entries)` writes
// through the board page's LobbyCanvas `doc.set` (what the features call, which also tells the page's UI)
// when its dev-auth debug handle is there, else straight into the core. Before, the board page's facade had
// neither verb (only `children` of the wave-1 set), so a board-document write race could be tested in Node
// only (e2e/excalidraw/doc-key-lost-write.spec.ts is its browser twin).
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasPort } from './port.ts'
import type { EngineCore } from './sync/types.ts'
import { createFacade } from './test-facade.ts'

interface FakeEngine {
  doc: Map<string, unknown>
  writes: Record<string, unknown>[]
}

function fakePort(withEngine = true): { port: CanvasPort; engine: FakeEngine } {
  const engine: FakeEngine = { doc: new Map(), writes: [] }
  const core = {
    doc: () => engine.doc,
    setDoc: (set: Record<string, unknown>) => {
      engine.writes.push(set)
      for (const [k, v] of Object.entries(set)) engine.doc.set(k, v)
    },
  } as unknown as EngineCore
  const port = {
    items: () => [],
    on: () => () => undefined,
    engine: withEngine ? core : null,
  } as unknown as CanvasPort
  return { port, engine }
}

const g = globalThis as { __lobbyBoard?: unknown }

describe('test facade: the board document', () => {
  afterEach(() => {
    delete g.__lobbyBoard
  })

  it('doc(key) reads the core document as a copy, undefined for a key nobody wrote', () => {
    const { port, engine } = fakePort()
    engine.doc.set('tagDef:topic', { name: 'Topic', color: 'red' })
    const { facade } = createFacade(port)
    const got = facade.doc('tagDef:topic') as { color: string }
    expect(got).toEqual({ name: 'Topic', color: 'red' })
    got.color = 'blue'
    expect(engine.doc.get('tagDef:topic')).toEqual({ name: 'Topic', color: 'red' })
    expect(facade.doc('tagDef:none')).toBeUndefined()
  })

  it('setDoc writes through the LobbyCanvas doc.set of the debug handle when the page has one', () => {
    const { port, engine } = fakePort()
    const viaCanvas: Record<string, unknown>[] = []
    g.__lobbyBoard = { canvas: { doc: { set: (e: Record<string, unknown>) => viaCanvas.push(e) } } }
    const { facade } = createFacade(port)
    facade.setDoc({ 'tagDef:topic': { name: 'Topic', color: 'red' }, 'tagDef:old': null })
    expect(viaCanvas).toEqual([{ 'tagDef:topic': { name: 'Topic', color: 'red' }, 'tagDef:old': null }])
    expect(engine.writes).toEqual([])
  })

  it('setDoc falls back to the core when there is no debug handle, and hands it a copy', () => {
    const { port, engine } = fakePort()
    const { facade } = createFacade(port)
    const entries = { 'tagDef:topic': { name: 'Topic', color: 'red' } }
    facade.setDoc(entries)
    expect(engine.writes).toEqual([entries])
    expect(engine.writes[0]).not.toBe(entries)
    ;(entries['tagDef:topic'] as { color: string }).color = 'blue'
    expect(facade.doc('tagDef:topic')).toEqual({ name: 'Topic', color: 'red' })
  })

  it('setDoc without a sync engine (a page with none) says so instead of dropping the write', () => {
    const { port } = fakePort(false)
    const { facade } = createFacade(port)
    expect(() => facade.setDoc({ startView: null })).toThrow(/no sync engine/)
    expect(facade.doc('startView')).toBeUndefined()
  })
})
