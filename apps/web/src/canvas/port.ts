/**
 * `CanvasPort`: the engine-neutral interface features use (docs/EXCALIDRAW-MIGRATION.md §2.3.1), frozen at
 * the spike B contracts step C0 (docs/research/excalidraw/spike-b/CONTRACTS.md). Lead-owned; O2
 * implements it in `canvas/port-impl.ts` on the Excalidraw host and the engine core. Features (O5), the
 * test facade (O3) and the installers only ever see this interface and the registries.
 *
 * Every write goes through `transact`, one undo step, and then the sync engine, never straight into
 * `updateScene`, so specs that write through the facade test the real path (§6.3).
 */
import type { LeaseHolder, RosterEntry } from '@draftroom/canvas-schema/protocol'
import type { EngineCore, SaveStatus, SceneElement } from './sync/types.ts'

/** An element as features read it: the engine's element (live or not), typed on the fields everyone uses. */
export type CanvasElement = SceneElement & {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly angle: number
  readonly groupIds: readonly string[]
  readonly frameId: string | null
  readonly locked: boolean
  readonly containerId?: string | null
  readonly customData?: { readonly lobby?: Readonly<Record<string, unknown>>; readonly lobbyServer?: unknown }
}

export interface ScenePoint {
  readonly x: number
  readonly y: number
}
export interface ScreenPoint {
  readonly x: number
  readonly y: number
}
export interface Bounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
/** The visible scene rectangle and the zoom (Lobby's own camera may go below Excalidraw's 0.1 clamp, §4.2). */
export interface Viewport {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly zoom: number
}

/** What a feature can create (a note is a `stickynote` with its label, made with `created: null`). */
export type ItemKind =
  | 'note'
  | 'text'
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'line'
  | 'freedraw'
  | 'image'
  | 'frame'

/** The writes of one `transact` step. `props` and `patch` are engine element fields (and `customData.lobby` keys under `customData`). */
export interface CanvasTx {
  /** creates an element (a note with its label) and returns its id */
  create(kind: ItemKind, props: Readonly<Record<string, unknown>>): string
  update(id: string, patch: Readonly<Record<string, unknown>>): void
  delete(id: string): void
}

export type CanvasEventMap = {
  /** ids whose document state changed (local or remote) */
  changed: (ids: readonly string[]) => void
  selectionChanged: (ids: readonly string[]) => void
  viewportChanged: (viewport: Viewport) => void
  /** Lobby's own pointer listener (every role, §2.7), in scene coordinates; null on leave */
  pointer: (point: ScenePoint | null) => void
}

export interface CanvasPort {
  /** Live elements (deleted ones excluded), in paint order. */
  items(): readonly CanvasElement[]
  /** One element, live or deleted. */
  get(id: string): CanvasElement | undefined
  /** Scene-space axis-aligned bounds of an element (rotation included), or null. */
  bounds(id: string): Bounds | null
  /** The selection (hidden ids already filtered out, §2.3.3). */
  readonly selection: readonly string[]
  select(ids: readonly string[]): void

  readonly viewport: {
    get(): Viewport
    set(viewport: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>): void
    /** Lobby's own fit (zoom below 0.1 allowed, §4.2); with ids, fit those. */
    fit(ids?: readonly string[]): void
  }
  sceneToScreen(point: ScenePoint): ScreenPoint
  screenToScene(point: ScreenPoint): ScenePoint

  /** One undo step: every write inside `fn`, pushed by the engine as ordinary edits. */
  transact<T>(label: string, fn: (tx: CanvasTx) => T): T

  /** Lobby tool names (`select`, `note`, `text`, `arrow`, … and the pointer tools features register); false when refused. */
  setTool(tool: string): boolean
  tool(): string | null

  on<E extends keyof CanvasEventMap>(event: E, listener: CanvasEventMap[E]): () => void

  // ---- session state the facade and features read ----
  /** The lease id of this tab's open text editor, or null. */
  editingId(): string | null
  /** Who holds the text lease on `id`, or null. */
  leaseHolder(id: string): LeaseHolder | null
  /** The roster (everyone in the room, uncapped). */
  collaborators(): readonly RosterEntry[]
  saveStatus(): SaveStatus
  /** The sync engine core (null on pages without sync, such as spike A's). */
  readonly engine: EngineCore | null
}
