/**
 * `createLobbyCanvas`: the LobbyCanvas implementation (docs/EXCALIDRAW-CONTRACTS.md §2).
 * OWNER: 2C (wave 2 web-engine). The members other owners implement are built in ./parts/*.ts, one
 * module per owner, so nobody else edits this file; the member table below says who implements what,
 * and the contracts test (./contracts.test.ts) fails when a member of `LobbyCanvas` is missing from it or
 * names an unknown owner.
 *
 * How members are provided:
 *  - the C0 `CanvasPort` members, delegated, with reactive tracking of the reads the port has events for
 *    (document, selection, viewport, save state);
 *  - members composed from port members alone (`boundsOf`, `isHidden`, `isLocked`, `doc.*`,
 *    `tx.createMany`, and 2C's `text.of`, `visibleBounds`, `sceneToOverlay`/`overlayToScene` and the
 *    structural `tx` writes of ../board/tx.ts);
 *  - members that need the board page's engine (the Excalidraw host, the input layer, the lease, undo,
 *    presence): real when the board page passes its `board` handles (canvas/board/handles.ts), a stub
 *    naming 2C otherwise (a canvas built on a bare port, as in the unit tests);
 *  - every member owned by a wave-3 owner is its part's (a stub naming the owner until the part lands;
 *    status `part` once it has, LANDED_PARTS below).
 *
 * NODE-SAFE: no engine and no DOM imports here (the board handles bring the engine).
 */
import { source } from '../../lib/signals.ts'
import {
  bind as bindTx,
  duplicate as duplicateTx,
  group as groupTx,
  reorder as reorderTx,
  setFrame as setFrameTx,
  type TxView,
  ungroup as ungroupTx,
} from '../board/tx.ts'
import type { CanvasElement, CanvasEventMap, CanvasPort, CanvasTx, ItemKind } from '../port.ts'
import { intersection, union } from './geometry.ts'
import { contentItems, textOf } from './items.ts'
import type {
  Bounds,
  CameraMove,
  CanvasGesture,
  HitTestOptions,
  LobbyCanvas,
  LobbyCanvasEventMap,
  LobbyFiles,
  LobbyHistory,
  LobbyPresence,
  LobbySettings,
  LobbyStyles,
  LobbyText,
  LobbyTx,
  PointerState,
  ScenePoint,
  Viewport,
} from './lobby-canvas.ts'
import { NotImplementedError, notImplemented, type Owner } from './owners.ts'
import { createExportPart } from './parts/export.ts'
import { createFilesPart } from './parts/files.ts'
import { createFollowPart } from './parts/follow.ts'
import { createNavigationPart } from './parts/navigation.ts'
import { createStylesPart } from './parts/styles.ts'
import type { PartDeps } from './parts/types.ts'
import type { FeatureRegistries } from './registries.ts'

export interface LobbyCanvasDeps {
  readonly port: CanvasPort
  readonly registries: FeatureRegistries
  /** the board page's engine handles (canvas/board/handles.ts); without them 2C's engine members are stubs */
  readonly board?: BoardHandles
}

/** What a board-page member is reactive on (the board handles notify, the canvas bumps its source). */
export type BoardConcern =
  | 'mode'
  | 'pointer'
  | 'hover'
  | 'tool'
  | 'editing'
  | 'presence'
  | 'settings'
  | 'theme'
  | 'history'
  | 'files'
  | 'docKeys'

/** The board-page events of LobbyCanvasEventMap (C0's four come from the port, `followChanged` from 3c). */
export type BoardEvent = 'change' | 'input' | 'toolChanged' | 'editingChanged' | 'resize' | 'docChanged'

/**
 * The board page's engine, as this canvas needs it (engine-neutral types: the Excalidraw specifics stay
 * in canvas/board/**). Implemented by `createBoardHandles` (canvas/board/handles.ts).
 */
