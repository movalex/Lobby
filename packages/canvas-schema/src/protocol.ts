/**
 * The ElementRoom wire protocol, `proto: 1` (docs/EXCALIDRAW-MIGRATION.md §2.4.2, §2.4.3, §2.7, §2.9),
 * as zod schemas plus TS types. Frozen at the spike B contracts step C0; every later change is a change
 * request to the lead, bumps `CONTRACTS_REV` and needs the OK of O1 and O2
 * (docs/research/excalidraw/spike-b/CONTRACTS.md).
 *
 * JSON, one message per WebSocket text frame, discriminated by `type`. The server parses every client
 * message with `ClientMessage` (strict: unknown keys are refused). The endpoint and query are unchanged:
 * `/connect/:boardId?sessionId=…&ticket=…`. The one binary frame is the gzip snapshot after a
 * `welcome` with `reset: true` (`SnapshotFrame`).
 *
 * Pure: zod and this package's pure modules (no engine code, no DOM, no Node built-ins). The group
 * VOCABULARY lives here because ops name groups; the per-kind field map and the geometry helpers are in
 * groups.ts.
 */
import { z } from 'zod'
import { CustomData, LobbyServer, lobbyKeySpec, lobbyValueProblem } from './custom-data.ts'
import { DocSet, docValueProblem } from './doc.ts'
import { BoundElementRef, ElementId, FixedSegment, LocalPoint, WireElement } from './elements.ts'
import {
  COORD_LIMIT,
  LEASE_TTL_MS,
  MAX_BOUND_ELEMENTS,
  MAX_DRAG_IDS,
  MAX_DRAG_IDS_WIRE,
  MAX_FIXED_SEGMENTS,
  MAX_LINEAR_POINTS,
  MAX_OPS_PER_PUSH,
  MAX_SEL_IDS,
  WIRE_LIMITS,
} from './limits.ts'

/** The wire protocol version (`hello.proto`, `welcome.proto`). */
export const PROTO = 1 as const
/**
 * Bumped by the contracts owner on every change request applied after C0 (CONTRACTS.md; since wave 5,
 * docs/EXCALIDRAW-CONTRACTS.md §0a). C0 is revision 1. Revision 7 (wave 5, owner 2A as contracts owner):
 * tombstones travel redacted (elements.ts `redactTombstone`, hash.ts `TOMBSTONE_KEYS`; W5-02), font family
 * 7 is allowed (D3), the signed-URL check fails closed and knows GCS (V2), the guest cap is per uid (D5).
 * Revision 8: a delete's broadcast is the exact patch again (only `c` ops of tombstones are redacted).
 * Revision 9 (wave 4b, 2A): `welcome.docClocks` and `snapshot.docClocks`, the clock each board-document
 * key was last written at (doc-key ABA, CR-W5-FIX-2: a lost doc write whose key the server wrote after
 * the push's base is superseded, never replayed over the later write); the `changes` frame that follows a
 * cached reset snapshot carries the doc keys written since the cache (DEF-3F-1); the `CLOSING` notice
 * names a terminal close's reason in band, before the close frame (SMK-2: an edge may strip close
 * codes and reasons); `isAllowedLink` normalises relative links and requires `http(s)://` (XSS-F3).
 */
export const CONTRACTS_REV = 9
/**
 * The element schema version (`hello.schema`, `welcome.schema`, `lb_meta.schemaVersion`). A client one
 * version older is served; a newer one gets 4099 `SERVER_TOO_OLD`, an older one `CLIENT_TOO_OLD` (§6.2 `schema`).
 */
export const ELEMENT_SCHEMA_VERSION = 1

// ---- small shared schemas ---------------------------------------------------------------------------

const NonNegInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** A server clock: +1 per accepted push, never reused within an epoch. */
export const Clock = NonNegInt
/** A board epoch: a new one on every restore; a client whose epoch differs gets a reset (§2.6). */
export const Epoch = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
/** A session id: `<uid>:<tab>` from the ticket and the connect URL (`sid = uid:clientSessionId`). */
export const SessionId = z.string().min(3).max(200)
const Uid = z.string().min(1).max(60)
const Finite = z.number().finite()
const Coord = Finite.gte(-COORD_LIMIT).lte(COORD_LIMIT)
export const BoardRoleSchema = z.enum(['owner', 'editor', 'commenter', 'viewer'])

// ---- field groups: the wire vocabulary (§3.2) ----------------------------------------------------------

/**
 * The merge units. `c:<key>` (one per `customData.lobby` key) is a group too; it travels in an op's `c`,
 * not in `g`. `bound` travels in `b`. `fit` is not a group: it is the conditional write form of §2.9.4,
 * and the `gclock` slot that derived writes advance.
 */
export const GROUP_NAMES = [
  'pos',
  'shape',
  'path',
  'text',
  'layout',
  'textStyle',
  'style',
  'bind',
  'bound',
  'z',
  'membership',
  'meta',
  'file',
  'life',
] as const
export type GroupName = (typeof GROUP_NAMES)[number]
/** Groups a patch carries in `g` (all but `bound`, which is `b`). */
export const PATCH_GROUP_NAMES = GROUP_NAMES.filter((g) => g !== 'bound') as readonly Exclude<
  GroupName,
  'bound'
