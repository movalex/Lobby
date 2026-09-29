/**
 * One board session of the spike board page (docs/EXCALIDRAW-MIGRATION.md §8.1 "Web", §8.6.3): the socket
 * with real tickets, the engine core, the lease client on the real protocol, the input layer (allowlist,
 * guard, double-tap), undo, presence with the drag relay, the render overrides, the CanvasPort, and the
 * one `installAll` call. React-free; the page (./SpikeBoardPage.tsx) renders its state.
 *
 * Order at attach (the host's wiring, once Excalidraw is initialised): the engine's onChange feed first
 * (so the core scans before the editor-open rule runs), then the input layer, presence, custom tools,
 * undo's actions; then the installers; then the socket connects.
 */
import type { TicketResponse } from '@draftroom/contracts'
import * as ExcalidrawElementNs from '@excalidraw/element'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { api as apiClient } from '../../../api/client.ts'
import { createTicketUri } from '../../../board/ticket.ts'
import type { LobbyRole } from '../../engine/interaction.ts'
import { UndoController } from '../../history/controller.ts'
import { CanvasInput } from '../../input/CanvasInput.ts'
import { LeaseClient } from '../../lease/client.ts'
import type { EditNotice, EditState } from '../../lease/editorLease.ts'
import { installBoardOverrides, type RenderOverrides } from '../../overrides.ts'
import { createCanvasPort, type LobbyCanvasPort } from '../../port-impl.ts'
import { PresenceHub } from '../../presence/hub.ts'
import { attachPresencePointer } from '../../presence/pointer.ts'
import { type CanvasRegistries, createRegistries } from '../../registries.ts'
import { attachEngine, createExcalidrawScene } from '../../sync/adapter/excalidraw.ts'
import { createIdbOfflineStore, type IdbOfflineStore, tabId } from '../../sync/adapter/offline-idb.ts'
import { LobbyEngineCore } from '../../sync/core/engine.ts'
import { createMemoryOfflineStore } from '../../sync/core/offline-memory.ts'
import { bump } from '../../sync/headless/scene.ts'
import { createSocketTransport, type SocketTransport } from '../../sync/transport/socket.ts'
import type { OfflineQueueStore, SaveStatus, SceneAdapter, SceneElement } from '../../sync/types.ts'
import { IDLE_GESTURE } from '../../sync/types.ts'
import { attachCustomTools, type CustomToolClick } from '../../tools/customTools.ts'
import { setTool } from '../../tools/tools.ts'
import { installAll } from '../installers.ts'
import { createGuardMonitor } from './monitor.ts'
import { createSpecHelpers } from './specHelpers.ts'

export type BoardPhase = 'connecting' | 'ready' | 'offline' | 'no-access' | 'signed-out' | 'closed'

export interface BoardSnapshot {
  readonly phase: BoardPhase
  readonly role: LobbyRole
  readonly save: SaveStatus
  readonly toasts: readonly { id: number; text: string }[]
  readonly notice: (EditNotice & { id: number }) | null
  readonly edit: EditState | null
  readonly closeReason: string | null
  readonly people: number
}

export const roleOf = (r: TicketResponse['role'], readonly: boolean): LobbyRole =>
  readonly
    ? r === 'commenter'
      ? 'commenter'
      : 'viewer'
    : r === 'commenter'
      ? 'commenter'
      : r === 'viewer'
        ? 'viewer'
        : 'editor'

export interface BoardSessionOptions {
  readonly boardId: string
  readonly first: TicketResponse
}

export class BoardSession {
  readonly registries: CanvasRegistries = createRegistries()
  readonly tab: string
  readonly transport: SocketTransport
  readonly core: LobbyEngineCore
  readonly lease: LeaseClient
  readonly input: CanvasInput
  private readonly store: IdbOfflineStore | null
  private api: ExcalidrawImperativeAPI | null = null
  private undo: UndoController | null = null
  private presence: PresenceHub | null = null
  private overrides: RenderOverrides | null = null
  port: LobbyCanvasPort | null = null
  private readonly listeners = new Set<() => void>()
  private snap: BoardSnapshot
  private toastSeq = 0
  private readonly detach: (() => void)[] = []
  private guest = false
  private ticketRole: TicketResponse['role']

