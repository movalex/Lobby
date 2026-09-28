// A note's "last edited by" is bound to the session that wrote the text (reviewer finding SEAM-01).
//
// tldraw 5.4.2 stores it as `props.textLastEditedBy` on note shapes (a plain user id, the ticket's
// uid in Lobby) and renders `Editor.getAttributionDisplayName(id)` on the note. The client stamps it
// (NoteShapeUtil.onBeforeUpdate on a text change, onBeforeDuplicate on duplicate and paste), so
// without the sync server's rule any editor, a name-only guest on a workshop link included, could
// put someone else's name under words they never wrote, or on a revealed private note.
//
// What each honest path puts on the wire is taken from the tldraw 5.4.2 sources (cited per test) and
// from Lobby's per-property undo (apps/web/src/sync-quality/perPropUndo.ts), which replays undo and
// redo as field-level patches of exactly the fields the history entry changed.

import type { TicketRole } from '@draftroom/auth-tickets'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { type TLRecord, toRichText } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { noteShape, PAGE_ID, plainText, type ShapeRecord } from '../harness/records.ts'
import type { SyncServer } from '../harness/server-process.ts'
import type { NetworkDiff, NodeSyncClient } from '../harness/sync-client.ts'
import { callInternal, mintTicket } from '../harness/tickets.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()
// The text lease (lease.ts) would veto a second writer's text edit for 5 s; it is not under test here.
const startServer = () => h.server({ env: { TEXT_LEASE_MS: '1' } })

// Ids the private-notes endpoint accepts as authors (usr_ + 10..40 alphanumerics).
const ALICE = 'usr_aliceAAAAAAAAAAAAAA' // a DBC member, editor
const VIC = 'usr_vicVVVVVVVVVVVVVVVV' // a name-only guest on a workshop (editor) link
const CAROL = 'usr_carolCCCCCCCCCCCCCC' // a member who is not in the room
const BOB = 'usr_bobBBBBBBBBBBBBBBBB' // a viewer watching
const NAMES: Record<string, string> = {
  [ALICE]: 'Alice Adams',
  [VIC]: 'Vic (guest)',
  [CAROL]: 'Carol Chen',
  [BOB]: 'Bob Brown',
}

const join = (server: SyncServer, boardId: string, user: string, role: TicketRole = 'editor') =>
  h.connected(server, {
    boardId,
    user,
    role,
    name: NAMES[user],
    ticket: () => mintTicket(boardId, user, role, { name: NAMES[user] ?? user }),
  })

/** A note with text, attributed as tldraw stamps it. */
const note = (id: string, text: string, by: string | null, over: { x?: number } = {}): ShapeRecord => {
  const n = noteShape(id, text, over)
  return { ...n, props: { ...n.props, textLastEditedBy: by } }
}
/** `shape` with new text and attribution: what NoteShapeUtil.onBeforeUpdate produces for a text edit. */
const edited = (shape: ShapeRecord, text: string, by: string | null): ShapeRecord => ({
  ...shape,
  props: { ...shape.props, richText: toRichText(text), textLastEditedBy: by },
})
const by = (s: ShapeRecord | undefined) => s?.props.textLastEditedBy
const textOf = (s: ShapeRecord | undefined) => plainText(s?.props.richText)

/** Every record in the board's storage right now (what a restart or a new tab would load). */
async function stored(server: SyncServer, boardId: string): Promise<Map<string, TLRecord>> {
  const res = await callInternal(server.url, 'GET', `/internal/boards/${boardId}/snapshot`)
  expect(res.status).toBe(200)
  const snap = (await res.json()) as { documents: { state: TLRecord }[] }
  return new Map(snap.documents.map((d) => [d.state.id as string, d.state]))
}
const storedShape = async (server: SyncServer, boardId: string, id: string) =>
  (await stored(server, boardId)).get(id) as unknown as ShapeRecord | undefined

/** The push result of the push TLSyncClient sent last (each store change is one push in tests). */
async function lastResult(c: NodeSyncClient) {
  const clock = c.lastPushClock()
  await c.waitForAcked()
  return (await waitFor(() => c.pushResults.find((r) => r.clientClock === clock && !r.raw))).action
}
async function rawResult(c: NodeSyncClient, clock: number) {
  return (await waitFor(() => c.pushResults.find((r) => r.clientClock === clock))).action
}

