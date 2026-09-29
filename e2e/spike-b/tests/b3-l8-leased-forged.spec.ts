// B3 L8 (docs/EXCALIDRAW-MIGRATION.md §8.3): while A holds N's lease (A typing in N), B's raw socket sends
// a label-text patch, a new text with `containerId: N`, a delete of N, and a `fit` for N. Pass: LEASED for
// each of the first three; the fit is dropped (`fitDropped`); nothing stored. 20 repetitions; after each,
// every browser converges on the test snapshot and the invariant checker finds nothing. Owner: O1.
//
// Two browser processes (A, B). B's frames go through a socket opened inside B's page with B's own ticket
// (harness.forgeSocket), so no client code can stand between the frame and the server's refusal.

import { expect, test } from '@playwright/test'
import type {} from '../../../apps/web/src/canvas/test-facade.types.ts' // window.lobbyCanvas
import { harness } from '../support/harness.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { codes, forge, storedElement, textEl } from './b6-forge-kit.ts'

let stack: SpikeBStack
let A: BrowserProcess
let B: BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack()
  const ua = harness.devUser('l8-alice')
  const ub = harness.devUser('l8-bob')
  ;({ boardId } = await stack.createBoard({ owner: ua, members: [{ user: ub, role: 'editor' }] }))
  A = await harness.launchBrowser(stack, ua, { name: 'A' })
  B = await harness.launchBrowser(stack, ub, { name: 'B' })
  await A.openBoard(boardId)
  await B.openBoard(boardId)
})
test.afterAll(async () => {
  await A?.close()
  await B?.close()
  await stack?.stop()
})

test('L8: forged writes to a note A is typing in are LEASED, the fit dropped, nothing stored (20/20)', async () => {
  const horizon = (await harness.readSnapshot(stack, boardId)).horizon
  const noteId = await A.page.evaluate(
    () => window.lobbyCanvas?.create('note', { x: 100, y: 100, text: 'memo' }) ?? '',
  )
  expect(noteId).not.toBe('')
  await expect.poll(async () => (await storedElement(stack, boardId, noteId))?.boundElements).toBeTruthy()
  const refs = ((await storedElement(stack, boardId, noteId))?.boundElements ?? []) as {
    id: string
    type: string
  }[]
  const labelId = refs.find((r) => r.type === 'text')?.id as string
  // A opens the editor on N (Enter on the selected note): Lobby acquires the lease
  await A.page.evaluate((id) => window.lobbyCanvas?.select([id]), noteId)
  await A.page.keyboard.press('Enter')
  await expect
    .poll(() => A.page.evaluate((id) => window.lobbyCanvas?.leaseState().held.includes(id), noteId))
    .toBe(true)
  await expect
    .poll(() => B.page.evaluate((id) => window.lobbyCanvas?.leaseHolder(id)?.name ?? null, noteId))
    .not.toBeNull()

  const bob = await forge(B.page, boardId)
  const report: string[][] = []
  for (let i = 0; i < 20; i++) {
    const before = await harness.readSnapshot(stack, boardId)
    const label = before.elements.find((e) => e.id === labelId) as { version: number }
    const note = before.elements.find((e) => e.id === noteId) as { version: number }
    const ack = await bob.push([
      {
        k: 'p',
        id: labelId,
        pv: label.version,
        g: { text: { originalText: `bob ${i}` }, layout: { text: `bob ${i}` } },
      },
      { k: 'c', el: textEl(`l8-forged-${i}`, { containerId: noteId }) },
      { k: 'p', id: noteId, pv: note.version, g: { life: { isDeleted: true } } },
      { k: 'p', id: noteId, pv: note.version, fit: { height: 900 } },
    ])
    const got = codes(ack)
    report.push(got)
    expect(got.slice(0, 3)).toEqual(['LEASED', 'LEASED', 'LEASED'])
    expect(ack.r[3]).toMatchObject({ ok: true, fitDropped: true })
    const after = await harness.readSnapshot(stack, boardId)
    expect(after.hash).toBe(before.hash) // nothing stored
    expect(bob.socket).toBeTruthy()
  }
  await bob.socket.close()
  const conv = await harness.converged(stack, boardId, [A, B], { horizonAtStart: horizon })
  expect(conv.horizonMoved).toBe(false)
  expect(conv.ok).toBe(true)
  expect(harness.checkInvariants(conv.snapshot).violations).toEqual([])
  test.info().annotations.push({ type: 'L8', description: JSON.stringify({ runs: report.length }) })
})
