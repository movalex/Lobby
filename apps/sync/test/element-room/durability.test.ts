// §6.2 `durability` and the server half of B4 D3 and D4, through the real server process:
//  - D3: SIGKILL during group commits (a stream of pushes the drain takes up to 64 at a time), 3 rounds:
//    every push that was acked is on disk after the restart (0 acked-but-missing);
//  - SIGINT: a graceful stop keeps every acked push;
//  - D4: an injected COMMIT failure answers the batch UNAVAILABLE, reopens the board file and closes every
//    session with 4000 RECONNECT; nothing acked is lost and the retried push lands.

import { describe, expect, it } from 'vitest'
import type { RawClient } from './support/client.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Streams `pushes` pushes of `per` creates each; returns the ids of every acked op. */
function stream(c: RawClient, tag: string, pushes: number, per: number) {
  const acked = new Set<string>()
  const all: Promise<unknown>[] = []
  for (let k = 0; k < pushes; k++) {
    const ops = Array.from({ length: per }, (_, j) => ({
      k: 'c',
      el: rect(`${tag}-${k}-${j}`, { x: k, y: j }),
    }))
    const { ack } = c.pushNow(ops)
    all.push(
      ack.then(
        (a) => {
          for (const r of a.r) if (r.ok) acked.add(r.id)
        },
        () => {},
      ),
    )
  }
  return { acked, all }
}

describe('durability', () => {
  it('D3: 3 SIGKILLs during group commits: 0 acked-but-missing', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const report: { round: number; acked: number; stored: number; missing: number }[] = []
    for (let round = 1; round <= 3; round++) {
      const c = await st.client({ boardId: b, user: `writer${round}` })
      const { acked } = stream(c, `r${round}`, 300, 5)
      // kill mid-stream, once some batches have committed
      await c.until(() => acked.size >= 64 * 5, 'first batches acked', 30_000)
      await st.server.kill('SIGKILL')
      const ackedAtKill = new Set(acked)
      await st.server.restart()
      const snap = await st.snapshot(b)
      const stored = new Set(snap.elements.map((e) => e.id))
      const missing = [...ackedAtKill].filter((id) => !stored.has(id))
      report.push({ round, acked: ackedAtKill.size, stored: stored.size, missing: missing.length })
      expect(missing).toEqual([])
    }
    // every round killed inside the stream: not everything was acked
    for (const r of report) expect(r.acked).toBeLessThan(300 * 5)
    console.log('[D3]', JSON.stringify(report))
  })

  it('SIGINT: a graceful stop keeps every acked push', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const c = await st.client({ boardId: b, user: 'writer' })
    const { acked } = stream(c, 'g', 100, 5)
    await c.until(() => acked.size >= 50, 'some acks')
    await st.server.kill('SIGINT')
    const ackedAtStop = new Set(acked)
    await st.server.restart()
    const stored = new Set((await st.snapshot(b)).elements.map((e) => e.id))
    expect([...ackedAtStop].filter((id) => !stored.has(id))).toEqual([])
  })

  it('D4: an injected COMMIT failure: UNAVAILABLE, 4000 RECONNECT, nothing lost, the retry lands', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    await a.create([rect('kept1'), rect('kept2')])
    const before = await st.snapshot(b)
    await st.failCommit(b, 1)
    const failed = await a.pushNow([{ k: 'c', el: rect('lost1') }]).ack
    expect(failed.r[0]).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
    expect(await a.untilClosed()).toMatchObject({ code: 4000, reason: 'RECONNECT' })
    expect(await bob.untilClosed()).toMatchObject({ code: 4000, reason: 'RECONNECT' })
    const after = await st.snapshot(b)
    expect(after).toEqual(before)
    // the client resyncs from since and retries
    const a2 = await st.client({
      boardId: b,
      user: 'alice',
      since: before.clock,
      epoch: before.epoch,
      confirmed: a.confirmed,
    })
    expect(a2.welcome?.reset).toBe(false)
    const retry = await a2.push([{ k: 'c', el: rect('lost1') }])
    expect(retry.r[0]).toMatchObject({ ok: true })
    const s = await st.snapshot(b)
    expect(s.elements.map((e) => e.id).sort()).toEqual(['kept1', 'kept2', 'lost1'])
    await sleep(10)
  })
})
