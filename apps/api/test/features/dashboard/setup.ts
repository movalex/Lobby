// Shared fixtures for the dashboard-share API tests: alice owns Dev Studio (first login), bob and
// carol are members, erin and frank are outsiders (removed from Dev Studio).

import { InvitationCreated } from '@draftroom/contracts'
import { expect } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

export interface World {
  api: TestApi
  events: EventHub
  published: { boardId: string; type: string; data: unknown }[]
  alice: Client
  bob: Client
  carol: Client
  erin: Client
  frank: Client
  /** A private Dev Studio board created (and owned) by bob. */
  board: string
}

export const DAY = 24 * 60 * 60 * 1000

export async function setupWorld(): Promise<World> {
  const events = new EventHub()
  const api = await createTestApi({ deps: { events } })
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const erin = await api.login('erin')
  const frank = await api.login('frank')
  for (const outsider of [erin, frank])
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      outsider.userId,
      DEV_STUDIO,
    ])
  const board = await createBoard(bob, DEV_STUDIO, 'Campaign review')
  const published: World['published'] = []
  // Record what reaches this board's stream (a subscriber like an open SSE connection would be).
  events.subscribe(board, (e) => published.push({ boardId: e.boardId, type: e.type, data: e.data }))
  return { api, events, published, alice, bob, carol, erin, frank, board }
}

export const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

export async function boardRole(c: Client, boardId: string): Promise<string | null> {
  const res = await c.req('GET', `/api/boards/${boardId}`)
  if (res.statusCode === 404) return null
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as { role: string }).role
}

export async function singleUseInvite(c: Client, boardId: string, role = 'viewer') {
  const res = await c.req('POST', `/api/boards/${boardId}/invitations`, { role })
  expect(res.statusCode, res.body).toBe(201)
  return InvitationCreated.parse(res.json())
}

export async function tableExists(api: TestApi, name: string): Promise<boolean> {
  const row = await api.db.one<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [name])
  return row.ok
}
