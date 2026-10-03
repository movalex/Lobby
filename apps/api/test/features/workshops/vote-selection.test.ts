// RETRO-10 (migration 0024): a dot vote over the facilitator's selection: several frames (their contents
// take votes) and/or single objects, a capped list of refs. The api checks every listed ref is on the board
// when the vote starts and applies the list to every cast. A web build from before 0024 (no x-lobby-client
// header) cannot parse the scope 'selection': it gets the vote as a board vote, and its casts are still
// judged by the selection (NOT_ELIGIBLE outside it).
import {
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  VOTE_SELECTION_MAX,
  WorkshopState,
  type WorkshopVoteState,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Client } from '../../helpers.ts'
import { expectStatus, json, note, setupWorld, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.api.close()
})

const PAGE = 'page:page'
const REV = { [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV) }

/** A retro: columns "went" and "improve" with notes, a third frame "later", two loose notes. */
async function retro() {
  w = await setupWorld()
  w.sync.add(
    w.boardId,
    { id: 'shape:went', type: 'frame', parentId: PAGE },
    { id: 'shape:improve', type: 'frame', parentId: PAGE },
    { id: 'shape:later', type: 'frame', parentId: PAGE },
    note('w1', 'shape:went'),
    note('w2', 'shape:went'),
    { id: 'shape:wbox', type: 'geo', parentId: 'shape:went' },
    note('i1', 'shape:improve'),
    note('p1', 'shape:later'),
    note('loose'),
    note('other'),
    { id: 'shape:link', type: 'arrow', parentId: PAGE },
  )
  return w
}

const SELECTION = ['shape:went', 'shape:improve', 'shape:loose']

function start(c: Client, body: Record<string, unknown>, headers: Record<string, string> = REV) {
  return c.req(
    'POST',
    `/api/boards/${w.boardId}/votes`,
    { votesPerPerson: 5, onePerObject: false, ...body },
    headers,
  )
}
async function startSelection(
  c: Client,
  selection: string[] = SELECTION,
  extra: Record<string, unknown> = {},
) {
  const res = await start(c, { scope: 'selection', selection, ...extra })
  expectStatus(res, 201)
  return json<WorkshopVoteState>(res)
}
const cast = (c: Client, vid: string, shapeId: string, headers: Record<string, string> = REV) =>
  c.req('POST', `/api/votes/${vid}/cast`, { shapeId, delta: 1 }, headers)
const codeOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code

/** The workshop state as a web build from before 0024 parses it: its own VoteScope enum. */
const OldWorkshop = z.object({
  vote: z
    .object({
      session: z.object({ scope: z.enum(['board', 'frame']), frameId: z.string().nullable() }),
      myVotes: z.record(z.string(), z.number()),
    })
    .nullable(),
})

describe('RETRO-10: starting a selection vote', () => {
  it('stores the list (repeats dropped) and answers it to the current web build', async () => {
    await retro()
    const v = await startSelection(w.owner, [...SELECTION, 'shape:loose'], { shapeTypes: ['note'] })
    expect(v.session).toMatchObject({
      scope: 'selection',
      frameId: null,
      selection: SELECTION,
      shapeTypes: ['note'],
      status: 'open',
    })
    const row = await w.api.db.one('SELECT scope, frame_id, selection FROM vote_sessions WHERE id = $1', [
      v.session.id,
    ])
    expect(row).toEqual({ scope: 'selection', frame_id: null, selection: SELECTION })
    const res = await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`, undefined, REV)
    expect(WorkshopState.parse(res.json()).vote?.session).toMatchObject({
      scope: 'selection',
      selection: SELECTION,
    })
    const past = await w.owner.req('GET', `/api/boards/${w.boardId}/votes`, undefined, REV)
    expect(json<{ sessions: { scope: string; selection: string[] }[] }>(past).sessions[0]).toMatchObject({
      scope: 'selection',
      selection: SELECTION,
    })
  })

  it('every listed ref must be on the board; the list is required, capped and only for scope selection', async () => {
    await retro()
    const gone = await start(w.owner, { scope: 'selection', selection: ['shape:went', 'shape:nope'] })
    expectStatus(gone, 400)
    expect(gone.body).toContain('one of the selected objects is not on this board')
    const two = await start(w.owner, { scope: 'selection', selection: ['shape:x', 'shape:y', 'shape:went'] })
    expectStatus(two, 400)
    expect(two.body).toContain('2 of the selected objects are not on this board')
    const tooMany = Array.from({ length: VOTE_SELECTION_MAX + 1 }, (_, i) => `shape:n${i}`)
    for (const bad of [
      { scope: 'selection' },
      { scope: 'selection', selection: [] },
      { scope: 'selection', selection: tooMany },
      { scope: 'board', selection: ['shape:went'] },
      { scope: 'selection', selection: ['shape:went'], frameId: 'shape:went' },
    ])
      expectStatus(await start(w.owner, bad), 400)
    // People who may not facilitate are refused before anything is read.
    const before = w.sync.snapshots
    expectStatus(await start(w.viewer, { scope: 'selection', selection: SELECTION }), 403)
    expect(w.sync.snapshots).toBe(before)
    expect((await w.api.db.query('SELECT 1 FROM vote_sessions')).rows).toEqual([])
  })
})

describe('RETRO-10: casting in a selection vote', () => {
  it('listed objects and the contents of listed frames take votes; the frames and anything else do not', async () => {
    await retro()
    const vid = (await startSelection(w.owner)).session.id
    for (const id of ['shape:w1', 'shape:wbox', 'shape:i1', 'shape:loose'])
      expectStatus(await cast(w.viewer, vid, id), 200)
    for (const id of ['shape:went', 'shape:p1', 'shape:other', 'shape:link', 'shape:later']) {
      const res = await cast(w.viewer, vid, id)
      expectStatus(res, 400)
      expect(codeOf(res), id).toBe('NOT_ELIGIBLE')
    }
    const s = await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`, undefined, REV)
    expect(json<WorkshopState>(s).vote?.myVotes).toEqual({
      'shape:w1': 1,
      'shape:wbox': 1,
      'shape:i1': 1,
      'shape:loose': 1,
    })
  })

  it('the type filter still applies inside the selection', async () => {
    await retro()
    const vid = (await startSelection(w.owner, SELECTION, { shapeTypes: ['note'] })).session.id
    expectStatus(await cast(w.editor, vid, 'shape:w2'), 200)
    expect(codeOf(await cast(w.editor, vid, 'shape:wbox'))).toBe('NOT_ELIGIBLE')
  })

  it('a note added to a listed frame after the start takes votes (the frame stands for its contents)', async () => {
    await retro()
    const vid = (await startSelection(w.owner)).session.id
    w.sync.add(w.boardId, note('w-late', 'shape:went'))
    w.clock.advance(5_000) // past the snapshot cache
    expectStatus(await cast(w.viewer, vid, 'shape:w-late'), 200)
  })
})

