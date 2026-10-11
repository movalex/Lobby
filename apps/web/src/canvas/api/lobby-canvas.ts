/**
 * `LobbyCanvas`: the FEATURE-FACING canvas API that wave 3 ports `apps/web/src/features/**` onto
 * (docs/EXCALIDRAW-CONTRACTS.md §2-§4). It is spike B's `CanvasPort` (../port.ts, frozen at C0 and
 * unchanged) plus the members features need to leave tldraw. Frozen at wave 1: a change is a change
 * request to the contracts owner (docs/EXCALIDRAW-CONTRACTS.md §0).
 *
 * Rules (§1):
 * - Every document write goes through `transact` (one undo step, or none with `skipUndo`) and then the
 *   sync engine. Nothing a feature does calls the engine's scene API directly; only
 *   `apps/web/src/canvas/**` imports `@excalidraw/*`.
 * - A `transact` whose callback throws applies nothing (tldraw's `bailToMark`).
 * - Every read below is reactive: called inside `useValue`, `computed` or `react` (../../lib/signals.ts)
 *   it re-runs when the value may have changed (the implementation tracks a `source` per concern).
 * - Coordinates are scene coordinates unless a name says `screen` (client/window pixels, what
 *   Playwright's mouse uses) or `overlay` (pixels relative to the overlay root, the canvas container).
 * - Ids are element ids (`CanvasElement.id`); the api's object refs stay `shape:<id>` (canvas-schema
 *   refs.ts). There is one page: tldraw page ids are gone (legacy links map through `lb_doc.import`).
 *
 * Each member says who implements it (`@owner`, see ./owners.ts) and which tldraw `Editor` members it
 * replaces. Until its owner lands it, a member is a stub that throws `NotImplementedError` (./impl.ts).
 */
import type { LeaseHolder, RosterEntry } from '@draftroom/canvas-schema/protocol'
import type {
  Bounds,
  CanvasElement,
  CanvasEventMap,
  CanvasPort,
  CanvasTx,
  ItemKind,
  ScenePoint,
  ScreenPoint,
  Viewport,
} from '../port.ts'

export type {
  Bounds,
  CanvasElement,
  CanvasTx,
  ItemKind,
  LeaseHolder,
  RosterEntry,
  ScenePoint,
  ScreenPoint,
  Viewport,
}

/** The one page every element is on (contracts C1: `PrivateTarget.pageId` sends this constant). */
export const SINGLE_PAGE_ID = 'page:page'

/** Default camera animation, ms (tldraw's `options.animationMediumMs`). */
export const CAMERA_ANIMATION_MS = 320

// ---- names ------------------------------------------------------------------------------------------------

/**
 * Lobby tool names `setTool` takes: the built-in ones below plus every pointer tool a feature registers
 * (`comment`, `vote`, `open-card`, …). `highlight` is a `freedraw` with the highlighter style
 * (customData.lobby.kind = 'highlight'). Refused (never activated): Excalidraw's `text`, `stickynote`,
 * `autoshape`, `image`, `embeddable`, `magicframe`, `bucketfill` (canvas/tools/tools.ts).
 */
export const BUILT_IN_TOOLS = [
  'select',
  'lasso',
  'hand',
  'note',
  'text',
  'rectangle',
  'ellipse',
  'diamond',
  'arrow',
  'line',
  'freedraw',
  'highlight',
  'eraser',
  'laser',
  'frame',
] as const
export type BuiltInTool = (typeof BUILT_IN_TOOLS)[number]
export type ToolName = BuiltInTool | (string & {})

/**
 * What the pointer is doing (tldraw's `isIn('select.idle')`, `getPath()`, `inputs.getIsDragging()`):
 * `idle` is the select tool at rest with no editor open.
 */
export type CanvasGesture =
  | 'idle'
  | 'pressing'
  | 'dragging'
  | 'resizing'
  | 'rotating'
  | 'box-selecting'
  | 'drawing'
  | 'panning'
  | 'editing-text'
  | 'tool'

/** Where a change came from: this tab (a user gesture or a `transact`), its own undo/redo, or the server. */
export type ChangeSource = 'local' | 'history' | 'remote'

/** One batch of document changes (tldraw's `store.listen` diff and `sideEffects` handlers). */
export interface CanvasChange {
  readonly source: ChangeSource
  readonly created: readonly string[]
  readonly updated: readonly string[]
  readonly deleted: readonly string[]
}

/** The feature-level kind of an element (./items.ts `itemKindOf`). */
export type LobbyItemKind =
  | 'note'
  | 'text'
  | 'label'
  | 'shape'
  | 'arrow'
  | 'line'
  | 'draw'
  | 'highlight'
  | 'image'
  | 'file-card'
  | 'frame'

// ---- input -------------------------------------------------------------------------------------------------

export interface InputModifiers {
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
  readonly meta: boolean
}

