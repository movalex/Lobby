// Wave 4b, owner 2A (the sync room and the contracts), against the REAL sync server process
// (DRAFTROOM_ENGINE=excalidraw). Each case failed on 747d41d (the wave-4a integration) and passes with the
// fix it names:
//   DEF-3F-1      a join while the reset snapshot is cached after a board-document write: the `changes` frame after the cached reset
//                 snapshot carries the doc keys written since (and the welcome their clocks, rev 9)
//   V1 low        doc-key clocks in the welcome and the snapshot (CONTRACTS_REV 9, the client's ABA rule)
//   V2 low P-X1   a tombstone takes no patch but its undelete: a re-delete is a no-op, the rest is GONE
//   V2 low P-G4   a guest's label detached into a free text counts against its CREATOR, whoever detaches
//   SMK-2         a `notice` CLOSING names the reason before every terminal close (ticket, maintenance, a
//                 malformed message)
import { decodeSnapshotFrame } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { callInternal } from '../harness/tickets.ts'
import { type ClientOptions, RawClient } from './support/client.ts'
import { type El, label, note, text, withLabel } from './support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const T = 120_000
type R = { ok: boolean; code?: string; el?: El | null }
const codes = (ack: { r: unknown[] }) => (ack.r as R[]).map((r) => (r.ok ? 'ok' : (r.code ?? '?')))
const patch = (c: RawClient, id: string, rest: El) => ({
  k: 'p',
  id,
  pv: c.confirmed.get(id)?.version ?? 1,
  ...rest,
})
async function stored(st: ElementStack, b: string): Promise<Map<string, El>> {
  const s = await st.snapshot(b)
  return new Map(s.elements.map((e) => [(e as El).id as string, e as El]))
}
const lastEditedBy = (e: El | undefined) =>
  (e?.customData?.lobbyServer as { lastEditedBy?: { uid: string } | null } | undefined)?.lastEditedBy?.uid ??
  null

/** A raw client that keeps every frame it received, in order (binary snapshot frames decoded). */
async function spy(st: ElementStack, opts: Omit<ClientOptions, 'wsUrl' | 'hello'>) {
  const c = new RawClient({ wsUrl: st.server.wsUrl, ...opts, hello: false } as ClientOptions)
  const frames: unknown[] = []
  const pending: Promise<unknown>[] = []
  c.ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary)
      pending.push(
        decodeSnapshotFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).then(
          (f) => frames.push(f),
          (e) => frames.push({ type: 'snapshot-decode-error', error: String(e) }),
        ),
      )
    else frames.push(JSON.parse(data.toString('utf8')))
  })
  await c.opened
  await c.hello(0, null)
  await Promise.allSettled(pending)
  return { c, frames: frames as { type: string; [k: string]: unknown }[] }
}

const TAG = 'tagDef:idea'
const TAG_VALUE = { name: 'Idea', color: 'yellow' }

describe('DEF-3F-1 and the doc-key clocks (CONTRACTS_REV 9)', () => {
  it(
    'a join within 5 s of a doc write: the welcome carries the key and its clock, the changes frame after the cached snapshot carries the key',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const alice = await st.client({ boardId: b, user: 'alice', role: 'owner' })
      await alice.create([note('n1', { x: 10 })])
      // carol's reset join caches the snapshot (with the document as it is now: no tag)
      const carol = await st.client({ boardId: b, user: 'carol', role: 'viewer' })
      expect(carol.welcome?.doc[TAG]).toBeUndefined()
      const ack = await alice.push([], { doc: { set: { [TAG]: TAG_VALUE } } })
      const writtenAt = ack.clock
      // bob joins within the cache's 5 s
      const bob = await spy(st, { boardId: b, user: 'bob', role: 'editor' })
      const welcome = bob.frames.find((f) => f.type === 'welcome') as
        | { reset: boolean; clock: number; doc: Record<string, unknown>; docClocks?: Record<string, number> }
        | undefined
      const snapshot = bob.frames.find((f) => f.type === 'snapshot') as
        | { clock: number; doc: Record<string, unknown>; docClocks?: Record<string, number> }
        | undefined
      const changes = bob.frames.find((f) => f.type === 'changes') as
        | { clock: number; doc?: { set: Record<string, unknown> } }
        | undefined
      expect(welcome?.reset).toBe(true)
      expect(welcome?.doc[TAG]).toEqual(TAG_VALUE)
      expect(welcome?.docClocks?.[TAG]).toBe(writtenAt)
      // the snapshot is carol's cached one: older than the write, without the tag, with the clocks it had
      expect(snapshot?.clock).toBeLessThan(writtenAt)
      expect(snapshot?.doc[TAG]).toBeUndefined()
      expect(snapshot?.docClocks).toEqual({})
      // DEF-3F-1: the changes frame that follows brings the key written since the cache
      expect(changes?.clock).toBe(writtenAt)
      expect(changes?.doc?.set[TAG]).toEqual(TAG_VALUE)
      expect(bob.c.schemaErrors).toEqual([])

      // a key removed within the cache's 5 s: null in the frame, and its clock still listed
      const removed = await alice.push([], { doc: { set: { [TAG]: null } } })
      const dave = await spy(st, { boardId: b, user: 'dave', role: 'editor' })
      const w2 = dave.frames.find((f) => f.type === 'welcome') as
        | { doc: Record<string, unknown>; docClocks?: Record<string, number> }
        | undefined
      const ch2 = dave.frames.find((f) => f.type === 'changes') as
        | { doc?: { set: Record<string, unknown> } }
        | undefined
      expect(w2?.doc[TAG]).toBeUndefined()
      expect(w2?.docClocks?.[TAG]).toBe(removed.clock)
      expect(ch2?.doc?.set).toEqual({ [TAG]: null })
      expect(ch2?.doc?.set[TAG]).toBeNull()
      expect(dave.c.schemaErrors).toEqual([])

      // a fresh snapshot carries the clocks too. The cache no longer ages out in 5 s (element-room.ts
      // SNAPSHOT_REUSE: reused while the board is within 500 rows and 60 s of its clock, the performance round
      // after B9); a delete still drops it at once (W5-02), so one makes the next joiner's snapshot fresh
      const n1 = alice.confirmed.get('n1')
      await alice.push([{ k: 'p', id: 'n1', pv: n1?.version, g: { life: { isDeleted: true } } }])
      const erin = await spy(st, { boardId: b, user: 'erin', role: 'viewer' })
      const snap3 = erin.frames.find((f) => f.type === 'snapshot') as
        | { docClocks?: Record<string, number> }
        | undefined
      expect(snap3?.docClocks?.[TAG]).toBe(removed.clock)
      expect(erin.frames.some((f) => f.type === 'changes')).toBe(false)
    },
    T,
  )
})