>[]
export type PatchGroupName = Exclude<GroupName, 'bound'>

/**
 * Fields each group may carry, over all element kinds (§3.2). Which of them a given element has, and
 * which group a field is in for that element's kind, is groups.ts (`fieldGroupOf`): a bound label's `x`
 * is `layout`, an arrow's `x` is `path`, a rectangle's `x` is `pos`.
 */
export const GROUP_FIELDS: Readonly<Record<GroupName, readonly string[]>> = {
  pos: ['x', 'y'],
  shape: [
    'width',
    'height',
    'angle',
    'points',
    'pressures',
    'simulatePressure',
    'scale',
    'crop',
    'roundness',
    'seed',
    'baseHeight',
  ],
  path: [
    'x',
    'y',
    'points',
    'width',
    'height',
    'angle',
    'elbowed',
    'fixedSegments',
    'startIsSpecial',
    'endIsSpecial',
    'polygon',
  ],
  text: ['originalText'],
  layout: ['text', 'fontSize', 'x', 'y', 'width', 'height'],
  textStyle: [
    'fontSize',
    'baseFontSize',
    'fontFamily',
    'lineHeight',
    'textAlign',
    'verticalAlign',
    'autoResize',
  ],
  style: [
    'strokeColor',
    'backgroundColor',
    'fillStyle',
    'strokeWidth',
    'strokeStyle',
    'strokeOptions',
    'roughness',
    'opacity',
    'startArrowhead',
    'endArrowhead',
  ],
  bind: ['startBinding', 'endBinding', 'containerId', 'labelPosition'],
  bound: ['boundElements'],
  z: ['index'],
  membership: ['groupIds', 'frameId'],
  meta: ['link', 'locked', 'name'],
  file: ['fileId'],
  life: ['isDeleted'],
}

/** The `gclock` slot of derived writes: a fit, and the server's re-snaps of bound arrows and their labels. */
export const DERIVED_CLOCK = 'fit' as const

// ---- the `path` unit: an arrow's or a line's whole geometry (revision 3.4; whole since 3.5) -----------------

/** Always in an arrow's `path` unit. */
export const ARROW_PATH_FIELDS = ['x', 'y', 'points', 'width', 'height', 'angle', 'elbowed'] as const
/** Also in the unit when `elbowed` is true (may be null); may be present (stale) on a non-elbow arrow. */
export const ELBOW_PATH_FIELDS = ['fixedSegments', 'startIsSpecial', 'endIsSpecial'] as const
/** Always in a line's `path` unit. */
export const LINE_PATH_FIELDS = ['x', 'y', 'points', 'width', 'height', 'angle', 'polygon'] as const

/**
 * Why a `path` group value is not a whole unit, or null (§2.4.2 "Linear geometry travels whole"): an
 * op that writes any field of `path` carries all of them from the same local copy, and the server
 * refuses a `path` patch with a missing field (`INVALID`). With `type` unknown (stage 0, before the
 * stored element is read) the kind is taken from the unit itself: `polygon` means a line, `elbowed` an
 * arrow; the server repeats the check with the stored type.
 *
 * Applying a unit is whole too: the element's path fields become exactly the unit's (an elbow field the
 * unit leaves out is removed from the element).
 */
export function pathUnitProblem(
  unit: Readonly<Record<string, unknown>>,
  type?: 'arrow' | 'line',
): string | null {
  const isLine = type ? type === 'line' : 'polygon' in unit
  if ('polygon' in unit && 'elbowed' in unit) return "a path unit is either an arrow's or a line's"
  const required: readonly string[] = isLine ? LINE_PATH_FIELDS : ARROW_PATH_FIELDS
  for (const f of required) if (!(f in unit)) return `path unit without ${f}`
  if (isLine) {
    for (const f of ELBOW_PATH_FIELDS) if (f in unit) return `a line's path unit has no ${f}`
    return null
  }
  if ('polygon' in unit) return "an arrow's path unit has no polygon"
  if (unit.elbowed === true)
    for (const f of ELBOW_PATH_FIELDS) if (!(f in unit)) return `elbow path unit without ${f}`
  return null
}

const PathValues = z.strictObject({
  x: Coord.optional(),
  y: Coord.optional(),
  points: z.array(LocalPoint).max(MAX_LINEAR_POINTS).optional(),
  width: Coord.optional(),
  height: Coord.optional(),
  angle: Finite.optional(),
  elbowed: z.boolean().optional(),
  fixedSegments: z.array(FixedSegment).max(MAX_FIXED_SEGMENTS).nullable().optional(),
  startIsSpecial: z.boolean().nullable().optional(),
  endIsSpecial: z.boolean().nullable().optional(),
  polygon: z.boolean().optional(),
})

// ---- patches -------------------------------------------------------------------------------------------