/**
 * A canvas input event as features see it (tldraw's `editor.on('event')` infos). Dispatched from Lobby's
 * capture-phase listeners on the board wrapper BEFORE the engine sees it; `handled()` stops the engine
 * from acting on it (tldraw's `markEventAsHandled`). Keys go through the key registry, not this stream,
 * except `key-down` notifications for observers (a present session that exits on any key; the mind map's
 * keys typed while a topic's editor is on its way, which `handled()` keeps from everything else).
 */
export type CanvasInputEvent =
  | ({
      readonly type: 'pointer-down' | 'pointer-move' | 'pointer-up' | 'double-click' | 'context-menu'
      readonly scene: ScenePoint
      readonly screen: ScreenPoint
      /** the topmost element under the point (the hit guard applied), or null */
      readonly hit: CanvasElement | null
      readonly button: number
      readonly pointerType: 'mouse' | 'pen' | 'touch'
      handled(): void
    } & InputModifiers)
  | ({
      readonly type: 'wheel' | 'pinch'
      /** the pointer (a wheel) or the middle of the two fingers (a touch pinch) */
      readonly screen: ScreenPoint
      /**
       * The wheel's deltas and their unit (WheelEvent.deltaX/deltaY/deltaMode: 0 pixels, 1 lines, 2 pages;
       * a trackpad pinch is a `pinch` with Ctrl): what the engine zooms or pans by (CR 3b-2).
       * Optional: a synthetic event may leave them out.
       */
      readonly deltaX?: number
      readonly deltaY?: number
      readonly deltaMode?: number
      /**
       * CR 3b-10 (W5-19): a two-finger touch pinch (a `pinch` with no deltas). `start` is the second
       * finger going down, `move` is a finger moving (`handled()` stops the engine's own pinch for that
       * move: Excalidraw's clamps at 0.1), `end` is a finger lifting or a third one landing.
       */
      readonly touch?: TouchPinch
      handled(): void
    } & InputModifiers)
  | ({
      readonly type: 'key-down'
      readonly key: string
      readonly code: string
      /**
       * CR-3D-2: Lobby's own event, not a key the person pressed: the synthetic Enter and Escape the text
       * lease dispatches to open and close an editor (events a script dispatches count too). Observers of
       * what the person types ignore these.
       */
      readonly synthetic: boolean
      /** an IME is composing (the key is part of it) */
      readonly composing: boolean
      /** stops and prevents this key: the board's own key dispatch and the engine never see it */
      handled(): void
    } & InputModifiers)

/** A two-finger touch pinch as the board's input layer reads it (the `touch` of a `pinch` input event). */
export interface TouchPinch {
  readonly phase: 'start' | 'move' | 'end'
  /** the distance between the fingers now over their distance when the second one went down (1 at `start`) */
  readonly scale: number
  /** the middle of the fingers when the second one went down */
  readonly startScreen: ScreenPoint
}

/** Where the pointer is right now (tldraw's `inputs.*`, `getInstanceState().isHoveringCanvas`). */
export interface PointerState extends InputModifiers {
  readonly scene: ScenePoint
  readonly screen: ScreenPoint
  readonly overCanvas: boolean
  /** a button is held (a press or a drag in progress) */
  readonly down: boolean
}

export interface HitTestOptions {
  /** screen pixels of slack around thin shapes (tldraw's `getHitTestMargin()`); default: the engine's */
  readonly margin?: number
  /** a click inside a filled/closed shape counts (tldraw's `hitInside`); default true */
  readonly hitInside?: boolean
  /** prefer an element of the current selection (tldraw's `getSelectedShapeAtPoint`) */
  readonly selectedFirst?: boolean
  /** skip hidden (collapsed) and locked elements; default: hidden skipped, locked kept */
  readonly skipLocked?: boolean
  readonly filter?: (el: CanvasElement) => boolean
}

// ---- viewport ------------------------------------------------------------------------------------------------

export interface CameraMove {
  /** animate (default duration CAMERA_ANIMATION_MS); default false (an immediate move) */
  readonly animate?: boolean | { readonly durationMs: number }
  /** also while the user is following someone or presenting (tldraw's `force`) */
  readonly force?: boolean
}

export interface ZoomToOptions extends CameraMove {
  /** screen pixels kept free around the bounds; default 64 */
  readonly inset?: number
  /** an exact zoom instead of the fit zoom (tldraw's `targetZoom`) */
  readonly zoom?: number
  /** never zoom in above this (default 1: a fit of a few elements is not a magnifier) */
  readonly maxZoom?: number
}

export interface ZoomLimits {
  readonly min: number
  readonly max: number
  /** the zoom-in/out steps (tldraw's `getCameraOptions().zoomSteps`) */
  readonly steps: readonly number[]
  /** the zoom a whole-board fit needs right now; Lobby's floor below Excalidraw's 0.1 (§4.2) */
  readonly fit: number
}

