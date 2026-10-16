// Wave T's one wire change, the planning key classes (`card:`, `sb:`, `kanban`, `timeline`; PLANNING_REV 14), against the
// deployed builds' OWN schemas (docs/EXCALIDRAW-CONTRACTS.md §0b, the per-reader downgrade rule):
//  - ../test/fixtures/rev13-6769e07: the canvas-schema of 6769e07, the web on staging since wave S (CONTRACTS_REV 13).
//    `git diff ba1704c 6769e07 -- packages/canvas-schema` is empty (checked at 5e90bb69), so it is also the schema of
//    the deployed sync ba1704c;
//  - ../test/fixtures/rev12-3c83611 and rev11-437b4e7: older webs (a tab of either may still be open somewhere).
// Each web parses every server text frame with its strict `ServerMessage` and drops the whole frame on one key it does
// not know (its socket transport), and the gzip snapshot with `decodeSnapshotFrame`. So:
//  1. what wave T changes in a server frame is listed by diffing this package against the frozen rev-13 one;
//  2. each planning shape is parsed in every frame it can travel in: what the old parses ACCEPT and DROP is pinned;
//  3. `frameForReader(13 | 12 | 11, frame)` is accepted by the old parses and loses nothing a reader keeps (a `p` op
//     becomes the `c` op of the stored element); `frameForReader(14, frame)` is the frame itself;
//  4. the writer side: a rev-13 writer never writes, removes or forges a planning key (`lobbyPatchOfWriter`,
//     `lobbyCreateOfWriter`).

import { describe, expect, it } from 'vitest'
import * as Old11 from '../test/fixtures/rev11-437b4e7/protocol.ts'
import * as Old12 from '../test/fixtures/rev12-3c83611/protocol.ts'
import * as OldCustom from '../test/fixtures/rev13-6769e07/custom-data.ts'
import * as OldElements from '../test/fixtures/rev13-6769e07/elements.ts'
import * as OldHash from '../test/fixtures/rev13-6769e07/hash.ts'
import * as OldLimits from '../test/fixtures/rev13-6769e07/limits.ts'
import * as Old from '../test/fixtures/rev13-6769e07/protocol.ts'
import * as Custom from './custom-data.ts'
import * as Elements from './elements.ts'
import * as Hash from './hash.ts'
import * as Limits from './limits.ts'
import { PLANNING_KEY_CLASSES } from './planning-keys.ts'
import {
  CONTRACTS_REV,
  ELEMENT_SCHEMA_VERSION,
  encodeSnapshotFrame,
  frameForReader,
  GROUP_FIELDS,
  LOBBY_FIELD_ADDITIONS,
  LOBBY_KEY_ADDITIONS,
  lobbyCreateOfWriter,
  lobbyKeyNewerThan,
  lobbyPatchOfWriter,
  NOTICE_CODES,
  opForReader,
  PLANNING_REV,
  PRESENT_MINS_REV,
  REACTIONS_REV,
  READER_RULE_REV,
  REJECT_CODES,
  type ServerMessage,
  ServerMessage as ServerMessageSchema,
  type ServerOp,
  TERMINAL_CLOSE_REASONS,
} from './protocol.ts'
import { reactionKey } from './reactions.ts'
import { SAMPLE_ELEMENTS } from './test-samples.ts'

type Verdict = 'ACCEPT' | 'DROP'
const parseWith =
  (schema: { safeParse(v: unknown): { success: boolean } }) =>
  (frame: unknown): Verdict =>
    schema.safeParse(JSON.parse(JSON.stringify(frame))).success ? 'ACCEPT' : 'DROP'
/** The deployed web (6769e07, rev 13): its socket's `ServerMessage.safeParse` of each text frame. */
const rev13Web = parseWith(Old.ServerMessage)
const rev12Web = parseWith(Old12.ServerMessage)
const rev11Web = parseWith(Old11.ServerMessage)
const OLD_WEBS = [
  ['rev 13', rev13Web, 13],
  ['rev 12', rev12Web, 12],
  ['rev 11', rev11Web, 11],
] as const
const newWeb = parseWith(ServerMessageSchema)

const U1 = 'usr_0123456789'
const UP1 = reactionKey('up', U1)

