// The scene index (`canvas.index`, ./scene-index.ts; wave N foundation, OWNER: WS1). The foundation's version is a
// full walk per read; these answers are the reference WS1's incremental index must keep (N1-6: after random op
// sequences the incremental index equals a full rebuild).
import { describe, expect, it } from 'vitest'
import * as signals from '../../../lib/signals.ts'
import type { CanvasElement, CanvasEventMap, CanvasPort } from '../../port.ts'
import { createLobbyCanvas } from '../impl.ts'
import { createFeatureRegistries } from '../registries.ts'
import { hasLobbyKeyPrefix, lobbyKindOf, sceneIndexOf } from './scene-index.ts'

const el = (id: string, type: string, extra: Record<string, unknown> = {}): CanvasElement =>
  ({
    id,
    type,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    index: 'a0',
    ...extra,
  }) as unknown as CanvasElement

const lobby = (l: Record<string, unknown>) => ({ customData: { lobby: l } })

/** A port over a mutable scene that emits `changed` like the board page's. */
function scenePort(initial: CanvasElement[]) {
  let scene = initial
  const listeners = new Set<CanvasEventMap['changed']>()
  const noop = () => {}
  const port: CanvasPort = {
    items: () => scene.filter((e) => !e.isDeleted),
    get: (id) => scene.find((e) => e.id === id),
    bounds: () => null,
    selection: [],
    select: noop,
    viewport: { get: () => ({ x: 0, y: 0, width: 100, height: 100, zoom: 1 }), set: noop, fit: noop },
    sceneToScreen: (p) => p,
    screenToScene: (p) => p,
    transact: (_label, fn) => fn({ create: () => 'new', update: noop, delete: noop }),
    setTool: () => true,
    tool: () => 'select',
    on: ((event: keyof CanvasEventMap, l: CanvasEventMap['changed']) => {
      if (event !== 'changed') return noop
      listeners.add(l)
      return () => listeners.delete(l)
    }) as CanvasPort['on'],
    editingId: () => null,
    leaseHolder: () => null,
    collaborators: () => [],
    saveStatus: () => ({ state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }),
    engine: null,
  }
  return {
    port,
    apply(next: CanvasElement[], ids: string[]) {
      scene = next
      for (const l of listeners) l(ids)
    },
  }
}

const SCENE = [
  el('n1', 'stickynote', lobby({ 'react:up:usr_a': true })),
  el('n2', 'stickynote', { frameId: 'f1', ...lobby({ 'plusOne:usr_b': true }) }),
  el('n3', 'stickynote', { isDeleted: true, ...lobby({ 'react:up:usr_a': true }) }),
  el('f1', 'frame'),
  el('r1', 'rectangle', { frameId: 'f1', link: '/b/b-two', ...lobby({ kind: 'board-card' }) }),
  el('r2', 'rectangle', lobby({ kind: 'link-card' })),
  el('t1', 'text', { containerId: 'n1' }),
]
const ids = (xs: readonly CanvasElement[]) => xs.map((e) => e.id)

describe('canvas.index (the foundation’s full-walk version)', () => {
  it('answers live notes, lobby key prefixes, frames and kinds, in paint order; deleted elements never', () => {
    const { port } = scenePort(SCENE)
    const { canvas, dispose } = createLobbyCanvas({ port, registries: createFeatureRegistries() })
    expect(ids(canvas.index.notes())).toEqual(['n1', 'n2'])
    expect(ids(canvas.index.withLobbyKeyPrefix('react:'))).toEqual(['n1'])
    expect(ids(canvas.index.withLobbyKeyPrefix('plusOne:'))).toEqual(['n2'])
    expect(canvas.index.withLobbyKeyPrefix('')).toEqual([])
    expect(ids(canvas.index.byFrame('f1'))).toEqual(['n2', 'r1'])
    expect(ids(canvas.index.byKind('board-card'))).toEqual(['r1'])
    expect(ids(canvas.index.byKind('link-card'))).toEqual(['r2'])
    expect(canvas.index.byKind('nothing')).toEqual([])
    dispose()
  })

  it('follows the scene: onChanged names the ids, and a reactive read re-runs', () => {
    const s = scenePort(SCENE)
    const { canvas, dispose } = createLobbyCanvas({ port: s.port, registries: createFeatureRegistries() })
    const heard: string[][] = []
    const off = canvas.index.onChanged((changed) => heard.push([...changed]))
    const seen: string[][] = []
    const stop = signals.react('index-notes', () => {
      seen.push(ids(canvas.index.withLobbyKeyPrefix('react:')))
    })
    // n2 gets a reaction, n1 loses its own
    s.apply(
      SCENE.map((e) =>
        e.id === 'n2'
          ? el('n2', 'stickynote', { frameId: 'f1', ...lobby({ 'react:heart:usr_b': true }) })
          : e.id === 'n1'
            ? el('n1', 'stickynote')
            : e,
      ),
      ['n1', 'n2'],
    )
    expect(heard).toEqual([['n1', 'n2']])
    expect(seen.at(-1)).toEqual(['n2'])
    off()
    s.apply(SCENE, ['n1', 'n2'])
    expect(heard).toHaveLength(1)
    stop()
    dispose()
  })

  it('the helpers: a prefix needs something after it; kind is a string or null', () => {
    expect(hasLobbyKeyPrefix(el('a', 'stickynote', lobby({ 'react:': true })), 'react:')).toBe(false)
    expect(hasLobbyKeyPrefix(el('a', 'stickynote'), 'react:')).toBe(false)
    expect(lobbyKindOf(el('a', 'rectangle', lobby({ kind: 7 })))).toBeNull()
    expect(lobbyKindOf(el('a', 'rectangle', lobby({ kind: 'board-card' })))).toBe('board-card')
    // the reference rebuild over a plain list
    const ref = sceneIndexOf(() => SCENE.filter((e) => !e.isDeleted))
    expect(ids(ref.notes())).toEqual(['n1', 'n2'])
  })
})
