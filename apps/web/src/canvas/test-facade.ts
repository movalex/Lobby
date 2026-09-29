/**
 * O3's e2e test facade, `window.lobbyCanvas` (docs/EXCALIDRAW-MIGRATION.md §6.3; types frozen at C0 in
 * ./test-facade.types.ts). `canvas/spike/installers.ts` calls `install` on the spike board page, which is
 * reachable only with VITE_LOBBY_ENGINE=excalidraw and the dev-auth guard; nothing else imports this file,
 * so the normal build carries none of it.
 *
 * Every write goes through `CanvasPort.transact` (one undo step each) and from there through the sync
 * engine, never straight into `updateScene`, so specs that write through the facade test the real path.
 * Every return value is a JSON-serializable copy (specs call the verbs through `page.evaluate`).
 *
 * Besides the frozen facade, the harness reads `window.__lobbyHarness` (typed below, O3's own): the
 * session as the server announced it, every element the engine core holds (deleted ones included, for
 * convergence diffs), the camera for the §8.4 pan method, and a "painted" watch for edit visibility (B9).
 * It is installed and removed together with the facade.
 */
import { hashElements } from '@draftroom/canvas-schema/hash'
import type { LeaseHolder } from '@draftroom/canvas-schema/protocol'
import type { CanvasElement, CanvasPort, ItemKind, ScenePoint, Viewport } from './port.ts'
import type { CanvasRegistries } from './registries.ts'
import type { SceneElement } from './sync/types.ts'
import type { LeaseStateView, LobbyCanvasFacade } from './test-facade.types.ts'

// ---- the harness side channel (not part of the frozen facade) ----------------------------------------------

/** Who this tab is on the board, from the engine core's `welcome` (all null before it). */
export interface FacadeSession {
  readonly welcomed: boolean
  readonly sid: string | null
  readonly uid: string | null
  readonly role: string | null
  readonly readonly: boolean | null
  readonly clock: number
  readonly epoch: string | null
  /** whether a sync engine is attached at all (spike A pages have none) */
  readonly engine: boolean
}

/** One entry of the change log: the ids a `changed` event named, when, and when the next frame painted. */
export interface ChangeLogEntry {
  readonly seq: number
  readonly ids: readonly string[]
  /** wall clock (`Date.now()`, the clock every process on the machine shares) of the event */
  readonly at: number
  /** wall clock of the second animation frame after it (the change is on screen), or null until then */
  paintedAt: number | null
}

/** A field value an element must reach (B9's visibility watch). */
export interface WatchSpec {
  readonly id: string
  readonly field: string
  readonly value: unknown
}
export interface WatchResult {
  /** wall clock of the `changed` event that applied the value (or of the watch start, if already there) */
  readonly appliedAt: number
  /** wall clock of the second animation frame after it */
  readonly paintedAt: number
  readonly already: boolean
}

export interface LobbyHarnessHooks {
  session(): FacadeSession
  /** every element the engine core holds (deleted ones included), as copies; without an engine, `items()` */
  allElements(): SceneElement[]
  viewport(): Viewport
  setViewport(v: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>): void
  fit(ids?: string[]): void
  screenToScene(point: ScenePoint): ScenePoint
  /** change-log entries with `seq` > `after` (the log keeps the last 20,000) */
  changes(after?: number): ChangeLogEntry[]
  /** resolves when `port.get(id)[field]` equals `value` (deep-equal through JSON), painted; rejects after `timeoutMs` */
  watch(spec: WatchSpec, timeoutMs?: number): Promise<WatchResult>
  /** Performance measures whose name starts with `lobby.` (O2's adapter timings for §8.4), and clears them when asked */
  measures(clear?: boolean): { name: string; startTime: number; duration: number }[]
  /** when the facade was installed (wall clock) */
  readonly installedAt: number
}

type FacadeGlobal = typeof globalThis & {
  lobbyCanvas?: LobbyCanvasFacade
  __lobbyHarness?: LobbyHarnessHooks
}

// ---- helpers ----------------------------------------------------------------------------------------------

/** The machine clock, shared by every browser process and the test process (cross-process visibility). */
const wallNow = () => Date.now()

/** A JSON-serializable copy (what `page.evaluate` would give the spec anyway). */
function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
const twoFrames = async () => {
  await nextFrame()
  await nextFrame()
}

/** The ids of the lease requests the engine core has sent and has no answer for (see `leaseState`). */
type PendingSource = { pendingLeases?: () => readonly string[] }

const CHANGE_LOG_CAP = 20_000

/**
 * Builds the facade on a port. Exported for the unit test; `install` is what the board page runs.
 */
