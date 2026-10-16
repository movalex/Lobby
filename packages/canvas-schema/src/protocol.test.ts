/**
 * Contract tests of protocol.ts (spike B contracts step C0): a zod round trip for EVERY message in both
 * directions, the snapshot frame, and the test-hook bodies; plus the refusals the wire itself makes
 * (unknown keys, identity in presence, a `path` patch that is not whole, the size caps).
 */
import { describe, expect, it } from 'vitest'
import { type ZodType, z } from 'zod'
import { pathUnitOf } from './groups.ts'
import { LEASE_TTL_MS, MAX_OPS_PER_PUSH, WIRE_LIMITS } from './limits.ts'
import {
  Ack,
  Changes,
  ClientEnvelope,
  ClientMessage,
  CONTRACTS_REV,
  Contracts,
  decodeSnapshotFrame,
  encodeSnapshotFrame,
  FailCommitRequest,
  GROUP_FIELDS,
  GROUP_NAMES,
  Hello,
  LeaseAcquire,
  LeaseBroadcast,
  LeaseDeny,
  LeaseGrant,
  LeaseHookRequest,
  LeaseRelease,
  MAX_FOLLOWERS,
  MAX_LASER_TRAIL_POINTS,
  MAX_LASER_TRAIL_POINTS_WIRE,
  MAX_PRESENCE_ZOOM,
  MAX_RECEIPT_IDS,
  Notice,
  Op,
  PatchOp,
  PeerPresence,
  Ping,
  Pong,
  PRESENCE_FOLLOW_REV,
  PRESENCE_LASER_REV,
  PRESENT_MINS_REV,
  PROTO,
  PresenceIn,
  PresenceOut,
  Push,
  PushEnvelope,
  presenceForReader,
  presenceReaderRev,
  RECEIPTS_REV,
  REJECT_CODE_INFO,
  REJECT_CODES,
  RESTORE_ELEMENTS_REV,
  Receipts,
  ReceiptsQuery,
  Roster,
  ServerMessage,
  SnapshotFrame,
  TestSnapshot,
  Welcome,
  Workshop,
} from './protocol.ts'
import { SAMPLE_ELEMENTS as E, tombstone } from './test-samples.ts'

const roundTrip = (schema: ZodType, sample: unknown) => {
  const first = schema.parse(sample)
  const again = schema.parse(JSON.parse(JSON.stringify(first)))
  expect(again).toEqual(first)
  expect(first).toEqual(sample)
}

const arrowUnit = pathUnitOf(E.arrow as never)
const elbowUnit = pathUnitOf(E.elbow as never)
const lineUnit = pathUnitOf(E.line as never)