/** `CanvasPort.viewport` plus the camera members features use. */
export interface LobbyViewport {
  /** @owner 2C (core) · getViewportPageBounds, getCamera, getZoomLevel, getEfficientZoomLevel */
  get(): Viewport
  /** @owner 2C (core; `opts` 2C) · setCamera */
  set(viewport: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>, opts?: CameraMove): void
  /** @owner 2C (core; Lobby's own fit below 0.1 is 3b) · zoomToFit, zoomToContent */
  fit(ids?: readonly string[], opts?: CameraMove): void
  /** @owner 3b · zoomToBounds */
  zoomTo(bounds: Bounds, opts?: ZoomToOptions): void
  /** @owner 3b · centerOnPoint */
  centerOn(point: ScenePoint, opts?: CameraMove): void
  /** @owner 3b · zoomToSelectionIfOffscreen: moves only when `target` is not wholly on screen (margin in screen px) */
  ensureVisible(target: Bounds | readonly string[], opts?: CameraMove & { readonly margin?: number }): void
  /** @owner 3b · zoomIn/zoomOut (Ctrl+= / Ctrl+-, the zoom menu), around `at` (default: the centre) */
  zoomStep(direction: 'in' | 'out', at?: ScreenPoint, opts?: CameraMove): void
  /** @owner 2C · stopCameraAnimation */
  stop(): void
  /** @owner 2C · getCameraState() === 'moving' (an animation, a pan or a zoom in progress) */
  moving(): boolean
  /** @owner 3b · getCameraOptions, getBaseZoom */
  limits(): ZoomLimits
  /** @owner 2C · getViewportScreenBounds: the canvas's client rectangle, screen pixels */
  screenRect(): Bounds
  /** @owner 2C · updateViewportScreenBounds: re-measure after the container moved or resized (present mode) */
  remeasure(): void
}

// ---- text ------------------------------------------------------------------------------------------------

/** How an edit starts: the lease flow differs per path (§2.9.2; P1-P8). */
export type EditVia = 'enter' | 'type' | 'double-click' | 'double-tap' | 'api'

export interface EditOptions {
  readonly via: EditVia
  /** keys typed before the grant (type-to-edit), replayed after it */
  readonly initialText?: string
  /** where the caret goes (tldraw: notes open at the end, other shapes with all text selected) */
  readonly caret?: 'end' | 'all'
}

/** The text style fields the measurer needs (canvas-schema `textStyle` group names). */
export interface TextStyle {
  readonly fontFamily: number
  readonly fontSize: number
  readonly lineHeight?: number
  /** wrap at this width (scene px); unwrapped when absent */
  readonly width?: number
}

export interface LobbyText {
  /** @owner 2C · getShapeUtil(s).getText, renderPlaintextFromRichText: an element's plain text (a container's label text) */
  of(id: string): string
  /** @owner 2C · canEditShape: this tab may open the editor on `id` (role, lock, lease holder) */
  canEdit(id: string): boolean
  /**
   * @owner 2C · setEditingShape, setCurrentTool('select.editing_shape'), startEditingShapeWithRichText:
   * opens the editor on `id` through the text lease; resolves true once the lease is granted and the
   * editor is writable, false when denied (someone else is typing: the lease notice shows). Not for
   * frames: a frame's name is `meta` (no lease), renamed with `tx.update(id, {name})` from Lobby's input.
   */
  edit(id: string, opts: EditOptions): Promise<boolean>
  /** @owner 2C · setEditingShape(null), complete(), cancel(): closes the open editor (commit, or `cancel` restores) */
  stop(opts?: { readonly cancel?: boolean }): void
  /** @owner 2C · getRichTextEditor: the open editor's textarea, or null */
  editorElement(): HTMLTextAreaElement | null
  /** @owner 2C · textMeasure.measureText/measureHtml, with the server's metrics (canvas-schema engine layout) */
  measure(text: string, style: TextStyle): { readonly width: number; readonly height: number }
  /**
   * @owner 2C · updateShape({props: {richText}}) on an existing element: acquires the lease, writes the
   * words (one undo step), releases; false when the lease is denied. New elements take `text` in create.
   */
  replace(id: string, text: string, label?: string): Promise<boolean>
}

// ---- styles ------------------------------------------------------------------------------------------------

/**
 * Style values in the engine's element field names (canvas-schema groups.ts `style` and `textStyle`),
 * so features and the style panel share one vocabulary. The palette names Lobby shows are 3a's mapping.
 */
