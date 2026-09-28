// Name-only guests, round-2 follow-ups (docs/WAVE3-CONTRACTS.md §2 guests):
// - the Share dialog's "pick someone from the workspace" list (GET /api/workspaces/:wid/members) never
//   offers name-only guests: adding one to another board is refused (GUEST_ONLY_THROUGH_LINKS);
// - a "keep sharing settings" duplicate never copies a name-only guest's grant (SEAM-03), so revoking
//   the link with removal ends their access everywhere;
// - "Recently deleted" is for editors with an account (SEAM-06).
import { ListDeletedResponse, WorkspaceMember } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { guestSweepSettings } from '../../../src/features/guests/index.ts'
import { DEV_STUDIO } from '../../helpers.ts'
import { createFakeSync, type FakeSync } from '../history/helpers.ts'
import {
  boardRole,
  errorCode,
  guestLink,
  guestSweeper,
  joinAsGuest,
  setupWorld,
  tokenOf,
  type World,
} from './support.ts'

let w: World
let sync: FakeSync
const sweepInterval = guestSweepSettings.intervalMs
beforeEach(async () => {
  guestSweepSettings.intervalMs = 60 * 60_000 // these tests run the sweep themselves
  sync = createFakeSync()
  w = await setupWorld({ sync })
})
afterEach(async () => {
  guestSweepSettings.intervalMs = sweepInterval
  await w.api.close()
})

describe('the workspace people picker', () => {
  it('never lists name-only guests (they join boards only through links); account guests stay', async () => {
    const sam = await joinAsGuest(w.api, (await guestLink(w.bob, w.board)).url, 'Sam')
    // Erin has an account and joined through a review link: a workspace guest who CAN be added.
    const link = await guestLink(w.bob, w.board, { allowGuests: false })
    expect((await w.erin.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)).statusCode).toBe(200)

    for (const who of [w.alice, w.bob]) {
      const res = await who.req('GET', `/api/workspaces/${DEV_STUDIO}/members`)
      expect(res.statusCode, res.body).toBe(200)
      const ids = z
        .object({ members: z.array(WorkspaceMember) })
        .parse(res.json())
        .members.map((m) => m.user.id)
      expect(ids).not.toContain(sam.userId)
      expect(ids).toContain(w.erin.userId)
      expect(ids).toContain(w.carol.userId)
    }
    // What picking them would do (the reason they are left out).
    const other = (
      (await w.bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'Other' })).json() as {
        id: string
      }
    ).id
    const put = await w.bob.req('PUT', `/api/boards/${other}/members/${sam.userId}`, { role: 'viewer' })
    expect(put.statusCode).toBe(409)
    expect(errorCode(put)).toBe('GUEST_ONLY_THROUGH_LINKS')
  })
})

describe('duplicate with "keep sharing settings" (SEAM-03)', () => {
  it('copies the people with an account, never a name-only guest; revoking the link then ends the guest’s access', async () => {
    const link = await guestLink(w.bob, w.board, { role: 'editor' })
    const wes = await joinAsGuest(w.api, link.url, 'Wes')
    expect(
      (await w.bob.req('PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(200)

    const dup = await w.bob.req('POST', `/api/boards/${w.board}/duplicate`, {
      title: 'Workshop v2',
      keepSharing: true,
    })
    expect(dup.statusCode, dup.body).toBe(201)
    const copy = (dup.json() as { board: { id: string } }).board.id
    const members = (
      (await w.bob.req('GET', `/api/boards/${copy}/members`)).json() as {
        members: { user: { id: string } }[]
      }
    ).members.map((m) => m.user.id)
    expect(members).toContain(w.carol.userId)
    expect(members).not.toContain(wes.userId)
    expect(await boardRole(wes, copy)).toBeNull()
    expect((await wes.req('POST', `/api/boards/${copy}/ticket`)).statusCode).toBe(404)

    // The workshop is over: revoke with removal. The guest's session ends with their last grant.
    const revoke = await w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/revoke`, {
      removeAccess: true,
    })
    expect(revoke.statusCode, revoke.body).toBe(200)
    const swept = await guestSweeper(w).run()
    expect(swept.signedOut).toContain(wes.userId)
    expect((await wes.req('GET', '/api/me')).statusCode).toBe(401)
  })
})

describe('"Recently deleted" (SEAM-06)', () => {
  it('editors with an account read it; a name-only guest editor gets 403 GUEST_ACCOUNT_REQUIRED (GET and HEAD)', async () => {
    sync.deletedList = {
      entries: [
        {
          shapeId: 'shape:old',
          type: 'note',
          label: 'Internal: client budget is 40k, pitch 65k',
          deletedAt: '2026-09-27T00:00:00.000Z',
          deletedBy: { id: w.bob.userId, name: 'Bob' },
          childCount: 0,
        },
      ],
      total: 1,
      limit: 2000,
    }
    const wes = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'editor' })).url, 'Wes')
    const vic = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'viewer' })).url, 'Vic')
    expect(await boardRole(wes, w.board)).toBe('editor')

    const byGuest = await wes.req('GET', `/api/boards/${w.board}/deleted`)
    expect(byGuest.statusCode, byGuest.body).toBe(403)
    expect(errorCode(byGuest)).toBe('GUEST_ACCOUNT_REQUIRED')
    expect(byGuest.body).not.toContain('budget')
    const head = await w.api.app.inject({
      method: 'HEAD',
      url: `/api/boards/${w.board}/deleted`,
      headers: { cookie: wes.cookie },
    })
    expect(head.statusCode).toBe(403)
    // A guest viewer: 403 as for any viewer.
    expect((await vic.req('GET', `/api/boards/${w.board}/deleted`)).statusCode).toBe(403)
    // Someone who cannot see the board at all: 404, whoever they are.
    expect((await w.carol.req('GET', `/api/boards/${w.board}/deleted`)).statusCode).toBe(404)

    // An editor with an account still reads it.
    expect(
      (await w.bob.req('PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'editor' }))
        .statusCode,
    ).toBe(200)
    const byEditor = await w.carol.req('GET', `/api/boards/${w.board}/deleted`)
    expect(byEditor.statusCode, byEditor.body).toBe(200)
    expect(ListDeletedResponse.parse(byEditor.json()).entries).toHaveLength(1)
  })
})
