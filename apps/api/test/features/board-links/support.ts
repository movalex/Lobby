// Shared setup for the links-between-boards API tests (wave N, WS7: N7-2 board cards, N7-4 backlinks). The sync
// server is search's fake (../search/support.ts), here as a wave N sync that answers `links` when asked; the
// search indexer is driven by the tests (passes and refreshes), as in the search tests.
//
// Dev Studio (alice owns it; bob and carol are members; erin is not a member, her own workspace is hers):
//   A  bob's private board, carol views it (the board the cards are on, and a guest link's board)
//   D  bob's private board, carol views it (a target carol may see; frame `frame-1` "Q3 goals")
//   B  bob's private board, carol has no grant (a target carol may not see)
//   C  bob's private board, carol views it, then it is trashed
// sam is a name-only guest who joined A through a review link.

import { BoardCardsAnswer } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import { type Client, createBoard, DEV_STUDIO } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest } from '../guests/support.ts'
import { type SearchWorld, searchWorld } from '../search/support.ts'

export interface LinksWorld extends SearchWorld {
  alice: Client
  bob: Client
  carol: Client
  erin: Client
  sam: GuestClient
  b: { A: string; B: string; C: string; D: string }
}

export const MISSING = 'b-missing00001'

export async function linksWorld(): Promise<LinksWorld> {
  const w = await searchWorld()
  w.sync.linksSupported = true
  const { api } = w
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  const b = {
    A: await createBoard(bob, DEV_STUDIO, 'Roadmap A'),
    B: await createBoard(bob, DEV_STUDIO, 'Secret B'),
    C: await createBoard(bob, DEV_STUDIO, 'Trashed C'),
    D: await createBoard(bob, DEV_STUDIO, 'Design D'),
  }
  for (const id of [b.A, b.C, b.D]) await grant(bob, id, carol.userId, 'viewer')
  expect((await bob.req('POST', `/api/boards/${b.C}/trash`)).statusCode).toBe(200)
  const sam = await joinAsGuest(api, (await guestLink(bob, b.A, { role: 'viewer' })).url, 'Sam')
  return { ...w, alice, bob, carol, erin, sam, b }
}

export async function grant(owner: Client, boardId: string, userId: string, role: string): Promise<void> {
  const res = await owner.req('PUT', `/api/boards/${boardId}/members/${userId}`, { role })
  expect(res.statusCode, res.body).toBe(200)
}

type Requester = { req: Client['req'] }

export const cardsUrl = (boardId: string, ids: readonly string[]) =>
  `/api/boards/${boardId}/board-cards?ids=${ids.map(encodeURIComponent).join(',')}`

export async function cardsRaw(
  c: Requester,
  boardId: string,
  ids: readonly string[],
): Promise<LightMyRequestResponse> {
  return c.req('GET', cardsUrl(boardId, ids))
}

/** A successful board-cards answer, parsed with the contract. */
export async function cards(
  c: Requester,
  boardId: string,
  ids: readonly string[],
): Promise<BoardCardsAnswer> {
  const res = await cardsRaw(c, boardId, ids)
  expect(res.statusCode, res.body).toBe(200)
  return BoardCardsAnswer.parse(res.json())
}

/** Every query the api runs from now on (query, one and maybeOne), with its parameters, until `stop()`. */
export function spyQueries(w: SearchWorld) {
  const db = w.api.db as unknown as Record<'query' | 'one' | 'maybeOne', (...a: unknown[]) => unknown>
  const seen: { sql: string; params: unknown[] }[] = []
  const saved = { query: db.query, one: db.one, maybeOne: db.maybeOne }
  for (const k of ['query', 'one', 'maybeOne'] as const) {
    const orig = saved[k]
    db[k] = (sql: unknown, params?: unknown) => {
      seen.push({ sql: String(sql), params: Array.isArray(params) ? params : [] })
      return orig.call(w.api.db, sql, params)
    }
  }
  return {
    seen,
    /** The queries whose parameters name `value` (arrays of parameters included). */
    naming: (value: string) =>
      seen.filter((q) => q.params.some((p) => p === value || (Array.isArray(p) && p.includes(value)))),
    stop() {
      Object.assign(db, saved)
    },
  }
}