export interface BoardHandles {
  subscribe(concern: BoardConcern, listener: () => void): () => void
  on<E extends BoardEvent>(event: E, listener: LobbyCanvasEventMap[E]): () => void
  readOnly(): boolean
  container(): HTMLElement | null
  focus(opts?: { readonly preventScroll?: boolean }): void
  hasKeyboard(): boolean
  setCursor(cursor: string | null): void
  theme(): 'light' | 'dark'
  pointer(): PointerState | null
  gesture(): CanvasGesture
  hitTest(point: ScenePoint, opts?: HitTestOptions): CanvasElement | null
  hovered(): string | null
  hide(owner: string, ids: Iterable<string>): () => void
  readonly viewport: {
    set(viewport: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>, opts?: CameraMove): void
    fit(ids?: readonly string[], opts?: CameraMove): void
    stop(): void
    moving(): boolean
    screenRect(): Bounds
    remeasure(): void
  }
  readonly text: Pick<LobbyText, 'edit' | 'stop' | 'editorElement' | 'measure' | 'replace'>
  readonly styles: Pick<LobbyStyles, 'next' | 'setNext'>
  readonly presence: LobbyPresence
  readonly history: LobbyHistory & {
    /** runs `write` (a transact) and folds the step it records into this tab's previous one */
    joinPrevious<T>(write: () => T): T
  }
  readonly files: Pick<LobbyFiles, 'status'>
  readonly settings: LobbySettings
  /** a local `doc.set` (the board page reports `docChanged` for it) */
  docWritten(keys: readonly string[]): void
  /** a fresh element or group id (the engine's) */
  newId(): string
}

/**
 * How each member is provided today: the C0 port; composed here from port members; the board page's
 * (real when createLobbyCanvas gets the board handles, a stub naming 2C on a bare port); a wave-3
 * owner's landed part (./parts/*.ts, real everywhere); a landed part that needs the board page's engine
 * (real on the board page, a stub naming its owner on a bare port); or a stub for its owner.
 */
export type MemberStatus = 'core' | 'composed' | 'board' | 'part' | 'board-part' | 'stub'

/**
 * Members a wave-3 owner has landed in its part (./parts/*.ts): real on a bare port and on the board page
 * (status `part`). CR-3A-1, CR 3G-1 and 3c's CR, merged into one set at the wave-3 integration
 * (docs/EXCALIDRAW-CONTRACTS.md §12, W3-1): each owner adds its paths here when its part lands, instead of
 * editing the rows below.
 */
const LANDED_PARTS: ReadonlySet<string> = new Set([
  // 3a: parts/styles.ts
  'styles.of',
  'styles.apply',
  // 3c: parts/follow.ts
  'follow.current',
  'follow.start',
  'follow.stop',
  'on:followChanged',
  // 3g: parts/files.ts
  'files.urlOf',
  'files.insert',
  // 3b: parts/navigation.ts (composed from the canvas's own members; CR 3b-1)
  'viewport.zoomTo',
  'viewport.centerOn',
  'viewport.ensureVisible',
  'viewport.zoomStep',
  'viewport.limits',
])

/**
 * Members a wave-3 owner has landed in a part that needs the board page's engine (status `board-part`): real
 * when the engine is attached before the canvas is created (the board page), a stub naming the owner on a
 * bare port (CR 3E-2, accepted at the wave-3 integration, W3-1).
 */
const LANDED_BOARD_PARTS: ReadonlySet<string> = new Set([
  // 3e: parts/export.ts (the engine's exporters)
  'export.svg',
  'export.png',
  'export.canvas',
  'export.copy',
])

/** 2C's members composed from port members alone (the rest of 2C's are the board page's). */
const COMPOSED_BY_2C: ReadonlySet<string> = new Set([
  'text.of',
  'visibleBounds',
  'sceneToOverlay',
  'overlayToScene',
  'tx.reorder',
  'tx.setFrame',
  'tx.group',
  'tx.ungroup',
  'tx.bind',
  'tx.duplicate',
])

export interface MemberInfo {
  /** 'items', 'viewport.zoomTo', 'text.edit', 'tx.reorder', 'on:change' */
  readonly path: string
  readonly owner: Owner
  readonly status: MemberStatus
}

/**
 * Every LobbyCanvas member and its owner. The one list the stubs, the docs table and the contracts
 * test are built from. Core members keep the C0 owner of the port implementation (2C).
 */