/** One sample of every client message (and of every op shape inside `push`). */
const CLIENT: Record<string, unknown[]> = {
  hello: [
    { type: 'hello', proto: 1, schema: 1, since: 0, epoch: null, tab: 'tab-1' },
    { type: 'hello', proto: 1, schema: 1, since: 41, epoch: 'e1_abc', tab: 'tab-1' },
  ],
  push: [
    { type: 'push', seq: 1, base: 0, ops: Object.values(E).map((el) => ({ k: 'c', el })) },
    // CONTRACTS_REV 11: a receipt id (sent only to a room that announced rev 11)
    {
      type: 'push',
      seq: 3,
      base: 12,
      ops: [{ k: 'p', id: 'rect-1', pv: 4, g: { pos: { x: 11, y: 20 } } }],
      rid: 'k3f9a2b7.3',
    },
    {
      type: 'push',
      seq: 2,
      base: 12,
      ops: [
        { k: 'p', id: 'rect-1', pv: 3, g: { pos: { x: 10, y: 20 }, style: { strokeColor: '#e03131' } } },
        { k: 'p', id: 'arrow-1', pv: 2, g: { path: arrowUnit, bind: { endBinding: null } } },
        { k: 'p', id: 'elbow-1', pv: 2, g: { path: elbowUnit }, off: 700_000 },
        { k: 'p', id: 'line-1', pv: 2, g: { path: lineUnit } },
        { k: 'p', id: 'note-1', pv: 4, c: { 'tag:research': null, 'plusOne:usr_0123456789': true } },
        { k: 'p', id: 'note-1', pv: 4, b: { add: [{ id: 'arrow-1', type: 'arrow' }], rm: ['old-arrow'] } },
        { k: 'p', id: 'note-1', pv: 5, fit: { height: 260 } },
        {
          k: 'p',
          id: 'text-1',
          pv: 2,
          g: { text: { originalText: 'Free!' }, layout: { text: 'Free!', width: 60 } },
          fit: { x: -5 },
        },
        { k: 'p', id: 'frame-1', pv: 1, g: { life: { isDeleted: true } } },
      ],
      doc: {
        set: {
          startView: { x: 0, y: 0, w: 800, h: 600 },
          'tagDef:research': { name: 'research', color: 'blue' },
          workshop: null,
        },
      },
    },
    {
      type: 'push',
      seq: 3,
      base: 12,
      ops: [],
      doc: { set: { workshop: { hideNoteAuthors: true, hideCursors: false } } },
    },
  ],
  'lease.acquire': [{ type: 'lease.acquire', req: 1, id: 'note-1' }],
  'lease.release': [{ type: 'lease.release', id: 'note-1' }],
  presence: [
    {
      type: 'presence',
      pointer: { x: 10.5, y: -3 },
      button: 'down',
      sel: ['note-1', 'rect-1'],
      view: { x: 0, y: 0, w: 1536, h: 864 },
      idle: false,
      editing: null,
      drag: { d: 1, ids: ['note-1'], dx: 0, dy: 0 },
    },
    {
      type: 'presence',
      pointer: null,
      button: 'up',
      sel: { count: 250 },
      view: null,
      idle: true,
      editing: 'note-1',
      drag: null,
    },
    {
      type: 'presence',
      pointer: { x: 1, y: 1 },
      button: 'up',
      sel: [],
      view: null,
      idle: false,
      editing: null,
      drag: { d: 1, dx: 12.5, dy: -4 },
    },
    // CONTRACTS_REV 10: a follow target and the sender's zoom (sent only to a room that announced rev 10)
    {
      type: 'presence',
      pointer: { x: 5, y: 6 },
      button: 'up',
      sel: [],
      view: { x: -20, y: 40, w: 1280, h: 720, z: 1.25 },
      idle: false,
      editing: null,
      f: 'usr_9876543210:tab-2',
    },
    {
      type: 'presence',
      pointer: null,
      button: 'up',
      sel: [],
      view: null,
      idle: false,
      editing: null,
      f: null,
    },
    // CONTRACTS_REV 12: the laser pressed, with the samples since the last send (sent only to a rev-12 room)
    {
      type: 'presence',
      pointer: { x: 300, y: 120 },
      button: 'down',
      sel: [],
      view: { x: 0, y: 0, w: 1280, h: 720, z: 1 },
      idle: false,
      editing: null,
      f: null,
      t: 'laser',
      trail: [
        { x: 280, y: 118 },
        { x: 290, y: 119 },
        { x: 300, y: 120 },
      ],
    },
    // CONTRACTS_REV 12: the laser released (a rev-12 sender says t: null in every message)
    {
      type: 'presence',
      pointer: { x: 300, y: 120 },
      button: 'up',
      sel: [],
      view: null,
      idle: false,
      editing: null,
      f: null,
      t: null,
    },
  ],
  ping: [{ type: 'ping' }, { type: 'ping', n: 7 }],
  // CONTRACTS_REV 11 (W5-ENG-2): which of these lost pushes landed
  receipts: [{ type: 'receipts', req: 1, ids: ['k3f9a2b7.3', 'k3f9a2b7.4', 'p0.12'] }],
}

const holder = { sid: 'usr_0123456789:tab-1', uid: 'usr_0123456789', name: 'Alice' }
const roster = {
  sid: holder.sid,
  uid: holder.uid,
  name: 'Alice',
  color: '#1971c2',
  role: 'editor',
  guest: false,
}
const limits = { ...WIRE_LIMITS }

