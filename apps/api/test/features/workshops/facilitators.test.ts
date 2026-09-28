// Who facilitates a workshop (final review R3): the timer, votes, "Gather everyone" and other people's
// hands are for editors with an account. A name-only guest on a workshop (editor) link takes part
// (votes, "I'm done", reactions, their own hand) but gets 403 GUEST_ACCOUNT_REQUIRED for every
// facilitator control, after the board checks. (Private brainstorms: private-notes-access.test.ts.)
import type { WorkshopVoteState } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { expectStatus, json, note, setupWorld, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.api.close()
})

const errCode = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code

async function world() {
  w = await setupWorld()
  w.sync.add(w.boardId, note('n1'), note('n2'))
  const link = await guestLink(w.owner, w.boardId, { role: 'editor' })
  const guest = await joinAsGuest(w.api, link.url, 'Jordan')
  return { guest }
}

describe('facilitator controls (final review R3)', () => {
  it('a guest editor gets 403 for the timer, starting a vote, summon and other people’s hands', async () => {
    const { guest } = await world()
    const b = `/api/boards/${w.boardId}`
    const refusals = [
      await guest.req('POST', `${b}/timer`, { action: 'start', durationMs: 60_000 }),
      await guest.req('POST', `${b}/votes`, {
        votesPerPerson: 3,
        onePerObject: false,
        scope: 'board',
      }),
      await guest.req('POST', `${b}/summon`, {}),
      await guest.req('POST', `${b}/hands/clear`),
      await guest.req('POST', `${b}/hands/${w.editor.userId}/lower`),
    ]
    for (const res of refusals) {
      expectStatus(res, 403)
      expect(errCode(res)).toBe('GUEST_ACCOUNT_REQUIRED')
    }
    // Nothing happened: no timer, no vote.
    const state = json<{ timer: unknown; vote: unknown }>(await w.owner.req('GET', `${b}/workshop`))
    expect(state).toMatchObject({ timer: null, vote: null })
    // An account editor may.
    expectStatus(await w.editor.req('POST', `${b}/timer`, { action: 'start', durationMs: 60_000 }), 200)
    expectStatus(await w.editor.req('POST', `${b}/summon`, {}), 202)
  })

  it('a guest cannot pause, extend, close or reveal someone’s vote or timer, but takes part in it', async () => {
    const { guest } = await world()
    const b = `/api/boards/${w.boardId}`
    expectStatus(await w.owner.req('POST', `${b}/timer`, { action: 'start', durationMs: 60_000 }), 200)
    const pause = await guest.req('POST', `${b}/timer`, { action: 'pause' })
    expectStatus(pause, 403)
    const started = await w.owner.req('POST', `${b}/votes`, {
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
      durationMs: 5 * 60_000,
    })
    expectStatus(started, 201)
    const vid = json<WorkshopVoteState>(started).session.id
    for (const [path, body] of [
      ['extend', { addMs: 60_000 }],
      ['close', undefined],
      ['reveal', undefined],
    ] as const) {
      const res = await guest.req('POST', `/api/votes/${vid}/${path}`, body)
      expectStatus(res, 403)
      expect(errCode(res)).toBe('GUEST_ACCOUNT_REQUIRED')
    }
    // Participant controls stay theirs.
    expectStatus(await guest.req('POST', `/api/votes/${vid}/cast`, { shapeId: 'shape:n1', delta: 1 }), 200)
    expectStatus(await guest.req('POST', `/api/votes/${vid}/done`, { done: true }), 200)
    expectStatus(await guest.req('POST', `${b}/reactions`, { emoji: '👏' }), 202)
    expectStatus(await guest.req('POST', `${b}/hand`, { raised: true }), 200)
    expectStatus(await guest.req('POST', `${b}/hands/${guest.userId}/lower`), 200)
    // The timer still runs, and the facilitator ends the vote.
    const state = json<{ timer: { status: string } }>(await w.owner.req('GET', `${b}/workshop`))
    expect(state.timer.status).toBe('running')
    expectStatus(await w.owner.req('POST', `/api/votes/${vid}/reveal`), 200)
  })

  it('a board the guest cannot reach stays a 404, before the account check', async () => {
    const { guest } = await world()
    const otherId = await createBoard(w.owner, DEV_STUDIO, 'Other')
    for (const res of [
      await guest.req('POST', `/api/boards/${otherId}/timer`, { action: 'start', durationMs: 60_000 }),
      await guest.req('POST', `/api/boards/${otherId}/summon`, {}),
    ])
      expectStatus(res, 404)
  })
})