const note = SAMPLE_ELEMENTS.stickynote as Elements.WireElement
const frameEl = SAMPLE_ELEMENTS.frame as Elements.WireElement
const textEl = SAMPLE_ELEMENTS.text as Elements.WireElement
const withLobby = (el: Elements.WireElement, lobby: Record<string, unknown>, id = el.id) =>
  ({ ...el, id, customData: { ...(el.customData ?? {}), lobby } }) as Elements.WireElement

/** One valid value of every planning key, on the element type it goes on. */
const CARD = {
  'card:status': 'doing',
  'card:who': U1,
  'card:start': '2026-10-01',
  'card:due': '2026-10-20',
  'tag:urgent': { name: 'urgent', color: 'red' },
}
const PANEL = { 'sb:of': 'text-1', 'sb:pos': 'a0', 'sb:dur': 2500 }
const HEAD = { 'sb:head': { aspect: '16:9', fps: 24, defaultMs: 2000, perRow: 6, audio: 'video-1' } }
const KANBAN = { kanban: { labels: { doing: 'Doing now' }, hidden: ['blocked'], wip: { doing: 3 } } }
const TIMELINE = { timeline: { start: '2026-10-01', end: '2027-03-31', scale: 'week', lanes: 'assignee' } }
const card = withLobby(note, CARD)
const panel = withLobby(frameEl, PANEL)
const head = withLobby(textEl, HEAD)
const kanban = withLobby(frameEl, KANBAN, 'frame-k')
const timeline = withLobby(frameEl, TIMELINE, 'frame-t')
const PLANNED = { card, panel, head, kanban, timeline }

/** A server patch of `el` from version `v` to `v + 1` (element-room.ts serverOp's form). */
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
/** `el` as stored after a patch to version `v + 1` with `lobby`. */
const afterOf = (el: Elements.WireElement, lobby: Record<string, unknown>): Elements.WireElement =>
  ({
    ...el,
    version: el.version + 1,
    versionNonce: 7,
    updated: el.updated + 1,
    customData: { ...(el.customData ?? {}), lobby },
  }) as Elements.WireElement
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
const opsOf = (f: ServerMessage) => (f as { ops: ServerOp[] }).ops

/** Every patch `c` a rev-14 room may send that names a planning key: values, removals, and with other keys. */
const PLANNING_PATCHES: [Elements.WireElement, Record<string, unknown>][] = [
  [note, { 'card:status': 'todo' }],
  [note, { 'card:status': null, 'card:who': null, 'card:start': null, 'card:due': null }],
  [note, { 'card:due': '2026-11-02', 'tag:x': null }],
  [note, { 'card:who': U1 }],
  [frameEl, { 'sb:pos': 'a0V' }],
  [frameEl, { 'sb:dur': 3000, 'sb:of': 'text-1', 'sb:pos': 'a1' }],
  [textEl, { 'sb:head': { aspect: '9:16' } }],
  [frameEl, { kanban: { hidden: ['review'] } }],
  [frameEl, { kanban: null }],
  [frameEl, { timeline: { start: '2026-01-01', end: '2026-12-31', scale: 'month', lanes: 'none' } }],
  [frameEl, { timeline: null, present: { index: 2 } }],
]

// ---- 1. the fixture, and what wave T changes in a server frame ------------------------------------------------------

describe('the frozen 6769e07 schemas', () => {
  it('are the rev-13 contracts the deployed web and sync run; this package says 14, the planning revision', () => {
    expect(Old.CONTRACTS_REV).toBe(13)
    expect(CONTRACTS_REV).toBe(14)
    expect(CONTRACTS_REV).toBe(PLANNING_REV)
    expect(READER_RULE_REV).toBe(14)
    expect(LOBBY_KEY_ADDITIONS).toEqual([
      { prefix: 'react:', since: REACTIONS_REV },
      { prefix: 'card:', since: 14 },
      { prefix: 'sb:', since: 14 },
      { prefix: 'kanban', since: 14 },
      { prefix: 'timeline', since: 14 },
    ])
    // no value of an existing key gained a field
    expect(LOBBY_FIELD_ADDITIONS).toEqual([{ key: 'present', field: 'mins', since: PRESENT_MINS_REV }])
  })
})