/** One sample of every server message. */
const SERVER: Record<string, unknown[]> = {
  welcome: [
    {
      type: 'welcome',
      proto: 1,
      schema: 1,
      sid: holder.sid,
      you: { uid: holder.uid, name: 'Alice', color: '#1971c2', role: 'editor', guest: false },
      readonly: false,
      epoch: 'e1_abc',
      clock: 40,
      horizon: 0,
      reset: true,
      catchUp: null,
      snapshot: { elements: 12, bytes: 2048 },
      doc: { startView: { x: 0, y: 0, w: 800, h: 600 } },
      // CONTRACTS_REV 9: the clock of every key ever written, a removed key's included (tagDef:old)
      docClocks: { startView: 37, 'tagDef:old': 12 },
      leases: [{ id: 'note-1', holder }],
      roster: [roster],
      workshop: { voteOpen: false, anonymous: false },
      drags: [{ sid: 'usr_9876543210:tab-2', d: 3, ids: ['rect-1'], dx: 4, dy: 5 }],
      limits,
    },
    {
      type: 'welcome',
      proto: 1,
      schema: 1,
      sid: holder.sid,
      you: { uid: holder.uid, name: 'Guest', color: '#1971c2', role: 'viewer', guest: true },
      readonly: true,
      epoch: 'e1_abc',
      clock: 41,
      horizon: 0,
      reset: false,
      catchUp: [
        { k: 'c', el: E.rectangle },
        { k: 'c', el: tombstone(E.ellipse as never) },
      ],
      snapshot: null,
      doc: {},
      leases: [],
      roster: [],
      workshop: { voteOpen: true, anonymous: true },
      drags: [],
      limits,
    },
  ],
  changes: [
    {
      type: 'changes',
      clock: 42,
      ops: [
        { k: 'c', el: E.stickynote },
        {
          k: 'p',
          id: 'arrow-1',
          v: 5,
          vn: 1_234_567,
          pv: 4,
          updated: 1_790_000_000_100,
          g: { path: arrowUnit },
          lobbyServer: {
            createdBy: { uid: holder.uid, name: 'Alice', guest: false },
            createdAt: 1,
            lastEditedBy: null,
            lastEditedAt: 1,
          },
        },
        {
          k: 'p',
          id: 'note-1',
          v: 6,
          vn: -42,
          pv: 5,
          updated: 2,
          c: { alt: 'a note' },
          b: { add: [], rm: ['arrow-1'] },
        },
      ],
      doc: { set: { 'tagDef:research': null } },
    },
  ],
  ack: [
    {
      type: 'ack',
      seq: 2,
      clock: 42,
      r: [
        { id: 'rect-1', ok: true, v: 4 },
        {
          id: 'arrow-1',
          ok: true,
          v: 5,
          fix: {
            points: [
              [0, 0],
              [300.01, 299.99],
            ],
            x: 205.01,
          },
        },
        { id: 'note-1', ok: true, v: 6, fitDropped: true },
        { id: 'label-9', ok: true, v: 2, denied: { groups: ['text', 'layout'], code: 'LEASED' } },
        { id: 'gone-1', ok: false, code: 'GONE', el: null },
        { id: 'frame-1', ok: false, code: 'LOCKED', el: E.frame },
      ],
      derived: [
        {
          id: 'arrow-2',
          v: 9,
          fix: {
            points: [
              [0, 0],
              [10, 10],
            ],
            width: 10,
            height: 10,
          },
        },
      ],
      docDenied: { keys: ['startView'], code: 'READ_ONLY' },
    },
  ],
  'lease.grant': [{ type: 'lease.grant', req: 1, id: 'note-1', ttlMs: LEASE_TTL_MS }],
  'lease.deny': [{ type: 'lease.deny', req: 1, id: 'note-1', holder }],
  lease: [
    { type: 'lease', id: 'note-1', holder },
    { type: 'lease', id: 'note-1', holder: null },
  ],
  roster: [
    {
      type: 'roster',
      events: [
        { k: 'join', p: roster },
        { k: 'update', p: { ...roster, name: 'Alice B' } },
        { k: 'leave', sid: holder.sid },
      ],
    },
  ],
  presence: [
    {
      type: 'presence',
      peers: [
        {
          sid: holder.sid,
          pointer: { x: 1, y: 2 },
          button: 'up',
          sel: null,
          view: null,
          idle: false,
          editing: null,
        },
      ],
      off: ['usr_x123456789:tab-3'],
      drags: [
        { sid: holder.sid, d: 1, ids: ['note-1'], dx: 0, dy: 0 },
        { sid: holder.sid, d: 1, dx: 3.5, dy: 1 },
        { sid: holder.sid, d: 1, end: true },
      ],
    },
    // CONTRACTS_REV 10, to a rev-10 recipient: the follow target, the zoom, and who follows the recipient
    {
      type: 'presence',
      peers: [
        {
          sid: holder.sid,
          pointer: { x: 1, y: 2 },
          button: 'up',
          sel: [],
          view: { x: 0, y: 0, w: 800, h: 600, z: 0.5 },
          idle: false,
          editing: null,
          f: 'usr_9876543210:tab-2',
        },
      ],
      followers: ['usr_9876543210:tab-2', 'usr_x123456789:tab-3'],
    },
    { type: 'presence', peers: [], followers: [] },
    // CONTRACTS_REV 12, to a rev-12 recipient: a peer's laser and its latest samples
    {
      type: 'presence',
      peers: [
        {
          sid: holder.sid,
          pointer: { x: 300, y: 120 },
          button: 'down',
          sel: [],
          view: { x: 0, y: 0, w: 800, h: 600, z: 1 },
          idle: false,
          editing: null,
          t: 'laser',
          trail: [
            { x: 280, y: 118 },
            { x: 300, y: 120 },
          ],
        },
      ],
    },
  ],
  contracts: [
    { type: 'contracts', rev: 10 },
    { type: 'contracts', rev: 11 },
  ],
  receipts: [
    { type: 'receipts', req: 1, landed: { 'k3f9a2b7.3': 41 }, from: 0 },
    { type: 'receipts', req: 2, landed: {}, from: 1207 },
  ],
  workshop: [{ type: 'workshop', voteOpen: true, anonymous: false }],
  notice: [
    { type: 'notice', code: 'SLOW_DOWN' },
    { type: 'notice', code: 'DISK', detail: 'free space below 5%' },
    { type: 'notice', code: 'PREPARING' },
    { type: 'notice', code: 'CLOSING', detail: 'MAINTENANCE' },
  ],
  pong: [{ type: 'pong' }, { type: 'pong', n: 7 }],
}

