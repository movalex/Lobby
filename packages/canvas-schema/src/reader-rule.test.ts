// The per-reader rule (protocol.ts `frameForReader`, CONTRACTS_REV 12; docs/EXCALIDRAW-CONTRACTS.md §0b) against the
// deployed web's OWN schemas: the canvas-schema of 437b4e7 (the web on staging since wave K, CONTRACTS_REV 11),
// frozen in ../test/fixtures/rev11-437b4e7. That web parses each server text frame with its strict `ServerMessage`
// and drops the whole frame on one value or field it does not know (its socket transport), and the gzip snapshot
// with `decodeSnapshotFrame`. So:
//  1. what rev 12 changed in a frame is listed by diffing this package against the frozen one (every vocabulary
//     and schema a server frame uses), and each wave L data shape is parsed in every frame it can travel in: what
//     the old parse ACCEPTS and what it DROPS is pinned here, one test per kind of addition;
//  2. `frameForReader(11, frame)` is accepted by the old parse for every one of them, and loses nothing a reader
//     keeps (a `p` op becomes the `c` op of the stored element); `frameForReader(12, frame)` is the frame itself;
//  3. `lobbyWriteOf`, the writer side: a rev-11 writer's write of `present` keeps the stored minutes.

import { describe, expect, it } from 'vitest'
import * as OldCustom from '../test/fixtures/rev11-437b4e7/custom-data.ts'
import * as OldElements from '../test/fixtures/rev11-437b4e7/elements.ts'
import * as OldLimits from '../test/fixtures/rev11-437b4e7/limits.ts'
import * as Old from '../test/fixtures/rev11-437b4e7/protocol.ts'
import * as Custom from './custom-data.ts'
import * as Elements from './elements.ts'
import * as Limits from './limits.ts'
import {
  CONNECT_REV_PARAM,
  CONTRACTS_REV,
  connectRevOf,
  encodeSnapshotFrame,
  frameForReader,
  GROUP_FIELDS,
  LOBBY_FIELD_ADDITIONS,
  LOBBY_KEY_ADDITIONS,
  lobbyValueForReader,
  lobbyValueNewerThan,
  lobbyWriteOf,
  NOTICE_CODES,
  opForReader,
  PRESENT_MINS_REV,
  REJECT_CODES,
  type ServerMessage,
  ServerMessage as ServerMessageSchema,
  type ServerOp,
  TERMINAL_CLOSE_REASONS,
  UNANNOUNCED_REV,
} from './protocol.ts'
import { SAMPLE_ELEMENTS, tombstone } from './test-samples.ts'

const RUN = 'air_0123456789ABCDEFGHIJ'
const BY = 'usr_0123456789'

type Verdict = 'ACCEPT' | 'DROP'
/** What the deployed web does with one text frame: its socket's `ServerMessage.safeParse` of the JSON. */
const oldWeb = (frame: unknown): Verdict =>
  Old.ServerMessage.safeParse(JSON.parse(JSON.stringify(frame))).success ? 'ACCEPT' : 'DROP'
const newWeb = (frame: unknown): Verdict =>
  ServerMessageSchema.safeParse(JSON.parse(JSON.stringify(frame))).success ? 'ACCEPT' : 'DROP'

const withLobby = (el: Elements.WireElement, lobby: Record<string, unknown>, id = el.id) =>
  ({ ...el, id, customData: { ...(el.customData ?? {}), lobby } }) as Elements.WireElement

// ---- the wave L data shapes (what each feature writes; docs/EXCALIDRAW-CONTRACTS.md L-1) ---------------------------

