import { afterEach, describe, expect, it, vi } from 'vitest'
import { geoShape } from '../test/harness/records.ts'
import {
  bindPresenceOp,
  type Inbound,
  InboundFrames,
  MAX_CHAT_MESSAGE_LENGTH,
  type PresenceIdentity,
  presenceIdentity,
} from './presence.ts'

const NOW = 1_800_000_000_000
const VIC: PresenceIdentity = presenceIdentity({ uid: 'usr_vic', name: 'Vic Viewer', color: '#047857' })

const presence = (over: Record<string, unknown> = {}) => ({
  id: 'instance_presence:x',
  typeName: 'instance_presence',
  userId: 'user:usr_vic',
  userName: 'Vic Viewer',
  color: '#047857',
  lastActivityTimestamp: NOW - 10,
  followingUserId: null,
  cursor: { x: 1, y: 2, type: 'default', rotation: 0 },
  camera: { x: 0, y: 0, z: 1 },
  screenBounds: null,
  selectedShapeIds: ['shape:a'],
  currentPageId: 'page:page',
  brush: null,
  scribbles: [],
  chatMessage: '',
  meta: { editingShapeId: 'shape:a' },
  ...over,
})
const push = (presenceOp: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'push', clientClock: 3, presence: presenceOp, ...extra })
const frames = () => new InboundFrames(VIC, () => NOW)
/** The message a `deliver` verdict hands to the room, parsed. */
const delivered = (r: Inbound) => {
  if (r.kind !== 'deliver') throw new Error(`expected deliver, got ${r.kind}`)
  return JSON.parse(r.text) as { presence: [string, Record<string, unknown>] }
}
/** ClientWebSocketAdapter's framing: "<frames still to come>_<slice>". */
const chunked = (text: string, size: number) => {
  const n = Math.ceil(text.length / size)
  return Array.from({ length: n }, (_, i) => `${n - 1 - i}_${text.slice(i * size, (i + 1) * size)}`)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('presenceIdentity', () => {
  it("is tldraw's user id form, the ticket's name, and its color unless that is not a plain hex color", () => {
    expect(VIC).toEqual({ userId: 'user:usr_vic', userName: 'Vic Viewer', color: '#047857' })
    const odd = presenceIdentity({ uid: 'usr_vic', name: 'V', color: 'red;background:url(x)' })
    expect(odd.color).toMatch(/^#[0-9a-f]{6}$/)
    // deterministic, like the web client's colorForUser fallback
    expect(presenceIdentity({ uid: 'usr_vic', name: 'V', color: '' }).color).toBe(odd.color)
  })
})

describe('bindPresenceOp: put', () => {
  it("refuses a put that claims another user's id", () => {
    for (const userId of ['user:usr_alice', 'usr_vic', 'user:usr_vic ', 'user:USR_VIC', 42, null])
      expect(bindPresenceOp(['put', presence({ userId })], VIC, NOW), String(userId)).toEqual({ ok: false })
  })

  it("forces the ticket's name and color, clamps a future timestamp, caps the chat", () => {
    const record = presence({
      userName: 'Alice (facilitator)',
      color: '#ff0000',
      lastActivityTimestamp: NOW + 365 * 24 * 3600_000,
      chatMessage: 'x'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1),
    })
    expect(bindPresenceOp(['put', record], VIC, NOW)).toEqual({ ok: true, changed: true })
    expect(record).toMatchObject({
      userId: 'user:usr_vic',
      userName: 'Vic Viewer',
      color: '#047857',
      lastActivityTimestamp: NOW,
      chatMessage: 'x'.repeat(MAX_CHAT_MESSAGE_LENGTH),
    })
  })

  it('fills in a missing identity; leaves an honest record, past and null timestamps untouched', () => {
    const { userId: _u, userName: _n, ...bare } = presence()
    expect(bindPresenceOp(['put', bare], VIC, NOW)).toEqual({ ok: true, changed: true })
    expect(bare).toMatchObject({ userId: 'user:usr_vic', userName: 'Vic Viewer' })
    for (const lastActivityTimestamp of [NOW, NOW - 60_000, 0, null]) {
      const honest = presence({ lastActivityTimestamp })
      expect(bindPresenceOp(['put', honest], VIC, NOW)).toEqual({ ok: true, changed: false })
      expect(honest).toEqual(presence({ lastActivityTimestamp }))
    }
  })

  it('refuses anything that is not a put or patch of an object', () => {
    for (const op of [null, 'put', {}, ['put'], ['put', null], ['put', []], ['remove'], ['append', {}]])
      expect(bindPresenceOp(op, VIC, NOW), JSON.stringify(op)).toEqual({ ok: false })
  })
})

describe('bindPresenceOp: patch', () => {
  it('refuses any change to userId: another id, an append, a delete, a nested patch', () => {
    for (const userId of [
      ['put', 'user:usr_alice'],
      ['append', 'ce', 'user:usr_vic'.length],
      ['delete'],
      ['patch', {}],
    ])
      expect(bindPresenceOp(['patch', { userId }], VIC, NOW), JSON.stringify(userId)).toEqual({ ok: false })
    // a no-op put of its own id is fine
    expect(bindPresenceOp(['patch', { userId: ['put', 'user:usr_vic'] }], VIC, NOW)).toEqual({
      ok: true,
      changed: false,
    })
  })

  it("replaces any op on userName/color with the ticket's value and clamps a future timestamp", () => {
    const diff: Record<string, unknown> = {
      userName: ['append', ' (host)', 10],
      color: ['delete'],
      lastActivityTimestamp: ['put', NOW + 1],
      cursor: ['put', { x: 5, y: 5, type: 'default', rotation: 0 }],
    }
    expect(bindPresenceOp(['patch', diff], VIC, NOW)).toEqual({ ok: true, changed: true })
    expect(diff).toEqual({
      userName: ['put', 'Vic Viewer'],
      color: ['put', '#047857'],
      lastActivityTimestamp: ['put', NOW],
      cursor: ['put', { x: 5, y: 5, type: 'default', rotation: 0 }],
    })
  })

  it('caps the chat for puts and appends (an append lands only at offset = current length)', () => {
    const cap = MAX_CHAT_MESSAGE_LENGTH
    const cases: [unknown, unknown][] = [
      [
        ['put', 'y'.repeat(cap + 50)],
        ['put', 'y'.repeat(cap)],
      ],
      [
        ['append', 'z'.repeat(100), cap - 10],
        ['append', 'z'.repeat(10), cap - 10],
      ],
      [['append', 'z', cap], undefined], // already full: the op is dropped
      [
        ['put', 'hi'],
        ['put', 'hi'],
      ],
      [
        ['append', ' there', 2],
        ['append', ' there', 2],
      ],
    ]
    for (const [op, expected] of cases) {
      const diff: Record<string, unknown> = { chatMessage: op }
      expect(bindPresenceOp(['patch', diff], VIC, NOW).ok).toBe(true)
      expect(diff.chatMessage, JSON.stringify(op)).toEqual(expected)
    }
  })

  it('leaves an honest patch (cursor, selection, meta, a past timestamp) unchanged', () => {
    const diff = {
      cursor: ['patch', { x: ['put', 9] }],
      selectedShapeIds: ['put', []],
      meta: ['patch', { editingShapeId: ['put', null] }],
      lastActivityTimestamp: ['put', NOW - 5],
    }
    const copy = structuredClone(diff)
    expect(bindPresenceOp(['patch', diff], VIC, NOW)).toEqual({ ok: true, changed: false })
    expect(diff).toEqual(copy)
  })
})

describe('InboundFrames', () => {
  it('passes document pushes, pings and connects through verbatim, without parsing them', () => {
    const f = frames()
    const doc = JSON.stringify({
      type: 'push',
      clientClock: 1,
      diff: { 'shape:a': ['put', { id: 'shape:a', props: { text: 'hello' } }] },
    })
    const ping = '{"type":"ping"}'
    const parse = vi.spyOn(JSON, 'parse')
    for (const text of [doc, ping]) {
      const r = f.accept(text)
      expect(r).toEqual({ kind: 'deliver', text })
      expect(r.kind === 'deliver' && r.text).toBe(text) // the same string, not a copy
    }
    expect(parse).not.toHaveBeenCalled()
  })

  it('a document push costs one scan, a fraction of the parse the room does anyway (1 MB paste)', () => {
    const diff: Record<string, unknown> = {}
    for (let i = 0; i < 2_500; i++) {
      const s = geoShape(`s${i}`, {
        x: i * 3.5,
        y: i * 2.25,
        text: `Sticky note number ${i} with a few words`,
      })
      diff[s.id] = ['put', s]
    }
    const doc = JSON.stringify({ type: 'push', clientClock: 1, diff })
    expect(doc.length).toBeGreaterThan(1_000_000)
    const f = frames()
    const median = (fn: () => void) => {
      const runs: number[] = []
      for (let i = 0; i < 15; i++) {
        const t = performance.now()
        fn()
        runs.push(performance.now() - t)
      }
      return runs.sort((a, b) => a - b)[7] ?? 0
    }
    const guard = median(() => f.accept(doc))
    const parse = median(() => JSON.parse(doc))
    // measured ~0.25 ms vs ~3.8 ms; the room also validates and stores every record after its parse
    expect(guard).toBeLessThan(parse / 3)
  })

  it("binds presence in a push (with or without a document diff) and refuses someone else's", () => {
    const f = frames()
    const forgedName = push(['put', presence({ userName: 'Alice' })], { diff: { 'shape:a': ['remove'] } })
    const out = delivered(f.accept(forgedName)) as { presence: [string, { userName: string }]; diff: unknown }
    expect(out.presence[1].userName).toBe('Vic Viewer')
    expect(out.diff).toEqual({ 'shape:a': ['remove'] })

    const honest = push(['put', presence()])
    expect(f.accept(honest)).toEqual({ kind: 'deliver', text: honest })

    expect(f.accept(push(['put', presence({ userId: 'user:usr_alice' })]))).toEqual({ kind: 'forged' })
    expect(f.accept(push(['patch', { userId: ['put', 'user:usr_alice'] }]))).toEqual({ kind: 'forged' })
  })

  it('cannot be dodged by spelling "presence" with \\u escapes', () => {
    const f = frames()
    // (a bare record: a full one would say "instance_presence" in its id and typeName)
    const sneaky = '{"type":"push","clientClock":1,"pres\\u0065nce":["put",{"userId":"user:usr_alice"}]}'
    expect(sneaky).not.toContain('presence')
    expect(Object.keys(JSON.parse(sneaky))).toContain('presence')
    expect(f.accept(sneaky)).toEqual({ kind: 'forged' })
    // and an escaped userId is read the same way the room reads it
    const escapedId = push(['put', presence()]).replace('"user:usr_vic"', '"user:usr_\\u0061lice"')
    expect(f.accept(escapedId)).toEqual({ kind: 'forged' })
  })

  it('reassembles chunked frames: a forged presence split across chunks is still refused', () => {
    const f = frames()
    const parts = chunked(push(['put', presence({ userId: 'user:usr_alice' })]), 40)
    expect(parts.length).toBeGreaterThan(3)
    for (const p of parts.slice(0, -1)) expect(f.accept(p)).toEqual({ kind: 'partial' })
    expect(f.accept(parts.at(-1) as string)).toEqual({ kind: 'forged' })

    // an honest chunked push is handed to the room as ONE whole message
    const whole = push(['put', presence()], { diff: { 'shape:b': ['remove'] } })
    const again = chunked(whole, 50)
    for (const p of again.slice(0, -1)) expect(f.accept(p)).toEqual({ kind: 'partial' })
    expect(f.accept(again.at(-1) as string)).toEqual({ kind: 'deliver', text: whole })
    // a single "0_" frame is a whole message too
    expect(f.accept(`0_${whole}`)).toEqual({ kind: 'deliver', text: whole })
  })

  it("rejects broken chunk streams like sync-core's assembler, then recovers", () => {
    const whole = push(['put', presence()])
    const [first, second] = chunked(whole, Math.ceil(whole.length / 3))
    const cases: string[][] = [
      [first as string, whole], // a whole message in the middle of a chunked one
      [first as string, first as string], // wrong order (2 remaining, then 2 again)
      ['not json at all'],
      [' {"type":"ping"}'],
      ['0_"a string"'],
      [second as string, 'x_'],
    ]
    for (const seq of cases) {
      const f = frames()
      const results = seq.map((s) => f.accept(s))
      expect(results.at(-1), JSON.stringify(seq)).toEqual({ kind: 'malformed' })
      expect(f.accept('{"type":"ping"}')).toEqual({ kind: 'deliver', text: '{"type":"ping"}' })
    }
  })

  it('never throws: invalid JSON goes to the room unchanged (which rejects it), a pathological message is refused', () => {
    const f = frames()
    const bad = '{"type":"push","presence":["put",{'
    expect(f.accept(bad)).toEqual({ kind: 'deliver', text: bad })
    const deep = `{"type":"push","clientClock":1,"presence":["put",{"userName":"x","meta":${'['.repeat(20_000)}${']'.repeat(20_000)}}]}`
    expect(() => f.accept(deep)).not.toThrow()
  })
})