describe('a tombstone takes no patch but its undelete (V2 re-check P-X1, P-X1b)', () => {
  it(
    'a text patch or a detach of a deleted element is GONE with the redacted tombstone; a re-delete is a no-op; the undelete still works',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const alice = await st.client({ boardId: b, user: 'alice', role: 'owner' })
      const n1 = withLabel(
        note('n1'),
        label('l1', 'n1', { text: 'staff words', originalText: 'staff words' }),
      )
      await alice.create([
        text('t1', { text: 'staff text', originalText: 'staff text' }),
        n1,
        label('l1', 'n1'),
      ])
      const gina = await st.client({ boardId: b, user: 'gina', guest: true })
      const bob = await st.client({ boardId: b, user: 'bob', role: 'editor' })
      // alice deletes the free text and the note (its label cascades)
      await alice.push([
        patch(alice, 't1', { g: { life: { isDeleted: true } } }),
        patch(alice, 'n1', { g: { life: { isDeleted: true } } }),
      ])
      await gina.untilClock(alice.clock)
      await bob.untilClock(alice.clock)
      const before = await stored(st, b)
      expect(before.get('t1')?.isDeleted).toBe(true)
      expect(before.get('l1')?.isDeleted).toBe(true)

      // a guest's text patch on the deleted text, and its detach of the deleted label: GONE, nothing stored
      const g1 = await gina.push([
        patch(gina, 't1', { g: { text: { originalText: 'FORGED' } } }),
        patch(gina, 'l1', { g: { bind: { containerId: null } } }),
      ])
      expect(codes(g1)).toEqual(['GONE', 'GONE'])
      for (const r of g1.r as R[]) {
        expect(r.el?.isDeleted).toBe(true)
        expect(r.el?.text ?? '').toBe('') // redacted (W5-02)
      }
      // an account editor's content patch on a tombstone: GONE too
      const b1 = await bob.push([patch(bob, 't1', { g: { pos: { x: 500 } } })])
      expect(codes(b1)).toEqual(['GONE'])
      const after = await stored(st, b)
      expect(after.get('t1')?.originalText).toBe('staff text')
      expect(after.get('l1')?.containerId).toBe('n1')
      expect(lastEditedBy(after.get('t1'))).toBe(lastEditedBy(before.get('t1')))
      expect(after.get('t1')?.version).toBe(before.get('t1')?.version)

      // a re-delete (two people deleting the same thing) is acked ok and writes nothing
      const redo = await gina.push([patch(gina, 't1', { g: { life: { isDeleted: true } } })])
      expect(codes(redo)).toEqual(['ok'])
      const after2 = await stored(st, b)
      expect(after2.get('t1')).toEqual(after.get('t1'))

      // the undelete by patch still works for its author
      const back = await alice.push([patch(alice, 't1', { g: { life: { isDeleted: false } } })])
      expect(codes(back)).toEqual(['ok'])
      expect((await stored(st, b)).get('t1')?.isDeleted).toBe(false)
    },
    T,
  )
})