function expectUndisturbed(...clients: NodeSyncClient[]) {
  for (const c of clients) {
    expect(c.closes, c.name).toEqual([])
    expect(c.status, c.name).toBe('online')
  }
}

/**
 * Nothing re-sends on its own after the server refused or rewrote a write: the writer's pushes stop
 * (no ~14/s loop like tldraw's user-record re-put) and it stays connected.
 */
async function expectSettled(c: NodeSyncClient) {
  await c.waitForAcked()
  const pushes = c.sentPushes().length
  const closes = c.closes.length // a test that restarted the server has one close per restart
  await sleep(700)
  expect(c.sentPushes().length, `${c.name} kept pushing`).toBe(pushes)
  expect(c.closes.length, `${c.name} was closed`).toBe(closes)
  expect(c.status, c.name).toBe('online')
}

/** alice's note "Keep the Q3 launch" on a board with alice, vic (guest editor) and bob (viewer). */
async function board() {
  const server = await startServer()
  const boardId = newBoardId()
  const alice = await join(server, boardId, ALICE)
  alice.put(note('a1', 'Keep the Q3 launch', ALICE))
  expect(await lastResult(alice)).toBe('commit')
  const vic = await join(server, boardId, VIC)
  const bob = await join(server, boardId, BOB, 'viewer')
  await waitFor(() => vic.get('shape:a1') && bob.get('shape:a1'))
  return { server, boardId, alice, vic, bob }
}

/** alice's note is exactly hers in every tab and in storage. */
async function expectAlicesNote(server: SyncServer, boardId: string, ...tabs: NodeSyncClient[]) {
  await sleep(200) // anything forged would have been broadcast by now
  for (const c of tabs) {
    expect(textOf(c.get('shape:a1')), c.name).toBe('Keep the Q3 launch')
    expect(by(c.get('shape:a1')), c.name).toBe(ALICE)
  }
  const s = await storedShape(server, boardId, 'shape:a1')
  expect(textOf(s)).toBe('Keep the Q3 launch')
  expect(by(s)).toBe(ALICE)
}