export interface StyleValues {
  readonly strokeColor?: string
  readonly backgroundColor?: string
  readonly fillStyle?: string
  readonly strokeWidth?: number
  readonly strokeStyle?: string
  readonly roughness?: number
  readonly opacity?: number
  readonly fontFamily?: number
  readonly fontSize?: number
  readonly textAlign?: string
  readonly verticalAlign?: string
  readonly startArrowhead?: string | null
  readonly endArrowhead?: string | null
  /** a shape's or a plain line's corners (the engine's `currentItemRoundness`); a connector's kind is `arrowKind` */
  readonly roundness?: 'sharp' | 'round'
  /** next-style only: a connector that is an elbow (`arrowKind: 'elbow'`); reads as `arrowKind === 'elbow'` */
  readonly elbowed?: boolean
  /**
   * CR-W5-3A-1 (W5-40), next-style only: the connector the next arrow tool draws, straight, curved or an
   * elbow (the engine's `currentItemArrowType` 'sharp', 'round', 'elbow'). Picking one never touches the
   * corners of the next rectangle (`roundness`).
   */
  readonly arrowKind?: ArrowKind
  /**
   * CR-3A-7, next-style only: the fill of the next note (one of Lobby's note palette fills; the engine's
   * `currentItemStickynoteBackgroundColor`), taken by every note created without a `backgroundColor` of its
   * own (the note tool, Add a sticky note, a double-click). Reads as Lobby's default note fill until set.
   */
  readonly noteColor?: string
}
export type ArrowKind = 'straight' | 'curved' | 'elbow'
/** Per field: the shared value, or 'mixed' when the selection differs. */
export type MixedStyles = { readonly [K in keyof StyleValues]?: StyleValues[K] | 'mixed' }

export interface LobbyStyles {
  /** @owner 2C · getStyleForNextShape, getInstanceState().stylesForNextShape */
  next(): StyleValues
  /** @owner 2C · setStyleForNextShapes (not an undo step) */
  setNext(patch: StyleValues): void
  /** @owner 3a · the style panel's shared values of `ids` (default: the selection) */
  of(ids?: readonly string[]): MixedStyles
  /** @owner 3a · setStyleForSelectedShapes: one undo step on `ids` (default: the selection) and the next-style */
  apply(patch: StyleValues, ids?: readonly string[]): void
}

// ---- transactions -------------------------------------------------------------------------------------------

export type ReorderTo = 'front' | 'back' | 'forward' | 'backward'

/** `CanvasTx` plus the structural writes features need, all inside the same undo step. */
export interface LobbyTx extends CanvasTx {
  /** @owner 2C · createShapes: several at once, in order; returns their ids */
  createMany(
    items: readonly { readonly kind: ItemKind; readonly props: Readonly<Record<string, unknown>> }[],
  ): string[]
  /** @owner 2C · reparentShapes' z part, sendToBack, bringToFront (the server assigns the final index) */
  reorder(ids: readonly string[], to: ReorderTo): void
  /** @owner 2C · reparentShapes(ids, frame): frame membership (null = out of any frame) */
  setFrame(ids: readonly string[], frameId: string | null): void
  /** @owner 2C · groupShapes: returns the new group id */
  group(ids: readonly string[]): string
  /** @owner 2C · ungroupShapes: removes the outermost group of `ids` */
  ungroup(ids: readonly string[]): void
  /** @owner 2C · createBindings/deleteBindings for arrows: binds an end to `targetId` (null unbinds) */
  bind(arrowId: string, end: 'start' | 'end', targetId: string | null): void
  /** @owner 2C · duplicateShapes: copies through the `onDuplicate` rules (customData registry); returns old → new ids */
  duplicate(ids: readonly string[], offset?: ScenePoint): ReadonlyMap<string, string>
  /**
   * @owner 2C · putContentOntoCurrentPage / createShapes of prepared records (CR-2D-2, W3-9): installs
   * prepared elements (a template scene, pasted notes: `WireElement`-shaped) as new elements, exactly as
   * given, in this transaction. Ids are kept; `index` is replaced by keys on top of the scene in the given
   * order (the server assigns the final ones). Throws, writing nothing, on a missing id or type, a deleted
   * element, a repeated id or an id the board already has. Returns the ids.
   */
  insert(elements: readonly Readonly<Record<string, unknown>>[]): string[]
}

export interface TransactOptions {
  /**
   * Fold this write into this tab's previous undo step when that step is still the top of the stack
   * (tldraw's side-effect handlers run inside the user's own step; the mind map's re-layout after a
   * text change uses this). @owner 2C (the history controller)
   */
  readonly joinPrevious?: boolean
  /**
   * Keep this write out of this tab's undo history (tldraw's `run(fn, {history: 'ignore'})`; a +1, W5-26 /
   * CR-3F-1): it records no step, joins none and leaves the redo stack as it is, so this tab's Ctrl+Z undoes
   * the step before it and never the write. What it changed is taken in like someone else's edit: an undo of
   * an earlier step that changed the same field leaves the write's value ("1 change kept"). The engine
   * pushes it as any edit, and the server's `fix` rows for it fold without a step. Wins over `joinPrevious`.
   * A bare port (no history) ignores it. @owner 2C (the history controller, `UndoController.outside`, through
   * the board page's port): composed in `transact`, real on every port (row `transact.skipUndo`).
   */
  readonly skipUndo?: boolean
}