const discriminators = (schema: ZodType): string[] =>
  (
    (schema as unknown as { def: { options: { def: { shape: { type: { def: { values: string[] } } } } }[] } })
      .def.options ?? []
  ).flatMap((o) => o.def.shape.type.def.values)

describe('every message round-trips through its zod schema (§2.4.2)', () => {
  it('covers every client and server message type', () => {
    expect(Object.keys(CLIENT).sort()).toEqual(discriminators(ClientMessage).sort())
    expect(Object.keys(SERVER).sort()).toEqual(discriminators(ServerMessage).sort())
  })

  for (const [type, samples] of Object.entries(CLIENT))
    it(`client → server: ${type}`, () => {
      for (const s of samples) roundTrip(ClientMessage, s)
    })
  for (const [type, samples] of Object.entries(SERVER))
    it(`server → client: ${type}`, () => {
      for (const s of samples) roundTrip(ServerMessage, s)
    })

  it('each message also parses with its own schema', () => {
    const own: Record<string, ZodType> = {
      hello: Hello,
      push: Push,
      'lease.acquire': LeaseAcquire,
      'lease.release': LeaseRelease,
      ping: Ping,
      receipts: ReceiptsQuery,
    }
    for (const [t, schema] of Object.entries(own)) for (const s of CLIENT[t] ?? []) roundTrip(schema, s)
    roundTrip(PresenceIn, CLIENT.presence?.[0])
    const serverOwn: Record<string, ZodType> = {
      welcome: Welcome,
      changes: Changes,
      ack: Ack,
      'lease.grant': LeaseGrant,
      'lease.deny': LeaseDeny,
      lease: LeaseBroadcast,
      roster: Roster,
      presence: PresenceOut,
      workshop: Workshop,
      notice: Notice,
      pong: Pong,
      contracts: Contracts,
      receipts: Receipts,
    }
    for (const [t, schema] of Object.entries(serverOwn)) for (const s of SERVER[t] ?? []) roundTrip(schema, s)
  })

  it('the binary snapshot frame (tombstones included) survives gzip in both directions', async () => {
    const frame = {
      type: 'snapshot',
      epoch: 'e1_abc',
      clock: 40,
      horizon: 0,
      elements: [...Object.values(E), tombstone(E.ellipse as never, 7)],
      doc: { workshop: { hideNoteAuthors: false, hideCursors: true } },
    }
    roundTrip(SnapshotFrame, frame)
    const bytes = await encodeSnapshotFrame(SnapshotFrame.parse(frame))
    expect(bytes[0]).toBe(0x1f) // gzip magic
    expect(await decodeSnapshotFrame(bytes)).toEqual(frame)
  })

  it('the test-hook bodies round-trip', () => {
    roundTrip(TestSnapshot, {
      clock: 3,
      epoch: 'e1_abc',
      horizon: 0,
      elements: [E.rectangle, tombstone(E.frame as never)],
    })
    for (const s of [{ mode: 'delay', ms: 300 }, { mode: 'hold' }, { mode: 'release' }, { mode: 'off' }])
      roundTrip(LeaseHookRequest, s)
    roundTrip(FailCommitRequest, { count: 2 })
    expect(LeaseHookRequest.safeParse({ mode: 'delay' }).success).toBe(false)
    expect(FailCommitRequest.safeParse({ count: 0 }).success).toBe(false)
  })
})

