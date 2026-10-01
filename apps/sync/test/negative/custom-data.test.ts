// The negative security suite, part 2: the five customData classes of §3.3, one test per rule, plus the
// customData envelope (only `lobby` and `lobbyServer`; every `lobby` key in the registry; the budget).
// Raw frames against the real server process (DRAFTROOM_ENGINE=excalidraw).

import { describe, expect, it } from 'vitest'
import { fileRef } from '../harness/element-api.ts'
import { newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { assetId, frame, image, note, rect, text, versionId } from '../harness/elements.ts'
import { expectAccepted, expectNotStored, expectRefused, storedEl, storedLobby } from './support.ts'

const shared = sharedElementStack()

const forgedServer = {
  createdBy: { uid: 'mallory', name: 'Mallory', guest: false },
  createdAt: 1,
  lastEditedBy: { uid: 'mallory', name: 'Mallory', guest: false },
  lastEditedAt: 1,
  privateNote: { session: 'sess1', author: 'mallory' },
}

describe('§3.3 the customData envelope', () => {
  it('a top-level customData key other than lobby and lobbyServer is INVALID', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    expectRefused(await a.createOne(rect('r1', { customData: { evil: { x: 1 } } })), 'INVALID', a)
    await expectNotStored(st, b, ['r1'])
  })

  it('a lobby key the registry does not know is INVALID, in a create and in a patch', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    expectRefused(await a.createOne(rect('r1', { customData: { lobby: { secret: 'x' } } })), 'INVALID', a)
    await a.create([rect('r2')])
    expectRefused(await a.patch('r2', { c: { secret: 'x' } }), 'INVALID', a)
    await expectNotStored(st, b, ['r1'])
    expect(await storedLobby(st, b, 'r2')).toEqual({})
  })
})

describe('§3.3 class 1: server-owned customData.lobbyServer', () => {
  it('a lobbyServer in a create is replaced: createdBy from the ticket, never privateNote from a socket', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    expectAccepted(await a.createOne(text('t1', { customData: { lobbyServer: forgedServer } })))
    const ls = (await storedEl(st, b, 't1')).customData?.lobbyServer
    expect(ls?.createdBy).toEqual({ uid: 'alice', name: 'alice-name', guest: false })
    expect(ls?.lastEditedBy).toEqual({ uid: 'alice', name: 'alice-name', guest: false })
    expect(ls?.createdAt).toBeGreaterThan(1)
    expect(ls?.privateNote).toBeUndefined()
  })

  it('a patch cannot carry lobbyServer (the op is INVALID and nothing changes)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'mallory' })
    await a.create([rect('r1')])
    await m.untilClock(a.clock)
    expectRefused(
      await m.one({ ...m.patchOp('r1', { g: { pos: { x: 5, y: 5 } } }), lobbyServer: forgedServer }),
      'INVALID',
      m,
    )
    const s = await storedEl(st, b, 'r1')
    expect(s.customData?.lobbyServer?.createdBy?.uid).toBe('alice')
    expect(s.x).toBe(0)
  })

  it('text written by someone else stamps lastEditedBy from their ticket', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'bob' })
    await a.create([text('t1')])
    await m.untilClock(a.clock)
    expectAccepted(
      await m.patch('t1', {
        g: {
          text: { originalText: 'bob was here' },
          layout: { text: 'bob was here', width: 60, height: 25 },
        },
      }),
    )
    const ls = (await storedEl(st, b, 't1')).customData?.lobbyServer
    expect(ls?.createdBy?.uid).toBe('alice')
    expect(ls?.lastEditedBy?.uid).toBe('bob')
  })
})

