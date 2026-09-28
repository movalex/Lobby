// Private brainstorming (docs/WAVE3-CONTRACTS.md "private-notes"): author-only drafts, count-only
// events, the reveal (idempotent, retried after a sync failure), anonymity, cancel and permissions.
import type { PrivateBrainstormState } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { Client } from '../../helpers.ts'
import { expectStatus, json, setupWorld, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.api.close()
})

interface PlaceCall {
  boardId: string
  body: {
    sessionId: string
    anonymous: boolean
    frame: Record<string, unknown>
    notes: { id: string; text: string; color: string; authorId: string | null }[]
    authors: { id: string; name: string; color: string }[]
  }
}

/** The sync server's place-notes endpoint, as the API sees it: idempotent per draft id. */
function fakePlacement(world: World) {
  const onBoard = new Set<string>()
  const calls: PlaceCall[] = []
  const ctl = { down: false, calls, onBoard }
  Object.assign(world.sync, {
    async placeNotes(boardId: string, body: PlaceCall['body']) {
      calls.push({ boardId, body: structuredClone(body) })
      if (ctl.down) throw new Error('sync down')
      const placed: string[] = []
      const existing: string[] = []
      for (const n of body.notes) {
        const id = `shape:${n.id}`
        if (onBoard.has(id)) existing.push(id)
        else {
          onBoard.add(id)
          placed.push(id)
        }
      }
      return { placed, existing, frameId: body.frame.id, frameCreated: false }
    },
  })
  return ctl
}

const TARGET = { frameId: 'shape:frame1', pageId: 'page:page', x: 100, y: 200, w: 1120, h: 720 }

async function world() {
  w = await setupWorld()
  return w
}

async function start(c: Client, body: Record<string, unknown> = {}) {
  const res = await c.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, {
    prompt: 'What should we stop doing?',
    anonymous: false,
    target: TARGET,
    ...body,
  })
  expectStatus(res, 201)
  return json<PrivateBrainstormState>(res)
}
const state = async (c: Client) => {
  const res = await c.req('GET', `/api/boards/${w.boardId}/private-brainstorm`)
  expectStatus(res, 200)
  return json<PrivateBrainstormState>(res)
}
const add = (c: Client, sid: string, text: string, color = 'yellow') =>
  c.req('POST', `/api/private-brainstorms/${sid}/notes`, { text, color })