  constructor(o: BoardSessionOptions) {
    this.tab = tabId()

    this.ticketRole = o.first.role
    let firstTicket: TicketResponse | null = o.first
    const tickets = createTicketUri({
      boardId: o.boardId,
      fetchTicket: async (bid) => {
        // the page already fetched one to learn the role; use it for the first socket
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
      },
      onAccessLost: () => this.set({ phase: 'no-access' }),
      onSignedOut: () => this.set({ phase: 'signed-out' }),
      origin: location,
    })
    this.detach.push(() => tickets.cancel())
    this.transport = createSocketTransport({
      url: async () => `${await tickets.uri()}&${new URLSearchParams({ sessionId: this.tab })}`,
      WebSocketImpl: WebSocket as never,
      log: (event, detail) => this.log(event, detail),
    })
    this.store = createIdbOfflineStore({ boardId: o.boardId, uid: o.first.user.id, tab: this.tab })
    // guests keep no offline copy on the device (§2.5.6 privacy): memory only, once the welcome says so
    const idb = this.store
    const memory = createMemoryOfflineStore()
    const offline: OfflineQueueStore = {
      load: () => (this.guest ? memory.load() : idb.load()),
      save: (e) => (this.guest ? memory.save(e) : idb.save(e)),
      clear: () => (this.guest ? memory.clear() : idb.clear()),
    }
    const scene = this.sceneAdapter()
    this.core = new LobbyEngineCore({
      transport: this.transport,
      scene,
      tab: this.tab,
      offline,
      log: (event, detail) => this.log(event, detail),
    })
    const me = { sid: `${o.first.user.id}:${this.tab}`, uid: o.first.user.id, name: o.first.user.name }
    this.lease = new LeaseClient(this.core.leaseConnect, me)
    this.snap = {
      phase: 'connecting',
      role: roleOf(o.first.role, false),
      save: this.core.saveStatus,
      toasts: [],
      notice: null,
      edit: null,
      closeReason: null,
      people: 0,
    }
    this.input = new CanvasInput({
      role: () => (this.snap.role === 'editor' ? 'editor' : 'readonly'),
      lease: this.lease,
      setTool: (t) => (this.api ? setTool(this.api, t, { readOnly: this.snap.role !== 'editor' }) : false),
      actions: {
        undo: () => this.runUndo('undo'),
        redo: () => this.runUndo('redo'),
      },
      hiddenIds: () => {
        const out = new Set<string>()
        for (const el of this.api?.getSceneElements() ?? [])
          if (this.registries.hidden.isHidden(el.id)) out.add(el.id)
        return out
      },
      isBlocked: (p) => this.registries.hitGuard.isBlocked(p) !== null,
      isConfirmed: (id) => this.core.confirmed(id) !== undefined,
      onEmptyDoubleClick: (p) => this.createFreeText(p.x, p.y),
      onDeny: (_id, holder) => this.toast(`${holder} is typing in this note`),
      onNotice: (n) => {
        this.logEvent({ kind: 'notice', id: n.leaseId, detail: n.kind })
        this.set({ notice: { ...n, id: ++this.toastSeq } })
      },
      onEditState: (s) => this.set({ edit: s }),
    })
    this.detach.push(
      this.core.onSaveStatus((s) => this.set({ save: s })),
      this.core.on((e) => {
        if (e.kind === 'welcome') {
          this.logEvent({ kind: 'welcome', id: e.welcome.sid, detail: String(e.welcome.clock) })
          if (e.welcome.you.guest && !this.guest) {
            this.guest = true
            void idb.purge()
          }
          const role = roleOf(this.ticketRole, e.welcome.readonly)
          this.set({ phase: 'ready', role, people: this.core.roster().size })
        } else if (e.kind === 'transport') {
          if (e.state === 'closed' && e.close?.code === 4099) {
            const reason = e.close.reason
            this.set({
              phase:
                reason === 'FORBIDDEN'
                  ? 'no-access'
                  : reason === 'NOT_AUTHENTICATED'
                    ? 'signed-out'
                    : 'closed',
              closeReason: reason,
            })
            if (reason === 'FORBIDDEN') void this.store?.purge()
          } else if (e.state === 'closed' && this.snap.phase === 'ready') this.set({ phase: 'offline' })
        } else if (e.kind === 'message' && e.message.type === 'roster')
          this.set({ people: this.core.roster().size })
        else if (e.kind === 'message' && e.message.type === 'ack')
          this.logEvent({ kind: 'ack', id: String(e.message.seq), detail: String(e.message.clock) })
        else if (e.kind === 'reject') {
          this.logEvent({ kind: 'reject', id: e.id, detail: e.code })
          this.toast(rejectText(e.code, e.id, this.core))
        } else if (e.kind === 'refit') {
          this.logEvent({ kind: 'refit', id: e.id, detail: null })
          this.refit(e.id, e.dx, e.dy)
        }
      }),
    )
  }