/** `g`: changed groups, with only their fields (for `path`: the whole unit). Values are checked on the merged element. */
export const GroupPatch = z
  .partialRecord(
    z.enum(PATCH_GROUP_NAMES as unknown as [PatchGroupName, ...PatchGroupName[]]),
    z.record(z.string(), z.unknown()),
  )
  .superRefine((g, ctx) => {
    for (const [group, fields] of Object.entries(g) as [PatchGroupName, Record<string, unknown>][]) {
      const allowed = GROUP_FIELDS[group]
      const keys = Object.keys(fields)
      if (keys.length === 0) ctx.addIssue({ code: 'custom', message: `empty group ${group}`, path: [group] })
      for (const k of keys)
        if (!allowed.includes(k))
          ctx.addIssue({ code: 'custom', message: `${k} is not in group ${group}`, path: [group, k] })
      if (group === 'path') {
        const problem = pathUnitProblem(fields)
        if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['path'] })
        else if (!PathValues.safeParse(fields).success)
          ctx.addIssue({ code: 'custom', message: 'invalid path values', path: ['path'] })
      }
    }
  })
export type GroupPatch = z.infer<typeof GroupPatch>

/** `c`: `customData.lobby` keys; `null` removes the key. Keys and values from the registry (custom-data.ts). */
export const LobbyPatch = z.record(z.string().min(1).max(200), z.unknown()).superRefine((c, ctx) => {
  const keys = Object.keys(c)
  if (keys.length === 0) ctx.addIssue({ code: 'custom', message: 'empty customData patch' })
  if (keys.length > 250) ctx.addIssue({ code: 'custom', message: 'too many customData keys' })
  for (const [k, v] of Object.entries(c)) {
    // a removal (null) only needs a known key; a value must be valid for its key
    const problem =
      v === null ? (lobbyKeySpec(k) ? null : 'unknown customData.lobby key') : lobbyValueProblem(k, v)
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: [k] })
  }
})
export type LobbyPatch = z.infer<typeof LobbyPatch>

/** `b`: `boundElements` by id (set add/remove; the server keeps them symmetric, §2.4.4). */
export const BoundPatch = z.strictObject({
  add: z.array(BoundElementRef).max(MAX_BOUND_ELEMENTS),
  rm: z.array(ElementId).max(MAX_BOUND_ELEMENTS),
})
export type BoundPatch = z.infer<typeof BoundPatch>

/**
 * `fit` (§2.9.4): the lease holder's conditional write of a text container's `height`, `width`, `x`, `y`,
 * or (revision 3.5) a leased free text's own `x`, `y`. Applied last, only if no ordinary `pos`/`shape`
 * write (for a free text: `pos` write) to that element committed after the push's `base`; otherwise
 * dropped, answered `fitDropped: true`. A fit from any session but the holder is dropped silently.
 * Advances only `gclock.fit`.
 */
export const Fit = z
  .strictObject({
    height: Coord.optional(),
    width: Coord.optional(),
    x: Coord.optional(),
    y: Coord.optional(),
  })
  .refine((f) => Object.keys(f).length > 0, 'empty fit')
export type Fit = z.infer<typeof Fit>

// ---- client → server ---------------------------------------------------------------------------------

/** A create, or an undelete of a tombstone id: the full element. */
export const CreateOp = z.strictObject({ k: z.literal('c'), el: WireElement })
/**
 * A patch: only the changed groups. `pv` is the server version this edit is based on. `off` is the age in
 * ms, only on replays from the offline queue (§2.5.6).
 */
export const PatchOp = z
  .strictObject({
    k: z.literal('p'),
    id: ElementId,
    pv: NonNegInt,
    g: GroupPatch.optional(),
    c: LobbyPatch.optional(),
    b: BoundPatch.optional(),
    fit: Fit.optional(),
    off: NonNegInt.optional(),
  })
  .refine(
    (op) => op.g !== undefined || op.c !== undefined || op.b !== undefined || op.fit !== undefined,
    'empty patch',
  )
export const Op = z.discriminatedUnion('k', [CreateOp, PatchOp])
export type CreateOp = z.infer<typeof CreateOp>
export type PatchOp = z.infer<typeof PatchOp>
export type Op = z.infer<typeof Op>

const DocSetChecked = DocSet.superRefine((d, ctx) => {
  for (const [k, v] of Object.entries(d.set)) {
    const problem = docValueProblem(k, v)
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['set', k] })
  }
})

/** `hello`: first message on every socket. A fresh client sends `since: 0, epoch: null` and gets a reset. */
export const Hello = z.strictObject({
  type: z.literal('hello'),
  proto: z.literal(PROTO),
  schema: z.number().int().positive(),
  since: Clock,
  epoch: Epoch.nullable(),
  tab: z.string().min(1).max(128),
})
/** `push`: ≤ 500 ops and ≤ 512 KiB (the frame ≤ 1 MiB). Each accepted push gets its own clock. */
export const Push = z
  .strictObject({
    type: z.literal('push'),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    base: Clock,
    ops: z.array(Op).max(MAX_OPS_PER_PUSH),
    doc: DocSetChecked.optional(),
  })
  .refine((p) => p.ops.length > 0 || p.doc !== undefined, 'empty push')