describe('what the wire refuses', () => {
  const ok = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(true)
  const bad = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(false)

  it('unknown keys, a wrong proto, identity fields in presence', () => {
    bad(ClientMessage, { ...(CLIENT.hello?.[0] as object), extra: 1 })
    bad(ClientMessage, { ...(CLIENT.hello?.[0] as object), proto: 2 })
    bad(ClientMessage, { ...(CLIENT.presence?.[1] as object), uid: 'usr_0123456789' })
    bad(ClientMessage, { ...(CLIENT.presence?.[1] as object), name: 'Mallory' })
    bad(ClientMessage, { type: 'connect', protocolVersion: 7 }) // a tldraw client
    expect(PROTO).toBe(1)
  })

  it('a path patch must be whole (a missing field is INVALID)', () => {
    for (const unit of [arrowUnit, elbowUnit, lineUnit])
      for (const f of Object.keys(unit)) {
        const { [f]: _, ...rest } = unit
        bad(PatchOp, { k: 'p', id: 'x', pv: 1, g: { path: rest } })
      }
    // the critic-r33 case: a free-end drag sent as points only
    bad(PatchOp, { k: 'p', id: 'arrow-1', pv: 1, g: { path: { points: arrowUnit.points } } })
    ok(PatchOp, { k: 'p', id: 'arrow-1', pv: 1, g: { path: arrowUnit } })
  })

  it('fields must be in their group, groups must be known, patches must not be empty', () => {
    bad(PatchOp, { k: 'p', id: 'r', pv: 1, g: { style: { x: 1 } } })
    bad(PatchOp, { k: 'p', id: 'r', pv: 1, g: { bound: { boundElements: [] } } }) // `bound` travels in `b`
    bad(PatchOp, { k: 'p', id: 'r', pv: 1, g: { colour: { strokeColor: '#000' } } })
    bad(PatchOp, { k: 'p', id: 'r', pv: 1 })
    bad(PatchOp, { k: 'p', id: 'r', pv: 1, fit: {} })
    bad(PatchOp, { k: 'p', id: 'r', pv: 1, c: { 'made-up': 1 } })
    bad(PatchOp, { k: 'p', id: 'r', pv: 1, c: { 'plusOne:usr_1': 'yes' } })
    ok(PatchOp, { k: 'p', id: 'r', pv: 1, c: { 'plusOne:usr_1': null } })
    for (const g of GROUP_NAMES) expect(GROUP_FIELDS[g].length).toBeGreaterThan(0)
  })

  it('size caps: 500 ops per push, 2,000 drag ids per presence message', () => {
    const op = { k: 'p', id: 'r', pv: 1, g: { pos: { x: 1, y: 1 } } }
    ok(Push, { type: 'push', seq: 1, base: 0, ops: Array(MAX_OPS_PER_PUSH).fill(op) })
    bad(Push, { type: 'push', seq: 1, base: 0, ops: Array(MAX_OPS_PER_PUSH + 1).fill(op) })
    const presence = CLIENT.presence?.[0] as Record<string, unknown>
    // 501 ids parse (the server drops that drag, not the message); above the wire bound the message is INVALID
    ok(PresenceIn, {
      ...presence,
      drag: { d: 1, ids: Array.from({ length: 501 }, (_, i) => `n${i}`), dx: 0, dy: 0 },
    })
    bad(PresenceIn, {
      ...presence,
      drag: { d: 1, ids: Array.from({ length: 2001 }, (_, i) => `n${i}`), dx: 0, dy: 0 },
    })
  })

  it('a welcome is either a reset with a snapshot or a catch-up', () => {
    const w = SERVER.welcome?.[0] as Record<string, unknown>
    bad(Welcome, { ...w, catchUp: [] })
    bad(Welcome, { ...w, reset: false })
  })

  it('docClocks (CONTRACTS_REV 9): optional on the welcome and the snapshot, a clock per key, never a bad clock', async () => {
    const w = SERVER.welcome?.[0] as Record<string, unknown>
    const { docClocks: _, ...without } = w
    ok(Welcome, without)
    ok(Welcome, { ...w, docClocks: {} })
    bad(Welcome, { ...w, docClocks: { startView: -1 } })
    bad(Welcome, { ...w, docClocks: { startView: 1.5 } })
    bad(Welcome, { ...w, docClocks: { startView: '3' } })
    const frame = {
      type: 'snapshot',
      epoch: 'e1_abc',
      clock: 40,
      horizon: 0,
      elements: [E.rectangle],
      doc: { workshop: { hideNoteAuthors: false, hideCursors: true } },
      docClocks: { workshop: 40, 'tagDef:gone': 3 },
    }
    roundTrip(SnapshotFrame, frame)
    expect(await decodeSnapshotFrame(await encodeSnapshotFrame(SnapshotFrame.parse(frame)))).toEqual(frame)
    bad(SnapshotFrame, { ...frame, docClocks: { workshop: 0.5 } })
  })

  it('rejections are per op: a push with one bad op passes the envelope, not the full schema', () => {
    const good = { k: 'p', id: 'r', pv: 1, g: { pos: { x: 1, y: 1 } } }
    const broken = { k: 'p', id: 'arrow-1', pv: 1, g: { path: { points: [[0, 0]] } } }
    const push = { type: 'push', seq: 4, base: 0, ops: [good, broken] }
    ok(ClientEnvelope, push)
    bad(Push, push)
    expect(Op.safeParse(good).success).toBe(true)
    expect(Op.safeParse(broken).success).toBe(false)
    bad(ClientEnvelope, { ...push, ops: Array(MAX_OPS_PER_PUSH + 1).fill(good) })
    bad(ClientEnvelope, { type: 'push', seq: 0, base: 0, ops: [good] })
  })

  it('an op is a create or a patch', () => {
    ok(Op, { k: 'c', el: E.rectangle })
    bad(Op, { k: 'c', el: { ...E.rectangle, type: 'embeddable' } })
    bad(Op, { k: 'd', id: 'x' })
  })

  it('every reject code has its retry, abuse and UI rule', () => {
    expect(Object.keys(REJECT_CODE_INFO).sort()).toEqual([...REJECT_CODES].sort())
    expect(REJECT_CODES.filter((c) => REJECT_CODE_INFO[c].abuse).sort()).toEqual([
      'INVALID',
      'TOO_LARGE',
      'TYPE_CHANGE',
    ])
    expect(REJECT_CODES.filter((c) => REJECT_CODE_INFO[c].retryable).sort()).toEqual(['RATE', 'UNAVAILABLE'])
  })
})

