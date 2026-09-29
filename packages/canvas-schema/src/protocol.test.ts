/**
 * Contract tests of protocol.ts (spike B contracts step C0): a zod round trip for EVERY message in both
 * directions, the snapshot frame, and the test-hook bodies; plus the refusals the wire itself makes
 * (unknown keys, identity in presence, a `path` patch that is not whole, the size caps).
 */
import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { pathUnitOf } from './groups.ts'
import { LEASE_TTL_MS, MAX_OPS_PER_PUSH, WIRE_LIMITS } from './limits.ts'
import {
  Ack,
  Changes,
  ClientEnvelope,
  ClientMessage,
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
  Notice,
  Op,
  PatchOp,
  Ping,
  Pong,
  PROTO,
  PresenceIn,
  PresenceOut,
  Push,
  REJECT_CODE_INFO,
  REJECT_CODES,
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
  ],
  ping: [{ type: 'ping' }, { type: 'ping', n: 7 }],
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
  ],
  workshop: [{ type: 'workshop', voteOpen: true, anonymous: false }],
  notice: [
    { type: 'notice', code: 'SLOW_DOWN' },
    { type: 'notice', code: 'DISK', detail: 'free space below 5%' },
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
