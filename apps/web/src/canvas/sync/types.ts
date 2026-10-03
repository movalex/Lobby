/**
 * The engine-core interface (docs/EXCALIDRAW-MIGRATION.md §2.5, §8.6.2), frozen at the spike B contracts
 * step C0 (docs/research/excalidraw/spike-b/CONTRACTS.md). Lead-owned; O2 implements it in
 * `canvas/sync/core/**` (pure), `adapter/**` (Excalidraw) and `headless/**` (Node). O1's protocol tests and
 * O3's load generator drive the headless client; O3's facade reads the core.
 *
 * NODE-SAFE (CONTRACTS.md "Node-safety rules"): explicit `.ts` import extensions, no DOM (no `window`,
 * `document` or DOM lib types), no `import.meta.env`, no Vite-only imports, no `@excalidraw/excalidraw`.
 * Typechecked by `apps/sync/tsconfig.node-safe.json`.
 */
import type {
  Ack,
  ClientMessage,
  LeaseClientMessage,
  LeaseHolder,
  LeaseServerMessage,
  Op,
  PresenceIn,
  Push,
  ServerMessage,
  SnapshotFrame,
  Welcome,
} from '@draftroom/canvas-schema/protocol'

// ---- the scene -------------------------------------------------------------------------------------

/**
 * One element as a scene holds it: an Excalidraw element, typed loosely (the adapter owns the engine
 * type; the headless scene holds plain objects of the same shape). Excalidraw mutates elements in place,
 * so the core keeps its own clones (`confirmed`).
 */
export type SceneElement = Readonly<Record<string, unknown>> & {
  readonly id: string
  readonly type: string
  readonly version: number
  readonly versionNonce: number
  readonly isDeleted: boolean
  readonly index: string | null
}

/**
 * The `appState` flags the core needs (§2.5.3 gesture detection, §2.5.4 hold-back), as the adapter reads
 * them from Excalidraw (`selectedElementsAreBeingDragged`, `isResizing`, `isRotating`,
 * `resizingElement`, `newElement`, `multiElement`, `selectedLinearElement?.isEditing`, `isCropping`,
 * `editingTextElement`) or as a headless test sets them.
 */
export interface GestureState {
  readonly dragging: boolean
  readonly resizing: boolean
  readonly rotating: boolean
  readonly cropping: boolean
  /** `selectedLinearElement.isEditing` (a point edit) */
  readonly editingLinear: boolean
  readonly resizingElementId: string | null
  readonly newElementId: string | null
  readonly multiElementId: string | null
  readonly selectedLinearElementId: string | null
  readonly selectedElementIds: readonly string[]
  /** `editingTextElement?.id` */
  readonly editingTextElementId: string | null
}

export const IDLE_GESTURE: GestureState = Object.freeze({
  dragging: false,
  resizing: false,
  rotating: false,
  cropping: false,
  editingLinear: false,
  resizingElementId: null,
  newElementId: null,
  multiElementId: null,
  selectedLinearElementId: null,
  selectedElementIds: [],
  editingTextElementId: null,
})

/** What `onChange` hands the core: every element (deleted ones included) and the gesture flags. */
export interface SceneSnapshot {
  readonly elements: readonly SceneElement[]
  readonly gesture: GestureState
}

/** What the core needs from a scene (the Excalidraw adapter, or the headless Map-backed scene). */
export interface SceneAdapter {
  read(): SceneSnapshot
  /**
   * Installs the whole element array, sorted by `(index, id)`, with `CaptureUpdateAction.NEVER` (D4;
   * never through `reconcileElements`). The core runs the index pre-pass (E2) before calling it.
   */
  apply(elements: readonly SceneElement[]): void
}

// ---- the transport ----------------------------------------------------------------------------------

/** What arrives from the server: a parsed message, or the decoded binary snapshot frame after a reset `welcome`. */
export type ServerInbound = ServerMessage | SnapshotFrame

export type TransportState = 'connecting' | 'open' | 'closed'
export interface TransportClose {
  readonly code: number
  readonly reason: string
}

/**
 * A WebSocket (browser or Node 24's global WebSocket) or an in-memory test pipe. It parses and validates
 * inbound frames (`ServerMessage`, and `decodeSnapshotFrame` for the binary one) before `onMessage`.
 */
export interface Transport {
  readonly state: TransportState
  send(message: ClientMessage): void
  onMessage(listener: (message: ServerInbound) => void): () => void
  onState(listener: (state: TransportState, close?: TransportClose) => void): () => void
  close(code?: number, reason?: string): void
}

/**
 * The lease side of the transport, as spike A's `LeaseClient` takes it (`canvas/lease/client.ts`):
 * implemented by the real core (its lease messages go through the same socket, in the session's FIFO
 * order, §2.4.3) and by spike A's `fakeServer.ts`, so the spike A pages keep working.
 */
export interface LeaseTransport {
  send(message: LeaseClientMessage): void
}
/** `new LeaseClient(connect, me)`'s first argument. */
export type LeaseConnect = (onMessage: (message: LeaseServerMessage) => void) => LeaseTransport