const frameWithMins = withLobby(SAMPLE_ELEMENTS.frame as Elements.WireElement, {
  present: { index: 0, mins: 5 },
})
/** Every element a wave L feature makes, by feature, with the `customData.lobby` it carries. */
const WAVE_L_ELEMENTS: Record<string, Elements.WireElement> = {
  // W5 run of show (L5-1): a frame's planned minutes, written with its index and skip mark
  'frame minutes': withLobby(SAMPLE_ELEMENTS.frame as Elements.WireElement, {
    present: { index: 2, skip: true, mins: 15 },
  }),
  // W2 AI results with provenance (the run id); an answer note; the AI lens reads them
  'AI note': withLobby(SAMPLE_ELEMENTS.stickynote as Elements.WireElement, {
    ai: { by: BY, run: RUN },
    kind: 'ai-idea',
  }),
  'AI answer': withLobby(SAMPLE_ELEMENTS.stickynote as Elements.WireElement, {
    ai: { by: BY, run: RUN },
    kind: 'ai-answer',
  }),
  // W2 Wrap up: the Recap frame and its parts (the AI's with provenance, the room's table and items)
  'recap frame': withLobby(SAMPLE_ELEMENTS.frame as Elements.WireElement, {
    ai: { by: BY, run: RUN },
    kind: 'ai-recap',
  }),
  'recap frame (no AI)': withLobby(SAMPLE_ELEMENTS.frame as Elements.WireElement, { kind: 'recap' }),
  'recap heading': withLobby(SAMPLE_ELEMENTS.text as Elements.WireElement, {
    ai: { by: BY, run: RUN },
    kind: 'ai-recap-heading',
  }),
  'recap table': withLobby(SAMPLE_ELEMENTS.rectangle as Elements.WireElement, { kind: 'recap-table' }),
  'recap item': withLobby(SAMPLE_ELEMENTS.text as Elements.WireElement, { kind: 'recap-item' }),
  // W4 diagram from words (W1's diagram action): nodes, edges and labels with provenance
  'diagram node': withLobby(SAMPLE_ELEMENTS.diamond as Elements.WireElement, {
    ai: { by: BY, run: RUN },
    kind: 'ai-diagram-node',
  }),
  'diagram edge': withLobby(SAMPLE_ELEMENTS.arrow as Elements.WireElement, {
    ai: { by: BY, run: RUN },
    kind: 'ai-diagram-edge',
  }),
  'diagram label': withLobby(SAMPLE_ELEMENTS.text as Elements.WireElement, {
    ai: { by: BY, run: RUN },
    kind: 'ai-diagram-label',
  }),
  // W4 Mermaid paste and the flow's next shape: plain shapes and bound arrows (no new key)
  'flow shape': SAMPLE_ELEMENTS.rectangle as Elements.WireElement,
  'flow connector': SAMPLE_ELEMENTS.arrow as Elements.WireElement,
  // W8 sort headings (by colour, author, tag, votes; by an AI lens with provenance) and the 2x2
  'sort heading': withLobby(SAMPLE_ELEMENTS.text as Elements.WireElement, { kind: 'sort-label' }),
  'AI sort heading': withLobby(SAMPLE_ELEMENTS.text as Elements.WireElement, {
    ai: { by: BY, run: RUN },
    kind: 'ai-sort-label',
  }),
  '2x2 frame': withLobby(SAMPLE_ELEMENTS.frame as Elements.WireElement, { kind: 'sort-matrix' }),
  // W8 pieces: every element of a piece carries `piece-<id>` (at most 26 characters of id)
  piece: withLobby(SAMPLE_ELEMENTS.rectangle as Elements.WireElement, { kind: 'piece-flowchart-decision' }),
  'piece slot': withLobby(SAMPLE_ELEMENTS.rectangle as Elements.WireElement, {
    kind: 'piece-wireframe-image',
    slot: 'image',
  }),
  // W5 results to the board, gather the winners
  'vote chart': withLobby(SAMPLE_ELEMENTS.frame as Elements.WireElement, { kind: 'vote-chart' }),
  'vote winners': withLobby(SAMPLE_ELEMENTS.frame as Elements.WireElement, { kind: 'vote-winners' }),
  'vote rank': withLobby(SAMPLE_ELEMENTS.text as Elements.WireElement, { kind: 'vote-rank' }),
  // tags on any of them (unchanged)
  tagged: withLobby(SAMPLE_ELEMENTS.stickynote as Elements.WireElement, {
    'tag:urgent': { name: 'urgent', color: 'red' },
  }),
}

/**
 * A server patch of `el` from version `v` to `v + 1` (as element-room.ts serverOp makes it): the `c` given (none
 * when null), and the groups `g`.
 */
const patchOp = (
  el: Elements.WireElement,
  c: Record<string, unknown> | null,
  g?: Record<string, unknown>,
): ServerOp =>
  ({
    k: 'p',
    id: el.id,
    v: el.version + 1,
    vn: 7,
    pv: el.version,
    updated: el.updated + 1,
    ...(g ? { g } : {}),
    ...(c ? { c } : {}),
  }) as ServerOp
