// Shared world and helpers of the J2 access-lifecycle tests (wave J: the end of access; the 2026-10-05
// security audit's links-guests and authz lenses). alice owns Dev Studio (first login); bob is a member and
// a creator and owns `board` (private); carol and dave are members; erin and frank are outsiders with
// accounts. The fake sync server has content for `board`, so it can be duplicated.
//
// PGlite (one connection): decisions and end states. The interleavings with the paths that give access are
// in access-lifecycle.pg.test.ts (a real Postgres: DRAFTROOM_TEST_DATABASE_URL).

import { ReviewLinkCreated } from '@draftroom/contracts'
import { afterEach, beforeEach, expect } from 'vitest'
import { createSessionStore } from '../src/auth/session.ts'
import { EventHub } from '../src/events/hub.ts'
import type { FeatureContext } from '../src/features/context.ts'
import { sweepExpiredReviewLinks } from '../src/features/dashboard/review-links.ts'
import { guestSweepSettings } from '../src/features/guests/index.ts'
import { sweepGuests } from '../src/features/guests/sweep.ts'
import type { AccessChange } from '../src/notifier.ts'
import { cookieOf, freshIp, type GuestClient, joinRequest } from './features/guests/support.ts'
import { baseRecords, createFakeSync, noteRec } from './features/history/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from './helpers.ts'

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

export interface World {
  api: TestApi
  events: EventHub
  alice: Client // owns Dev Studio (first login)
  bob: Client // a member, a creator: owns `board`
  carol: Client // a member
  dave: Client // a member
  erin: Client // an outsider with an account
  frank: Client // an outsider with an account
  /** A private Dev Studio board owned by bob (the fake sync has content for it, for duplicates). */
  board: string
}

/** The current test's world (set by useWorld's beforeEach). */
export let w: World
const cleanup: (() => Promise<void>)[] = []

async function setupWorld(): Promise<World> {
  const events = new EventHub()
  const sync = createFakeSync()
  const api = await createTestApi({ deps: { events, syncInternal: sync } })
  cleanup.push(() => api.close())
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const dave = await api.login('dave')
  const erin = await api.login('erin')
  const frank = await api.login('frank')
  for (const outsider of [erin, frank])
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      outsider.userId,
      DEV_STUDIO,
    ])
  const board = await createBoard(bob, DEV_STUDIO, 'Client review')
  sync.setBoard(board, [...baseRecords(), noteRec('n1', 'live content')])
  api.notifications.length = 0
  return { api, events, alice, bob, carol, dave, erin, frank, board }
}

/** Registers the per-test world (a fresh app, people and board) and its cleanup. */
export function useWorld(): void {
  beforeEach(async () => {
    // these tests run the guest sweep themselves; the app's own timer must not race them
    guestSweepSettings.intervalMs = 60 * 60 * 1000
    w = await setupWorld()
  })
  afterEach(async () => {
    for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
  })
}

export const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)
export const codeOf = (res: { json(): unknown }) => (res.json() as { error?: { code?: string } }).error?.code

export async function link(
  c: Client,
  body: {
    role: 'viewer' | 'commenter' | 'editor'
    allowGuests?: boolean
    expiresInHours?: number
    expiresInDays?: number
  },
  boardId = w.board,
) {
  const res = await c.req('POST', `/api/boards/${boardId}/review-links`, body)
  expect(res.statusCode, res.body).toBe(201)
  return ReviewLinkCreated.parse(res.json())
}
export const accept = (c: Pick<Client, 'req'>, url: string) =>
  c.req('POST', `/api/invitations/${tokenOf(url)}/accept`)
export const revoke = (c: Client, id: string, removeAccess = true, boardId = w.board) =>
  c.req('POST', `/api/boards/${boardId}/review-links/${id}/revoke`, { removeAccess })
export const put = (c: Client, uid: string, role: string, boardId = w.board) =>
  c.req('PUT', `/api/boards/${boardId}/members/${uid}`, { role })
export const del = (c: Client, uid: string, boardId = w.board) =>
  c.req('DELETE', `/api/boards/${boardId}/members/${uid}`)
export const removeFromWorkspace = (c: Client, uid: string) =>
  c.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${uid}`)

export async function roleOn(c: Pick<Client, 'req'>, boardId = w.board): Promise<string | null> {
  const res = await c.req('GET', `/api/boards/${boardId}`)
  if (res.statusCode === 404) return null
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as { role: string }).role
}
export const grantOf = async (userId: string, boardId = w.board) =>
  (
    await w.api.db.maybeOne<{ role: string }>(
      'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
      [boardId, userId],
    )
  )?.role ?? null

const fakeCtx = (extra: Record<string, unknown> = {}) =>
  ({
    db: w.api.db,
    now: w.api.clock.now,
    notifier: {
      accessChanged: (c: AccessChange) => void w.api.notifications.push({ ...c }),
      drain: async () => {},
    },
    events: w.events,
    ...extra,
  }) as unknown as FeatureContext
/** The review-link expiry sweeper with the test clock (what its 5 s timer runs). */
export const sweepLinks = () => sweepExpiredReviewLinks(fakeCtx())
/** One guest sweep with the test clock (what its timer runs). */
export function guestSweep() {
  const sessions = createSessionStore({ db: w.api.db, secureCookies: false, now: w.api.clock.now })
  return sweepGuests(fakeCtx({ sessions }))
}

/** A signed-in guest joins one more guest link (their cookie): the same guest user, one more redemption. */
export async function joinAgain(g: GuestClient, url: string) {
  const res = await joinRequest(w.api, tokenOf(url), {}, { cookie: g.cookie, ip: freshIp() })
  expect(res.statusCode, res.body).toBe(200)
  // a longer link replaces the session: follow the new cookie
  const next = cookieOf(res)
  if (next) g.cookie = `dr_session=${next.value}`
  const cookie = g.cookie
  g.req = (method, url2, body) =>
    w.api.app.inject({
      method,
      url: url2,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: { origin: ORIGIN, cookie },
    })
}

/** The person's latest access request for the board. */
export const requestOf = async (userId: string, boardId = w.board) =>
  w.api.db.maybeOne<{ id: string; status: string; decided_by: string | null }>(
    'SELECT id, status, decided_by FROM access_requests WHERE board_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1',
    [boardId, userId],
  )
export const ask = (c: Client, role: string, boardId = w.board) =>
  c.req('POST', `/api/boards/${boardId}/access-requests`, { role })