// ---- Saved (§2.5.7) ------------------------------------------------------------------------------------

export type SaveState = 'saved' | 'saving' | 'offline' | 'not-saved' | 'retrying'
export interface SaveStatus {
  readonly state: SaveState
  /** dirty elements + ops in flight + queued offline ops */
  readonly pending: number
  /** "Offline — N changes on this device" */
  readonly offlineChanges: number
  /** the last non-retryable reject, for "Change not saved" + reason */
  readonly lastReject: { readonly id: string; readonly code: string } | null
}

// ---- the core -------------------------------------------------------------------------------------------

/** One push as it went out (B10's recorder, the facade's `pushedOps()`). */
export interface PushRecord {
  readonly seq: number
  readonly base: number
  readonly at: number
  readonly ops: readonly Op[]
  readonly doc?: Push['doc']
}

export interface EngineCoreOptions {
  readonly transport: Transport
  readonly scene: SceneAdapter
  /** the tab id (`hello.tab`, the offline queue's key) */
  readonly tab: string
  /** the per-tab offline queue (IndexedDB in the browser, memory in Node and for guests) */
  readonly offline?: OfflineQueueStore
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  /** `echo_suspect` and other diagnostics (dev and test builds fail the run on it) */
  readonly log?: (event: string, detail: Readonly<Record<string, unknown>>) => void
}

/** The per-tab offline queue store (§2.5.6). The browser's is IndexedDB with a Web Locks lock per tab. */
export interface OfflineQueueStore {
  load(): Promise<readonly OfflineEntry[]>
  save(entries: readonly OfflineEntry[]): Promise<void>
  clear(): Promise<void>
}
export interface OfflineEntry {
  readonly element: SceneElement
  /** the dirty groups (`c:<key>` for customData keys) */
  readonly groups: readonly string[]
  readonly base: number
  readonly queuedAt: number
  /**
   * Pushes of this element that were out without an ack when the queue was written (wave 5, V1): a
   * reload or a closed tab loses their acks, so the page that adopts the queue decides them exactly as a
   * reconnect does (the core's `replayLost`), not as unsent changes. Absent in queues written before.
   */
  readonly lost?: readonly LostPushRecord[]
  /** the `#doc` entry's board-document writes that were out without an ack, with what they replaced */
  readonly lostDoc?: readonly LostDocRecord[]
}

/** One lost push's part for one element, as the offline queue keeps it (OfflineEntry.lost). */
export interface LostPushRecord {
  /** the socket the push went out on (`<tab>:<socket generation>`): one FIFO, delivered as a prefix */
  readonly src: string
  readonly seq: number
  /** the push's base clock */
  readonly base: number
  /** when the change was made (the push's time) */
  readonly at: number
  readonly create: boolean
  readonly groups: readonly string[]
  /** the copy the groups were taken from */
  readonly el: SceneElement
  /** a patch's: what it was built on (the server copy plus earlier pushes in flight) */
  readonly ref?: SceneElement
  /** a patch's `pv`: the server version it was built on */
  readonly pv?: number
  /** a create's: the server copy it was made over (a tombstone it undeletes), if any */
  readonly prior?: SceneElement
  /**
   * CONTRACTS_REV 11 (W5-ENG-2): the push's receipt id, when it went out to a rev-11 room: the page that
   * adopts the queue asks the room whether it landed. Absent in queues written before, or for a rev-10 room.
   */
  readonly rid?: string
}

/** A lost board-document write: the keys it set and the server's values it replaced (null: none). */
export interface LostDocRecord {
  readonly set: Readonly<Record<string, unknown>>
  readonly base: Readonly<Record<string, unknown>>
  /**
   * the base clock of the push that carried it (what the writer had seen of the server): with the server's
   * per-key clock (the welcome's `docClocks`, CONTRACTS_REV 9), a key not written past it was not written by
   * anyone since (wave 4b, 2C: the doc-key ABA). Absent in queues written before it existed.
   */
  readonly clock?: number
  /**
   * per key, when above `clock`: the clock the room gave the last of this tab's own earlier writes of the key
   * that this push was built behind and that was acked before the cut (`ack.clock`, the key's `lb_doc.clock`
   * after it). The decision counts other users' writes from it: two writes of one key within one round trip
   * go out on the same base, and the first one's landing is not another user's write (wave 4c, 2C: V1 round
   * 6, DB1). Keys with no such write, and queues written before it existed, have none.
   */
  readonly clocks?: Readonly<Record<string, number>>
  /** CONTRACTS_REV 11 (W5-ENG-2): the receipt id of the push that carried it, when it had one */
  readonly rid?: string
}