describe('§3.3 class 2: create-only kind, ai, privateFrame', () => {
  it('kind is accepted in a create; a later change is INVALID', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    expectAccepted(await a.createOne(rect('r1', { customData: { lobby: { kind: 'highlight' } } })))
    expectRefused(await a.patch('r1', { c: { kind: 'other' } }), 'INVALID', a)
    await a.create([rect('r2')])
    expectRefused(await a.patch('r2', { c: { kind: 'highlight' } }), 'INVALID', a)
    expect(await storedLobby(st, b, 'r1')).toEqual({ kind: 'highlight' })
    expect(await storedLobby(st, b, 'r2')).toEqual({})
  })

  it('ai needs by = the writer; a later change is INVALID; only its user removes it', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'bob' })
    expectRefused(
      await a.createOne(note('forged', { customData: { lobby: { ai: { by: 'bob' } } } })),
      'INVALID',
      a,
    )
    // canvas-schema's registry requires `by` (the plan's "stamped when absent" is not the frozen schema)
    expectRefused(
      await a.createOne(note('no-by', { customData: { lobby: { ai: { run: 'r0' } } } })),
      'INVALID',
      a,
    )
    expectAccepted(
      await a.createOne(note('mine', { customData: { lobby: { ai: { by: 'alice', run: 'r1' } } } })),
    )
    expectRefused(await a.patch('mine', { c: { ai: { by: 'alice', run: 'r2' } } }), 'INVALID', a)
    await m.untilClock(a.clock)
    expectRefused(await m.patch('mine', { c: { ai: null } }), 'INVALID', m)
    expect((await storedLobby(st, b, 'mine')).ai).toMatchObject({ by: 'alice', run: 'r1' })
    expectAccepted(await a.patch('mine', { c: { ai: null } }))
    expect((await storedLobby(st, b, 'mine')).ai).toBeUndefined()
    await expectNotStored(st, b, ['forged', 'no-by'])
  })

  it('privateFrame added to an existing frame is INVALID; in a create it needs by = the writer', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([frame('f1')])
    expectRefused(await a.patch('f1', { c: { privateFrame: { session: 's1', by: 'alice' } } }), 'INVALID', a)
    expectRefused(
      await a.createOne(
        frame('f2', { customData: { lobby: { privateFrame: { session: 's1', by: 'bob' } } } }),
      ),
      'INVALID',
      a,
    )
    expectAccepted(
      await a.createOne(
        frame('f3', { customData: { lobby: { privateFrame: { session: 's1', by: 'alice' } } } }),
      ),
    )
    await expectNotStored(st, b, ['f2'])
    expect(await storedLobby(st, b, 'f1')).toEqual({})
  })
})

describe('§3.3 class 3: identity-bound plusOne:<uid>', () => {
  it('a +1 for another uid (added or removed) is INVALID; the writer’s own is kept', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'bob' })
    await a.create([note('n1')])
    await m.untilClock(a.clock)
    expectRefused(await a.patch('n1', { c: { 'plusOne:bob': true } }), 'INVALID', a)
    expectAccepted(await m.patch('n1', { c: { 'plusOne:bob': true } }))
    await a.untilClock(m.clock)
    expectRefused(await a.patch('n1', { c: { 'plusOne:bob': null } }), 'INVALID', a)
    expectRefused(
      await a.createOne(note('n2', { customData: { lobby: { 'plusOne:bob': true } } })),
      'INVALID',
      a,
    )
    expect(await storedLobby(st, b, 'n1')).toEqual({ 'plusOne:bob': true })
    await expectNotStored(st, b, ['n2'])
  })

  it('a +1 while a dot vote is open is VOTE_OPEN; after the vote closes it is accepted', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([note('n1')])
    await st.setWorkshop(b, { voteOpen: true, anonymous: false })
    await a.until(() => a.of('workshop').some((w) => w.voteOpen), 'the vote-open broadcast')
    expectRefused(await a.patch('n1', { c: { 'plusOne:alice': true } }), 'VOTE_OPEN', a)
    expect(await storedLobby(st, b, 'n1')).toEqual({})
    await st.setWorkshop(b, { voteOpen: false, anonymous: false })
    await a.until(() => a.of('workshop').at(-1)?.voteOpen === false, 'the vote-closed broadcast')
    expectAccepted(await a.patch('n1', { c: { 'plusOne:alice': true } }))
  })
})

