// Wave M (M7-1, CAP-SYNC-RECHECK), through the real server process: the periodic access round is ONE
// POST /internal/access-many per round (no GET per pair), and it still closes a revoked person (4099 FORBIDDEN)
// and an ended sign-in (4099 NOT_AUTHENTICATED) within a round, and nobody else. The stale pair: against an api
// from before wave M (the 4e4a549 api has no such route: its web-Origin check answers the POST 403), the round falls back to the per-pair route and
// still revokes, and the batch is not asked again within the hour. The unit tests are src/access-batch.test.ts.

import { describe, expect, it } from 'vitest'
import { callInternal } from '../harness/tickets.ts'
import type { RawClient } from './support/client.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

/** Contract-shaped user ids (the batch takes `usr_` ids; tests' plain names go per pair). */
const ALICE = 'usr_alice0000001'
const BOB = 'usr_bob000000001'
const CAROL = 'usr_carol0000001'

const stillOpen = async (c: RawClient, ms = 600) => {
  await new Promise((r) => setTimeout(r, ms))
  expect(c.closeCode, `${c.user} (${c.tab}) is still connected`).toBeNull()
}

describe('M7-1: the batched access round in the real server', () => {
  it('one batched call per round and no per-pair call; a revocation and an ended sign-in close within a round', async () => {
    const st = await h.stack({ env: { ACCESS_RECHECK_MS: '200' } })
    st.api.accessMany = true
    const [b1, b2] = [newBoardId(), newBoardId()]
    for (const [b, u] of [
      [b1, ALICE],
      [b1, BOB],
      [b2, ALICE],
      [b2, CAROL],
    ] as const)
      st.api.setRole(b, u, 'editor')
    for (const u of [ALICE, BOB, CAROL]) st.api.setSignedInSince(u, Date.now() - 60_000)
    const a1 = await st.client({ boardId: b1, user: ALICE, tab: 'a1' })
    const a2 = await st.client({ boardId: b2, user: ALICE, tab: 'a2' })
    const bob = await st.client({ boardId: b1, user: BOB })
    const carol = await st.client({ boardId: b2, user: CAROL })
    await stillOpen(a1, 900) // several rounds with every pair answered: nothing happens
    const rounds = st.api.accessManyCalls.filter((c) => c.length === 4)
    expect(rounds.length).toBeGreaterThanOrEqual(2)
    for (const c of rounds)
      expect([...c].sort()).toEqual(
        [`${b1}/${ALICE}`, `${b1}/${BOB}`, `${b2}/${ALICE}`, `${b2}/${CAROL}`].sort(),
      )
    expect(st.api.accessCalls).toEqual([]) // never one GET per pair

    // bob loses the board: closed FORBIDDEN by the next round (no push)
    st.api.setRole(b1, BOB, null)
    expect(await bob.untilClosed(10_000)).toEqual({ code: 4099, reason: 'FORBIDDEN' })
    // carol's last session ends (an expiry: no push either): NOT_AUTHENTICATED
    st.api.setSignedInSince(CAROL, null)
    expect(await carol.untilClosed(10_000)).toEqual({ code: 4099, reason: 'NOT_AUTHENTICATED' })
    // alice keeps both boards, and still writes
    await stillOpen(a1)
    await stillOpen(a2, 0)
    expect((await a1.create([rect('after')])).r[0]).toMatchObject({ ok: true })
    expect(st.api.accessCalls).toEqual([])
    expect(st.server.logs()).toMatch(/\[access\] revoked: closing a session on board/)
  })

  it('a push (POST /internal/access-changed) is still checked at once, per pair', async () => {
    const st = await h.stack({ env: { ACCESS_RECHECK_MS: '600000' } })
    st.api.accessMany = true
    const b = newBoardId()
    st.api.setRole(b, ALICE, 'editor')
    const a = await st.client({ boardId: b, user: ALICE })
    st.api.setRole(b, ALICE, null)
    const res = await callInternal(st.server.url, 'POST', '/internal/access-changed', {
      body: { boardId: b, userId: ALICE },
    })
    expect(res.status).toBe(204)
    expect(await a.untilClosed(10_000)).toEqual({ code: 4099, reason: 'FORBIDDEN' })
    expect(st.api.accessCalls).toEqual([`${b}/${ALICE}`])
    expect(st.api.accessManyCalls).toEqual([])
  })
})

describe('stale pair: this sync against an api from before wave M (403 on the batch route)', () => {
  it('falls back to the per-pair route for the round and still revokes; the batch is probed once, not every round', async () => {
    const st = await h.stack({ env: { ACCESS_RECHECK_MS: '200' } })
    expect(st.api.accessMany).toBe(false) // the fake answers the batch route 403, as the 4e4a549 api does
    const b = newBoardId()
    st.api.setRole(b, ALICE, 'editor')
    st.api.setRole(b, BOB, 'editor')
    const a = await st.client({ boardId: b, user: ALICE })
    const bob = await st.client({ boardId: b, user: BOB })
    await stillOpen(a, 900)
    expect(st.api.accessManyCalls).toHaveLength(1)
    expect(st.api.accessCalls.filter((c) => c === `${b}/${ALICE}`).length).toBeGreaterThanOrEqual(2)
    st.api.setRole(b, BOB, null)
    expect(await bob.untilClosed(10_000)).toEqual({ code: 4099, reason: 'FORBIDDEN' })
    await stillOpen(a)
    expect(st.api.accessManyCalls).toHaveLength(1)
    expect(st.server.logs()).toContain('[access] the api has no batched access check (an older api)')
  })
})