describe('what wave T changes in a server frame (a diff against the deployed web 6769e07)', () => {
  it('message types, reject and notice codes, close reasons: nothing a rev-13 reader does not know', () => {
    const types = (u: { options: readonly { shape: { type: { value: string } } }[] }) =>
      u.options.map((o) => o.shape.type.value).sort()
    expect(types(ServerMessageSchema as never)).toEqual(types(Old.ServerMessage as never))
    expect(REJECT_CODES).toEqual(Old.REJECT_CODES)
    expect(NOTICE_CODES).toEqual(Old.NOTICE_CODES)
    expect(TERMINAL_CLOSE_REASONS).toEqual(Old.TERMINAL_CLOSE_REASONS)
  })

  it('field groups, wire limits, element types and fields, hash keys: unchanged', () => {
    expect(GROUP_FIELDS).toEqual(Old.GROUP_FIELDS)
    expect(Limits.WIRE_LIMITS).toEqual(OldLimits.WIRE_LIMITS)
    expect(Elements.ELEMENT_TYPES).toEqual(OldElements.ELEMENT_TYPES)
    const shapes = (u: { options: readonly { shape: Record<string, unknown> }[] }) =>
      Object.fromEntries(
        u.options.map((o) => [
          String((o.shape.type as { value: string }).value),
          Object.keys(o.shape).sort(),
        ]),
      )
    expect(shapes(Elements.WireElement as never)).toEqual(shapes(OldElements.WireElement as never))
    expect(Hash.TOMBSTONE_KEYS).toEqual(OldHash.TOMBSTONE_KEYS)
    expect(ELEMENT_SCHEMA_VERSION).toBe(Old.ELEMENT_SCHEMA_VERSION)
  })

  it('customData: the one change is the ten planning keys of the four classes (no lock exemption)', () => {
    const specs = (s: readonly Custom.LobbyKeySpec[]) =>
      s.map(({ match, name, class: cls, maxBytes, duplicate, lockExempt }) => ({
        match,
        name,
        cls,
        maxBytes,
        duplicate,
        lockExempt,
      }))
    const now = specs(Custom.LOBBY_KEY_SPECS)
    const before = specs(OldCustom.LOBBY_KEY_SPECS as never)
    const added = now.filter((s) => !before.some((b) => b.name === s.name))
    expect(added.map((s) => [s.name, s.cls, s.duplicate, s.lockExempt])).toEqual([
      ['card:status', 'free', 'keep', undefined],
      ['card:who', 'api-validated', 'keep', undefined],
      ['card:start', 'free', 'keep', undefined],
      ['card:due', 'free', 'keep', undefined],
      ['sb:of', 'free', 'relink-keep', undefined],
      ['sb:pos', 'free', 'keep', undefined],
      ['sb:dur', 'free', 'keep', undefined],
      ['sb:head', 'free', 'relink-keep', undefined],
      ['kanban', 'free', 'keep', undefined],
      ['timeline', 'free', 'keep', undefined],
    ])
    for (const s of added) expect(s.match).toBe('exact')
    // everything the rev-13 registry had is as it was
    expect(now.filter((s) => before.some((b) => b.name === s.name))).toEqual(before)
    expect(Object.keys(Custom.LobbyServer.shape).sort()).toEqual(
      Object.keys(OldCustom.LobbyServer.shape).sort(),
    )
    // every addition is in a key class LOBBY_KEY_ADDITIONS names at 14, and every class has keys
    for (const s of added) expect(lobbyKeyNewerThan(13, s.name), s.name).toBe(true)
    for (const p of PLANNING_KEY_CLASSES)
      expect(
        added.some((s) => s.name.startsWith(p)),
        p,
      ).toBe(true)
    // `kanban` and `timeline` are exact keys: no other key of the registry starts with either
    for (const exact of ['kanban', 'timeline'])
      expect(Custom.LOBBY_KEY_SPECS.filter((s) => s.name.startsWith(exact)).map((s) => s.name)).toEqual([
        exact,
      ])
  })

  it('every planning key is valid now and unknown to the deployed web, as a value and as a removal', () => {
    for (const el of Object.values(PLANNED)) {
      for (const [k, v] of Object.entries(el.customData?.lobby ?? {})) {
        if (k.startsWith('tag:')) continue
        expect(Custom.lobbyValueProblem(k, v), k).toBeNull()
        expect(OldCustom.lobbyKeySpec(k), k).toBeNull()
        expect(OldCustom.lobbyValueProblem(k, v), k).not.toBeNull()
        for (const r of [13, 12, 11]) expect(lobbyKeyNewerThan(r, k), `${k} @${r}`).toBe(true)
        expect(lobbyKeyNewerThan(14, k), k).toBe(false)
      }
    }
    for (const k of ['tag:x', 'present', 'kind', 'plusOne:usr_1', UP1, 'cards', 'sbx'])
      expect(lobbyKeyNewerThan(13, k), k).toBe(false)
    expect(lobbyKeyNewerThan(12, UP1)).toBe(true)
  })

  it('a planned element is valid for this package and travels whole to the deployed one (its lobby is a record)', () => {
    for (const [what, el] of Object.entries(PLANNED)) {
      expect(Elements.checkElement(el).ok, what).toBe(true)
      expect(OldElements.WireElement.safeParse(el).success, what).toBe(true)
      // the deployed sync's checkElement (merge.ts on every patched element) refuses it: the rollback hazard that the
      // strip-keys route answers for the four classes
      expect(OldElements.checkElement(el as never).ok, what).toBe(false)
    }
  })
})

