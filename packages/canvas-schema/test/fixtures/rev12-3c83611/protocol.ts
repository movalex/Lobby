// FROZEN FIXTURE, never edit. This is
//   packages/canvas-schema/src/protocol.ts
// of commit 3c83611 (the web deployed on staging since hotfix H2 (wave M): CONTRACTS_REV 12), as
// `git show 3c83611:<that path>` gives it (blob ed990ba0604f). The deployed web parses every server
// frame with these schemas (its socket transport, apps/web/src/canvas/sync/transport/socket.ts at that
// commit: `ServerMessage.safeParse` on each text frame, the gzip snapshot through `decodeSnapshotFrame`),
// so the stale-pair tests parse the room's frames with them (docs/EXCALIDRAW-CONTRACTS.md §0b, the
// per-reader downgrade rule). Changed from the commit:
// these header lines only.
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
 * Revision 10 (wave A, A2: CR-3C-1, CR-3CF-1): presence carries a follow target (`f`) and the sender's
 * zoom (`view.z`); a recipient always gets the peer it follows (outside the 40-cursor cap) and the list
 * of sessions that follow it (`followers`); the shown set re-ranks (`off` evicts out-of-view peers). The
 * room says it speaks rev 10 with a `contracts` frame after the welcome; a client sends `f` and `view.z`
 * only after that frame, and the room sends the rev-10 fields only to a session that has sent `f`, so a
 * rev-9 client and a rev-9 room are served as before (`PresenceIn`/`PeerPresence` are strict both ways).
 * Revision 11 (wave C, C2: W5-ENG-2, push receipts): a push may carry a receipt id `rid` (client-made,
 * unique per page) that the room records with the push's COMMIT (a small ring per user in the board file,
 * `lb_receipts`); after a reconnect the client asks which of the receipts of its lost pushes landed
 * (`receipts` query, answered by a `receipts` frame), so it decides every lost push exactly, instead of
 * counting the writes since (the residual of V1's re-checks: a push that never arrived and two or more
 * other writes in the window, the doc-key DB2). Additive and gated like rev 10: a client sends `rid` and
 * the query only on a socket whose room sent `contracts` with `rev >= RECEIPTS_REV` (a rev-10 room refuses
 * both: strict); a rev-10 client sends neither and is served as before; a rev-11 room's `contracts` frame
 * says 11, which a rev-10 client reads as "rev 10 or later".
 * Revision 12 (wave L foundation; owner W6, the canvas-schema and presence owner of wave L): the shared
 * laser. `PresenceIn.t` ('laser' while the laser tool is pressed, else null) and `trail` (the samples since
 * the last send, at most MAX_LASER_TRAIL_POINTS integer scene points), relayed as `PeerPresence.t` and
 * `trail`. Additive and gated per socket exactly like rev 10's `f`: a client sends `t` (null included) in
 * every presence message, and `trail` with it, only on a socket whose room's `contracts` frame named
 * PRESENCE_LASER_REV or later (a rev-11 room refuses both: strict), and that is how the room knows the
 * socket reads them; every other socket gets the entries `presenceForReader` gives its revision (no `t`, no
 * `trail`), which a rev-11 client's strict parse accepts. A rev-11 client never sends `t` and is served as
 * before; a rev-12 room's `contracts` frame says 12, which it reads as "rev 10 (or 11) or later". Rev 12
 * also marks the wave L sync build: `customData.lobby.present.mins` is accepted (PRESENT_MINS_REV) and the
 * restore-elements internal route exists (RESTORE_ELEMENTS_REV); clients read the room's revision
 * (CanvasPort `room.contractsRev()`) to offer either.
 * DEPLOY (foundation review): because 12 also means "the whole wave L sync", a sync built from the wave L
 * foundation alone must never be deployed. It says 12 but relays the laser to nobody and has no
 * restore-elements route, so a wave L web would offer a laser nobody sees and a "Restore these" that gets 503,
 * and the rev gate (the fallback "hold the sync, the web hides all three") would stop working. The sync ships
 * once, carrying W6's relay and W7's route, after the O1/O2 sign-off for this bump is recorded in PROGRESS.
 * Readers (the integration's stale pair (c)): the deployed rev-11 web parses each frame with its strict
 * `ServerMessage` and drops the whole frame on one unknown field or value (`present.mins` in a `p` op's `c`),
 * and it stays open for days after a deploy. So from rev 12 every frame the room sends goes through
 * `frameForReader` for its socket's revision (the connect URL's `rev`, CONNECT_REV_PARAM; none: UNANNOUNCED_REV
 * 11), and a write from an older socket keeps the fields it cannot know (`lobbyWriteOf`,
 * LOBBY_FIELD_ADDITIONS). A rev-12 client names its revision in the connect URL to every room.
 */
export const CONTRACTS_REV = 12
/**
 * The first contracts revision whose presence has `f`, `view.z` and `followers` (see `CONTRACTS_REV`).
 * A client sends them only to a room whose `contracts` frame names this revision or a later one.
 */
export const PRESENCE_FOLLOW_REV = 10
/**
 * The first contracts revision with push receipts (`Push.rid`, `ReceiptsQuery`, `Receipts`; see
 * `CONTRACTS_REV`). A client sends them only to a room whose `contracts` frame names this revision or a later one.
 */
export const RECEIPTS_REV = 11
/**
 * The first contracts revision whose presence has the laser (`t`, `trail`; see `CONTRACTS_REV`). A client
 * sends them only to a room whose `contracts` frame names this revision or a later one.
 */
export const PRESENCE_LASER_REV = 12
/**
 * The first contracts revision whose sync accepts `customData.lobby.present.mins` (custom-data.ts; W5's run
 * of show). A web shows the minutes stepper only in a room whose `contracts` frame names this or later, so a
 * web deployed before the sync never sends a value an older sync refuses.
 */
export const PRESENT_MINS_REV = 12
/**
 * The first contracts revision whose sync serves `POST /internal/boards/:bid/restore-elements` (W7's
 * selective restore; @draftroom/contracts sync-internal.ts). Not a wire change: the web shows "Restore these"
 * only in a room at this revision or later, and the api answers 503 RESTORE_UNAVAILABLE when the sync
 * answers 404 (an older sync).
 */
export const RESTORE_ELEMENTS_REV = 12
/**
 * The connect URL's parameter that names the contracts revision a client reads (CONTRACTS_REV 12 on):
 * `/connect/:boardId?sessionId=…&rev=<CONTRACTS_REV>`. It tells the room before its first frame (the welcome)
 * and before the client's first push, which a revision learned from presence (`f`, `t`) cannot: the room then
 * serves that socket every frame in its revision's form (`frameForReader`) and keeps the fields a writer of an
 * older revision cannot know (`lobbyWriteOf`). A rev-11 room ignores the parameter (it reads only `sessionId`
 * and the ticket), so a client sends it to every room.
 */
export const CONNECT_REV_PARAM = 'rev'
/**
 * The revision the room reads a socket at when its connect URL names none: every web built before
 * CONTRACTS_REV 12 (the web deployed with wave K, 437b4e7, is rev 11). A socket that sends `t` in presence is
 * a rev-12 reader from then on (it could only have learned `t` from a rev-12 room's `contracts` frame).
 */
export const UNANNOUNCED_REV = 11
/** The connect URL's `rev` as the room takes it: a whole number of at least 1, else null (an older client). */
export function connectRevOf(param: string | null | undefined): number | null {
  if (typeof param !== 'string' || !/^[1-9][0-9]{0,5}$/.test(param)) return null
  return Number(param)
}
/** A push's receipt id (CONTRACTS_REV 11): made by the client, unique per page (`<page nonce>.<seq>`). */
export const ReceiptId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/)
/** The most receipt ids one `receipts` query names (a reconnect has at most a few pushes out). */
export const MAX_RECEIPT_IDS = 64
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
/**
 * `push`: ≤ 500 ops and ≤ 512 KiB (the frame ≤ 1 MiB). Each accepted push gets its own clock. `rid`
 * (CONTRACTS_REV 11): its receipt id, recorded by the room with the push's COMMIT when the push wrote and
 * no op of it was refused with a retryable code; sent only to a rev-11 room (see `CONTRACTS_REV`).
 */