// ---- the rest ------------------------------------------------------------------------------------------------

/** A remote cursor for overlays (tldraw's `getCollaborators()` presence). */
export interface RemoteCursor {
  readonly sid: string
  readonly uid: string
  readonly name: string
  readonly color: string
  readonly guest: boolean
  /** scene point, or null when their pointer is off the canvas */
  readonly point: ScenePoint | null
  /** their visible scene rectangle (follow, "bring to me"), or null */
  readonly view: Bounds | null
  /** ids they have selected (null while a dot vote is open: the server drops `sel`) */
  readonly selection: readonly string[] | null
  readonly idle: boolean
  /** the lease id of their open editor */
  readonly editing: string | null
  /**
   * The session they follow (their camera follows its `view`), or null (CONTRACTS_REV 10, CR-3C-1).
   * Absent or null from a room or a client one revision older, which do not carry it.
   */
  readonly following?: string | null
  /** Their zoom (presence `view.z`, CONTRACTS_REV 10, CR-3CF-1), or null when their end does not send it. */
  readonly zoom?: number | null
  /**
   * `false`: the room does not stream this session. It is a follower past the cursor cap, listed so "Following
   * you" counts it: no point, view or selection, and never the session to follow or show for a person who has
   * a streaming one (CR-3C-1). Absent or true: its presence streams.
   */
  readonly streaming?: boolean
}

export interface LobbyPresence {
  /**
   * @owner 2C · getCollaborators, getCollaboratorsOnCurrentPage (cursor-capped: at most 40 peers stream,
   * plus the one this tab follows). CONTRACTS_REV 10: also every session that follows this tab, those
   * past the cap as an entry without a point, view or selection (`following` = this tab's sid).
   */
  peers(): readonly RemoteCursor[]
  /** @owner 2C · one peer by session id */
  peer(sid: string): RemoteCursor | null
  /**
   * @owner 2C · wave L (W6 for the wave, as the CanvasPort owner): the other session dragging `id` right now
   * (the room's drag relay, O2's "Bob is moving this": the C0 registries' `dragger`), or null when nobody
   * does. Null on a bare port (no presence). L8-1 and L8-2 skip a note another session drags. Tracks the
   * `presence` concern (a presence frame carries the drags), but read it when you act, not from a cache: a
   * drag that ends with its committed positions may clear before the next presence frame.
   */
  draggerOf(id: string): { readonly sid: string; readonly name: string } | null
  /**
   * @owner 2C · wave L (W6, L6-1; CONTRACTS_REV 12): the other sessions' lasers, each with its samples of
   * the last second (`RemoteLaser`), oldest first; empty in a room older than rev 12 (it relays none) and on
   * a bare port. Every role's laser shows, read-only reviewers' included, and "hide cursors" does not hide
   * it (pointing is deliberate). Tracks the `presence` concern (a presence frame brings new samples); a
   * layer that draws the fade reads it again on its own animation frames. Nothing of it is stored.
   */
  lasers(): readonly RemoteLaser[]
}

/** One sample of another session's laser (L6-1): a scene point and when this tab got it (`performance.now()`). */
export interface LaserSample {
  readonly x: number
  readonly y: number
  readonly at: number
}

/** Another session's laser (L6-1, CONTRACTS_REV 12), with its identity from the roster. */
export interface RemoteLaser {
  readonly sid: string
  readonly uid: string
  readonly name: string
  /** their presence colour (the roster's) */
  readonly color: string
  /** pressed now: their latest presence carries the laser */
  readonly active: boolean
  /** the samples of about the last second, oldest first (a pressed laser keeps at least its newest) */
  readonly points: readonly LaserSample[]
}