// ---- 2. each planning shape in every frame it can travel in: ACCEPT or DROP -----------------------------------------

describe('planning keys in every server frame, as the deployed webs parse them', () => {
  it('a `p` op naming a planning key is DROPPED whole by revs 13, 12 and 11, with every other op of the frame', () => {
    const move = patchOp(SAMPLE_ELEMENTS.rectangle as Elements.WireElement, null, { pos: { x: 40, y: 40 } })
    for (const [el, c] of PLANNING_PATCHES) {
      const frame = changes(patchOp(el, c), move)
      expect(newWeb(frame), JSON.stringify(c)).toBe('ACCEPT')
      for (const [name, parse] of OLD_WEBS) expect(parse(frame), `${name} ${JSON.stringify(c)}`).toBe('DROP')
    }
    // the control: the same frame without the planning keys
    for (const [, parse] of OLD_WEBS)
      expect(parse(changes(patchOp(note, { 'tag:x': null }), move))).toBe('ACCEPT')
  })

  it('a whole planned element (a create, a catch-up row, a refusal, the snapshot): ACCEPTED as it is', async () => {
    for (const [what, el] of Object.entries(PLANNED))
      for (const [name, parse] of OLD_WEBS) {
        expect(parse(changes({ k: 'c', el })), `${name} ${what}`).toBe('ACCEPT')
        expect(parse(welcome([{ k: 'c', el }])), `${name} ${what}`).toBe('ACCEPT')
        expect(
          parse({ type: 'ack', seq: 1, clock: 9, r: [{ id: el.id, ok: false, code: 'LOCKED', el }] }),
          `${name} ${what}`,
        ).toBe('ACCEPT')
      }
    const snap = await encodeSnapshotFrame({
      type: 'snapshot',
      epoch: 'e1',
      clock: 9,
      horizon: 0,
      elements: Object.values(PLANNED),
      doc: {},
      docClocks: {},
    })
    for (const decode of [Old.decodeSnapshotFrame, Old12.decodeSnapshotFrame, Old11.decodeSnapshotFrame])
      expect((await decode(snap)).elements).toEqual(Object.values(PLANNED))
  })

  it('an ack fix that strips a planning key from a create (`c:card:status: null`), or names its stored value: ACCEPTED', () => {
    const ack = {
      type: 'ack',
      seq: 1,
      clock: 9,
      r: [
        { id: 'copy-1', ok: true, v: 1, fix: { 'c:card:status': null, 'c:card:who': null } },
        { id: 'frame-1', ok: true, v: 3, fix: { 'c:sb:pos': 'a0', 'c:kanban': KANBAN.kanban } },
      ],
    }
    for (const [name, parse] of OLD_WEBS) expect(parse(ack), name).toBe('ACCEPT')
    expect(frameForReader(13, ack as ServerMessage)).toBe(ack)
  })

  it('the room revision (`contracts` 14): ACCEPTED (read as "13 or later")', () => {
    for (const [name, parse] of OLD_WEBS) expect(parse({ type: 'contracts', rev: 14 }), name).toBe('ACCEPT')
    const f = { type: 'contracts', rev: 14 } as ServerMessage
    expect(frameForReader(13, f)).toBe(f)
  })
})