export function createFacade(port: CanvasPort): {
  facade: LobbyCanvasFacade
  hooks: LobbyHarnessHooks
  dispose(): void
} {
  const log: ChangeLogEntry[] = []
  let seq = 0
  const installedAt = wallNow()
  const watchers = new Set<() => void>()

  const offChanged = port.on('changed', (ids) => {
    const entry: ChangeLogEntry = { seq: ++seq, ids: [...ids], at: wallNow(), paintedAt: null }
    log.push(entry)
    if (log.length > CHANGE_LOG_CAP) log.splice(0, log.length - CHANGE_LOG_CAP)
    void twoFrames().then(() => {
      entry.paintedAt = wallNow()
    })
    for (const w of [...watchers]) w()
  })

  const session = (): FacadeSession => {
    const w = port.engine?.welcome ?? null
    return {
      welcomed: w !== null,
      sid: w?.sid ?? null,
      uid: w?.you.uid ?? null,
      role: w?.you.role ?? null,
      readonly: w?.readonly ?? null,
      clock: port.engine?.clock ?? 0,
      epoch: port.engine?.epoch ?? null,
      engine: port.engine !== null,
    }
  }

  const allElements = (): SceneElement[] =>
    port.engine ? [...port.engine.elements().values()].map(copy) : port.items().map(copy)

  const leaseState = (): LeaseStateView => {
    const holders: Record<string, LeaseHolder> = {}
    const map = port.engine?.leaseHolders()
    if (map) for (const [id, h] of map) holders[id] = copy(h)
    const mySid = port.engine?.welcome?.sid ?? null
    const held = Object.entries(holders)
      .filter(([, h]) => mySid !== null && h.sid === mySid)
      .map(([id]) => id)
    // The frozen EngineCore has no read of the lease requests in flight (a change request asks for
    // `pendingLeases()`); use it when the core provides it, else infer: an editor open on an id this tab
    // does not hold is the guard's pending editor (P3b, P5).
    const source = port.engine as unknown as PendingSource | null
    let pending: string[]
    if (source && typeof source.pendingLeases === 'function') pending = [...source.pendingLeases()]
    else {
      const editing = port.editingId()
      pending = editing !== null && !held.includes(editing) ? [editing] : []
    }
    return { held, pending, holders }
  }

  const facade: LobbyCanvasFacade = {
    items: () => port.items().map(copy) as CanvasElement[],
    get: (id) => {
      const el = port.get(id)
      return el ? copy(el) : null
    },
    create: (kind: ItemKind, props) => port.transact(`facade.create.${kind}`, (tx) => tx.create(kind, props)),
    update: (id, patch) => {
      port.transact('facade.update', (tx) => tx.update(id, patch))
    },
    delete: (id) => {
      port.transact('facade.delete', (tx) => tx.delete(id))
    },
    select: (ids) => port.select([...ids]),
    selection: () => [...port.selection],
    tool: () => port.tool(),
    setTool: (tool) => port.setTool(tool),
    sceneToScreen: (point) => copy(port.sceneToScreen(point)),
    bounds: (id) => copy(port.bounds(id)),
    zoomToFit: () => port.viewport.fit(),
    editingId: () => port.editingId(),
    leaseHolder: (id) => copy(port.leaseHolder(id) ?? null),
    collaborators: () => port.collaborators().map(copy),
    saveState: () => copy(port.saveStatus()),
    hash: () => hashElements(port.engine ? port.engine.elements().values() : port.items()),
    pushedOps: () => (port.engine ? port.engine.pushLog().map(copy) : []),
    leaseState,
  }

  const hooks: LobbyHarnessHooks = {
    installedAt,
    session,
    allElements,
    viewport: () => copy(port.viewport.get()),
    setViewport: (v) => port.viewport.set(v),
    fit: (ids) => port.viewport.fit(ids),
    screenToScene: (p) => copy(port.screenToScene(p)),
    changes: (after = 0) => log.filter((e) => e.seq > after).map((e) => ({ ...e, ids: [...e.ids] })),
    watch: (spec, timeoutMs = 30_000) =>
      new Promise<WatchResult>((resolve, reject) => {
        const matches = () => {
          const el = port.get(spec.id) as Record<string, unknown> | undefined
          return el !== undefined && sameJson(el[spec.field], spec.value)
        }
        const finish = async (already: boolean) => {
          const appliedAt = wallNow()
          await twoFrames()
          resolve({ appliedAt, paintedAt: wallNow(), already })
        }
        if (matches()) return void finish(true)
        const timer = setTimeout(() => {
          watchers.delete(check)
          reject(new Error(`watch ${spec.id}.${spec.field}: not reached in ${timeoutMs} ms`))
        }, timeoutMs)
        const check = () => {
          if (!matches()) return
          watchers.delete(check)
          clearTimeout(timer)
          void finish(false)
        }
        watchers.add(check)
      }),
    measures: (clear = false) => {
      if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return []
      const out = performance
        .getEntriesByType('measure')
        .filter((m) => m.name.startsWith('lobby.'))
        .map((m) => ({ name: m.name, startTime: m.startTime, duration: m.duration }))
      if (clear) for (const m of new Set(out.map((x) => x.name))) performance.clearMeasures(m)
      return out
    },
  }

  return {
    facade,
    hooks,
    dispose: () => {
      offChanged()
      watchers.clear()
    },
  }
}

/**
 * Defence in depth: the board page is only routed behind the guard, and so is the facade. (Read through a
 * cast so the e2e harness can import this file's types without Vite's `ImportMeta`; Vite still replaces
 * `import.meta.env` in the built code.)
 */
function guardAllows(): boolean {
  const env = (import.meta as unknown as { env?: { DEV?: boolean; VITE_DRAFTROOM_DEV_AUTH?: string } }).env
  return env?.DEV === true || env?.VITE_DRAFTROOM_DEV_AUTH === '1'
}

export function install(port: CanvasPort, registries: CanvasRegistries): (() => void) | undefined {
  void registries
  if (!guardAllows()) return undefined
  const g = globalThis as FacadeGlobal
  const { facade, hooks, dispose } = createFacade(port)
  g.lobbyCanvas = facade
  g.__lobbyHarness = hooks
  return () => {
    dispose()
    if (g.lobbyCanvas === facade) delete g.lobbyCanvas
    if (g.__lobbyHarness === hooks) delete g.__lobbyHarness
  }
}
