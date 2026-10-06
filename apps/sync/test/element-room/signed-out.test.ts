// RT-01 (realtime audit, wave J3), through the real server process: a person whose sign-in ended ("Sign
// out everywhere", a ban or a deleted account: the api ends every session; an expiry) loses their open
// board sockets, 4099 NOT_AUTHENTICATED (the CLOSING notice first), on every board, and nobody else does.
// - the push: POST /internal/access-changed `{ userId }` re-checks that person on every open board now;
// - the periodic round applies the same rule (an expiry has no push);
// - after a new sign-in, the sockets of the new session stay (and new ones are admitted), while a socket
//   whose ticket predates every live session of the person is sent to reconnect (4000: its new ticket
//   needs a live session, so only a browser that signed in again comes back);
// - an api from before J3 (no `signedInSince` in its answer) changes nothing.

import { describe, expect, it } from 'vitest'
import { callInternal, mintTicket } from '../harness/tickets.ts'
import type { RawClient } from './support/client.ts'
import { rect } from './support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

const pushUser = (st: ElementStack, body: unknown) =>
  callInternal(st.server.url, 'POST', '/internal/access-changed', { body })

/** The CLOSING notice (CONTRACTS_REV 9) this client got before its terminal close, if any. */
const closingDetail = (c: RawClient) =>
  c
    .of('notice')
    .filter((n) => n.code === 'CLOSING')
    .map((n) => n.detail)

const stillOpen = async (c: RawClient, ms = 600) => {
  await new Promise((r) => setTimeout(r, ms))
  expect(c.closeCode, `${c.user} (${c.tab}) is still connected`).toBeNull()
}