// ---- 3. frameForReader ----------------------------------------------------------------------------------------------

describe('frameForReader: a rev-13 (12, 11) reader parses every planning frame and keeps what a reader keeps', () => {
  it('a planning patch of a live element becomes its `c` op as stored: accepted, exactly the server copy', () => {
    for (const [el, c] of PLANNING_PATCHES) {
      const lobby = { ...(el.customData?.lobby ?? {}) } as Record<string, unknown>
      for (const [k, v] of Object.entries(c)) if (v === null) delete lobby[k]
      // a stored copy that holds what the patch wrote (a valid element: the cross-key rules need the rest)
      const stored = afterOf(el, { ...lobby })
      const other = patchOp(SAMPLE_ELEMENTS.rectangle as Elements.WireElement, { 'tag:x': null })
      const frame = changes(patchOp(el, c), other)
      for (const [name, parse, reader] of OLD_WEBS) {
        const out = frameForReader(reader, frame, (id) => (id === el.id ? stored : undefined))
        expect(parse(out), `${name} ${JSON.stringify(c)}`).toBe('ACCEPT')
        expect(opsOf(out)[0]).toEqual({ k: 'c', el: stored })
        // the op without a newer key is the same object (no copy per reader)
        expect(opsOf(out)[1]).toBe(opsOf(frame)[1])
      }
    }
  })

  it('in a catch-up too (welcome.catchUp)', () => {
    const stored = afterOf(note, { 'card:status': 'todo' })
    const out = frameForReader(13, welcome([patchOp(note, { 'card:status': 'todo' })]), () => stored)
    expect(rev13Web(out)).toBe('ACCEPT')
    expect((out as { catchUp: ServerOp[] }).catchUp[0]).toEqual({ k: 'c', el: stored })
  })

  it('a tombstone patch with only planning keys: `c` is omitted, and the op is accepted with its version', () => {
    const op = patchOp(frameEl, { 'sb:pos': 'a0V', kanban: null })
    const dead = { ...afterOf(frameEl, {}), isDeleted: true } as Elements.WireElement
    for (const [name, parse, reader] of OLD_WEBS) {
      const out = frameForReader(reader, changes(op), () => dead)
      expect(parse(out), name).toBe('ACCEPT')
      const { c: _c, ...rest } = op as ServerOp & { c?: unknown }
      expect(opsOf(out)[0]).toEqual(rest)
    }
  })

  it('without the stored element, or at another version: the keys are left out, the rest of `c` kept', () => {
    const mixed = patchOp(note, { 'card:status': 'done', 'card:due': null, 'tag:x': null })
    const want = { ...mixed, c: { 'tag:x': null } }
    expect(opsOf(frameForReader(13, changes(mixed)))[0]).toEqual(want)
    const later = { ...afterOf(note, {}), version: note.version + 5 } as Elements.WireElement
    expect(opsOf(frameForReader(13, changes(mixed), () => later))[0]).toEqual(want)
    for (const [name, parse, reader] of OLD_WEBS)
      expect(parse(frameForReader(reader, changes(mixed))), name).toBe('ACCEPT')
  })

  it('with a reaction and present.mins in the same frame, each reader loses only what it cannot read', () => {
    const minsOp = patchOp(frameEl, { present: { index: 0, mins: 5 }, 'sb:pos': 'a2' })
    const reactOp = patchOp(note, { [UP1]: true, 'card:status': 'review' })
    const frame = changes(minsOp, reactOp)
    // rev 13 knows reactions and the minutes: only the planning keys go
    const out13 = frameForReader(13, frame)
    expect(rev13Web(out13)).toBe('ACCEPT')
    expect(opsOf(out13)[0]).toEqual({ ...minsOp, c: { present: { index: 0, mins: 5 } } })
    expect(opsOf(out13)[1]).toEqual({ ...reactOp, c: { [UP1]: true } })
    // rev 12: the reaction goes too
    const out12 = frameForReader(12, frame)
    expect(rev12Web(out12)).toBe('ACCEPT')
    expect('c' in (opsOf(out12)[1] as object)).toBe(false)
    // rev 11: and the minutes
    const out11 = frameForReader(11, frame)
    expect(rev11Web(out11)).toBe('ACCEPT')
    expect(opsOf(out11)[0]).toEqual({ ...minsOp, c: { present: { index: 0 } } })
  })

  it('a rev-14 reader gets every frame as it is; a `c` op is never changed for any reader', () => {
    const op = patchOp(note, { 'card:status': 'todo' })
    const frames: ServerMessage[] = [changes(op), welcome([op]), { type: 'contracts', rev: 14 }]
    for (const f of frames) {
      expect(frameForReader(14, f)).toBe(f)
      expect(frameForReader(PLANNING_REV + 1, f)).toBe(f)
    }
    const whole: ServerOp = { k: 'c', el: card }
    for (const r of [9, 10, 11, 12, 13, 14]) expect(opForReader(r, whole, () => card)).toBe(whole)
  })

  it('frames with no planning key are returned as they are for a rev-13 reader (one serialization for all)', () => {
    const plain = changes(
      patchOp(note, { 'tag:x': null, [UP1]: true }),
      patchOp(note, null, { pos: { x: 1, y: 1 } }),
    )
    expect(frameForReader(13, plain)).toBe(plain)
  })
})

