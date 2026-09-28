// Private brainstorming when people lose access mid-session (round-2 finding SEAM-07): a brainstorm
// started by someone who can no longer edit the board (removed, lowered to a read-only role, or a
// name-only guest who left) must not block the board's other facilitators, and drafts of people who
// left the board never reach it.
import type { PrivateBrainstormState } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { Client } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest } from '../guests/support.ts'
import { expectStatus, json, setupWorld, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.api.close()
})

type Requester = Pick<Client, 'req'> | GuestClient

const TARGET = { frameId: 'shape:frame1', pageId: 'page:page', x: 100, y: 200, w: 1120, h: 720 }

interface PlaceCall {
  notes: { id: string; text: string; authorId: string | null }[]
}

/** The sync server's place-notes endpoint as the API sees it (idempotent per draft id). */
function fakePlacement(world: World) {
  const calls: PlaceCall[] = []
  Object.assign(world.sync, {
    async placeNotes(_boardId: string, body: PlaceCall & { frame: { id: string } }) {
      calls.push(structuredClone(body))
      return {
        placed: body.notes.map((n) => `shape:${n.id}`),
        existing: [],
        frameId: body.frame.id,
        frameCreated: false,
      }
    },
  })
  return calls
}

const state = async (c: Requester) => {
  const res = await c.req('GET', `/api/boards/${w.boardId}/private-brainstorm`)
  expectStatus(res, 200)
  return json<PrivateBrainstormState>(res)
}

async function start(c: Requester, anonymous = true) {
  const res = await c.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, {
    prompt: 'Rate your manager 1-10',
    anonymous,
    target: TARGET,
  })
  expectStatus(res, 201)
  const sid = json<PrivateBrainstormState>(res).session?.id
  if (!sid) throw new Error('no session')
  return sid
}

async function draft(c: Requester, sid: string, text: string) {
  expectStatus(await c.req('POST', `/api/private-brainstorms/${sid}/notes`, { text, color: 'red' }), 201)
}

const errCode = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code
const drafts = async () =>
  (await w.api.db.query<{ body: string }>('SELECT body FROM private_notes ORDER BY seq')).rows.map(
    (r) => r.body,
  )

/** A name-only guest on a workshop (editor) link of the board. */
async function guestEditor(name = 'Troll') {
  const link = await guestLink(w.owner, w.boardId, { role: 'editor' })
  return joinAsGuest(w.api, link.url, name)
}

