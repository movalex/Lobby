// Wave N's one wire addition, emoji reactions on notes (`react:<code>:<uid>`, REACTIONS_REV 13), against the deployed
// builds' OWN schemas (docs/EXCALIDRAW-CONTRACTS.md §0b, the per-reader downgrade rule):
//  - ../test/fixtures/rev12-3c83611: the canvas-schema of 3c83611, the web on staging since hotfix H2 (wave M,
//    CONTRACTS_REV 12). `git diff 104c6e0 3c83611 -- packages` is empty (checked at 81dcf025), so it is also the
//    schema of the deployed sync 104c6e0;
//  - ../test/fixtures/rev11-437b4e7: the rev-11 web (UNANNOUNCED_REV sockets are still possible).
// Each deployed web parses every server text frame with its strict `ServerMessage` and drops the whole frame on one
// key it does not know (its socket transport), and the gzip snapshot with `decodeSnapshotFrame`. So:
//  1. what wave N changes in a server frame is listed by diffing this package against the frozen rev-12 one;
//  2. each reaction shape is parsed in every frame it can travel in: what the old parses ACCEPT and DROP is pinned;
//  3. `frameForReader(12 | 11, frame)` is accepted by the old parses and loses nothing a reader keeps (a `p` op
//     becomes the `c` op of the stored element); `frameForReader(13, frame)` is the frame itself;
//  4. the writer side: a rev-12 writer never writes, removes or forges a reaction (`lobbyPatchOfWriter`,
//     `lobbyCreateOfWriter`).
// This package said CONTRACTS_REV 13 (the room says 13 once the sync's rules for the class landed, N2-4); the rule
// serves every reader below REACTIONS_REV, as it did while the foundation still said 12. Since wave T it says 14
// (reader-rule-rev14.test.ts proves wave T's key classes against the rev-13 web); what is pinned here still holds.

import { REACTION_CODES } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import * as Old11 from '../test/fixtures/rev11-437b4e7/protocol.ts'
import * as OldCustom from '../test/fixtures/rev12-3c83611/custom-data.ts'
import * as OldElements from '../test/fixtures/rev12-3c83611/elements.ts'
import * as OldHash from '../test/fixtures/rev12-3c83611/hash.ts'
import * as OldLimits from '../test/fixtures/rev12-3c83611/limits.ts'
import * as Old from '../test/fixtures/rev12-3c83611/protocol.ts'
import * as Custom from './custom-data.ts'
import * as Elements from './elements.ts'
import * as Hash from './hash.ts'
import * as Limits from './limits.ts'
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
  PRESENT_MINS_REV,
  REACTIONS_REV,
  READER_RULE_REV,
  REJECT_CODES,
  type ServerMessage,
  ServerMessage as ServerMessageSchema,
  type ServerOp,
  TERMINAL_CLOSE_REASONS,
  UNANNOUNCED_REV,
} from './protocol.ts'
import { reactionKey } from './reactions.ts'
import { SAMPLE_ELEMENTS } from './test-samples.ts'

type Verdict = 'ACCEPT' | 'DROP'
const parseWith =
  (schema: { safeParse(v: unknown): { success: boolean } }) =>
  (frame: unknown): Verdict =>
    schema.safeParse(JSON.parse(JSON.stringify(frame))).success ? 'ACCEPT' : 'DROP'
/** The deployed web (3c83611, rev 12): its socket's `ServerMessage.safeParse` of each text frame. */
const rev12Web = parseWith(Old.ServerMessage)
/** The rev-11 web (437b4e7). */
const rev11Web = parseWith(Old11.ServerMessage)
const newWeb = parseWith(ServerMessageSchema)

const U1 = 'usr_0123456789'
const U2 = 'usr_abcdefghij'
const UP1 = reactionKey('up', U1)
const HEART2 = reactionKey('heart', U2)

const note = SAMPLE_ELEMENTS.stickynote as Elements.WireElement
const withLobby = (el: Elements.WireElement, lobby: Record<string, unknown>, id = el.id) =>
  ({ ...el, id, customData: { ...(el.customData ?? {}), lobby } }) as Elements.WireElement
/** A reacted note, as stored. */
const reacted = withLobby(note, {
  [UP1]: true,
  [HEART2]: true,
  'tag:urgent': { name: 'urgent', color: 'red' },
})

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

// ---- 1. the fixture, and what wave N changes in a server frame ------------------------------------------------------