/** Text lease (§2.9.2; spike A's shapes). `id`: the container for a label, the text itself for free text. */
export const LeaseAcquire = z.strictObject({
  type: z.literal('lease.acquire'),
  req: NonNegInt,
  id: ElementId,
})
export const LeaseRelease = z.strictObject({ type: z.literal('lease.release'), id: ElementId })

export const ScenePoint = z.strictObject({ x: Finite, y: Finite })
export const SceneRect = z.strictObject({
  x: Finite,
  y: Finite,
  w: Finite.nonnegative(),
  h: Finite.nonnegative(),
})
/** Selection in presence: ids (the client sends ids up to 200, a count above), or a count. */
export const PresenceSel = z.union([
  z.array(ElementId).max(MAX_SEL_IDS),
  z.strictObject({ count: NonNegInt }),
])
/**
 * A drag preview (§2.7): `d` names the drag (a per-session counter), `ids` only in the drag's first
 * message, then `dx`/`dy` alone (scene units, rounded to 0.1); `null` ends it. A `drag` with more than
 * `MAX_DRAG_IDS` (500) ids, a second active drag, or any drag of a read-only session is DROPPED by the
 * server (the rest of the message is kept); above `MAX_DRAG_IDS_WIRE` the message is INVALID.
 */
export const DragIn = z.strictObject({
  d: NonNegInt,
  ids: z.array(ElementId).min(1).max(MAX_DRAG_IDS_WIRE).optional(),
  dx: Finite,
  dy: Finite,
})
/** `presence` (≤ 20 Hz, bypasses the FIFO): no identity fields; the server adds them from the ticket. */
export const PresenceIn = z.strictObject({
  type: z.literal('presence'),
  pointer: ScenePoint.nullable(),
  button: z.enum(['up', 'down']),
  sel: PresenceSel,
  view: SceneRect.nullable(),
  idle: z.boolean(),
  /** the lease id of this tab's open editor; renews that lease (never grants one) */
  editing: ElementId.nullable(),
  drag: DragIn.nullable().optional(),
})
export const Ping = z.strictObject({ type: z.literal('ping'), n: NonNegInt.optional() })

export const ClientMessage = z.discriminatedUnion('type', [
  Hello,
  Push,
  LeaseAcquire,
  LeaseRelease,
  PresenceIn,
  Ping,
])
/**
 * Rejections are per op (§3.5): the server parses a frame with `ClientEnvelope` first (a push's ops
 * unchecked), then each op with `Op`, and answers an op that fails `INVALID` in its place in `ack.r`. A
 * frame that fails the envelope is a malformed message (§6.2 `validation`: 4099 INVALID_MESSAGE).
 */
export const PushEnvelope = z
  .strictObject({
    type: z.literal('push'),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    base: Clock,
    ops: z.array(z.unknown()).max(MAX_OPS_PER_PUSH),
    doc: z.unknown().optional(),
  })
  .refine((p) => p.ops.length > 0 || p.doc !== undefined, 'empty push')
export const ClientEnvelope = z.discriminatedUnion('type', [
  Hello,
  PushEnvelope,
  LeaseAcquire,
  LeaseRelease,
  PresenceIn,
  Ping,
])
export type ClientEnvelope = z.infer<typeof ClientEnvelope>
export type Hello = z.infer<typeof Hello>
export type Push = z.infer<typeof Push>
export type LeaseAcquire = z.infer<typeof LeaseAcquire>
export type LeaseRelease = z.infer<typeof LeaseRelease>
export type DragIn = z.infer<typeof DragIn>
export type PresenceIn = z.infer<typeof PresenceIn>
export type Ping = z.infer<typeof Ping>
export type ClientMessage = z.infer<typeof ClientMessage>
/** The lease messages a client sends, as spike A's `LeaseClientMessage`. */
export type LeaseClientMessage = LeaseAcquire | LeaseRelease

// ---- reject and close codes (§2.4.2) -------------------------------------------------------------------

export const REJECT_CODES = [
  'READ_ONLY',
  'LOCKED',
  'LEASED',
  'GONE',
  'ELEMENT_LIMIT',
  'GUEST_LIMIT',
  'VOTE_OPEN',
  'STALE',
  'INVALID',
  'TOO_LARGE',
  'TYPE_CHANGE',
  'RATE',
  'UNAVAILABLE',
] as const
export type RejectCode = (typeof REJECT_CODES)[number]
export const RejectCodeSchema = z.enum(REJECT_CODES)

/**
 * Per code: whether the client retries it, whether it counts toward the abuse close (more than 50 in a
 * minute close the session with 4099 INVALID_MESSAGE), and what the Saved indicator shows (§2.5.7).
 */
export const REJECT_CODE_INFO: Readonly<
  Record<RejectCode, { retryable: boolean; abuse: boolean; ui: 'not-saved' | 'saving' | 'retrying' }>
