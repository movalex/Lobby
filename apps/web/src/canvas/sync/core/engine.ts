/**
 * The pure engine core (docs/EXCALIDRAW-MIGRATION.md §2.5): server messages and local scene snapshots
 * in; pushes, lease messages, presence and Saved state out. No DOM and no engine: the browser adapter
 * (`../adapter/**`) and the headless client (`../headless/**`) give it a scene and a transport.
 *
 * State (§2.5.1):
 *  - `confirmed`: the server's copy of every element (tombstones included), exactly as stored;
 *  - `tracked`: per element, the groups that differ locally from what the server has or will have
 *    (`base` = confirmed overlaid with this client's in-flight pushes), and whether it is a local create;
 *  - `inflight`: pushes without an ack (≤ 4, more only when a lease message forces a flush);
 *  - `held`: derived arrow changes (§2.5.2, E10) kept on screen, never pushed, reset when no cause of this
 *    client is pending;
 *  - `known` / `last`: the (version, versionNonce) and the copy of every element as last seen or applied,
 *    so a scan only looks at what changed since.
 *
 * Invariants the tests pin:
 *  - a group is pushed only when the local value differs from `base` (so a remote change applied locally,
 *    or a value already in flight, is never pushed back: E-rules of §2.5.5);
 *  - an element with nothing dirty, in flight or held is, in the scene, EXACTLY the server's copy (version
 *    and versionNonce included), so a quiet client's map hashes equal to the server's (hash.ts);
 *  - remote changes are applied with the gesture hold-back of §2.5.4; the text editor holds back only the
 *    edited label's `text` and `layout`;
 *  - text and layout of a text element are pushed only while this tab holds its lease, or when nobody
 *    holds it and this tab asked for nothing (programmatic writes); while this tab's request is pending
 *    they wait (the New element rule, the guard's step 3); held by someone else they are reset at once;
 *  - Saved (§2.5.7): nothing dirty, nothing in flight, nothing queued offline, and every push acked.
 *
 * NODE-SAFE (CONTRACTS.md): explicit `.ts` extensions, no DOM, injectable timers and clock.
 */
import { compareArrowChange } from '@draftroom/canvas-schema/groups'
import {
  COALESCE_MS,
  MAX_IN_FLIGHT_PUSHES,
  MAX_OPS_PER_PUSH,
  MAX_PUSH_BYTES,
  PRESENCE_IN_HZ,
  TYPING_PUSH_MS,
} from '@draftroom/canvas-schema/limits'
import {
  type Ack,
  type Changes,
  CLOSE_TERMINAL,
  type ClientMessage,
  ELEMENT_SCHEMA_VERSION,
  type LeaseClientMessage,
  type LeaseHolder,
  type LeaseServerMessage,
  type Op,
  PROTO,
  type PresenceIn,
  REJECT_CODE_INFO,
  type RejectCode,
  type RosterEntry,
  type ServerMessage,
  type ServerOp,
  type SnapshotFrame,
  type Welcome,
} from '@draftroom/canvas-schema/protocol'
import { indexPrePass } from '../index-keys.ts'
import type {
  EngineCore,
  EngineCoreOptions,
  GestureState,
  LeaseConnect,
  OfflineEntry,
  OfflineQueueStore,
  PushRecord,
  SaveStatus,
  SceneAdapter,
  SceneElement,
  SceneSnapshot,
  ServerInbound,
  Transport,
  TransportClose,
  TransportState,
} from '../types.ts'
import { IDLE_GESTURE } from '../types.ts'
import {
  buildPatch,
  clone,
  copyGroups,
  deepEqual,
  diffGroups,
  FIT_FIELDS,
  type GroupKey,
  opId,
  toWire,
  withoutArtifacts,
} from './fields.ts'
import { computeSaveStatus, type SaveInputs } from './saved.ts'
import { overlayPatchOp } from './server-ops.ts'

// ---- internal records ---------------------------------------------------------------------------------

interface Tracked {
  /** groups that differ from `base` and are not sent yet */
  dirty: Set<GroupKey>
  /** a local create the server does not have yet (the create op is sent until an ack confirms it) */
  isNew: boolean
  /** when this element first became dirty (the offline `off`) */
  since: number
  /** a replay from the offline queue or of a push lost with a socket: its ops carry `off` */
  replay: boolean
  /** the element was a leased free text's own fit (its `fit` carries x, y only) */
  freeTextFit?: boolean
  /**
   * The lease id whose grant this text change needs: it was made in an editor this tab opened without a
   * granted lease (a guard-caught open, the open-time re-measure of §2.9.2 step 3). Pushed only once that
   * lease is granted; reset when the editor closes without it.
   */
  needsLease?: string
}

interface Inflight {
  readonly seq: number
  readonly base: number
  readonly ops: Op[]
  readonly record: PushRecord
  /** per element: the groups this push carries and the local copy they were taken from */
  readonly sent: Map<string, { groups: Set<GroupKey>; el: SceneElement; create: boolean }>
  readonly forced: boolean
}

interface Held {
  /** the targets whose pending change keeps this derived arrow change on screen */
  readonly targets: readonly string[]
  /** a label held with its arrow */
  readonly arrow?: string
}

/** What the core reports besides the frozen interface (the adapter, presence, the board page use it). */
export type CoreEvent =
  | { kind: 'message'; message: ServerMessage }
  | { kind: 'push'; record: PushRecord; ids: readonly string[] }
  /** the server dropped a conditional fit of this container (or free text): the holder re-fits (§2.9.4 rule 4) */
  | { kind: 'refit'; id: string }
  /** a non-retryable reject (Change not saved, with the reason) */
  | { kind: 'reject'; id: string; code: RejectCode }
  /** elements the core just installed in the scene (changed ids), with the copies before */
  | { kind: 'applied'; ids: readonly string[]; before: ReadonlyMap<string, SceneElement | undefined> }
  | { kind: 'transport'; state: TransportState; close?: TransportClose }
  | { kind: 'welcome'; welcome: Welcome }
  | { kind: 'echo_suspect'; ids: readonly string[] }

const now0 = () => Date.now()
const GESTURE_FLAGS: readonly (keyof GestureState)[] = [
  'dragging',
  'resizing',
  'rotating',
  'cropping',
  'editingLinear',
]

export function gestureActive(g: GestureState): boolean {
  return (
    GESTURE_FLAGS.some((f) => g[f] === true) ||
    g.resizingElementId !== null ||
    g.newElementId !== null ||
    g.multiElementId !== null
  )
}

const isText = (el: SceneElement | undefined): boolean => el?.type === 'text'
const containerOf = (el: SceneElement | undefined): string | null =>
  ((el as { containerId?: string | null } | undefined)?.containerId ?? null) || null
const leaseIdOf = (el: SceneElement): string => containerOf(el) ?? el.id
const bindingTarget = (el: SceneElement, end: 'startBinding' | 'endBinding'): string | null =>
  ((el as Record<string, unknown>)[end] as { elementId?: string } | null | undefined)?.elementId ?? null

