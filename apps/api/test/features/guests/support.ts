// Shared fixtures for the name-only guest API tests (docs/WAVE3-CONTRACTS.md §2 guests).
// alice owns Dev Studio (first login); bob is a member and owns `board` (private); carol is a member
// with no access to it; erin is an outsider with an account.

import { GuestJoined, ReviewLinkCreated } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import { createSessionStore } from '../../../src/auth/session.ts'
import { EventHub } from '../../../src/events/hub.ts'
import type { FeatureContext } from '../../../src/features/context.ts'
import { sweepExpiredReviewLinks } from '../../../src/features/dashboard/review-links.ts'
import { sweepGuests } from '../../../src/features/guests/sweep.ts'
import type { AccessChange } from '../../../src/notifier.ts'
import type { SyncInternalClient } from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../../helpers.ts'

export interface World {
  api: TestApi
  events: EventHub
  alice: Client
  bob: Client
  carol: Client
  erin: Client
  /** A private Dev Studio board owned by bob. */
  board: string
}

/**
 * A fresh app and its people. The app's own guest sweeper runs at `guestSweepSettings.intervalMs`:
 * tests that run the sweep themselves (guestSweeper below) raise it first.
 */
export async function setupWorld(
  opts: { events?: EventHub; sync?: SyncInternalClient } = {},
): Promise<World> {
  const events = opts.events ?? new EventHub()
  const api = await createTestApi({
    deps: { events, ...(opts.sync ? { syncInternal: opts.sync } : {}) },
  })
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  const board = await createBoard(bob, DEV_STUDIO, 'Client review')
  return { api, events, alice, bob, carol, erin, board }
}

export const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

/** A review (viewer/commenter) or workshop (editor) link; guests allowed unless `allowGuests: false`. */
export async function guestLink(
  c: Client,
  boardId: string,
  body: { role?: 'viewer' | 'commenter' | 'editor'; allowGuests?: boolean; maxUses?: number } = {},
) {
  const res = await c.req('POST', `/api/boards/${boardId}/review-links`, { allowGuests: true, ...body })
  expect(res.statusCode, res.body).toBe(201)
  return ReviewLinkCreated.parse(res.json())
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** A browser without an account that joined as a guest: its cookie and a request helper. */
export interface GuestClient {
  cookie: string
  userId: string
  joined: GuestJoined
  req(method: Method, url: string, body?: unknown): Promise<LightMyRequestResponse>
}

const cookieOf = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === 'dr_session')

/** POST /api/invitations/:token/guest, optionally from a given client IP or with a cookie. */
export function joinRequest(
  api: TestApi,
  token: string,
  body: unknown,
  opts: { ip?: string; cookie?: string; origin?: string | null } = {},
) {
  const headers: Record<string, string> = {}
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN
  if (opts.cookie) headers.cookie = opts.cookie
  return api.app.inject({
    method: 'POST',
    url: `/api/invitations/${token}/guest`,
    ...(body === undefined ? {} : { payload: body as object }),
    headers,
    ...(opts.ip ? { remoteAddress: opts.ip } : {}),
  })
}

let ipSeq = 0
/** A fresh client address per guest, so the per-IP creation limit stays out of unrelated tests. */
export const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`

export function clientFor(api: TestApi, cookie: string, userId: string, joined: GuestJoined): GuestClient {
  return {
    cookie,
    userId,
    joined,
    req: (method, url, body) =>
      api.app.inject({
        method,
        url,
        ...(body === undefined ? {} : { payload: body as object }),
        headers: { origin: ORIGIN, cookie },
      }),
  }
}

/** Joins `url` as a new guest called `name` (from a fresh IP) and returns the guest's client. */
export async function joinAsGuest(api: TestApi, url: string, name = 'Sam'): Promise<GuestClient> {
  const res = await joinRequest(api, tokenOf(url), { name }, { ip: freshIp() })
  expect(res.statusCode, res.body).toBe(201)
  const cookie = cookieOf(res)
  if (!cookie) throw new Error('no session cookie')
  const joined = GuestJoined.parse(res.json())
  return clientFor(api, `dr_session=${cookie.value}`, joined.user.id, joined)
}

export { cookieOf }

/** The review-link expiry sweeper with the test clock (what its timer runs). */
export const sweepLinks = (w: World) =>
  sweepExpiredReviewLinks({
    db: w.api.db,
    now: w.api.clock.now,
    notifier: {
      accessChanged: (c: AccessChange) => void w.api.notifications.push({ ...c }),
      drain: async () => {},
    },
    events: w.events,
  } as unknown as FeatureContext)

/**
 * One guest sweep with the test clock. `revoked` collects the session ids it announced (the app's
 * own store would end their event streams).
 */
export function guestSweeper(w: World) {
  const sessions = createSessionStore({ db: w.api.db, secureCookies: false, now: w.api.clock.now })
  const revoked: string[] = []
  sessions.onRevoked((ids) => void revoked.push(...ids))
  const run = () =>
    sweepGuests({
      db: w.api.db,
      now: w.api.clock.now,
      sessions,
      notifier: {
        accessChanged: (c: AccessChange) => void w.api.notifications.push({ ...c }),
        drain: async () => {},
      },
      events: w.events,
    } as unknown as FeatureContext)
  return { run, revoked }
}

export async function boardRole(c: { req: Client['req'] }, boardId: string): Promise<string | null> {
  const res = await c.req('GET', `/api/boards/${boardId}`)
  if (res.statusCode === 404) return null
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as { role: string }).role
}

export const errorCode = (res: LightMyRequestResponse) =>
  (res.json() as { error?: { code?: string } }).error?.code