const removeFromBoard = async (userId: string) =>
  expectStatus(await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${userId}`), 200)

/**
 * A brainstorm a guest started before guests stopped facilitating (final review R3): such sessions
 * may still exist, so the take-over rules below still hold for them. Started by the owner, then
 * recorded as the guest's.
 */
async function startedBy(guest: GuestClient) {
  const sid = await start(w.owner)
  await w.api.db.query('UPDATE private_brainstorms SET created_by = $2 WHERE id = $1', [sid, guest.userId])
  return sid
}

describe('who starts a brainstorm (final review R3)', () => {
  it('a name-only guest editor cannot start one (403 after the board checks), but writes drafts in one', async () => {
    w = await setupWorld()
    const guest = await guestEditor('Jordan')
    const refused = await guest.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, {
      prompt: 'What slowed us down?',
      anonymous: false,
      target: TARGET,
    })
    expectStatus(refused, 403)
    expect(errCode(refused)).toBe('GUEST_ACCOUNT_REQUIRED')
    expect((await state(w.owner)).session).toBeNull()
    // An account editor starts it; the guest takes part.
    const sid = await start(w.editor)
    await draft(guest, sid, 'from the guest')
    expect((await state(guest)).canReveal).toBe(false)
    expectStatus(await guest.req('POST', `/api/private-brainstorms/${sid}/cancel`), 403)
  })
})

describe('a brainstorm whose starter can no longer edit the board', () => {
  it('a guest starter who was removed: any account editor can cancel it and start the next one', async () => {
    w = await setupWorld()
    const guest = await guestEditor()
    const sid = await startedBy(guest)
    await draft(guest, sid, 'offensive text')
    // While the guest can still edit, it is theirs (and the board owner's) to end.
    expect((await state(w.editor)).canReveal).toBe(false)
    expectStatus(await w.editor.req('POST', `/api/private-brainstorms/${sid}/cancel`), 403)

    await removeFromBoard(guest.userId)
    const seen = await state(w.editor)
    expect(seen.canReveal).toBe(true)
    expect(seen.starterLeft).toBe(true)
    // Viewers learn nothing about the starter's access.
    expect(await state(w.viewer)).toMatchObject({ canReveal: false, starterLeft: false })

    expectStatus(await w.editor.req('POST', `/api/private-brainstorms/${sid}/cancel`), 200)
    expect(await drafts()).toEqual([])
    // The board is free for the facilitator's own brainstorm.
    await start(w.editor, false)
  })

  it('a guest starter who signed out (before the guest sweep ran): account editors can reveal it', async () => {
    w = await setupWorld()
    const calls = fakePlacement(w)
    const guest = await guestEditor('Sam')
    const sid = await startedBy(guest)
    await draft(guest, sid, 'from the guest who left')
    await draft(w.editor, sid, 'from the editor')
    expectStatus(await guest.req('POST', '/api/auth/logout'), 204)

    expect((await state(w.editor)).canReveal).toBe(true)
    const res = await w.editor.req('POST', `/api/private-brainstorms/${sid}/reveal`)
    expectStatus(res, 200)
    expect(json<PrivateBrainstormState>(res).placed).toMatchObject({ status: 'placed', placedCount: 1 })
    // The guest who left is gone with their drafts: only the editor's note reaches the board.
    expect(calls.flatMap((c) => c.notes.map((n) => n.text))).toEqual(['from the editor'])
    expect(await drafts()).toEqual([])
  })

  it('a member starter downgraded to viewer: another editor reveals; a still-editing starter keeps it', async () => {
    w = await setupWorld()
    fakePlacement(w)
    const eve = await w.api.login('eve', 'Eve Editor')
    expectStatus(
      await w.owner.req('PUT', `/api/boards/${w.boardId}/members/${eve.userId}`, { role: 'editor' }),
      200,
    )
    const sid = await start(eve, false)
    await draft(eve, sid, 'eve idea')
    expectStatus(await w.editor.req('POST', `/api/private-brainstorms/${sid}/reveal`), 403)
    expect((await state(w.editor)).starterLeft).toBe(false)

    expectStatus(
      await w.owner.req('PUT', `/api/boards/${w.boardId}/members/${eve.userId}`, { role: 'viewer' }),
      200,
    )
    expect(await state(w.editor)).toMatchObject({ canReveal: true, starterLeft: true })
    expectStatus(await w.editor.req('POST', `/api/private-brainstorms/${sid}/reveal`), 200)
  })

  it('a guest editor cannot take over another guest’s brainstorm; commenters and viewers never can', async () => {
    w = await setupWorld()
    const first = await guestEditor('First')
    const second = await guestEditor('Second')
    const sid = await startedBy(first)
    await removeFromBoard(first.userId)
    const asGuest = await state(second)
    expect(asGuest.canReveal).toBe(false)
    expectStatus(await second.req('POST', `/api/private-brainstorms/${sid}/cancel`), 403)
    expectStatus(await second.req('POST', `/api/private-brainstorms/${sid}/reveal`), 403)
    for (const c of [w.commenter, w.viewer]) {
      expect((await state(c)).canReveal).toBe(false)
      expectStatus(await c.req('POST', `/api/private-brainstorms/${sid}/cancel`), 403)
    }
    // The board owner always could.
    expectStatus(await w.owner.req('POST', `/api/private-brainstorms/${sid}/cancel`), 200)
  })
})

describe('drafts of people who left the board', () => {
  it('are left off the board at reveal and deleted; a member lowered to commenter keeps theirs', async () => {
    w = await setupWorld()
    const calls = fakePlacement(w)
    const guest = await guestEditor('Wes')
    const eve = await w.api.login('eve', 'Eve Editor')
    expectStatus(
      await w.owner.req('PUT', `/api/boards/${w.boardId}/members/${eve.userId}`, { role: 'editor' }),
      200,
    )
    const sid = await start(w.owner)
    await draft(guest, sid, 'guest draft')
    await draft(eve, sid, 'eve draft')
    await draft(w.editor, sid, 'editor draft')
    await draft(w.owner, sid, 'owner draft')
    await removeFromBoard(guest.userId)
    expectStatus(
      await w.owner.req('PUT', `/api/boards/${w.boardId}/members/${eve.userId}`, { role: 'commenter' }),
      200,
    )

    const before = w.events.length
    const res = await w.owner.req('POST', `/api/private-brainstorms/${sid}/reveal`)
    expectStatus(res, 200)
    expect(json<PrivateBrainstormState>(res).placed).toMatchObject({ placedCount: 3 })
    expect(calls.flatMap((c) => c.notes.map((n) => n.text)).sort()).toEqual([
      'editor draft',
      'eve draft',
      'owner draft',
    ])
    expect(await drafts()).toEqual([])
    // Everyone's counts followed: the removed guest's draft is not counted once it is discarded.
    const counts = w.events
      .slice(before)
      .filter((e) => e.type === 'workshop.private')
      .map((e) => (e.data as { counts: { notes: number } }).counts.notes)
    expect(counts[0]).toBe(3)
  })

  it('a reveal where everyone who wrote has left ends the session with no notes', async () => {
    w = await setupWorld()
    const calls = fakePlacement(w)
    const guest = await guestEditor('Wes')
    const sid = await start(w.owner)
    await draft(guest, sid, 'only draft')
    await removeFromBoard(guest.userId)
    const res = await w.owner.req('POST', `/api/private-brainstorms/${sid}/reveal`)
    expectStatus(res, 200)
    expect(json<PrivateBrainstormState>(res).placed).toMatchObject({ status: 'placed', placedCount: 0 })
    expect(calls).toEqual([])
    expect(await drafts()).toEqual([])
    // The session is over: nothing is left to reveal or cancel.
    expect((await state(w.owner)).session).toBeNull()
    const cancel = await w.owner.req('POST', `/api/private-brainstorms/${sid}/cancel`)
    expect(cancel.statusCode).toBe(409)
    expect(errCode(cancel)).toBe('PRIVATE_PLACED')
  })
})