/**
 * The pure engine core: it takes server messages and local scene snapshots, and emits pushes, lease
 * messages and Saved state. It holds `confirmed`, `known`, `dirty`, `inFlight` and the offline queue
 * (§2.5.1), and the derived-arrow marking (§2.9.4 rule 7): a local arrow change is classified with
 * `isDerivedArrowChange` from `@draftroom/canvas-schema/groups` (by structure, within
 * `GEOMETRY_TOLERANCE_PX`, fixed segments by order), held while a cause of this client is pending (a
 * gesture in progress, an unacked push that changed a target of the arrow, or a dirty, unpushed local
 * change to a target), reset from `confirmed` in the same scan when nothing is pending, and kept past
 * the text editor's close.
 */
export interface EngineCore {
  /** Sends `hello` (and again after every reconnect, with `since` and `epoch`). */
  start(): void
  /** Every scene change (the adapter's `onChange`, or a headless edit). */
  onSceneChange(snapshot: SceneSnapshot): void
  /** Sends coalesced edits now (tests; the core also flushes on its own timers). */
  flush(): void
  stop(): void

  /** The session as the server announced it (null before the first `welcome`). */
  readonly welcome: Welcome | null
  /** The last server clock processed, and the epoch. */
  readonly clock: number
  readonly epoch: string | null
  /** Every element the core holds, deleted ones included (the facade's `hash()` input, hash.ts). */
  elements(): ReadonlyMap<string, SceneElement>
  /** The server's copy of one element. */
  confirmed(id: string): SceneElement | undefined
  /** Whether a local change to this arrow is currently held as derived (never pushed). */
  isDerivedHeld(id: string): boolean

  readonly saveStatus: SaveStatus
  onSaveStatus(listener: (status: SaveStatus) => void): () => void
  /** Every ack, in order (the undo stack folds `fix` and `derived` rows from these). */
  onAck(listener: (ack: Ack) => void): () => void
  /** Every push sent, in order. */
  pushLog(): readonly PushRecord[]

  /**
   * The board document (`lb_doc`, canvas-schema doc.ts) as this client last applied it: `welcome.doc`,
   * then every `changes` batch's `doc` (a null value removes the key). CR by O5 (spike B): the contracts
   * had `Push.doc` and `PushRecord.doc` but no way for a feature to write or read a doc key.
   */
  doc(): ReadonlyMap<string, unknown>
  /**
   * Writes board-document keys as a push's `doc: {set}` (null removes a key), ordered with this
   * session's element pushes (a doc write queued before an element edit is sent no later than it). The
   * server validates each key (doc.ts `docValueProblem`, `canWriteDocKey`). O5's tags write
   * `tagDef:<key>` before the element's `tag:<key>`, which the server accepts only for a tag in `lb_doc`
   * (§3.3).
   */
  setDoc(set: Readonly<Record<string, unknown>>): void

  /** The lease side for spike A's `LeaseClient`. */
  readonly leaseConnect: LeaseConnect
  /** Who holds each leased id right now (from `welcome.leases` and `lease` broadcasts). */
  leaseHolders(): ReadonlyMap<string, LeaseHolder>

  /** Presence out (≤ 20 Hz; the core throttles). `drag` rules: §2.7. */
  sendPresence(presence: Omit<PresenceIn, 'type'>): void
}

export type CreateEngineCore = (options: EngineCoreOptions) => EngineCore

// ---- the headless client (O1's protocol tests, O3's load generator) ----------------------------------------------

export interface HeadlessClientOptions {
  /** `ws://host:port` of the sync server */
  readonly syncUrl: string
  readonly boardId: string
  /** the connect URL's `sessionId` (the tab id) */
  readonly tab: string
  /** a signed test ticket */
  readonly ticket: string
  /** a WebSocket constructor; default Node 24's global `WebSocket` */
  readonly WebSocketImpl?: new (
    url: string,
  ) => unknown
  readonly now?: () => number
  readonly log?: EngineCoreOptions['log']
}

/**
 * The engine core on a Map-backed scene and a real WebSocket, for Node. Local edits go through the scene
 * and `core.onSceneChange`, exactly as the browser adapter does, so tests run the client code browsers run.
 */
export interface HeadlessClient {
  readonly core: EngineCore
  /** The scene the client edits (the same map `SceneAdapter.read` returns). */
  readonly scene: Map<string, SceneElement>
  /** Connects, sends `hello` and resolves with the `welcome` (after the snapshot or catch-up is applied). */
  connect(): Promise<Welcome>
  /** One local step: edit the scene in `fn`, then hand the core a snapshot with `gesture`. */
  edit(fn: (scene: Map<string, SceneElement>) => void, gesture?: Partial<GestureState>): void
  /** Resolves when Saved (no dirty, no in flight, nothing queued). */
  saved(timeoutMs?: number): Promise<void>
  /** Every raw message received, in order (tests assert on the protocol). */
  received(): readonly ServerInbound[]
  /** Sends a raw frame, bypassing the core: a message, or any string (forged frames, protocol tests). */
  sendRaw(frame: ClientMessage | string): void
  close(): Promise<void>
}

export type CreateHeadlessClient = (options: HeadlessClientOptions) => HeadlessClient