export const LOBBY_CANVAS_MEMBERS: readonly MemberInfo[] = [
  // C0 CanvasPort (delegated to the port)
  ...[
    'items',
    'get',
    'bounds',
    'selection',
    'select',
    'viewport.get',
    'viewport.set',
    'viewport.fit',
    'sceneToScreen',
    'screenToScene',
    'transact',
    'setTool',
    'tool',
    'on',
    'editingId',
    'leaseHolder',
    'collaborators',
    'saveStatus',
    'engine',
    'tx.create',
    'tx.update',
    'tx.delete',
    'on:changed',
    'on:selectionChanged',
    'on:viewportChanged',
    'on:pointer',
  ].map((path) => ({ path, owner: '2C' as const, status: 'core' as const })),
  // composed at wave 1 from port members (2C reviews and may replace)
  ...['boundsOf', 'isHidden', 'isLocked', 'doc.get', 'doc.entries', 'doc.set', 'tx.createMany'].map(
    (path) => ({
      path,
      owner: '2C' as const,
      status: 'composed' as const,
    }),
  ),
  // wave 2C's members (composed, or the board page's) and the wave-3 owners' stubs
  ...(
    [
      ['transact.joinPrevious', '2C'],
      ['viewport.zoomTo', '3b'],
      ['viewport.centerOn', '3b'],
      ['viewport.ensureVisible', '3b'],
      ['viewport.zoomStep', '3b'],
      ['viewport.stop', '2C'],
      ['viewport.moving', '2C'],
      ['viewport.limits', '3b'],
      ['viewport.screenRect', '2C'],
      ['viewport.remeasure', '2C'],
      ['readOnly', '2C'],
      ['container', '2C'],
      ['focus', '2C'],
      ['hasKeyboard', '2C'],
      ['setCursor', '2C'],
      ['pointer', '2C'],
      ['gesture', '2C'],
      ['hitTest', '2C'],
      ['hovered', '2C'],
      ['visibleBounds', '2C'],
      ['hide', '2C'],
      ['sceneToOverlay', '2C'],
      ['overlayToScene', '2C'],
      ['theme', '2C'],
      ['text.of', '2C'],
      ['text.canEdit', '2C'],
      ['text.edit', '2C'],
      ['text.stop', '2C'],
      ['text.editorElement', '2C'],
      ['text.measure', '2C'],
      ['text.replace', '2C'],
      ['styles.next', '2C'],
      ['styles.setNext', '2C'],
      ['styles.of', '3a'],
      ['styles.apply', '3a'],
      ['presence.peers', '2C'],
      ['presence.peer', '2C'],
      ['follow.current', '3c'],
      ['follow.start', '3c'],
      ['follow.stop', '3c'],
      ['history.undo', '2C'],
      ['history.redo', '2C'],
      ['history.canUndo', '2C'],
      ['history.canRedo', '2C'],
      ['export.svg', '3e'],
      ['export.png', '3e'],
      ['export.canvas', '3e'],
      ['export.copy', '3e'],
      ['files.urlOf', '3g'],
      ['files.status', '2C'],
      ['files.insert', '3g'],
      ['settings.get', '2C'],
      ['settings.set', '2C'],
      ['tx.reorder', '2C'],
      ['tx.setFrame', '2C'],
      ['tx.group', '2C'],
      ['tx.ungroup', '2C'],
      ['tx.bind', '2C'],
      ['tx.duplicate', '2C'],
      ['tx.insert', '2C'],
      ['on:change', '2C'],
      ['on:input', '2C'],
      ['on:toolChanged', '2C'],
      ['on:editingChanged', '2C'],
      ['on:resize', '2C'],
      ['on:docChanged', '2C'],
      ['on:followChanged', '3c'],
    ] as const
  ).map(
    ([path, owner]): MemberInfo => ({
      path,
      owner,
      status:
        owner !== '2C'
          ? LANDED_PARTS.has(path)
            ? 'part'
            : LANDED_BOARD_PARTS.has(path)
              ? 'board-part'
              : 'stub'
          : COMPOSED_BY_2C.has(path)
            ? 'composed'
            : 'board',
    }),
  ),
]