describe("a guest's detached label counts against its creator (V2 re-check P-G4)", () => {
  it(
    'a second guest cannot detach a capped guest’s labels; an account editor can, and the creator is then over the cap',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const alice = await st.client({ boardId: b, user: 'alice', role: 'owner' })
      await alice.create([note('seed')])
      const ga = await st.client({ boardId: b, user: 'guest-a', guest: true })
      const gb = await st.client({ boardId: b, user: 'guest-b', guest: true })
      // guest A at exactly its cap: 499 plain notes and one labelled note (500 items; the label is none)
      const notes: El[] = []
      for (let i = 0; i < 499; i++) notes.push(note(`a${i}`, { x: i * 10 }))
      const nl = withLabel(note('an', { x: 6000 }), label('al', 'an', { text: 'mine', originalText: 'mine' }))
      const first = await ga.create([...notes, nl])
      expect(new Set(codes(first))).toEqual(new Set(['ok']))
      const lab = await ga.create([label('al', 'an', { text: 'mine', originalText: 'mine' })])
      expect(codes(lab)).toEqual(['ok'])
      expect(codes(await ga.create([note('one-more')]))).toEqual(['GUEST_LIMIT'])
      await gb.untilClock(ga.clock)
      await alice.untilClock(ga.clock)

      // guest B detaching A's label: one more item of A's, and A is at its cap
      const detachB = await gb.push([patch(gb, 'al', { g: { bind: { containerId: null } } })])
      expect(codes(detachB)).toEqual(['GUEST_LIMIT'])
      expect((await stored(st, b)).get('al')?.containerId).toBe('an')

      // the owner may: the item is A's (its creator's), so A stands above the cap and creates nothing
      const detachOwner = await alice.push([patch(alice, 'al', { g: { bind: { containerId: null } } })])
      expect(codes(detachOwner)).toEqual(['ok'])
      await ga.untilClock(alice.clock)
      expect((await stored(st, b)).get('al')?.containerId).toBeNull()
      expect(codes(await ga.create([note('another')]))).toEqual(['GUEST_LIMIT'])
      // B's own count is untouched by the detach
      expect(codes(await gb.create([note('b-own')]))).toEqual(['ok'])
    },
    T,
  )
})

describe('the CLOSING notice before every terminal close (SMK-2, CONTRACTS_REV 9)', () => {
  const closingNotices = (c: RawClient) =>
    c.rawFrames
      .map((f) => JSON.parse(f) as { type: string; code?: string; detail?: string })
      .filter((f) => f.type === 'notice' && f.code === 'CLOSING')
      .map((f) => f.detail)

  it(
    'a refused ticket, a malformed message and the maintenance switch each announce their reason in band first',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      // a refused ticket (app.ts, before any room)
      const bad = await st.socket({ boardId: b, user: 'mallory', ticket: 'garbage' })
      expect(await bad.untilClosed()).toEqual({ code: 4099, reason: 'NOT_AUTHENTICATED' })
      expect(closingNotices(bad)).toEqual(['NOT_AUTHENTICATED'])
      // a malformed message (the room's terminal())
      const alice = await st.client({ boardId: b, user: 'alice', role: 'owner' })
      alice.send('not json')
      expect(await alice.untilClosed()).toEqual({ code: 4099, reason: 'INVALID_MESSAGE' })
      expect(closingNotices(alice)).toEqual(['INVALID_MESSAGE'])
      // the maintenance switch closes a welcomed session, and refuses a new socket, announced both times
      const bob = await st.client({ boardId: b, user: 'bob', role: 'editor' })
      const on = await callInternal(st.server.url, 'POST', '/internal/maintenance', { body: { on: true } })
      expect(on.status).toBe(200)
      expect(await bob.untilClosed()).toEqual({ code: 4099, reason: 'MAINTENANCE' })
      expect(closingNotices(bob)).toEqual(['MAINTENANCE'])
      const late = await st.socket({ boardId: b, user: 'carol', role: 'editor' })
      expect(await late.untilClosed()).toEqual({ code: 4099, reason: 'MAINTENANCE' })
      expect(closingNotices(late)).toEqual(['MAINTENANCE'])
      // the notice always precedes the close frame: it is the last text frame each socket received
      for (const c of [bad, alice, bob, late]) {
        const last = JSON.parse(c.rawFrames.at(-1) ?? '{}') as { code?: string }
        expect(last.code).toBe('CLOSING')
        expect(c.schemaErrors).toEqual([])
      }
      // a 4000 RECONNECT carries no notice (a maintenance off, then a room-level reconnect is not terminal)
      expect(
        (await callInternal(st.server.url, 'POST', '/internal/maintenance', { body: { on: false } })).status,
      ).toBe(200)
    },
    T,
  )
})
