// The scene index (`canvas.index`, ./scene-index.ts; wave N foundation, OWNER: WS1). The foundation's version is a
// full walk per read; these answers are the reference WS1's incremental index must keep (N1-6: after random op
// sequences the incremental index equals a full rebuild).
import { describe, expect, it } from 'vitest'
import * as signals from '../../../lib/signals.ts'
import type { CanvasElement, CanvasEventMap, CanvasPort } from '../../port.ts'
import { createLobbyCanvas } from '../impl.ts'
import { createFeatureRegistries } from '../registries.ts'
import {
  absorbIntoSceneIndex,
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
    /** the scene changes and nobody is told yet (an engine core's apply, before the engine's onChange) */
    set(next: CanvasElement[]) {
      scene = next
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
  const TYPES = ['frame', 'stickynote', 'rectangle', 'text', 'arrow', 'image']
  const EXACT = ['kind', 'react:u1', 'tag:u0', 'react:', 'nothing']
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
        // wave N.1: by type, by an exact key, the count
        for (const t of TYPES)
          expect(ids(canvas.index.byType(t)), `${when}: type ${t}`).toEqual(ids(ref.byType(t)))
        for (const k of EXACT)
          expect(ids(canvas.index.withLobbyKey(k)), `${when}: key ${k}`).toEqual(ids(ref.withLobbyKey(k)))
        expect(canvas.index.count(), `${when}: count`).toBe(ref.count())
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
          } else if (op < 0.96) {
            // a reorder: a new index key (paint order changes)
            next = { ...target, index: `Z${key(n++)}` } as CanvasElement
          } else {
            // wave N.1: the engine's in-place write (the same object: a drag's move, its key, its frame, a lobby key)
            const t = target as unknown as Record<string, unknown>
            const how = r()
            if (how < 0.4) t.x = (t.x as number) + 1
            else if (how < 0.6) t.index = `Z${key(n++)}`
            else if (how < 0.8) {
              const fs = frames().filter((f) => f !== target.id)
              t.frameId = fs.length && r() < 0.7 ? pick(fs) : null
            } else {
              if (!t.customData) t.customData = {}
              const cd = t.customData as { lobby?: Record<string, unknown> }
              if (!cd.lobby) cd.lobby = {}
              const l = cd.lobby
              l[`${pick(PREFIXES)}u${Math.floor(r() * 4)}`] = true
            }
            next = target
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

  it('wave N.1: an in-place move of the same object keeps every cached answer; a key, frame or lobby change does not', () => {
    const notes = [0, 1, 2].map((i) => el(`n${i}`, 'stickynote', { index: `a${i}`, frameId: 'f1' }))
    const scene = [el('f1', 'frame', { index: 'Zz' }), ...notes]
    const s = scenePort(scene)
    const { canvas, dispose } = createLobbyCanvas({ port: s.port, registries: createFeatureRegistries() })
    const before = canvas.index.notes()
    const inFrame = canvas.index.byFrame('f1')
    const byType = canvas.index.byType('stickynote')
    const n1 = notes[1] as unknown as Record<string, unknown>
    // a drag's moves: the engine mutates the element in place
    for (let i = 0; i < 5; i++) {
      n1.x = i * 10
      s.apply(scene, ['n1'])
      expect(canvas.index.notes()).toBe(before)
      expect(canvas.index.byFrame('f1')).toBe(inFrame)
      expect(canvas.index.byType('stickynote')).toBe(byType)
    }
    expect(canvas.index.notes()[1]?.x).toBe(40)
    // a new paint key in place: re-sorted
    n1.index = 'a9'
    s.apply(scene, ['n1'])
    expect(ids(canvas.index.notes())).toEqual(['n0', 'n2', 'n1'])
    // out of its frame in place: gone from it
    n1.frameId = null
    s.apply(scene, ['n1'])
    expect(ids(canvas.index.byFrame('f1'))).toEqual(['n0', 'n2'])
    // a lobby key added in place: found by it
    n1.customData = { lobby: { 'plusOne:usr_a': true } }
    s.apply(scene, ['n1'])
    expect(ids(canvas.index.withLobbyKeyPrefix('plusOne:'))).toEqual(['n1'])
    ;(n1.customData as { lobby: Record<string, unknown> }).lobby.file = { assetId: 'a' }
    s.apply(scene, ['n1'])
    expect(ids(canvas.index.withLobbyKey('file'))).toEqual(['n1'])
    // deleted in place: gone
    n1.isDeleted = true
    s.apply(scene, ['n1'])
    expect(ids(canvas.index.notes())).toEqual(['n0', 'n2'])
    expect(canvas.index.count()).toBe(3)
    dispose()
  })

  it('wave N.1: a reader of both the scene (`get`) and the index runs once per change batch, and reads it fresh', () => {
    const s = scenePort(SCENE)
    const { canvas, dispose } = createLobbyCanvas({ port: s.port, registries: createFeatureRegistries() })
    const seen: string[] = []
    const stop = signals.react('get-and-index', () => {
      const x = canvas.get('n1')?.x
      seen.push(`${x}:${ids(canvas.index.byType('stickynote')).join(',')}`)
    })
    expect(seen).toEqual(['0:n1,n2'])
    s.apply(
      [...SCENE.map((e) => (e.id === 'n1' ? el('n1', 'stickynote', { x: 5 }) : e)), el('n9', 'stickynote')],
      ['n1', 'n9'],
    )
    expect(seen).toEqual(['0:n1,n2', '5:n1,n2,n9'])
    stop()
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

// The review of N1-6: `canvas.on('change')` handlers read `canvas.index` synchronously; the index must answer for the
// very batch they hear. The board page's change stream is a port `changed` listener registered after the LobbyCanvas
// (local batches), and remote batches (the engine core's `applied`) are absorbed first (absorbIntoSceneIndex).
describe('canvas.index answers for the batch a change listener hears (N1-6, the review)', () => {
  const answers = (
    canvas: ReturnType<typeof createLobbyCanvas>['canvas'],
    items: () => readonly CanvasElement[],
  ) => ({
    index: {
      notes: ids(canvas.index.notes()),
      frame: ids(canvas.index.byFrame('f1')),
      react: ids(canvas.index.withLobbyKeyPrefix('react:')),
    },
    filter: {
      notes: ids(items().filter((e) => e.type === 'stickynote')),
      frame: ids(items().filter((e) => e.frameId === 'f1')),
      react: ids(items().filter((e) => hasLobbyKeyPrefix(e, 'react:'))),
    },
  })

  it('a local batch: the page’s listener, registered after the LobbyCanvas, reads an index that has it', () => {
    const s = scenePort(SCENE)
    const { canvas, dispose } = createLobbyCanvas({ port: s.port, registries: createFeatureRegistries() })
    // built before the batches (a feature's overlay read it at mount)
    canvas.index.notes()
    const seen: ReturnType<typeof answers>[] = []
    // the board page's change stream (session.ts), after createLobbyCanvas
    const off = s.port.on('changed', () => seen.push(answers(canvas, s.port.items)))
    let scene = SCENE
    for (let i = 0; i < 3; i++) {
      scene = [
        ...scene,
        el(`m${i}`, 'stickynote', {
          index: `a${i + 1}`,
          frameId: 'f1',
          ...lobby({ 'react:up:usr_c': true }),
        }),
      ]
      s.apply(scene, [`m${i}`])
    }
    expect(seen).toHaveLength(3)
    for (const a of seen) expect(a.index).toEqual(a.filter)
    expect(seen.at(-1)?.index.notes).toEqual(['n1', 'n2', 'm0', 'm1', 'm2'])
    off()
    dispose()
  })

  it('a remote batch (the core applied it; the port tells later): absorbed first, the index has it at once', () => {
    const s = scenePort(SCENE)
    const { canvas, dispose } = createLobbyCanvas({ port: s.port, registries: createFeatureRegistries() })
    canvas.index.notes()
    canvas.index.byFrame('f1')
    canvas.index.withLobbyKeyPrefix('react:')
    const next = [
      ...SCENE.filter((e) => e.id !== 'n1'),
      el('n1', 'stickynote', { isDeleted: true }),
      el('p1', 'stickynote', { index: 'a5', frameId: 'f1', ...lobby({ 'react:up:usr_d': true }) }),
    ]
    s.set(next)
    // before the absorb: the index still answers for the scene before the apply (what the review reproduced)
    expect(ids(canvas.index.notes())).toEqual(['n1', 'n2'])
    absorbIntoSceneIndex(s.port, ['n1', 'p1'])
    const a = answers(canvas, s.port.items)
    expect(a.index).toEqual(a.filter)
    expect(a.index.notes).toEqual(['n2', 'p1'])
    // the port's `changed` for the same ids, later: idempotent
    s.apply(next, ['n1', 'p1'])
    const b = answers(canvas, s.port.items)
    expect(b.index).toEqual(b.filter)
    // an index nobody built yet: nothing to absorb (its build reads the scene)
    const s2 = scenePort(SCENE)
    const c2 = createLobbyCanvas({ port: s2.port, registries: createFeatureRegistries() })
    s2.set(next)
    absorbIntoSceneIndex(s2.port, ['n1', 'p1'])
    expect(ids(c2.canvas.index.notes())).toEqual(['n2', 'p1'])
    c2.dispose()
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