> = {
  READ_ONLY: { retryable: false, abuse: false, ui: 'not-saved' },
  LOCKED: { retryable: false, abuse: false, ui: 'not-saved' },
  LEASED: { retryable: false, abuse: false, ui: 'not-saved' },
  GONE: { retryable: false, abuse: false, ui: 'not-saved' },
  ELEMENT_LIMIT: { retryable: false, abuse: false, ui: 'not-saved' },
  GUEST_LIMIT: { retryable: false, abuse: false, ui: 'not-saved' },
  VOTE_OPEN: { retryable: false, abuse: false, ui: 'not-saved' },
  STALE: { retryable: false, abuse: false, ui: 'not-saved' },
  INVALID: { retryable: false, abuse: true, ui: 'not-saved' },
  TOO_LARGE: { retryable: false, abuse: true, ui: 'not-saved' },
  TYPE_CHANGE: { retryable: false, abuse: true, ui: 'not-saved' },
  RATE: { retryable: true, abuse: false, ui: 'saving' },
  UNAVAILABLE: { retryable: true, abuse: false, ui: 'retrying' },
}

/** WebSocket close codes: 4099 is terminal on the client, 4000 reconnects. */
export const CLOSE_TERMINAL = 4099
export const CLOSE_RECONNECT = 4000
/** A socket replaced by a newer one of the same session (kept from today's app.ts). */
export const CLOSE_REPLACED = 1000
export const TERMINAL_CLOSE_REASONS = [
  'NOT_AUTHENTICATED',
  'FORBIDDEN',
  'INVALID_MESSAGE',
  'CLIENT_TOO_OLD',
  'SERVER_TOO_OLD',
  'RATE_LIMITED',
  'UNKNOWN_ERROR',
  /** "Lobby is updating" (cut-over and rollback maintenance). */
  'MAINTENANCE',
  /** The R0 stand-in (tldraw sync) refusing a board born on the new canvas (§8.3 B8, pre-open check). */
  'NEW_CANVAS_BOARD',
  /**
   * The ElementRoom could not prepare a tldraw board for the new canvas: its lazy conversion or roll-forward
   * failed (heap cap, time budget, disk check, limits, semantic diff; §5.3, §5.9). The board stays on its
   * tldraw tables; only a maintenance run converts it. Terminal, so joiners do not re-queue the job.
   */
  'CONVERSION_FAILED',
] as const
export type TerminalCloseReason = (typeof TERMINAL_CLOSE_REASONS)[number]
/** 4000: role change, backpressure, a room reopened after a COMMIT failure. */
export const RECONNECT_CLOSE_REASONS = ['RECONNECT'] as const
export type ReconnectCloseReason = (typeof RECONNECT_CLOSE_REASONS)[number]

/**
 * `PREPARING` (CR, O1): the board is being converted or rolled forward on room open (§5.3, §5.9, §2.13). Sent
 * once, right after the socket opens, to a joiner the server holds; its `welcome` follows when the board is
 * ready (or the socket closes 4099 CONVERSION_FAILED). The client shows "Preparing this board…".
 *
 * `CLOSING` (CONTRACTS_REV 9, SMK-2): sent on the Excalidraw engine right before every terminal close
 * (4099) of an upgraded socket, `detail` = the close's reason (a `TerminalCloseReason`, `MAINTENANCE`
 * included). Through an edge that strips close codes and reasons (the Render edge delivered an empty
 * close frame), the client still learns why: a close that follows this notice on the same socket is
 * terminal with `detail` as its reason, whatever the close frame says.
 */
export const NOTICE_CODES = ['SLOW_DOWN', 'LIMIT_NEAR', 'RESYNC', 'DISK', 'PREPARING', 'CLOSING'] as const
export type NoticeCode = (typeof NOTICE_CODES)[number]

// ---- server → client ---------------------------------------------------------------------------------

/**
 * A server op in `changes` (and `welcome.catchUp`). `c`: the full element as stored at its version
 * `el.version` (a create, an undelete, a catch-up row, a server repair); the receiver replaces its copy.
 * A tombstone is never sent in full (CONTRACTS_REV 7, W5-02): a `c` op of a deleted element carries
 * elements.ts `redactTombstone(stored)`; a delete reaches the sessions that held the element live as the
 * `p` op of what the deleting push changed (CONTRACTS_REV 8: exactly, so their copy stays the server's;
 * rev 7 sent `life` alone, and an arrow whose bindings the same delete nulled was revived unbound by its
 * undo); an undelete is always a `c` op of the full live element (a receiver may hold only the redacted
 * form). A receiver that holds the element's content may keep it under a tombstone; only the
 * TOMBSTONE_KEYS of a deleted element are authoritative (hash.ts).
 * `p`: the stored values of the groups that changed (the whole unit for `path`), the new version `v` and
 * `versionNonce` `vn` (C0: the plan named `v`, `pv` and `updated` only, but the convergence hash includes
 * `versionNonce`, and the server owns it, so every receiver must learn it), the previous `pv`, `updated`,
 * and `lobbyServer` when it changed. A receiver whose copy is not at `pv` asks for a resync (a `hello` with
 * its `since`); under the prefix invariant that never happens.
 */
