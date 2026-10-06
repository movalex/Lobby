// The negative security suite: CR-3D-5 (W5-29), an editor guest writes the board’s tag list and nothing
// else of the board document.
// A workshop (editor) guest creates, renames, recolours and deletes tags as an editor does (the tldraw
// board let it), within GUEST_TAG_DEF_CAP keys; `workshop` (the facilitator’s), `startView` and `import`
// stay READ_ONLY for every guest; a review (commenter) guest writes nothing; a note tagged with a refused
// definition answers the definition’s code (GUEST_LIMIT), never the abuse-counting INVALID.
// Raw frames against the REAL sync server process (DRAFTROOM_ENGINE=excalidraw), the protocol harness.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUEST_TAG_DEF_CAP, MAX_TAG_DEFS } from '@draftroom/canvas-schema/limits'
import { afterEach, describe, expect, it } from 'vitest'
import { MEMBER_TAG_DEF_RESERVE } from '../../src/room/merge.ts'
import {
  createElementStack,
  type ElementStack,
  newBoardId,
  sharedElementStack,
} from '../harness/element-stack.ts'
import { rect } from '../harness/elements.ts'
import { callInternal } from '../harness/tickets.ts'
import { storedLobby } from './support.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const shared = sharedElementStack()

type Ack = Awaited<ReturnType<Awaited<ReturnType<ElementStack['client']>>['push']>>
const codes = (ack: Ack) => ack.r.map((r) => (r.ok ? 'ok' : r.code))
const tagDef = (k: string) => ({ [`tagDef:${k}`]: { name: k, color: 'red' } })
const tagOn = (k: string) => ({ [`tag:${k}`]: { name: k, color: 'red' } })