async function addOk(c: Client, sid: string, text: string, color = 'yellow') {
  const res = await add(c, sid, text, color)
  expectStatus(res, 201)
  return json<PrivateBrainstormState>(res)
}
const reveal = (c: Client, sid: string) => c.req('POST', `/api/private-brainstorms/${sid}/reveal`)
const privateEvents = () => w.events.filter((e) => e.type === 'workshop.private')
const draftRows = async () =>
  (await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM private_notes')).n
const errCode = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code

async function secondEditor(): Promise<Client> {
  const c = await w.api.login('eve', 'Eve Editor')
  expectStatus(
    await w.owner.req('PUT', `/api/boards/${w.boardId}/members/${c.userId}`, { role: 'editor' }),
    200,
  )
  return c
}

describe('starting a private brainstorm', () => {
  it('editors and owners start one; one active per board; inputs validated; everyone sees it', async () => {
    await world()
    const body = { prompt: 'Ideas?', anonymous: true, target: TARGET }
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, body), 403)
    expectStatus(await w.commenter.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, body), 403)
    expectStatus(await w.outsider.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, body), 404)
    for (const bad of [
      { ...body, prompt: '   ' },
      { ...body, prompt: 'x'.repeat(201) },
      { ...body, prompt: 'ring\u0007' },
      { ...body, anonymous: 'yes' },
      { ...body, target: { ...TARGET, frameId: 'frame1' } },
      { ...body, target: { ...TARGET, w: 0 } },
      { ...body, target: { ...TARGET, pageId: 'page' } },
      { prompt: 'x', anonymous: false },
    ])
      expectStatus(await w.editor.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, bad), 400)

    const s = await start(w.editor, { prompt: '  What   should we stop doing? ', anonymous: true })
    expect(s.session).toMatchObject({
      status: 'open',
      prompt: 'What should we stop doing?',
      anonymous: true,
      frameId: 'shape:frame1',
      createdBy: w.editor.userId,
    })
    expect(s).toMatchObject({ counts: { notes: 0, people: 0 }, myNotes: [], canReveal: true })
    const again = await w.owner.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, body)
    expectStatus(again, 409)
    expect(errCode(again)).toBe('PRIVATE_ALREADY_ACTIVE')
    // everyone who can view sees the session (not who may reveal it: that is per person)
    const seen = await state(w.viewer)
    expect(seen.session?.id).toBe(s.session?.id)
    expect(seen.canReveal).toBe(false)
    expect((await state(w.owner)).canReveal).toBe(true) // board owner
    expectStatus(await w.outsider.req('GET', `/api/boards/${w.boardId}/private-brainstorm`), 404)
    expect(privateEvents().map((e) => (e.data as { session: { status: string } }).session.status)).toEqual([
      'open',
    ])
  })

  it('two starts at the same moment make exactly one session', async () => {
    await world()
    const body = { prompt: 'Ideas?', anonymous: false, target: TARGET }
    const res = await Promise.all([
      w.owner.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, body),
      w.editor.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, body),
    ])
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409])
  })

  it('an archived board is read-only', async () => {
    await world()
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/archive`), 200)
    const res = await w.owner.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, {
      prompt: 'x',
      anonymous: false,
      target: TARGET,
    })
    expectStatus(res, 403)
  })
})

describe('drafts are readable by their author only', () => {
  it('no route and no event gives anyone else the text; counts are for everyone', async () => {
    await world()
    const s = await start(w.owner)
    const sid = s.session?.id as string
    const editor = w.track(w.editor)
    const owner = w.track(w.owner)
    const viewer = w.track(w.viewer)
    const commenter = w.track(w.commenter)
    const outsider = w.track(w.outsider)

    const e1 = await addOk(editor, sid, 'Editor secret alpha', 'blue')
    expect(e1.myNotes.map((n) => [n.text, n.color])).toEqual([['Editor secret alpha', 'blue']])
    await addOk(editor, sid, 'Editor secret beta')
    const o1 = await addOk(owner, sid, 'Owner secret gamma', 'green')
    expect(o1.myNotes.map((n) => n.text)).toEqual(['Owner secret gamma'])
    expect(o1.counts).toEqual({ notes: 3, people: 2 })

    // Everyone else asks every way they can.
    const eNote = e1.myNotes[0]?.id as string
    for (const c of [owner, viewer, commenter, outsider]) {
      await c.req('GET', `/api/boards/${w.boardId}/private-brainstorm`)
      await c.req('PATCH', `/api/private-notes/${eNote}`, { text: 'hijack' })
      await c.req('DELETE', `/api/private-notes/${eNote}`)
      await c.req('GET', `/api/boards/${w.boardId}/workshop`)
    }
    const viewerState = await state(viewer)
    expect(viewerState).toMatchObject({ counts: { notes: 3, people: 2 }, myNotes: [] })
    expect((await state(owner)).myNotes.map((n) => n.text)).toEqual(['Owner secret gamma'])

    for (const c of [owner, viewer, commenter, outsider]) {
      const bodies = (w.seen.get(c.userId) ?? []).join('\n')
      expect(bodies).not.toContain('Editor secret')
    }
    for (const c of [editor, viewer, commenter, outsider]) {
      expect((w.seen.get(c.userId) ?? []).join('\n')).not.toContain('Owner secret')
    }
    // Events: counts only (never a text, never who wrote a note).
    const evs = privateEvents()
    const raw = JSON.stringify(evs)
    expect(raw).not.toContain('secret')
    for (const e of evs) expect(Object.keys(e.data as object).sort()).toEqual(['counts', 'session'])
    expect(evs.map((e) => (e.data as { counts: unknown }).counts)).toEqual([
      { notes: 0, people: 0 },
      { notes: 1, people: 1 },
      { notes: 2, people: 1 },
      { notes: 3, people: 2 },
    ])
    // The owner's attempts changed nothing.
    expect((await state(editor)).myNotes.map((n) => n.text)).toEqual([
      'Editor secret alpha',
      'Editor secret beta',
    ])
  })

  it('authors edit and delete their own drafts; others get 404; viewers and commenters cannot write', async () => {
    await world()
    const s = await start(w.editor)
    const sid = s.session?.id as string
    const mine = (await addOk(w.editor, sid, 'first')).myNotes[0]?.id as string
    for (const [c, status] of [
      [w.viewer, 403],
      [w.commenter, 403],
      [w.outsider, 404],
    ] as const)
      expectStatus(await add(c, sid, 'nope'), status)
    for (const c of [w.owner, w.viewer, w.outsider]) {
      expectStatus(await c.req('PATCH', `/api/private-notes/${mine}`, { text: 'x' }), 404)
      expectStatus(await c.req('DELETE', `/api/private-notes/${mine}`), 404)
    }
    const edited = await w.editor.req('PATCH', `/api/private-notes/${mine}`, {
      text: ' second ',
      color: 'red',
    })
    expectStatus(edited, 200)
    expect(json<PrivateBrainstormState>(edited).myNotes).toMatchObject([{ text: 'second', color: 'red' }])
    expectStatus(await w.editor.req('PATCH', `/api/private-notes/${mine}`, {}), 400)
    const events = privateEvents().length
    const deleted = await w.editor.req('DELETE', `/api/private-notes/${mine}`)
    expectStatus(deleted, 200)
    expect(json<PrivateBrainstormState>(deleted)).toMatchObject({
      myNotes: [],
      counts: { notes: 0, people: 0 },
    })
    expect(privateEvents().length).toBe(events + 1)
    expectStatus(await w.editor.req('DELETE', `/api/private-notes/${mine}`), 404)
    expectStatus(await w.editor.req('DELETE', '/api/private-notes/not-an-id'), 404)
    expectStatus(await add(w.editor, 'pbs_doesnotexist0000', 'x'), 404)
  })

  it('validates text and color, counts code points, and caps notes per person', async () => {
    await world()
    const sid = (await start(w.editor)).session?.id as string
    for (const [text, color] of [
      ['', 'yellow'],
      ['   ', 'yellow'],
      ['x'.repeat(501), 'yellow'],
      ['bell \u0007', 'yellow'],
      ['ok', 'magenta'],
    ])
      expectStatus(await add(w.editor, sid, text as string, color as string), 400)
    // 500 emoji are 500 characters (1,000 UTF-16 units): accepted, like Postgres counts them
    expect((await addOk(w.editor, sid, '🎉'.repeat(500))).myNotes[0]?.text).toBe('🎉'.repeat(500))
    expect((await addOk(w.editor, sid, 'two\r\nlines')).myNotes[1]?.text).toBe('two\nlines')
    for (let i = 2; i < 50; i++) await addOk(w.editor, sid, `note ${i}`)
    const over = await add(w.editor, sid, 'one too many')
    expectStatus(over, 409)
    expect(errCode(over)).toBe('TOO_MANY_NOTES')
  })

  it('limits how fast one person writes', async () => {
    await world()
    const sid = (await start(w.editor)).session?.id as string
    const mine = (await addOk(w.editor, sid, 'first')).myNotes[0]?.id as string
    let limited = 0
    for (let i = 0; i < 125 && limited === 0; i++) {
      const res = await w.editor.req('PATCH', `/api/private-notes/${mine}`, { text: `edit ${i}` })
      if (res.statusCode === 429) limited++
      else expectStatus(res, 200)
    }
    expect(limited).toBe(1)
    // someone else is not held up
    await addOk(w.owner, sid, 'owner still writes')
  })
})

describe('revealing', () => {
  it('only the starter or a board owner reveals; the notes are placed, grouped by author, then deleted', async () => {
    await world()
    const place = fakePlacement(w)
    const sid = (await start(w.editor)).session?.id as string
    await addOk(w.editor, sid, 'E1', 'blue')
    await addOk(w.owner, sid, 'O1')
    await addOk(w.editor, sid, 'E2')
    const eve = await secondEditor()
    await addOk(eve, sid, 'V1')
    expectStatus(await reveal(eve, sid), 403) // an editor who did not start it
    expectStatus(await reveal(w.viewer, sid), 403)
    expectStatus(await reveal(w.outsider, sid), 404)

    const res = await reveal(w.editor, sid)
    expectStatus(res, 200)
    const out = json<PrivateBrainstormState>(res)
    expect(out.session).toBeNull()
    expect(out.placed).toMatchObject({ id: sid, status: 'placed', placedCount: 4 })
    expect(place.calls).toHaveLength(1)
    const call = place.calls[0] as PlaceCall
    expect(call.boardId).toBe(w.boardId)
    expect(call.body.frame).toMatchObject({ id: 'shape:frame1', pageId: 'page:page', x: 100, y: 200 })
    // grouped by author, in order of each author's first note
    expect(call.body.notes.map((n) => n.text)).toEqual(['E1', 'E2', 'O1', 'V1'])
    expect(call.body.notes.map((n) => n.authorId)).toEqual([
      w.editor.userId,
      w.editor.userId,
      w.owner.userId,
      eve.userId,
    ])
    expect(call.body.authors.map((a) => a.name).sort()).toEqual(['Ada Owner', 'Ed Editor', 'Eve Editor'])
    expect(await draftRows()).toBe(0)
    expect((await state(w.viewer)).session).toBeNull()
    const statuses = privateEvents().map((e) => (e.data as { session: { status: string } }).session.status)
    expect(statuses.slice(-2)).toEqual(['revealed', 'placed'])
    // a new one can start afterwards
    await start(w.owner)
  })

  it('a doubled or repeated reveal places each note once', async () => {
    await world()
    const place = fakePlacement(w)
    const sid = (await start(w.editor)).session?.id as string
    for (let i = 0; i < 5; i++) await addOk(w.editor, sid, `n${i}`)
    const [a, b] = await Promise.all([reveal(w.editor, sid), reveal(w.owner, sid)])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect(place.onBoard.size).toBe(5)
    const sent = place.calls.flatMap((c) => c.body.notes.map((n) => n.id))
    expect(new Set(sent).size).toBe(5)
    // pressing it again: nothing is sent, the answer says it is on the board
    const again = await reveal(w.editor, sid)
    expectStatus(again, 200)
    expect(json<PrivateBrainstormState>(again).placed?.placedCount).toBe(5)
    expect(place.onBoard.size).toBe(5)
    expect(
      privateEvents().filter((e) => (e.data as { session: { status: string } }).session.status === 'placed'),
    ).toHaveLength(1)
  })

  it('a failed placement keeps the drafts for "Place notes"; nobody can edit them meanwhile', async () => {
    await world()
    const place = fakePlacement(w)
    const sid = (await start(w.editor)).session?.id as string
    const note = (await addOk(w.editor, sid, 'kept')).myNotes[0]?.id as string
    place.down = true
    const failed = await reveal(w.editor, sid)
    expectStatus(failed, 503)
    expect(errCode(failed)).toBe('PLACE_FAILED')
    const s = await state(w.viewer)
    expect(s.session?.status).toBe('revealed')
    expect(s.counts).toEqual({ notes: 1, people: 1 })
    expect(await draftRows()).toBe(1)
    const edit = await w.editor.req('PATCH', `/api/private-notes/${note}`, { text: 'changed' })
    expectStatus(edit, 409)
    expectStatus(await add(w.editor, sid, 'late'), 409)
    // one active session stays one: no new start while it waits
    expectStatus(
      await w.owner.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, {
        prompt: 'x',
        anonymous: false,
        target: TARGET,
      }),
      409,
    )
    place.down = false
    const ok = await reveal(w.owner, sid)
    expectStatus(ok, 200)
    expect(place.onBoard).toEqual(new Set([`shape:${note}`]))
    expect(place.calls.at(-1)?.body.notes[0]?.text).toBe('kept')
    expect(await draftRows()).toBe(0)
  })

  it('a reveal with no drafts ends the session without calling the canvas', async () => {
    await world()
    const place = fakePlacement(w)
    const sid = (await start(w.editor)).session?.id as string
    const res = await reveal(w.editor, sid)
    expectStatus(res, 200)
    expect(json<PrivateBrainstormState>(res).placed).toMatchObject({ status: 'placed', placedCount: 0 })
    expect(place.calls).toHaveLength(0)
  })
})

describe('anonymous sessions', () => {
  it('never tell anyone who wrote what: not the canvas, not a route, not an event', async () => {
    await world()
    const place = fakePlacement(w)
    const sid = (await start(w.owner, { anonymous: true })).session?.id as string
    await addOk(w.editor, sid, 'Anon from editor')
    await addOk(w.owner, sid, 'Anon from owner')
    await addOk(w.editor, sid, 'Anon again')
    const res = await reveal(w.owner, sid)
    expectStatus(res, 200)
    const body = (place.calls[0] as PlaceCall).body
    expect(body.anonymous).toBe(true)
    expect(body.authors).toEqual([])
    expect(body.notes.every((n) => n.authorId === null)).toBe(true)
    // no user id anywhere in what goes to the canvas
    expect(JSON.stringify(body)).not.toMatch(/usr_/)
    // the order is the drafts' random ids, not who wrote them or when
    const ids = body.notes.map((n) => n.id)
    expect([...ids].sort()).toEqual(ids)
    // after the reveal the drafts (and with them the only record of authorship) are gone
    const rows = await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM private_notes')
    expect(rows.n).toBe(0)
    for (const e of privateEvents()) {
      const d = e.data as { session: Record<string, unknown> }
      expect(JSON.stringify(d)).not.toContain('Anon')
      // the only person an event names is whoever started the session
      const ids = JSON.stringify(d).match(/usr_[0-9A-Za-z]+/g) ?? []
      expect(new Set(ids)).toEqual(new Set([w.owner.userId]))
    }
  })
})

describe('cancelling', () => {
  it('discards every draft; only the starter or a board owner may; then a new one can start', async () => {
    await world()
    const place = fakePlacement(w)
    const sid = (await start(w.editor)).session?.id as string
    await addOk(w.editor, sid, 'gone soon')
    await addOk(w.owner, sid, 'also gone')
    const eve = await secondEditor()
    expectStatus(await eve.req('POST', `/api/private-brainstorms/${sid}/cancel`), 403)
    expectStatus(await w.viewer.req('POST', `/api/private-brainstorms/${sid}/cancel`), 403)
    const res = await w.owner.req('POST', `/api/private-brainstorms/${sid}/cancel`)
    expectStatus(res, 200)
    expect(json<PrivateBrainstormState>(res).session).toBeNull()
    expect(await draftRows()).toBe(0)
    expect(privateEvents().at(-1)?.data).toMatchObject({
      session: { id: sid, status: 'cancelled' },
      counts: { notes: 0, people: 0 },
    })
    // idempotent; a cancelled session is never revealed
    expectStatus(await w.owner.req('POST', `/api/private-brainstorms/${sid}/cancel`), 200)
    const late = await reveal(w.editor, sid)
    expectStatus(late, 409)
    expect(errCode(late)).toBe('PRIVATE_CANCELLED')
    expect(place.calls).toHaveLength(0)
    await start(w.editor)
  })
})