/** A follower's camera: the scene point at the canvas's top left, and the zoom (what `viewport.set` takes). */
export interface FollowCamera {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

/** What a follow camera rule (`FollowOptions.camera`) is given. */
export interface FollowCameraInput {
  /** the followed session's visible scene rectangle (their presence `view`) */
  readonly leader: Bounds
  /** this canvas's size on screen, px */
  readonly screen: { readonly width: number; readonly height: number }
  /** the default camera: `leader` fitted whole into `screen`, centred (tldraw's follow) */
  readonly fit: FollowCamera
  /**
   * The followed session's own zoom (presence `view.z`, CONTRACTS_REV 10, CR-3CF-1); absent when their end
   * does not send it (a rev-9 room or client): a rule then works it out from what else it knows.
   */
  readonly leaderZoom?: number | null
}

/** CR-3F-3 (W3-10): how `follow.start` places this tab's camera. */
export interface FollowOptions {
  /**
   * Shapes the follower's camera (tldraw's per-instance `getViewportPageBoundsForFollowing`; R2-04's
   * readable zoom for a gathered phone): called for every new `view` of the followed session and on every
   * resize. Returns the camera to use, or null for `fit`. A camera move only, never a document write.
   */
  readonly camera?: (input: FollowCameraInput) => FollowCamera | null
}

/**
 * Wave L (W6, L6-3): a follow that this person paused by moving the camera keeps its target. `following`: the
 * camera follows `sid`; `paused`: it does not, and `resume()` follows `sid` again.
 */
export interface FollowState {
  readonly sid: string
  readonly status: 'following' | 'paused'
}

export interface LobbyFollow {
  /** @owner 3c · getInstanceState().followingUserId: the session followed, or null (also while paused) */
  current(): string | null
  /**
   * @owner 3c · startFollowingUser (the camera follows their `view`). Starting the session already followed
   * keeps following and replaces the options (a summon over a plain follow).
   */
  start(sid: string, options?: FollowOptions): void
  /** @owner 3c · stopFollowingUser (a paused follow too) */
  stop(): void
  /**
   * @owner 3c · wave L (W6, L6-3): the follow's state, or null when there is none. This person's own camera
   * move (a wheel, a pinch, a press on the canvas) pauses a follow instead of ending it (`followChanged(null)`,
   * `current()` null), and the target stays here; the followed session leaving, `stop()` and Esc end it.
   * Reactive.
   */
  state(): FollowState | null
  /** @owner 3c · wave L (W6, L6-3): a paused follow follows its session again (its options kept); else nothing */
  resume(): void
}

export interface LobbyHistory {
  /** @owner 2C · undo (Lobby's field-level stack, §2.8) */
  undo(): void
  /** @owner 2C · redo */
  redo(): void
  /** @owner 2C · getCanUndo */
  canUndo(): boolean
  /** @owner 2C · getCanRedo */
  canRedo(): boolean
}

/** Board document keys (lb_doc, canvas-schema doc.ts): `startView`, `workshop`, `tagDef:<key>`, `import` (read-only). */
export type DocKey = 'startView' | 'workshop' | `tagDef:${string}` | 'import'

export interface LobbyDoc {
  /** @owner 2C · getDocumentSettings().meta.dr*: one key's value, or undefined */
  get(key: DocKey): unknown
  /** @owner 2C · every key with a prefix (`tagDef:`) */
  entries(prefix?: string): ReadonlyMap<string, unknown>
  /** @owner 2C · updateDocumentSettings: sets keys (null removes); sent no later than the next element push */
  set(entries: Readonly<Record<string, unknown>>): void
}

export interface ExportOptions {
  /** elements to export (default: all live items); hidden (collapsed) ids are always left out */
  readonly ids?: readonly string[]
  /** export exactly this scene rectangle (a frame's, a thumbnail's) */
  readonly bounds?: Bounds
  /** clip to this frame, as the frame's own export does (tldraw's masked bounds) */
  readonly frameId?: string
  readonly scale?: number
  readonly padding?: number
  readonly background?: boolean
  readonly theme?: 'light' | 'dark'
  /** cap the bitmap's longer side (thumbnails) */
  readonly maxSide?: number
  /**
   * Which bytes an uploaded image is drawn from (CR 3E-1): `original` (the upload; the default of
   * `png`, `canvas` and `copy`), `display` (the 2,048 px preview; the default of `svg`, which embeds
   * every image) or `canvas` (what the canvas shows now, nothing fetched: thumbnails). File cards and
   * placed PDF pages draw their face's preview.
   */
  readonly files?: 'original' | 'display' | 'canvas'
  /**
   * Wave N (WS6, the vector PDF): how `svg` carries the text's fonts. `embedded` (the default, today's): the
   * covering woff2 faces as `@font-face` data: URLs (fonts.ts), a self-contained SVG. `names`: no `@font-face`
   * at all, the text naming its families only, for a consumer that embeds the fonts itself (the PDF worker's
   * subset fonts). Ignored by `png`, `canvas` and `copy`.
   */
  readonly fonts?: 'embedded' | 'names'
}

export interface LobbyExport {
  /** @owner 3e · getSvgString: a self-contained SVG (files inlined as data: only here, fonts embedded, §2.10.4) */
  svg(opts?: ExportOptions): Promise<string>
  /** @owner 3e · toImage/getSvgAsImage: a PNG blob (one pHYs chunk) */
  png(opts?: ExportOptions): Promise<Blob>
  /** @owner 3e (3h for the checkpoint preview) · a bitmap of the scene (PDF pages, previews) */
  canvas(opts?: ExportOptions): Promise<HTMLCanvasElement>
  /** @owner 3e · copyAs: puts the export on the clipboard, gated by the board's export policy */
  copy(format: 'png' | 'svg', opts?: ExportOptions): Promise<void>
}

export interface LobbyFiles {
  /** @owner 3g · resolveAssetUrl: a URL for the element's file (a derivative, or the original) */
  urlOf(id: string, opts?: { readonly original?: boolean }): Promise<string | null>
  /** @owner 2C · the loader state of an image element (PendingImageNames, a failing load) */
  status(id: string): 'loading' | 'loaded' | 'failed' | null
  /** @owner 3g · putExternalContent({type: 'files'}): uploads and places files like a drop (Ctrl+U) */
  insert(files: readonly File[], at?: ScenePoint): Promise<readonly string[]>
  /**
   * @owner 3g · tldraw's crop mode (setCroppingShape, select.crop): opens the engine's crop editor on an
   * image or placed page (selecting it), on its thumb, so the crop is written in the pixels every tab
   * loads; false when it cannot (no such image, a file card, read-only, locked). Optional: CR-W5-3G-1.
   */
  crop?(id: string): boolean
  /**
   * @owner 3g · CR 3G-2 (CR-3A-9): counts `upload` as in flight until it settles, so the board's Saved waits
   * for it (canvas/board/uploads.ts `trackUpload`, docs/EXCALIDRAW-MIGRATION.md §2.5.7); resolves or rejects
   * as `upload` does. Ported code cannot import canvas/board/uploads.ts: the media feature's uploads go
   * through this (the assets/board-media.ts tracker seam is its stand-in).
   */
  track<T>(upload: Promise<T>): Promise<T>
}

/**
 * CR-W5-3A-4 (W5-33), tldraw's Input device preference: what a plain mouse wheel does over the canvas.
 * `auto` tells a mouse wheel's notches (zoom) from a trackpad's two-finger scroll (pan) by the events;
 * `mouse`: the wheel always zooms; `trackpad`: it always pans (Excalidraw's own). Ctrl/Cmd + wheel and a
 * trackpad pinch zoom whichever is chosen, and Shift + wheel pans sideways.
 */
export type WheelPreference = 'auto' | 'mouse' | 'trackpad'
export const WHEEL_PREFERENCES: readonly WheelPreference[] = ['auto', 'mouse', 'trackpad']

/**
 * Wave L (W6, the CanvasPort owner of wave L): what this tab knows of the board's room (its sync server).
 */
export interface LobbyRoom {
  /**
   * @owner 2C · the contracts revision the room announced on this tab's current socket (its `contracts` frame:
   * canvas-schema protocol.ts CONTRACTS_REV), or null until that frame came (a new socket, a room older than
   * rev 10, a canvas with no board page). Reactive. Features gate on it what an older sync would refuse or
   * not serve: `present.mins` (PRESENT_MINS_REV, W5) and "Restore these" (RESTORE_ELEMENTS_REV, W7). Null
   * means "not known": offer nothing that needs a newer room.
   */
  contractsRev(): number | null
}

/**
 * Wave N (WS1, N1-6; frozen by the wave N foundation): find what a feature draws without walking the whole scene
 * on every change (a 10k-element board at 60 fps). Every read is of LIVE elements (deleted ones excluded), in
 * paint order, and reactive on the scene (like `items()`). The foundation's implementation is a full walk per
 * read (parts/scene-index.ts); WS1's keeps an incremental index whose answers equal it.
 */
export interface SceneIndex {
  /** @owner 2C · the live sticky notes */
  notes(): readonly CanvasElement[]
  /** @owner 2C · the live elements with a `customData.lobby` key that starts with `prefix` (`react:`, `plusOne:`) */
  withLobbyKeyPrefix(prefix: string): readonly CanvasElement[]
  /** @owner 2C · the live elements whose `frameId` is `frameId` */
  byFrame(frameId: string): readonly CanvasElement[]
  /** @owner 2C · the live elements whose `customData.lobby.kind` is `kind` (`board-card`, `link-card`) */
  byKind(kind: string): readonly CanvasElement[]
  /**
   * @owner 2C · called after the scene applied a batch, with the ids that changed (created, updated or deleted;
   * local or remote), once the index answers for it. Returns the unsubscribe.
   */
  onChanged(listener: (ids: readonly string[]) => void): () => void
}

export interface LobbySettingsValues {
  readonly grid: boolean
  readonly snap: boolean
  readonly focusMode: boolean
  readonly wheel: WheelPreference
}

export interface LobbySettings {
  /**
   * @owner 2C · grid, snapping, focus mode and the wheel preference (tldraw user preferences and instance
   * state). In focus mode the board page hides its chrome (dock, top bar, host slots) and every overlay
   * layer that does not say `focusMode: 'show'` (present mode uses it).
   */
  get(): LobbySettingsValues
  /** @owner 2C · updateUserPreferences, updateInstanceState (a local preference, never synced) */
  set(patch: Partial<LobbySettingsValues>): void
}

export type LobbyCanvasEventMap = CanvasEventMap & {
  /** @owner 2C · store.listen / sideEffects: a batch of document changes with its source */
  change: (change: CanvasChange) => void
  /** @owner 2C · editor.on('event'): canvas input before the engine acts */
  input: (event: CanvasInputEvent) => void
  /** @owner 2C · the active tool changed */
  toolChanged: (tool: string | null) => void
  /** @owner 2C · this tab's editor opened or closed */
  editingChanged: (id: string | null) => void
  /** @owner 2C · editor.on('resize'): the canvas container changed size */
  resize: (screen: Bounds) => void
  /** @owner 2C · lb_doc keys changed */
  docChanged: (keys: readonly string[]) => void
  /** @owner 3c · editor.on('stop-following') */
  followChanged: (sid: string | null) => void
}

/**
 * The feature-facing canvas. Extends the C0 `CanvasPort` (items, get, bounds, selection, select,
 * viewport, sceneToScreen, screenToScene, transact, setTool, tool, on, editingId, leaseHolder,
 * collaborators, saveStatus, engine), whose members keep their C0 meaning.
 */
export interface LobbyCanvas extends CanvasPort {
  /** Widened: the camera members (./LobbyViewport). */
  readonly viewport: LobbyViewport