describe('CR-3D-5: an editor guest writes the tag list, nothing else of the board document', () => {
  it('a workshop guest defines a tag and tags a note in one push; workshop, startView and import stay READ_ONLY', async () => {
    const st = shared.get()
    const b = newBoardId()
    const alice = await st.client({ boardId: b, user: 'alice', role: 'owner' })
    await alice.create([rect('r1'), rect('r2', { x: 200 })])
    const g = await st.client({ boardId: b, user: 'guest-wes', guest: true })
    const made = await g.push([g.patchOp('r1', { c: tagOn('from-the-room') })], {
      doc: { set: tagDef('from-the-room') },
    })
    expect(made.docDenied).toBeUndefined()
    expect(codes(made)).toEqual(['ok'])
    for (const [key, value] of [
      ['workshop', { hideNoteAuthors: true, hideCursors: true }],
      ['startView', { x: 0, y: 0, w: 100, h: 100 }],
      [
        'import',
        { from: 'tldraw-5.4.2', converterVersion: '1', at: 0, legacyPages: {}, legacyIds: {}, lossy: {} },
      ],
    ] as const) {
      const ack = await g.push([], { doc: { set: { [key]: value } } })
      expect(ack.docDenied, key).toEqual({ keys: [key], code: 'READ_ONLY' })
    }
    // a mixed push: the tag lands, the facilitator's key does not
    const mixed = await g.push([], {
      doc: { set: { ...tagDef('second'), workshop: { hideNoteAuthors: true, hideCursors: false } } },
    })
    expect(mixed.docDenied).toEqual({ keys: ['workshop'], code: 'READ_ONLY' })
    // what a fresh session is told the document holds
    const fresh = await st.client({ boardId: b, user: 'fresh' })
    const doc = (fresh.welcome?.doc ?? {}) as Record<string, unknown>
    expect(Object.keys(doc).sort()).toEqual(['tagDef:from-the-room', 'tagDef:second'])
    expect(Object.keys(await storedLobby(st, b, 'r1'))).toEqual(['tag:from-the-room'])
    // an editor account still writes the facilitator's key (canWriteDocKey), the owner the start view
    expect(
      (await alice.push([], { doc: { set: { startView: { x: 0, y: 0, w: 9, h: 9 } } } })).docDenied,
    ).toBeUndefined()
  })

  it('a review (commenter) guest writes nothing: its tag definition is READ_ONLY', async () => {
    const st = shared.get()
    const b = newBoardId()
    const alice = await st.client({ boardId: b, user: 'alice' })
    await alice.create([rect('r1')])
    const g = await st.client({ boardId: b, user: 'guest-ria', guest: true, role: 'commenter' })
    const ack = await g.push([g.patchOp('r1', { c: tagOn('nope') })], { doc: { set: tagDef('nope') } })
    expect(ack.docDenied).toEqual({ keys: ['tagDef:nope'], code: 'READ_ONLY' })
    expect(codes(ack)).toEqual(['READ_ONLY'])
    expect(await storedLobby(st, b, 'r1')).toEqual({})
  })

  it(`a guest writes at most ${GUEST_TAG_DEF_CAP} tag-list keys; its own keys stay writable; a note tagged with a refused definition is GUEST_LIMIT, not INVALID`, async () => {
    const st = shared.get()
    const b = newBoardId()
    const alice = await st.client({ boardId: b, user: 'alice' })
    await alice.create([rect('r1'), rect('r2', { x: 200 })])
    await alice.push([], { doc: { set: tagDef('staff') } })
    const g = await st.client({ boardId: b, user: 'guest-cap', guest: true })
    for (let i = 0; i < GUEST_TAG_DEF_CAP - 1; i++)
      expect((await g.push([], { doc: { set: tagDef(`g${i}`) } })).docDenied, `g${i}`).toBeUndefined()
    // a recolour of the staff tag spends the last key (a write of the list, as a creation is)
    expect(
      (await g.push([], { doc: { set: { 'tagDef:staff': { name: 'staff', color: 'blue' } } } })).docDenied,
    ).toBeUndefined()
    // the next new key is refused, and so is the tag it would carry onto a note (not abuse-counting INVALID)
    const over = await g.push([g.patchOp('r1', { c: tagOn('over') })], { doc: { set: tagDef('over') } })
    expect(over.docDenied).toEqual({ keys: ['tagDef:over'], code: 'GUEST_LIMIT' })
    expect(codes(over)).toEqual(['GUEST_LIMIT'])
    expect(g.isOpen).toBe(true)
    // keys it wrote stay its own: a rename-free recolour and a removal of its own tag land
    expect(
      (await g.push([], { doc: { set: { 'tagDef:g0': { name: 'g0', color: 'green' }, 'tagDef:g1': null } } }))
        .docDenied,
    ).toBeUndefined()
    // another guest uid has its own budget; an account has none
    const g2 = await st.client({ boardId: b, user: 'guest-cap-2', guest: true })
    expect((await g2.push([], { doc: { set: tagDef('other-guest') } })).docDenied).toBeUndefined()
    expect((await alice.push([], { doc: { set: tagDef('more-staff') } })).docDenied).toBeUndefined()
    const fresh = await st.client({ boardId: b, user: 'fresh' })
    const doc = (fresh.welcome?.doc ?? {}) as Record<string, { color: string }>
    expect(doc['tagDef:over']).toBeUndefined()
    expect(doc['tagDef:g1']).toBeUndefined()
    expect(doc['tagDef:g0']?.color).toBe('green')
    expect(doc['tagDef:staff']?.color).toBe('blue')
    expect(doc['tagDef:other-guest']).toBeDefined()
    expect(await storedLobby(st, b, 'r1')).toEqual({})
  })
})

// ---- TAGS-1 (wave J): the budget survives an eviction and a restart; members keep a reserve ------------------