// ---- CONTRACTS_REV 10 and the ends one revision older (deploy order, stale tabs) ----------------------------

/** Rev 9's presence schemas, as a rev-9 client or room parses them (strict, no `f`, no `view.z`). */
const Rect9 = z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
const PresenceIn9 = z.strictObject({
  type: z.literal('presence'),
  pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
  button: z.enum(['up', 'down']),
  sel: z.union([z.array(z.string()), z.strictObject({ count: z.number() })]),
  view: Rect9.nullable(),
  idle: z.boolean(),
  editing: z.string().nullable(),
  drag: z.unknown().optional(),
})
const PeerPresence9 = PresenceIn9.omit({ type: true, drag: true }).extend({
  sid: z.string(),
  sel: z.union([z.array(z.string()), z.strictObject({ count: z.number() })]).nullable(),
})

describe('CONTRACTS_REV 10: follow target, zoom, followers, the contracts frame', () => {
  const ok = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(true)
  const bad = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(false)

  it('presence follow starts at revision 10 (the room speaks rev 12 since wave L)', () => {
    expect(CONTRACTS_REV).toBeGreaterThanOrEqual(PRESENCE_FOLLOW_REV)
    expect(PRESENCE_FOLLOW_REV).toBe(10)
  })

  it('every rev-9 presence message still parses (the new fields are optional)', () => {
    for (const s of (CLIENT.presence ?? []).slice(0, 3)) {
      ok(PresenceIn9, s)
      ok(PresenceIn, s)
    }
    const peer9 = (SERVER.presence as { peers: unknown[] }[])[0]?.peers[0]
    ok(PeerPresence9, peer9)
  })

  it('a rev-9 end refuses the rev-10 fields (why each end sends them only to a rev-10 one)', () => {
    const rich = CLIENT.presence?.[3] as Record<string, unknown>
    ok(PresenceIn, rich)
    bad(PresenceIn9, rich) // a rev-9 room: INVALID_MESSAGE, the socket closes
    bad(PresenceIn9, { ...rich, f: undefined }) // the zoom alone is refused too
    const richPeer = (SERVER.presence as { peers: unknown[] }[])[1]?.peers[0]
    bad(PeerPresence9, richPeer) // a rev-9 client drops the whole frame
  })

  it('the zoom is positive and bounded; the follow target is a session id; followers are bounded', () => {
    const rich = CLIENT.presence?.[3] as Record<string, unknown>
    const view = rich.view as Record<string, unknown>
    bad(PresenceIn, { ...rich, view: { ...view, z: 0 } })
    bad(PresenceIn, { ...rich, view: { ...view, z: -1 } })
    bad(PresenceIn, { ...rich, view: { ...view, z: MAX_PRESENCE_ZOOM + 1 } })
    bad(PresenceIn, { ...rich, view: { ...view, z: Number.NaN } })
    ok(PresenceIn, { ...rich, view: { ...view, z: MAX_PRESENCE_ZOOM } })
    bad(PresenceIn, { ...rich, f: 'x' })
    bad(PresenceIn, { ...rich, f: 3 })
    ok(PresenceOut, { type: 'presence', peers: [], followers: Array(MAX_FOLLOWERS).fill(holder.sid) })
    bad(PresenceOut, { type: 'presence', peers: [], followers: Array(MAX_FOLLOWERS + 1).fill(holder.sid) })
  })

  it('the contracts frame is strict and names a positive revision', () => {
    ok(Contracts, { type: 'contracts', rev: CONTRACTS_REV })
    bad(Contracts, { type: 'contracts', rev: 0 })
    bad(Contracts, { type: 'contracts', rev: 10, extra: true })
    bad(Contracts, { type: 'contracts' })
  })
})

// ---- CONTRACTS_REV 11 (W5-ENG-2, push receipts) and the ends one revision older ---------------------------------

/** Rev 10's push and client envelope, as a rev-10 room parses them (strict: no `rid`, no `receipts`). */
const PushEnvelope10 = z.strictObject({
  type: z.literal('push'),
  seq: z.number().int().positive(),
  base: z.number().int().nonnegative(),
  ops: z.array(z.unknown()),
  doc: z.unknown().optional(),
})
const ClientTypes10 = ['hello', 'push', 'lease.acquire', 'lease.release', 'presence', 'ping']
/** Rev 10's server message types, as a rev-10 client parses them (a frame of another type is dropped). */
const ServerTypes10 = [
  'welcome',
  'changes',
  'ack',
  'lease.grant',
  'lease.deny',
  'lease',
  'roster',
  'presence',
  'workshop',
  'notice',
  'pong',
  'contracts',
]

