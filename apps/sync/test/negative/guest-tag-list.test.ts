// The negative security suite: CR-3D-5 (W5-29), an editor guest writes the board’s tag list and nothing
// else of the board document.
// A workshop (editor) guest creates, renames, recolours and deletes tags as an editor does (the tldraw
// board let it), within GUEST_TAG_DEF_CAP keys; `workshop` (the facilitator’s), `startView` and `import`
// stay READ_ONLY for every guest; a review (commenter) guest writes nothing; a note tagged with a refused
// definition answers the definition’s code (GUEST_LIMIT), never the abuse-counting INVALID.
// Raw frames against the REAL sync server process (DRAFTROOM_ENGINE=excalidraw), the protocol harness.

import { GUEST_TAG_DEF_CAP } from '@draftroom/canvas-schema/limits'
import { describe, expect, it } from 'vitest'
import { type ElementStack, newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { rect } from '../harness/elements.ts'
import { storedLobby } from './support.ts'

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