describe('the frozen 3c83611 schemas', () => {
  it('are the rev-12 contracts the wave N deploy found; this package is past the reactions revision (14 since wave T)', () => {
    expect(Old.CONTRACTS_REV).toBe(12)
    expect(CONTRACTS_REV).toBe(14)
    expect(CONTRACTS_REV).toBeGreaterThan(REACTIONS_REV)
    expect(REACTIONS_REV).toBe(13)
    expect(READER_RULE_REV).toBe(14)
    expect(UNANNOUNCED_REV).toBe(11)
    expect(LOBBY_KEY_ADDITIONS.filter((a) => a.since <= REACTIONS_REV)).toEqual([
      { prefix: 'react:', since: REACTIONS_REV },
    ])
    expect(LOBBY_FIELD_ADDITIONS).toEqual([{ key: 'present', field: 'mins', since: PRESENT_MINS_REV }])
  })
})

describe('what wave N changes in a server frame (a diff against the deployed web 3c83611)', () => {
  it('message types, reject and notice codes, close reasons: nothing a rev-12 reader does not know', () => {
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

  it('customData: the one change is the `react:` key class (identity-bound, strip on duplicate, lock-exempt own)', () => {
    const specs = (s: readonly Custom.LobbyKeySpec[]) =>
      s.map(({ match, name, class: cls, maxBytes, duplicate, lockExempt }) => ({
        match,
        name,
        cls,
        maxBytes,
        duplicate,
        lockExempt,
      }))
    // wave T's classes (since 14) are reader-rule-rev14.test.ts's diff
    const now = specs(
      Custom.LOBBY_KEY_SPECS.filter(
        (s) => !LOBBY_KEY_ADDITIONS.some((a) => a.since > REACTIONS_REV && s.name.startsWith(a.prefix)),
      ),
    )
    const before = specs(OldCustom.LOBBY_KEY_SPECS as never)
    const added = now.filter((s) => !before.some((b) => b.name === s.name))
    expect(added).toEqual([
      {
        match: 'prefix',
        name: 'react:',
        cls: 'identity-bound',
        maxBytes: 32,
        duplicate: 'strip',
        lockExempt: 'own',
      },
    ])
    expect(now.filter((s) => s.name !== 'react:')).toEqual(before)
    expect(Object.keys(Custom.LobbyServer.shape).sort()).toEqual(
      Object.keys(OldCustom.LobbyServer.shape).sort(),
    )
    // every addition is a key class LOBBY_KEY_ADDITIONS names
    for (const s of added) expect(LOBBY_KEY_ADDITIONS.map((a) => a.prefix)).toContain(s.name)
  })

  it('a reaction key is valid now and unknown to the deployed web, as a value and as a removal', () => {
    for (const code of REACTION_CODES) {
      const k = reactionKey(code, U1)
      expect(Custom.lobbyValueProblem(k, true), k).toBeNull()
      expect(OldCustom.lobbyValueProblem(k, true), k).not.toBeNull()
      expect(OldCustom.lobbyKeySpec(k), k).toBeNull()
      expect(lobbyKeyNewerThan(12, k)).toBe(true)
      expect(lobbyKeyNewerThan(11, k)).toBe(true)
      expect(lobbyKeyNewerThan(13, k)).toBe(false)
    }
    for (const k of ['plusOne:usr_1', 'tag:x', 'present', 'reaction', 'reactx'])
      expect(lobbyKeyNewerThan(12, k), k).toBe(false)
  })

  it('a reacted note is a valid element for this package and for the deployed one (its lobby is a record)', () => {
    expect(Elements.checkElement(reacted).ok).toBe(true)
    expect(OldElements.WireElement.safeParse(reacted).success).toBe(true)
    // the deployed sync's checkElement (merge.ts on every patched element) refuses it: the rollback hazard that
    // the strip-keys route answers (plan N2-5)
    expect(OldElements.checkElement(reacted as never).ok).toBe(false)
  })
})

// ---- 2. each reaction shape in every frame it can travel in: ACCEPT or DROP -----------------------------------------

describe('reactions in every server frame, as the deployed webs parse them', () => {
  it('a `p` op naming a reaction key is DROPPED whole by rev 12 and rev 11, with every other op of the frame', () => {
    const move = patchOp(SAMPLE_ELEMENTS.text as Elements.WireElement, null, { pos: { x: 40, y: 40 } })
    for (const c of [{ [UP1]: true }, { [UP1]: null }, { [UP1]: true, 'tag:x': null }]) {
      const frame = changes(patchOp(note, c), move)
      expect(newWeb(frame)).toBe('ACCEPT')
      expect(rev12Web(frame), JSON.stringify(c)).toBe('DROP')
      expect(rev11Web(frame), JSON.stringify(c)).toBe('DROP')
    }
    // the control: the same frame without the reaction
    expect(rev12Web(changes(patchOp(note, { 'tag:x': null }), move))).toBe('ACCEPT')
  })

  it('a whole reacted note (a create, a catch-up row, a refusal, the snapshot): ACCEPTED as it is', async () => {
    for (const parse of [rev12Web, rev11Web]) {
      expect(parse(changes({ k: 'c', el: reacted }))).toBe('ACCEPT')
      expect(parse(welcome([{ k: 'c', el: reacted }]))).toBe('ACCEPT')
      expect(
        parse({
          type: 'ack',
          seq: 1,
          clock: 9,
          r: [{ id: note.id, ok: false, code: 'LOCKED', el: reacted }],
        }),
      ).toBe('ACCEPT')
    }
    const snap = await encodeSnapshotFrame({
      type: 'snapshot',
      epoch: 'e1',
      clock: 9,
      horizon: 0,
      elements: [reacted],
      doc: {},
      docClocks: {},
    })
    expect((await Old.decodeSnapshotFrame(snap)).elements[0]).toEqual(reacted)
    expect((await Old11.decodeSnapshotFrame(snap)).elements[0]).toEqual(reacted)
  })

  it('an ack fix that strips a reaction from a create (`c:react:…: null`), and the stored value: ACCEPTED', () => {
    const ack = {
      type: 'ack',
      seq: 1,
      clock: 9,
      r: [{ id: 'copy-1', ok: true, v: 1, fix: { [`c:${UP1}`]: null, [`c:${HEART2}`]: true } }],
    }
    expect(rev12Web(ack)).toBe('ACCEPT')
    expect(rev11Web(ack)).toBe('ACCEPT')
    expect(frameForReader(12, ack as ServerMessage)).toBe(ack)
  })

  it('the room revision (`contracts` 13): ACCEPTED (read as "12 or later")', () => {
    expect(rev12Web({ type: 'contracts', rev: 13 })).toBe('ACCEPT')
    expect(rev11Web({ type: 'contracts', rev: 13 })).toBe('ACCEPT')
    const f = { type: 'contracts', rev: 13 } as ServerMessage
    expect(frameForReader(12, f)).toBe(f)
  })
})

// ---- 3. frameForReader ----------------------------------------------------------------------------------------------

describe('frameForReader: a rev-12 (and rev-11) reader parses every reaction frame and keeps what a reader keeps', () => {
  const lobby = { [UP1]: true, 'tag:urgent': { name: 'urgent', color: 'red' } }
  const stored = afterOf(note, lobby)
  const reactOp = patchOp(note, { [UP1]: true })
  const storedOf = (id: string) => (id === stored.id ? stored : undefined)

  it('a reaction patch of a live note becomes the `c` op of the note as stored: accepted, exactly the server copy', () => {
    const other = patchOp(SAMPLE_ELEMENTS.text as Elements.WireElement, { 'tag:x': null })
    const frame = changes(reactOp, other)
    for (const reader of [12, 11]) {
      const out = frameForReader(reader, frame, storedOf)
      expect(rev12Web(out)).toBe('ACCEPT')
      expect(rev11Web(out)).toBe('ACCEPT')
      expect(opsOf(out)[0]).toEqual({ k: 'c', el: stored })
      // the op without a newer key is the same object (no copy per reader)
      expect(opsOf(out)[1]).toBe(opsOf(frame)[1])
    }
    // a removal (an owner's Clear reactions) is translated the same way
    const cleared = afterOf(note, {})
    const out = frameForReader(12, changes(patchOp(note, { [UP1]: null })), () => cleared)
    expect(opsOf(out)[0]).toEqual({ k: 'c', el: cleared })
    expect(rev12Web(out)).toBe('ACCEPT')
  })

  it('in a catch-up too (welcome.catchUp)', () => {
    const out = frameForReader(12, welcome([reactOp]), storedOf)
    expect(rev12Web(out)).toBe('ACCEPT')
    expect((out as { catchUp: ServerOp[] }).catchUp[0]).toEqual({ k: 'c', el: stored })
  })

  it('a tombstone patch with only a reaction key: `c` is omitted, and the op is accepted with its version', () => {
    const dead = { ...stored, isDeleted: true } as Elements.WireElement
    const out = frameForReader(12, changes(reactOp), () => dead)
    expect(rev12Web(out)).toBe('ACCEPT')
    const { c: _c, ...rest } = reactOp as ServerOp & { c?: unknown }
    expect(opsOf(out)[0]).toEqual(rest)
    expect('c' in (opsOf(out)[0] as object)).toBe(false)
  })

  it('without the stored note, or at another version: the keys are left out, the rest of `c` kept', () => {
    const mixed = patchOp(note, { [UP1]: true, [HEART2]: null, 'tag:x': null })
    const want = { ...mixed, c: { 'tag:x': null } }
    expect(opsOf(frameForReader(12, changes(mixed)))[0]).toEqual(want)
    const later = { ...stored, version: stored.version + 1 } as Elements.WireElement
    expect(opsOf(frameForReader(12, changes(mixed), () => later))[0]).toEqual(want)
    expect(rev12Web(frameForReader(12, changes(mixed)))).toBe('ACCEPT')
  })

  it('with present.mins in the same frame, a rev-11 reader loses neither rule (a frame patch and a note patch)', () => {
    const frameEl = SAMPLE_ELEMENTS.frame as Elements.WireElement
    const minsOp = patchOp(frameEl, { present: { index: 0, mins: 5 } })
    const out = frameForReader(11, changes(minsOp, patchOp(note, { [UP1]: true, 'tag:x': null })))
    expect(rev11Web(out)).toBe('ACCEPT')
    expect(opsOf(out)[0]).toEqual({ ...minsOp, c: { present: { index: 0 } } })
    // a rev-12 reader knows the minutes: only the reaction is left out
    const out12 = frameForReader(12, changes(minsOp, patchOp(note, { [UP1]: true, 'tag:x': null })))
    expect(opsOf(out12)[0]).toBe(minsOp)
    expect(rev12Web(out12)).toBe('ACCEPT')
  })

  it('a rev-13 reader gets every frame as it is; a `c` op is never changed for any reader', () => {
    const frames: ServerMessage[] = [changes(reactOp), welcome([reactOp]), { type: 'contracts', rev: 13 }]
    for (const f of frames) {
      expect(frameForReader(13, f, storedOf)).toBe(f)
      expect(frameForReader(REACTIONS_REV + 1, f, storedOf)).toBe(f)
    }
    const op: ServerOp = { k: 'c', el: reacted }
    for (const r of [9, 10, 11, 12, 13]) expect(opForReader(r, op, () => reacted)).toBe(op)
  })

  it('frames with no reaction are returned as they are for a rev-12 reader (one serialization for all)', () => {
    const plain = changes(patchOp(note, { 'tag:x': null }), patchOp(note, null, { pos: { x: 1, y: 1 } }))
    expect(frameForReader(12, plain)).toBe(plain)
    const ack = { type: 'ack', seq: 1, clock: 2, r: [] } as ServerMessage
    expect(frameForReader(12, ack)).toBe(ack)
  })
})

// ---- 4. the writer side -----------------------------------------------------------------------------------------------

describe('a writer below 13 never writes, removes or forges a reaction', () => {
  it('a patch: its reaction keys (values and nulls) are dropped, the rest kept; nothing left is null', () => {
    const c = { [UP1]: null, [HEART2]: true, 'tag:x': null }
    expect(lobbyPatchOfWriter(12, c)).toEqual({ 'tag:x': null })
    expect(lobbyPatchOfWriter(11, c)).toEqual({ 'tag:x': null })
    expect(lobbyPatchOfWriter(12, { [UP1]: null })).toBeNull()
    // a rev-13 writer's patch, and a rev-12 patch without reactions: the same object
    expect(lobbyPatchOfWriter(13, c)).toBe(c)
    const plain = { 'tag:x': null }
    expect(lobbyPatchOfWriter(12, plain)).toBe(plain)
  })

  it('a create: reactions equal to its undelete source are kept (undo of a delete), every other one stripped', () => {
    const lobby = { [UP1]: true, [HEART2]: true, kind: 'note' }
    // a paste or duplicate (a new id): a copy without reactions, the keys named for the ack fix
    expect(lobbyCreateOfWriter(12, lobby, null)).toEqual({ lobby: { kind: 'note' }, stripped: [UP1, HEART2] })
    // an undelete of the tombstone that holds both: kept whole
    const undo = lobbyCreateOfWriter(12, lobby, { [UP1]: true, [HEART2]: true })
    expect(undo).toEqual({ lobby, stripped: [] })
    expect(undo.lobby).toBe(lobby)
    // an undelete whose source holds only one: the other is a forgery and goes
    expect(lobbyCreateOfWriter(12, lobby, { [UP1]: true })).toEqual({
      lobby: { [UP1]: true, kind: 'note' },
      stripped: [HEART2],
    })
    // a rev-13 writer, or no lobby: as they are
    expect(lobbyCreateOfWriter(13, lobby, null)).toEqual({ lobby, stripped: [] })
    expect(lobbyCreateOfWriter(12, undefined, null)).toEqual({ lobby: undefined, stripped: [] })
  })

  it('the stripped create is a valid element, and its ack fix parses for the deployed web', () => {
    const { lobby, stripped } = lobbyCreateOfWriter(12, { [UP1]: true }, null)
    const copy = withLobby(note, lobby ?? {}, 'copy-1')
    expect(Elements.checkElement(copy).ok).toBe(true)
    expect(OldElements.checkElement(copy as never).ok).toBe(true)
    const fix = Object.fromEntries(stripped.map((k) => [`c:${k}`, null]))
    expect(rev12Web({ type: 'ack', seq: 1, clock: 1, r: [{ id: 'copy-1', ok: true, v: 1, fix }] })).toBe(
      'ACCEPT',
    )
  })
})