describe('CONTRACTS_REV 11: push receipts', () => {
  const ok = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(true)
  const bad = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(false)

  it('receipts start at revision 11 (the room speaks rev 12 since wave L)', () => {
    expect(CONTRACTS_REV).toBeGreaterThanOrEqual(RECEIPTS_REV)
    expect(RECEIPTS_REV).toBe(11)
    expect(MAX_RECEIPT_IDS).toBe(64)
  })

  it('a push without a receipt id is exactly a rev-10 push (a rev-11 room serves a rev-10 tab as before)', () => {
    for (const p of CLIENT.push ?? []) {
      const { rid: _rid, ...rest } = p as Record<string, unknown>
      ok(PushEnvelope10, rest)
      ok(Push, rest)
      ok(PushEnvelope, rest)
    }
  })

  it('a rev-10 room refuses a receipt id and the query (why a rev-11 tab sends them only to a rev-11 room)', () => {
    const withRid = (CLIENT.push ?? []).find((p) => (p as { rid?: string }).rid)
    ok(Push, withRid)
    ok(PushEnvelope, withRid)
    bad(PushEnvelope10, withRid) // a rev-10 room: INVALID_MESSAGE, the socket closes
    expect(ClientTypes10).not.toContain('receipts')
    // ... and a rev-10 tab never gets a receipts frame (it never asks); if it did, it would drop it
    expect(ServerTypes10).not.toContain('receipts')
    expect(discriminators(ServerMessage).filter((t) => !ServerTypes10.includes(t))).toEqual(['receipts'])
  })

  it('receipt ids are short and plain; a query names 1 to 64; an answer at most 64 with clocks', () => {
    const q = (ids: unknown) => ({ type: 'receipts', req: 1, ids })
    bad(ReceiptsQuery, q([]))
    ok(ReceiptsQuery, q(Array.from({ length: MAX_RECEIPT_IDS }, (_, i) => `p.${i}`)))
    bad(ReceiptsQuery, q(Array.from({ length: MAX_RECEIPT_IDS + 1 }, (_, i) => `p.${i}`)))
    bad(ReceiptsQuery, q(['has space']))
    bad(ReceiptsQuery, q(['x'.repeat(65)]))
    bad(ReceiptsQuery, { ...q(['a.1']), extra: 1 })
    const withRid = (CLIENT.push ?? []).find((p) => (p as { rid?: string }).rid) as Record<string, unknown>
    bad(Push, { ...withRid, rid: '' })
    bad(Push, { ...withRid, rid: 'a/b' })
    const many = Object.fromEntries(Array.from({ length: MAX_RECEIPT_IDS + 1 }, (_, i) => [`p.${i}`, i]))
    bad(Receipts, { type: 'receipts', req: 1, landed: many, from: 0 })
    bad(Receipts, { type: 'receipts', req: 1, landed: { 'a.1': -1 }, from: 0 })
    bad(Receipts, { type: 'receipts', req: 1, landed: {}, from: 0, extra: true })
    bad(Receipts, { type: 'receipts', req: 1, landed: {} })
  })
})

// ---- CONTRACTS_REV 12 (wave L: the shared laser) and the ends one revision older ------------------------------
//
// The stale-client pairs at the protocol layer (the plan's shared contract 4): (a) a rev-11 tab in a rev-12
// room, (b) a rev-12 tab in a rev-11 room. Rev 11's presence is rev 10's (receipts changed no presence).

/** Rev 11's presence schemas, as a rev-11 client or room parses them (strict: `f`, `view.z`, no `t`). */
const Rect11 = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  z: z.number().positive().optional(),
})
const PresenceIn11 = z.strictObject({
  type: z.literal('presence'),
  pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
  button: z.enum(['up', 'down']),
  sel: z.union([z.array(z.string()), z.strictObject({ count: z.number() })]),
  view: Rect11.nullable(),
  idle: z.boolean(),
  editing: z.string().nullable(),
  drag: z.unknown().optional(),
  f: z.string().nullable().optional(),
})
const PeerPresence11 = PresenceIn11.omit({ type: true, drag: true }).extend({
  sid: z.string(),
  sel: z.union([z.array(z.string()), z.strictObject({ count: z.number() })]).nullable(),
})
/** Rev 11's server message types (a rev-11 client drops a frame of another type). */
const ServerTypes11 = [...ServerTypes10, 'receipts']