const changes = (...ops: ServerOp[]): ServerMessage => ({ type: 'changes', clock: 9, ops })
const welcome = (catchUp: ServerOp[]): ServerMessage =>
  ({
    type: 'welcome',
    proto: 1,
    schema: 1,
    sid: 'usr_a:tab',
    you: { uid: 'usr_a', name: 'Ann', color: '#1971c2', role: 'editor', guest: false },
    readonly: false,
    epoch: 'e1',
    clock: 9,
    horizon: 0,
    reset: false,
    catchUp,
    snapshot: null,
    doc: {},
    docClocks: {},
    leases: [],
    roster: [],
    workshop: { voteOpen: false, anonymous: false },
    drags: [],
    limits: { ...Limits.WIRE_LIMITS, leaseTtlMs: 10_000 },
  }) as ServerMessage
/** `el` as stored after `op` (what the room's `after` map holds for a translation). */
const afterOf = (el: Elements.WireElement, lobby: Record<string, unknown>): Elements.WireElement =>
  ({
    ...el,
    version: el.version + 1,
    versionNonce: 7,
    updated: el.updated + 1,
    customData: { ...(el.customData ?? {}), lobby },
  }) as Elements.WireElement

// ---- 1. what changed since the deployed web, by diff ---------------------------------------------------------------

describe('the frozen 437b4e7 schemas', () => {
  it('are the rev-11 contracts the rev-11 web runs; this package is two revisions on (12, and 13: reader-rule-rev13.test.ts)', () => {
    expect(Old.CONTRACTS_REV).toBe(11)
    expect(CONTRACTS_REV).toBe(13)
    expect(UNANNOUNCED_REV).toBe(Old.CONTRACTS_REV)
  })
})

describe('what rev 12 changed in a server frame (a diff against the deployed web)', () => {
  it('message types, reject and notice codes, close reasons: nothing a rev-11 reader does not know', () => {
    const types = (u: { options: readonly { shape: { type: { value: string } } }[] }) =>
      u.options.map((o) => o.shape.type.value).sort()
    expect(types(ServerMessageSchema as never)).toEqual(types(Old.ServerMessage as never))
    expect(REJECT_CODES.filter((c) => !(Old.REJECT_CODES as readonly string[]).includes(c))).toEqual([])
    expect(NOTICE_CODES.filter((c) => !(Old.NOTICE_CODES as readonly string[]).includes(c))).toEqual([])
    expect(
      TERMINAL_CLOSE_REASONS.filter((c) => !(Old.TERMINAL_CLOSE_REASONS as readonly string[]).includes(c)),
    ).toEqual([])
  })

  it('field groups, wire limits, element types and every field of every type: unchanged', () => {
    expect(GROUP_FIELDS).toEqual(Old.GROUP_FIELDS)
    expect(Object.keys(Limits.WIRE_LIMITS).sort()).toEqual(Object.keys(OldLimits.WIRE_LIMITS).sort())
    expect(Elements.ELEMENT_TYPES).toEqual(OldElements.ELEMENT_TYPES)
    expect(Elements.ARROWHEADS).toEqual(OldElements.ARROWHEADS)
    const shapes = (u: { options: readonly { shape: Record<string, unknown> }[] }) =>
      Object.fromEntries(
        u.options.map((o) => [
          String((o.shape.type as { value: string }).value),
          Object.keys(o.shape).sort(),
        ]),
      )
    expect(shapes(Elements.WireElement as never)).toEqual(shapes(OldElements.WireElement as never))
    // every sample element, of every type, parses with the deployed web's element schema
    for (const el of Object.values(SAMPLE_ELEMENTS))
      expect(OldElements.WireElement.safeParse(el).success, el.id).toBe(true)
  })

  it('customData: the same keys, classes, sizes and rules (but wave N key classes); the one value change is present.mins', () => {
    const specs = (s: readonly Custom.LobbyKeySpec[]) =>
      s.map(({ match, name, class: cls, maxBytes, duplicate, lockExempt }) => ({
        match,
        name,
        cls,
        maxBytes,
        duplicate,
        lockExempt,
      }))
    // wave N's key classes (LOBBY_KEY_ADDITIONS, reader-rule-rev13.test.ts) are left out of this rev-11 diff
    const known = Custom.LOBBY_KEY_SPECS.filter((s) => !LOBBY_KEY_ADDITIONS.some((a) => a.prefix === s.name))
    expect(specs(known)).toEqual(specs(OldCustom.LOBBY_KEY_SPECS as never))
    expect(Object.keys(Custom.LobbyServer.shape).sort()).toEqual(
      Object.keys(OldCustom.LobbyServer.shape).sort(),
    )
    // the value change, pinned both ways
    expect(Custom.lobbyValueProblem('present', { index: 1, mins: 5 })).toBeNull()
    expect(OldCustom.lobbyValueProblem('present', { index: 1, mins: 5 })).not.toBeNull()
    // and the table of additions names exactly it
    expect(LOBBY_FIELD_ADDITIONS).toEqual([{ key: 'present', field: 'mins', since: PRESENT_MINS_REV }])
  })

  it('every customData.lobby value a wave L feature writes, but present.mins, is valid for the deployed web', () => {
    for (const [what, el] of Object.entries(WAVE_L_ELEMENTS)) {
      const lobby = (el.customData?.lobby ?? {}) as Record<string, unknown>
      for (const [k, v] of Object.entries(lobby)) {
        const now = Custom.lobbyValueProblem(k, v)
        expect(now, `${what}: ${k}`).toBeNull()
        const before = OldCustom.lobbyValueProblem(k, v)
        if (lobbyValueNewerThan(11, k, v)) expect(before, `${what}: ${k}`).not.toBeNull()
        else expect(before, `${what}: ${k}`).toBeNull()
      }
      expect(Elements.checkElement(el).ok, what).toBe(true)
    }
  })
})