export const ServerCreateOp = z.strictObject({ k: z.literal('c'), el: WireElement })
export const ServerPatchOp = z.strictObject({
  k: z.literal('p'),
  id: ElementId,
  v: z.number().int().positive(),
  vn: z.number().int(),
  pv: NonNegInt,
  updated: Finite.nonnegative(),
  g: GroupPatch.optional(),
  c: LobbyPatch.optional(),
  b: BoundPatch.optional(),
  lobbyServer: LobbyServer.optional(),
})
export const ServerOp = z.discriminatedUnion('k', [ServerCreateOp, ServerPatchOp])
export type ServerOp = z.infer<typeof ServerOp>

/** Who holds a text lease. */
export const LeaseHolder = z.strictObject({ sid: SessionId, uid: Uid, name: z.string().max(200) })
export type LeaseHolder = z.infer<typeof LeaseHolder>
export const LeaseState = z.strictObject({ id: ElementId, holder: LeaseHolder })
/** A person in the room (the roster is uncapped: the people list, search and "(guest)" come from it). */
export const RosterEntry = z.strictObject({
  sid: SessionId,
  uid: Uid,
  name: z.string().max(200),
  color: z.string().max(64),
  role: BoardRoleSchema,
  guest: z.boolean(),
})
export type RosterEntry = z.infer<typeof RosterEntry>
/** A relayed drag (§2.7): `ids` in the first frame after its start (and in `welcome`), then deltas; `end` ends it. */
export const DragOut = z.union([
  z.strictObject({
    sid: SessionId,
    d: NonNegInt,
    ids: z.array(ElementId).min(1).max(MAX_DRAG_IDS).optional(),
    dx: Finite,
    dy: Finite,
  }),
  z.strictObject({ sid: SessionId, d: NonNegInt, end: z.literal(true) }),
])
export type DragOut = z.infer<typeof DragOut>
export const WorkshopState = z.strictObject({ voteOpen: z.boolean(), anonymous: z.boolean() })
export type WorkshopState = z.infer<typeof WorkshopState>
export const WireLimitsSchema = z.strictObject(
  Object.fromEntries(Object.keys(WIRE_LIMITS).map((k) => [k, z.number().int().positive()])) as Record<
    keyof typeof WIRE_LIMITS,
    z.ZodNumber
  >,
)
export type WireLimits = z.infer<typeof WireLimitsSchema>

/**
 * `welcome`: the answer to `hello`. Either a catch-up (`reset: false`, `catchUp` = the rows changed since
 * `since`, tombstones included as redacted `c` ops, CONTRACTS_REV 7) or a reset (`reset: true`, `catchUp: null`, `snapshot`
 * announcing the binary `SnapshotFrame` that is the very next frame). After processing it the client is
 * at `clock` of `epoch`. `leases` are the live leases, `drags` the active drags with their ids.
 */
export const Welcome = z
  .strictObject({
    type: z.literal('welcome'),
    proto: z.literal(PROTO),
    schema: z.number().int().positive(),
    sid: SessionId,
    you: z.strictObject({
      uid: Uid,
      name: z.string().max(200),
      color: z.string().max(64),
      role: BoardRoleSchema,
      guest: z.boolean(),
    }),
    readonly: z.boolean(),
    epoch: Epoch,
    clock: Clock,
    /** Tombstones older than the horizon were purged; a `since` below it gets a reset. */
    horizon: Clock,
    reset: z.boolean(),
    catchUp: z.array(ServerOp).nullable(),
    snapshot: z.strictObject({ elements: NonNegInt, bytes: NonNegInt }).nullable(),
    doc: z.record(z.string(), z.unknown()),
    /**
     * CONTRACTS_REV 9: the clock each `lb_doc` key was last written at, removed keys included (a key in
     * `docClocks` and not in `doc` was removed at that clock). Read with `doc` at the hello, so the two
     * agree. A client deciding a doc write lost with its socket compares the key's clock with the lost
     * push's `base`: at or below it, nothing landed since and the write goes again; above it, a write
     * landed after the push was built (this tab's own when `doc[key]` is the value it wrote, else someone
     * else's, which stands: the write is superseded and the person is told). Optional on the wire for the
     * test doubles; the room always sends it.
     */
    docClocks: z.record(z.string(), Clock).optional(),
    leases: z.array(LeaseState),
    roster: z.array(RosterEntry),
    workshop: WorkshopState,
    drags: z.array(DragOut),
    limits: WireLimitsSchema,
  })
  .refine(
    (w) => (w.reset ? w.snapshot !== null && w.catchUp === null : w.snapshot === null && w.catchUp !== null),
    {
      message: 'a reset carries a snapshot, a catch-up carries catchUp',
    },
  )
/**
 * `changes`: one commit batch, serialized once and sent to every session, the writer included. Also the
 * frame after a cached reset snapshot (the room keeps one for 5 s): the rows changed since the cache's
 * clock and, since CONTRACTS_REV 9 (DEF-3F-1), `doc` with the document keys written since it (null: a
 * key removed), so snapshot + changes equal the board at `clock` for the document too.
 */