describe('§3.3 class 4: api-validated file and pdfPage', () => {
  it('file facts are canonicalized from the api (only name is the client’s); pdfPage comes from the fileId', async () => {
    const st = shared.get()
    const b = newBoardId()
    st.api.addFile(
      fileRef(versionId(70), assetId(70), {
        kind: 'pdf',
        name: 'real.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 999,
        pageCount: 3,
      }),
    )
    const a = await st.client({ boardId: b, user: 'alice' })
    const forged = {
      assetId: assetId(71),
      versionId: versionId(70),
      kind: 'image',
      name: 'mine.pdf',
      mimeType: 'text/html',
      sizeBytes: 1,
    }
    expectAccepted(
      await a.createOne(
        image('p1', `${versionId(70)}.p2`, { customData: { lobby: { file: forged, pdfPage: 3 } } }),
      ),
    )
    expect(await storedLobby(st, b, 'p1')).toEqual({
      file: {
        assetId: assetId(70),
        versionId: versionId(70),
        kind: 'pdf',
        name: 'mine.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 999,
      },
      pdfPage: 2,
    })
  })

  it('a file whose versionId is not the fileId’s version, a page beyond pageCount, or a name over 200 characters: INVALID', async () => {
    const st = shared.get()
    const b = newBoardId()
    st.api.addFile(
      fileRef(versionId(80), assetId(80), { kind: 'pdf', mimeType: 'application/pdf', pageCount: 3 }),
    )
    st.api.addFile(fileRef(versionId(81), assetId(81)))
    const a = await st.client({ boardId: b, user: 'alice' })
    const file = (v: string, name = 'a.pdf') => ({
      assetId: assetId(80),
      versionId: v,
      kind: 'pdf',
      name,
      mimeType: 'application/pdf',
      sizeBytes: 1,
    })
    expectRefused(
      await a.createOne(image('x1', versionId(80), { customData: { lobby: { file: file(versionId(81)) } } })),
      'INVALID',
      a,
    )
    expectRefused(await a.createOne(image('x2', `${versionId(80)}.p9`)), 'INVALID', a)
    expectRefused(
      await a.createOne(
        image('x3', versionId(80), { customData: { lobby: { file: file(versionId(80), 'n'.repeat(201)) } } }),
      ),
      'INVALID',
      a,
    )
    await expectNotStored(st, b, ['x1', 'x2', 'x3'])
  })
})

describe('§3.3 class 5: free keys, schema-validated', () => {
  it('a tag needs its tagDef in the doc (the same push may define it); more than 10 tags is INVALID', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    const tag = (k: string) => ({ [`tag:${k}`]: { name: k, color: 'red' } })
    expectRefused(await a.patch('r1', { c: tag('x') }), 'INVALID', a)
    expectAccepted(
      await a.one(a.patchOp('r1', { c: tag('x') }), {
        doc: { set: { 'tagDef:x': { name: 'x', color: 'red' } } },
      }),
    )
    const defs = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`tagDef:k${i}`, { name: `k${i}`, color: 'red' }]),
    )
    const eleven = Object.assign({}, ...Array.from({ length: 11 }, (_, i) => tag(`k${i}`)))
    await a.create([rect('r2')])
    expectRefused(await a.one(a.patchOp('r2', { c: eleven }), { doc: { set: defs } }), 'INVALID', a)
    expect(Object.keys(await storedLobby(st, b, 'r1'))).toEqual(['tag:x'])
    expect(await storedLobby(st, b, 'r2')).toEqual({})
  })

  it('values outside their schema are INVALID: alt over 500 characters, a bad mindmap, present, marker', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1')])
    for (const c of [
      { alt: 'x'.repeat(501) },
      { mindmap: { rootId: 'r1', parentId: null, side: 'up', collapsed: false } },
      { mindmapEdge: { rootId: 'r1', parentId: 'r1' } },
      { present: { index: -1 } },
      { present: { index: 1, extra: true } },
      { prompt: 'p'.repeat(65) },
      { swatch: 42 },
    ])
      expectRefused(await a.patch('r1', { c }), 'INVALID', a)
    expectAccepted(
      await a.patch('r1', { c: { alt: 'A red square', present: { index: 2 }, prompt: 'image' } }),
    )
    expect(await storedLobby(st, b, 'r1')).toEqual({
      alt: 'A red square',
      present: { index: 2 },
      prompt: 'image',
    })
  })
})