// ---- 1b. each addition in every frame it can travel in: ACCEPT or DROP --------------------------------------------

describe('each wave L data shape in every server frame, as the deployed web parses it', () => {
  it('present.mins: a `changes` patch carrying it is DROPPED whole, with every other op of the frame', () => {
    // a note's move committed in the same batch (element-room.ts serializes one `changes` frame per commit)
    const move = patchOp(SAMPLE_ELEMENTS.text as Elements.WireElement, null, { pos: { x: 40, y: 40 } })
    const frame = changes(
      patchOp(SAMPLE_ELEMENTS.frame as Elements.WireElement, { present: { index: 0, mins: 5 } }),
      move,
    )
    expect(newWeb(frame)).toBe('ACCEPT')
    expect(oldWeb(frame)).toBe('DROP')
    // the same frame without the minutes: accepted (the control)
    const control = changes(
      patchOp(SAMPLE_ELEMENTS.frame as Elements.WireElement, { present: { index: 0 } }),
      move,
    )
    expect(oldWeb(control)).toBe('ACCEPT')
  })

  it('present.mins in a whole element (a create, a catch-up row, a repair, a refusal, the snapshot): ACCEPTED', async () => {
    expect(oldWeb(changes({ k: 'c', el: frameWithMins }))).toBe('ACCEPT')
    expect(oldWeb(welcome([{ k: 'c', el: frameWithMins }]))).toBe('ACCEPT')
    expect(
      oldWeb({
        type: 'ack',
        seq: 1,
        clock: 9,
        r: [{ id: 'frame-1', ok: false, code: 'LOCKED', el: frameWithMins }],
      }),
    ).toBe('ACCEPT')
    const snap = await encodeSnapshotFrame({
      type: 'snapshot',
      epoch: 'e1',
      clock: 9,
      horizon: 0,
      elements: [frameWithMins],
      doc: {},
      docClocks: {},
    })
    expect((await Old.decodeSnapshotFrame(snap)).elements[0]).toEqual(frameWithMins)
  })

  it('present.mins in an ack fix (`c:present`, the stored value after a merge): ACCEPTED', () => {
    const ack = {
      type: 'ack',
      seq: 1,
      clock: 9,
      r: [{ id: 'frame-1', ok: true, v: 3, fix: { 'c:present': { index: 0, mins: 5 } } }],
      derived: [{ id: 'arrow-1', v: 2, fix: { x: 1 } }],
    }
    expect(oldWeb(ack)).toBe('ACCEPT')
  })

  it('the laser in presence (`t`, `trail`): DROPPED (the room never sends them to a rev-11 reader)', () => {
    const peer = {
      sid: 'usr_b:tab',
      pointer: { x: 1, y: 2 },
      button: 'down',
      sel: [],
      view: { x: 0, y: 0, w: 10, h: 10, z: 1 },
      idle: false,
      editing: null,
      f: 'usr_c:tab',
    }
    expect(oldWeb({ type: 'presence', peers: [peer] })).toBe('ACCEPT')
    expect(oldWeb({ type: 'presence', peers: [{ ...peer, t: 'laser' }] })).toBe('DROP')
    expect(oldWeb({ type: 'presence', peers: [{ ...peer, trail: [{ x: 1, y: 2 }] }] })).toBe('DROP')
  })

  it('the room revision (`contracts` 12): ACCEPTED (read as "10 or later")', () => {
    expect(oldWeb({ type: 'contracts', rev: 12 })).toBe('ACCEPT')
  })

  it('every other message type the room sends, as it builds them, every code and reason included: ACCEPTED', () => {
    const holder = { sid: 'usr_b:tab', uid: 'usr_b', name: 'Bob' }
    const entry = {
      sid: 'usr_b:tab',
      uid: 'usr_b',
      name: 'Bob',
      color: '#1971c2',
      role: 'editor',
      guest: false,
    }
    const frames: unknown[] = [
      // a reset welcome (the binary snapshot follows), and one with the board document and its clocks
      {
        ...welcome([]),
        reset: true,
        catchUp: null,
        snapshot: { elements: 3, bytes: 900 },
        doc: { 'tagDef:urgent': { name: 'urgent', color: 'red' } },
        docClocks: { 'tagDef:urgent': 4 },
        leases: [{ id: 'note-1', holder }],
        roster: [entry],
        drags: [{ sid: 'usr_b:tab', d: 1, ids: ['note-1'], dx: 2, dy: 3 }],
      },
      { type: 'lease.grant', req: 1, id: 'note-1', ttlMs: 10_000 },
      { type: 'lease.deny', req: 2, id: 'note-1', holder },
      { type: 'lease', id: 'note-1', holder: null },
      {
        type: 'roster',
        events: [
          { k: 'join', p: entry },
          { k: 'leave', sid: 'usr_c:tab' },
        ],
      },
      { type: 'workshop', voteOpen: true, anonymous: true },
      { type: 'pong', n: 3 },
      { type: 'receipts', req: 1, landed: { 'p1.1': 5 }, from: 2 },
      {
        type: 'ack',
        seq: 2,
        clock: 5,
        r: [{ id: 'note-1', ok: true, v: 3, fitDropped: true, denied: { groups: ['text'], code: 'LEASED' } }],
        docDenied: { keys: ['startView'], code: 'READ_ONLY' },
      },
      {
        type: 'presence',
        peers: [],
        off: ['usr_c:tab'],
        drags: [{ sid: 'usr_b:tab', d: 1, end: true }],
        followers: ['usr_c:tab'],
      },
      { type: 'changes', clock: 6, ops: [], doc: { set: { startView: null } } },
    ]
    for (const code of NOTICE_CODES) frames.push({ type: 'notice', code })
    for (const reason of TERMINAL_CLOSE_REASONS)
      frames.push({ type: 'notice', code: 'CLOSING', detail: reason })
    for (const code of REJECT_CODES)
      frames.push({ type: 'ack', seq: 1, clock: 1, r: [{ id: 'x', ok: false, code, el: null }] })
    for (const f of frames) {
      expect(newWeb(f), JSON.stringify(f).slice(0, 80)).toBe('ACCEPT')
      expect(oldWeb(f), JSON.stringify(f).slice(0, 80)).toBe('ACCEPT')
      // and the rule leaves every one of them as it is, for every older reader
      expect(frameForReader(11, f as ServerMessage)).toBe(f)
    }
  })

  it('every other wave L shape (AI provenance, recap, diagram, flow, sort, 2x2, pieces, vote results, tags): ACCEPTED in every frame', async () => {
    for (const [what, el] of Object.entries(WAVE_L_ELEMENTS)) {
      if (what === 'frame minutes') continue
      const lobby = (el.customData?.lobby ?? {}) as Record<string, unknown>
      // the create, the catch-up row, the refusal's stored copy
      expect(oldWeb(changes({ k: 'c', el })), `${what}: create`).toBe('ACCEPT')
      expect(oldWeb(welcome([{ k: 'c', el }])), `${what}: catch-up`).toBe('ACCEPT')
      expect(
        oldWeb({ type: 'ack', seq: 1, clock: 9, r: [{ id: el.id, ok: false, code: 'INVALID', el }] }),
        `${what}: refusal`,
      ).toBe('ACCEPT')
      // a patch that writes its free keys (a re-tag, a slot), and one that removes its create-only ones
      const free = Object.fromEntries(Object.entries(lobby).filter(([k]) => !['ai', 'kind'].includes(k)))
      if (Object.keys(free).length)
        expect(oldWeb(changes(patchOp(el, free))), `${what}: patch`).toBe('ACCEPT')
      const removed = Object.fromEntries(Object.keys(lobby).map((k) => [k, null]))
      if (Object.keys(removed).length)
        expect(oldWeb(changes(patchOp(el, removed))), `${what}: removal`).toBe('ACCEPT')
      // and the gzip snapshot
      const snap = await encodeSnapshotFrame({
        type: 'snapshot',
        epoch: 'e1',
        clock: 9,
        horizon: 0,
        elements: [el],
        doc: {},
      })
      await expect(Old.decodeSnapshotFrame(snap), `${what}: snapshot`).resolves.toBeTruthy()
    }
  })
})