describe('RT-01: an ended sign-in closes the person’s board sockets', () => {
  it('the push closes every socket of that person on every board (4099 NOT_AUTHENTICATED), and only theirs', async () => {
    // no periodic round during the test: only the push can close anything
    const st = await h.stack({ env: { ACCESS_RECHECK_MS: '600000' } })
    const [b1, b2] = [newBoardId(), newBoardId()]
    for (const [b, u] of [
      [b1, 'alice'],
      [b2, 'alice'],
      [b1, 'bob'],
    ] as const)
      st.api.setRole(b, u, 'editor')
    st.api.setSignedInSince('bob', Date.now() - 3_600_000)
    const a1 = await st.client({ boardId: b1, user: 'alice', tab: 'a-1' })
    const a2 = await st.client({ boardId: b2, user: 'alice', tab: 'a-2' })
    const bob = await st.client({ boardId: b1, user: 'bob' })
    await a1.create([rect('before')])

    // "Sign out everywhere": the api has ended every session of alice, then tells this server
    st.api.setSignedInSince('alice', null)
    const res = await pushUser(st, { userId: 'alice' })
    expect(res.status).toBe(204)
    for (const c of [a1, a2]) {
      expect(await c.untilClosed(10_000)).toEqual({ code: 4099, reason: 'NOT_AUTHENTICATED' })
      expect(closingDetail(c)).toEqual(['NOT_AUTHENTICATED'])
    }
    // bob, on the same board, is untouched and still writes
    await stillOpen(bob)
    expect((await bob.create([rect('bob-after')])).r[0]).toMatchObject({ ok: true })
    // nothing alice had written is lost
    expect((await st.snapshot(b1)).elements.map((e) => e.id)).toEqual(
      expect.arrayContaining(['before', 'bob-after']),
    )
    expect(st.server.logs()).toMatch(/\[access\] signed out: closing a session on board/)
  })

  it('after a new sign-in: the new session’s sockets stay and new ones are admitted; a socket of the ended session is sent to reconnect', async () => {
    const st = await h.stack({ env: { ACCESS_RECHECK_MS: '600000' } })
    const b = newBoardId()
    st.api.setRole(b, 'alice', 'editor')
    const t = Date.now()
    // a socket from before "Sign out everywhere" (its ticket was issued 30 s ago, still within its 60 s)
    const old = await st.client({
      boardId: b,
      user: 'alice',
      tab: 'old-device',
      ticket: mintTicket(b, 'alice', 'editor', { now: t - 30_000 }),
    })
    // alice signed out everywhere 20 s ago and signed in again 10 s ago: her oldest live session is that one
    st.api.setSignedInSince('alice', t - 10_000)
    const fresh = await st.client({ boardId: b, user: 'alice', tab: 'new-session' })
    expect((await pushUser(st, { userId: 'alice' })).status).toBe(204)
    // 4000: its reconnect needs a new ticket, which only a live session gets (this browser's, if it
    // signed in again; otherwise a 401, and the web shows the sign-in page)
    expect(await old.untilClosed(10_000)).toEqual({ code: 4000, reason: 'RECONNECT' })
    await stillOpen(fresh)
    expect((await fresh.create([rect('after-sign-in')])).r[0]).toMatchObject({ ok: true })

    // a reconnect right after the push (its admission re-checks the person): admitted and kept
    const again = await st.client({ boardId: b, user: 'alice', tab: 'reconnect' })
    await stillOpen(again)
    expect((await again.create([rect('reconnected')])).r[0]).toMatchObject({ ok: true })
    // and a ticket the ended session got just before the end, presented now, is sent away on admission
    // (a socket only: the re-check can close it before its welcome would come)
    const late = await st.socket({
      boardId: b,
      user: 'alice',
      tab: 'late-old-ticket',
      ticket: mintTicket(b, 'alice', 'editor', { now: t - 25_000 }),
    })
    expect(await late.untilClosed(10_000)).toEqual({ code: 4000, reason: 'RECONNECT' })
    expect(st.server.logs()).toContain('[access] sign-in ended: closing a session on board')
    await stillOpen(fresh, 100)
  })

  it('the periodic round: an expired sign-in closes too (no push); lost access stays FORBIDDEN', async () => {
    const st = await h.stack({ env: { ACCESS_RECHECK_MS: '200' } })
    const b = newBoardId()
    st.api.setRole(b, 'alice', 'editor')
    st.api.setRole(b, 'bob', 'editor')
    st.api.setRole(b, 'carol', 'editor')
    for (const u of ['alice', 'bob', 'carol']) st.api.setSignedInSince(u, Date.now() - 60_000)
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    const carol = await st.client({ boardId: b, user: 'carol' })
    await stillOpen(a, 700) // a few rounds with live sessions: nothing happens
    // alice's last session expired
    st.api.setSignedInSince('alice', null)
    expect(await a.untilClosed(10_000)).toEqual({ code: 4099, reason: 'NOT_AUTHENTICATED' })
    // bob lost the board AND has no session: access lost wins (the web purges the board's unsent edits)
    st.api.setSignedInSince('bob', null)
    st.api.setRole(b, 'bob', null)
    expect(await bob.untilClosed(10_000)).toEqual({ code: 4099, reason: 'FORBIDDEN' })
    await stillOpen(carol)
  })

  it('an api from before J3 (no signedInSince) closes nothing; malformed pushes are refused', async () => {
    const st = await h.stack({ env: { ACCESS_RECHECK_MS: '200' } })
    const b = newBoardId()
    st.api.setRole(b, 'alice', 'editor')
    const a = await st.client({
      boardId: b,
      user: 'alice',
      ticket: mintTicket(b, 'alice', 'editor', { now: Date.now() - 50_000 }),
    })
    expect((await pushUser(st, { userId: 'alice' })).status).toBe(204)
    await stillOpen(a, 800)
    for (const body of [{}, { userId: '' }, { userId: 'x'.repeat(129) }, { userId: 7 }, { boardId: 'Bad!' }])
      expect((await pushUser(st, body)).status, JSON.stringify(body)).toBe(400)
    await stillOpen(a, 100)
  })
})