  /** @owner 2C (core; `opts` 2C) · run, markHistoryStoppingPoint, bailToMark (a throw applies nothing) */
  transact<T>(label: string, fn: (tx: LobbyTx) => T, opts?: TransactOptions): T

  /** @owner 2C · on/off for every event of LobbyCanvasEventMap (core events included) */
  on<E extends keyof LobbyCanvasEventMap>(event: E, listener: LobbyCanvasEventMap[E]): () => void

  // ---- mode, DOM, keyboard ----
  /** @owner 2C · getIsReadonly, getInstanceState().isReadonly: the role's interaction mode (never a UI toggle) */
  readOnly(): boolean
  /** @owner 2C · getContainer: the board wrapper element (aria label, ownerDocument, listeners) */
  container(): HTMLElement | null
  /** @owner 2C · focus + getContainer().focus(): gives the board the keyboard */
  focus(opts?: { readonly preventScroll?: boolean }): void
  /** @owner 2C · getInstanceState().isFocused: the board has the keyboard (the key allowlist is live) */
  hasKeyboard(): boolean
  /** @owner 2C · setCursor: a CSS cursor over the canvas while a pointer tool wants one (null = the tool's) */
  setCursor(cursor: string | null): void

  // ---- pointer and hit testing ----
  /** @owner 2C · inputs.getCurrentPagePoint/getCurrentScreenPoint/getShiftKey/getIsDragging, isHoveringCanvas */
  pointer(): PointerState | null
  /** @owner 2C · isIn('select.idle'), getPath() */
  gesture(): CanvasGesture
  /** @owner 2C · getShapeAtPoint, getSelectedShapeAtPoint, isPointInShape, getHitTestMargin (hidden ids never hit) */
  hitTest(point: ScenePoint, opts?: HitTestOptions): CanvasElement | null
  /** @owner 2C · getHoveredShapeId, getHoveredShape */
  hovered(): string | null