// ---- 2. frameForReader --------------------------------------------------------------------------------------------

describe('frameForReader: a rev-11 reader parses every frame, and keeps everything a reader keeps', () => {
  const frameEl = SAMPLE_ELEMENTS.frame as Elements.WireElement
  const stored = afterOf(frameEl, { present: { index: 0, mins: 5 } })
  const minsOp = patchOp(frameEl, { present: { index: 0, mins: 5 } })

  it('a patch with present.mins becomes the `c` op of the element as stored: accepted, and exactly the server copy', () => {
    const frame = changes(minsOp, patchOp(SAMPLE_ELEMENTS.text as Elements.WireElement, { 'tag:x': null }))
    const out = frameForReader(11, frame, (id) => (id === stored.id ? stored : undefined))
    expect(oldWeb(out)).toBe('ACCEPT')
    const ops = (out as { ops: ServerOp[] }).ops
    expect(ops[0]).toEqual({ k: 'c', el: stored })
    // the op without a newer value is the same object (no copy per reader)
    expect(ops[1]).toBe((frame as { ops: ServerOp[] }).ops[1])
  })

  it('the same patch of a deleted element keeps its form without the minutes (a tombstone is never sent whole)', () => {
    const dead = { ...stored, isDeleted: true } as Elements.WireElement
    const out = frameForReader(11, changes(minsOp), () => dead)
    expect(oldWeb(out)).toBe('ACCEPT')
    expect((out as { ops: ServerOp[] }).ops[0]).toEqual({ ...minsOp, c: { present: { index: 0 } } })
    // and so does a patch whose stored element the caller does not have
    expect((frameForReader(11, changes(minsOp)) as { ops: ServerOp[] }).ops[0]).toEqual({
      ...minsOp,
      c: { present: { index: 0 } },
    })
  })

  it('a stored element at another version than the op is not used (the op left out the minutes instead)', () => {
    const later = { ...stored, version: stored.version + 1 } as Elements.WireElement
    const out = frameForReader(11, changes(minsOp), () => later)
    expect((out as { ops: ServerOp[] }).ops[0]).toEqual({ ...minsOp, c: { present: { index: 0 } } })
  })

  it('presence: no `t`, no `trail` for a rev-11 reader; everything else as it was', () => {
    const peer = {
      sid: 'usr_b:tab',
      pointer: { x: 1, y: 2 },
      button: 'down' as const,
      sel: [],
      view: { x: 0, y: 0, w: 10, h: 10, z: 2 },
      idle: false,
      editing: null,
      f: 'usr_c:tab',
      t: 'laser' as const,
      trail: [{ x: 1, y: 2 }],
    }
    const frame = { type: 'presence', peers: [peer], followers: ['usr_c:tab'] } as ServerMessage
    const out = frameForReader(11, frame)
    expect(oldWeb(out)).toBe('ACCEPT')
    const { t: _t, trail: _trail, ...rest } = peer
    expect(out).toEqual({ type: 'presence', peers: [rest], followers: ['usr_c:tab'] })
  })

  it('every frame of every wave L shape, downgraded for rev 11, is accepted; for rev 12 it is the frame itself', () => {
    const frames: ServerMessage[] = [welcome([]), { type: 'contracts', rev: 12 }, { type: 'pong' }]
    const elements = new Map<string, Elements.WireElement>()
    for (const [what, el] of Object.entries(WAVE_L_ELEMENTS)) {
      const id = `wl-${what.replace(/[^a-z0-9]+/g, '-')}`
      const e = { ...el, id } as Elements.WireElement
      const lobby = (e.customData?.lobby ?? {}) as Record<string, unknown>
      const free = Object.fromEntries(Object.entries(lobby).filter(([k]) => !['ai', 'kind'].includes(k)))
      frames.push(changes({ k: 'c', el: e }), welcome([{ k: 'c', el: e }]))
      if (Object.keys(free).length) {
        const op = patchOp(e, free)
        elements.set(id, afterOf(e, lobby))
        frames.push(changes(op))
      }
    }
    for (const f of frames) {
      const out = frameForReader(11, f, (id) => elements.get(id))
      expect(oldWeb(out), f.type).toBe('ACCEPT')
      expect(newWeb(out), f.type).toBe('ACCEPT')
      expect(frameForReader(12, f, (id) => elements.get(id))).toBe(f)
      expect(frameForReader(CONTRACTS_REV + 1, f)).toBe(f)
    }
  })

  it('a `c` op is never changed, for any reader (so the catch-up and the snapshot are the same for every reader)', () => {
    for (const el of [...Object.values(WAVE_L_ELEMENTS), tombstone(frameWithMins)]) {
      const op: ServerOp = { k: 'c', el }
      for (const r of [9, 10, 11, 12]) expect(opForReader(r, op, () => el)).toBe(op)
    }
  })

  it('frames with nothing newer are returned as they are (one serialization for every reader)', () => {
    const plain = changes(patchOp(SAMPLE_ELEMENTS.frame as Elements.WireElement, { present: { index: 3 } }))
    expect(frameForReader(11, plain)).toBe(plain)
    const ack = { type: 'ack', seq: 1, clock: 2, r: [] } as ServerMessage
    expect(frameForReader(11, ack)).toBe(ack)
  })
})