describe("a note's attribution is bound to the session that wrote its text", () => {
  describe('forged updates are skipped: the writer self-corrects and stays connected', () => {
    const forgeries: { name: string; send: (vic: NodeSyncClient) => number | undefined }[] = [
      {
        name: "new text under alice's name (a hand-crafted richText-only patch)",
        send: (vic) =>
          vic.sendRawPush({
            'shape:a1': [
              'patch',
              { props: ['patch', { richText: ['put', toRichText('Cancel the Q3 launch')] }] },
            ],
          }),
      },
      {
        name: "new text stamped with alice's id (TLSyncClient update)",
        send: (vic) => {
          vic.update('shape:a1', (s) => edited(s, 'Cancel the Q3 launch', ALICE))
          return undefined
        },
      },
      {
        name: "alice's note relabelled as carol's, text unchanged",
        send: (vic) =>
          vic.sendRawPush({
            'shape:a1': ['patch', { props: ['patch', { textLastEditedBy: ['put', CAROL] }] }],
          }),
      },
      {
        name: "alice's note claimed by the guest without changing its text",
        send: (vic) => {
          vic.update('shape:a1', (s) => ({ ...s, props: { ...s.props, textLastEditedBy: VIC } }))
          return undefined
        },
      },
      {
        name: "alice's name stripped from her note, text unchanged",
        send: (vic) =>
          vic.sendRawPush({
            'shape:a1': ['patch', { props: ['patch', { textLastEditedBy: ['put', null] }] }],
          }),
      },
      {
        name: 'a move smuggling a relabel in the same op (the whole op is skipped)',
        send: (vic) =>
          vic.sendRawPush({
            'shape:a1': [
              'patch',
              { x: ['put', 500], props: ['patch', { textLastEditedBy: ['put', CAROL] }] },
            ],
          }),
      },
    ]

    for (const f of forgeries)
      it(f.name, async () => {
        const { server, boardId, alice, vic, bob } = await board()
        const clock = f.send(vic)
        const action = clock === undefined ? await lastResult(vic) : await rawResult(vic, clock)
        expect(action).toBe('discard')
        await expectAlicesNote(server, boardId, alice, bob, vic)
        expect(vic.get('shape:a1')?.x).toBe(0)
        await expectSettled(vic)
        expectUndisturbed(alice, bob)
      })

    it("alice's own earlier words (she replaced them herself) cannot be put back under her name by the guest", async () => {
      const { server, boardId, alice, vic, bob } = await board()
      alice.update('shape:a1', (s) => edited(s, 'Cancel the Q3 launch', ALICE))
      expect(await lastResult(alice)).toBe('commit')
      await waitFor(() => textOf(vic.get('shape:a1')) === 'Cancel the Q3 launch')
      // only alice's own undo may bring her replaced version back with her name
      vic.update('shape:a1', (s) => edited(s, 'Keep the Q3 launch', ALICE))
      expect(await lastResult(vic)).toBe('discard')
      await sleep(200)
      expect(textOf(bob.get('shape:a1'))).toBe('Cancel the Q3 launch')
      alice.update('shape:a1', (s) => edited(s, 'Keep the Q3 launch', ALICE))
      expect(await lastResult(alice)).toBe('commit')
      await expectAlicesNote(server, boardId, alice, bob, vic)
      await expectSettled(vic)
    })
  })

  describe('forged creates are stored anonymous (rewritten, never dropped)', () => {
    it("a new note carrying alice's name: stored with no attribution, the writer's tab takes it, nobody sees her name", async () => {
      const { server, boardId, alice, vic, bob } = await board()
      vic.put(note('forged', 'Alice: cancel the Q3 launch', ALICE))
      const action = await lastResult(vic)
      expect(action).not.toBe('commit')
      expect(action).not.toBe('discard') // the note itself is kept
      await waitFor(() => bob.get('shape:forged'))
      for (const c of [alice, bob, vic]) {
        await waitFor(() => c.get('shape:forged') && by(c.get('shape:forged')) === null)
        expect(textOf(c.get('shape:forged')), c.name).toBe('Alice: cancel the Q3 launch')
      }
      expect(by(await storedShape(server, boardId, 'shape:forged'))).toBeNull()
      await expectSettled(vic)
      expectUndisturbed(alice, bob)
    })

    it("re-creating alice's deleted note under its id with other words keeps nothing of her name", async () => {
      const { server, boardId, alice, vic, bob } = await board()
      alice.remove('shape:a1')
      await alice.waitForAcked()
      await waitFor(() => vic.get('shape:a1') === undefined)
      vic.put(note('a1', 'Cancel the Q3 launch', ALICE))
      await vic.waitForAcked()
      await waitFor(() => bob.get('shape:a1'))
      expect(by(bob.get('shape:a1'))).toBeNull()
      expect(by(await storedShape(server, boardId, 'shape:a1'))).toBeNull()
      await waitFor(() => by(vic.get('shape:a1')) === null)
      await expectSettled(vic)
      expectUndisturbed(alice, bob)
    })

    it('a note alice deleted cannot be re-created under her name by the guest, even word for word', async () => {
      const { server, boardId, alice, vic, bob } = await board()
      const hers = vic.get('shape:a1') as ShapeRecord
      alice.remove('shape:a1')
      await alice.waitForAcked()
      await waitFor(() => vic.get('shape:a1') === undefined)
      vic.put(hers) // "Recently deleted" (a server write) is how someone else's delete is undone
      await vic.waitForAcked()
      await waitFor(() => bob.get('shape:a1'))
      expect(textOf(bob.get('shape:a1'))).toBe('Keep the Q3 launch')
      expect(by(bob.get('shape:a1'))).toBeNull()
      expect(by(await storedShape(server, boardId, 'shape:a1'))).toBeNull()
      await expectSettled(vic)
    })

    it('a pasted empty note that still names someone (tldraw re-stamps only notes with text) lands, anonymous', async () => {
      // NoteShapeUtil.onBeforeDuplicate returns early for an empty note, so its textLastEditedBy is
      // carried over as it was in the clipboard.
      const { server, boardId, vic, bob } = await board()
      vic.put(note('pasted-empty', '', CAROL, { x: 400 }))
      await vic.waitForAcked()
      await waitFor(() => bob.get('shape:pasted-empty'))
      expect(by(bob.get('shape:pasted-empty'))).toBeNull()
      expect(by(await storedShape(server, boardId, 'shape:pasted-empty'))).toBeNull()
      await expectSettled(vic)
    })
  })

  describe('honest edits, paste, duplicate, undo and redo still work', () => {
    it('typing: the author edits her own note, and the guest edits it under his own name', async () => {
      const { server, boardId, alice, vic, bob } = await board()
      alice.update('shape:a1', (s) => edited(s, 'Keep the Q3 launch!', ALICE))
      expect(await lastResult(alice)).toBe('commit')
      // what tldraw sends while alice's own attribution is unchanged: a richText-only patch
      const clock = alice.sendRawPush({
        'shape:a1': [
          'patch',
          { props: ['patch', { richText: ['put', toRichText('Keep the Q3 launch!!')] }] },
        ],
      })
      expect(await rawResult(alice, clock)).toBe('commit')
      await waitFor(() => textOf(vic.get('shape:a1')) === 'Keep the Q3 launch!!')

      vic.update('shape:a1', (s) => edited(s, 'Keep the Q3 launch, but later', VIC))
      expect(await lastResult(vic)).toBe('commit')
      await waitFor(() => by(bob.get('shape:a1')) === VIC)
      expect(by(await storedShape(server, boardId, 'shape:a1'))).toBe(VIC)
      expectUndisturbed(alice, vic, bob)
    })

    it('clearing a note removes its attribution (onBeforeUpdate stamps null on empty text)', async () => {
      const { server, boardId, vic, bob } = await board()
      vic.update('shape:a1', (s) => edited(s, '', null))
      expect(await lastResult(vic)).toBe('commit')
      await waitFor(() => by(bob.get('shape:a1')) === null)
      expect(by(await storedShape(server, boardId, 'shape:a1'))).toBeNull()
    })

    it('moving, recolouring and resizing someone else’s note never touches its attribution', async () => {
      const { server, boardId, vic, bob } = await board()
      vic.update('shape:a1', (s) => ({ ...s, x: 320, props: { ...s.props, color: 'blue', size: 'l' } }))
      expect(await lastResult(vic)).toBe('commit')
      await waitFor(() => bob.get('shape:a1')?.x === 320)
      expect(by(await storedShape(server, boardId, 'shape:a1'))).toBe(ALICE)
    })

    it('duplicate and paste of a note with text: the copy is stamped with the paster (onBeforeDuplicate)', async () => {
      const { server, boardId, vic, bob } = await board()
      const original = vic.get('shape:a1') as ShapeRecord
      vic.put({
        ...original,
        id: 'shape:dup' as ShapeRecord['id'],
        x: 260,
        props: { ...original.props, textLastEditedBy: VIC },
      })
      expect(await lastResult(vic)).toBe('commit')
      await waitFor(() => bob.get('shape:dup'))
      expect(by(bob.get('shape:dup'))).toBe(VIC)
      expect(by(await storedShape(server, boardId, 'shape:dup'))).toBe(VIC)
      // a note created empty (toolbar, double click, the adjacent-note handle) has no attribution
      vic.put(note('blank', '', null, { x: 600 }))
      expect(await lastResult(vic)).toBe('commit')
    })

    it('undo and redo of an edit to alice’s note bring back her words with her name, then his', async () => {
      const { server, boardId, alice, vic, bob } = await board()
      vic.update('shape:a1', (s) => edited(s, 'Cancel the Q3 launch', VIC))
      expect(await lastResult(vic)).toBe('commit')
      await waitFor(() => by(bob.get('shape:a1')) === VIC)

      // undo (per-property replay): exactly the two fields the entry changed, back to alice's
      vic.update('shape:a1', (s) => edited(s, 'Keep the Q3 launch', ALICE))
      expect(await lastResult(vic)).toBe('commit')
      await expectAlicesNote(server, boardId, alice, bob, vic)

      // redo
      vic.update('shape:a1', (s) => edited(s, 'Cancel the Q3 launch', VIC))
      expect(await lastResult(vic)).toBe('commit')
      await waitFor(
        () => by(bob.get('shape:a1')) === VIC && textOf(bob.get('shape:a1')) === 'Cancel the Q3 launch',
      )
      // and undo once more
      vic.update('shape:a1', (s) => edited(s, 'Keep the Q3 launch', ALICE))
      expect(await lastResult(vic)).toBe('commit')
      await expectAlicesNote(server, boardId, alice, bob, vic)
      expectUndisturbed(alice, vic, bob)
    })

    it('undo of a deleted note (and of a cut) re-creates it with its author’s name', async () => {
      const { server, boardId, alice, vic, bob } = await board()
      const before = vic.get('shape:a1') as ShapeRecord
      vic.remove('shape:a1')
      expect(await lastResult(vic)).toBe('commit')
      await waitFor(() => bob.get('shape:a1') === undefined)
      vic.put(before) // the history entry's `removed` record, re-added as it was
      expect(await lastResult(vic)).toBe('commit')
      await expectAlicesNote(server, boardId, alice, bob, vic)
    })

    it('a note moved to another page (delete and re-create with the same id, even in two pushes) keeps its name', async () => {
      // Editor.moveShapesToPage deletes the shapes and puts them back with preserveIds (no re-stamp);
      // in one transaction the store squashes that to an update, but two pushes must work too.
      const { server, boardId, alice, vic, bob } = await board()
      vic.store.put([{ id: 'page:two', typeName: 'page', name: 'Page 2', index: 'a2', meta: {} } as TLRecord])
      expect(await lastResult(vic)).toBe('commit')
      const before = vic.get('shape:a1') as ShapeRecord
      vic.update('shape:a1', (s) => ({ ...s, parentId: 'page:two' }))
      expect(await lastResult(vic)).toBe('commit')
      vic.remove('shape:a1')
      await vic.waitForAcked()
      vic.put({ ...before, parentId: PAGE_ID })
      expect(await lastResult(vic)).toBe('commit')
      await expectAlicesNote(server, boardId, alice, bob, vic)
    })

    it('undo of a delete still works after the sync server restarted ("Recently deleted" vouches for it)', async () => {
      const { server, boardId, vic } = await board()
      const before = vic.get('shape:a1') as ShapeRecord
      vic.remove('shape:a1')
      await vic.waitForAcked()
      await server.kill('SIGKILL')
      await server.restart()
      await vic.waitForSynced()
      vic.put(before)
      expect(await lastResult(vic)).toBe('commit')
      expect(by(await storedShape(server, boardId, 'shape:a1'))).toBe(ALICE)
      await expectSettled(vic)
    })

    it('residual: undo of an edit to someone else’s note after a restart is skipped (the server cannot vouch for it), with no loop', async () => {
      const { server, boardId, vic } = await board()
      vic.update('shape:a1', (s) => edited(s, 'Cancel the Q3 launch', VIC))
      await vic.waitForAcked()
      await server.kill('SIGKILL')
      await server.restart()
      await vic.waitForSynced()
      vic.update('shape:a1', (s) => edited(s, 'Keep the Q3 launch', ALICE))
      expect(await lastResult(vic)).toBe('discard')
      await waitFor(() => by(vic.get('shape:a1')) === VIC)
      const s = await storedShape(server, boardId, 'shape:a1')
      expect([textOf(s), by(s)]).toEqual(['Cancel the Q3 launch', VIC])
      await expectSettled(vic)
    })
  })

  describe('private-note reveals', () => {
    const reveal = (server: SyncServer, boardId: string, anonymous: boolean) =>
      callInternal(server.url, 'POST', `/internal/boards/${boardId}/place-notes`, {
        body: {
          sessionId: 'pbs_AAAAAAAAAAAAAAAAAAAA',
          anonymous,
          frame: {
            id: 'shape:frame1',
            pageId: PAGE_ID,
            x: 0,
            y: 600,
            w: 1000,
            h: 600,
            name: 'Private ideas',
          },
          notes: [
            {
              id: 'pnt_0001AAAAAAAAAAAAAAAA',
              text: 'Raise prices',
              color: 'yellow',
              authorId: anonymous ? null : ALICE,
            },
          ],
          authors: anonymous ? [] : [{ id: ALICE, name: 'Alice Adams', color: '#1971c2' }],
        },
      })
    const REVEALED = 'shape:pnt_0001AAAAAAAAAAAAAAAA'

    it('an anonymous reveal stays anonymous: nobody can put a name on it without rewriting it', async () => {
      const { server, boardId, alice, vic, bob } = await board()
      expect((await reveal(server, boardId, true)).status).toBe(200)
      await waitFor(() => vic.get(REVEALED))
      expect(by(vic.get(REVEALED))).toBeNull()

      for (const who of [ALICE, VIC, CAROL]) {
        const clock = vic.sendRawPush({
          [REVEALED]: ['patch', { props: ['patch', { textLastEditedBy: ['put', who] }] }],
        } as NetworkDiff)
        expect(await rawResult(vic, clock)).toBe('discard')
      }
      // nor retype it and stay unnamed (a richText-only patch keeps the null attribution)
      const retype = vic.sendRawPush({
        [REVEALED]: ['patch', { props: ['patch', { richText: ['put', toRichText('Lower prices')] }] }],
      } as NetworkDiff)
      expect(await rawResult(vic, retype)).toBe('discard')
      // alice (who may well be its author) cannot claim it either without editing it
      alice.update(REVEALED, (s) => ({ ...s, props: { ...s.props, textLastEditedBy: ALICE } }))
      expect(await lastResult(alice)).toBe('discard')
      await sleep(200)
      for (const c of [alice, vic, bob]) expect(by(c.get(REVEALED)), c.name).toBeNull()
      expect(by(await storedShape(server, boardId, REVEALED))).toBeNull()

      // editing its text is honest and names the editor, and undo makes it anonymous again
      vic.update(REVEALED, (s) => edited(s, 'Raise prices in Q4', VIC))
      expect(await lastResult(vic)).toBe('commit')
      vic.update(REVEALED, (s) => edited(s, 'Raise prices', null))
      expect(await lastResult(vic)).toBe('commit')
      await waitFor(() => textOf(bob.get(REVEALED)) === 'Raise prices' && by(bob.get(REVEALED)) === null)
      expectUndisturbed(alice, vic, bob)
    })

    it('a named reveal keeps its author (server writes are not client pushes), and a guest cannot move it to someone else', async () => {
      const { server, boardId, vic, bob } = await board()
      expect((await reveal(server, boardId, false)).status).toBe(200)
      await waitFor(() => bob.get(REVEALED))
      expect(by(bob.get(REVEALED))).toBe(ALICE)
      const clock = vic.sendRawPush({
        [REVEALED]: ['patch', { props: ['patch', { textLastEditedBy: ['put', CAROL] }] }],
      } as NetworkDiff)
      expect(await rawResult(vic, clock)).toBe('discard')
      vic.update(REVEALED, (s) => edited(s, 'Alice: raise prices by 50%', ALICE))
      expect(await lastResult(vic)).toBe('discard')
      await sleep(200)
      expect([textOf(bob.get(REVEALED)), by(bob.get(REVEALED))]).toEqual(['Raise prices', ALICE])
      expectUndisturbed(vic, bob)
    })
  })

  it('server writes keep whatever attribution they carry: a template seed and a "Recently deleted" restore', async () => {
    const server = await startServer()
    const boardId = newBoardId()
    const seeded = await callInternal(server.url, 'POST', `/internal/boards/${boardId}/seed`, {
      body: {
        snapshot: {
          schema: draftroomSchema.serialize(),
          documents: [note('seeded', 'From the template', CAROL)].map((state) => ({
            state,
            lastChangedClock: 0,
          })),
        },
      },
    })
    expect(seeded.status).toBe(201)
    const alice = await join(server, boardId, ALICE)
    expect(by(alice.get('shape:seeded'))).toBe(CAROL)

    alice.remove('shape:seeded')
    await alice.waitForAcked()
    const restored = await callInternal(server.url, 'POST', `/internal/boards/${boardId}/deleted/restore`, {
      body: { ids: ['shape:seeded'] },
    })
    expect(restored.status).toBe(200)
    await waitFor(() => alice.get('shape:seeded'))
    expect(by(alice.get('shape:seeded'))).toBe(CAROL)
    expectUndisturbed(alice)
  })
})
