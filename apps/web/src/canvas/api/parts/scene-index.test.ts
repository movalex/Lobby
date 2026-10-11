// The scene index (`canvas.index`, ./scene-index.ts; wave N foundation, OWNER: WS1). The foundation's version is a
// full walk per read; these answers are the reference WS1's incremental index must keep (N1-6: after random op
// sequences the incremental index equals a full rebuild).
import { describe, expect, it } from 'vitest'
import * as signals from '../../../lib/signals.ts'
import type { CanvasElement, CanvasEventMap, CanvasPort } from '../../port.ts'
import { createLobbyCanvas } from '../impl.ts'
import { createFeatureRegistries } from '../registries.ts'
import {
  hasLobbyKeyPrefix,
  itemsCallerOf,
  lobbyKindOf,
  resetSceneWalks,
  sceneIndexOf,
  sceneWalks,
  sceneWalksCounted,
} from './scene-index.ts'

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

// N1-6 (wave N): the incremental index (built once, then moved per changed id) equals a full rebuild after random op
// sequences: creates, deletes, undeletes, lobby key adds and removes, frame moves, kind changes, re-keys.
describe('canvas.index is incremental and equals a full rebuild (N1-6)', () => {
  function rng(seed: number): () => number {
    let x = seed >>> 0
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0
      return x / 2 ** 32
    }
  }
  const PREFIXES = ['react:', 'plusOne:', 'tag:']
  const KINDS = ['board-card', 'link-card', 'highlight']
  const key = (i: number) => `a${i.toString(36).padStart(5, '0')}`

  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34])
    it(`seed ${seed}: 400 random ops, every answer equal to the rebuild after each batch`, () => {
      const r = rng(seed)
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T
      let n = 0
      let scene: CanvasElement[] = []
      const frames = () => scene.filter((e) => e.type === 'frame' && !e.isDeleted).map((e) => e.id)
      const make = (): CanvasElement => {
        const id = `e${n}`
        const type = r() < 0.15 ? 'frame' : r() < 0.6 ? 'stickynote' : pick(['rectangle', 'text', 'arrow'])
        const lobby: Record<string, unknown> = {}
        if (r() < 0.3) lobby[`${pick(PREFIXES)}u${Math.floor(r() * 4)}`] = true
        if (r() < 0.2) lobby.kind = pick(KINDS)
        const fs = frames()
        return el(id, type, {
          index: key(n++),
          frameId: type !== 'frame' && fs.length && r() < 0.5 ? pick(fs) : null,
          ...(Object.keys(lobby).length ? lobby_(lobby) : {}),
        })
      }
      const lobby_ = (l: Record<string, unknown>) => ({ customData: { lobby: l } })
      for (let i = 0; i < 30; i++) scene.push(make())
      const s = scenePort(scene)
      const { canvas, dispose } = createLobbyCanvas({ port: s.port, registries: createFeatureRegistries() })
      const check = (when: string) => {
        const ref = sceneIndexOf(() => scene.filter((e) => !e.isDeleted))
        expect(ids(canvas.index.notes()), `${when}: notes`).toEqual(ids(ref.notes()))
        for (const p of PREFIXES)
          expect(ids(canvas.index.withLobbyKeyPrefix(p)), `${when}: ${p}`).toEqual(
            ids(ref.withLobbyKeyPrefix(p)),
          )
        for (const f of new Set([...frames(), 'nope', ...scene.map((e) => e.id).slice(0, 5)]))
          expect(ids(canvas.index.byFrame(f)), `${when}: frame ${f}`).toEqual(ids(ref.byFrame(f)))
        for (const k of [...KINDS, 'none'])
          expect(ids(canvas.index.byKind(k)), `${when}: kind ${k}`).toEqual(ids(ref.byKind(k)))
      }
      check('built')
      for (let step = 0; step < 400; step++) {
        const changed = new Set<string>()
        const ops = 1 + Math.floor(r() * 4)
        for (let k = 0; k < ops; k++) {
          const op = r()
          if (op < 0.2 || !scene.length) {
            const e = make()
            scene = [...scene, e]
            changed.add(e.id)
            continue
          }
          const target = pick(scene)
          const at = scene.indexOf(target)
          const lobby = {
            ...((target.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}),
          }
          let next: CanvasElement
          if (op < 0.35) next = { ...target, isDeleted: !target.isDeleted } as CanvasElement
          else if (op < 0.55) {
            lobby[`${pick(PREFIXES)}u${Math.floor(r() * 4)}`] = true
            next = { ...target, customData: { lobby } } as CanvasElement
          } else if (op < 0.7) {
            for (const k2 of Object.keys(lobby)) if (r() < 0.5) delete lobby[k2]
            next = {
              ...target,
              customData: Object.keys(lobby).length ? { lobby } : undefined,
            } as CanvasElement
          } else if (op < 0.85) {
            const fs = frames().filter((f) => f !== target.id)
            next = { ...target, frameId: fs.length && r() < 0.7 ? pick(fs) : null } as CanvasElement
          } else if (op < 0.93) {
            lobby.kind = r() < 0.3 ? 7 : pick(KINDS)
            next = { ...target, customData: { lobby } } as CanvasElement
          } else {
            // a reorder: a new index key (paint order changes)
            next = { ...target, index: `Z${key(n++)}` } as CanvasElement
          }
          scene = scene.map((e, i) => (i === at ? next : e))
          changed.add(target.id)
        }
        // the scene array stays in paint order, as Excalidraw keeps it
        scene = [...scene].sort((a, b) =>
          (a.index as string) < (b.index as string) ? -1 : (a.index as string) > (b.index as string) ? 1 : 0,
        )
        // an element can also leave the scene entirely (a purged tombstone): gone from it, named in the batch
        if (r() < 0.05 && scene.length) {
          const gone = pick(scene)
          scene = scene.filter((e) => e !== gone)
          changed.add(gone.id)
        }
        s.apply(scene, [...changed])
        check(`step ${step}`)
      }
      dispose()
    })

  it('one full walk to build, none per change after it (the dev counter)', () => {
    resetSceneWalks()
    const s = scenePort(SCENE)
    const { canvas, dispose } = createLobbyCanvas({ port: s.port, registries: createFeatureRegistries() })
    canvas.index.notes()
    canvas.index.byFrame('f1')
    for (let i = 0; i < 20; i++) {
      s.apply(
        SCENE.map((e) => (e.id === 'n1' ? el('n1', 'stickynote', { x: i }) : e)),
        ['n1'],
      )
      canvas.index.notes()
      canvas.index.withLobbyKeyPrefix('react:')
    }
    expect(sceneWalksCounted()).toBe(true)
    expect(sceneWalks()['index.build']).toBe(1)
    dispose()
  })

  it('a listener hears a batch once the index answers for it', () => {
    const s = scenePort(SCENE)
    const { canvas, dispose } = createLobbyCanvas({ port: s.port, registries: createFeatureRegistries() })
    expect(ids(canvas.index.notes())).toEqual(['n1', 'n2'])
    const heard: string[][] = []
    canvas.index.onChanged(() => heard.push(ids(canvas.index.notes())))
    s.apply([...SCENE, el('n4', 'stickynote', { index: 'a1' })], ['n4'])
    expect(heard).toEqual([['n1', 'n2', 'n4']])
    dispose()
  })
})

describe('the walk counter’s caller of a canvas.items() read (N1-6)', () => {
  it('names the first caller under /src/ past the plumbing (the dev server), else items', () => {
    const dev = [
      'Error',
      '    at Object.items (http://127.0.0.1:5173/src/canvas/board/session.ts?t=1:900:20)',
      '    at Object.items (http://127.0.0.1:5173/src/canvas/api/impl.ts:607:19)',
      '    at overlay (http://127.0.0.1:5173/src/features/workshops/ported/votes.ts:40:9)',
    ].join('\n')
    expect(itemsCallerOf(dev)).toBe('items:features/workshops')
    expect(itemsCallerOf('Error\n    at x (http://h/src/canvas/lod/index.ts:1:1)')).toBe('items:canvas/lod')
    expect(itemsCallerOf('Error\n    at a (http://h/assets/LobbyBoardPage-AbC.js:1:2)')).toBe('items')
    expect(itemsCallerOf(undefined)).toBe('items')
  })
})