// ---- 4. the writer side -----------------------------------------------------------------------------------------------

describe('a writer below 14 never writes, removes or forges a planning key', () => {
  it('a patch: its planning keys (values and nulls) are dropped, the rest kept; nothing left is null', () => {
    for (const [, c] of PLANNING_PATCHES) {
      const rest = Object.fromEntries(Object.entries(c).filter(([k]) => !lobbyKeyNewerThan(13, k)))
      for (const w of [13, 12, 11])
        expect(lobbyPatchOfWriter(w, c), `${w} ${JSON.stringify(c)}`).toEqual(
          Object.keys(rest).length ? rest : null,
        )
      // a rev-14 writer's patch: the same object
      expect(lobbyPatchOfWriter(14, c)).toBe(c)
    }
    // a rev-13 patch with a reaction keeps it (rev 13 knows reactions)
    expect(lobbyPatchOfWriter(13, { [UP1]: true, 'card:status': 'done' })).toEqual({ [UP1]: true })
  })

  it('a create: planning keys equal to its undelete source are kept (undo of a delete), every other one stripped', () => {
    const lobby = { ...CARD, kind: 'note' }
    // a paste or duplicate in a rev-13 tab (a new id): a plain note, the keys named for the ack fix
    expect(lobbyCreateOfWriter(13, lobby, null)).toEqual({
      lobby: { 'tag:urgent': CARD['tag:urgent'], kind: 'note' },
      stripped: ['card:status', 'card:who', 'card:start', 'card:due'],
    })
    // an undelete of the tombstone that holds them all: kept whole
    const undo = lobbyCreateOfWriter(13, lobby, { ...CARD })
    expect(undo).toEqual({ lobby, stripped: [] })
    expect(undo.lobby).toBe(lobby)
    // an undelete whose source holds another assignee: that one is a forgery and goes
    expect(lobbyCreateOfWriter(13, lobby, { ...CARD, 'card:who': 'usr_someoneelse' }).stripped).toEqual([
      'card:who',
    ])
    expect(lobbyCreateOfWriter(14, lobby, null)).toEqual({ lobby, stripped: [] })
  })

  it('the stripped create is a valid element for both builds, and its ack fix parses for the deployed web', () => {
    for (const el of Object.values(PLANNED)) {
      const { lobby, stripped } = lobbyCreateOfWriter(13, el.customData?.lobby, null)
      const copy = withLobby(el, lobby ?? {}, 'copy-1')
      expect(Elements.checkElement(copy).ok).toBe(true)
      expect(OldElements.checkElement(copy as never).ok).toBe(true)
      const fix = Object.fromEntries(stripped.map((k) => [`c:${k}`, null]))
      expect(rev13Web({ type: 'ack', seq: 1, clock: 1, r: [{ id: 'copy-1', ok: true, v: 1, fix }] })).toBe(
        'ACCEPT',
      )
    }
  })
})
