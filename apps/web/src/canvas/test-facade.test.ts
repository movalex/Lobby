// O3's test facade (test-facade.ts) on a fake CanvasPort and a fake engine core: every write goes through
// `transact`, reads are copies, `hash()` is hash.ts over the core's whole map (tombstones included),
// `pushedOps()` is the core's push log, `leaseState()` splits held and pending, and install/uninstall own
// exactly `window.lobbyCanvas` and `window.__lobbyHarness`. `select` commits before it returns (DANA-01): a
// model of React's default lane stands in for react-dom here; e2e/excalidraw/facade-select-commit.spec.ts
// proves it on the real page.
import { hashElements } from '@draftroom/canvas-schema/hash'
import type { LeaseHolder, RosterEntry, Welcome } from '@draftroom/canvas-schema/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasElement, CanvasEventMap, CanvasPort, CanvasTx, Viewport } from './port.ts'
import { createRegistries } from './registries.ts'
import type { EngineCore, PushRecord, SaveStatus, SceneElement } from './sync/types.ts'
import { createFacade, install, type LobbyHarnessHooks } from './test-facade.ts'
import type { LobbyCanvasFacade } from './test-facade.types.ts'

/**
 * A model of React's lanes, standing in for react-dom: a state update made outside any event (a
 * `page.evaluate`) is a default-lane update, committed in a later task; one made inside `flushSync` is
 * committed before `flushSync` returns.
 */
const lane = vi.hoisted(() => {
  const queue: (() => void)[] = []
  const state = {
    /** how deep inside `flushSync` the caller is (0: outside any event) */
    depth: 0,
    /** how many times `flushSync` ran */
    flushes: 0,
    /** a state update: committed when `flushSync` returns, or else in a later task (`runLater`) */
    update(commit: () => void) {
      queue.push(commit)
    },
    /** the later task: what React's scheduler does with the default lane */
    runLater(): Promise<void> {
      return new Promise((resolve) =>
        setTimeout(() => {
          for (const commit of queue.splice(0)) commit()
          resolve()
        }, 0),
      )
    },
    flush<R>(fn: () => R): R {
      state.depth++
      try {
        return fn()
      } finally {
        state.depth--
        state.flushes++
        for (const commit of queue.splice(0)) commit()
      }
    },
  }
  return state
})
vi.mock('react-dom', () => ({ flushSync: lane.flush }))

const el = (id: string, extra: Record<string, unknown> = {}): CanvasElement =>
  ({
    id,
    type: 'rectangle',
    version: 1,
    versionNonce: 7,
    isDeleted: false,
    index: 'a0',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    ...extra,
  }) as unknown as CanvasElement

interface Fake {
  port: CanvasPort
  txLog: { label: string; ops: unknown[] }[]
  emit<E extends keyof CanvasEventMap>(e: E, ...a: Parameters<CanvasEventMap[E]>): void
  scene: Map<string, CanvasElement>
  holders: Map<string, LeaseHolder>
  engine: EngineCore & { pendingLeases?: () => readonly string[] }
  setEditing(id: string | null): void
  selection: string[]
}

