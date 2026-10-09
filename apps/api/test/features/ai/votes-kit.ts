// Wave L (W1): dot votes through the real routes for the AI tests (the recap's top voted list, L1-2; the
// vote-weighted action items, L1-7). alice (the Dev Studio owner) facilitates; anyone may cast.

import { expect } from 'vitest'
import type { Client } from '../../helpers.ts'

export async function startVote(alice: Client, board: string): Promise<string> {
  const res = await alice.req('POST', `/api/boards/${board}/votes`, {
    votesPerPerson: 5,
    onePerObject: false,
    scope: 'board',
  })
  expect(res.statusCode, res.body).toBe(201)
  return (res.json() as { session: { id: string } }).session.id
}

export async function cast(c: Client, vote: string, shapeId: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    const res = await c.req('POST', `/api/votes/${vote}/cast`, { shapeId, delta: 1 })
    expect(res.statusCode, res.body).toBe(200)
  }
}

export async function closeVote(alice: Client, vote: string): Promise<void> {
  const res = await alice.req('POST', `/api/votes/${vote}/close`)
  expect(res.statusCode, res.body).toBe(200)
}

export async function revealVote(alice: Client, vote: string): Promise<void> {
  const res = await alice.req('POST', `/api/votes/${vote}/reveal`)
  expect(res.statusCode, res.body).toBe(200)
}