  // ---- reads beyond the port ----
  /** @owner 2C · getSelectionPageBounds (ids = the selection), getCurrentPageBounds (no ids: every live item) */
  boundsOf(ids?: readonly string[]): Bounds | null
  /** @owner 2C · the visible bounds of an element clipped by its frame (getShapeMaskedPageBounds) */
  visibleBounds(id: string): Bounds | null
  /** @owner 2C · isShapeOrAncestorLocked: its own `locked`, or its container's for a bound label */
  isLocked(id: string): boolean
  /** @owner 2C · isShapeHidden: hidden by a mind-map collapse (registries.hidden) */
  isHidden(id: string): boolean
  /**
   * @owner 2C · the render side of a collapse: hides `ids` (opacity 0 through canvas/overrides.ts, the
   * hit guard, selection and export filters) for `owner` until the returned function runs. Replaces
   * tldraw's `isShapeHidden` option and the mind map's `getShapeVisibility`.
   */
  hide(owner: string, ids: Iterable<string>): () => void
  /** @owner 2C · sceneToScreen minus the container origin: overlay-root pixels (tldraw's pageToViewport) */
  sceneToOverlay(point: ScenePoint): ScreenPoint
  /** @owner 2C · the inverse of `sceneToOverlay` */
  overlayToScene(point: ScreenPoint): ScenePoint

  // ---- namespaces ----
  readonly text: LobbyText
  readonly styles: LobbyStyles
  readonly presence: LobbyPresence
  readonly follow: LobbyFollow
  readonly history: LobbyHistory
  readonly doc: LobbyDoc
  readonly export: LobbyExport
  readonly files: LobbyFiles
  readonly settings: LobbySettings
  /** Wave L: the board's room (its contracts revision). */
  readonly room: LobbyRoom
  /** Wave N: the scene index (live notes, lobby key prefixes, frames, kinds), for overlays on big boards. */
  readonly index: SceneIndex
  /** @owner 2C · getColorMode, getCurrentTheme, user.getIsDarkMode (the palette's dark filter is applied by the engine) */
  theme(): 'light' | 'dark'
}