function fakePort(opts: { withEngine?: boolean; pending?: string[] } = {}): Fake {
  const scene = new Map<string, CanvasElement>([
    ['r1', el('r1')],
    ['gone', el('gone', { isDeleted: true, index: 'a1' })],
  ])
  const holders = new Map<string, LeaseHolder>()
  const txLog: Fake['txLog'] = []
  const listeners = new Map<string, Set<(...a: never[]) => void>>()
  let editing: string | null = null
  let tool: string | null = 'select'
  const selection: string[] = []
  let view: Viewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 }
  const pushes: PushRecord[] = [
    { seq: 1, base: 0, at: 5, ops: [{ k: 'p', id: 'r1', pv: 1, g: { style: { strokeColor: '#f00' } } }] },
  ]
  const welcome = {
    type: 'welcome',
    sid: 'usr_a:tab1',
    you: { uid: 'usr_a', name: 'A', color: '#000', role: 'editor', guest: false },
    readonly: false,
  } as unknown as Welcome
  const save: SaveStatus = { state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }
  const engine = {
    welcome,
    clock: 12,
    epoch: 'ep1',
    elements: () => scene as ReadonlyMap<string, SceneElement>,
    pushLog: () => pushes,
    leaseHolders: () => holders,
    saveStatus: save,
    ...(opts.pending ? { pendingLeases: () => opts.pending as string[] } : {}),
  } as unknown as Fake['engine']
  const port: CanvasPort = {
    items: () => [...scene.values()].filter((e) => !e.isDeleted),
    get: (id) => scene.get(id),
    bounds: (id) => {
      const e = scene.get(id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    get selection() {
      return selection
    },
    select: (ids) => {
      selection.splice(0, selection.length, ...ids)
    },
    viewport: {
      get: () => view,
      set: (v) => {
        view = { ...view, ...v }
      },
      fit: () => {
        view = { ...view, zoom: 0.05 }
      },
    },
    sceneToScreen: (p) => ({ x: p.x * view.zoom + 3, y: p.y * view.zoom + 4 }),
    screenToScene: (p) => ({ x: (p.x - 3) / view.zoom, y: (p.y - 4) / view.zoom }),
    transact<T>(label: string, fn: (tx: CanvasTx) => T): T {
      const ops: unknown[] = []
      const tx: CanvasTx = {
        create: (kind, props) => {
          const id = `new-${ops.length}`
          ops.push({ create: kind, props })
          scene.set(id, el(id, { type: kind, ...props }))
          return id
        },
        update: (id, patch) => {
          ops.push({ update: id, patch })
          const prev = scene.get(id)
          if (prev) scene.set(id, { ...prev, ...patch } as CanvasElement)
        },
        delete: (id) => {
          ops.push({ delete: id })
          const prev = scene.get(id)
          if (prev) scene.set(id, { ...prev, isDeleted: true } as CanvasElement)
        },
      }
      const out = fn(tx)
      txLog.push({ label, ops })
      return out
    },
    setTool: (t) => {
      if (t === 'laser') return false
      tool = t
      return true
    },
    tool: () => tool,
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set)
      set.add(listener as never)
      return () => set.delete(listener as never)
    },
    editingId: () => editing,
    leaseHolder: (id) => holders.get(id) ?? null,
    collaborators: () =>
      [
        { sid: 'usr_b:t', uid: 'usr_b', name: 'B', color: '#111', role: 'viewer', guest: false },
      ] as RosterEntry[],
    saveStatus: () => save,
    engine: opts.withEngine === false ? null : engine,
  }
  return {
    port,
    txLog,
    scene,
    holders,
    engine,
    selection,
    setEditing: (id) => {
      editing = id
    },
    emit: (event, ...a) => {
      for (const l of listeners.get(event) ?? []) (l as (...x: unknown[]) => void)(...a)
    },
  }
}

