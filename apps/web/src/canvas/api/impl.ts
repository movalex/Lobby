/**
 * `createLobbyCanvas`: the LobbyCanvas implementation scaffold (docs/EXCALIDRAW-CONTRACTS.md §2).
 * OWNER: 2C (wave 2 web-engine), who replaces each 2C stub with the real member (the members other owners
 * implement are built in ./parts/*.ts, one module per owner, so nobody else edits this file); the member table below
 * says who implements what, and the contracts test (./contracts.test.ts) fails when a member of
 * `LobbyCanvas` is missing from it or names an unknown owner.
 *
 * What is already real at wave 1: the C0 `CanvasPort` members (delegated), reactive tracking of the
 * reads the port has events for (document, selection, viewport), and a few members that are pure
 * compositions of port members (`boundsOf`, `isHidden`, `isLocked`, `doc.*`, `tx.createMany`). Every
 * other member is a stub that throws `NotImplementedError(owner, member)`.
 *
 * `LobbyCanvasDeps` is 2C's to extend (the Excalidraw API, the undo controller, the lease client, …);
 * only the `LobbyCanvas` interface is frozen.
 */
import { source } from '../../lib/signals.ts'
import type { CanvasEventMap, CanvasPort, CanvasTx } from '../port.ts'
import { union } from './geometry.ts'
import { contentItems } from './items.ts'
import type { LobbyCanvas, LobbyCanvasEventMap, LobbyTx } from './lobby-canvas.ts'
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
}

/** How each member is provided today: the C0 port, composed here, or a stub for its owner. */
export type MemberStatus = 'core' | 'composed' | 'stub'

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
  // stubs
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
      ['on:change', '2C'],
      ['on:input', '2C'],
      ['on:toolChanged', '2C'],
      ['on:editingChanged', '2C'],
      ['on:resize', '2C'],
      ['on:docChanged', '2C'],
      ['on:followChanged', '3c'],
    ] as const
  ).map(([path, owner]) => ({ path, owner, status: 'stub' as const })),
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

/** The reactive sources of this canvas (2C bumps the ones the port has no event for yet). */
export interface LobbyCanvasSources {
  readonly doc: ReturnType<typeof source>
  readonly selection: ReturnType<typeof source>
  readonly viewport: ReturnType<typeof source>
  /** 2C: bump on tool, editor, presence, save-state and lb_doc changes */
  readonly tool: ReturnType<typeof source>
  readonly editing: ReturnType<typeof source>
  readonly presence: ReturnType<typeof source>
  readonly save: ReturnType<typeof source>
  readonly docKeys: ReturnType<typeof source>
}

export interface LobbyCanvasHandle {
  readonly canvas: LobbyCanvas
  readonly sources: LobbyCanvasSources
  dispose(): void
}

export function createLobbyCanvas(deps: LobbyCanvasDeps): LobbyCanvasHandle {
  const { port, registries } = deps
  const sources: LobbyCanvasSources = {
    doc: source('canvas.doc'),
    selection: source('canvas.selection'),
    viewport: source('canvas.viewport'),
    tool: source('canvas.tool'),
    editing: source('canvas.editing'),
    presence: source('canvas.presence'),
    save: source('canvas.save'),
    docKeys: source('canvas.docKeys'),
  }
  const offs = [
    port.on('changed', () => sources.doc.bump()),
    port.on('selectionChanged', () => sources.selection.bump()),
    port.on('viewportChanged', () => sources.viewport.bump()),
  ]
  const offSave = port.engine?.onSaveStatus(() => sources.save.bump())
  if (offSave) offs.push(offSave)

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

  const lobbyTx = (tx: CanvasTx): LobbyTx => ({
    create: (kind, props) => tx.create(kind, props),
    update: (id, patch) => tx.update(id, patch),
    delete: (id) => tx.delete(id),
    createMany: (items) => items.map((i) => tx.create(i.kind, i.props)),
    reorder: stub('tx.reorder'),
    setFrame: stub('tx.setFrame'),
    group: stub('tx.group'),
    ungroup: stub('tx.ungroup'),
    bind: stub('tx.bind'),
    duplicate: stub('tx.duplicate'),
  })

  const engineDoc = () => {
    sources.docKeys.track()
    return port.engine?.doc() ?? new Map<string, unknown>()
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
      get() {
        sources.viewport.track()
        return port.viewport.get()
      },
      set: (v) => port.viewport.set(v),
      fit: (ids) => port.viewport.fit(ids),
      ...navigation,
      stop: stub('viewport.stop'),
      moving: stub('viewport.moving'),
      screenRect: stub('viewport.screenRect'),
      remeasure: stub('viewport.remeasure'),
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
      if (opts?.joinPrevious)
        throw new NotImplementedError(ownerOf('transact.joinPrevious'), 'transact.joinPrevious')
      return port.transact(label, (tx) => fn(lobbyTx(tx)))
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
      },
    },

    // ---- stubs ----
    readOnly: stub('readOnly'),
    container: stub('container'),
    focus: stub('focus'),
    hasKeyboard: stub('hasKeyboard'),
    setCursor: stub('setCursor'),
    pointer: stub('pointer'),
    gesture: stub('gesture'),
    hitTest: stub('hitTest'),
    hovered: stub('hovered'),
    visibleBounds: stub('visibleBounds'),
    hide: stub('hide'),
    sceneToOverlay: stub('sceneToOverlay'),
    overlayToScene: stub('overlayToScene'),
    theme: stub('theme'),
    text: {
      of: stub('text.of'),
      canEdit: stub('text.canEdit'),
      edit: stub('text.edit'),
      stop: stub('text.stop'),
      editorElement: stub('text.editorElement'),
      measure: stub('text.measure'),
      replace: stub('text.replace'),
    },
    styles: {
      next: stub('styles.next'),
      setNext: stub('styles.setNext'),
      ...stylesPart,
    },
    presence: { peers: stub('presence.peers'), peer: stub('presence.peer') },
    follow: followPart.follow,
    history: {
      undo: stub('history.undo'),
      redo: stub('history.redo'),
      canUndo: stub('history.canUndo'),
      canRedo: stub('history.canRedo'),
    },
    export: exportPart,
    files: { ...filesPart, status: stub('files.status') },
    settings: { get: stub('settings.get'), set: stub('settings.set') },
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