const ownerOf = (path: string): Owner => {
  const m = LOBBY_CANVAS_MEMBERS.find((x) => x.path === path)
  if (!m) throw new Error(`LOBBY_CANVAS_MEMBERS has no ${path}`)
  return m.owner
}
// biome-ignore lint/suspicious/noExplicitAny: stubs take any member's signature
const stub = (path: string): any => notImplemented(ownerOf(path), path)

const CORE_EVENTS: ReadonlySet<string> = new Set([
  'changed',
  'selectionChanged',
  'viewportChanged',
  'pointer',
])

const BOARD_EVENTS: ReadonlySet<string> = new Set<BoardEvent>([
  'change',
  'input',
  'toolChanged',
  'editingChanged',
  'resize',
  'docChanged',
])

/** The reactive sources of this canvas (the port's events and the board handles bump them). */
export interface LobbyCanvasSources {
  readonly doc: ReturnType<typeof source>
  readonly selection: ReturnType<typeof source>
  readonly viewport: ReturnType<typeof source>
  readonly tool: ReturnType<typeof source>
  readonly editing: ReturnType<typeof source>
  readonly presence: ReturnType<typeof source>
  readonly save: ReturnType<typeof source>
  readonly docKeys: ReturnType<typeof source>
  readonly mode: ReturnType<typeof source>
  readonly pointer: ReturnType<typeof source>
  readonly hover: ReturnType<typeof source>
  readonly settings: ReturnType<typeof source>
  readonly theme: ReturnType<typeof source>
  readonly history: ReturnType<typeof source>
  readonly files: ReturnType<typeof source>
}

export interface LobbyCanvasHandle {
  readonly canvas: LobbyCanvas
  readonly sources: LobbyCanvasSources
  dispose(): void
}

/** Optional reads a transaction of the board page's port offers (canvas/port-impl.ts `LobbyPortTx`). */
interface PortTxReads {
  read?(id: string): CanvasElement | undefined
}

/** The transaction's view for ../board/tx.ts: the scene with this step's writes on top. */
function txView(port: CanvasPort, tx: CanvasTx, newId: () => string): TxView {
  const reads = tx as CanvasTx & PortTxReads
  const patches = new Map<string, Record<string, unknown>>()
  const created = new Map<string, CanvasElement>()
  const get = (id: string): CanvasElement | undefined => {
    if (reads.read) return reads.read(id)
    const base = created.get(id) ?? port.get(id)
    const patch = patches.get(id)
    return base && patch ? ({ ...base, ...patch } as CanvasElement) : base
  }
  return {
    get,
    items() {
      const out: CanvasElement[] = []
      for (const el of port.items()) {
        const v = get(el.id)
        if (v && !v.isDeleted) out.push(v)
      }
      for (const id of created.keys()) {
        const v = get(id)
        if (v && !v.isDeleted) out.push(v)
      }
      return out
    },
    update(id, patch) {
      tx.update(id, patch)
      patches.set(id, { ...(patches.get(id) ?? {}), ...patch })
    },
    create(kind: ItemKind, props) {
      const id = tx.create(kind, props)
      created.set(id, {
        groupIds: [],
        frameId: null,
        locked: false,
        angle: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        version: 1,
        versionNonce: 0,
        isDeleted: false,
        index: null,
        ...props,
        id,
        type: kind === 'note' ? 'stickynote' : kind,
      } as unknown as CanvasElement)
      return id
    },
    newId,
  }
}

let fallbackIds = 0
const fallbackId = () => `lc${Date.now().toString(36)}${(++fallbackIds).toString(36)}`