export const Changes = z.strictObject({
  type: z.literal('changes'),
  /** the batch's last clock: after it the receiver is at this clock */
  clock: Clock,
  ops: z.array(ServerOp),
  doc: DocSet.optional(),
})
/** Fields the server rewrote: top-level field names, or `c:<key>` for a canonicalized `customData.lobby` key. */
export const FixFields = z.record(z.string().min(1).max(210), z.unknown())
export type FixFields = z.infer<typeof FixFields>
/**
 * One op's answer. `ok: true` with `fix` (only fields the server rewrote: index, a repaired binding,
 * rounded points and, for an unrotated linear element, rounded `x`, `y`, re-snapped bound endpoints of an
 * arrow this push wrote), `fitDropped` when a conditional fit was not applied, and `denied` for a partial
 * accept (the groups not applied, e.g. `text`/`layout`/`life` under someone else's lease). `ok: false`
 * with the code and the stored element (null when there is none; a tombstone redacted, CONTRACTS_REV 7),
 * so the client can reset.
 */
export const AckResult = z.discriminatedUnion('ok', [
  z.strictObject({
    id: ElementId,
    ok: z.literal(true),
    v: z.number().int().positive(),
    fix: FixFields.optional(),
    fitDropped: z.literal(true).optional(),
    denied: z
      .strictObject({ groups: z.array(z.string().min(1).max(210)).min(1), code: RejectCodeSchema })
      .optional(),
  }),
  /** `id`: the op's id as sent (`''` when an op that failed `Op` had no usable id); `ack.r` is in op order */
  z.strictObject({
    id: z.string().max(200),
    ok: z.literal(false),
    code: RejectCodeSchema,
    el: WireElement.nullable(),
  }),
])
export type AckResult = z.infer<typeof AckResult>
/** An element the server re-snapped because of this push's ops although the push did not write it. */
export const DerivedRow = z.strictObject({ id: ElementId, v: z.number().int().positive(), fix: FixFields })
export type DerivedRow = z.infer<typeof DerivedRow>
/**
 * `ack`: after COMMIT only (so Saved means on disk), after the batch's `changes`. `clock` is this push's
 * clock (the push's own, even when it rode in a batch). `r` answers every op in order.
 */
export const Ack = z.strictObject({
  type: z.literal('ack'),
  seq: z.number().int().positive(),
  clock: Clock,
  r: z.array(AckResult),
  derived: z.array(DerivedRow).optional(),
  /** doc keys not applied, with why */
  docDenied: z.strictObject({ keys: z.array(z.string()).min(1), code: RejectCodeSchema }).optional(),
})
export const LeaseGrant = z.strictObject({
  type: z.literal('lease.grant'),
  req: NonNegInt,
  id: ElementId,
  ttlMs: z.number().int().positive(),
})
export const LeaseDeny = z.strictObject({
  type: z.literal('lease.deny'),
  req: NonNegInt,
  id: ElementId,
  holder: LeaseHolder,
})
export const LeaseBroadcast = z.strictObject({
  type: z.literal('lease'),
  id: ElementId,
  holder: LeaseHolder.nullable(),
})
export const RosterEvent = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('join'), p: RosterEntry }),
  z.strictObject({ k: z.literal('leave'), sid: SessionId }),
  z.strictObject({ k: z.literal('update'), p: RosterEntry }),
])
export const Roster = z.strictObject({ type: z.literal('roster'), events: z.array(RosterEvent).min(1) })
/** One peer in a presence frame (identity is in the roster, by `sid`). `sel` is null while a dot vote is open. */
export const PeerPresence = z.strictObject({
  sid: SessionId,
  pointer: ScenePoint.nullable(),
  button: z.enum(['up', 'down']),
  sel: PresenceSel.nullable(),
  view: SceneRect.nullable(),
  idle: z.boolean(),
  editing: ElementId.nullable(),
})
export type PeerPresence = z.infer<typeof PeerPresence>
/** `presence` out, 10 Hz, changed peers only; `off`: peers this recipient no longer gets (the 40-cursor cap). */
export const PresenceOut = z.strictObject({
  type: z.literal('presence'),
  peers: z.array(PeerPresence),
  off: z.array(SessionId).optional(),
  drags: z.array(DragOut).optional(),
})
export const Workshop = z.strictObject({
  type: z.literal('workshop'),
  voteOpen: z.boolean(),
  anonymous: z.boolean(),
})
export const Notice = z.strictObject({
  type: z.literal('notice'),
  code: z.enum(NOTICE_CODES),
  detail: z.string().max(200).optional(),
})
export const Pong = z.strictObject({ type: z.literal('pong'), n: NonNegInt.optional() })