// ---- 3. the writer side, and the reader's revision ---------------------------------------------------------------

describe('lobbyWriteOf: what an older writer cannot know is kept', () => {
  const stored = { index: 2, skip: true, mins: 15 }
  it('a rev-11 reorder (index, skip) keeps the minutes; a rev-12 one writes what it says', () => {
    expect(lobbyWriteOf(11, 'present', { index: 3 }, stored)).toEqual({ index: 3, mins: 15 })
    expect(lobbyWriteOf(11, 'present', { index: 3, skip: true }, stored)).toEqual({
      index: 3,
      skip: true,
      mins: 15,
    })
    expect(lobbyWriteOf(12, 'present', { index: 3 }, stored)).toEqual({ index: 3 })
  })
  it('a rev-11 removal of `present` (no index, not skipped) keeps the minutes alone', () => {
    expect(lobbyWriteOf(11, 'present', null, stored)).toEqual({ mins: 15 })
    expect(lobbyWriteOf(11, 'present', null, { index: 2 })).toBeNull()
    expect(lobbyWriteOf(12, 'present', null, stored)).toBeNull()
  })
  it('a value that carries the field, other keys, and nothing stored: written as they are', () => {
    const w = { index: 1, mins: 5 }
    expect(lobbyWriteOf(11, 'present', w, stored)).toBe(w)
    const tag = { name: 'x', color: 'red' }
    expect(lobbyWriteOf(11, 'tag:x', tag, { name: 'y', color: 'blue' })).toBe(tag)
    expect(lobbyWriteOf(11, 'present', { index: 1 }, undefined)).toEqual({ index: 1 })
    expect(lobbyWriteOf(11, 'present', { index: 1 }, { index: 2 })).toEqual({ index: 1 })
  })
  it('the merged value is valid for this revision and readers strip it back to what the writer wrote', () => {
    const merged = lobbyWriteOf(11, 'present', { index: 3 }, stored)
    expect(Custom.lobbyValueProblem('present', merged)).toBeNull()
    expect(lobbyValueForReader(11, 'present', merged)).toEqual({ index: 3 })
  })
})

describe("the socket's revision", () => {
  it('the connect URL names it (`rev`); a missing or malformed one is an older client', () => {
    expect(CONNECT_REV_PARAM).toBe('rev')
    expect(connectRevOf('12')).toBe(12)
    expect(connectRevOf('13')).toBe(13)
    for (const bad of [null, undefined, '', '0', '-1', '12.5', '1e3', ' 12', 'x', '1234567'])
      expect(connectRevOf(bad as string), String(bad)).toBeNull()
  })
})