/** Lease-gated groups of a text element (§2.9.4: what the lease protects). */
const LEASED_GROUPS: ReadonlySet<GroupKey> = new Set<GroupKey>(['text', 'layout', 'life'])

export class LobbyEngineCore implements EngineCore {
  // ---- options
  private readonly transport: Transport
  private readonly scene: SceneAdapter
  private readonly tab: string
  private readonly store: OfflineQueueStore | undefined
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  private readonly logFn: EngineCoreOptions['log']

  // ---- server state
  welcome: Welcome | null = null
  clock = 0
  epoch: string | null = null
  private horizon = 0
  private readonly confirmedMap = new Map<string, SceneElement>()
  private doc: Record<string, unknown> = {}
  private readonly holders = new Map<string, LeaseHolder>()
  private readonly rosterMap = new Map<string, RosterEntry>()
  private awaitingSnapshot = false
  private resyncing = false
  private connected = false
  private terminal: TransportClose | null = null

  // ---- local state
  private readonly tracked = new Map<string, Tracked>()
  private inflight: Inflight[] = []
  private readonly held = new Map<string, Held>()
  private readonly known = new Map<string, { v: number; vn: number }>()
  private last = new Map<string, SceneElement>()
  /** ids to drop from the scene at the next apply (a rejected create, a local-only label never pushed) */
  private readonly vanish = new Set<string>()
  /** remote changes waiting for the gesture that holds their element (§2.5.4) */
  private readonly heldBack = new Set<string>()
  private gesture: GestureState = IDLE_GESTURE
  private editingLabel: string | null = null
  private current = new Map<string, SceneElement>()
  private currentOrder: SceneElement[] = []
  private seq = 0
  private readonly pushes: PushRecord[] = []
  private started = false
  private stopped = false

  // ---- timers and retries
  private flushTimer: unknown = null
  private flushDue = Number.POSITIVE_INFINITY
  private retryTimer: unknown = null
  private retryDelay = 0
  private unavailableSince: number | null = null
  private lastReject: SaveStatus['lastReject'] = null
  private offlineQueued = 0
  private persistTimer: unknown = null

  // ---- lease
  private leaseListener: ((m: LeaseServerMessage) => void) | null = null
  private readonly leaseReq = new Map<number, string>()
  private readonly leasePending = new Set<string>()
  private readonly leaseHeld = new Set<string>()
  private readonly queuedLease: LeaseClientMessage[] = []

  // ---- presence
  private presenceLast = Number.NEGATIVE_INFINITY
  private presencePending: Omit<PresenceIn, 'type'> | null = null
  private presenceTimer: unknown = null

  // ---- listeners
  private readonly saveListeners = new Set<(s: SaveStatus) => void>()
  private readonly ackListeners = new Set<(a: Ack) => void>()
  private readonly eventListeners = new Set<(e: CoreEvent) => void>()
  private lastSave: SaveStatus = {
    state: 'offline',
    pending: 0,
    offlineChanges: 0,
    lastReject: null,
  }
  private readonly unsubscribe: (() => void)[] = []

  constructor(opts: EngineCoreOptions) {
    this.transport = opts.transport
    this.scene = opts.scene
    this.tab = opts.tab
    this.store = opts.offline
    this.now = opts.now ?? now0
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.logFn = opts.log
  }

