// B4 D3 (docs/EXCALIDRAW-MIGRATION.md §8.3): 3 SIGKILLs of sync during 64-push group commits. Pass: 0
// acked-but-missing: every op the server acked is in the test snapshot after the restart. Owner: O1.
//
// The pushes come from a socket opened inside a signed-in page with its own ticket (the stream is the
// protocol's, not the page's client); the browser only provides the ticket. The protocol twin of this
// check is apps/sync/test/element-room/durability.test.ts.

import { expect, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { forge, rectEl } from './b6-forge-kit.ts'

let stack: SpikeBStack
let A: BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack()
  const ua = harness.devUser('d3-writer')
  ;({ boardId } = await stack.createBoard({ owner: ua }))
  A = await harness.launchBrowser(stack, ua, { name: 'A' })
  await A.openBoard(boardId)
})
test.afterAll(async () => {
  await A?.close()
  await stack?.stop()
})

test('D3: 3 SIGKILLs during group commits, 0 acked-but-missing', async () => {
  const rounds: { round: number; acked: number; missing: number }[] = []
  for (let round = 1; round <= 3; round++) {
    await A.openBoard(boardId) // a fresh page ticket after each restart
    const w = await forge(A.page, boardId)
    const acked = new Set<string>()
    const base = await w.clock()
    for (let k = 0; k < 300; k++) {
      const ops = Array.from({ length: 5 }, (_, j) => ({
        k: 'c',
        el: rectEl(`d3-${round}-${k}-${j}`, { x: k, y: j }),
      }))
      void w.send({ type: 'push', seq: 10_000 * round + k, base, ops } as never)
    }
    // kill once some batches have committed
    await expect
      .poll(async () => {
        for (const m of await w.socket.messages())
          if (m.type === 'ack') for (const r of m.r) if (r.ok) acked.add(r.id)
        return acked.size
      })
      .toBeGreaterThanOrEqual(64 * 5)
    await stack.killSync('SIGKILL')
    for (const m of await w.socket.messages())
      if (m.type === 'ack') for (const r of m.r) if (r.ok) acked.add(r.id)
    await stack.restartSync()
    const stored = new Set((await harness.readSnapshot(stack, boardId)).elements.map((e) => e.id))
    const missing = [...acked].filter((id) => !stored.has(id))
    rounds.push({ round, acked: acked.size, missing: missing.length })
    expect(missing).toEqual([])
  }
  test.info().annotations.push({ type: 'D3', description: JSON.stringify(rounds) })
})