describe('TAGS-1: a guest’s tag-list budget is kept in the board file, and members keep the list’s last places', () => {
  const dirs: string[] = []
  const stacks: ElementStack[] = []
  afterEach(async () => {
    await Promise.all(stacks.splice(0).map((s) => s.dispose()))
    for (const d of dirs.splice(0))
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const T = 120_000

  it(
    `a guest that wrote ${GUEST_TAG_DEF_CAP} keys is still at its cap after the room was evicted and after a restart; a key a member rewrote is free again`,
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dr-j6-tags-'))
      dirs.push(dataDir)
      let st = await createElementStack({ dataDir, env: { IDLE_EVICT_MS: '200' } })
      stacks.push(st)
      const b = newBoardId()
      const alice = await st.client({ boardId: b, user: 'alice' })
      const g = await st.client({ boardId: b, user: 'guest-keep', guest: true })
      for (let i = 0; i < GUEST_TAG_DEF_CAP; i++)
        expect((await g.push([], { doc: { set: tagDef(`k${i}`) } })).docDenied, `k${i}`).toBeUndefined()
      expect((await g.push([], { doc: { set: tagDef('over-1') } })).docDenied).toEqual({
        keys: ['tagDef:over-1'],
        code: 'GUEST_LIMIT',
      })
      // the room is evicted (nobody on the board), then opened again: before TAGS-1 the budget was fresh
      g.close()
      alice.close()
      await g.untilClosed()
      await alice.untilClosed()
      await sleep(700)
      const metrics = await (await callInternal(st.server.url, 'GET', '/internal/metrics')).text()
      expect(metrics).toMatch(/^lobby_rooms_open 0$/m)
      const g2 = await st.client({ boardId: b, user: 'guest-keep', guest: true })
      expect((await g2.push([], { doc: { set: tagDef('over-2') } })).docDenied).toEqual({
        keys: ['tagDef:over-2'],
        code: 'GUEST_LIMIT',
      })
      // its own keys stay writable
      expect(
        (await g2.push([], { doc: { set: { 'tagDef:k0': { name: 'k0', color: 'blue' } } } })).docDenied,
      ).toBeUndefined()
      // a process restart: the same
      await st.dispose()
      stacks.length = 0
      st = await createElementStack({ dataDir })
      stacks.push(st)
      const g3 = await st.client({ boardId: b, user: 'guest-keep', guest: true })
      expect((await g3.push([], { doc: { set: tagDef('over-3') } })).docDenied).toEqual({
        keys: ['tagDef:over-3'],
        code: 'GUEST_LIMIT',
      })
      // a member rewrites one of the guest's keys: it is no longer the guest's, so one new key fits again
      const a2 = await st.client({ boardId: b, user: 'alice' })
      expect(
        (await a2.push([], { doc: { set: { 'tagDef:k1': { name: 'k1', color: 'green' } } } })).docDenied,
      ).toBeUndefined()
      expect((await g3.push([], { doc: { set: tagDef('after-member') } })).docDenied).toBeUndefined()
      expect((await g3.push([], { doc: { set: tagDef('over-4') } })).docDenied?.code).toBe('GUEST_LIMIT')
      // another guest uid has its own budget
      const other = await st.client({ boardId: b, user: 'guest-other', guest: true })
      expect((await other.push([], { doc: { set: tagDef('other-1') } })).docDenied).toBeUndefined()
    },
    T,
  )

  it(
    `guests together fill the tag list to ${MAX_TAG_DEFS - MEMBER_TAG_DEF_RESERVE} of ${MAX_TAG_DEFS} at most; members add the rest`,
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dr-j6-reserve-'))
      dirs.push(dataDir)
      const st = await createElementStack({ dataDir })
      stacks.push(st)
      const b = newBoardId()
      const alice = await st.client({ boardId: b, user: 'alice' })
      const guestShare = MAX_TAG_DEFS - MEMBER_TAG_DEF_RESERVE
      expect(guestShare % GUEST_TAG_DEF_CAP).toBe(0)
      // fresh guest uids (one per incognito join), each spending its whole budget in one push
      for (let u = 0; u < guestShare / GUEST_TAG_DEF_CAP; u++) {
        const g = await st.client({ boardId: b, user: `guest-r${u}`, guest: true })
        const set: Record<string, unknown> = {}
        for (let i = 0; i < GUEST_TAG_DEF_CAP; i++) Object.assign(set, tagDef(`r${u}-${i}`))
        expect((await g.push([], { doc: { set } })).docDenied, `guest ${u}`).toBeUndefined()
        g.close()
      }
      // the next fresh guest is refused: the rest is the members'
      const late = await st.client({ boardId: b, user: 'guest-late', guest: true })
      expect((await late.push([], { doc: { set: tagDef('late') } })).docDenied).toEqual({
        keys: ['tagDef:late'],
        code: 'GUEST_LIMIT',
      })
      // a guest still renames or removes a key it wrote (no new place)
      const g0 = await st.client({ boardId: b, user: 'guest-r0', guest: true })
      expect((await g0.push([], { doc: { set: { 'tagDef:r0-0': null } } })).docDenied).toBeUndefined()
      // a member adds up to the list's cap, then is refused as before (INVALID)
      const set: Record<string, unknown> = {}
      for (let i = 0; i < MEMBER_TAG_DEF_RESERVE + 1; i++) Object.assign(set, tagDef(`m${i}`))
      expect((await alice.push([], { doc: { set } })).docDenied).toBeUndefined()
      expect((await alice.push([], { doc: { set: tagDef('m-over') } })).docDenied).toEqual({
        keys: ['tagDef:m-over'],
        code: 'INVALID',
      })
      const fresh = await st.client({ boardId: b, user: 'fresh' })
      const keys = Object.keys((fresh.welcome?.doc ?? {}) as Record<string, unknown>).filter((k) =>
        k.startsWith('tagDef:'),
      )
      expect(keys).toHaveLength(MAX_TAG_DEFS)
    },
    T,
  )
})