  // =====================================================================================================
  // lifecycle
  // =====================================================================================================

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe.push(this.transport.onMessage((m) => this.receive(m)))
    this.unsubscribe.push(this.transport.onState((s, c) => this.onTransportState(s, c)))
    void this.loadOffline()
    if (this.transport.state === 'open') this.onTransportState('open')
    else this.updateSaved()
  }

  stop(): void {
    this.stopped = true
    for (const u of this.unsubscribe.splice(0)) u()
    for (const t of [this.flushTimer, this.retryTimer, this.presenceTimer, this.persistTimer])
      if (t !== null) this.clearTimer(t)
    this.flushTimer = this.retryTimer = this.presenceTimer = this.persistTimer = null
  }

  private onTransportState(state: TransportState, close?: TransportClose): void {
    this.emit({ kind: 'transport', state, close })
    if (state === 'open') {
      this.connected = true
      this.terminal = null
      this.sendHello()
    } else if (state === 'closed') {
      this.connected = false
      this.welcome = null
      this.awaitingSnapshot = false
      if (close && close.code === CLOSE_TERMINAL) this.terminal = close
      this.schedulePersist()
    }
    this.updateSaved()
  }

  private sendHello(): void {
    this.transport.send({
      type: 'hello',
      proto: PROTO,
      schema: ELEMENT_SCHEMA_VERSION,
      since: this.epoch ? this.clock : 0,
      epoch: this.epoch,
      tab: this.tab,
    })
  }

  // =====================================================================================================
  // reads
  // =====================================================================================================

  elements(): ReadonlyMap<string, SceneElement> {
    const out = new Map<string, SceneElement>()
    for (const [id, el] of this.current) {
      const t = this.tracked.get(id)
      // a local create deleted before it was ever pushed is not part of the board
      if (t?.isNew && el.isDeleted && !this.confirmedMap.has(id) && !this.inflightHas(id)) continue
      out.set(id, withoutArtifacts(el))
    }
    for (const [id, el] of this.confirmedMap) if (!out.has(id)) out.set(id, el)
    return out
  }

  confirmed(id: string): SceneElement | undefined {
    return this.confirmedMap.get(id)
  }

  /** Every server copy (the snapshot and catch-up, then `changes`). */
  confirmedElements(): ReadonlyMap<string, SceneElement> {
    return this.confirmedMap
  }

  isDerivedHeld(id: string): boolean {
    return this.held.has(id)
  }

  get saveStatus(): SaveStatus {
    return this.lastSave
  }

  onSaveStatus(listener: (status: SaveStatus) => void): () => void {
    this.saveListeners.add(listener)
    return () => this.saveListeners.delete(listener)
  }

  onAck(listener: (ack: Ack) => void): () => void {
    this.ackListeners.add(listener)
    return () => this.ackListeners.delete(listener)
  }

  /** Everything else the core reports (server messages, pushes, refits, rejects, applies). */
  on(listener: (e: CoreEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  pushLog(): readonly PushRecord[] {
    return this.pushes
  }

  leaseHolders(): ReadonlyMap<string, LeaseHolder> {
    return this.holders
  }

  /** The roster (everyone in the room, uncapped), by session id. */
  roster(): ReadonlyMap<string, RosterEntry> {
    return this.rosterMap
  }

  /** The board document (`lb_doc` keys) as the server last sent it. */
  docValues(): Readonly<Record<string, unknown>> {
    return this.doc
  }

  /** This session's id (`welcome.sid`), or null before the first welcome. */
  get sid(): string | null {
    return this.welcome?.sid ?? null
  }

  get readonly(): boolean {
    return this.welcome?.readonly ?? false
  }

  /** The last terminal close (4099 and its reason), or null. */
  get terminalClose(): TransportClose | null {
    return this.terminal
  }

  /** Lease ids this tab holds, and ids it asked for without an answer yet. */
  leaseState(): { held: string[]; pending: string[] } {
    return { held: [...this.leaseHeld], pending: [...this.leasePending] }
  }

  /** Dirty (unsent or held) element ids, for tests and the debug panel. */
  dirtyIds(): string[] {
    return [...this.tracked.entries()].filter(([, t]) => t.dirty.size > 0 || t.isNew).map(([id]) => id)
  }

  private emit(e: CoreEvent): void {
    for (const l of [...this.eventListeners]) l(e)
  }

  private log(event: string, detail: Record<string, unknown>): void {
    this.logFn?.(event, detail)
  }

  // =====================================================================================================
  // local changes (§2.5.2)
  // =====================================================================================================

  onSceneChange(snapshot: SceneSnapshot): void {
    if (this.stopped) return
    const wasGesture = gestureActive(this.gesture)
    const prevEditing = this.gesture.editingTextElementId
    this.gesture = snapshot.gesture
    this.editingLabel = snapshot.gesture.editingTextElementId
    const gestureNow = gestureActive(snapshot.gesture)
    this.readScene(snapshot.elements)

    const reset = new Set<string>()
    const changed: SceneElement[] = []
    for (const el of snapshot.elements) {
      const k = this.known.get(el.id)
      if (k && k.v === el.version && k.vn === el.versionNonce) continue
      changed.push(el)
    }
    // vanished ids (§2.5.2): a never-pushed create is dropped with its state; a confirmed one comes back
    if (snapshot.elements.length !== this.last.size || changed.some((e) => !this.last.has(e.id))) {
      for (const id of [...this.last.keys()]) {
        if (this.current.has(id)) continue
        this.last.delete(id)
        this.known.delete(id)
        const t = this.tracked.get(id)
        if (t?.isNew && !this.confirmedMap.has(id) && !this.inflightHas(id)) this.tracked.delete(id)
        else if (this.confirmedMap.has(id)) reset.add(id)
      }
    }
    if (this.readonly) {
      // a read-only session never writes: every local change goes back to the server's copy
      for (const el of changed) if (this.confirmedMap.has(el.id)) reset.add(el.id)
    } else {
      this.classify(changed, reset)
    }
    for (const el of changed) {
      this.known.set(el.id, { v: el.version, vn: el.versionNonce })
      this.last.set(el.id, el)
    }
    // derived changes with nothing of this client behind them are reset in this same scan (§2.5.2)
    this.releaseHeld(reset)
    this.dropUngranted(reset)
    // the gesture ended: the remote changes it held back land now, and its edits go out at once
    if (wasGesture && !gestureNow) {
      for (const id of this.heldBack) reset.add(id)
      this.heldBack.clear()
    }
    if (reset.size) this.applyScene(reset)
    const editorClosed = prevEditing !== null && snapshot.gesture.editingTextElementId === null
    this.scheduleFlush(editorClosed || (wasGesture && !gestureNow))
    this.schedulePersist()
    this.updateSaved()
  }

  private readScene(elements: readonly SceneElement[]): void {
    this.currentOrder = elements as SceneElement[]
    const m = new Map<string, SceneElement>()
    for (const el of elements) m.set(el.id, el)
    this.current = m
  }

  /** `base`: the server copy overlaid with what this client's in-flight pushes carry for the element. */
  private base(id: string): SceneElement | undefined {
    let el = this.confirmedMap.get(id)
    for (const p of this.inflight) {
      const s = p.sent.get(id)
      if (!s) continue
      el = s.create || !el ? s.el : copyGroups(el, s.el, s.groups)
    }
    return el
  }

  private inflightHas(id: string): boolean {
    return this.inflight.some((p) => p.sent.has(id))
  }

  private inflightGroups(id: string): Set<GroupKey> {
    const out = new Set<GroupKey>()
    for (const p of this.inflight) {
      const s = p.sent.get(id)
      if (s) for (const g of s.groups) out.add(g)
    }
    return out
  }

  /** The lease id and container of the text element being edited, or null. */
  private editingContext(): { label: string; lease: string; container: string | null; free: boolean } | null {
    const id = this.editingLabel
    if (!id) return null
    const el = this.current.get(id)
    if (!el) return null
    const container = containerOf(el)
    return { label: id, lease: container ?? id, container, free: container === null }
  }

  /** How this tab stands with lease `id`: held, pending (asked), other (someone else holds it), or free. */
  private leaseStanding(id: string): 'held' | 'pending' | 'other' | 'free' {
    if (this.leaseHeld.has(id)) return 'held'
    if (this.leasePending.has(id)) return 'pending'
    const h = this.holders.get(id)
    if (h && h.sid !== this.welcome?.sid) return 'other'
    return 'free'
  }

  private classify(changed: readonly SceneElement[], reset: Set<string>): void {
    const ctx = this.editingContext()
    const gestureNow = gestureActive(this.gesture)
    let localMap: Map<string, SceneElement> | null = null
    let baseMap: Map<string, SceneElement> | null = null
    const derivedArrows = new Set<string>()
    const labels: SceneElement[] = []
    for (const el of changed) {
      const ref = this.base(el.id)
      const t = this.tracked.get(el.id)
      if (!ref) {
        // a local create (or the local copy of an element the server does not know)
        const isNew = t?.isNew ?? true
        this.track(el.id, new Set(diffGroups(el, undefined).groups), isNew)
        continue
      }
      const diff = diffGroups(el, ref)
      const groups = new Set(diff.groups)
      // an arrow whose change moved only its bound ends is DERIVED (§2.5.2, E10): held, never pushed
      if (el.type === 'arrow' && groups.has('path')) {
        localMap ??= this.current
        baseMap ??= this.baseMap()
        const rest = [...groups].filter((g) => g !== 'path')
        const cmpRef = rest.length ? copyGroups(ref, el, rest) : ref
        const cmp = compareArrowChange(
          el as never,
          cmpRef as never,
          localMap as ReadonlyMap<string, unknown>,
          baseMap as ReadonlyMap<string, unknown>,
        )
        if (cmp.derived) {
          groups.delete('path')
          derivedArrows.add(el.id)
          this.held.set(el.id, {
            targets: [bindingTarget(el, 'startBinding'), bindingTarget(el, 'endBinding')].filter(
              (x): x is string => !!x,
            ),
          })
        } else this.held.delete(el.id)
      }
      if (isText(el) && containerOf(el)) labels.push(el)
      // fit (§2.9.4 rule 1): the edited label's container, or a leased free text's own x/y, while no gesture runs
      if (ctx && !gestureNow) {
        const fitOf =
          ctx.container && el.id === ctx.container
            ? FIT_FIELDS
            : ctx.free && el.id === ctx.label
              ? ['x', 'y']
              : null
        if (fitOf) {
          const standing = this.leaseStanding(ctx.lease)
          if (standing === 'held' || standing === 'pending') {
            let fit = false
            for (const [f, g] of diff.fields) {
              if (!(fitOf as readonly string[]).includes(f)) continue
              fit = true
              // the group stays only if one of its other fields changed too
              const others = [...diff.fields].some(
                ([of, og]) => og === g && !(fitOf as readonly string[]).includes(of),
              )
              if (!others) groups.delete(g)
            }
            if (fit) {
              groups.add('fit')
              const tt = this.tracked.get(el.id)
              if (tt) tt.freeTextFit = ctx.free
            }
          }
        }
      }
      if (groups.size === 0) {
        this.untrack(el.id)
        // nothing differs from the server's copy (or what is in flight): the scene must hold the server's
        // copy exactly (version included), unless a derived change is held or a push is out for it
        if (!this.held.has(el.id) && !this.inflightHas(el.id)) {
          const conf = this.confirmedMap.get(el.id)
          if (conf && (conf.version !== el.version || conf.versionNonce !== el.versionNonce)) reset.add(el.id)
        }
        continue
      }
      this.track(el.id, groups, t?.isNew ?? false)
      if (groups.has('fit')) {
        const tt = this.tracked.get(el.id)
        if (tt) tt.freeTextFit = !!ctx?.free && el.id === ctx.label
      }
    }
    // an arrow's label moved with a derived arrow change is derived too
    for (const label of labels) {
      const arrow = containerOf(label) as string
      if (!this.held.has(arrow) && !derivedArrows.has(arrow)) continue
      const t = this.tracked.get(label.id)
      if (!t || [...t.dirty].some((g) => g !== 'layout') || t.isNew) continue
      if (this.editingLabel === label.id) continue // the holder's typing re-wraps it
      this.untrack(label.id)
      this.held.set(label.id, { targets: [], arrow })
    }
    // the lease gate for text: someone else holds it -> the local text and layout go back at once
    for (const el of changed) {
      const t = this.tracked.get(el.id)
      if (!t) continue
      if (isText(el)) {
        const standing = this.leaseStanding(leaseIdOf(el))
        // a change in an editor open without this tab's grant waits for it (and goes back without it)
        if (
          this.editingLabel === el.id &&
          standing !== 'held' &&
          [...t.dirty].some((g) => LEASED_GROUPS.has(g))
        )
          t.needsLease = leaseIdOf(el)
        if (standing === 'other') {
          const drop = t.isNew ? [...t.dirty] : [...t.dirty].filter((g) => LEASED_GROUPS.has(g))
          if (drop.length) {
            if (t.isNew && !this.confirmedMap.has(el.id)) {
              this.tracked.delete(el.id)
              this.vanish.add(el.id)
              reset.add(el.id)
            } else {
              for (const g of drop) t.dirty.delete(g)
              if (t.dirty.size === 0) this.tracked.delete(el.id)
              reset.add(el.id)
            }
          }
        }
      } else if (t.dirty.has('fit')) {
        // a container fit while someone else holds its label's lease is never ours to write
        const labelId = (el.boundElements as { id: string; type: string }[] | null | undefined)?.find(
          (b) => b.type === 'text',
        )?.id
        if (labelId && this.leaseStanding(el.id) === 'other') {
          t.dirty.delete('fit')
          if (t.dirty.size === 0) this.tracked.delete(el.id)
          reset.add(el.id)
        }
      }
    }
  }

  private baseMap(): Map<string, SceneElement> {
    const m = new Map(this.confirmedMap)
    for (const p of this.inflight) for (const id of p.sent.keys()) m.set(id, this.base(id) as SceneElement)
    return m
  }

  private track(id: string, groups: Set<GroupKey>, isNew: boolean): void {
    const t = this.tracked.get(id)
    if (t) {
      t.dirty = groups
      t.isNew = isNew
      return
    }
    // an edit made with no socket is replayed from the queue: its ops carry their age (`off`, §2.5.6)
    const offline = !this.connected || !this.welcome
    this.tracked.set(id, { dirty: groups, isNew, since: this.now(), replay: offline })
  }

  private untrack(id: string): void {
    const t = this.tracked.get(id)
    if (t && !t.isNew) this.tracked.delete(id)
  }

  // =====================================================================================================
  // derived arrows: pending causes (§2.5.2, §2.9.4 rule 7)
  // =====================================================================================================

  private causePending(h: Held): boolean {
    if (h.arrow) return this.held.has(h.arrow) && this.causePending(this.held.get(h.arrow) as Held)
    if (gestureActive(this.gesture)) return true
    for (const target of h.targets) {
      const t = this.tracked.get(target)
      if (t && (t.dirty.size > 0 || t.isNew)) return true
      if (this.inflightHas(target)) return true
      // the text editor open on the target's label: the holder's fit is on its way
      const ctx = this.editingContext()
      if (ctx && (ctx.container === target || ctx.label === target)) return true
    }
    return false
  }

  /** Resets every held derived change with no pending cause of this client (into `reset`). */
  private releaseHeld(reset: Set<string>): void {
    for (const [id, h] of [...this.held]) {
      if (this.causePending(h)) continue
      this.held.delete(id)
      reset.add(id)
    }
  }

  // =====================================================================================================
  // applying server state (§2.5.4)
  // =====================================================================================================

  /** The ids an active gesture holds back (§2.5.4): containers and labels together. */
  private gestureIds(): Set<string> {
    const g = this.gesture
    const out = new Set<string>()
    for (const id of [g.resizingElementId, g.newElementId, g.multiElementId, g.selectedLinearElementId])
      if (id) out.add(id)
    if (g.dragging || g.resizing || g.rotating || g.cropping)
      for (const id of g.selectedElementIds) out.add(id)
    for (const id of [...out]) {
      const el = this.current.get(id)
      if (!el) continue
      const c = containerOf(el)
      if (c) out.add(c)
      for (const b of (el.boundElements as { id: string; type: string }[] | null | undefined) ?? [])
        if (b.type === 'text') out.add(b.id)
    }
    return out
  }

  /**
   * The element the scene should hold: the server's copy overlaid with this client's dirty and in-flight
   * groups (the local values), the edited label's text and layout, and a held derived change. An element
   * with none of these is the server's copy exactly.
   */
  private rebuild(id: string): SceneElement | undefined {
    const conf = this.confirmedMap.get(id)
    const local = this.current.get(id)
    if (!local) return conf
    const t = this.tracked.get(id)
    if (!conf) return t?.isNew || this.inflightHas(id) ? local : undefined
    const groups = new Set<GroupKey>([...(t?.dirty ?? []), ...this.inflightGroups(id)])
    // the open editor: only the edited label's text and layout are held back (§2.5.4), while this tab
    // holds or asks for its lease; a deny or a lost lease puts the server's back
    if (id === this.editingLabel) {
      const standing = this.leaseStanding(leaseIdOf(local))
      if (standing === 'held' || standing === 'pending') {
        groups.add('text')
        groups.add('layout')
      }
    }
    if (this.held.has(id))
      groups.add(id === this.editingLabel ? 'layout' : local.type === 'arrow' ? 'path' : 'layout')
    if (groups.size === 0) return conf
    const out = copyGroups(conf, local, groups) as Record<string, unknown>
    out.version = Math.max(local.version, conf.version)
    out.versionNonce = local.versionNonce
    if (deepEqual(out, local)) return local
    return out as SceneElement
  }

  /**
   * Installs the whole element array (§2.5.4) with the rebuilt copies of `ids` (and every confirmed
   * element missing from the scene), after the index pre-pass (E2, E3). Elements an active gesture holds
   * keep their local copy until it ends.
   */
  private applyScene(ids: ReadonlySet<string>): void {
    const hold = gestureActive(this.gesture) ? this.gestureIds() : new Set<string>()
    const out: SceneElement[] = []
    const seen = new Set<string>()
    const before = new Map<string, SceneElement | undefined>()
    const touched: string[] = []
    const put = (id: string, el: SceneElement | undefined) => {
      if (!el) return
      seen.add(id)
      out.push(el)
    }
    for (const el of this.currentOrder) {
      if (seen.has(el.id)) continue
      if (this.vanish.has(el.id)) {
        before.set(el.id, el)
        touched.push(el.id)
        seen.add(el.id)
        continue
      }
      if (ids.has(el.id)) {
        if (hold.has(el.id)) {
          this.heldBack.add(el.id)
          put(el.id, el)
          continue
        }
        const next = this.rebuild(el.id)
        if (next !== el) {
          before.set(el.id, el)
          touched.push(el.id)
        }
        put(el.id, next)
        continue
      }
      put(el.id, el)
    }
    for (const [id, el] of this.confirmedMap) {
      if (seen.has(id) || this.vanish.has(id)) continue
      before.set(id, undefined)
      touched.push(id)
      put(id, el)
    }
    this.vanish.clear()
    if (touched.length === 0) return
    const own = (el: SceneElement) => {
      const t = this.tracked.get(el.id)
      return !!t?.isNew && !this.confirmedMap.has(el.id)
    }
    const pre = indexPrePass(out, {
      isOwnUnacked: (el) => own(el) || (this.inflightHas(el.id) && !this.confirmedMap.has(el.id)),
      isInFlight: (el) => this.inflightHas(el.id),
      withIndex: (el, index) => ({ ...el, index }) as SceneElement,
    })
    if (pre.confirmedConflicts.length)
      this.log('index_conflict', { ids: pre.confirmedConflicts.slice(0, 20) })
    for (const r of pre.rekeys) {
      if (!r.inFlight) {
        const t = this.tracked.get(r.id)
        if (t && !t.isNew) t.dirty.add('z')
      }
      if (!before.has(r.id)) {
        before.set(r.id, this.current.get(r.id))
        touched.push(r.id)
      }
    }
    const next = pre.elements
    for (const el of next) {
      this.known.set(el.id, { v: el.version, vn: el.versionNonce })
      this.last.set(el.id, el)
    }
    for (const id of touched)
      if (!next.some((e) => e.id === id)) {
        this.known.delete(id)
        this.last.delete(id)
      }
    this.readScene(next)
    this.scene.apply(next)
    // the global guard (§2.5.5): what the scene holds now for a clean confirmed element is the server's copy
    const after = this.scene.read().elements
    const suspects: string[] = []
    for (const el of after) {
      const k = this.known.get(el.id)
      if (!k || (k.v === el.version && k.vn === el.versionNonce)) continue
      if (this.confirmedMap.has(el.id) && !this.tracked.has(el.id)) suspects.push(el.id)
    }
    if (suspects.length) {
      this.log('echo_suspect', { ids: suspects.slice(0, 20) })
      this.emit({ kind: 'echo_suspect', ids: suspects })
    }
    this.emit({ kind: 'applied', ids: touched, before })
  }

  // =====================================================================================================
  // server messages
  // =====================================================================================================

  private receive(m: ServerInbound): void {
    if (this.stopped) return
    if (m.type === 'snapshot') {
      this.onSnapshot(m)
      return
    }
    this.emit({ kind: 'message', message: m })
    switch (m.type) {
      case 'welcome':
        this.onWelcome(m)
        return
      case 'changes':
        this.onChanges(m)
        return
      case 'ack':
        this.onAckMessage(m)
        return
      case 'lease.grant':
      case 'lease.deny':
      case 'lease':
        this.onLease(m)
        return
      case 'roster':
        for (const ev of m.events) {
          if (ev.k === 'leave') this.rosterMap.delete(ev.sid)
          else this.rosterMap.set(ev.p.sid, ev.p)
        }
        return
      case 'notice':
        if (m.code === 'RESYNC') this.resync()
        if (m.code === 'SLOW_DOWN') this.retryDelay = Math.max(this.retryDelay, 1000)
        return
      default:
        return
    }
  }

  private onWelcome(w: Welcome): void {
    const epochChanged = this.epoch !== null && this.epoch !== w.epoch
    this.welcome = w
    this.epoch = w.epoch
    this.horizon = w.horizon
    this.doc = { ...w.doc }
    this.holders.clear()
    for (const l of w.leases) this.holders.set(l.id, l.holder)
    this.rosterMap.clear()
    for (const r of w.roster) this.rosterMap.set(r.sid, r)
    // a lease this tab thought it held but the server does not name it for is gone (§2.9.3)
    for (const id of [...this.leaseHeld]) if (this.holders.get(id)?.sid !== w.sid) this.leaseHeld.delete(id)
    if (w.reset) {
      this.awaitingSnapshot = true
      if (epochChanged) this.log('epoch_reset', { epoch: w.epoch })
      return
    }
    for (const op of w.catchUp ?? []) this.applyServerOp(op, new Set())
    this.clock = w.clock
    this.afterWelcome()
    this.emit({ kind: 'welcome', welcome: w })
  }

  private onSnapshot(frame: SnapshotFrame): void {
    if (!this.awaitingSnapshot) {
      this.log('unexpected_snapshot', { clock: frame.clock })
      return
    }
    this.awaitingSnapshot = false
    this.confirmedMap.clear()
    for (const el of frame.elements) this.confirmedMap.set(el.id, el as unknown as SceneElement)
    this.clock = frame.clock
    this.epoch = frame.epoch
    this.horizon = frame.horizon
    this.doc = { ...frame.doc }
    this.afterWelcome()
    if (this.welcome) this.emit({ kind: 'welcome', welcome: this.welcome })
  }

  /** After a welcome (catch-up or reset): rebase every local change on the new server state, then push. */
  private afterWelcome(): void {
    this.resyncing = false
    // pushes with no ack were lost with the old socket: their groups are dirty again (replayed with `off`)
    for (const p of this.inflight) {
      for (const [id, s] of p.sent) {
        const t = this.tracked.get(id)
        if (t) for (const g of s.groups) t.dirty.add(g)
        else
          this.tracked.set(id, {
            dirty: new Set(s.groups),
            isNew: s.create,
            since: p.record.at,
            replay: true,
          })
        const tt = this.tracked.get(id) as Tracked
        tt.replay = true
        if (s.create) tt.isNew = true
      }
    }
    this.inflight = []
    for (const [id, t] of [...this.tracked]) {
      if (this.confirmedMap.has(id)) t.isNew = false
      else if (!t.isNew) this.tracked.delete(id)
    }
    this.held.clear()
    this.heldBack.clear()
    // the whole scene is rebuilt from the new server state and the local changes
    const all = new Set<string>([...this.current.keys(), ...this.confirmedMap.keys()])
    for (const id of this.current.keys())
      if (!this.confirmedMap.has(id) && !this.tracked.has(id)) this.vanish.add(id)
    this.applyScene(all)
    // dirty groups equal to the new server copy are not changes any more
    for (const [id, t] of [...this.tracked]) {
      if (t.isNew) continue
      const el = this.current.get(id)
      const conf = this.confirmedMap.get(id)
      if (!el || !conf) continue
      const diff = diffGroups(el, conf).groups
      for (const g of [...t.dirty]) if (g !== 'fit' && !diff.has(g)) t.dirty.delete(g)
      if (t.dirty.size === 0) this.tracked.delete(id)
    }
    // lease messages asked for while disconnected go out now, behind any push
    this.flushNow(true)
    for (const m of this.queuedLease.splice(0)) this.transport.send(m)
    this.retryDelay = 0
    this.updateSaved()
  }

  private applyServerOp(op: ServerOp, affected: Set<string>): boolean {
    if (op.k === 'c') {
      this.confirmedMap.set(op.el.id, op.el as unknown as SceneElement)
      affected.add(op.el.id)
      return true
    }
    const cur = this.confirmedMap.get(op.id)
    if (!cur || cur.version !== op.pv) {
      this.log('resync_pv', { id: op.id, have: cur?.version ?? null, pv: op.pv })
      return false
    }
    this.confirmedMap.set(op.id, overlayPatchOp(cur, op))
    affected.add(op.id)
    return true
  }

  private onChanges(m: Changes): void {
    if (this.resyncing || this.awaitingSnapshot || !this.welcome) return
    const affected = new Set<string>()
    for (const op of m.ops) {
      if (!this.applyServerOp(op, affected)) {
        this.resync()
        return
      }
    }
    if (m.doc)
      for (const [k, v] of Object.entries(m.doc.set)) {
        if (v === null) delete this.doc[k]
        else this.doc[k] = v
      }
    this.clock = m.clock
    // the server's value for a held derived change arrived: it replaces the local follow (§2.5.2)
    for (const id of affected) this.held.delete(id)
    this.releaseHeld(affected)
    // elements that are now equal to the server's copy in their dirty groups are clean
    this.applyScene(affected)
    this.updateSaved()
  }

  private resync(): void {
    if (this.resyncing || !this.connected) return
    this.resyncing = true
    this.log('resync', { since: this.clock })
    this.sendHello()
  }

  private onAckMessage(ack: Ack): void {
    const i = this.inflight.findIndex((p) => p.seq === ack.seq)
    if (i < 0) {
      this.log('ack_unknown', { seq: ack.seq })
      return
    }
    const push = this.inflight[i] as Inflight
    this.inflight.splice(i, 1)
    const affected = new Set<string>()
    let retry = false
    let allOk = true
    ack.r.forEach((r, n) => {
      const op = push.ops[n]
      const id = op ? opId(op) : r.id
      affected.add(id)
      const sent = push.sent.get(id)
      if (r.ok) {
        const t = this.tracked.get(id)
        if (t && sent?.create) t.isNew = false
        if (r.denied) {
          allOk = false
          this.lastReject = { id, code: r.denied.code }
          this.emit({ kind: 'reject', id, code: r.denied.code })
        }
        if (r.fitDropped) this.emit({ kind: 'refit', id })
        return
      }
      const info = REJECT_CODE_INFO[r.code]
      if (info.retryable) {
        retry = true
        if (r.code === 'UNAVAILABLE' && this.unavailableSince === null) this.unavailableSince = this.now()
        if (sent) {
          const t = this.tracked.get(id)
          if (t) for (const g of sent.groups) t.dirty.add(g)
          else
            this.tracked.set(id, {
              dirty: new Set(sent.groups),
              isNew: sent.create,
              since: this.now(),
              replay: false,
            })
          if (sent.create) (this.tracked.get(id) as Tracked).isNew = true
        }
        return
      }
      allOk = false
      this.lastReject = { id, code: r.code }
      this.emit({ kind: 'reject', id, code: r.code })
      if (r.el) this.confirmedMap.set(id, r.el as unknown as SceneElement)
      else if (!this.confirmedMap.has(id)) {
        // a create the server refused: the element never existed for anyone
        this.tracked.delete(id)
        this.vanish.add(id)
      }
    })
    if (!retry) {
      this.unavailableSince = null
      this.retryDelay = 0
    }
    if (allOk && !retry) this.lastReject = null
    for (const d of ack.derived ?? []) affected.add(d.id)
    for (const l of [...this.ackListeners]) l(ack)
    this.releaseHeld(affected)
    this.applyScene(affected)
    if (retry) this.scheduleRetry()
    else this.scheduleFlush(false)
    this.updateSaved()
  }

  // =====================================================================================================
  // pushing (§2.5.3)
  // =====================================================================================================

  flush(): void {
    this.flushNow(false)
  }

  private scheduleFlush(immediate: boolean): void {
    if (gestureActive(this.gesture)) return // one push at the end of the gesture
    const typingOnly = this.onlyTyping()
    if (!this.hasPushable()) return
    const delay = immediate ? 0 : typingOnly ? TYPING_PUSH_MS : COALESCE_MS
    const due = this.now() + delay
    if (this.flushTimer !== null && this.flushDue <= due) return
    if (this.flushTimer !== null) this.clearTimer(this.flushTimer)
    this.flushDue = due
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = null
      this.flushDue = Number.POSITIVE_INFINITY
      this.flushNow(false)
    }, delay)
  }

  /** Every dirty element is the edited label's text/layout or its container's fit (typing, §2.5.3). */
  private onlyTyping(): boolean {
    const ctx = this.editingContext()
    if (!ctx) return false
    for (const [id, t] of this.tracked) {
      if (t.dirty.size === 0 && !t.isNew) continue
      if (
        id === ctx.label &&
        !t.isNew &&
        [...t.dirty].every((g) => g === 'text' || g === 'layout' || g === 'fit')
      )
        continue
      if (id === ctx.container && [...t.dirty].every((g) => g === 'fit')) continue
      return false
    }
    return true
  }

  private hasPushable(): boolean {
    for (const [id] of this.tracked) if (this.pushableGroups(id)) return true
    return false
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return
    this.retryDelay = Math.min(Math.max(this.retryDelay * 2, 500), 10_000)
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null
      this.flushNow(false)
    }, this.retryDelay)
  }

  /**
   * What of element `id` may be pushed now: `null` when nothing (a gesture holds it, its lease is pending
   * or someone else's, a held create), else its groups and whether it is a create.
   */
  private pushableGroups(id: string): { groups: Set<GroupKey>; create: boolean } | null {
    const t = this.tracked.get(id)
    if (!t || (t.dirty.size === 0 && !t.isNew)) return null
    const el = this.current.get(id)
    if (!el) return null
    if (gestureActive(this.gesture) && this.gestureIds().has(id)) return null
    const create = t.isNew && !this.confirmedMap.has(id)
    if (create && this.inflight.some((p) => p.sent.get(id)?.create)) return null // the create is out: wait
    if (create && el.isDeleted) return null // created and deleted before it was pushed: nothing to say
    const groups = new Set(t.dirty)
    // text and layout (and a label's create) wait for this tab's lease (§2.9.2 New element, guard step 3)
    if (isText(el)) {
      const standing = this.leaseStanding(leaseIdOf(el))
      const editingHere = this.editingLabel === id
      const gate =
        standing === 'pending' ||
        standing === 'other' ||
        (editingHere && standing !== 'held') ||
        (t.needsLease !== undefined && this.leaseStanding(t.needsLease) !== 'held')
      if (gate) {
        if (create) return null
        for (const g of LEASED_GROUPS) groups.delete(g)
      }
    }
    // a fit is the lease holder's (the container's lease, or a free text's own): only while held
    if (groups.has('fit') && this.leaseStanding(id) !== 'held') groups.delete('fit')
    if (groups.has('bound')) {
      // a container's bound change waits while it names a label whose create waits
      const added = ((el.boundElements as { id: string; type: string }[] | null | undefined) ?? []).filter(
        (b) => {
          const tt = this.tracked.get(b.id)
          return !!tt?.isNew && !this.confirmedMap.has(b.id) && !this.inflightHas(b.id)
        },
      )
      if (added.some((b) => this.pushableGroups(b.id) === null)) groups.delete('bound')
    }
    if (create) return { groups, create: true }
    return groups.size ? { groups, create: false } : null
  }

  /** Builds and sends pushes for everything pushable. `forced`: a lease message follows (no cap). */
  private flushNow(forced: boolean): void {
    if (this.flushTimer !== null) {
      this.clearTimer(this.flushTimer)
      this.flushTimer = null
      this.flushDue = Number.POSITIVE_INFINITY
    }
    if (!this.connected || !this.welcome || this.awaitingSnapshot || this.resyncing) {
      this.schedulePersist()
      this.updateSaved()
      return
    }
    if (!forced && this.inflight.length >= MAX_IN_FLIGHT_PUSHES) return
    let ops: Op[] = []
    let sent = new Map<string, { groups: Set<GroupKey>; el: SceneElement; create: boolean }>()
    let bytes = 0
    const flushOne = () => {
      if (ops.length === 0) return
      this.sendPush(ops, sent, forced)
      ops = []
      sent = new Map()
      bytes = 0
    }
    // creates first (a label's container before the label: the index order), then patches
    const entries = [...this.tracked.keys()].map((id) => ({ id, p: this.pushableGroups(id) }))
    const order = entries
      .filter((e): e is { id: string; p: { groups: Set<GroupKey>; create: boolean } } => e.p !== null)
      .sort((a, b) => Number(b.p.create) - Number(a.p.create))
    for (const { id, p } of order) {
      const el = this.current.get(id) as SceneElement
      const t = this.tracked.get(id) as Tracked
      const off = t.replay ? this.now() - t.since : undefined
      let op: Op | null
      if (p.create) op = { k: 'c', el: toWire(el) as never }
      else {
        const ref = this.base(id) as SceneElement
        const conf = this.confirmedMap.get(id) as SceneElement
        op = buildPatch(el, ref, p.groups, { pv: conf.version, off, freeTextFit: t.freeTextFit })
      }
      for (const g of p.groups) t.dirty.delete(g)
      if (p.create) t.dirty.clear()
      if (t.dirty.size === 0 && !(t.isNew && !p.create)) {
        if (!t.isNew) this.tracked.delete(id)
      }
      if (!op) continue
      const size = JSON.stringify(op).length
      if (ops.length >= MAX_OPS_PER_PUSH || bytes + size > MAX_PUSH_BYTES) flushOne()
      ops.push(op)
      bytes += size
      sent.set(id, {
        groups: p.create ? new Set(diffGroups(el, undefined).groups) : new Set(p.groups),
        el: clone(el),
        create: p.create,
      })
      if (!forced && this.inflight.length >= MAX_IN_FLIGHT_PUSHES) break
    }
    flushOne()
    this.updateSaved()
  }

  private sendPush(
    ops: Op[],
    sent: Map<string, { groups: Set<GroupKey>; el: SceneElement; create: boolean }>,
    forced: boolean,
  ): void {
    const seq = ++this.seq
    const base = this.clock
    const record: PushRecord = { seq, base, at: this.now(), ops }
    this.inflight.push({ seq, base, ops, record, sent, forced })
    this.pushes.push(record)
    this.transport.send({ type: 'push', seq, base, ops })
    for (const t of this.tracked.values()) if (t.dirty.size === 0) t.replay = false
    this.emit({ kind: 'push', record, ids: [...sent.keys()] })
  }

  // =====================================================================================================
  // the lease (§2.9.2): LeaseClient talks to the server through the same socket, in the session's order
  // =====================================================================================================

  readonly leaseConnect: LeaseConnect = (onMessage) => {
    this.leaseListener = onMessage
    return {
      send: (message) => this.sendLease(message),
    }
  }

  private sendLease(message: LeaseClientMessage): void {
    const online = this.connected && !!this.welcome && !this.awaitingSnapshot
    // the per-session FIFO (§2.4.3): the create before its acquire, the editor's final push (made while
    // the lease is still held, so its text is not gated) before its release
    if (online) this.flushNow(true)
    if (message.type === 'lease.acquire') {
      this.leaseReq.set(message.req, message.id)
      this.leasePending.add(message.id)
    } else {
      this.leaseHeld.delete(message.id)
      this.leasePending.delete(message.id)
    }
    if (online) this.transport.send(message)
    else if (message.type === 'lease.acquire') this.queuedLease.push(message)
    // a release while offline is not sent: the server lets the lease expire (§2.9.3)
    this.updateSaved()
  }

  private onLease(m: LeaseServerMessage): void {
    const affected = new Set<string>()
    if (m.type === 'lease') {
      if (m.holder) this.holders.set(m.id, m.holder)
      else this.holders.delete(m.id)
      if (m.holder && m.holder.sid !== this.welcome?.sid && this.leaseHeld.delete(m.id))
        this.dropLeased(m.id, affected)
    } else {
      this.leaseReq.delete(m.req)
      this.leasePending.delete(m.id)
      if (m.type === 'lease.grant') this.leaseHeld.add(m.id)
      else {
        this.holders.set(m.id, m.holder)
        this.dropLeased(m.id, affected)
      }
    }
    this.leaseListener?.(m)
    this.dropUngranted(affected)
    if (affected.size) {
      this.releaseHeld(affected)
      this.applyScene(affected)
    }
    this.scheduleFlush(false)
    this.updateSaved()
  }

  /**
   * Text changes made in an editor this tab opened without a grant, once that editor is gone and no
   * request of this tab is out (the guard closed it, the deny came, the user left it): they go back.
   */
  private dropUngranted(affected: Set<string>): void {
    for (const [id, t] of [...this.tracked]) {
      if (t.needsLease === undefined || this.editingLabel === id) continue
      const standing = this.leaseStanding(t.needsLease)
      if (standing === 'held' || standing === 'pending') continue
      t.needsLease = undefined
      if (t.isNew && !this.confirmedMap.has(id)) {
        this.tracked.delete(id)
        this.vanish.add(id)
      } else {
        for (const g of LEASED_GROUPS) t.dirty.delete(g)
        if (t.dirty.size === 0) this.tracked.delete(id)
      }
      affected.add(id)
    }
  }

  /** A lease this tab does not get (deny) or lost: its label's text, layout and life, and the fit, go back. */
  private dropLeased(leaseId: string, affected: Set<string>): void {
    for (const [id, t] of [...this.tracked]) {
      const el = this.current.get(id)
      if (!el) continue
      if (isText(el) && leaseIdOf(el) === leaseId) {
        if (t.isNew && !this.confirmedMap.has(id)) {
          this.tracked.delete(id)
          this.vanish.add(id)
        } else {
          for (const g of LEASED_GROUPS) t.dirty.delete(g)
          if (t.dirty.size === 0 && !t.isNew) this.tracked.delete(id)
        }
        affected.add(id)
      } else if (id === leaseId && t.dirty.delete('fit')) {
        if (t.dirty.size === 0 && !t.isNew) this.tracked.delete(id)
        affected.add(id)
      }
    }
    // arrows following the container go back with it
    for (const [id, h] of this.held) if (h.targets.includes(leaseId)) affected.add(id)
  }

  // =====================================================================================================
  // presence (§2.7): ≤ 20 Hz, a drag's first message (ids) and its end are never dropped
  // =====================================================================================================

  sendPresence(presence: Omit<PresenceIn, 'type'>): void {
    const prev = this.presencePending
    let next = presence
    // keep a drag's ids (the first message of a drag) and an end (null) that were not sent yet
    if (prev?.drag && next.drag && prev.drag.ids && prev.drag.d === next.drag.d && !next.drag.ids)
      next = { ...next, drag: { ...next.drag, ids: prev.drag.ids } }
    // a message without `drag` (a pointer move) never replaces an unsent drag start, move or end
    if (prev && prev.drag !== undefined && next.drag === undefined) next = { ...next, drag: prev.drag }
    this.presencePending = next
    const interval = 1000 / PRESENCE_IN_HZ
    const wait = this.presenceLast + interval - this.now()
    if (wait <= 0) {
      this.sendPresenceNow()
      return
    }
    if (this.presenceTimer === null)
      this.presenceTimer = this.setTimer(() => {
        this.presenceTimer = null
        this.sendPresenceNow()
      }, wait)
  }

  private sendPresenceNow(): void {
    const p = this.presencePending
    this.presencePending = null
    if (!p || !this.connected || !this.welcome) return
    this.presenceLast = this.now()
    this.transport.send({ type: 'presence', ...p } as ClientMessage)
  }

  // =====================================================================================================
  // the offline queue (§2.5.6)
  // =====================================================================================================

  private async loadOffline(): Promise<void> {
    if (!this.store) return
    try {
      const entries = await this.store.load()
      if (!entries.length) return
      for (const e of entries) this.adoptOffline(e)
      this.log('offline_adopted', { entries: entries.length })
      this.updateSaved()
      if (this.welcome && !this.awaitingSnapshot) this.afterWelcome()
    } catch (err) {
      this.log('offline_load_failed', { error: String(err) })
    }
  }

  private adoptOffline(e: OfflineEntry): void {
    const id = e.element.id
    const isNew = e.groups.includes('create')
    const groups = new Set<GroupKey>(e.groups.filter((g) => g !== 'create') as GroupKey[])
    this.tracked.set(id, { dirty: groups, isNew, since: e.queuedAt, replay: true })
    // the queued element becomes the local copy (its dirty groups are rebased on the server's at welcome)
    const next = [...this.currentOrder.filter((el) => el.id !== id), e.element]
    this.readScene(next)
    this.known.delete(id)
  }

  private offlineEntries(): OfflineEntry[] {
    const out: OfflineEntry[] = []
    const add = (id: string, groups: Iterable<GroupKey>, create: boolean, since: number) => {
      const el = this.current.get(id)
      if (!el) return
      const g = new Set<string>(groups)
      if (create) g.add('create')
      out.push({ element: clone(el), groups: [...g], base: this.clock, queuedAt: since })
    }
    const seen = new Set<string>()
    for (const [id, t] of this.tracked) {
      if (t.dirty.size === 0 && !t.isNew) continue
      const groups = new Set<GroupKey>([...t.dirty, ...this.inflightGroups(id)])
      add(id, groups, t.isNew && !this.confirmedMap.has(id), t.since)
      seen.add(id)
    }
    for (const p of this.inflight)
      for (const [id, s] of p.sent) {
        if (seen.has(id)) continue
        seen.add(id)
        add(id, s.groups, s.create, p.record.at)
      }
    return out
  }

  private schedulePersist(): void {
    if (!this.store || this.persistTimer !== null) return
    this.persistTimer = this.setTimer(() => {
      this.persistTimer = null
      void this.persist()
    }, 100)
  }

  private async persist(): Promise<void> {
    if (!this.store) return
    const entries = this.offlineEntries()
    this.offlineQueued = this.connected && this.welcome ? 0 : entries.length
    try {
      if (entries.length) await this.store.save(entries)
      else await this.store.clear()
    } catch (err) {
      this.log('offline_save_failed', { error: String(err) })
    }
    this.updateSaved()
  }

  // =====================================================================================================
  // Saved (§2.5.7)
  // =====================================================================================================

  private updateSaved(): void {
    let dirty = 0
    for (const t of this.tracked.values()) if (t.dirty.size > 0 || t.isNew) dirty++
    const inputs: SaveInputs = {
      connected: this.connected && !!this.welcome && !this.awaitingSnapshot,
      dirty,
      inflightOps: this.inflight.reduce((n, p) => n + p.ops.length, 0),
      offlineQueued: this.connected && this.welcome ? 0 : Math.max(this.offlineQueued, dirty),
      unavailableSince: this.unavailableSince,
      lastReject: this.lastReject,
      now: this.now(),
    }
    const next = computeSaveStatus(inputs)
    if (
      next.state === this.lastSave.state &&
      next.pending === this.lastSave.pending &&
      next.offlineChanges === this.lastSave.offlineChanges &&
      next.lastReject?.id === this.lastSave.lastReject?.id &&
      next.lastReject?.code === this.lastSave.lastReject?.code
    )
      return
    this.lastSave = next
    for (const l of [...this.saveListeners]) l(next)
  }
}
