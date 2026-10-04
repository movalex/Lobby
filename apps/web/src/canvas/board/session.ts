/**
 * One board session of Lobby's Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §2.3-§2.9; wave 2C):
 * the socket with the real tickets, the engine core, the lease client, spike B's input layer (allowlist,
 * editor-open guard, double-tap), undo, presence with the drag relay, the render overrides and hit guard,
 * the image loader, the CanvasPort, and on top of them the feature-facing `LobbyCanvas` with the feature
 * registries (docs/EXCALIDRAW-CONTRACTS.md). React-free; the page (./LobbyBoardPage.tsx) renders its
 * state and installs CANVAS_FEATURES on `canvas` after the first welcome.
 *
 * Spike B's board session (canvas/spike/board/session.ts) is the reviewed starting point: the order at
 * attach, the scene adapter, the N and T tools, undo's actions and the re-fit are the same; what is new
 * is the LobbyCanvas and its board handles, the outer input layer, the peer store, the change stream,
 * the notices through the page's notice region, and no spike features.
 *
 * Order at attach (the host's wiring, once Excalidraw is initialised): the render overrides and hit
 * guard, undo, presence, the port; the engine's onChange feed, then the input layer, presence's pointer,
 * the custom and pointer tools, undo's actions; the outer input layer; the LobbyCanvas; the test facade
 * (dev-auth builds only); then the socket connects.
 */