  // ---- state for the page ---------------------------------------------------------------------------------

  get snapshot(): BoardSnapshot {
    return this.snap
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private set(patch: Partial<BoardSnapshot>): void {
    this.snap = { ...this.snap, ...patch }
    for (const l of [...this.listeners]) l()
  }

  /**
   * Acks (push seq → commit clock: which write committed first), rejects, refits (an ack's fitDropped) and
   * editor notices, in order, for the specs (ids, codes and clocks, never text)
   */
  readonly eventLog: {
    kind: 'ack' | 'welcome' | 'reject' | 'refit' | 'notice' | 'undo'
    id: string | null
    detail: string | null
    /** a running number (the log keeps the last 5000 entries; read "since n", never by position) */
    n: number
    at: number
  }[] = []
  private eventSeq = 0

  private logEvent(e: {
    kind: 'ack' | 'welcome' | 'reject' | 'refit' | 'notice' | 'undo'
    id: string | null
    detail: string | null
  }): void {
    this.eventLog.push({ ...e, n: ++this.eventSeq, at: Date.now() })
    if (this.eventLog.length > 5000) this.eventLog.splice(0, this.eventLog.length - 5000)
  }

  /** every toast shown, in order (the specs read it: the screen keeps only the last few, for 5 s) */
  readonly toastLog: { id: number; text: string; at: number }[] = []

  toast(text: string): void {
    const id = ++this.toastSeq
    this.toastLog.push({ id, text, at: Date.now() })
    if (this.toastLog.length > 1000) this.toastLog.splice(0, this.toastLog.length - 1000)
    this.set({ toasts: [...this.snap.toasts.slice(-3), { id, text }] })
    setTimeout(() => this.set({ toasts: this.snap.toasts.filter((t) => t.id !== id) }), 5_000)
  }

  dismissNotice(): void {
    this.set({ notice: null })
  }

  get presenceHub(): PresenceHub | null {
    return this.presence
  }

  get sid(): string | null {
    return this.core.sid
  }

  /**
   * The engine core's and the transport's log (ids, counts, clocks and codes only; never element text),
   * the last 2000 entries, numbered: the specs' trace of what the core did (a resync, an unknown ack, an
   * offline adoption, a superseded fit). Read it "since n", never by position.
   */
  readonly coreLog: { n: number; event: string; detail: Readonly<Record<string, unknown>>; at: number }[] = []
  private coreSeq = 0

  private log(event: string, detail: Readonly<Record<string, unknown>>): void {
    // ids and counts only; never element text
    const entry = { n: ++this.coreSeq, event, detail, at: Date.now() }
    this.coreLog.push(entry)
    if (this.coreLog.length > 2000) this.coreLog.splice(0, this.coreLog.length - 2000)
    ;(window as unknown as { __lobbyBoardLog?: unknown[] }).__lobbyBoardLog?.push(entry)
    if (event === 'echo_suspect') console.warn('lobby: echo_suspect', detail)
  }

  // ---- the scene the core reads and applies (the api arrives after the engine initialises) ----------

  private sceneAdapter(): SceneAdapter {
    let real: ReturnType<typeof createExcalidrawScene> | null = null
    return {
      read: () => {
        if (!this.api) return { elements: [], gesture: IDLE_GESTURE }
        real ??= createExcalidrawScene(this.api)
        return real.read()
      },
      apply: (elements) => {
        if (!this.api) return
        real ??= createExcalidrawScene(this.api)
        real.apply(elements)
      },
    }
  }

  // ---- attach (the host's wiring) -----------------------------------------------------------------------

  readonly attach = (wrapper: HTMLElement, api: ExcalidrawImperativeAPI): (() => void) => {
    this.api = api
    const offs: (() => void)[] = []
    // the one RenderOverrides, the hit guard (isBlocked, isHidden) and the engine seam for O5's features
    // (image loader, file cards, exports, collapse) come from O5's installBoardOverrides (lead, M1/M2: the
    // page created its own RenderOverrides, so nothing of O5's that needs the engine was ever installed)
    const board = installBoardOverrides({ api, wrapper, registries: this.registries })
    this.overrides = board.overrides
    this.undo = new UndoController({
      core: this.core,
      scene: this.sceneAdapter(),
      bump: (el, patch) => bump(el, patch),
      install: (elements) =>
        api.updateScene({ elements: elements as never, captureUpdate: CaptureUpdateAction.NEVER }),
    })
    this.presence = new PresenceHub({
      core: this.core,
      overrides: this.overrides,
      elements: () => api.getSceneElementsIncludingDeleted() as unknown as readonly SceneElement[],
      view: () => {
        const s = api.getAppState()
        const z = s.zoom.value
        return {
          x: Math.round(-s.scrollX),
          y: Math.round(-s.scrollY),
          w: Math.round(s.width / z),
          h: Math.round(s.height / z),
        }
      },
      readOnly: () => this.snap.role !== 'editor',
    })
    const presence = this.presence
    this.registries.dragger.provide((id) => presence.draggerOf(id))
    this.port = createCanvasPort({
      api,
      core: this.core,
      registries: this.registries,
      undo: this.undo,
      readOnly: () => this.snap.role !== 'editor',
      editingLease: () => {
        const el = this.input.editorLease
        return el && el.phase === 'open' ? el.leaseId : null
      },
    })
    const port = this.port
    // 1. the engine's feed, then undo's step boundary, the port's events, presence
    offs.push(
      attachEngine(api, this.core, (g) => {
        const idle =
          !g.dragging &&
          !g.resizing &&
          !g.rotating &&
          !g.cropping &&
          !g.editingLinear &&
          !g.newElementId &&
          !g.multiElementId
        if (idle && !g.editingTextElementId) this.undo?.boundary()
        port.afterSceneChange()
        presence.onGesture(g)
        const el = this.input.editorLease
        presence.setEditing(el && el.phase !== 'idle' ? el.leaseId : null)
      }),
    )
    // 2. the input layer (allowlist, guard, double-click and double-tap, clipboard and drop)
    offs.push(this.input.attach(wrapper, api))
    // 3. presence pointer for every role
    offs.push(
      attachPresencePointer(wrapper, {
        toScene: (x, y) => this.input.toScene(x, y),
        onSample: (s) => {
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
    // 6. the features and the facade (O5, O3), once
    offs.push(installAll(port, this.registries))
    // the page renders the overlay and the slots once the port exists
    this.set({})
    // the §8.4 client timings (lobby.* performance measures, read and cleared by O3's facade)
    ;(globalThis as { LOBBY_MEASURE?: boolean }).LOBBY_MEASURE = true
    // the editor-guard monitor the B3 specs start and read (./monitor.ts; off until started)
    const monitor = createGuardMonitor({
      api,
      lease: this.lease,
      input: this.input,
      core: this.core,
      root: wrapper,
    })
    offs.push(() => monitor.dispose())
    // spike-only debug handle (this page exists only behind the dev-auth guard): the specs' way in
    // until O3's facade (`window.lobbyCanvas`) is installed, and the probes' after it
    ;(window as unknown as { __lobbyBoard?: unknown }).__lobbyBoard = {
      session: this,
      core: this.core,
      port,
      api,
      lease: this.lease,
      input: this.input,
      undo: this.undo,
      helpers: createSpecHelpers(port),
      monitor,
    }
    // 7. connect
    this.core.start()
    this.transport.connect()
    return () => {
      for (const f of offs.reverse()) f()
      this.presence?.dispose()
      this.undo?.dispose()
      board.dispose()
      this.port?.dispose()
      this.api = null
    }
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
    if (this.snap.role !== 'editor' || !this.port || !this.api) return
    if (c.tool === 'note') {
      const size = 200
      const id = this.port.transact('note', (tx) =>
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
    if (this.snap.role !== 'editor' || !this.port) return
    const id = this.port.transact('text', (tx) => tx.create('text', { x, y, text: '' }))
    this.lease.markCreated(id)
    this.input.editorLease?.requestEdit(id, { reason: 'new-text', caretEnd: true })
  }

  // ---- undo ------------------------------------------------------------------------------------------------

  runUndo(dir: 'undo' | 'redo'): void {
    const out = dir === 'undo' ? this.undo?.undo() : this.undo?.redo()
    if (out)
      this.logEvent({
        kind: 'undo',
        id: dir,
        detail: JSON.stringify(
          out.result.skips.map((k) => ({ id: k.id, what: k.what, reason: k.reason, silent: k.silent })),
        ),
      })
    if (!out || out.kept === 0) return
    const who = out.keptBy ? ` — ${out.keptBy} edited it since` : ' — someone edited it since'
    this.toast(`${out.kept} change${out.kept === 1 ? '' : 's'} kept${who}`)
  }

  /**
   * The holder re-fits after a dropped fit (§2.9.4 rule 4). A container: Excalidraw's editor re-runs its
   * layout on the container as it is now. A leased free text (`dx`/`dy` given): the dropped fit's own
   * shift (a centred text grows around its centre) is re-applied on the server's position, with
   * Excalidraw's follow of the arrows bound to it (derived, held by the core), after the core has
   * installed the server's copy (B3 L10 5).
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
      mutateElement: (el: any, u: any, o?: any) => ExcalidrawElementLib.mutateElement(el, map, u, o),
      getNonDeletedElementsMap: () => map,
      getElementsMapIncludingDeleted: () => map,
      getNonDeletedElements: () => [...map.values()],
      triggerUpdate: () => {},
    }
    ExcalidrawElementLib.mutateElement(t, map, { x: t.x + dx, y: t.y + dy })
    ExcalidrawElementLib.updateBoundElements(t, scene as never)
    const next = els.map((e) => {
      const c = map.get(e.id)
      return c && c.version !== e.version ? c : e
    })
    api.updateScene({ elements: next as never, captureUpdate: CaptureUpdateAction.NEVER })
  }

  dispose(): void {
    for (const f of this.detach.splice(0)) f()
    this.core.stop()
    this.transport.close(1000, 'page closed')
    this.store?.release()
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element helpers, typed loosely on purpose
const ExcalidrawElementLib = ExcalidrawElementNs as any

function rejectText(code: string, id: string, core: LobbyEngineCore): string {
  if (code === 'LEASED') {
    const el = core.confirmed(id) as { containerId?: string | null } | undefined
    const h = core.leaseHolders().get(el?.containerId ?? id)
    return `Change not saved — ${h?.name ?? 'someone'} is typing in this note`
  }
  const reasons: Record<string, string> = {
    READ_ONLY: 'you can only view this board',
    LOCKED: 'it is locked',
    GONE: 'it was deleted',
    STALE: 'someone changed it while you were offline',
    ELEMENT_LIMIT: 'the board is full',
    GUEST_LIMIT: 'the guest limit is reached',
    VOTE_OPEN: 'a vote is open',
  }
  return `Change not saved${reasons[code] ? ` — ${reasons[code]}` : ''}`
}
