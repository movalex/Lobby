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
 *    and versionNonce included), so a quiet client's map hashes equal to the server's (hash.ts); the one
 *    local value kept on it is an image's derivative suffix (`ver_X@display`, E9, CR-W5-3G-3), which the
 *    hash, every push and the offline queue strip;
 *  - remote changes are applied with the gesture hold-back of §2.5.4; the text editor holds back only the
 *    edited label's `text` and `layout`;
 *  - text and layout of a text element are pushed only while this tab holds its lease, or when nobody
 *    holds it and this tab asked for nothing (programmatic writes); while this tab's request is pending
 *    they wait (the New element rule, the guard's step 3); held by someone else they are reset at once;
 *  - Saved (§2.5.7): nothing dirty, nothing in flight, nothing queued offline, and every push acked;
 *    and nothing in the live scene the core has not scanned yet (see below);
 *  - the core never installs, pushes or persists over a scene it has not scanned (spike B part 3):
 *    Excalidraw holds a write at once (`updateScene`, `mutateElement`) but reports it through `onChange`
 *    only after React commits, so every entry point that acts on the scene (a server message, a flush, a
 *    persist, an offline adoption) first scans the live scene when it holds versions the core has not
 *    seen (`syncLive`). Before this, a `changes` or `ack` frame handled in that window rebuilt the scene
 *    from the last scan and dropped the write: lost with Saved showing (M3's B7 mood board, B9, wave 2's
 *    burst);
 *  - a remote change a gesture holds back (§2.5.4) is not a local change: a group the server changed
 *    while held (`heldRemote`) counts as local only if the user changed it too, so the gesture's end
 *    pushes only what the user changed (wave 2's drag-recolour overwrite);
 *  - the offline queue is written as soon as a change is known (outside a gesture), and `persistNow()`
 *    (the page's pagehide) writes it at once: no 100 ms window in which a reload loses a change;
 *  - `message` events are emitted after the core applied the message (its roster, lease table, document
 *    and confirmed copies are the new ones when a listener reads them).
 *
 * NODE-SAFE (CONTRACTS.md): explicit `.ts` extensions, no DOM, injectable timers and clock.
 */
import { isRedactedTombstone } from '@draftroom/canvas-schema/elements'
import { compareArrowChange } from '@draftroom/canvas-schema/groups'
import { TOMBSTONE_KEYS } from '@draftroom/canvas-schema/hash'
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
  MAX_RECEIPT_IDS,
  type Op,
  PROTO,
  type PresenceIn,
  RECEIPTS_REV,
  REJECT_CODE_INFO,
  type Receipts,
  type RejectCode,
  type RosterEntry,
  type ServerMessage,
  type ServerOp,
  type SnapshotFrame,
  type Welcome,
} from '@draftroom/canvas-schema/protocol'
import { generateNKeysBetween } from '@excalidraw/fractional-indexing'
import { compareIndexThenId, indexPrePass, isValidKey } from '../index-keys.ts'
import type {
  EngineCore,
  EngineCoreOptions,
  GestureState,
  LeaseConnect,
  LostDocRecord,
  LostPushRecord,
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
  keepLocalFileSuffix,
  opId,
  toWire,
  withoutArtifacts,
  withWireFile,
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
  /**
   * The server clock this change was made on (a replay's): the base of the push that replays it, so the
   * room's rules that read a push's base see the change's age (§2.4.3 step 8, STALE; the fit). Before,
   * every replay went out on the post-welcome clock and STALE could never fire (V1 N17)
   */
  baseClock?: number
  /**
   * The server clock at which this tab had the element's copy (an adopted offline entry's `base`): a
   * change to an element a reset snapshot older than that lacks waits for the catch-up behind it
   */
  knownAt?: number
  /** the element was a leased free text's own fit (its `fit` carries x, y only) */
  freeTextFit?: boolean
  /**
   * The lease id whose grant this text change needs: it was made in an editor this tab opened without a
   * granted lease (a guard-caught open, the open-time re-measure of §2.9.2 step 3). Pushed only once that
   * lease is granted; reset when the editor closes without it.
   */
  needsLease?: string
}

interface Sent {
  groups: Set<GroupKey>
  el: SceneElement
  create: boolean
  ref?: SceneElement
  /** a patch's `pv`: the server version it was built on (the lost-push decision counts writes since) */
  pv?: number
  /**
   * a patch's: the seqs of every push of this tab still in flight when it was built (`ref` holds the values
   * of those carrying the element; `pv` does not hold their version bumps). The lost-push decision reads
   * their acks (`ackedVersion`), so this tab's own landed pushes are never counted as other users' writes.
   * Every flying push, not only those carrying the element: a push that moves a box re-snaps the arrow
   * bound to it on the server (a derived write, `ack.derived`), which bumps the arrow's version with no op
   * of ours for it (V1 re-check round 4, L7)
   */
  ahead?: readonly number[]
  /** a create's: the server copy it was made over (a tombstone it undeletes), or none (a new id) */
  prior?: SceneElement
  /**
   * This push's fit was given up when another user's position (or container size) write reached this
   * client before its ack (`placedByOther`): the server drops it, and its shift was already redone on the
   * new position, so its `fitDropped` asks for nothing more
   */
  fitSuperseded?: boolean
}

/** What an acked push left on the server for one element: its version, and the fields the server rewrote. */
interface AckedVersion {
  readonly v: number
  readonly fix?: Readonly<Record<string, unknown>>
}

interface Inflight {
  readonly seq: number
  readonly base: number
  readonly ops: Op[]
  readonly record: PushRecord
  /**
   * per element: the groups this push carries, the local copy they were taken from, and `ref`: the copy
   * the patch was computed against (base: the server copy plus earlier pushes in flight)
   */
  readonly sent: Map<string, Sent>
  readonly forced: boolean
  /**
   * The socket it went out on (`<tab>:<welcome count>`). One socket is one FIFO: the room received a
   * prefix of its pushes, which the lost-push decision relies on (replayLost)
   */
  readonly src: string
  /**
   * CONTRACTS_REV 11 (W5-ENG-2): its receipt id, when it went out on a socket whose room speaks rev 11: the
   * room records it with the push's COMMIT, and a lost push's fate is asked for by it (`receipts`)
   */
  readonly rid?: string
}

interface Held {
  /** the targets whose pending change keeps this derived arrow change on screen */
  readonly targets: readonly string[]
  /** a label held with its arrow */
  readonly arrow?: string
}

/** What the core reports besides the frozen interface (the adapter, presence, the board page use it). */
export type CoreEvent =
  /**
   * a server message, AFTER the core applied it: `roster()`, `leaseHolders()`, `doc()`, `confirmed()` and
   * the scene already hold its effect (the events the apply caused, `applied`, `reject`, `refit`, came
   * first). A reset welcome is reported before its snapshot frame arrives
   */
  | { kind: 'message'; message: ServerMessage }
  | { kind: 'push'; record: PushRecord; ids: readonly string[] }
  /** the server dropped a conditional fit of this container (or free text): the holder re-fits (§2.9.4 rule 4) */
  /**
   * an ack's `fitDropped` (§2.9.4 rule 4): the holder re-fits on the server's position. For a leased
   * FREE text, `dx`/`dy` are the shift the dropped fit carried (its own growth: a centred text moves
   * left by half of it), to re-apply on the new position; a container re-runs its layout instead
   */
  | { kind: 'refit'; id: string; dx?: number; dy?: number }
  /** a non-retryable reject (Change not saved, with the reason) */
  | { kind: 'reject'; id: string; code: RejectCode }
  /**
   * groups of a push lost with the socket (or the page) whose fate the server copy cannot tell, so the
   * server's copy stands (replayLost): the user is told (Change not saved), the change is not dropped silently
   */
  | { kind: 'superseded'; id: string; groups: readonly GroupKey[] }
  /** elements the core just installed in the scene (changed ids), with the copies before */
  | { kind: 'applied'; ids: readonly string[]; before: ReadonlyMap<string, SceneElement | undefined> }
  | { kind: 'transport'; state: TransportState; close?: TransportClose }
  | { kind: 'welcome'; welcome: Welcome }
  | { kind: 'echo_suspect'; ids: readonly string[] }

const now0 = () => Date.now()

/**
 * The per-key board-document clock of a welcome or a snapshot frame (CONTRACTS_REV 9, W4B-1, the contracts
 * owner's half of CR-W5-FIX-2: `docClocks`, per key the clock of the write that last set or removed it,
 * `lb_doc.clock`). Read loosely, so this core builds with a `protocol.ts` before or after rev 9: a frame
 * without it gives null, and the lost-doc decision then counts values alone, as before.
 */
export function docClockOf(frame: Welcome | SnapshotFrame): Record<string, number> | null {
  const raw = (frame as unknown as { docClocks?: unknown }).docClocks
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  return out
}

/**
 * Whether the latest lost write of one board-document key goes again (LobbyEngineCore.decideLostDoc has
 * the rule): `chain` is every lost write that set the key, in send order; `docClock` the server's per-key
 * clock as of the welcome (null: not known); `now` the server's value (null: none). Called when the
 * server does not hold the value sent last. Pure.
 */
export function decideLostDocKey(
  chain: readonly LostDocRecord[],
  docClock: Readonly<Record<string, number>> | null,
  now: unknown,
): boolean {
  const key = Object.keys(chain[chain.length - 1]?.set ?? {})[0]
  if (docClock && chain.every((r) => r.clock !== undefined)) {
    const k = key as string
    const since = docClock[k]
    // a write of ours that lands gets a clock above everything the room had given out when it was sent,
    // so a key whose clock is not past a lost write's base was written by nobody from that write on. The
    // base counts from past this tab's own earlier writes of the key that landed before the cut (`clocks`):
    // the first of two writes within one round trip landing is ours, not another user's (V1 round 6, DB1)
    return chain.some((r) => since === undefined || since <= Math.max(r.clock as number, r.clocks?.[k] ?? 0))
  }
  // no per-key clock: the server at a value this chain started from or passed through means the later
  // writes did not land (a value set back by someone else reads the same way: V1 R9, accepted here)
  const k = key as string
  const earlier = [chain[0]?.base[k] ?? null, ...chain.slice(0, -1).map((r) => r.set[k] ?? null)]
  return earlier.some((v) => deepEqual(now, v))
}

/**
 * The offline queue's entry for board-document writes (`setDoc`) not acked yet: `OfflineEntry` is an
 * element entry, so they travel as one pseudo-element whose id no element can have (ids are
 * `[A-Za-z0-9_.:-]`), `{id, type, set}`, group `doc`. Adopted into the next push's `doc`, never the scene.
 */
export const DOC_ENTRY_ID = '#doc'
function docEntry(set: Record<string, unknown>, base: number, at: number): OfflineEntry {
  const element = {
    id: DOC_ENTRY_ID,
    type: 'lobby-doc',
    version: 0,
    versionNonce: 0,
    index: null,
    isDeleted: false,
    set: structuredClone(set),
  }
  return { element: element as unknown as SceneElement, groups: ['doc'], base, queuedAt: at }
}
/** How long changes to elements a stale reset snapshot lacked wait for its catch-up (see awaitingCatchUp). */
export const CATCH_UP_WAIT_MS = 3000
/**
 * How long lost pushes wait for the room's receipts answer (CONTRACTS_REV 11) before they are decided by
 * counting the writes since, as before rev 11 (the answer is one round trip and one COMMIT away).
 */
export const RECEIPTS_WAIT_MS = 5000

/**
 * A lost board-document write whose push's fate its receipt tells (CONTRACTS_REV 11, W5-ENG-2): it never
 * landed, so the latest value goes again ('again'; the doc counterpart of an element's unlanded group); or
 * it landed at `landedAt` and the server's value differs from it: a later write by someone else stands and
 * the person is told ('superseded'), unless the key was not written after ours ('quiet': the server's
 * value is what our write left). Pure.
 */
export function decideLostDocByReceipt(
  fate: number | false,
  keyClock: number | undefined,
): 'again' | 'superseded' | 'quiet' {
  if (fate === false) return 'again'
  return keyClock !== undefined && keyClock === fate ? 'quiet' : 'superseded'
}
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
/** A `lobby.*` performance measure (§8.4's client numbers; O3's facade reads and clears them). */
function measure(name: string, start: number): void {
  // opt-in (the spike board page sets it): user-timing entries accumulate until someone clears them, so
  // headless clients (200 in a load run) never record them
  if (!(globalThis as { LOBBY_MEASURE?: boolean }).LOBBY_MEASURE) return
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return
  try {
    performance.measure(name, { start, end: nowMs() })
  } catch {
    // a runtime without user timing: no number
  }
}
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
/** An arrow with at least one bound end. */
const bound = (el: SceneElement): boolean =>
  bindingTarget(el, 'startBinding') !== null || bindingTarget(el, 'endBinding') !== null

/** Lease-gated groups of a text element (§2.9.4: what the lease protects). */
const LEASED_GROUPS: ReadonlySet<GroupKey> = new Set<GroupKey>(['text', 'layout', 'life'])

/** One lost push's part for one element, as `decideLostElement` reads it. */
export interface LostPart {
  /**
   * `landed` (CONTRACTS_REV 11, W5-ENG-2): the push's fate as its receipt tells it (true: committed; false:
   * never committed); absent when unknown (no receipt id, a room before rev 11, a trimmed receipt)
   */
  readonly p: { readonly src: string; readonly landed?: boolean }
  readonly s: {
    readonly groups: ReadonlySet<GroupKey>
    readonly el: SceneElement
    readonly create: boolean
    readonly ref?: SceneElement
    readonly pv?: number
    readonly prior?: SceneElement
  }
}

/**
 * A tombstone as the server sends it since CONTRACTS_REV 7 (W5-02: `redactTombstone`, no content) over
 * the copy this client already holds: only its TOMBSTONE_KEYS are authoritative (hash.ts), so the content
 * this client saw live stays under it. An undo of this tab's own delete then revives the element where it
 * was, with its words, at once (the server's full `c` op of the undelete follows one round trip later).
 */
export function keepTombstoneContent(had: SceneElement | undefined, next: SceneElement): SceneElement {
  if (!had || next.isDeleted !== true || had.type !== next.type) return next
  if (!isRedactedTombstone(next as never)) return next
  const out: Record<string, unknown> = clone(had) as Record<string, unknown>
  for (const k of TOMBSTONE_KEYS) out[k] = (next as Record<string, unknown>)[k]
  return out as SceneElement
}

const sameGroup = (a: SceneElement, b: SceneElement, g: GroupKey): boolean =>
  g === 'fit' ? FIT_FIELDS.every((f) => deepEqual(a[f], b[f])) : !diffGroups(a, b).groups.has(g)

/**
 * The lost-push decision for one element (LobbyEngineCore.replayLost has the rule): `list` is every lost
 * push carrying it, in send order; `conf` the server copy now; `dirty` the groups changed again since.
 * Returns the groups that go again, whether its create goes again, and the groups whose fate cannot be told
 * (the server's copy stands; the user is told). Pure.
 */
export function decideLostElement(
  list: readonly LostPart[],
  conf: SceneElement | undefined,
  dirty: ReadonlySet<GroupKey>,
): { again: Set<GroupKey>; recreate: boolean; superseded: GroupKey[] } {
  const again = new Set<GroupKey>()
  const superseded: GroupKey[] = []
  const lastOf = (g: GroupKey, from: readonly LostPart[]) =>
    [...from].reverse().find((x) => x.s.groups.has(g))
  const createAt = list.findIndex((x) => x.s.create)
  if (createAt >= 0) {
    const prior = list[createAt]?.s.prior
    // a new id: landed if the server has it; an undelete: landed unless the tombstone is untouched
    const landed = !!conf && (!prior || !conf.isDeleted || conf.version !== prior.version)
    if (!landed) {
      if (!conf) return { again, recreate: true, superseded }
      for (const g of list[createAt]?.s.groups ?? []) again.add(g)
      return { again, recreate: false, superseded }
    }
    // the create landed (the server sets a create's version, so no counting after it): what came after it
    // stands where the server does not hold it
    const after = list.slice(createAt + 1)
    const groups = new Set<GroupKey>()
    for (const x of after) for (const g of x.s.groups) groups.add(g)
    for (const g of groups) {
      if (dirty.has(g)) continue
      const last = lastOf(g, after)
      if (last && !sameGroup(conf as SceneElement, last.s.el, g)) superseded.push(g)
    }
    return { again, recreate: false, superseded }
  }
  if (!conf) return { again, recreate: false, superseded } // gone from the server (purged): nothing to say
  // groups the server does not hold at their last lost value
  const all = new Set<GroupKey>()
  for (const x of list) for (const g of x.s.groups) all.add(g)
  const open = [...all].filter((g) => {
    if (dirty.has(g)) return false
    const last = lastOf(g, list)
    return !!last && !sameGroup(conf, last.s.el, g)
  })
  if (!open.length) return { again, recreate: false, superseded }
  const first = list[0] as LostPart
  const P = first.s.pv ?? first.s.ref?.version
  // CONTRACTS_REV 11 (W5-ENG-2): every open group's last lost write has a known fate (its push's receipt).
  // Never landed: it goes again (an offline change, whatever the server copy holds). Landed: the server's
  // copy stands; the person is told unless nobody else wrote the element since (its version moved by at
  // most our landed pushes: the difference is the server's own form of our write, a fix)
  const lastAt = (g: GroupKey) => {
    for (let i = list.length - 1; i >= 0; i--) if (list[i]?.s.groups.has(g)) return i
    return -1
  }
  if (open.every((g) => list[lastAt(g)]?.p.landed !== undefined)) {
    const known = list.every((x) => x.p.landed !== undefined)
    const ours = list.filter((x) => x.p.landed === true).length
    const quiet = known && P !== undefined && conf.version - P <= ours
    for (const g of open) {
      if (list[lastAt(g)]?.p.landed === false) again.add(g)
      else if (!quiet) superseded.push(g)
    }
    return { again, recreate: false, superseded }
  }
  if (new Set(list.map((x) => x.p.src)).size > 1 || P === undefined || !first.s.ref) {
    // pushes of several sockets (two tabs' queues), or no version to count from: not decidable
    return { again, recreate: false, superseded: open }
  }
  const n = conf.version - P
  const k = list.length
  // the server copy after the first j lost pushes of this element and no other write
  const after = (j: number): SceneElement => {
    let el = first.s.ref as SceneElement
    for (const x of list.slice(0, j)) el = copyGroups(el, x.s.el, x.s.groups)
    return el
  }
  const possible: number[] = []
  for (let j = 0; j <= k; j++) {
    const others = n - j
    if (others < 0) continue
    if (others === 0 && diffGroups(conf, after(j)).groups.size > 0) continue
    // a known fate (CONTRACTS_REV 11) rules out the prefixes it contradicts: the first j landed, the rest not
    if (list.some((x, i) => (i < j ? x.p.landed === false : x.p.landed === true))) continue
    possible.push(j)
  }
  if (!possible.length) return { again, recreate: false, superseded: open }
  for (const g of open) {
    const unlanded = possible.every((j) => list.slice(j).some((x) => x.s.groups.has(g)))
    if (unlanded) again.add(g)
    else superseded.push(g)
  }
  return { again, recreate: false, superseded }
}

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
  private serverDoc: Record<string, unknown> = {}
  /**
   * Per board-document key, the clock of the write that last set or removed it on the server: the
   * welcome's `docClocks` (CONTRACTS_REV 9, W4B-1; a room without it leaves this null and the lost-doc
   * decision falls back to values alone), advanced by every `changes` batch that carries the key. Read by
   * `decideLostDoc`: a key whose clock is not past a lost write's base was not written by anyone since, so
   * that write did not land and goes again; otherwise the server's value stands unless it is the one we
   * sent (V1 R9, the doc-key ABA: a value set back by someone else read as "did not land" and was
   * overwritten).
   */
  private serverDocClock: Record<string, number> | null = null
  /** doc writes of this client not sent yet (setDoc), and sent but not acked: overlaid on the server copy */
  private pendingDoc: Record<string, unknown> = {}
  private readonly inflightDoc = new Map<number, Record<string, unknown>>()
  /** per doc write in flight: the values its keys replaced (what the server had or would have), null for none */
  private readonly inflightDocBase = new Map<number, Record<string, unknown>>()
  /** per doc write in flight: the push's base clock (what this tab had seen of the server when it was built) */
  private readonly inflightDocClock = new Map<number, number>()
  /**
   * per doc write in flight: the seqs of this tab's pushes in flight when it was built (`Sent.ahead`'s
   * counterpart for the board document). Two writes of one key within one round trip go out on the same
   * base clock; the first one's landing bumps the key's clock with no other user involved, and the lost-doc
   * decision read it as another user's write (V1 round 6, DB1): the second write was dropped as superseded
   * and the page told the user someone else had changed the setting
   */
  private readonly inflightDocAhead = new Map<number, readonly number[]>()
  /**
   * Per acked push that wrote board-document keys: the clock the room gave it (`ack.clock`, the batch's: the
   * `lb_doc.clock` of the keys it wrote) and those keys, kept while a doc write still in flight was built
   * behind it (`inflightDocAhead`). Read by `ownDocClockAhead` when that later write is lost: its base is
   * lifted to the own write's landing, so only a write past it counts as another user's.
   */
  private readonly ackedDocClock = new Map<number, { clock: number; keys: readonly string[] }>()
  /**
   * Doc writes lost with a socket (or a closed page: the offline queue's `lostDoc`) whose fate is not
   * decided yet: decided with the lost pushes (decideLostDoc), overlaid on the server copy until then
   */
  private lostDoc: LostDocRecord[] = []
  /** the welcomes so far: the socket generation pushes record as their `src` */
  private welcomes = 0
  /** pushes of another page's queue (OfflineEntry.lost), by `<src>#<seq>`: decided like this page's lost pushes */
  private readonly adoptedLost = new Map<string, Inflight>()
  private adoptedSeq = 0
  /** when the last reset snapshot was processed, until its catch-up (`changes`) arrives */
  private resetAt: number | null = null
  private readonly holders = new Map<string, LeaseHolder>()
  private readonly rosterMap = new Map<string, RosterEntry>()
  private awaitingSnapshot = false
  private resyncing = false
  private connected = false
  private terminal: TransportClose | null = null

  // ---- local state
  private readonly tracked = new Map<string, Tracked>()
  private inflight: Inflight[] = []
  /**
   * Per acked push (seq): the server version of each element it wrote (`AckResult.v`) or made the server
   * re-snap (`ack.derived`: a bound arrow following its moved target, a label following its arrow, a
   * frame follower), kept while a push in flight was built behind it (`Sent.ahead`). A lost push's `pv`
   * lags the acks of this tab's own earlier pushes, and the lost-push decision counted their bumps as other
   * users' writes: a push lost behind two acked nudges read as "superseded" and was dropped (V1 re-check
   * round 3, L0-L5); a recolour of a bound arrow lost behind two moves of its box read the same way, and
   * told the user someone else had changed it (round 4, L7). With the version, the fields the server
   * rewrote (`fix`): a lost push's `ref` plus those is the server copy after this tab's pushes ahead, which
   * the decision compares the server copy against ("ours landed and nobody wrote after").
   */
  private readonly ackedVersion = new Map<number, Map<string, AckedVersion>>()
  private readonly held = new Map<string, Held>()
  private readonly known = new Map<string, { v: number; vn: number }>()
  private last = new Map<string, SceneElement>()
  /** ids to drop from the scene at the next apply (a rejected create, a local-only label never pushed) */
  private readonly vanish = new Set<string>()
  /** remote changes waiting for the gesture that holds their element (§2.5.4) */
  private readonly heldBack = new Set<string>()
  /**
   * Per element a gesture holds back (§2.5.4): `before`, the base (`base(id)`) its scene copy was built
   * from when the first held server change arrived, and `groups`, the groups the server changed since.
   * Until the gesture ends such a group is a local change only if the scene copy differs from `before`
   * in it (the user changed it too), so the remote values the scene does not show yet are never pushed
   * back as local ones (wave 2: a drag's pointer-up pushed the old colour over B's recolour).
   */
  private readonly heldRemote = new Map<string, { before: SceneElement; groups: Set<GroupKey> }>()
  /** a scan is running (the live-scene sync never re-enters it) */
  private scanning = false
  /** what the last offline-queue write held (ids, versions, groups), to skip identical writes */
  private persistedSig: string | null = null
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
  /** what the last offline-queue write held, counted as changes (`changeItems`: a label with its container) */
  private offlineQueuedItems = 0
  /**
   * Queued entries loaded from the offline store before a welcome (and its snapshot) was processed: adopted
   * in afterWelcome, once the server's copies are known, so an adopted copy is rebased on them and put in
   * the scene there (adopted earlier, the next scan dropped it from the scene, and a create queued offline
   * was then never pushed)
   */
  private pendingAdopt: OfflineEntry[] | null = null
  private persistTimer: unknown = null
  /**
   * Changes (not creates) to elements a reset snapshot lacked although this tab knew them at a later
   * clock: the room serves a cached snapshot (5 s) and sends the rows since it right after as `changes`,
   * so they wait for that frame instead of being dropped (spike B part 3, D7: a reload within 5 s of a
   * create lost the queued edits of that element). Resolved at the next `changes` frame, or dropped
   * after `CATCH_UP_WAIT_MS` when none comes.
   */
  private readonly awaitingCatchUp = new Set<string>()
  private catchUpTimer: unknown = null
  /** the last welcome changed the epoch (a restore): nothing from before it waits for a catch-up */
  private epochReset = false
  /** the queue the previous page left is loaded (or there is none): writes may replace it now */
  private offlineLoaded = false
  /** a write was asked for before that */
  private persistAfterLoad = false
  /**
   * Pushes lost with a socket whose fate a reset snapshot cannot tell yet (a cached snapshot may be older
   * than their commit; its catch-up follows as `changes`): they count as in flight (their values stay in
   * the scene, nothing of them is pushed, Saved waits) until that frame, or CATCH_UP_WAIT_MS, decides
   * each group (replayLost)
   */
  private lostHeld: Inflight[] = []
  private lostTimer: unknown = null
  /**
   * What the lost pushes held in `lostHeld` (and the lost doc writes) wait for before they are decided: a
   * reset snapshot's catch-up (`catchUp`), and (CONTRACTS_REV 11, W5-ENG-2) the room's answer on which of
   * their receipts landed (`receipts`: 'contracts' until this socket's room says its revision, then
   * 'asked' while the queries in `asked` are out). Null: nothing is held.
   */
  private lostGate: {
    catchUp: boolean
    receipts: 'contracts' | 'asked' | null
    readonly asked: Map<number, readonly string[]>
  } | null = null
  /** CONTRACTS_REV 11: the revision this socket's room announced (its `contracts` frame); null until then */
  private roomRev: number | null = null
  /** this page's receipt id prefix (CONTRACTS_REV 11): a push's id is `<prefix><seq>`, unique per page */
  private readonly ridPrefix =
    `${Math.random().toString(36).slice(2, 10) || 'p'}${Date.now().toString(36).slice(-4)}.`
  private receiptsReq = 0
  /** what the room's receipts answers told (CONTRACTS_REV 11): rid → the clock its push landed at, or false */
  private readonly receiptFate = new Map<string, number | false>()
  /** per rid asked: its push's base (an absence is conclusive when base + 1 >= the answer's `from`) */
  private readonly receiptBase = new Map<string, number>()
  /** unsent text outside the scene (keys buffered in an editor that waits for its lease, §2.5.7) */
  private readonly outside = new Set<string>()

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
    for (const t of [
      this.flushTimer,
      this.retryTimer,
      this.presenceTimer,
      this.persistTimer,
      this.catchUpTimer,
      this.lostTimer,
    ])
      if (t !== null) this.clearTimer(t)
    this.flushTimer = this.retryTimer = this.presenceTimer = this.persistTimer = this.catchUpTimer = null
    this.lostTimer = null
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
      // lost pushes held for a receipts answer wait for the next welcome, which asks again (not decided by
      // counting while no answer can come)
      if (this.lostGate?.receipts && this.lostTimer !== null) {
        this.clearTimer(this.lostTimer)
        this.lostTimer = null
      }
      // an acquire sent and never answered went with the socket (a failed COMMIT answers no lease message
      // of its batch, V1 N7): it is asked again after the next welcome, with its request number
      for (const [req, id] of this.leaseReq)
        if (
          this.leasePending.has(id) &&
          !this.queuedLease.some((m) => m.type === 'lease.acquire' && m.req === req)
        )
          this.queuedLease.push({ type: 'lease.acquire', req, id })
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
      // a local-only element that is not being created (one deleted before it was ever pushed) is not
      // part of the board
      if (
        !this.confirmedMap.has(id) &&
        !this.inflightHas(id) &&
        (!this.tracked.get(id)?.isNew || el.isDeleted)
      )
        continue
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

  /**
   * Saved as the core computes it, and never "saved" while the live scene holds a write the core has not
   * scanned yet (Excalidraw's `onChange` comes after React's commit): read-only, it reports that write as
   * pending (the scan that follows counts it properly). Listeners get the change at that scan.
   */
  get saveStatus(): SaveStatus {
    if (this.scanning || this.stopped) return this.lastSave
    if (!this.unseen(this.scene.read().elements)) return this.lastSave
    const pending = this.lastSave.pending + 1
    const online = this.lastSave.state !== 'offline'
    return {
      ...this.lastSave,
      state: online ? (this.lastSave.state === 'retrying' ? 'retrying' : 'saving') : 'offline',
      pending,
      offlineChanges: online ? this.lastSave.offlineChanges : this.lastSave.offlineChanges + 1,
    }
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
    return this.serverDoc
  }

  /**
   * The board document (`lb_doc`) as this client sees it: the server's copy (welcome, then every
   * `changes` batch's `doc`), overlaid with this client's writes not acked yet (O5's CR on EngineCore).
   */
  doc(): ReadonlyMap<string, unknown> {
    const out = new Map<string, unknown>(Object.entries(this.serverDoc))
    const overlay = (set: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(set)) {
        if (v === null) out.delete(k)
        else out.set(k, v)
      }
    }
    for (const r of this.lostDoc) overlay(r.set)
    for (const set of this.inflightDoc.values()) overlay(set)
    overlay(this.pendingDoc)
    return out
  }

  /**
   * Writes board-document keys (null removes one) as a push's `doc: {set}`, ordered with this client's
   * element pushes: it goes out in the next push, so a doc write made before an element edit is sent no
   * later than it (O5's tags: `tagDef:<key>` before the element's `tag:<key>`).
   */
  setDoc(set: Readonly<Record<string, unknown>>): void {
    for (const [k, v] of Object.entries(set)) this.pendingDoc[k] = v === undefined ? null : clone(v)
    this.scheduleFlush(true)
    this.updateSaved()
  }

  /**
   * Unsent text that is not in the scene yet keeps Saved away (§2.5.7 "no open text editor with unsent
   * text"): the page sets `key` while an editor waiting for its lease holds buffered keys, and clears it
   * when they are replayed or dropped (V1 P1: Saved showed while the keys were only in EditorLease).
   */
  holdSaved(key: string, on: boolean): void {
    const had = this.outside.has(key)
    if (on) this.outside.add(key)
    else this.outside.delete(key)
    if (had !== on) this.updateSaved()
  }

  /**
   * CR-2D-2 (wave 2D: template scenes, paste as notes; the canvas API's `LobbyTx.insert`): prepared
   * elements as new elements of this tab, exactly as given. Returns the copies to install; the caller
   * installs them with its own scene write (CanvasPort.transact's `tx.insert` does, so the insert is one
   * undo step with the rest of its transaction). `insert()` below does both through the core's scene.
   *
   *  - Every field is kept as given (nothing is rebuilt through the note or text tools: `frameId`, colours,
   *    a label's size, ink and position stay), except `index`: the copies get fresh keys above `above`
   *    (default: the top of the scene) in the given order, so each label stays above its container. The
   *    server assigns the final keys (§2.4.3 step 11 keeps these unless they collide, e.g. with another
   *    tab's insert at the same moment, and puts labels after their containers); its `changes` copy and
   *    the ack's `fix` bring them back.
   *  - `version` and `versionNonce` are kept when given (the server sets a create's version anyway);
   *    missing ones become 1 and a fresh nonce.
   *  - Ids are kept. The batch is refused whole (an Error, nothing to install) when this session is
   *    read-only, or an element has no string `id` or `type`, is deleted, repeats an id of the batch, or
   *    has an id the scene or the server already has, live or deleted (re-id a template to insert it
   *    twice).
   *  - Once installed, the next scan finds them as local creates: each is pushed whole (`{k: 'c'}`) and
   *    validated by the server as any create (schema, invariants, caps, locks, leases); a refused one
   *    leaves the scene with "Change not saved", as any refused create.
   */
  prepareInsert(
    elements: readonly Readonly<Record<string, unknown>>[],
    above?: string | null,
  ): SceneElement[] {
    if (this.readonly) throw new Error('insert: read-only session, no writes')
    const live = this.scene.read().elements
    const inScene = new Set(live.map((e) => e.id))
    const seen = new Set<string>()
    for (const [i, el] of elements.entries()) {
      const id = el.id
      if (typeof id !== 'string' || !id || typeof el.type !== 'string')
        throw new Error(`insert: element ${i} has no id or type`)
      if (el.isDeleted === true) throw new Error(`insert: ${id} is deleted`)
      if (seen.has(id)) throw new Error(`insert: ${id} twice in the batch`)
      if (inScene.has(id) || this.confirmedMap.has(id) || this.current.has(id))
        throw new Error(`insert: ${id} exists on this board`)
      seen.add(id)
    }
    let lo: string | null = above === undefined ? null : above
    if (above === undefined)
      for (const el of live)
        if (isValidKey(el.index) && (lo === null || (el.index as string) > lo)) lo = el.index
    const keys = elements.length ? generateNKeysBetween(lo, null, elements.length) : []
    return elements.map((el, i) => {
      const out: Record<string, unknown> = clone(el as SceneElement) as Record<string, unknown>
      out.index = keys[i]
      out.isDeleted = false
      if (typeof out.version !== 'number' || out.version < 1) out.version = 1
      if (typeof out.versionNonce !== 'number') out.versionNonce = Math.floor(Math.random() * 2 ** 31)
      return out as SceneElement
    })
  }

  /**
   * `prepareInsert` installed through the core's scene and scanned at once (outside any transaction: the
   * history records it as its own step at the next boundary). Returns the ids, in order.
   */
  insert(elements: readonly Readonly<Record<string, unknown>>[]): string[] {
    const copies = this.prepareInsert(elements)
    if (!copies.length) return []
    this.syncLive()
    this.scene.apply([...this.scene.read().elements, ...copies])
    this.syncLive()
    return copies.map((c) => c.id)
  }

  /** The ids this tab asked a lease for and has no answer for yet (O3's facade `leaseState().pending`). */
  pendingLeases(): readonly string[] {
    return [...this.leasePending]
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

  /** Elements with a change not sent yet: dirty groups, or a create that is not in a push (in flight or acknowledged). */
  unsentIds(): string[] {
    return [...this.tracked.entries()]
      .filter(([id, t]) => t.dirty.size > 0 || (t.isNew && !this.inflightHas(id)))
      .map(([id]) => id)
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
    const t0 = nowMs()
    try {
      this.scan(snapshot)
    } finally {
      measure('lobby.onChange', t0)
    }
  }

  /**
   * Scans the live scene now if it holds a write the core has not seen: the call for a writer that
   * installed elements with `updateScene` and should not wait for Excalidraw's `onChange` (CanvasPort's
   * `transact`, undo's install), so Saved and the offline queue know of the write at once. The core
   * also does this itself before it acts on the scene (see the header). Returns whether it scanned.
   */
  syncScene(): boolean {
    return this.syncLive()
  }

  /** Scans the live scene when it differs from what the core last saw (never inside a scan). */
  private syncLive(): boolean {
    if (this.scanning || this.stopped) return false
    const snapshot = this.scene.read()
    if (!this.unseen(snapshot.elements)) return false
    const t0 = nowMs()
    try {
      this.scan(snapshot)
    } finally {
      measure('lobby.onChange', t0)
    }
    return true
  }

  /**
   * The live scene holds an element version the core has not scanned or applied (a write Excalidraw has
   * not reported yet). An empty scene while the core knows elements is a detached host (the page between
   * two mounts), never a write.
   */
  private unseen(elements: readonly SceneElement[]): boolean {
    if (elements.length === 0) return false
    if (elements.length !== this.last.size) return true
    for (const el of elements) {
      const k = this.known.get(el.id)
      if (!k || k.v !== el.version || k.vn !== el.versionNonce) return true
    }
    return false
  }

  private scan(snapshot: SceneSnapshot): void {
    if (this.scanning) return
    this.scanning = true
    try {
      this.scanNow(snapshot)
    } finally {
      this.scanning = false
    }
  }

  private scanNow(snapshot: SceneSnapshot): void {
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
      // classify (above) diffed the gesture's elements against the base they were built from; the
      // rebuild below takes the held remote values from the server's copy
      this.heldRemote.clear()
    }
    const editorClosed = prevEditing !== null && snapshot.gesture.editingTextElementId === null
    // while the editor was open, rebuild() kept the edited label's local copy (its text and layout are
    // held back); an ack that landed meanwhile left nothing to re-examine it after the close, and the
    // submit usually changes nothing. Clean now: the scene must hold the server's copy exactly (B3 L6)
    if (prevEditing !== null && prevEditing !== snapshot.gesture.editingTextElementId)
      this.settleClean(prevEditing, reset)
    if (reset.size) this.applyScene(reset)
    this.scheduleFlush(editorClosed || (wasGesture && !gestureNow))
    this.schedulePersist()
    this.updateSaved()
  }

  /** `id` has nothing dirty, in flight or held: its scene copy goes back to the server's, version included. */
  private settleClean(id: string, reset: Set<string>): void {
    if (this.tracked.has(id) || this.inflightHas(id) || this.held.has(id)) return
    const conf = this.confirmedMap.get(id)
    const el = this.current.get(id)
    if (conf && el && (conf.version !== el.version || conf.versionNonce !== el.versionNonce)) reset.add(id)
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
    for (const p of this.flying()) {
      const s = p.sent.get(id)
      if (!s) continue
      el = s.create || !el ? s.el : copyGroups(el, s.el, s.groups)
    }
    return el
  }

  private inflightHas(id: string): boolean {
    return this.flying().some((p) => p.sent.has(id))
  }

  /** The pushes out without an ack: in flight, and lost ones a reset snapshot could not settle yet (lostHeld). */
  private flying(): Inflight[] {
    return this.lostHeld.length ? [...this.lostHeld, ...this.inflight] : this.inflight
  }

  private inflightGroups(id: string): Set<GroupKey> {
    const out = new Set<GroupKey>()
    for (const p of this.flying()) {
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
        // a local create (or the local copy of an element the server does not know); one deleted before
        // it was ever pushed is nothing to say (it stays out of the board's map, see elements())
        if (el.isDeleted) {
          this.tracked.delete(el.id)
          continue
        }
        const isNew = t?.isNew ?? true
        this.track(el.id, new Set(diffGroups(el, undefined).groups), isNew)
        continue
      }
      // an element a gesture holds back shows the base it was built from, not the remote values that
      // arrived since: those groups are not local changes unless the user changed them too (wave 2: a
      // drag's pointer-up pushed the old colour over B's recolour)
      const diff = diffGroups(el, ref)
      const groups = new Set(diff.groups)
      const held = this.heldRemote.get(el.id)
      if (held) {
        const mine = diffGroups(el, held.before).groups
        for (const g of held.groups) if (!mine.has(g)) groups.delete(g)
      }
      // an arrow whose change moved only its bound ends is DERIVED (§2.5.2, E10): held, never pushed. An
      // arrow bound to nothing has no follow: its change is the user's own (V1, B3 L10 6: an elbow arrow
      // created at its two drawn points, then routed locally, kept only its ends, so its route counted as
      // derived and was never pushed)
      if (el.type === 'arrow' && groups.has('path') && (bound(el) || bound(ref))) {
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
      } else if (el.type === 'arrow' && groups.has('path')) this.held.delete(el.id)
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
    for (const p of this.flying()) for (const id of p.sent.keys()) m.set(id, this.base(id) as SceneElement)
    return m
  }

  private track(id: string, groups: Set<GroupKey>, isNew: boolean): void {
    // an edit made with no socket is replayed from the queue: its ops carry their age (`off`, §2.5.6),
    // and its push the clock it was made on (the last one this tab had: the clock does not move offline)
    const offline = !this.connected || !this.welcome
    const t = this.tracked.get(id)
    if (t && (t.dirty.size > 0 || t.isNew)) {
      t.dirty = groups
      t.isNew = isNew
      // an element already changed online and changed again with no socket is an offline change too
      if (offline && !t.replay) {
        t.replay = true
        t.baseClock = this.clock
      }
      return
    }
    // nothing pending: a fresh change, even over an entry a create's ack left behind (V1 N17: an element
    // created in this session kept its entry with `replay` false, so its later offline edits carried no `off`)
    this.tracked.set(id, {
      ...(t ?? {}),
      dirty: groups,
      isNew,
      since: this.now(),
      replay: offline,
      ...(offline ? { baseClock: this.clock } : { baseClock: undefined }),
    })
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
    if (!local) return conf ? clone(conf) : undefined
    const t = this.tracked.get(id)
    if (!conf) return t?.isNew || this.inflightHas(id) || this.awaitingCatchUp.has(id) ? local : undefined
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
    // the local derivative suffix (`ver_X@display`) is not a change, and not the server's either: it
    // stays while the wire file is the same (E9, CR-W5-3G-3: before, every rebuild put the scene back on
    // the 512 px thumb and the derivative swap never stuck)
    if (groups.size === 0) return keepLocalFileSuffix(clone(conf), local)
    const out = keepLocalFileSuffix(copyGroups(conf, local, groups), local) as Record<string, unknown>
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
        // rebuilt from the current base: nothing held back for it any more
        this.heldRemote.delete(el.id)
        const next = this.rebuild(el.id)
        if (next !== el || !this.known.has(el.id)) {
          before.set(el.id, this.known.has(el.id) ? el : this.last.get(el.id))
          touched.push(el.id)
        }
        put(el.id, next)
        continue
      }
      // an adopted offline copy (adoptOffline) is not in the scene yet: installed, whatever else changed.
      // Before this was explicit, the install waited for the next apply that touched anything, and a
      // flush that read the live scene first took the old copy for the truth (spike B part 3)
      if (!this.known.has(el.id)) {
        before.set(el.id, this.last.get(el.id))
        touched.push(el.id)
      }
      put(el.id, el)
    }
    for (const [id, el] of this.confirmedMap) {
      if (seen.has(id) || this.vanish.has(id)) continue
      before.set(id, undefined)
      touched.push(id)
      put(id, clone(el))
    }
    this.vanish.clear()
    if (touched.length === 0) return
    // this client's to re-key: its own element the server has not acknowledged, and (SYNC-4) a confirmed
    // element whose scene key is this tab's write the server has not confirmed (a create whose `changes`
    // came before its ack, a reorder in flight or unsent). Counted as confirmed, such a key could tie with
    // another confirmed element, and Excalidraw's `syncInvalidIndices` would re-key that element in place
    // (an echo of someone else's element; at 017f76d, B11's one divergence)
    const ownUnacked = (el: SceneElement) => {
      const conf = this.confirmedMap.get(el.id)
      if (!conf) return !!this.tracked.get(el.id)?.isNew || this.inflightHas(el.id)
      return (
        el.index !== conf.index &&
        (!!this.tracked.get(el.id)?.dirty.has('z') || this.inflightGroups(el.id).has('z'))
      )
    }
    // the index pre-pass (E2, E3), skipped when this client has no unacknowledged element of its own
    // (§2.5.4); the array is then only sorted by (index, id)
    const t0 = nowMs()
    let next: SceneElement[]
    if (out.some(ownUnacked)) {
      const pre = indexPrePass(out, {
        isOwnUnacked: ownUnacked,
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
      next = pre.elements
    } else next = out.sort(compareIndexThenId)
    measure('lobby.prepass', t0)
    const inNext = new Set<string>()
    for (const el of next) {
      inNext.add(el.id)
      this.known.set(el.id, { v: el.version, vn: el.versionNonce })
      this.last.set(el.id, el)
    }
    for (const id of touched)
      if (!inNext.has(id)) {
        this.known.delete(id)
        this.last.delete(id)
      }
    this.readScene(next)
    const t1 = nowMs()
    this.scene.apply(next)
    measure('lobby.updateScene', t1)
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
    // a message that rebuilds or re-classifies the scene first takes in any write Excalidraw holds and has
    // not reported yet (see the header): otherwise the apply below drops it
    if (
      m.type === 'snapshot' ||
      m.type === 'welcome' ||
      m.type === 'changes' ||
      m.type === 'ack' ||
      m.type === 'lease.grant' ||
      m.type === 'lease.deny' ||
      m.type === 'lease'
    )
      this.syncLive()
    if (m.type === 'snapshot') {
      this.onSnapshot(m)
      return
    }
    switch (m.type) {
      case 'welcome':
        this.onWelcome(m)
        break
      case 'changes':
        this.onChanges(m)
        break
      case 'ack':
        this.onAckMessage(m)
        break
      case 'lease.grant':
      case 'lease.deny':
      case 'lease':
        this.onLease(m)
        break
      case 'roster':
        for (const ev of m.events) {
          if (ev.k === 'leave') this.rosterMap.delete(ev.sid)
          else this.rosterMap.set(ev.p.sid, ev.p)
        }
        break
      case 'contracts':
        this.onContracts(m.rev)
        break
      case 'receipts':
        this.onReceipts(m)
        break
      case 'notice':
        if (m.code === 'RESYNC') this.resync()
        if (m.code === 'SLOW_DOWN') this.retryDelay = Math.max(this.retryDelay, 1000)
        break
      default:
        break
    }
    // reported once applied (2C's request): a listener reads the new roster, leases, doc and copies
    if (!this.stopped) this.emit({ kind: 'message', message: m })
  }

  /**
   * Before the server's copies change (`ids`, or every held id): the elements an active gesture holds
   * get their `heldRemote` entry (the base their scene copy was built from, the first time), and their
   * server copies before the change, for `holdRecord`. Null when no gesture runs.
   */
  private holdMark(ids: Iterable<string> | null): Map<string, SceneElement | undefined> | null {
    if (!gestureActive(this.gesture)) return null
    const hold = this.gestureIds()
    const out = new Map<string, SceneElement | undefined>()
    for (const id of ids ?? hold) {
      if (!hold.has(id) || out.has(id)) continue
      if (!this.heldRemote.has(id)) {
        const b = this.base(id)
        if (!b) continue
        this.heldRemote.set(id, { before: clone(b), groups: new Set() })
      }
      out.set(id, this.confirmedMap.get(id))
    }
    return out
  }

  /** After the change: the groups the server changed in each marked element (see heldRemote). */
  private holdRecord(mark: Map<string, SceneElement | undefined> | null): void {
    if (!mark) return
    for (const [id, was] of mark) {
      const now = this.confirmedMap.get(id)
      const held = this.heldRemote.get(id)
      if (!now || !held || now === was) continue
      for (const g of diffGroups(now, was).groups) held.groups.add(g)
    }
  }

  private onWelcome(w: Welcome): void {
    const epochChanged = this.epoch !== null && this.epoch !== w.epoch
    this.epochReset = epochChanged
    this.welcome = w
    this.welcomes++
    // a new socket (or a resync): what its room speaks comes with its `contracts` frame, after this one
    this.roomRev = null
    this.epoch = w.epoch
    this.horizon = w.horizon
    this.serverDoc = { ...w.doc }
    this.serverDocClock = docClockOf(w)
    const before = new Map(this.holders)
    this.holders.clear()
    for (const l of w.leases) this.holders.set(l.id, l.holder)
    this.rosterMap.clear()
    for (const r of w.roster) this.rosterMap.set(r.sid, r)
    // a lease this tab thought it held but the server does not name it for is gone (§2.9.3); its local
    // text, layout and fit are not ours to write any more
    const lost = new Set<string>()
    for (const id of [...this.leaseHeld])
      if (this.holders.get(id)?.sid !== w.sid) {
        this.leaseHeld.delete(id)
        lost.add(id)
      }
    const dropped = new Set<string>()
    for (const id of lost) this.dropLeased(id, dropped)
    // the lease client learns the table as broadcasts: every lease whose holder changed while this tab
    // was away (B3 L7: A held N, went offline, the lease expired and B took it; A's editor then says so)
    for (const id of new Set([...before.keys(), ...this.holders.keys(), ...lost])) {
      const now = this.holders.get(id) ?? null
      if (lost.has(id) || before.get(id)?.sid !== now?.sid)
        this.leaseListener?.({ type: 'lease', id, holder: now })
    }
    if (w.reset) {
      this.awaitingSnapshot = true
      if (epochChanged) this.log('epoch_reset', { epoch: w.epoch })
      return
    }
    const mark = this.holdMark((w.catchUp ?? []).map((op) => (op.k === 'c' ? op.el.id : op.id)))
    for (const op of w.catchUp ?? []) this.applyServerOp(op, new Set())
    this.holdRecord(mark)
    this.clock = w.clock
    this.afterWelcome(null)
    this.emit({ kind: 'welcome', welcome: w })
  }

  private onSnapshot(frame: SnapshotFrame): void {
    if (!this.awaitingSnapshot) {
      this.log('unexpected_snapshot', { clock: frame.clock })
      return
    }
    this.awaitingSnapshot = false
    const mark = this.holdMark(null)
    const had = new Map(this.confirmedMap)
    this.confirmedMap.clear()
    for (const el of frame.elements)
      this.confirmedMap.set(el.id, keepTombstoneContent(had.get(el.id), el as unknown as SceneElement))
    this.holdRecord(mark)
    const before = this.clock
    this.clock = frame.clock
    this.epoch = frame.epoch
    this.horizon = frame.horizon
    // the welcome's board document, not the frame's: the room caches a reset snapshot for 5 s (with the
    // document as it was then) and sends only the element rows since it as `changes`, while the welcome's
    // `doc` is read at the hello. Taking the frame's put a document write of the last 5 s back to its old
    // value for a joiner (DEF-3F-1 = 3b F2: session settings, tags, start view). The same for the per-key
    // clocks: the frame's only when the welcome had none
    this.serverDoc = { ...(this.welcome?.doc ?? frame.doc) }
    if (!this.serverDocClock) this.serverDocClock = docClockOf(frame)
    this.resetAt = this.epochReset ? null : this.now()
    this.afterWelcome(this.epochReset ? null : { snapshotClock: frame.clock, before })
    if (this.welcome) this.emit({ kind: 'welcome', welcome: this.welcome })
  }

  /**
   * After a welcome (catch-up or reset): rebase every local change on the new server state, then push.
   * `reset`: the reset snapshot's clock and this tab's clock before it (null: a catch-up welcome, or an
   * epoch change), for changes to elements the snapshot lacks (see awaitingCatchUp).
   */
  private afterWelcome(reset: { snapshotClock: number; before: number } | null): void {
    this.resyncing = false
    if (this.pendingAdopt) {
      for (const e of this.pendingAdopt) this.adoptOffline(e)
      this.pendingAdopt = null
    }
    // pushes with no ack were lost with the old socket, and an adopted queue's pushes with their page:
    // each group goes again only if it did not land (replayLost); behind a reset snapshot that may
    // predate their commit, that waits for its catch-up
    const lost = [...this.lostHeld, ...this.takeAdopted(), ...this.inflight]
    this.lostHeld = []
    if (this.lostTimer !== null) {
      this.clearTimer(this.lostTimer)
      this.lostTimer = null
    }
    // a new socket: its room is asked again (an answer to the previous one's query will not come)
    this.lostGate = null
    this.receiptFate.clear()
    this.receiptBase.clear()
    this.inflight = []
    // doc writes lost with the socket: decided with the pushes (decideLostDoc), from the clock their push
    // was built at, past this tab's own writes of their keys acked before the cut
    for (const seq of this.inflightDoc.keys()) this.lostDoc.push(this.lostDocRecordOf(seq, lost))
    this.inflightDoc.clear()
    this.inflightDocClock.clear()
    this.inflightDocBase.clear()
    this.inflightDocAhead.clear()
    this.ackedDocClock.clear()
    if (lost.length || this.lostDoc.length) {
      if (this.epochReset) {
        this.replayAll(lost)
        this.replayAllDoc()
      } else {
        // behind a reset snapshot, or with receipts to ask for (CONTRACTS_REV 11): held until decided
        const receipts = this.receiptsPossible(lost)
        if (reset || receipts) this.holdLost(lost, { catchUp: !!reset, receipts })
        else {
          this.replayLost(lost)
          this.decideLostDoc()
        }
      }
    }
    this.awaitingCatchUp.clear()
    for (const [id, t] of [...this.tracked]) {
      if (this.confirmedMap.has(id)) t.isNew = false
      else if (!t.isNew) {
        // the snapshot is older than what this tab knew of the element: its catch-up follows
        const at = t.knownAt ?? reset?.before ?? 0
        if (reset && at > reset.snapshotClock) this.awaitingCatchUp.add(id)
        else this.tracked.delete(id)
      }
    }
    this.armCatchUp()
    // dirty groups equal to the new server copy are not changes any more (a push lost with the socket
    // that had committed): decided BEFORE the rebuild, so those elements become the server copy exactly
    for (const [id, t] of [...this.tracked]) this.settleDirty(id, t)
    this.dropDeadCreates()
    this.held.clear()
    this.heldBack.clear()
    // the whole scene is rebuilt from the new server state and the local changes
    const all = new Set<string>([...this.current.keys(), ...this.confirmedMap.keys()])
    // (an element only a held lost push carries, e.g. an adopted queue's create, waits for its decision)
    for (const id of this.current.keys())
      if (!this.confirmedMap.has(id) && !this.tracked.has(id) && !this.inflightHas(id)) this.vanish.add(id)
    this.applyScene(all)
    // lease messages asked for while disconnected go out now, behind any push
    this.flushNow(true)
    for (const m of this.queuedLease.splice(0)) this.transport.send(m)
    // a lease the server still names this tab for, though this tab released it (offline, or in a batch
    // whose COMMIT failed, V1 N7) or never asked for it (a reload): released now, behind the pushes above,
    // so the editor's final text lands before anyone else can take the lease
    const sid = this.welcome?.sid
    for (const [id, h] of this.holders)
      if (sid && h.sid === sid && !this.leaseHeld.has(id) && !this.leasePending.has(id))
        this.transport.send({ type: 'lease.release', id })
    this.retryDelay = 0
    this.updateSaved()
  }

  /**
   * Pushes lost with a socket (no ack: a network drop, a 4000, a SIGKILL after the COMMIT), or with a page
   * (a reload or a closed tab: the offline queue's `lost` records, adopted): each group goes out again
   * only if it did not land. The room processes one socket's frames in order, so what landed of a socket's
   * lost pushes is a PREFIX of them; and it bumps an element's version once per push that changes it. Per
   * element, with k lost pushes of one socket carrying it (in order), built on server version P, and the
   * server copy now at version P + n:
   *  - a group the server holds at the value the last lost push sent: landed (or written so); nothing to do;
   *  - otherwise each interpretation "the first j of the k landed, and n - j other writes happened" that is
   *    possible (n - j >= 0; with no other write, the server copy must be exactly what those j pushes made)
   *    decides the group: it goes again (it did not land: an offline change, the later arrival wins below
   *    10 minutes, STALE above) when every possible interpretation has a push after the landed prefix that
   *    carries it; when they disagree, the server's copy stands (as before: the write every other screen
   *    already shows; the common case is a push that landed and was edited after).
   * So a push that landed and was overwritten after (V1 N3a, N3b, P4), or set back to the value it replaced
   * (V1's ABA), never overwrites the later write; a push that never reached the server is replayed over a
   * write another user made meanwhile once, as an offline change is (V1's R8). What stays undecidable from
   * the server copy alone (a push that never arrived, then two or more writes by others in the same window)
   * keeps the server's copy; the socket's heartbeat (transport/socket.ts) keeps that window short, and a
   * push id the room deduplicates would close it (a change request to the contracts owner, wave 5).
   * A lost create goes again only when the server has no copy (it never landed), or, for an undelete, still
   * holds the tombstone it was made over (same version); one that landed leaves the rest of its element's
   * lost groups to the server's copy when it does not hold their value. A group the user changed
   * again since it was sent is a new change and goes as usual (it is dirty). Replays carry `off` and their
   * push's base. Before wave 5 the rule was by value only, which the ABA defeated, and it dropped every
   * unlanded push another user had written over (V1 re-check of beff59d).
   */
  private replayLost(lost: readonly Inflight[]): void {
    const byId = new Map<string, { p: Inflight; s: Sent }[]>()
    for (const p of lost)
      for (const [id, s] of p.sent) {
        const list = byId.get(id) ?? []
        list.push({ p, s })
        byId.set(id, list)
      }
    for (const [id, list] of byId) {
      const conf = this.confirmedMap.get(id)
      const t = this.tracked.get(id)
      // the version each part counts from, and the copy it compares against: past this tab's own pushes
      // acked before the cut (effectivePv, effectiveRef)
      const parts: LostPart[] = list.map(({ p, s }) => {
        const landed = this.fateOf(p.rid)
        return { p: { src: p.src, ...(landed !== undefined ? { landed } : {}) }, s: this.settledSent(id, s) }
      })
      const { again, recreate, superseded } = decideLostElement(parts, conf, t?.dirty ?? new Set())
      if (superseded.length) {
        // the server's copy stands and the user is told (the board page's notice): never a silent drop.
        // Not a reject: in the common case the push landed and someone wrote after it, so nothing of this
        // tab's is unsaved, and Saved stays true
        this.log('lost_superseded', { id, groups: superseded })
        this.emit({ kind: 'superseded', id, groups: superseded })
      }
      if (!again.size && !recreate) continue
      const at = (list[0] as { p: Inflight }).p
      const tt: Tracked = t ?? { dirty: new Set<GroupKey>(), isNew: false, since: at.record.at, replay: true }
      for (const g of again) tt.dirty.add(g)
      tt.replay = true
      tt.since = Math.min(tt.since, at.record.at)
      tt.baseClock = Math.min(tt.baseClock ?? at.base, at.base)
      if (recreate) tt.isNew = true
      this.tracked.set(id, tt)
    }
  }

  /** An epoch change (a restore): every lost group is rebased on the restored copy, as any local change. */
  private replayAll(lost: readonly Inflight[]): void {
    for (const p of lost)
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

  /**
   * Lost board-document writes (a socket's, or a closed page's `lostDoc`), per key over the writes that set
   * it (values v1..vk, v0 what the first replaced). The server holds vk: it landed. With the server's
   * per-key clock (`serverDocClock`, the welcome's `docClocks`): a key not written since the base clock of
   * one of the lost writes was written by nobody after that write was built, so it and the later ones did
   * not land and the latest local value goes again (unless the key was written again since); any other
   * value under a later clock is a write that may be another user's (it is, when ours landed and theirs
   * came after: the ABA of V1 R9), so the server's stands and the user is told (`superseded`). A lost
   * write's base counts from past this tab's own earlier writes of the key that were acked before the cut
   * (`LostDocRecord.clocks`, from `inflightDocAhead` / `ackedDocClock`): the first of two writes within one
   * round trip landing is not another user's write (V1 round 6, DB1: the second was dropped as superseded
   * and the user told nobody's lie). Without the clock (an older server): the server holds v0..vk-1, the
   * later writes did not land and the latest local value goes again; anything else is another user's later
   * write, which stands. Before wave 5, every lost key went again unless the server held exactly its value,
   * and a queued key went again whatever the server held (V1 R3, R7: a tag definition another user wrote
   * after was overwritten). Residual (design limit): two writes of one key where the first landed with its
   * ack lost too and the second never arrived (DB2) read as superseded; push receipts (W5-ENG-2) would tell
   * them apart.
   */
  private decideLostDoc(): void {
    const records = this.lostDoc
    this.lostDoc = []
    const keys = new Set<string>()
    for (const r of records) for (const k of Object.keys(r.set)) keys.add(k)
    for (const k of keys) {
      if (k in this.pendingDoc) continue // written again since: that write goes
      const chain = records.filter((r) => k in r.set)
      const last = chain[chain.length - 1] as LostDocRecord
      const now = this.serverDoc[k] ?? null
      const sent = last.set[k] ?? null
      if (deepEqual(now, sent)) continue
      // CONTRACTS_REV 11 (W5-ENG-2): the last write's receipt tells its fate (DB2: the first of two writes
      // landed with its ack lost, the second never arrived: it goes again, nobody is told anything)
      const fate = last.rid !== undefined ? this.receiptFate.get(last.rid) : undefined
      if (fate !== undefined) {
        const verdict = decideLostDocByReceipt(fate, this.serverDocClock?.[k])
        if (verdict === 'again') this.pendingDoc[k] = clone(sent)
        else if (verdict === 'superseded') {
          this.log('lost_doc_superseded', { key: k })
          this.emit({ kind: 'superseded', id: `doc:${k}`, groups: [] })
        }
        continue
      }
      const again = decideLostDocKey(chain, this.serverDocClock, now)
      if (again) this.pendingDoc[k] = clone(sent)
      else {
        this.log('lost_doc_superseded', { key: k })
        this.emit({ kind: 'superseded', id: `doc:${k}`, groups: [] })
      }
    }
  }

  /** An epoch change: every lost doc write goes again (a newer write of the key wins). */
  private replayAllDoc(): void {
    for (const r of this.lostDoc)
      for (const [k, v] of Object.entries(r.set)) if (!(k in this.pendingDoc)) this.pendingDoc[k] = clone(v)
    this.lostDoc = []
  }

  /**
   * Behind a reset snapshot (cached up to 5 s, its catch-up following as `changes`), lost pushes and doc
   * writes are held as in flight until that frame or CATCH_UP_WAIT_MS: a snapshot older than their commit
   * would read as "did not land" and replay a write another user has since overwritten.
   */
  private holdLost(lost: readonly Inflight[], why: { catchUp: boolean; receipts: boolean }): void {
    this.lostHeld = [...this.lostHeld, ...lost]
    const gate = this.lostGate ?? {
      catchUp: false,
      receipts: null,
      asked: new Map<number, readonly string[]>(),
    }
    this.lostGate = gate
    if (why.catchUp) gate.catchUp = true
    if (why.receipts) {
      // CONTRACTS_REV 11: asked now when this socket's room said rev 11, else once its contracts frame does
      if (this.roomRev === null) gate.receipts ??= 'contracts'
      else if (this.roomRev >= RECEIPTS_REV) this.askReceipts()
    }
    this.log('lost_held', {
      pushes: lost.map((p) => p.seq),
      doc: this.lostDoc.length,
      receipts: gate.receipts ?? 'none',
    })
    this.armLostTimer()
    this.maybeResolveLost()
  }

  /** The fallback that decides held lost pushes by counting when the frames they wait for do not come. */
  private armLostTimer(): void {
    const ms = this.lostGate?.receipts ? RECEIPTS_WAIT_MS : CATCH_UP_WAIT_MS
    if (this.lostTimer !== null) {
      if (ms === CATCH_UP_WAIT_MS) return
      this.clearTimer(this.lostTimer)
    }
    this.lostTimer = this.setTimer(() => {
      this.lostTimer = null
      if (!this.stopped) this.resolveLost()
    }, ms)
  }

  /** Decides the held lost pushes once nothing they wait for is pending. */
  private maybeResolveLost(): void {
    const g = this.lostGate
    if (g && !g.catchUp && g.receipts === null) this.resolveLost()
  }

  /**
   * Whether `lost` (or a lost doc write) carries a receipt id this socket's room may answer for (CONTRACTS_REV
   * 11): a rev-11 room, or one whose revision is not known yet (its contracts frame follows the welcome).
   */
  private receiptsPossible(lost: readonly Inflight[]): boolean {
    if (this.roomRev !== null && this.roomRev < RECEIPTS_REV) return false
    return lost.some((p) => p.rid !== undefined) || this.lostDoc.some((r) => r.rid !== undefined)
  }

  /** The fate of a lost push's receipt the room told (true: landed), or undefined when it did not. */
  private fateOf(rid: string | undefined): boolean | undefined {
    const f = rid === undefined ? undefined : this.receiptFate.get(rid)
    return f === undefined ? undefined : f !== false
  }

  /**
   * Asks this socket's room (rev 11) which receipts of the held lost pushes and lost doc writes landed: the
   * ids not asked yet, the newest MAX_RECEIPT_IDS (older ones are decided by counting).
   */
  private askReceipts(): void {
    const gate = this.lostGate
    if (!gate) return
    const base = new Map<string, number>()
    for (const p of this.lostHeld) if (p.rid !== undefined) base.set(p.rid, p.base)
    for (const r of this.lostDoc)
      if (r.rid !== undefined && r.clock !== undefined && !base.has(r.rid)) base.set(r.rid, r.clock)
    const ids = [...base.keys()]
      .filter((rid) => !this.receiptBase.has(rid) && !this.receiptFate.has(rid))
      .slice(-MAX_RECEIPT_IDS)
    if (!ids.length) {
      if (!gate.asked.size) gate.receipts = null
      return
    }
    for (const rid of ids) this.receiptBase.set(rid, base.get(rid) as number)
    const req = ++this.receiptsReq
    gate.asked.set(req, ids)
    gate.receipts = 'asked'
    this.transport.send({ type: 'receipts', req, ids })
    this.log('receipts_asked', { req, ids: ids.length })
  }

  /** The room's revision (its `contracts` frame, after every welcome): a rev-11 room is asked for receipts. */
  private onContracts(rev: number): void {
    this.roomRev = rev
    const g = this.lostGate
    if (g?.receipts !== 'contracts') return
    if (rev >= RECEIPTS_REV) {
      g.receipts = null
      this.askReceipts()
    } else g.receipts = null
    this.armLostTimer()
    this.maybeResolveLost()
  }

  /**
   * The room's answer to a receipts query (CONTRACTS_REV 11): each asked receipt landed at its clock, or did
   * not land when the room could still hold it (its push's base + 1 >= `from`); otherwise unknown.
   */
  private onReceipts(m: Receipts): void {
    const g = this.lostGate
    const ids = g?.asked.get(m.req)
    if (!g || !ids) return
    g.asked.delete(m.req)
    for (const rid of ids) {
      const at = m.landed[rid]
      if (at !== undefined) this.receiptFate.set(rid, at)
      else {
        const base = this.receiptBase.get(rid)
        if (base !== undefined && base + 1 >= m.from) this.receiptFate.set(rid, false)
      }
    }
    if (!g.asked.size) g.receipts = null
    this.maybeResolveLost()
  }

  private resolveLost(): void {
    if (this.lostTimer !== null) {
      this.clearTimer(this.lostTimer)
      this.lostTimer = null
    }
    this.lostGate = null
    const lost = this.lostHeld
    if (!lost.length && !this.lostDoc.length) return
    this.syncLive()
    this.lostHeld = []
    this.replayLost(lost)
    this.decideLostDoc()
    this.receiptFate.clear()
    this.receiptBase.clear()
    const ids = new Set<string>()
    for (const p of lost) for (const id of p.sent.keys()) ids.add(id)
    for (const id of ids) {
      const t = this.tracked.get(id)
      if (!t) continue
      if (this.confirmedMap.has(id)) t.isNew = false
      this.settleDirty(id, t)
    }
    this.applyScene(ids)
    this.scheduleFlush(true)
    this.schedulePersist()
    this.updateSaved()
  }

  /**
   * Dirty groups of `id` equal to the server's copy are not changes any more (a push that committed but
   * whose ack was lost, a queued offline entry that had landed): dropped, and the element is untracked
   * when nothing is left. A create is left alone (its ack or the server's copy settles it first).
   */
  private settleDirty(id: string, t: Tracked): void {
    if (t.isNew) return
    const el = this.current.get(id)
    const conf = this.confirmedMap.get(id)
    if (!el || !conf) return
    const diff = diffGroups(el, conf).groups
    for (const g of [...t.dirty]) if (g !== 'fit' && !diff.has(g)) t.dirty.delete(g)
    if (t.dirty.size === 0) this.tracked.delete(id)
  }

  private applyServerOp(op: ServerOp, affected: Set<string>): boolean {
    if (op.k === 'c') {
      this.confirmedMap.set(
        op.el.id,
        keepTombstoneContent(this.confirmedMap.get(op.el.id), op.el as unknown as SceneElement),
      )
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
    this.resetAt = null
    const affected = new Set<string>()
    const refits: CoreEvent[] = []
    const mark = this.holdMark(m.ops.map((op) => (op.k === 'c' ? op.el.id : op.id)))
    for (const op of m.ops) {
      if (op.k === 'p') this.placedByOther(op, refits)
      if (!this.applyServerOp(op, affected)) {
        this.holdRecord(mark)
        this.resync()
        return
      }
    }
    this.holdRecord(mark)
    // the catch-up behind a stale reset snapshot (see awaitingCatchUp): the changes waiting for it
    // become ordinary edits, or go when it does not have their element either
    if (this.awaitingCatchUp.size) this.resolveCatchUp(affected)
    if (m.doc)
      for (const [k, v] of Object.entries(m.doc.set)) {
        if (v === null) delete this.serverDoc[k]
        else this.serverDoc[k] = v
        // the batch's clock bounds the write's own from above: a lost write built before this batch has a
        // base below it either way
        if (this.serverDocClock) this.serverDocClock[k] = m.clock
      }
    this.clock = m.clock
    // an element this client still counts as its own create, now on the server though no create of ours is
    // in flight: that create landed before (a push whose ack was lost, a queued entry replayed after a
    // reload that the server already had, a reset snapshot older than the create followed by its catch-up).
    // It is an ordinary element from here on; otherwise it stayed "new" and Saved never came (B4 D1)
    for (const id of affected) {
      const t = this.tracked.get(id)
      if (!t?.isNew || !this.confirmedMap.has(id)) continue
      if (this.inflight.some((p) => p.sent.get(id)?.create)) continue // its ack settles it
      t.isNew = false
      this.settleDirty(id, t)
      this.log('create_settled', { id })
    }
    // the server's value for a held derived change arrived: it replaces the local follow (§2.5.2)
    for (const id of affected) this.held.delete(id)
    this.releaseHeld(affected)
    // elements that are now equal to the server's copy in their dirty groups are clean: their dirty groups
    // go now, so the rebuild below installs the server's copy exactly (V1 N18: another user's identical
    // write landed first; the flush then found nothing to send and the scene kept its own versionNonce,
    // Saved with a map that never hashed equal to the snapshot)
    for (const id of affected) {
      const t = this.tracked.get(id)
      if (t && !t.isNew && t.dirty.size) this.settleDirty(id, t)
    }
    // the catch-up behind a reset snapshot: the lost pushes (and doc writes) held for it are decided now,
    // unless they still wait for the room's receipts answer (CONTRACTS_REV 11)
    if (this.lostGate?.catchUp) {
      this.lostGate.catchUp = false
      this.maybeResolveLost()
    }
    this.applyScene(affected)
    for (const e of refits) this.emit(e)
    // an edit that could not go out before this frame (a change waiting for its element) goes now
    if (this.hasPushable()) this.scheduleFlush(false)
    this.updateSaved()
  }

  /** Starts (or stops) the fallback that drops changes still waiting for a catch-up (awaitingCatchUp). */
  private armCatchUp(): void {
    if (this.catchUpTimer !== null) {
      this.clearTimer(this.catchUpTimer)
      this.catchUpTimer = null
    }
    if (!this.awaitingCatchUp.size) return
    this.log('catch_up_wait', { ids: [...this.awaitingCatchUp].slice(0, 20) })
    this.catchUpTimer = this.setTimer(() => {
      this.catchUpTimer = null
      if (this.stopped || !this.awaitingCatchUp.size) return
      this.syncLive()
      const affected = new Set<string>()
      this.resolveCatchUp(affected)
      this.applyScene(affected)
      this.schedulePersist()
      this.updateSaved()
    }, CATCH_UP_WAIT_MS)
  }

  /** Each change waiting for a catch-up: an ordinary edit now that its element is here, else dropped. */
  private resolveCatchUp(affected: Set<string>): void {
    for (const id of this.awaitingCatchUp) {
      const t = this.tracked.get(id)
      affected.add(id)
      if (!t) continue
      if (this.confirmedMap.has(id)) {
        this.settleDirty(id, t)
        this.log('catch_up_settled', { id })
      } else {
        this.tracked.delete(id)
        this.vanish.add(id)
        this.log('catch_up_gone', { id })
      }
    }
    this.awaitingCatchUp.clear()
    if (this.catchUpTimer !== null) {
      this.clearTimer(this.catchUpTimer)
      this.catchUpTimer = null
    }
  }

  /**
   * A server write to the position of an element this holder has a fit for (a leased free text's own
   * `x`/`y`), or to the position or size of a container it fits, dirty or in flight (§2.9.4 rules 3, 4).
   * Called for each op of a `changes` batch before the op is applied.
   *
   * This client's own fit, applied, is recognised by its values and changes nothing. Any other such write
   * (B moved or resized the element) makes EVERY fit of this client that the server has not applied yet
   * stale at once: the ones in flight have a base older than the write, so the server drops them; a dirty
   * one was computed on the old position. None of them may hold the old position in the scene any more:
   * while one did, `rebuild` kept the local `x`, `y` over the server's, the next keystroke diffed the old
   * position against a base that already had B's move, and that fit went out on a base the server
   * accepts, undoing B's move (B3 L10 5, "B's move first", lost 20/20 on a loaded machine where A's typing
   * spanned several pushes). So their fields leave the in-flight records (`base` and `rebuild` then take
   * the server's position), the dirty fit is dropped, and ONE refit redoes their combined effect on the
   * new position: a free text's shift since the server's copy before this write (`dx`/`dy`), or a
   * container's layout re-run. Their later `fitDropped` acks ask for nothing more.
   */
  private placedByOther(op: Extract<ServerOp, { k: 'p' }>, refits: CoreEvent[]): void {
    const id = op.id
    const t = this.tracked.get(id)
    const dirtyFit = !!t?.dirty.has('fit')
    const flying = this.inflight.filter((p) => !!p.sent.get(id)?.groups.has('fit'))
    if (!dirtyFit && flying.length === 0) return
    const local = this.current.get(id)
    const conf = this.confirmedMap.get(id)
    const kindOf = local ?? conf
    const free = isText(kindOf) && !containerOf(kindOf)
    const g = (op.g ?? {}) as Record<string, Record<string, unknown> | undefined>
    // what the server checks a fit against (merge.ts): a free text's pos; a container's pos and shape
    const placed: Record<string, unknown> = { ...(g.pos ?? {}), ...(free ? {} : (g.shape ?? {})) }
    if (Object.keys(placed).length === 0) return
    if (flying.some((p) => this.ownPlacement(p, id, placed))) return
    let dx = 0
    let dy = 0
    if (free && local && conf) {
      // the shift of every fit not applied yet: the scene copy against the server's copy before this write
      // (unless an ordinary position change of this client is also pending: then nothing to separate)
      const posPending = !!t?.dirty.has('pos') || this.inflightGroups(id).has('pos')
      if (!posPending) {
        dx = ((local as { x?: number }).x ?? 0) - ((conf as { x?: number }).x ?? 0)
        dy = ((local as { y?: number }).y ?? 0) - ((conf as { y?: number }).y ?? 0)
      }
    }
    for (const p of flying) {
      const s = p.sent.get(id) as Sent
      s.groups.delete('fit')
      s.fitSuperseded = true
    }
    if (t && dirtyFit) {
      t.dirty.delete('fit')
      if (t.dirty.size === 0 && !t.isNew) this.tracked.delete(id)
    }
    this.log('fit_superseded', {
      id,
      inflight: flying.map((p) => p.seq),
      dirty: dirtyFit,
      fields: Object.keys(placed),
      dx,
      dy,
    })
    refits.push(free ? { kind: 'refit', id, dx, dy } : { kind: 'refit', id })
  }

  /** `placed` (a server op's position/size values for `id`) is what push `p` sent for it: its own fit applied. */
  private ownPlacement(p: Inflight, id: string, placed: Readonly<Record<string, unknown>>): boolean {
    const op = p.ops.find((o): o is Extract<Op, { k: 'p' }> => o.k === 'p' && o.id === id)
    if (!op?.fit) return false
    const fit = op.fit as Record<string, unknown>
    const g = (op.g ?? {}) as Record<string, Record<string, unknown> | undefined>
    for (const [f, v] of Object.entries(placed)) {
      const sent = f in fit ? fit[f] : (g.pos?.[f] ?? g.shape?.[f])
      if (!deepEqual(sent, v)) return false
    }
    return true
  }

  private resync(): void {
    if (this.resyncing || !this.connected) return
    this.resyncing = true
    this.log('resync', { since: this.clock })
    this.sendHello()
  }

  /**
   * Keeps the server versions an ack reports (`r.v` of each op applied, the stored copy of a create that
   * had landed: `create_exists`, and `derived` rows: elements the server re-snapped because of this push
   * without an op of ours) while a push still in flight was built behind this one (Sent.ahead), and
   * forgets the rest. Read by `effectivePv` when those later pushes are lost.
   */
  private recordAckedVersions(push: Inflight, ack: Ack): void {
    const byId = new Map<string, AckedVersion>()
    const fixOf = (fix: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
      if (!fix) return undefined
      // top-level fields only (`c:<key>` names a canonicalized customData.lobby key)
      const out = Object.fromEntries(Object.entries(fix).filter(([k]) => !k.startsWith('c:')))
      return Object.keys(out).length ? out : undefined
    }
    const record = (id: string, v: number, fix: Record<string, unknown> | undefined) => {
      const had = byId.get(id)
      const merged = had?.fix || fix ? { ...(had?.fix ?? {}), ...(fix ?? {}) } : undefined
      byId.set(id, { v: Math.max(had?.v ?? 0, v), ...(merged ? { fix: merged } : {}) })
    }
    ack.r.forEach((r, n) => {
      const op = push.ops[n]
      const id = op ? opId(op) : r.id
      if (r.ok) record(id, r.v, fixOf(r.fix))
      else if (r.code === 'INVALID' && r.el && !r.el.isDeleted && push.sent.get(id)?.create)
        record(id, r.el.version, undefined)
    })
    for (const d of ack.derived ?? []) record(d.id, d.v, fixOf(d.fix))
    if (byId.size) this.ackedVersion.set(ack.seq, byId)
    const referenced = new Set<number>()
    for (const p of this.flying())
      for (const s of p.sent.values()) for (const seq of s.ahead ?? []) referenced.add(seq)
    for (const seq of [...this.ackedVersion.keys()]) if (!referenced.has(seq)) this.ackedVersion.delete(seq)
  }

  /**
   * The server version a lost push's decision counts other writes from: its `pv`, or the version the last
   * of this tab's own pushes it was built behind (`ahead`) left on the server, when that push was acked
   * (an op of ours, or a derived write the server made for it). Those pushes landed before the lost one
   * (one socket is one FIFO), so their bumps are this tab's, not other users' writes.
   */
  private effectivePv(id: string, s: Sent): number | undefined {
    let pv = s.pv
    for (const seq of s.ahead ?? []) {
      const v = this.ackedVersion.get(seq)?.get(id)?.v
      if (v !== undefined && (pv === undefined || v > pv)) pv = v
    }
    return pv
  }

  /**
   * The copy a lost push's decision compares the server copy against: its `ref` (the server copy plus this
   * tab's pushes ahead, as built) with the fields the server rewrote for those pushes once they were acked
   * (an arrow re-snapped behind a move of its box: `ack.derived`; a rounded point: `fix`). Without them the
   * server copy never equals "ours landed and nobody wrote after", and a lost push behind a derived write
   * is superseded or replayed for nothing.
   */
  private effectiveRef(id: string, s: Sent): SceneElement | undefined {
    let ref = s.ref
    if (!ref) return ref
    for (const seq of [...(s.ahead ?? [])].sort((a, b) => a - b)) {
      const fix = this.ackedVersion.get(seq)?.get(id)?.fix
      if (fix) ref = { ...ref, ...clone(fix) } as SceneElement
    }
    return ref
  }

  /** A lost push's part with the versions and fields this tab's acked pushes ahead left on the server. */
  private settledSent(id: string, s: Sent): Sent {
    const pv = this.effectivePv(id, s)
    const ref = this.effectiveRef(id, s)
    return { ...s, ...(pv !== undefined ? { pv } : {}), ...(ref ? { ref } : {}) }
  }

  /**
   * Keeps the clock the room gave this tab's doc write (`ack.clock`: the batch's, the `lb_doc.clock` of the
   * keys it wrote; a denied key did not land) while a doc write still in flight was built behind it
   * (`inflightDocAhead`), and forgets the rest. Read by `ownDocClockAhead` when that later write is lost.
   */
  private recordAckedDocClock(ack: Ack, doc: Record<string, unknown> | undefined): void {
    if (doc) {
      const denied = new Set(ack.docDenied?.keys ?? [])
      const keys = Object.keys(doc).filter((k) => !denied.has(k))
      if (keys.length) this.ackedDocClock.set(ack.seq, { clock: ack.clock, keys })
    }
    const referenced = new Set<number>()
    for (const ahead of this.inflightDocAhead.values()) for (const seq of ahead) referenced.add(seq)
    for (const seq of [...this.ackedDocClock.keys()]) if (!referenced.has(seq)) this.ackedDocClock.delete(seq)
  }

  /**
   * The clock the last of this tab's own writes of `key` that the doc write `seq` was built behind
   * (`inflightDocAhead`) landed at, when that push was acked (undefined: none). Those writes landed before
   * the lost one (one socket is one FIFO), so the key's clock at theirs is this tab's, not another user's.
   */
  private ownDocClockAhead(seq: number, key: string): number | undefined {
    let clock: number | undefined
    for (const s of this.inflightDocAhead.get(seq) ?? []) {
      const a = this.ackedDocClock.get(s)
      if (a?.keys.includes(key) && (clock === undefined || a.clock > clock)) clock = a.clock
    }
    return clock
  }

  /**
   * The lost record of the doc write in flight `seq` (a socket lost, or the offline queue's `lostDoc`): its
   * keys, what they replaced, the push's base clock and, per key, the clock of this tab's own earlier write
   * of the key acked before the cut when that is above the base (`LostDocRecord.clocks`).
   */
  private lostDocRecordOf(seq: number, pushes: readonly Inflight[] = this.flying()): LostDocRecord {
    const set = this.inflightDoc.get(seq) ?? {}
    const clock = this.inflightDocClock.get(seq)
    const clocks: Record<string, number> = {}
    if (clock !== undefined)
      for (const k of Object.keys(set)) {
        const own = this.ownDocClockAhead(seq, k)
        if (own !== undefined && own > clock) clocks[k] = own
      }
    const rid = pushes.find((p) => p.seq === seq)?.rid
    return {
      set,
      base: this.inflightDocBase.get(seq) ?? {},
      ...(clock !== undefined ? { clock } : {}),
      ...(Object.keys(clocks).length ? { clocks } : {}),
      ...(rid !== undefined ? { rid } : {}),
    }
  }

  private onAckMessage(ack: Ack): void {
    const i = this.inflight.findIndex((p) => p.seq === ack.seq)
    if (i < 0) {
      this.log('ack_unknown', { seq: ack.seq })
      return
    }
    const push = this.inflight[i] as Inflight
    // a refusal below replaces the server copy of an element a gesture may hold (see heldRemote)
    const mark = this.holdMark([...push.sent.keys()])
    this.inflight.splice(i, 1)
    this.recordAckedVersions(push, ack)
    const affected = new Set<string>()
    let retry = false
    let docRejected = false
    // the push's doc write: accepted (the batch's changes carried it), retried, or not saved
    const doc = this.inflightDoc.get(ack.seq)
    this.inflightDoc.delete(ack.seq)
    this.inflightDocBase.delete(ack.seq)
    this.inflightDocClock.delete(ack.seq)
    this.inflightDocAhead.delete(ack.seq)
    this.recordAckedDocClock(ack, doc)
    if (doc && ack.docDenied) {
      if (REJECT_CODE_INFO[ack.docDenied.code].retryable) {
        retry = true
        for (const k of ack.docDenied.keys)
          if (k in doc && !(k in this.pendingDoc)) this.pendingDoc[k] = doc[k]
      } else {
        docRejected = true
        this.lastReject = { id: `doc:${ack.docDenied.keys[0] ?? ''}`, code: ack.docDenied.code }
        this.emit({ kind: 'reject', id: `doc:${ack.docDenied.keys[0] ?? ''}`, code: ack.docDenied.code })
      }
    }
    let allOk = true
    ack.r.forEach((r, n) => {
      const op = push.ops[n]
      const id = op ? opId(op) : r.id
      affected.add(id)
      const sent = push.sent.get(id)
      if (r.ok) {
        const t = this.tracked.get(id)
        if (t && sent?.create) {
          t.isNew = false
          // nothing else pending: the entry goes (it lingered with replay false, so a later offline
          // change of this element went out with no `off`, V1 N17)
          if (t.dirty.size === 0 && t.needsLease === undefined) this.tracked.delete(id)
        }
        if (r.denied) {
          allOk = false
          this.lastReject = { id, code: r.denied.code }
          this.emit({ kind: 'reject', id, code: r.denied.code })
          // refused groups of an element a gesture holds: the server's values, not ours to push again
          const held = mark?.has(id) ? this.heldRemote.get(id) : undefined
          if (held) for (const g of r.denied.groups) held.groups.add(g as GroupKey)
        }
        if (sent?.fitSuperseded) {
          // given up at another user's write (placedByOther): dropped as expected, already redone. Applied
          // would mean it committed before that write, which its own values should have shown
          if (!r.fitDropped) this.log('fit_superseded_applied', { id, seq: ack.seq })
        } else if (r.fitDropped) {
          const ref = sent?.ref as { x?: number; y?: number; containerId?: string | null } | undefined
          const el = sent?.el as { x?: number; y?: number } | undefined
          if (sent && ref && el && isText(sent.el) && !ref.containerId)
            this.emit({ kind: 'refit', id, dx: (el.x ?? 0) - (ref.x ?? 0), dy: (el.y ?? 0) - (ref.y ?? 0) })
          else this.emit({ kind: 'refit', id })
        }
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
      const stored = r.el as unknown as SceneElement | null | undefined
      if (sent?.create && r.code === 'INVALID' && stored && !stored.isDeleted) {
        // a create of an id the server has, live: this client's own create landed before (element ids are
        // random), its ack lost with a socket, or a queued offline entry replayed after a reload (B4 D1).
        // Not a refusal: the server's copy is the element, and whatever is still dirty goes out as patches
        this.confirmedMap.set(id, keepTombstoneContent(this.confirmedMap.get(id), stored))
        const t = this.tracked.get(id)
        if (t) {
          t.isNew = false
          this.settleDirty(id, t)
        }
        this.log('create_exists', { id, seq: ack.seq })
        return
      }
      allOk = false
      this.lastReject = { id, code: r.code }
      this.emit({ kind: 'reject', id, code: r.code })
      const held = mark?.has(id) ? this.heldRemote.get(id) : undefined
      if (held && sent) for (const g of sent.groups) held.groups.add(g)
      if (stored) {
        this.confirmedMap.set(id, keepTombstoneContent(this.confirmedMap.get(id), stored))
        // a refused create goes back to the server's copy: it is no create of ours any more (it stayed
        // "new" and Saved never came)
        if (sent?.create) this.tracked.delete(id)
      } else if (!this.confirmedMap.has(id)) {
        // a create the server refused: the element never existed for anyone
        this.tracked.delete(id)
        this.vanish.add(id)
      }
    })
    if (!retry) {
      this.unavailableSince = null
      this.retryDelay = 0
    }
    if (allOk && !retry && !docRejected) this.lastReject = null
    this.holdRecord(mark)
    for (const d of ack.derived ?? []) affected.add(d.id)
    for (const l of [...this.ackListeners]) l(ack)
    this.releaseHeld(affected)
    this.applyScene(affected)
    if (retry) this.scheduleRetry()
    else this.scheduleFlush(false)
    // the offline queue drops what this ack settled now, not on the next scan's 100 ms tick: a reload
    // right after "Saved" found the in-flight create still queued and replayed it (B4 D1)
    this.schedulePersist()
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
    if (Object.keys(this.pendingDoc).length) return true
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
    // a lost push that a reset snapshot could not settle yet (lostHeld) carries it: wait for the decision
    if (this.lostHeld.length && this.lostHeld.some((p) => p.sent.has(id))) return null
    if (gestureActive(this.gesture) && this.gestureIds().has(id)) return null
    const create = t.isNew && !this.confirmedMap.has(id)
    // a change to an element the server copy of which has not arrived (awaitingCatchUp): nothing to patch yet
    if (!create && !this.confirmedMap.has(id)) return null
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

  /**
   * A create the server never got (never sent, or lost with a socket) whose element is deleted locally
   * now: nothing to say to anyone. Its tracking goes, and the element leaves the scene.
   */
  private dropDeadCreates(): void {
    for (const [id, t] of [...this.tracked]) {
      if (!t.isNew || this.confirmedMap.has(id) || this.inflightHas(id)) continue
      const el = this.current.get(id)
      if (el && !el.isDeleted) continue
      this.tracked.delete(id)
      this.vanish.add(id)
    }
  }

  /** Builds and sends pushes for everything pushable. `forced`: a lease message follows (no cap). */
  private flushNow(forced: boolean): void {
    // a push carries the scene as it is: a write Excalidraw has not reported yet is scanned first
    this.syncLive()
    if (this.flushTimer !== null) {
      this.clearTimer(this.flushTimer)
      this.flushTimer = null
      this.flushDue = Number.POSITIVE_INFINITY
    }
    this.dropDeadCreates()
    if (!this.connected || !this.welcome || this.awaitingSnapshot || this.resyncing) {
      this.schedulePersist()
      this.updateSaved()
      return
    }
    if (!forced && this.inflight.length >= MAX_IN_FLIGHT_PUSHES) return
    const seqBefore = this.seq
    let ops: Op[] = []
    let sent = new Map<string, Sent>()
    let bytes = 0
    let pushBase = this.clock
    // doc writes ride in the first push of this flush (no later than any element edit made after them)
    let doc: Record<string, unknown> | null = Object.keys(this.pendingDoc).length ? this.pendingDoc : null
    this.pendingDoc = {}
    const flushOne = () => {
      if (ops.length === 0 && !doc) return
      this.sendPush(ops, sent, forced, doc, pushBase)
      doc = null
      ops = []
      sent = new Map()
      bytes = 0
    }
    // creates first (a label's container before the label: the index order), then patches
    const entries = [...this.tracked.keys()].map((id) => ({ id, p: this.pushableGroups(id) }))
    type Pushable = { id: string; p: { groups: Set<GroupKey>; create: boolean } }
    const order = entries
      .filter((e): e is Pushable => e.p !== null)
      .sort((a, b) => Number(b.p.create) - Number(a.p.create))
    // a replay goes out on the clock its change was made on, in a push of its own: the room's STALE rule
    // and the fit read a push's base, and a replay on this welcome's clock could never be STALE (V1 N17).
    // Segments: creates, then the replays by base (oldest first), then the other patches
    const baseOf = (e: Pushable): number => {
      const t = this.tracked.get(e.id) as Tracked
      if (e.p.create || !t.replay) return this.clock
      return Math.min(this.clock, t.baseClock ?? t.knownAt ?? this.clock)
    }
    const older = new Map<number, Pushable[]>()
    const creates: Pushable[] = []
    const current: Pushable[] = []
    for (const e of order) {
      const b = baseOf(e)
      if (b < this.clock) older.set(b, [...(older.get(b) ?? []), e])
      else if (e.p.create) creates.push(e)
      else current.push(e)
    }
    const segments: { base: number; items: Pushable[] }[] = older.size
      ? [
          { base: this.clock, items: creates },
          ...[...older.keys()]
            .sort((a, b) => a - b)
            .map((b) => ({ base: b, items: older.get(b) as Pushable[] })),
          { base: this.clock, items: current },
        ]
      : [{ base: this.clock, items: [...creates, ...current] }]
    /** ids whose dirty groups turned out to hold nothing to send (the same value arrived meanwhile) */
    const cleaned: string[] = []
    let full = false
    for (const seg of segments) {
      if (full) break
      if (seg.base !== pushBase) {
        flushOne()
        pushBase = seg.base
      }
      for (const { id, p } of seg.items) {
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
        if (!op) {
          cleaned.push(id)
          continue
        }
        const size = JSON.stringify(op).length
        if (ops.length >= MAX_OPS_PER_PUSH || bytes + size > MAX_PUSH_BYTES) flushOne()
        ops.push(op)
        bytes += size
        sent.set(id, {
          groups: p.create ? new Set(diffGroups(el, undefined).groups) : new Set(p.groups),
          // the push's copy as the lost-push records and the offline queue keep it (no local file suffix)
          el: withWireFile(el),
          create: p.create,
          ...(p.create
            ? { prior: this.confirmedMap.has(id) ? clone(this.confirmedMap.get(id)) : undefined }
            : {
                ref: this.base(id),
                pv: (this.confirmedMap.get(id) as SceneElement).version,
                // every push out, not only those carrying `id`: one of another element may make the
                // server re-snap this one (a bound arrow, a label, a frame follower: ack.derived)
                ahead: this.flying().map((q) => q.seq),
              }),
        })
        if (!forced && this.inflight.length >= MAX_IN_FLIGHT_PUSHES) {
          full = true
          break
        }
      }
    }
    flushOne()
    // what was dirty is in flight now: the offline queue keeps it as a lost push from here on (a reload
    // before its ack decides it as one, not as an unsent edit: V1 re-check, R4/R5 in the browser)
    if (this.seq !== seqBefore) this.schedulePersist()
    // nothing was left to send for them: with nothing dirty, in flight or held, the scene goes back to the
    // server's copy exactly (its version and versionNonce; V1 N18)
    if (cleaned.length) {
      const reset = new Set<string>()
      for (const id of cleaned) this.settleClean(id, reset)
      if (reset.size) this.applyScene(reset)
    }
    this.updateSaved()
  }

  private sendPush(
    ops: Op[],
    sent: Map<string, Sent>,
    forced: boolean,
    doc: Record<string, unknown> | null = null,
    base: number = this.clock,
  ): void {
    const seq = ++this.seq
    const record: PushRecord = { seq, base, at: this.now(), ops, ...(doc ? { doc: { set: doc } } : {}) }
    // CONTRACTS_REV 11 (W5-ENG-2): a receipt id, only to a room that said rev 11 on this socket (a rev-10
    // room refuses the field: strict)
    const rid = this.roomRev !== null && this.roomRev >= RECEIPTS_REV ? `${this.ridPrefix}${seq}` : undefined
    if (doc) {
      // what each key replaces: the server copy overlaid with this tab's earlier writes not acked yet
      const was = this.doc()
      const replaced: Record<string, unknown> = {}
      for (const k of Object.keys(doc)) replaced[k] = was.has(k) ? clone(was.get(k)) : null
      this.inflightDocBase.set(seq, replaced)
      // the pushes out before it: one of ours writing the same key lands before it (one socket is one FIFO)
      this.inflightDocAhead.set(
        seq,
        this.flying().map((q) => q.seq),
      )
    }
    this.inflight.push({
      seq,
      base,
      ops,
      record,
      sent,
      forced,
      src: `${this.tab}:${this.welcomes}`,
      ...(rid !== undefined ? { rid } : {}),
    })
    if (doc) {
      this.inflightDoc.set(seq, doc)
      this.inflightDocClock.set(seq, base)
    }
    this.pushes.push(record)
    this.transport.send({
      type: 'push',
      seq,
      base,
      ops,
      ...(doc ? { doc: { set: doc } } : {}),
      ...(rid !== undefined ? { rid } : {}),
    })
    for (const t of this.tracked.values())
      if (t.dirty.size === 0) {
        t.replay = false
        t.baseClock = undefined
      }
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
      // an acquire of it still waiting for a socket is not asked any more
      for (let i = this.queuedLease.length - 1; i >= 0; i--) {
        const q = this.queuedLease[i] as LeaseClientMessage
        if (q.type === 'lease.acquire' && q.id === message.id) this.queuedLease.splice(i, 1)
      }
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
      if (this.stopped || !entries.length) return
      this.log('offline_adopted', { entries: entries.length })
      if (this.connected && this.welcome && !this.awaitingSnapshot && !this.resyncing) this.adoptNow(entries)
      else {
        // no server state yet: adopted at the next welcome (afterWelcome), counted meanwhile
        this.pendingAdopt = [...(this.pendingAdopt ?? []), ...entries]
        this.offlineQueued = Math.max(this.offlineQueued, this.pendingAdopt.length)
        this.offlineQueuedItems = Math.max(this.offlineQueuedItems, this.entryItems(this.pendingAdopt).size)
      }
      this.updateSaved()
    } catch (err) {
      this.log('offline_load_failed', { error: String(err) })
    } finally {
      this.offlineLoaded = true
      if (this.persistAfterLoad && !this.stopped) {
        this.persistAfterLoad = false
        void this.persist()
      }
      if (!this.stopped) this.updateSaved()
    }
  }

  /** Adopts queued entries while connected: rebased on the server's copies, put in the scene, pushed. */
  private adoptNow(entries: readonly OfflineEntry[]): void {
    this.syncLive()
    const ids = new Set<string>()
    for (const e of entries) {
      this.adoptOffline(e)
      ids.add(e.element.id)
    }
    // the previous page's lost pushes and doc writes: decided as a reconnect decides its own (behind a
    // reset snapshot whose catch-up has not come yet, they wait for it)
    const adopted = this.takeAdopted()
    if (adopted.length || this.lostDoc.length) {
      const fresh = this.resetAt !== null && this.now() - this.resetAt < CATCH_UP_WAIT_MS
      const receipts = this.receiptsPossible(adopted)
      if (this.lostGate !== null || fresh || receipts) this.holdLost(adopted, { catchUp: fresh, receipts })
      else {
        this.replayLost(adopted)
        this.decideLostDoc()
      }
    }
    for (const id of ids) {
      const t = this.tracked.get(id)
      if (!t) continue
      if (this.confirmedMap.has(id)) t.isNew = false
      else if (!t.isNew) {
        this.tracked.delete(id)
        continue
      }
      this.settleDirty(id, t)
    }
    this.applyScene(ids)
    this.flushNow(false)
  }

  private adoptOffline(e: OfflineEntry): void {
    // the board-document writes the queue kept (docEntry): the unsent ones go in the next push, before its
    // element edits, unless this tab wrote the key again since; the ones that were out (`lostDoc`) are
    // decided like lost doc writes (decideLostDoc)
    if (e.element.id === DOC_ENTRY_ID) {
      const set = (e.element as unknown as { set?: Record<string, unknown> }).set ?? {}
      for (const [k, v] of Object.entries(set)) if (!(k in this.pendingDoc)) this.pendingDoc[k] = clone(v)
      for (const r of e.lostDoc ?? [])
        this.lostDoc.push({
          set: clone(r.set),
          base: clone(r.base),
          ...(r.clock !== undefined ? { clock: r.clock } : {}),
          ...(r.clocks ? { clocks: clone(r.clocks) } : {}),
          ...(r.rid !== undefined ? { rid: r.rid } : {}),
        })
      return
    }
    const id = e.element.id
    const isNew = e.groups.includes('create')
    const groups = new Set<GroupKey>(e.groups.filter((g) => g !== 'create') as GroupKey[])
    if (groups.size || isNew || !e.lost?.length)
      this.tracked.set(id, { dirty: groups, isNew, since: e.queuedAt, replay: true, knownAt: e.base })
    // its pushes that were out when the page closed: one lost push per (socket, seq), in send order
    for (const r of e.lost ?? []) {
      const key = `${r.src}#${r.seq}`
      let p = this.adoptedLost.get(key)
      if (!p) {
        const seq = --this.adoptedSeq
        p = {
          seq,
          base: r.base,
          ops: [],
          record: { seq: r.seq, base: r.base, at: r.at, ops: [] },
          sent: new Map(),
          forced: false,
          src: r.src,
          ...(r.rid !== undefined ? { rid: r.rid } : {}),
        }
        this.adoptedLost.set(key, p)
      }
      p.sent.set(id, {
        groups: new Set(r.groups as GroupKey[]),
        el: clone(r.el),
        create: r.create,
        ...(r.ref ? { ref: clone(r.ref) } : {}),
        ...(r.pv !== undefined ? { pv: r.pv } : {}),
        ...(r.prior ? { prior: clone(r.prior) } : {}),
      })
    }
    // the queued element becomes the local copy (its dirty groups are rebased on the server's at welcome)
    const next = [...this.currentOrder.filter((el) => el.id !== id), e.element]
    this.readScene(next)
    this.known.delete(id)
  }

  /** The adopted queues' lost pushes, in send order per socket, and forgets them. */
  private takeAdopted(): Inflight[] {
    const out = [...this.adoptedLost.values()].sort((a, b) =>
      a.src === b.src ? a.record.seq - b.record.seq : a.src < b.src ? -1 : 1,
    )
    this.adoptedLost.clear()
    return out
  }

  private offlineEntries(): OfflineEntry[] {
    const out: OfflineEntry[] = []
    type Acc = { groups: Set<string>; since: number; lost: LostPushRecord[] }
    const byId = new Map<string, Acc>()
    const acc = (id: string): Acc => {
      let a = byId.get(id)
      if (!a) {
        a = { groups: new Set(), since: Number.POSITIVE_INFINITY, lost: [] }
        byId.set(id, a)
      }
      return a
    }
    const flying = this.flying()
    for (const [id, t] of this.tracked) {
      if (t.dirty.size === 0 && !t.isNew) continue
      const a = acc(id)
      for (const g of t.dirty) a.groups.add(g)
      // a create not sent yet (one out is a lost record below)
      if (t.isNew && !this.confirmedMap.has(id) && !flying.some((p) => p.sent.get(id)?.create))
        a.groups.add('create')
      a.since = Math.min(a.since, t.since)
    }
    // pushes out without an ack: a reload or a closed tab loses their acks, so the page that adopts the
    // queue decides them as lost pushes (replayLost), not as unsent changes (V1's reload replay)
    for (const p of flying)
      for (const [id, raw] of p.sent) {
        const a = acc(id)
        // past this tab's own pushes acked so far: the page that adopts the queue sees no more acks
        const s = this.settledSent(id, raw)
        a.lost.push({
          src: p.src,
          seq: p.record.seq,
          base: p.base,
          at: p.record.at,
          create: s.create,
          groups: [...s.groups],
          el: withWireFile(s.el),
          ...(s.ref ? { ref: withWireFile(s.ref) } : {}),
          ...(s.pv !== undefined ? { pv: s.pv } : {}),
          ...(s.prior ? { prior: withWireFile(s.prior) } : {}),
          ...(p.rid !== undefined ? { rid: p.rid } : {}),
        })
        a.since = Math.min(a.since, p.record.at)
      }
    for (const [id, a] of byId) {
      const el = this.current.get(id)
      if (!el) continue
      out.push({
        // never a local derivative suffix in the queue (E9): the page that adopts it starts on the thumb
        element: withWireFile(el),
        groups: [...a.groups],
        base: this.clock,
        queuedAt: Number.isFinite(a.since) ? a.since : this.now(),
        ...(a.lost.length ? { lost: a.lost } : {}),
      })
    }
    // loaded but not adopted yet (no welcome so far): kept in the store as they were
    for (const e of this.pendingAdopt ?? []) if (!byId.has(e.element.id)) out.push(e)
    // board-document writes: the unsent ones (setDoc: a new tag's tagDef) and the ones out without an ack,
    // with what they replaced; kept, or a reload lost them and the element's tag, queued, was then refused
    // INVALID (V1 N8)
    // (past this tab's own doc writes acked so far: the page that adopts the queue sees no more acks)
    const lostDoc: LostDocRecord[] = [...this.lostDoc]
    for (const seq of this.inflightDoc.keys()) lostDoc.push(this.lostDocRecordOf(seq))
    if (Object.keys(this.pendingDoc).length || lostDoc.length) {
      const e = docEntry(this.pendingDoc, this.clock, this.now())
      out.unshift(lostDoc.length ? { ...e, lostDoc: clone(lostDoc) } : e)
    }
    return out
  }

  /**
   * Writes the offline queue after a change: at once (the store's write starts in this call), so a reload
   * or a closed tab right after an edit finds it (wave 2 lost offline-9 in the old 100 ms window); while a
   * gesture runs, once per 100 ms at most (its end writes at once). Nothing is written before the
   * queue left by the previous page is loaded (a write then would replace it unread).
   */
  private schedulePersist(): void {
    if (!this.store) return
    if (gestureActive(this.gesture)) {
      if (this.persistTimer === null)
        this.persistTimer = this.setTimer(() => {
          this.persistTimer = null
          void this.persist()
        }, 100)
      return
    }
    if (this.persistTimer !== null) {
      this.clearTimer(this.persistTimer)
      this.persistTimer = null
    }
    void this.persist()
  }

  /**
   * Writes the offline queue now, with any write Excalidraw holds and has not reported yet: the page
   * calls it on `pagehide` and when it is hidden (a reload, a closed tab, a phone switching apps).
   */
  persistNow(): void {
    if (this.stopped || !this.store) return
    this.syncLive()
    if (this.persistTimer !== null) {
      this.clearTimer(this.persistTimer)
      this.persistTimer = null
    }
    void this.persist()
  }

  private async persist(): Promise<void> {
    if (!this.store) return
    if (!this.offlineLoaded) {
      this.persistAfterLoad = true
      return
    }
    this.syncLive()
    const entries = this.offlineEntries()
    this.offlineQueued = this.connected && this.welcome ? 0 : entries.length
    this.offlineQueuedItems = this.connected && this.welcome ? 0 : this.entryItems(entries).size
    // the same queue as the last write (a scan that found nothing, the core's own apply): no write
    const sig = entries
      .map((e) =>
        e.element.id === DOC_ENTRY_ID
          ? `${DOC_ENTRY_ID}:${JSON.stringify((e.element as unknown as { set?: unknown }).set)}:${JSON.stringify(e.lostDoc ?? [])}`
          : `${e.element.id}:${e.element.version}:${e.element.versionNonce}:${e.groups.join(',')}:${(e.lost ?? []).map((l) => `${l.src}#${l.seq}`).join(',')}`,
      )
      .join('|')
    if (sig === this.persistedSig) return
    this.persistedSig = sig
    try {
      if (entries.length) await this.store.save(entries)
      else await this.store.clear()
    } catch (err) {
      this.persistedSig = null
      this.log('offline_save_failed', { error: String(err) })
    }
    this.updateSaved()
  }

  // =====================================================================================================
  // Saved (§2.5.7)
  // =====================================================================================================

  /**
   * OFFLINE-COUNT: the item a change of `id` counts under, as the person sees it: a bound label's change is
   * its container's (a note and its text are one note), anything else its own id.
   */
  private itemOf(id: string, el?: SceneElement): string {
    return containerOf(el ?? this.current.get(id) ?? this.confirmedMap.get(id)) ?? id
  }

  /** The offline queue's entries as items (a label's entry counts with its container's; the doc writes as one). */
  private entryItems(entries: readonly OfflineEntry[]): Set<string> {
    const out = new Set<string>()
    for (const e of entries)
      out.add(e.element.id === DOC_ENTRY_ID ? DOC_ENTRY_ID : this.itemOf(e.element.id, e.element))
    return out
  }

  /**
   * The changes on this device not on the server yet, as items (`offlineChanges` while offline): dirty and
   * in-flight elements (a label with its container), each doc write, each editor's buffered text, and a
   * queue loaded and not adopted yet. The Saved state's `pending` keeps counting elements.
   */
  private changeItems(): number {
    const items = new Set<string>()
    for (const [id, t] of this.tracked) if (t.dirty.size > 0 || t.isNew) items.add(this.itemOf(id))
    for (const p of this.flying()) for (const [id, s] of p.sent) items.add(this.itemOf(id, s.el))
    for (const id of this.entryItems(this.pendingAdopt ?? [])) items.add(id)
    let n = items.size
    n += (Object.keys(this.pendingDoc).length ? 1 : 0) + this.inflightDoc.size + this.lostDoc.length
    return n + this.outside.size
  }

  private updateSaved(): void {
    let dirty = 0
    for (const t of this.tracked.values()) if (t.dirty.size > 0 || t.isNew) dirty++
    // a doc write not sent or not acked keeps the board unsaved too
    dirty += (Object.keys(this.pendingDoc).length ? 1 : 0) + this.inflightDoc.size + this.lostDoc.length
    // unsent text outside the scene (an editor's buffered keys, holdSaved)
    dirty += this.outside.size
    // the previous page's offline queue not read yet, or read and not adopted yet: its edits are not on
    // the server (V1 N20: a reloaded page showed Saved at the welcome, before the queue was loaded). A
    // queue not read yet is `unknown`, not an offline change: a page opening with an empty queue is not
    // "Offline — 1 change" for its first milliseconds (A11Y-14, CR-3I-6: the announcer then said "Back
    // online. All changes saved." on every board open).
    const unknown = this.store && !this.offlineLoaded ? 1 : 0
    dirty += this.pendingAdopt?.length ?? 0
    const inputs: SaveInputs = {
      connected: this.connected && !!this.welcome && !this.awaitingSnapshot,
      dirty,
      // an adopted queue's lost push carries no ops, only its elements (OfflineEntry.lost)
      inflightOps: this.flying().reduce((n, p) => n + (p.ops.length || p.sent.size), 0),
      offlineQueued: this.connected && this.welcome ? 0 : Math.max(this.offlineQueued, dirty),
      offlineItems:
        this.connected && this.welcome ? 0 : Math.max(this.offlineQueuedItems, this.changeItems()),
      unknown,
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