import { CLOSE_TERMINAL, type RosterEntry, type ServerMessage } from '@draftroom/canvas-schema/protocol'
import type { TicketResponse } from '@draftroom/contracts'
import * as ExcalidrawElementNs from '@excalidraw/element'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { AppState as ExcalidrawAppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { api as apiClient } from '../../api/client.ts'
import { createTicketUri, ticketInProtocol } from '../../board/ticket.ts'
import { exportAllowedOnBoard } from '../../features/canvas-ux/ported/export-gate.ts'
import { frameAt } from '../../features/canvas-ux/ported/notes.ts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import { engineRejectNotice } from '../../sync-quality/copy.ts'
import { type BoardConcern, type BoardEvent, createLobbyCanvas, type LobbyCanvasHandle } from '../api/impl.ts'
import type {
  CanvasChange,
  CanvasInputEvent,
  LobbyCanvas,
  LobbyCanvasEventMap,
  LobbyTx,
  ScenePoint,
} from '../api/lobby-canvas.ts'
import { createFeatureRegistries, type ExternalContent, type FeatureRegistries } from '../api/registries.ts'
import type { LobbyRole } from '../engine/interaction.ts'
import { attachBoardFiles, installBoardFiles } from '../files/board.ts'
import { UndoController } from '../history/controller.ts'
import { CanvasInput } from '../input/CanvasInput.ts'
import { LeaseClient } from '../lease/client.ts'
import type { EditNotice, EditState } from '../lease/editorLease.ts'
import { installLod } from '../lod/index.ts'
import { installBoardOverrides, overridesLodTarget } from '../overrides.ts'
import { createCanvasPort, type LobbyCanvasPort } from '../port-impl.ts'
import { PresenceHub } from '../presence/hub.ts'
import { attachPresencePointer, type PresenceSample } from '../presence/pointer.ts'
import { attachEngine, createExcalidrawScene } from '../sync/adapter/excalidraw.ts'
import { type GuestQueue, guestOfflineQueue } from '../sync/adapter/offline-guest.ts'
import { createIdbOfflineStore, type IdbOfflineStore, tabId } from '../sync/adapter/offline-idb.ts'
import { LobbyEngineCore } from '../sync/core/engine.ts'
import { bump } from '../sync/headless/scene.ts'
import { createSocketTransport, type SocketTransport } from '../sync/transport/socket.ts'
import type { OfflineQueueStore, SaveStatus, SceneAdapter, SceneElement } from '../sync/types.ts'
import { IDLE_GESTURE } from '../sync/types.ts'
import { install as installFacade } from '../test-facade.ts'
import { attachCustomTools, type CustomToolClick } from '../tools/customTools.ts'
import { setTool } from '../tools/tools.ts'
import { ChangeClassifier } from './changes.ts'
import { contentOf } from './content.ts'
import { selectionText } from './copy-text.ts'
import { createBoardHandles } from './handles.ts'
import { BoardInput } from './input.ts'
import { PeerStore } from './peers.ts'
import { SettingsStore } from './settings.ts'

export type BoardPhase = 'connecting' | 'preparing' | 'ready' | 'offline' | 'closed'

export interface LobbyBoardSnapshot {
  readonly phase: BoardPhase
  /** the 4099 reason when the socket closed for good */
  readonly closeReason: string | null
  /** the first welcome of this page was processed */
  readonly welcomed: boolean
  /** the canvas exists (the engine is initialised) */
  readonly attached: boolean
  /** the role the canvas runs with (the ticket's, read-only when the welcome says so) */
  readonly role: LobbyRole
  readonly readonly: boolean
  readonly guest: boolean
  readonly save: SaveStatus
  readonly notice: (EditNotice & { id: number }) | null
  readonly edit: EditState | null
  /** everyone in the room, this tab included */
  readonly roster: readonly RosterEntry[]
}

export interface NoticeSink {
  notify(n: {
    key: string
    text: string
    tone?: 'info' | 'error'
    testId?: string
    timeoutMs?: number | null
  }): void
  dismiss(key: string): void
}

export interface LobbyBoardSessionOptions {
  readonly boardId: string
  /** the ticket the page fetched first (who this is, and the role before the welcome) */
  readonly first: TicketResponse
  /** the board cannot be edited by anyone (archived) */
  readonly archived: boolean
  readonly notices: NoticeSink
  /** every ticket a socket connects with (the role can change between reconnects) */
  onTicket?(ticket: TicketResponse): void
  /** access is gone (a 403/404 ticket, a FORBIDDEN close) */
  onAccessLost?(): void
  /** the session ended (401, NOT_AUTHENTICATED) */
  onSignedOut?(): void
}

export const lobbyRoleOf = (r: TicketResponse['role'], readonly: boolean): LobbyRole =>
  r === 'commenter' ? 'commenter' : r === 'viewer' || readonly ? 'viewer' : 'editor'

type Listener<E extends BoardEvent> = LobbyCanvasEventMap[E]

/** Takes pasted or dropped content (resolves whether a feature took it). */
export type ContentSink = (
  content: ExternalContent,
  at: ScenePoint | null,
  source: 'paste' | 'drop' | 'insert',
) => Promise<boolean>

export class LobbyBoardSession {
  readonly registries: FeatureRegistries = createFeatureRegistries()
  readonly settings: SettingsStore
  readonly tab: string
  readonly transport: SocketTransport
  readonly core: LobbyEngineCore
  readonly lease: LeaseClient
  readonly input: CanvasInput
  readonly peers: PeerStore
  private readonly tickets: ReturnType<typeof createTicketUri>
  private readonly store: IdbOfflineStore | null
  /** this page's queue for a guest on this board (it outlives this session: ../sync/adapter/offline-guest.ts) */
  private readonly guestQueue: GuestQueue
  /** the device queues of this board were purged in this session (a welcome said guest) */
  private guestPurged = false
  private readonly o: LobbyBoardSessionOptions
  private api: ExcalidrawImperativeAPI | null = null
  private undo: UndoController | null = null
  private presence: PresenceHub | null = null
  private boardInput: BoardInput | null = null
  private handle: LobbyCanvasHandle | null = null
  private handlesExtra: ReturnType<typeof createBoardHandles> | null = null
  port: LobbyCanvasPort | null = null
  private readonly listeners = new Set<() => void>()
  private snap: LobbyBoardSnapshot
  private noticeSeq = 0
  private readonly detach: (() => void)[] = []
  private guest = false
  private ticketRole: TicketResponse['role']
  private themeValue: 'light' | 'dark' = 'light'
  private readonly classifier = new ChangeClassifier()
  private readonly concernListeners = new Map<BoardConcern, Set<() => void>>()
  private readonly eventListeners = new Map<BoardEvent, Set<(...a: never[]) => void>>()
  private lastTool: string | null = null
  private lastEditing: string | null = null
  private rootEl: HTMLElement | null = null
  private contentSink: ContentSink | null = null

  constructor(o: LobbyBoardSessionOptions) {
    this.o = o
    this.tab = tabId()
    this.ticketRole = o.first.role
    let storage: Storage | null = null
    try {
      storage = globalThis.localStorage ?? null
    } catch {
      storage = null
    }
    this.settings = new SettingsStore(storage)
    let firstTicket: TicketResponse | null = o.first
    this.tickets = createTicketUri({
      boardId: o.boardId,
      fetchTicket: async (bid) => {
        // the page fetched one to learn who this is: use it for the first socket while it is fresh
        if (firstTicket && firstTicket.expiresAt > Date.now() + 5_000) {
          const t = firstTicket
          firstTicket = null
          return t
        }
        firstTicket = null
        return apiClient.boardTicket(bid)
      },
      onTicket: (t) => {
        this.ticketRole = t.role
        o.onTicket?.(t)
      },
      onAccessLost: () => o.onAccessLost?.(),
      onSignedOut: () => o.onSignedOut?.(),
      origin: location,
    })
    this.detach.push(() => this.tickets.cancel())
    this.transport = createSocketTransport({
      url: async () => `${await this.tickets.uri()}&${new URLSearchParams({ sessionId: this.tab })}`,
      // L7: the ticket goes in the handshake's Sec-WebSocket-Protocol, never in the socket URL
      WebSocketImpl: ticketInProtocol(WebSocket) as never,
    })
    this.store = createIdbOfflineStore({ boardId: o.boardId, uid: o.first.user.id, tab: this.tab })
    // guests keep no offline copy on the device (§2.5.6 privacy): memory only, once a welcome says so. The
    // memory queue is the PAGE's, not this session's (E2): a new session on the same page (Retry after a
    // terminal close, a remount) finds a guest's unsent changes there, as a member's are found in the
    // tab's IndexedDB record; and a page that already knows this user is a guest here routes to it from
    // the start (the core reads its queue before the first welcome)
    const idb = this.store
    const memory = guestOfflineQueue({ boardId: o.boardId, uid: o.first.user.id })
    this.guestQueue = memory
    this.guest = memory.known
    const offline: OfflineQueueStore = {
      load: () => (this.guest ? memory.load() : idb.load()),
      save: (e) => (this.guest ? memory.save(e) : idb.save(e)),
      clear: () => (this.guest ? memory.clear() : idb.clear()),
    }
    this.core = new LobbyEngineCore({
      transport: this.transport,
      scene: this.sceneAdapter(),
      tab: this.tab,
      offline,
    })
    const me = { sid: `${o.first.user.id}:${this.tab}`, uid: o.first.user.id, name: o.first.user.name }
    this.lease = new LeaseClient(this.core.leaseConnect, me)
    this.peers = new PeerStore(this.core)
    const readonlyRole = o.archived || o.first.role === 'viewer' || o.first.role === 'commenter'
    this.snap = {
      phase: 'connecting',
      closeReason: null,
      welcomed: false,
      attached: false,
      role: lobbyRoleOf(o.first.role, o.archived),
      readonly: readonlyRole,
      // where this tab keeps its unsent changes (the offline banner, the leave warning): a guest's in memory
      guest: this.guest,
      save: this.core.saveStatus,
      notice: null,
      edit: null,
      roster: [],
    }
    this.input = new CanvasInput({
      role: () => (this.snap.readonly ? 'readonly' : 'editor'),
      lease: this.lease,
      setTool: (t) => (this.api ? setTool(this.api, t, { readOnly: this.snap.readonly }) : false),
      actions: { undo: () => this.runUndo('undo'), redo: () => this.runUndo('redo') },
      hiddenIds: () => {
        const out = new Set<string>()
        for (const el of this.api?.getSceneElements() ?? [])
          if (this.registries.hidden.isHidden(el.id)) out.add(el.id)
        return out
      },
      isBlocked: (p) => this.registries.hitGuard.isBlocked(p) !== null,
      // CR-W5-3G-4: a feature that takes a double-click on an element takes a double-tap on it too
      onDoubleTap: (scene, screen) => this.boardInput?.dispatchDoubleTap(scene, screen) ?? false,
      // CR-3D-3: the first registered rule that applies to the selected element starts its edit
      typeToEdit: {
        applies: (id) => this.registries.typeToEdit.list().some((s) => s.applies(id)),
        start: (id, key) =>
          this.registries.typeToEdit
            .list()
            .find((s) => s.applies(id))
            ?.start(id, key) ?? false,
      },
      isConfirmed: (id) => this.core.confirmed(id) !== undefined,
      // CR-3A-4: the export policy decides who copies (editors, viewers and commenters alike; a name-only
      // guest only under 'everyone-including-guests'), and a read-only role copies the selection's text
      canCopy: () => exportAllowedOnBoard(o.boardId, this.ticketRole, this.guest),
      copyReadOnly: (data) => {
        const text = this.canvas ? selectionText(this.canvas) : ''
        if (!text) return false
        data.setData('text/plain', text)
        return true
      },
      onEmptyDoubleClick: (p) => this.createFreeText(p.x, p.y),
      // a drop on the board (editors): the features' content handlers (./content.ts), through the page
      onDrop: (e) => {
        const content = contentOf(e.dataTransfer)
        if (content) void this.contentSink?.(content, this.input.toScene(e.clientX, e.clientY), 'drop')
      },
      onDeny: (leaseId, holder) =>
        o.notices.notify({
          key: `lease:${leaseId}`,
          text: `${holder} is typing in this note`,
          testId: 'lease-toast',
        }),
      onNotice: (n) => this.set({ notice: { ...n, id: ++this.noticeSeq } }),
      onEditState: (s) => this.onEditState(s),
    })
    this.detach.push(
      this.core.onSaveStatus((s) => this.set({ save: s })),
      this.peers.subscribe(() => this.concern('presence')),
      this.core.on((e) => this.onCoreEvent(e)),
    )
  }

  // ---- state for the page ------------------------------------------------------------------------------

  get snapshot(): LobbyBoardSnapshot {
    return this.snap
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** The feature-facing canvas, once the engine is initialised. */
  get canvas(): LobbyCanvas | null {
    return this.handle?.canvas ?? null
  }

  get presenceHub(): PresenceHub | null {
    return this.presence
  }

  /** The board's canvas region (the page sets it; the outer input layer listens there). */
  setRoot(el: HTMLElement | null): void {
    this.rootEl = el
  }

  /** Where drops go (the page dispatches them to the features' content handlers with its context). */
  setContentSink(sink: ContentSink | null): void {
    this.contentSink = sink
  }

  setTheme(theme: 'light' | 'dark'): void {
    if (theme === this.themeValue) return
    this.themeValue = theme
    this.concern('theme')
  }

  dismissNotice(): void {
    this.set({ notice: null })
  }

  private set(patch: Partial<LobbyBoardSnapshot>): void {
    const modeBefore = this.snap.readonly
    this.snap = { ...this.snap, ...patch }
    for (const l of [...this.listeners]) l()
    if (this.snap.readonly !== modeBefore) this.concern('mode')
  }

  // ---- the canvas's concerns and events ---------------------------------------------------------------

  private concern(c: BoardConcern): void {
    for (const l of [...(this.concernListeners.get(c) ?? [])]) l()
  }

  private subscribeConcern(c: BoardConcern, l: () => void): () => void {
    let set = this.concernListeners.get(c)
    if (!set) {
      set = new Set()
      this.concernListeners.set(c, set)
    }
    set.add(l)
    return () => set?.delete(l)
  }

  private emit<E extends BoardEvent>(event: E, ...args: Parameters<Listener<E>>): void {
    for (const l of [...(this.eventListeners.get(event) ?? [])])
      try {
        ;(l as unknown as (...a: Parameters<Listener<E>>) => void)(...args)
      } catch (err) {
        console.error(`canvas ${event} listener failed`, err)
      }
  }

  private onBoardEvent<E extends BoardEvent>(event: E, listener: Listener<E>): () => void {
    let set = this.eventListeners.get(event)
    if (!set) {
      set = new Set()
      this.eventListeners.set(event, set)
    }
    const l = listener as unknown as (...a: never[]) => void
    set.add(l)
    return () => set?.delete(l)
  }

  private emitChange(c: CanvasChange | null): void {
    if (c) this.emit('change', c)
  }

  // ---- the engine core's events --------------------------------------------------------------------------

  private onCoreEvent(e: Parameters<Parameters<LobbyEngineCore['on']>[0]>[0]): void {
    if (e.kind === 'welcome') {
      if (e.welcome.you.guest) {
        this.guest = true
        this.guestQueue.markGuest()
        if (!this.guestPurged) {
          this.guestPurged = true
          void this.store?.purge()
        }
      }
      const readonly = e.welcome.readonly || this.o.archived
      this.set({
        phase: 'ready',
        welcomed: true,
        closeReason: null,
        readonly,
        // once a guest, this session keeps its queue in memory (a welcome that says otherwise changes no store)
        guest: this.guest,
        role: lobbyRoleOf(this.ticketRole, readonly),
        roster: [...this.core.roster().values()],
      })
      this.emit('docChanged', Object.keys(e.welcome.doc))
      this.concern('docKeys')
      this.concern('presence')
    } else if (e.kind === 'transport') {
      if (e.state === 'closed' && e.close?.code === CLOSE_TERMINAL) {
        const reason = e.close.reason
        if (reason === 'FORBIDDEN' || reason === 'NOT_FOUND') {
          void this.store?.purge()
          this.o.onAccessLost?.()
        } else if (reason === 'NOT_AUTHENTICATED') this.o.onSignedOut?.()
        this.set({ phase: 'closed', closeReason: reason })
      } else if (e.state === 'closed' && this.snap.phase !== 'closed') this.set({ phase: 'offline' })
    } else if (e.kind === 'message') {
      // the core reports a message BEFORE it applies it (its roster, lease table and document are still
      // the old ones here): read them once it has
      const m = e.message
      if (m.type === 'roster' || m.type === 'lease' || (m.type === 'changes' && m.doc))
        queueMicrotask(() => this.afterMessage(m))
      else if (m.type === 'notice' && m.code === 'PREPARING' && !this.snap.welcomed)
        this.set({ phase: 'preparing' })
    } else if (e.kind === 'reject') {
      const el = this.core.confirmed(e.id) as { containerId?: string | null } | undefined
      const holder = this.core.leaseHolders().get(el?.containerId ?? e.id)?.name ?? null
      const text = engineRejectNotice(e.code, holder)
      if (text)
        this.o.notices.notify({ key: 'save-rejected', text, tone: 'error', testId: 'save-rejected-toast' })
    } else if (e.kind === 'superseded') {
      // a change lost with the connection whose fate the server copy cannot tell: the server's stands,
      // and the person is told instead of the page returning to Saved as if nothing happened. A board
      // setting (a tag definition, the start view: `doc:<key>`) is told apart from an object
      this.o.notices.notify({
        key: 'save-superseded',
        text: e.id.startsWith('doc:')
          ? 'Someone else changed a board setting you edited while you were reconnecting — their version is kept.'
          : 'Someone else changed an object you edited while you were reconnecting — their version is kept.',
        tone: 'error',
        testId: 'save-superseded-toast',
      })
    } else if (e.kind === 'refit') {
      this.refit(e.id, e.dx, e.dy)
    } else if (e.kind === 'applied') {
      const api = this.api
      if (api) {
        const byId = new Map(api.getSceneElementsIncludingDeleted().map((x) => [x.id, x]))
        this.emitChange(this.classifier.applied(e.ids, (id) => byId.get(id) as never))
      }
      this.boardInput?.invalidateHover()
    }
  }

  private afterMessage(m: ServerMessage): void {
    if (m.type === 'roster') {
      this.set({ roster: [...this.core.roster().values()] })
      this.peers.rosterChanged()
      this.concern('presence')
    } else if (m.type === 'lease') this.concern('presence')
    else if (m.type === 'changes' && m.doc) {
      this.emit('docChanged', Object.keys(m.doc.set))
      this.concern('docKeys')
    }
  }

  private onEditState(s: EditState): void {
    this.set({ edit: s })
    // keys typed into an editor that waits for its lease are unsent text: no Saved meanwhile (§2.5.7,
    // V1 P1; the spike page had this, the board page did not)
    this.core.holdSaved('editor-buffer', s.phase !== 'idle' && s.phase !== 'open' && s.buffered > 0)
    this.handlesExtra?.editStateChanged(s.phase, s.leaseId)
    const editing = s.phase === 'open' ? s.leaseId : null
    if (editing !== this.lastEditing) {
      this.lastEditing = editing
      this.emit('editingChanged', editing)
    }
    this.concern('editing')
  }

  // ---- the scene the core reads and applies (the api arrives after the engine initialises) ----------

  private sceneAdapter(): SceneAdapter {
    // one adapter per engine instance: a re-mounted host brings a new API
    let real: ReturnType<typeof createExcalidrawScene> | null = null
    let realApi: ExcalidrawImperativeAPI | null = null
    const scene = (api: ExcalidrawImperativeAPI) => {
      if (!real || realApi !== api) {
        real = createExcalidrawScene(api)
        realApi = api
      }
      return real
    }
    return {
      read: () => (this.api ? scene(this.api).read() : { elements: [], gesture: IDLE_GESTURE }),
      apply: (elements) => {
        if (this.api) scene(this.api).apply(elements)
      },
    }
  }

  // ---- attach (the host's wiring) -----------------------------------------------------------------------

  readonly attach = (wrapper: HTMLElement, api: ExcalidrawImperativeAPI): (() => void) => {
    this.api = api
    const offs: (() => void)[] = []
    const root = this.rootEl ?? (wrapper.parentElement as HTMLElement)
    const board = installBoardOverrides({
      api,
      wrapper,
      registries: this.registries,
      boardId: this.o.boardId,
    })
    const undo = new UndoController({
      core: this.core,
      scene: this.sceneAdapter(),
      bump: (el, patch) => bump(el, patch),
      install: (elements) => {
        // what undo installs is `history` in the change stream (marked before the scene reports it)
        const current = new Map(api.getSceneElementsIncludingDeleted().map((e) => [e.id, e.version]))
        this.classifier.markHistory(elements.filter((e) => current.get(e.id) !== e.version).map((e) => e.id))
        api.updateScene({ elements: elements as never, captureUpdate: CaptureUpdateAction.NEVER })
      },
      // F11: an undo or a redo re-selects what its step was made with (the port leaves out hidden ids)
      select: (ids, groups) => {
        this.port?.select(ids)
        // a group comes back as a group, not as its members (the port's `select` clears `selectedGroupIds`)
        if (groups.length > 0)
          api.updateScene({
            appState: { selectedGroupIds: Object.fromEntries(groups.map((g) => [g, true])) } as never,
          })
      },
    })
    this.undo = undo
    const presence = new PresenceHub({
      core: this.core,
      overrides: board.overrides,
      elements: () => api.getSceneElementsIncludingDeleted() as unknown as readonly SceneElement[],
      elementMap: () =>
        api.getSceneElementsMapIncludingDeleted() as unknown as ReadonlyMap<string, SceneElement>,
      view: () => {
        const s = api.getAppState()
        const z = s.zoom.value
        return {
          x: Math.round(-s.scrollX),
          y: Math.round(-s.scrollY),
          w: Math.round(s.width / z),
          h: Math.round(s.height / z),
          // CR-3CF-1 (CONTRACTS_REV 10): the hub sends it as `view.z` only to a rev-10 room
          z,
        }
      },
      readOnly: () => this.snap.readonly,
    })
    this.presence = presence
    this.registries.dragger.provide((id) => presence.draggerOf(id))
    const port = createCanvasPort({
      api,
      core: this.core,
      registries: this.registries,
      undo,
      readOnly: () => this.snap.readonly,
      editingLease: () => {
        const el = this.input.editorLease
        return el && el.phase === 'open' ? el.leaseId : null
      },
    })
    this.port = port
    // the image loader (one per page; 3g's file cards and exports find it through the registries)
    const files = installBoardFiles({
      api,
      boardId: this.o.boardId,
      loader: { onState: () => this.concern('files') },
    })
    offs.push(attachBoardFiles(this.registries, files), () => files.dispose())
    this.classifier.seed(api.getSceneElementsIncludingDeleted() as never)

    // the last pointer sample of this tab (3. below); presence re-sends it with a fresh `view`
    let lastSample: PresenceSample | null = null
    // Re-sends presence with the current `view` and the last pointer, so the people who follow this tab
    // (Follow, Gather) read where it looks now without a pointer move (the core keeps 20 Hz). A camera
    // move (pan, zoom, a follow) and a change of the canvas's size both change the view.
    const resendView = () =>
      presence.onPointer(lastSample ?? { pointer: null, button: 'up', source: 'view', pointerType: 'mouse' })

    // the canvas's size and place as the engine last measured them (CR-3A-10: a window resize changes
    // `viewport.screenRect()` and the scene rectangle without a scroll, so readers were never told)
    let lastBox = ''
    // 1. the engine's feed, then undo's step boundary, the port's events, presence
    offs.push(
      attachEngine(api, this.core, (g, changed) => {
        const idle =
          !g.dragging &&
          !g.resizing &&
          !g.rotating &&
          !g.cropping &&
          !g.editingLinear &&
          !g.newElementId &&
          !g.multiElementId
        // a camera move changes no element and no gesture: no step to record, no element scan (CR 3b-8)
        if ((changed.elements || changed.gesture) && idle && !g.editingTextElementId) undo.boundary()
        port.afterSceneChange(changed.elements)
        const s = api.getAppState()
        const box = `${s.width}x${s.height}@${s.offsetLeft},${s.offsetTop}`
        if (box !== lastBox) {
          const first = lastBox === ''
          lastBox = box
          if (!first) {
            port.notifyViewport()
            // W5-25 (CR-3C-W5-1): the scene rectangle this tab shows changed with no camera move (a dock
            // panel opened or closed, a window resize), so the `view` the followers fit is stale until
            // re-sent. Here the engine's state already has the new size (the box above is read from it);
            // the ResizeObserver below only reports the container.
            resendView()
          }
        }
        presence.onGesture(g)
        const el = this.input.editorLease
        presence.setEditing(el && el.phase !== 'idle' ? el.leaseId : null)
        const tool = port.tool()
        if (tool !== this.lastTool) {
          this.lastTool = tool
          this.applyToolCursor(tool)
          this.emit('toolChanged', tool)
          this.concern('tool')
        }
        this.concern('pointer')
      }),
    )
    // the change stream (after the scan) and undo's availability
    offs.push(
      port.on('changed', (ids) => {
        const byId = new Map(api.getSceneElementsIncludingDeleted().map((x) => [x.id, x]))
        for (const c of this.classifier.scanned(ids, (id) => byId.get(id) as never)) this.emit('change', c)
        this.concern('history')
        this.boardInput?.invalidateHover()
      }),
    )
    // 2. spike B's input layer (allowlist, guard, double-click and double-tap, clipboard and drop)
    offs.push(this.input.attach(wrapper, api))
    // 3. presence pointer for every role
    offs.push(
      attachPresencePointer(wrapper, {
        toScene: (x, y) => this.input.toScene(x, y),
        onSample: (s) => {
          lastSample = s
          presence.onPointer(s)
          port.emitPointer(s.pointer)
        },
      }),
    )
    // 4. Lobby's custom tools (N, T) and the pointer tools features register
    offs.push(attachCustomTools(api, { onClick: (c) => this.onToolClick(c) }))
    offs.push(this.attachPointerTools(api))
    // 5. undo and redo replace Excalidraw's (§2.8)
    for (const name of ['undo', 'redo'] as const)
      api.registerAction({
        name,
        label: name === 'undo' ? 'Undo' : 'Redo',
        trackEvent: false,
        perform: () => {
          this.runUndo(name)
          return false
        },
        keyTest: () => false,
      })
    // 6. the outer input layer (feature keys, the input stream, pointer state)
    const boardInput = new BoardInput({
      root,
      canvasEl: () => root.querySelector<HTMLElement>('.excalidraw'),
      keys: () => this.registries.keys.list(),
      canvas: () => this.canvas,
      editor: () => {
        const el = this.input.editorLease
        return !el || el.phase === 'idle' ? 'none' : el.phase === 'open' ? 'granted' : 'pending'
      },
      isGrantedEditor: (ta) => this.input.editorLease?.isWritable(ta) ?? false,
      toScene: (x, y) => this.input.toScene(x, y),
      hit: (p) => this.canvas?.hitTest(p) ?? null,
      listeners: () => [...(this.eventListeners.get('input') ?? [])] as ((e: CanvasInputEvent) => void)[],
      onPointerChange: () => this.concern('pointer'),
      onHoverChange: () => this.concern('hover'),
    })
    this.boardInput = boardInput
    offs.push(() => boardInput.dispose())
    // a pointer tool's double-click (the open-card tool) takes the event before the engine's own
    offs.push(
      this.onBoardEvent('input', (e) => {
        if (e.type !== 'double-click' || !this.port) return
        const tool = this.port.tool()
        const spec = tool ? this.registries.pointerTools.get(tool) : undefined
        if (!spec?.onDoubleClick) return
        spec.onDoubleClick(e.scene, e.hit, this.port)
        e.handled()
      }),
    )
    offs.push(
      api.onScrollChange(() => {
        this.handlesExtra?.userMoved()
        // 3c (CR): a pan or zoom alone (a wheel, a key, a follow) re-sends presence, so the `view`
        // the people who follow this tab read is current without a pointer move (the core keeps 20 Hz)
        resendView()
      }),
    )
    // resize: the canvas container changed size
    const container = root.querySelector<HTMLElement>('.excalidraw') ?? wrapper
    const ro = new ResizeObserver(() => {
      const s = api.getAppState()
      this.emit('resize', { x: s.offsetLeft, y: s.offsetTop, width: s.width, height: s.height })
    })
    ro.observe(container)
    offs.push(() => ro.disconnect())
    // 7. the feature-facing canvas on the board handles
    // 3b's level-of-detail pass culls through RenderOverrides' render-only source (CR 3b-5; no Proxy of
    // the engine API any more, W3-14)
    const lodTarget = overridesLodTarget(board.overrides, api)
    const handles = createBoardHandles({
      api,
      port,
      registries: this.registries,
      input: this.input,
      board: boardInput,
      lease: this.lease,
      undo,
      overrides: board.overrides,
      peers: this.peers,
      settings: this.settings,
      root,
      readOnly: () => this.snap.readonly,
      theme: () => this.themeValue,
      runUndo: (dir) => this.runUndo(dir),
      fileState: (fileId) => files.loader.state(fileId),
      editingLease: () => port.editingId(),
      subscribe: (c, l) => this.subscribeConcern(c, l),
      on: (event, l) => this.onBoardEvent(event, l),
      docWritten: (keys) => {
        this.emit('docChanged', keys)
        this.concern('docKeys')
      },
      pushed: (ids, ms) => this.pushed(ids, ms),
      changed: (c) => this.concern(c),
    })
    this.handlesExtra = handles
    offs.push(() => handles.dispose())
    offs.push(this.settings.subscribe(() => this.concern('settings')))
    offs.push(this.settings.subscribe(() => this.applyFocusFrames(api)))
    this.handle = createLobbyCanvas({ port, registries: this.registries, board: handles })
    // 3b: the level-of-detail pass for zoomed-out views (docs/EXCALIDRAW-MIGRATION.md §8.5)
    const lod = installLod({
      api,
      target: lodTarget,
      canvas: this.handle.canvas,
      isHidden: (id) => this.registries.hidden.isHidden(id),
      root,
    })
    offs.push(() => lod.dispose())
    // the test facade and the debug handle (dev-auth builds only: the facade checks the guard itself)
    // CR-3A-9: the facade's `tool` / `setTool` go through the LobbyCanvas (3a's tools part: the
    // highlighter and the read-only Hand), not the raw port, which reports `freedraw` and `select` for them
    const lobbyCanvas = this.handle.canvas
    const facadePort = Object.create(port, {
      tool: { value: () => lobbyCanvas.tool() },
      setTool: { value: (t: string) => lobbyCanvas.setTool(t) },
    }) as LobbyCanvasPort
    const uninstallFacade = installFacade(facadePort, this.registries)
    if (uninstallFacade) offs.push(uninstallFacade)
    if (DEV_AUTH_ENABLED) {
      ;(window as unknown as { __lobbyBoard?: unknown }).__lobbyBoard = {
        session: this,
        core: this.core,
        port,
        canvas: this.handle.canvas,
        registries: this.registries,
        api,
        lease: this.lease,
        input: this.input,
        undo,
        overrides: board.overrides,
      }
    }
    this.set({ attached: true })
    // the offline queue is written when the page goes away or is hidden (a reload, a closed tab, a phone
    // switching apps), with any write Excalidraw has not reported yet (spike B part 3; WAVE-3 §6 asked the
    // board page for it): its pushes in flight then reach the next page as lost pushes, not as unsent edits
    const persist = () => this.core.persistNow()
    const onHidden = () => {
      if (document.visibilityState === 'hidden') persist()
    }
    window.addEventListener('pagehide', persist)
    document.addEventListener('visibilitychange', onHidden)
    offs.push(() => {
      window.removeEventListener('pagehide', persist)
      document.removeEventListener('visibilitychange', onHidden)
    })
    // 8. connect
    this.core.start()
    this.transport.connect()
    return () => {
      this.core.persistNow()
      for (const f of offs.reverse()) f()
      this.handle?.dispose()
      this.handle = null
      this.handlesExtra = null
      this.boardInput = null
      this.presence?.dispose()
      this.undo?.dispose()
      board.dispose()
      this.port?.dispose()
      this.api = null
      if (DEV_AUTH_ENABLED) delete (window as unknown as { __lobbyBoard?: unknown }).__lobbyBoard
      this.set({ attached: false })
    }
  }

  /**
   * W5-24: in focus mode (present mode) a slide is its frame's exact rectangle, with nothing of the engine's
   * frame chrome on it. The engine draws every frame's outline (2 screen px centred on the edge, corners
   * rounded 8 px) and name; with `outline` and `name` off it draws neither, and the presentation's
   * surround window can be the frame's rectangle itself instead of covering a rounded 2 px edge of every
   * slide. `clip` stays on (the slide's content stays inside it). The board's own setting comes back when
   * focus mode ends.
   */
  private focusFrameRendering: ExcalidrawAppState['frameRendering'] | null = null

  private applyFocusFrames(api: ExcalidrawImperativeAPI): void {
    const focus = this.settings.get().focusMode
    if (focus === (this.focusFrameRendering !== null)) return
    if (focus) {
      this.focusFrameRendering = api.getAppState().frameRendering
      api.updateScene({
        appState: { frameRendering: { enabled: true, clip: true, name: false, outline: false } },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    } else {
      const before = this.focusFrameRendering
      this.focusFrameRendering = null
      if (before)
        api.updateScene({ appState: { frameRendering: before }, captureUpdate: CaptureUpdateAction.NEVER })
    }
  }

  private applyToolCursor(tool: string | null): void {
    const spec = tool ? this.registries.pointerTools.get(tool) : undefined
    if (spec?.cursor) this.api?.setCursor(spec.cursor)
  }

  private attachPointerTools(api: ExcalidrawImperativeAPI): () => void {
    const specFor = (customType: string | null) =>
      customType ? this.registries.pointerTools.list().find((p) => p.customType === customType) : undefined
    const hit = (x: number, y: number) => {
      const el = this.input.elementAt(x, y)
      return el ? (this.port?.get(el.id) ?? null) : null
    }
    const offDown = api.onPointerDown((tool, state) => {
      const spec = tool.type === 'custom' ? specFor(tool.customType) : undefined
      if (spec?.onPointerDown && this.port)
        spec.onPointerDown(state.origin, hit(state.origin.x, state.origin.y), this.port)
    })
    const offUp = api.onPointerUp((tool, state) => {
      const spec = tool.type === 'custom' ? specFor(tool.customType) : undefined
      if (spec?.onPointerUp && this.port) {
        const p = state.lastCoords
        spec.onPointerUp(p, hit(p.x, p.y), this.port)
      }
    })
    return () => {
      offDown()
      offUp()
    }
  }

  // ---- Lobby's N and T tools (§2.3.4): the New element rule (§2.9.2) -----------------------------------

  private onToolClick(c: CustomToolClick): void {
    if (this.snap.readonly || !this.port || !this.api) return
    if (c.tool === 'note') {
      const size = 200
      // W5-01: a note made inside a frame is its child (tldraw's), in the same step as its create
      const id = this.createInFrame('note', { x: c.x, y: c.y }, (tx) =>
        tx.create('note', { x: c.x - size / 2, y: c.y - size / 2, size }),
      )
      this.lease.markCreated(id)
      setTool(this.api, 'select', {})
      this.input.editorLease?.requestEdit(id, { reason: 'new-note', caretEnd: true })
    } else if (c.tool === 'text') {
      const target = this.input.textTargetAt(c.x, c.y)
      if (target) this.input.editorLease?.requestEdit(target.id, { reason: 'T-tool', caretEnd: true })
      else this.createFreeText(c.x, c.y)
    }
  }

  private createFreeText(x: number, y: number): void {
    if (this.snap.readonly || !this.port) return
    const id = this.createInFrame('text', { x, y }, (tx) => tx.create('text', { x, y, text: '' }))
    this.lease.markCreated(id)
    this.input.editorLease?.requestEdit(id, { reason: 'new-text', caretEnd: true })
  }

  /**
   * Creates an element at `at` with `make` and, in the same step, puts it (and its label) into the
   * innermost unlocked frame under `at` (W5-01: notes and text made inside a frame are its children, as
   * on the tldraw board; frame-scoped votes, frame moves and comments depend on it). One undo step.
   */
  private createInFrame(
    label: string,
    at: ScenePoint,
    make: (tx: Pick<LobbyTx, 'create'>) => string,
  ): string {
    const canvas = this.canvas
    if (!canvas) return (this.port as LobbyCanvasPort).transact(label, (tx) => make(tx))
    const frame = frameAt(canvas, at, { unlockedOnly: true })
    return canvas.transact(label, (tx) => {
      const id = make(tx)
      if (frame) tx.setFrame([id], frame.id)
      return id
    })
  }

  // ---- undo ------------------------------------------------------------------------------------------------

  runUndo(dir: 'undo' | 'redo'): void {
    const out = dir === 'undo' ? this.undo?.undo() : this.undo?.redo()
    this.concern('history')
    if (!out || out.kept === 0) return
    const who = out.keptBy ? ` — ${out.keptBy} edited it since` : ' — someone edited it since'
    this.o.notices.notify({
      key: 'undo-kept',
      text: `${out.kept} change${out.kept === 1 ? '' : 's'} kept${who}`,
      testId: 'undo-notice',
    })
  }

  /** Waits until the core has pushed its changes to `ids` (the scan runs on Excalidraw's next change). */
  private async pushed(ids: readonly string[], timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs
    const want = new Set(ids)
    // two frames: Excalidraw reports the scene change, the core scans it
    for (;;) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      const unsent = this.core.unsentIds().filter((id) => want.has(id))
      if (!unsent.length || Date.now() > until) return
      this.core.flush()
    }
  }

  /**
   * The holder re-fits after a dropped fit (§2.9.4 rule 4; spike B's board session): a container re-runs
   * its layout in the open editor; a leased free text re-applies the dropped fit's shift on the server's
   * position, with Excalidraw's follow of the arrows bound to it.
   */
  private refit(id: string, dx?: number, dy?: number): void {
    if (dx !== undefined || dy !== undefined) {
      if (dx || dy) setTimeout(() => this.shiftFreeText(id, dx ?? 0, dy ?? 0), 0)
      return
    }
    const ta = this.input.editorLease?.textarea()
    if (ta && this.input.editorLease?.isWritable(ta)) ta.dispatchEvent(new Event('input', { bubbles: true }))
  }

  private shiftFreeText(id: string, dx: number, dy: number): void {
    const api = this.api
    if (!api) return
    const els = api.getSceneElements() as unknown as SceneElement[]
    // biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element helpers work on plain copies here
    const map = new Map<string, any>(els.map((e) => [e.id, structuredClone(e)]))
    const t = map.get(id)
    if (!t || t.isDeleted) return
    const scene = {
      // biome-ignore lint/suspicious/noExplicitAny: see above
      mutateElement: (el: any, u: any, o?: any) => ElementLib.mutateElement(el, map, u, o),
      getNonDeletedElementsMap: () => map,
      getElementsMapIncludingDeleted: () => map,
      getNonDeletedElements: () => [...map.values()],
      triggerUpdate: () => {},
    }
    ElementLib.mutateElement(t, map, { x: t.x + dx, y: t.y + dy })
    ElementLib.updateBoundElements(t, scene as never)
    const next = els.map((e) => {
      const c = map.get(e.id)
      return c && c.version !== e.version ? c : e
    })
    api.updateScene({ elements: next as never, captureUpdate: CaptureUpdateAction.NEVER })
  }

  dispose(): void {
    this.core.persistNow()
    for (const f of this.detach.splice(0)) f()
    this.peers.dispose()
    this.core.stop()
    this.transport.close(1000, 'page closed')
    this.store?.release()
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element helpers, typed loosely on purpose
const ElementLib = ExcalidrawElementNs as any
