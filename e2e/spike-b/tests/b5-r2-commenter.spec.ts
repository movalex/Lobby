// B5 R2 (docs/EXCALIDRAW-MIGRATION.md §8.3): a commenter places a comment pin and casts a vote through
// the custom tools; then forges a patch. Pass: pin and vote work; the patch gets READ_ONLY.
//
// Two Chromium processes (A editor and facilitator, C commenter), one stack (SPIKE_B_PORT_BASE; O5's is
// 7910). C uses the real UI: the toolbar's Comment and Vote tools and real clicks on the note. C's pushes
// are recorded (B10: C writes nothing to the canvas), and after the check every map hashes equal to the
// test snapshot and the invariant checker finds nothing. Evidence: docs/research/excalidraw/spike-b/B5-R2.md.
import { expect, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import { stackFromEnv } from '../support/ports.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { centreOf, createNote, featuresReady, forgeReady, saved, seen, startVote } from './b7-b12-kit.ts'

test.describe.configure({ mode: 'serial' })

let stack: SpikeBStack
let A: BrowserProcess
let C: BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack({ base: stackFromEnv().base })
  const alice = harness.devUser('r2-alice')
  const cora = harness.devUser('r2-cora')
  ;({ boardId } = await stack.createBoard({ owner: alice, members: [{ user: cora, role: 'commenter' }] }))
  A = await harness.launchBrowser(stack, alice, { name: 'A' })
  C = await harness.launchBrowser(stack, cora, { name: 'C' })
  await A.openBoard(boardId)
  await C.openBoard(boardId)
  await featuresReady(A.page)
  await featuresReady(C.page)
})

test.afterAll(async () => {
  await C?.close()
  await A?.close()
  await stack?.stop()
})

test('R2: a commenter places a pin and votes through the custom tools; a forged patch is READ_ONLY', async () => {
  const horizonAtStart = (await harness.readSnapshot(stack, boardId)).horizon
  const noteId = await createNote(A.page, 200, 160, 'R2 note')
  await saved(A.page)
  await seen([C], noteId)
  await startVote(A.page, 3)
  await expect
    .poll(() => C.page.evaluate(async () => (await window.lobbySpikeFeatures?.workshop())?.voteOpen))
    .toBe(true)
  expect(await C.page.evaluate(() => window.lobbySpikeFeatures?.me()?.role)).toBe('commenter')

  const cPushes = await harness.recordPushes(C.page)
  const before = await harness.readSnapshot(stack, boardId)

  // ---- the comment tool: a press on the note opens the composer; Post creates the thread ----
  await C.page.locator('[data-lobby-tool="comment"]').click()
  expect(await C.page.evaluate(() => window.lobbyCanvas?.tool())).toBe('comment')
  const at = await centreOf(C.page, noteId)
  await C.page.mouse.click(at.x, at.y)
  const input = C.page.locator('[data-lobby-comment-input]')
  await expect(input).toBeVisible()
  await input.fill('R2 pin from a commenter')
  await input.press('Enter')
  await expect(C.page.locator('[data-lobby-comment-pin]:not([data-lobby-comment-pin="draft"])')).toHaveCount(
    1,
  )
  const threads = await C.page.evaluate(() => window.lobbySpikeFeatures?.threads() ?? [])
  expect(threads).toHaveLength(1)
  expect(threads[0]?.body).toBe('R2 pin from a commenter')
  expect(threads[0]?.anchor).toMatchObject({ kind: 'shape', shapeId: `shape:${noteId}` })
  // A sees the pin too (the board event stream)
  await expect(A.page.locator(`[data-lobby-comment-pin="${threads[0]?.id}"]`)).toHaveCount(1, {
    timeout: 15_000,
  })

  // ---- the vote tool: a press on the note casts one dot; the note is never selected ----
  await C.page.locator('[data-lobby-tool="vote"]').click()
  expect(await C.page.evaluate(() => window.lobbyCanvas?.tool())).toBe('vote')
  await C.page.mouse.click(at.x, at.y)
  await expect
    .poll(
      async () =>
        (await C.page.evaluate(() => window.lobbySpikeFeatures?.workshop()))?.myVotes[`shape:${noteId}`],
    )
    .toBe(1)
  expect(await C.page.evaluate(() => window.lobbyCanvas?.selection() ?? [])).toEqual([])
  await expect(C.page.locator(`[data-lobby-vote-badge="${noteId}"]`)).toHaveAttribute('data-count', '1')

  // ---- the forged patch: READ_ONLY per op, the socket stays open, nothing stored ----
  const sock = await harness.forgeSocket(C.page, boardId)
  await forgeReady(sock, 'forge-r2')
  const stored = before.elements.find((e) => e.id === noteId) as { version?: number } | undefined
  await sock.send({
    type: 'push',
    seq: 1,
    base: before.clock,
    ops: [{ k: 'p', id: noteId, pv: stored?.version ?? 1, g: { style: { backgroundColor: '#ff0000' } } }],
  } as never)
  const ack = await sock.next('ack', 15_000)
  expect(ack.r).toHaveLength(1)
  expect(ack.r[0]).toMatchObject({ ok: false, code: 'READ_ONLY' })
  // still open: a ping is answered
  await sock.send({ type: 'ping' } as never)
  await sock.next('pong', 10_000)
  await sock.close()

  // ---- nothing on the canvas changed; C pushed nothing; everyone converges ----
  const after = await harness.readSnapshot(stack, boardId)
  expect(after.hash).toBe(before.hash)
  expect(await cPushes.count()).toBe(0)
  const report = await harness.converged(stack, boardId, [A, C], { horizonAtStart })
  expect(report.horizonMoved).toBe(false)
  expect(report.ok).toBe(true)
  expect(harness.checkInvariants(report.snapshot).violations).toEqual([])
  console.log(
    'B5-R2-METRICS',
    JSON.stringify({
      thread: threads[0]?.id,
      ack: ack.r[0],
      cPushes: await cPushes.count(),
      hash: after.hash,
    }),
  )
})
