// B4 D3 (docs/EXCALIDRAW-MIGRATION.md §8.3): 3 SIGKILLs of sync during 64-push group commits. Pass: 0
// acked-but-missing: every op the server acked is in the test snapshot after the restart. Owner: O1.
//
// The pushes come from a socket opened inside a signed-in page with its own ticket (b6-forge-kit.ts
// `burstSocket`): bursts of 64 pushes of 3 creates each, sent in ONE page task so they reach sync together
// and the drain commits them in 64-push batches (within app.ts's message budget and the room's op budget).
// The kill is fired while the 5th burst is being committed; a round whose kill landed after every sent op
// was acked did not test anything and is repeated (at most 5 attempts per round, reported). The protocol
// twin is apps/sync/test/element-room/durability.test.ts.

import { expect, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { burstSocket, rectEl } from './b6-forge-kit.ts'

let stack: SpikeBStack
let A: BrowserProcess
let boardId: string

const BURST = 64
const OPS = 3
const BURSTS = 5

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

test('D3: 3 SIGKILLs during 64-push group commits, 0 acked-but-missing', async () => {
  const rounds: {
    round: number
    attempt: number
    sent: number
    acked: number
    stored: number
    missing: number
  }[] = []
  let seq = 0
  for (let round = 1; round <= 3; round++) {
    for (let attempt = 1; ; attempt++) {
      await A.openBoard(boardId) // a fresh page (and ticket) after each restart
      const w = await burstSocket(A.page, boardId)
      let sent = 0
      const frames = (b: number) =>
        Array.from({ length: BURST }, (_, k) => {
          sent += OPS
          return {
            type: 'push',
            seq: ++seq,
            base: w.clock,
            ops: Array.from({ length: OPS }, (_, j) => ({
              k: 'c',
              el: rectEl(`d3-${round}-${attempt}-${b}-${k}-${j}`, { x: k, y: j }),
            })),
          }
        })
      for (let b = 1; b < BURSTS; b++) {
        await w.burst(frames(b))
        await A.page.waitForTimeout(150)
      }
      // the last burst and the kill together: the room is committing that burst when sync dies
      const last = w.burst(frames(BURSTS))
      await A.page.waitForTimeout(3)
      await stack.killSync('SIGKILL')
      await last.catch(() => {})
      const acked = new Set(await w.acked())
      await stack.restartSync()
      const stored = new Set((await harness.readSnapshot(stack, boardId)).elements.map((e) => e.id))
      const missing = [...acked].filter((id) => !stored.has(id))
      const prefix = `d3-${round}-${attempt}-`
      const storedOfStream = [...stored].filter((id) => id.startsWith(prefix)).length
      rounds.push({
        round,
        attempt,
        sent,
        acked: acked.size,
        stored: storedOfStream,
        missing: missing.length,
      })
      expect(missing).toEqual([])
      if (acked.size < sent) break // the kill landed inside the stream
      expect(attempt, 'the kill never landed before the last ack').toBeLessThan(5)
    }
  }
  test.info().annotations.push({ type: 'D3', description: JSON.stringify(rounds) })
  console.log('[evidence] D3', JSON.stringify(rounds))
})