export const Push = z
  .strictObject({
    type: z.literal('push'),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    base: Clock,
    ops: z.array(Op).max(MAX_OPS_PER_PUSH),
    doc: DocSetChecked.optional(),
    rid: ReceiptId.optional(),
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
/** The largest zoom presence may carry in `view.z` (Excalidraw's own range is 0.1 to 30). */
export const MAX_PRESENCE_ZOOM = 1_000
/**
 * A visible scene rectangle. `z` (CONTRACTS_REV 10, CR-3CF-1): the sender's zoom (screen px per scene
 * unit), so a follower can match it (a gathered phone's readable zoom, R2-04); optional, and sent only
 * to and by rev-10 ends (see `CONTRACTS_REV`): a rev-9 end refuses it (strict).
 */
export const SceneRect = z.strictObject({
  x: Finite,
  y: Finite,
  w: Finite.nonnegative(),
  h: Finite.nonnegative(),
  z: Finite.positive().max(MAX_PRESENCE_ZOOM).optional(),
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
/** The most laser samples one presence entry relays (CONTRACTS_REV 12): a longer `trail` in is dropped. */
export const MAX_LASER_TRAIL_POINTS = 6
/**
 * The most laser samples a presence message may carry at all (CONTRACTS_REV 12): above it the message is
 * INVALID; between MAX_LASER_TRAIL_POINTS and this the room drops the trail and keeps the rest (as a drag
 * above MAX_DRAG_IDS is dropped and one above MAX_DRAG_IDS_WIRE is INVALID).
 */
export const MAX_LASER_TRAIL_POINTS_WIRE = 32
/** A laser sample: an integer scene point inside the coordinate limit. */
export const LaserPoint = z.strictObject({
  x: z.number().int().gte(-COORD_LIMIT).lte(COORD_LIMIT),
  y: z.number().int().gte(-COORD_LIMIT).lte(COORD_LIMIT),
})
export type LaserPoint = z.infer<typeof LaserPoint>
/** What the pointer is doing beyond pointing (CONTRACTS_REV 12): only the laser today. */
export const PRESENCE_TOOLS = ['laser'] as const
export const PresenceTool = z.enum(PRESENCE_TOOLS)
export type PresenceTool = z.infer<typeof PresenceTool>

/**
 * `presence` (≤ 20 Hz, bypasses the FIFO): no identity fields; the server adds them from the ticket.
 *
 * `f` (CONTRACTS_REV 10, CR-3C-1): the session this tab follows (its camera follows their `view`), or
 * null. A client sends it, and `view.z`, only to a room that announced rev 10 (the `contracts` frame);
 * once it has, it sends `f` (null included) in every presence message, and that is how the room knows
 * this socket reads the rev-10 presence fields. A rev-9 room refuses both (strict: INVALID_MESSAGE).
 *
 * `t` and `trail` (CONTRACTS_REV 12, the shared laser): `t` is 'laser' while this tab's laser is pressed,
 * else null; `trail` the samples taken since the previous send (integer scene points, oldest first), only
 * with `t: 'laser'`. A client sends `t` (null included) in every presence message on a socket whose room
 * announced PRESENCE_LASER_REV or later, and that is how the room knows this socket reads the rev-12
 * presence fields; a rev-11 room refuses both (strict). The room drops a `trail` sent without `t: 'laser'`
 * or with more than MAX_LASER_TRAIL_POINTS points and keeps the rest of the message; above
 * MAX_LASER_TRAIL_POINTS_WIRE the message is INVALID. Nothing of it is ever stored.
 */
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
  f: SessionId.nullable().optional(),
  t: PresenceTool.nullable().optional(),
  trail: z.array(LaserPoint).max(MAX_LASER_TRAIL_POINTS_WIRE).optional(),
})
export const Ping = z.strictObject({ type: z.literal('ping'), n: NonNegInt.optional() })
/**
 * `receipts` (CONTRACTS_REV 11, W5-ENG-2): which of these receipt ids (pushes this user sent with `rid`,
 * lost with a socket or a page) the room committed. Ordered with this session's pushes and answered after
 * the room's next COMMIT (so every push queued before it is decided). Sent only to a rev-11 room.
 */
export const ReceiptsQuery = z.strictObject({
  type: z.literal('receipts'),
  req: NonNegInt,
  ids: z.array(ReceiptId).min(1).max(MAX_RECEIPT_IDS),
})

export const ClientMessage = z.discriminatedUnion('type', [
  Hello,
  Push,
  LeaseAcquire,
  LeaseRelease,
  PresenceIn,
  Ping,
  ReceiptsQuery,
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
    rid: ReceiptId.optional(),
  })
  .refine((p) => p.ops.length > 0 || p.doc !== undefined, 'empty push')
export const ClientEnvelope = z.discriminatedUnion('type', [
  Hello,
  PushEnvelope,
  LeaseAcquire,
  LeaseRelease,
  PresenceIn,
  Ping,
  ReceiptsQuery,
])
export type ClientEnvelope = z.infer<typeof ClientEnvelope>
export type Hello = z.infer<typeof Hello>
export type Push = z.infer<typeof Push>
export type LeaseAcquire = z.infer<typeof LeaseAcquire>
export type LeaseRelease = z.infer<typeof LeaseRelease>
export type DragIn = z.infer<typeof DragIn>
export type PresenceIn = z.infer<typeof PresenceIn>
export type Ping = z.infer<typeof Ping>
export type ReceiptsQuery = z.infer<typeof ReceiptsQuery>
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
 * frame after a cached reset snapshot (the room keeps one for up to 60 s, and only while the board is at most
 * 500 rows ahead of it: `SNAPSHOT_REUSE` in `apps/sync/src/room/element-room.ts`, since ac72d87f): the rows
 * changed since the cache's clock and, since CONTRACTS_REV 9 (DEF-3F-1), `doc` with the document keys written
 * since it (null: a key removed), so snapshot + changes equal the board at `clock` for the document too.
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
/**
 * One peer in a presence frame (identity is in the roster, by `sid`). `sel` is null while a dot vote is
 * open. To a rev-10 recipient (one that sent `f`) only: `f`, the session this peer follows (left out when
 * it follows nobody), and `view.z`, its zoom; a rev-9 recipient gets neither (its parse is strict).
 * To a rev-12 recipient (one that sent `t`) only: `t` while the peer's laser is pressed (left out
 * otherwise) and `trail`, its latest samples (at most MAX_LASER_TRAIL_POINTS); a rev-11 recipient gets
 * neither (its parse is strict). `presenceForReader` is the one rule for what each revision gets.
 */
export const PeerPresence = z.strictObject({
  sid: SessionId,
  pointer: ScenePoint.nullable(),
  button: z.enum(['up', 'down']),
  sel: PresenceSel.nullable(),
  view: SceneRect.nullable(),
  idle: z.boolean(),
  editing: ElementId.nullable(),
  f: SessionId.nullable().optional(),
  t: PresenceTool.optional(),
  trail: z.array(LaserPoint).max(MAX_LASER_TRAIL_POINTS).optional(),
})
export type PeerPresence = z.infer<typeof PeerPresence>

/**
 * The presence revisions a recipient socket can read (CONTRACTS_REV 9 to 12 change presence at 10 and 12):
 * 9 (it never sent `f`), 10 (it sent `f`: rev 10 and 11 clients) and 12 (it sent `t`).
 */
export type PresenceReaderRev = 9 | 10 | 12
/** The presence revision of a client that announced contracts revision `rev` by what it sends. */
export const presenceReaderRev = (rev: number): PresenceReaderRev =>
  rev >= PRESENCE_LASER_REV ? 12 : rev >= PRESENCE_FOLLOW_REV ? 10 : 9

/**
 * What the room sends a recipient that reads presence revision `reader` of a peer's full entry (the one
 * rule, CONTRACTS_REV 12): a rev-10 reader (rev 10 and 11 clients) gets no `t` and no `trail`, a rev-9 reader
 * also no `f` and no `view.z`. Returns `peer` itself when nothing is to be left out (no copy per recipient).
 * The result always parses with the reader's own strict schema (protocol.test.ts pins it).
 */
export function presenceForReader(peer: PeerPresence, reader: PresenceReaderRev): PeerPresence {
  if (reader >= 12) return peer
  const laser = peer.t !== undefined || peer.trail !== undefined
  const follow = reader < 10 && (peer.f !== undefined || peer.view?.z !== undefined)
  if (!laser && !follow) return peer
  const { t: _t, trail: _trail, ...rest } = peer
  if (!follow) return rest
  const { f: _f, ...plain } = rest
  const v = plain.view
  return { ...plain, view: v ? { x: v.x, y: v.y, w: v.w, h: v.h } : null }
}
/** The most session ids one `followers` list carries (a room has fewer sessions than this in practice). */
export const MAX_FOLLOWERS = 2_000
/**
 * `presence` out, 10 Hz, changed peers only. Above 41 sessions a recipient gets at most 40 cursors (peers
 * in its `view` first, then the ones it already gets), plus, always and outside the cap, the peer it
 * follows (CONTRACTS_REV 10); `off`: peers this recipient no longer gets (evicted by that ranking: a
 * re-rank on every tick, so a view change or a newcomer in view replaces an out-of-view cursor).
 *
 * `followers` (CONTRACTS_REV 10, rev-10 recipients only, CR-3C-1): the sessions whose `f` is this
 * recipient, the whole list (sorted, at most MAX_FOLLOWERS), in a frame whenever it changed (`[]`: nobody
 * follows it any more); a recipient that has not received one holds none. Uncapped, unlike the cursors,
 * so a facilitator sees everyone a "Gather everyone" made follow them without 200 cursors.
 */
export const PresenceOut = z.strictObject({
  type: z.literal('presence'),
  peers: z.array(PeerPresence),
  off: z.array(SessionId).optional(),
  drags: z.array(DragOut).optional(),
  followers: z.array(SessionId).max(MAX_FOLLOWERS).optional(),
})
/**
 * `contracts` (CONTRACTS_REV 10): the room's contracts revision, sent once per socket right after the
 * welcome (and its snapshot and catch-up frames), before the late joiner's presence. A client that gets
 * `rev >= PRESENCE_FOLLOW_REV` may send the rev-10 presence fields on this socket; one that gets no such
 * frame (a rev-9 room) must not. A rev-9 client drops it as an unknown frame (its transport drops a frame
 * its schema refuses, with no other effect).
 */
export const Contracts = z.strictObject({
  type: z.literal('contracts'),
  rev: z.number().int().positive(),
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
/**
 * `receipts` (CONTRACTS_REV 11, W5-ENG-2): the answer to a `receipts` query (same `req`). `landed`: each
 * named receipt the room holds for this user, with the clock its push committed at. A named receipt that
 * is not there did NOT land, provided it could still be held: the room keeps this user's receipts complete
 * from clock `from` on (older ones may have been trimmed: a ring per user, and an age limit), and a push
 * built on base `b` lands at a clock above `b`, so the absence is conclusive when `b + 1 >= from`; for an
 * older push it says nothing, and the client counts the writes since, as before rev 11.
 */
export const Receipts = z
  .strictObject({
    type: z.literal('receipts'),
    req: NonNegInt,
    landed: z.record(ReceiptId, Clock),
    from: Clock,
  })
  .refine((r) => Object.keys(r.landed).length <= MAX_RECEIPT_IDS, 'too many receipts')

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
  Contracts,
  Receipts,
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
export type Contracts = z.infer<typeof Contracts>
export type Receipts = z.infer<typeof Receipts>
export type ServerMessage = z.infer<typeof ServerMessage>
/** The lease messages a client receives, as spike A's `LeaseServerMessage`. */
export type LeaseServerMessage = LeaseGrant | LeaseDeny | LeaseBroadcast
export { LEASE_TTL_MS }

// ---- the per-reader rule (CONTRACTS_REV 12, docs/EXCALIDRAW-CONTRACTS.md §0b) -------------------------------

/**
 * A field that a revision after 11 added to a `customData.lobby` value (11: the oldest revision whose clients
 * are still open, the deployed web). A reader below `since` refuses a value that has it: its `LobbyPatch`
 * checks each value with its own strict schema, and its socket drops the whole frame that carries it (stale
 * pair (c), wave L: one `present.mins` in a `changes` frame lost every op of that frame, for good once a
 * later frame moved the tab's clock past it). A writer below `since` cannot know the field, so its writes of
 * the key keep it (`lobbyWriteOf`): every field of `present` is independent of the others (index, skip,
 * mins), so an older writer's whole-value write of it, or its removal of the key, never means "no minutes".
 */
export interface LobbyFieldAddition {
  readonly key: string
  readonly field: string
  readonly since: number
}
/** Every field added to a `customData.lobby` value after revision 11 (custom-data.ts), with its revision. */
export const LOBBY_FIELD_ADDITIONS: readonly LobbyFieldAddition[] = [
  { key: 'present', field: 'mins', since: PRESENT_MINS_REV },
]

const additionsOf = (rev: number, key: string): LobbyFieldAddition[] =>
  rev >= CONTRACTS_REV ? [] : LOBBY_FIELD_ADDITIONS.filter((a) => a.key === key && a.since > rev)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether `value` (of `customData.lobby[key]`) has a field that a reader of revision `reader` does not know. */
export function lobbyValueNewerThan(reader: number, key: string, value: unknown): boolean {
  if (!isRecord(value)) return false
  return additionsOf(reader, key).some((a) => a.field in value)
}

/** `value` without the fields a reader of revision `reader` does not know; `value` itself when it has none. */
export function lobbyValueForReader(reader: number, key: string, value: unknown): unknown {
  if (!lobbyValueNewerThan(reader, key, value)) return value
  const out = { ...(value as Record<string, unknown>) }
  for (const a of additionsOf(reader, key)) delete out[a.field]
  return out
}

/**
 * What the room stores when a writer of revision `writer` writes `written` (null: a removal) to
 * `customData.lobby[key]`, whose stored value is `stored`: the fields that writer cannot know
 * (LOBBY_FIELD_ADDITIONS above its revision) are kept from `stored` when `written` lacks them, and a removal
 * leaves them alone (`present: null` from a rev-11 tab cleared index and skip, never the minutes). `written`
 * itself when nothing is kept: a writer of this revision, or nothing stored to keep.
 */
export function lobbyWriteOf(writer: number, key: string, written: unknown, stored: unknown): unknown {
  if (!isRecord(stored)) return written
  const keep = additionsOf(writer, key).filter((a) => a.field in stored)
  if (!keep.length) return written
  if (written !== null && !isRecord(written)) return written
  const out: Record<string, unknown> = written === null ? {} : { ...written }
  let kept = false
  for (const a of keep)
    if (!(a.field in out)) {
      out[a.field] = stored[a.field]
      kept = true
    }
  return kept ? out : written
}

/** The stored element of a `p` op's id, for a translation into a `c` op (the room: the batch's elements). */
export type StoredElementOf = (id: string) => WireElement | undefined

/**
 * One server op as a reader of revision `reader` must get it; the op itself when nothing is to change.
 *  - A `c` op is never changed: every revision of the same ELEMENT_SCHEMA_VERSION takes a WireElement's
 *    `customData.lobby` values as they are (`CustomData.lobby` is a record of unknown values; only
 *    `LobbyPatch` checks them), and a new element field is an ELEMENT_SCHEMA_VERSION bump, which the hello
 *    handles. So a catch-up, a snapshot and every create reach every reader whole.
 *  - A `p` op whose `c` has a value with a field the reader does not know becomes the `c` op of the element as
 *    stored (`stored`): the reader parses it and loses nothing, so its copy stays the server's exactly (the
 *    client diffs its own pushes and decides lost ones against that copy). A deleted element is never sent in
 *    full (W5-02: a tombstone travels redacted), so its patch keeps its form with those fields left out, which
 *    changes nothing a reader compares (a tombstone is compared by hash.ts TOMBSTONE_KEYS only); and so does a
 *    patch whose stored element the caller does not have.
 */
export function opForReader(reader: number, op: ServerOp, stored?: StoredElementOf): ServerOp {
  if (reader >= CONTRACTS_REV || op.k === 'c' || !op.c) return op
  const c = op.c as Record<string, unknown>
  const newer = Object.keys(c).filter((k) => lobbyValueNewerThan(reader, k, c[k]))
  if (!newer.length) return op
  const el = stored?.(op.id)
  if (el && !el.isDeleted && el.id === op.id && el.version === op.v) return { k: 'c', el }
  const patch: Record<string, unknown> = { ...c }
  for (const k of newer) patch[k] = lobbyValueForReader(reader, k, c[k])
  return { ...op, c: patch }
}

/**
 * THE per-reader rule (CONTRACTS_REV 12): `frame` as a reader of contracts revision `reader` must get it, so
 * that its strict `ServerMessage` parses it. A client's socket drops a whole frame its schema refuses (the web's
 * transport since C0), so a frame with one field its revision does not know loses everything in it, silently.
 * Returns `frame` itself when nothing is to change (every frame to a reader of this revision). The room sends
 * every frame through it, at one place (apps/sync/src/room/reader-frames.ts, element-room.ts `Session.send`),
 * by the socket's revision (its connect URL's `rev`, CONNECT_REV_PARAM). By type:
 *  - `changes`, and the catch-up of a `welcome`: each op by `opForReader`;
 *  - `presence`: each peer by `presenceForReader` for the reader's presence revision (no `t`, no `trail` below 12);
 *  - `ack`: unchanged (no revision checks a `fix` value or a refusal's element per key; a `fix` of a
 *    `customData.lobby` key carries the stored value, the one its `changes` op gave the reader);
 *  - every other type (`welcome`'s other fields, `lease.*`, `roster`, `workshop`, `notice`, `pong`, `contracts`,
 *    `receipts`): unchanged, none of them changed after revision 11.
 * A later revision that adds a field or a value to any server message adds its rule here (and its field to
 * LOBBY_FIELD_ADDITIONS when it is one of a `customData.lobby` value), with a test that parses the downgraded
 * frames with the previous build's own frozen schemas (packages/canvas-schema/test/fixtures/).
 */
export function frameForReader(
  reader: number,
  frame: ServerMessage,
  stored?: StoredElementOf,
): ServerMessage {
  if (reader >= CONTRACTS_REV) return frame
  switch (frame.type) {
    case 'changes': {
      const ops = mapSame(frame.ops, (op) => opForReader(reader, op, stored))
      return ops === frame.ops ? frame : { ...frame, ops }
    }
    case 'welcome': {
      if (!frame.catchUp) return frame
      const catchUp = mapSame(frame.catchUp, (op) => opForReader(reader, op, stored))
      return catchUp === frame.catchUp ? frame : { ...frame, catchUp }
    }
    case 'presence': {
      const form = presenceReaderRev(reader)
      const peers = mapSame(frame.peers, (p) => presenceForReader(p, form))
      return peers === frame.peers ? frame : { ...frame, peers }
    }
    default:
      return frame
  }
}

/** `xs.map(f)`, or `xs` itself when `f` returned every item unchanged (no copy per reader). */
function mapSame<T>(xs: readonly T[], f: (x: T) => T): T[] {
  let out: T[] | null = null
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] as T
    const y = f(x)
    if (y !== x && !out) out = xs.slice(0, i)
    if (out) out.push(y)
  }
  return out ?? (xs as T[])
}

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