export const ServerMessage = z.discriminatedUnion('type', [
  Welcome,
  Changes,
  Ack,
  LeaseGrant,
  LeaseDeny,
  LeaseBroadcast,
  Roster,
  PresenceOut,
  Workshop,
  Notice,
  Pong,
])
export type Welcome = z.infer<typeof Welcome>
export type Changes = z.infer<typeof Changes>
export type Ack = z.infer<typeof Ack>
export type LeaseGrant = z.infer<typeof LeaseGrant>
export type LeaseDeny = z.infer<typeof LeaseDeny>
export type LeaseBroadcast = z.infer<typeof LeaseBroadcast>
export type Roster = z.infer<typeof Roster>
export type PresenceOut = z.infer<typeof PresenceOut>
export type Workshop = z.infer<typeof Workshop>
export type Notice = z.infer<typeof Notice>
export type Pong = z.infer<typeof Pong>
export type ServerMessage = z.infer<typeof ServerMessage>
/** The lease messages a client receives, as spike A's `LeaseServerMessage`. */
export type LeaseServerMessage = LeaseGrant | LeaseDeny | LeaseBroadcast
export { LEASE_TTL_MS }

// ---- the binary snapshot frame ------------------------------------------------------------------------------

/**
 * The frame after a `welcome` with `reset: true`: gzip of the UTF-8 JSON of this object. It carries the
 * live elements AND the tombstones the server holds (rows with `deleted = 1` within the horizon), in
 * `(index, id)` order, so every client's element map holds every tombstone the server holds and
 * convergence is checked including deleted elements (hash.ts). Since CONTRACTS_REV 7 (W5-02) every
 * tombstone is `redactTombstone(stored)`: no role, the owner's included, receives a deleted element's
 * text, authors or other content over the canvas socket ("Recently deleted" is the api's, owner/editor
 * only). Compressed once per cached snapshot.
 */
export const SnapshotFrame = z.strictObject({
  type: z.literal('snapshot'),
  epoch: Epoch,
  clock: Clock,
  horizon: Clock,
  elements: z.array(WireElement),
  doc: z.record(z.string(), z.unknown()),
  /** CONTRACTS_REV 9: as `welcome.docClocks`, for the document as the snapshot has it. */
  docClocks: z.record(z.string(), Clock).optional(),
})
export type SnapshotFrame = z.infer<typeof SnapshotFrame>

async function pipeBytes(
  bytes: Uint8Array,
  transform: { readable: ReadableStream; writable: WritableStream },
) {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
/** gzip(JSON) of a snapshot frame, with the platform's `CompressionStream` (browsers and Node 24). */
export async function encodeSnapshotFrame(frame: SnapshotFrame): Promise<Uint8Array> {
  return pipeBytes(new TextEncoder().encode(JSON.stringify(frame)), new CompressionStream('gzip'))
}
/** The inverse of `encodeSnapshotFrame` (any gzip encoder's output), validated. */
export async function decodeSnapshotFrame(bytes: Uint8Array): Promise<SnapshotFrame> {
  const json = new TextDecoder().decode(await pipeBytes(bytes, new DecompressionStream('gzip')))
  return SnapshotFrame.parse(JSON.parse(json))
}

// ---- test-only routes (§2.4.6; behind DRAFTROOM_TEST_HOOKS=1 and the internal secret) ------------------------

/**
 * `GET /internal/test/boards/:bid/snapshot`: the live elements and EVERY tombstone (`lb_elements` rows
 * with `deleted = 1`, as stored: in full, test-only behind the secret), in `(id)` order, hashed exactly by
 * hash.ts (a tombstone by its TOMBSTONE_KEYS). `horizon` (revision 3.4) lets the
 * harness see a compaction purge inside a check window (§8.1): a check whose horizon moved is re-run.
 */
export const TestSnapshot = z.strictObject({
  clock: Clock,
  epoch: Epoch,
  horizon: Clock,
  elements: z.array(WireElement),
})
export type TestSnapshot = z.infer<typeof TestSnapshot>
/**
 * `POST /internal/test/boards/:bid/lease-hook`: the next grants on that board are delayed by `ms`, held
 * until `release`, or normal again (`off`). 204.
 */
export const LeaseHookRequest = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('delay'), ms: z.number().int().min(0).max(60_000) }),
  z.strictObject({ mode: z.literal('hold') }),
  z.strictObject({ mode: z.literal('release') }),
  z.strictObject({ mode: z.literal('off') }),
])
export type LeaseHookRequest = z.infer<typeof LeaseHookRequest>
/** `POST /internal/test/boards/:bid/fail-commit`: the next `count` COMMITs of that room throw. 204. */
export const FailCommitRequest = z.strictObject({ count: z.number().int().min(1).max(100) })
export type FailCommitRequest = z.infer<typeof FailCommitRequest>
export const TEST_HOOK_PATHS = {
  snapshot: (boardId: string) => `/internal/test/boards/${encodeURIComponent(boardId)}/snapshot`,
  leaseHook: (boardId: string) => `/internal/test/boards/${encodeURIComponent(boardId)}/lease-hook`,
  failCommit: (boardId: string) => `/internal/test/boards/${encodeURIComponent(boardId)}/fail-commit`,
} as const

/** Re-exported so wire consumers need one import. */
export { CustomData }