describe('RETRO-10: a web build from before 0024 (a stale tab, or the web before its deploy)', () => {
  it('sees a selection vote as a board vote it can parse, and its casts still follow the selection', async () => {
    await retro()
    const vid = (await startSelection(w.owner)).session.id
    const res = await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`)
    expectStatus(res, 200)
    const old = OldWorkshop.parse(res.json())
    expect(old.vote?.session).toEqual({ scope: 'board', frameId: null })
    expect(JSON.stringify(res.json())).not.toContain('shape:improve') // no list it cannot use
    expectStatus(await cast(w.viewer, vid, 'shape:w1', {}), 200)
    const outside = await cast(w.viewer, vid, 'shape:other', {})
    expectStatus(outside, 400)
    expect(codeOf(outside)).toBe('NOT_ELIGIBLE')
    // Every answer that carries the session is shaped the same way.
    for (const r of [
      await cast(w.viewer, vid, 'shape:i1', {}),
      await w.viewer.req('POST', `/api/votes/${vid}/done`, {}),
      await w.owner.req('POST', `/api/votes/${vid}/close`),
      await w.owner.req('POST', `/api/votes/${vid}/reveal`),
    ]) {
      expectStatus(r, 200)
      expect(json<{ session: { scope: string; selection?: unknown } }>(r).session).toMatchObject({
        scope: 'board',
        selection: null,
      })
    }
    const past = await w.viewer.req('GET', `/api/boards/${w.boardId}/votes`)
    expect(json<{ sessions: { scope: string }[] }>(past).sessions.map((s) => s.scope)).toEqual(['board'])
    const results = await w.viewer.req('GET', `/api/votes/${vid}/results`)
    expect(json<{ session: { scope: string } }>(results).session.scope).toBe('board')
    // The current build, on the same vote, still reads the selection.
    const now = await w.viewer.req('GET', `/api/votes/${vid}/results`, undefined, REV)
    expect(json<{ session: { scope: string; selection: string[] } }>(now).session).toMatchObject({
      scope: 'selection',
      selection: SELECTION,
    })
  })

  it('board and frame votes are answered as before, with or without the header', async () => {
    await retro()
    const res = await start(w.owner, { scope: 'frame', frameId: 'shape:went' }, {})
    expectStatus(res, 201)
    expect(json<WorkshopVoteState>(res).session).toMatchObject({ scope: 'frame', frameId: 'shape:went' })
    const s = await w.viewer.req('GET', `/api/boards/${w.boardId}/workshop`)
    expect(OldWorkshop.parse(s.json()).vote?.session).toEqual({ scope: 'frame', frameId: 'shape:went' })
  })
})

describe('RETRO-10 on the Excalidraw engine snapshot (lobby-elements)', () => {
  it('frames parent their elements through frameId; a bound label is never an object', async () => {
    w = await setupWorld()
    const el = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
      id,
      type,
      isDeleted: false,
      frameId: null,
      ...extra,
    })
    const elements = [
      el('went', 'frame'),
      el('n1', 'stickynote', { frameId: 'went' }),
      el('n1-label', 'text', { containerId: 'n1', frameId: 'went' }),
      el('loose', 'stickynote'),
      el('other', 'stickynote'),
    ]
    w.sync.snapshot = async () => {
      w.sync.snapshots++
      return { format: 'lobby-elements', schema: 1, clock: 3, elements, doc: {} } as never
    }
    const label = await start(w.owner, { scope: 'selection', selection: ['shape:n1-label'] })
    expectStatus(label, 400)
    const vid = (await startSelection(w.owner, ['shape:went', 'shape:loose'])).session.id
    expectStatus(await cast(w.viewer, vid, 'shape:n1'), 200)
    expectStatus(await cast(w.viewer, vid, 'shape:loose'), 200)
    expect(codeOf(await cast(w.viewer, vid, 'shape:other'))).toBe('NOT_ELIGIBLE')
    expect(codeOf(await cast(w.viewer, vid, 'shape:went'))).toBe('NOT_ELIGIBLE')
  })
})