describe('test facade', () => {
  afterEach(() => {
    const g = globalThis as { lobbyCanvas?: unknown; __lobbyHarness?: unknown }
    delete g.lobbyCanvas
    delete g.__lobbyHarness
  })

  it('writes only through CanvasPort.transact, one step per verb', () => {
    const f = fakePort()
    const { facade } = createFacade(f.port)
    const id = facade.create('note', { x: 5, y: 6 })
    facade.update('r1', { strokeColor: '#00f' })
    facade.delete('r1')
    expect(f.txLog.map((t) => t.label)).toEqual(['facade.create.note', 'facade.update', 'facade.delete'])
    expect(f.txLog[0]?.ops).toEqual([{ create: 'note', props: { x: 5, y: 6 } }])
    expect(f.scene.get(id)?.x).toBe(5)
    expect(f.scene.get('r1')?.isDeleted).toBe(true)
  })

  it('returns copies, never the scene objects', () => {
    const f = fakePort()
    const { facade } = createFacade(f.port)
    const got = facade.get('r1') as unknown as Record<string, unknown>
    got.x = 999
    expect(f.scene.get('r1')?.x).toBe(0)
    const items = facade.items() as unknown as Record<string, unknown>[]
    ;(items[0] as Record<string, unknown>).y = 5
    expect(f.scene.get('r1')?.y).toBe(0)
    expect(facade.items().map((e) => e.id)).toEqual(['r1'])
    expect(facade.get('missing')).toBeNull()
  })

  it('hashes the core map with tombstones (hash.ts), and reads the push log', async () => {
    const f = fakePort()
    const { facade } = createFacade(f.port)
    expect(await facade.hash()).toBe(await hashElements(f.scene.values()))
    expect(await facade.hash()).not.toBe(
      await hashElements([...f.scene.values()].filter((e) => !e.isDeleted)),
    )
    const log = facade.pushedOps()
    expect(log).toHaveLength(1)
    expect(log[0]?.ops[0]).toMatchObject({ k: 'p', id: 'r1' })
  })

  it('splits held and pending leases (inferred pending without the core read)', () => {
    const f = fakePort()
    const { facade } = createFacade(f.port)
    f.holders.set('n1', { sid: 'usr_a:tab1', uid: 'usr_a', name: 'A' })
    f.holders.set('n2', { sid: 'usr_b:t', uid: 'usr_b', name: 'B' })
    expect(facade.leaseState()).toEqual({ held: ['n1'], pending: [], holders: Object.fromEntries(f.holders) })
    f.setEditing('n3')
    expect(facade.leaseState().pending).toEqual(['n3'])
    f.setEditing('n1')
    expect(facade.leaseState().pending).toEqual([])
    expect(facade.leaseHolder('n2')).toEqual({ sid: 'usr_b:t', uid: 'usr_b', name: 'B' })
    expect(facade.leaseHolder('zz')).toBeNull()
  })

  it('uses the core pendingLeases() read when the core has one', () => {
    const f = fakePort({ pending: ['p1', 'p2'] })
    const { facade } = createFacade(f.port)
    expect(facade.leaseState().pending).toEqual(['p1', 'p2'])
  })

  it('passes tools, selection, camera and session reads through', () => {
    const f = fakePort()
    const { facade, hooks } = createFacade(f.port)
    expect(facade.setTool('note')).toBe(true)
    expect(facade.tool()).toBe('note')
    expect(facade.setTool('laser')).toBe(false)
    facade.select(['r1'])
    expect(facade.selection()).toEqual(['r1'])
    facade.zoomToFit()
    expect(hooks.viewport().zoom).toBe(0.05)
    expect(facade.sceneToScreen({ x: 100, y: 100 })).toEqual({ x: 8, y: 9 })
    expect(facade.bounds('r1')).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    expect(facade.collaborators()[0]?.uid).toBe('usr_b')
    expect(facade.saveState().state).toBe('saved')
    expect(hooks.session()).toMatchObject({ welcomed: true, sid: 'usr_a:tab1', uid: 'usr_a', clock: 12 })
    expect(hooks.allElements().map((e) => e.id)).toEqual(['r1', 'gone'])
  })

  it('wave N.1: setViewport, fit and zoomToFit stop the board’s camera animation first (a running tween would take the camera back)', () => {
    const g = globalThis as { __lobbyBoard?: unknown }
    const f = fakePort()
    const order: string[] = []
    const { set, fit } = f.port.viewport
    ;(f.port.viewport as { set: typeof set }).set = (v) => {
      order.push('set')
      set(v)
    }
    ;(f.port.viewport as { fit: typeof fit }).fit = (ids) => {
      order.push('fit')
      fit(ids)
    }
    g.__lobbyBoard = { canvas: { viewport: { stop: () => order.push('stop') } } }
    try {
      const { facade, hooks } = createFacade(f.port)
      hooks.setViewport({ x: 5, zoom: 2 })
      hooks.fit(['r1'])
      facade.zoomToFit()
      expect(order).toEqual(['stop', 'set', 'stop', 'fit', 'stop', 'fit'])
      expect(hooks.viewport()).toMatchObject({ x: 5, zoom: 0.05 })
    } finally {
      delete g.__lobbyBoard
    }
  })

  it('select commits before it returns: a key pressed right after sees the selection (DANA-01)', async () => {
    // a port whose selection lives in "React state": select() is a state update, the reads see what is committed
    const f = fakePort()
    const committed: string[] = []
    const calls: { ids: readonly string[]; depth: number }[] = []
    const port: CanvasPort = Object.create(f.port, {
      select: {
        value: (ids: readonly string[]) => {
          calls.push({ ids: [...ids], depth: lane.depth })
          lane.update(() => void committed.splice(0, committed.length, ...ids))
        },
      },
      selection: { get: () => committed },
    })
    const { facade } = createFacade(port)

    // the control, the old facade's shape: the port's select alone leaves the selection uncommitted until a later task
    port.select(['r1'])
    expect(facade.selection()).toEqual([])
    await lane.runLater()
    expect(facade.selection()).toEqual(['r1'])

    // the facade: select runs inside flushSync and the selection is there when it returns, in the same task
    const flushes = lane.flushes
    facade.select(['gone'])
    expect(facade.selection()).toEqual(['gone'])
    expect(lane.flushes).toBe(flushes + 1)
    expect(calls.at(-1)).toEqual({ ids: ['gone'], depth: 1 })
    facade.select([])
    expect(facade.selection()).toEqual([])
    expect(calls.at(-1)?.depth).toBe(1)
  })

  it("children(frameId) lists a frame's live children in paint order (GAP-1: the wave-1 verb on the page)", () => {
    const f = fakePort()
    f.scene.set('F', el('F', { type: 'frame', index: 'a2' }))
    f.scene.set('c2', el('c2', { frameId: 'F', index: 'a4' }))
    f.scene.set('c1', el('c1', { frameId: 'F', index: 'a3' }))
    f.scene.set('c1.t', el('c1.t', { type: 'text', containerId: 'c1', frameId: 'F', index: 'a5' }))
    f.scene.set('c3', el('c3', { frameId: 'F', index: 'a6', isDeleted: true }))
    f.scene.set('loose', el('loose', { index: 'a7' }))
    const { facade } = createFacade(f.port)
    // the fake port's items() is its scene in insertion order (the real one is the engine's paint order)
    expect(facade.children('F')).toEqual(['c2', 'c1', 'c1.t'])
    expect(facade.children('r1')).toEqual([])
    expect(facade.children('nope')).toEqual([])
    expect(f.txLog).toEqual([])
  })

  it('works without a sync engine (spike A pages): live items only, no pushes', async () => {
    const f = fakePort({ withEngine: false })
    const { facade, hooks } = createFacade(f.port)
    expect(facade.pushedOps()).toEqual([])
    expect(await facade.hash()).toBe(await hashElements(f.port.items()))
    expect(hooks.session()).toMatchObject({ welcomed: false, engine: false, sid: null })
  })

  it('logs changed events and resolves a watch when the value lands', async () => {
    const f = fakePort()
    const { hooks } = createFacade(f.port)
    const watch = hooks.watch({ id: 'r1', field: 'x', value: 42 }, 2_000)
    f.scene.set('r1', { ...(f.scene.get('r1') as CanvasElement), x: 42 } as CanvasElement)
    f.emit('changed', ['r1'])
    const r = await watch
    expect(r.already).toBe(false)
    expect(r.paintedAt).toBeGreaterThanOrEqual(r.appliedAt)
    const log = hooks.changes()
    expect(log).toHaveLength(1)
    expect(log[0]?.ids).toEqual(['r1'])
    expect(hooks.changes(log[0]?.seq)).toEqual([])
    const again = await hooks.watch({ id: 'r1', field: 'x', value: 42 })
    expect(again.already).toBe(true)
    await expect(hooks.watch({ id: 'r1', field: 'x', value: 1 }, 20)).rejects.toThrow(/not reached/)
  })

  it('install owns window.lobbyCanvas and __lobbyHarness; uninstall removes only its own', () => {
    const f = fakePort()
    const g = globalThis as { lobbyCanvas?: LobbyCanvasFacade; __lobbyHarness?: LobbyHarnessHooks }
    const uninstall = install(f.port, createRegistries())
    expect(typeof g.lobbyCanvas?.hash).toBe('function')
    expect(typeof g.__lobbyHarness?.session).toBe('function')
    const other = {} as LobbyCanvasFacade
    g.lobbyCanvas = other
    uninstall?.()
    expect(g.lobbyCanvas).toBe(other)
    expect(g.__lobbyHarness).toBeUndefined()
  })
})