describe('CONTRACTS_REV 12: the shared laser, present.mins and the restore marker', () => {
  const ok = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(true)
  const bad = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(false)
  const laserIn = () => CLIENT.presence?.[5] as Record<string, unknown>
  const laserPeer = () =>
    PeerPresence.parse((SERVER.presence as { peers: unknown[] }[])[3]?.peers[0]) as ReturnType<
      typeof PeerPresence.parse
    >

  it('the laser, present.mins and the restore route all start at revision 12 (the room says 14 since wave T)', () => {
    expect(CONTRACTS_REV).toBe(14)
    expect(PRESENCE_LASER_REV).toBe(12)
    expect(PRESENT_MINS_REV).toBe(12)
    expect(RESTORE_ELEMENTS_REV).toBe(12)
    expect(MAX_LASER_TRAIL_POINTS).toBe(6)
    expect(MAX_LASER_TRAIL_POINTS_WIRE).toBeGreaterThan(MAX_LASER_TRAIL_POINTS)
    expect([9, 10, 11, 12, 13, 14].map(presenceReaderRev)).toEqual([9, 10, 10, 12, 12, 12])
  })

  it('(a) a rev-11 tab in a rev-12 room: everything it sends parses as before (the new fields are optional)', () => {
    const rev11 = (CLIENT.presence ?? []).filter((m) => !('t' in (m as object)))
    expect(rev11.length).toBeGreaterThanOrEqual(5)
    for (const m of rev11) {
      ok(PresenceIn11, m)
      ok(PresenceIn, m)
      ok(ClientMessage, m)
    }
    // it gets no new server message type: the rev-12 room's frames are all of rev-11 types
    expect(discriminators(ServerMessage).filter((t) => !ServerTypes11.includes(t))).toEqual([])
  })

  it('(a) what the room sends a rev-11 (or older) tab: presenceForReader leaves out t and trail; the raw entry would be refused', () => {
    const peer = laserPeer()
    bad(PeerPresence11, peer) // why the room gates per socket: a rev-11 client's strict parse drops the frame
    const for11 = presenceForReader(peer, 10)
    ok(PeerPresence11, for11)
    expect(for11).not.toHaveProperty('t')
    expect(for11).not.toHaveProperty('trail')
    expect(for11.view?.z).toBe(1) // a rev-10/11 reader keeps the zoom
    const for9 = presenceForReader(peer, 9)
    ok(PeerPresence9, for9)
    expect(for9.view).toEqual({ x: 0, y: 0, w: 800, h: 600 })
    ok(PresenceOut, { type: 'presence', peers: [for11] })
    // a rev-12 reader gets the entry itself; an entry with nothing to leave out is never copied
    expect(presenceForReader(peer, 12)).toBe(peer)
    const plain = PeerPresence.parse((SERVER.presence as { peers: unknown[] }[])[0]?.peers[0])
    expect(presenceForReader(plain, 9)).toBe(plain)
    expect(presenceForReader(plain, 10)).toBe(plain)
    const rich = PeerPresence.parse((SERVER.presence as { peers: unknown[] }[])[1]?.peers[0])
    expect(presenceForReader(rich, 10)).toBe(rich)
    ok(PeerPresence9, presenceForReader(rich, 9))
  })

  it('(b) a rev-12 tab in a rev-11 room: without its laser fields every message is one the rev-11 room accepts', () => {
    const msg = laserIn()
    ok(PresenceIn, msg)
    bad(PresenceIn11, msg) // a rev-11 room: INVALID_MESSAGE, the socket closes (why the tab gates on rev 12)
    bad(PresenceIn11, { ...msg, trail: undefined }) // `t` alone is refused too
    const { t: _t, trail: _trail, ...asRev11 } = msg
    ok(PresenceIn11, asRev11)
    ok(PresenceIn, asRev11)
  })

  it('the laser fields: t is the laser or null; trail integer points, at most 32 in and 6 out', () => {
    const msg = laserIn()
    const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: -i }))
    ok(PresenceIn, { ...msg, trail: pts(MAX_LASER_TRAIL_POINTS_WIRE) })
    bad(PresenceIn, { ...msg, trail: pts(MAX_LASER_TRAIL_POINTS_WIRE + 1) })
    ok(PresenceIn, { ...msg, trail: [] })
    bad(PresenceIn, { ...msg, trail: [{ x: 1.5, y: 0 }] })
    bad(PresenceIn, { ...msg, trail: [{ x: 1e9, y: 0 }] })
    bad(PresenceIn, { ...msg, trail: [{ x: 1, y: 2, z: 3 }] })
    bad(PresenceIn, { ...msg, t: 'pen' })
    ok(PresenceIn, { ...msg, t: null, trail: undefined })
    const peer = laserPeer()
    ok(PeerPresence, { ...peer, trail: pts(MAX_LASER_TRAIL_POINTS) })
    bad(PeerPresence, { ...peer, trail: pts(MAX_LASER_TRAIL_POINTS + 1) }) // a 7-point trail out is refused
    bad(PeerPresence, { ...peer, t: null }) // out, a released laser is left out, never null
  })
})