export function createLobbyCanvas(deps: LobbyCanvasDeps): LobbyCanvasHandle {
  const { port, registries, board } = deps
  const sources: LobbyCanvasSources = {
    doc: source('canvas.doc'),
    selection: source('canvas.selection'),
    viewport: source('canvas.viewport'),
    tool: source('canvas.tool'),
    editing: source('canvas.editing'),
    presence: source('canvas.presence'),
    save: source('canvas.save'),
    docKeys: source('canvas.docKeys'),
    mode: source('canvas.mode'),
    pointer: source('canvas.pointer'),
    hover: source('canvas.hover'),
    settings: source('canvas.settings'),
    theme: source('canvas.theme'),
    history: source('canvas.history'),
    files: source('canvas.files'),
  }
  const offs = [
    port.on('changed', () => sources.doc.bump()),
    port.on('selectionChanged', () => sources.selection.bump()),
    port.on('viewportChanged', () => sources.viewport.bump()),
  ]
  const offSave = port.engine?.onSaveStatus(() => sources.save.bump())
  if (offSave) offs.push(offSave)
  if (board) {
    const concerns: [BoardConcern, ReturnType<typeof source>][] = [
      ['mode', sources.mode],
      ['pointer', sources.pointer],
      ['hover', sources.hover],
      ['tool', sources.tool],
      ['editing', sources.editing],
      ['presence', sources.presence],
      ['settings', sources.settings],
      ['theme', sources.theme],
      ['history', sources.history],
      ['files', sources.files],
      ['docKeys', sources.docKeys],
    ]
    for (const [c, s] of concerns) offs.push(board.subscribe(c, () => s.bump()))
  }

  // a member of the board page: real with the board handles, else the stub naming its owner
  // biome-ignore lint/suspicious/noExplicitAny: members of any signature
  const onBoard = <F extends (...a: any[]) => any>(path: string, make: (b: BoardHandles) => F): F =>
    board ? make(board) : stub(path)

  // the members other owners implement, each in its own part module (parts/*.ts)
  let self: LobbyCanvas | null = null
  const partDeps: PartDeps = {
    port,
    registries,
    self: () => {
      if (!self) throw new Error('LobbyCanvas part used before createLobbyCanvas returned')
      return self
    },
  }
  const navigation = createNavigationPart(partDeps)
  const stylesPart = createStylesPart(partDeps)
  const followPart = createFollowPart(partDeps)
  const exportPart = createExportPart(partDeps)
  const filesPart = createFilesPart(partDeps)

  const newId = () => board?.newId() ?? fallbackId()
  const lobbyTx = (tx: CanvasTx): LobbyTx => {
    const view = txView(port, tx, newId)
    return {
      create: (kind, props) => view.create(kind, props),
      update: (id, patch) => view.update(id, patch),
      delete: (id) => tx.delete(id),
      createMany: (items) => items.map((i) => view.create(i.kind, i.props)),
      reorder: (ids, to) => void reorderTx(view, ids, to),
      setFrame: (ids, frameId) => setFrameTx(view, ids, frameId),
      group: (ids) => groupTx(view, ids),
      ungroup: (ids) => ungroupTx(view, ids),
      bind: (arrowId, end, targetId) => bindTx(view, arrowId, end, targetId),
      duplicate: (ids, offset) =>
        duplicateTx(view, ids, offset ?? { x: 20, y: 20 }, registries.customData.list()),
      // CR-2D-2 (W3-9): the board page's port transaction has `insert` (spike B O2, canvas/port-impl.ts
      // LobbyCanvasTx); a bare C0 port does not, so the member names 2C there
      insert: (elements) => {
        const insert = (tx as { insert?: (e: readonly Readonly<Record<string, unknown>>[]) => string[] })
          .insert
        if (typeof insert !== 'function') return stub('tx.insert')(elements)
        return insert.call(tx, elements)
      },
    }
  }

  const engineDoc = () => {
    sources.docKeys.track()
    return port.engine?.doc() ?? new Map<string, unknown>()
  }

  const viewportNow = () => {
    sources.viewport.track()
    return port.viewport.get()
  }

  const canvas: LobbyCanvas = {
    // ---- C0 port, tracked ----
    items() {
      sources.doc.track()
      return port.items()
    },
    get(id) {
      sources.doc.track()
      return port.get(id)
    },
    bounds(id) {
      sources.doc.track()
      return port.bounds(id)
    },
    get selection() {
      sources.selection.track()
      return port.selection
    },
    select: (ids) => port.select(ids),
    viewport: {
      get: viewportNow,
      set: (v, opts) => (board ? board.viewport.set(v, opts) : port.viewport.set(v)),
      // `fit` is 3b's part too (CR 3b-6): Lobby's own fit camera, below Excalidraw's 0.1 when the board
      // needs it (lobby-canvas.ts "Lobby's own fit below 0.1 is 3b"); the port's fit clamps at 0.1
      ...navigation,
      stop: onBoard('viewport.stop', (b) => () => b.viewport.stop()),
      moving: onBoard('viewport.moving', (b) => () => {
        sources.viewport.track()
        return b.viewport.moving()
      }),
      screenRect: onBoard('viewport.screenRect', (b) => () => {
        sources.viewport.track()
        return b.viewport.screenRect()
      }),
      remeasure: onBoard('viewport.remeasure', (b) => () => b.viewport.remeasure()),
    },
    sceneToScreen(p) {
      sources.viewport.track()
      return port.sceneToScreen(p)
    },
    screenToScene(p) {
      sources.viewport.track()
      return port.screenToScene(p)
    },
    transact(label, fn, opts) {
      const run = () => port.transact(label, (tx) => fn(lobbyTx(tx)))
      if (!opts?.joinPrevious) return run()
      if (!board) throw new NotImplementedError(ownerOf('transact.joinPrevious'), 'transact.joinPrevious')
      return board.history.joinPrevious(run)
    },
    setTool: (tool) => port.setTool(tool),
    tool() {
      sources.tool.track()
      return port.tool()
    },
    on<E extends keyof LobbyCanvasEventMap>(event: E, listener: LobbyCanvasEventMap[E]) {
      if (CORE_EVENTS.has(event)) {
        return port.on(event as keyof CanvasEventMap, listener as CanvasEventMap[keyof CanvasEventMap])
      }
      if (event === 'followChanged') {
        return followPart.onFollowChanged(listener as LobbyCanvasEventMap['followChanged'])
      }
      if (board && BOARD_EVENTS.has(event)) {
        return board.on(event as BoardEvent, listener as LobbyCanvasEventMap[BoardEvent])
      }
      throw new NotImplementedError(ownerOf(`on:${event}`), `on:${event}`)
    },
    editingId() {
      sources.editing.track()
      return port.editingId()
    },
    leaseHolder(id) {
      sources.presence.track()
      return port.leaseHolder(id)
    },
    collaborators() {
      sources.presence.track()
      return port.collaborators()
    },
    saveStatus() {
      sources.save.track()
      return port.saveStatus()
    },
    get engine() {
      return port.engine
    },

    // ---- composed ----
    boundsOf(ids) {
      sources.doc.track()
      const list = ids ?? port.selection
      const pick = ids === undefined && list.length === 0 ? contentItems(port.items()).map((e) => e.id) : list
      return union(pick.map((id) => port.bounds(id)))
    },
    isHidden: (id) => registries.hidden.isHidden(id),
    isLocked(id) {
      sources.doc.track()
      const el = port.get(id)
      if (!el) return false
      if (el.locked) return true
      return el.containerId ? (port.get(el.containerId)?.locked ?? false) : false
    },
    doc: {
      get: (key) => engineDoc().get(key),
      entries(prefix) {
        const all = engineDoc()
        if (!prefix) return all
        return new Map([...all].filter(([k]) => k.startsWith(prefix)))
      },
      set(entries) {
        const engine = port.engine
        if (!engine) throw new Error('doc.set: this canvas has no sync engine')
        engine.setDoc(entries)
        board?.docWritten(Object.keys(entries))
      },
    },
    visibleBounds(id) {
      sources.doc.track()
      const b = port.bounds(id)
      if (!b) return null
      const el = port.get(id)
      const frameId = el?.frameId ?? (el?.containerId ? port.get(el.containerId)?.frameId : null)
      if (!frameId) return b
      const frame = port.bounds(frameId)
      return frame ? intersection(b, frame) : b
    },
    sceneToOverlay(p) {
      const v = viewportNow()
      return { x: (p.x - v.x) * v.zoom, y: (p.y - v.y) * v.zoom }
    },
    overlayToScene(p) {
      const v = viewportNow()
      return { x: p.x / v.zoom + v.x, y: p.y / v.zoom + v.y }
    },

    // ---- the board page's ----
    readOnly: onBoard('readOnly', (b) => () => {
      sources.mode.track()
      return b.readOnly()
    }),
    container: onBoard('container', (b) => () => b.container()),
    focus: onBoard('focus', (b) => (opts?: { readonly preventScroll?: boolean }) => b.focus(opts)),
    hasKeyboard: onBoard('hasKeyboard', (b) => () => {
      sources.pointer.track()
      return b.hasKeyboard()
    }),
    setCursor: onBoard('setCursor', (b) => (cursor: string | null) => b.setCursor(cursor)),
    pointer: onBoard('pointer', (b) => () => {
      sources.pointer.track()
      return b.pointer()
    }),
    gesture: onBoard('gesture', (b) => () => {
      sources.pointer.track()
      sources.editing.track()
      sources.tool.track()
      return b.gesture()
    }),
    hitTest: onBoard('hitTest', (b) => (point: ScenePoint, opts?: HitTestOptions) => {
      sources.doc.track()
      return b.hitTest(point, opts)
    }),
    hovered: onBoard('hovered', (b) => () => {
      sources.hover.track()
      return b.hovered()
    }),
    hide: onBoard('hide', (b) => (owner: string, ids: Iterable<string>) => b.hide(owner, ids)),
    theme: onBoard('theme', (b) => () => {
      sources.theme.track()
      return b.theme()
    }),
    text: {
      of(id) {
        sources.doc.track()
        const el = port.get(id)
        return el ? textOf(el, (x) => port.get(x)) : ''
      },
      canEdit: onBoard('text.canEdit', (b) => (id: string) => {
        sources.mode.track()
        sources.presence.track()
        sources.doc.track()
        if (b.readOnly()) return false
        const el = port.get(id)
        if (!el || el.isDeleted) return false
        const target = el.type === 'text' && el.containerId ? port.get(el.containerId) : el
        if (
          !target ||
          target.isDeleted ||
          canvas.isLocked(target.id) ||
          registries.hidden.isHidden(target.id)
        )
          return false
        const holder = port.leaseHolder(target.id)
        const me = port.engine?.welcome?.sid ?? null
        if (holder && holder.sid !== me) return false
        return ['text', 'stickynote', 'rectangle', 'ellipse', 'diamond', 'arrow'].includes(target.type)
      }),
      edit: onBoard('text.edit', (b) => b.text.edit),
      stop: onBoard('text.stop', (b) => b.text.stop),
      editorElement: onBoard('text.editorElement', (b) => () => {
        sources.editing.track()
        return b.text.editorElement()
      }),
      measure: onBoard('text.measure', (b) => b.text.measure),
      replace: onBoard('text.replace', (b) => b.text.replace),
    },
    styles: {
      next: onBoard('styles.next', (b) => () => {
        sources.tool.track()
        return b.styles.next()
      }),
      setNext: onBoard('styles.setNext', (b) => b.styles.setNext),
      ...stylesPart,
    },
    presence: {
      peers: onBoard('presence.peers', (b) => () => {
        sources.presence.track()
        return b.presence.peers()
      }),
      peer: onBoard('presence.peer', (b) => (sid: string) => {
        sources.presence.track()
        return b.presence.peer(sid)
      }),
    },
    follow: followPart.follow,
    history: {
      undo: onBoard('history.undo', (b) => () => b.history.undo()),
      redo: onBoard('history.redo', (b) => () => b.history.redo()),
      canUndo: onBoard('history.canUndo', (b) => () => {
        sources.history.track()
        return b.history.canUndo()
      }),
      canRedo: onBoard('history.canRedo', (b) => () => {
        sources.history.track()
        return b.history.canRedo()
      }),
    },
    export: exportPart,
    files: {
      ...filesPart,
      status: onBoard('files.status', (b) => (id: string) => {
        sources.files.track()
        sources.doc.track()
        return b.files.status(id)
      }),
    },
    settings: {
      get: onBoard('settings.get', (b) => () => {
        sources.settings.track()
        return b.settings.get()
      }),
      set: onBoard('settings.set', (b) => b.settings.set),
    },
  }
  self = canvas
  return {
    canvas,
    sources,
    dispose() {
      for (const off of offs) off()
    },
  }
}
