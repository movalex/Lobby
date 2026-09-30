// B3 L8, extended to the bind group: while A types in N (A holds N's lease in a real browser), B's raw socket
// (B's own ticket) tries to detach N's label (`g.bind.containerId: null`), then to rewrite it. Both are
// LEASED, A's typing lands, and no invariant breaks. The spike B verifier V2's probe (part-3 round; 20/20
// lost A's text on 37bdfa9), adopted as its regression. SPIKE_B3_L8B_REPS repetitions (default 3; V2 ran 20).
import { expect, test } from '@playwright/test'
import type {} from '../../../apps/web/src/canvas/test-facade.types.ts'
import { harness } from '../support/harness.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { editorState, openEditor, show, toasts } from './b3-kit.ts'
import { codes, forge, storedElement } from './b6-forge-kit.ts'

const N = Number(process.env.SPIKE_B3_L8B_REPS ?? 3)
test.setTimeout(60 * 60_000)
let stack: SpikeBStack
let A: BrowserProcess
let B: BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack()
  const ua = harness.devUser('l8b-alice')
  const ub = harness.devUser('l8b-bob')
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

test("L8 bind: a non-holder can neither detach the leased label nor rewrite it; the holder's text lands", async () => {
  const bob = await forge(B.page, boardId)
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < N; i++) {
    const noteId = await A.page.evaluate(
      (i) => window.lobbyCanvas?.create('note', { x: 100 + i * 260, y: 100, text: `alice${i}` }) ?? '',
      i,
    )
    await expect.poll(async () => (await storedElement(stack, boardId, noteId))?.boundElements).toBeTruthy()
    const labelId = (
      ((await storedElement(stack, boardId, noteId))?.boundElements ?? []) as { id: string; type: string }[]
    ).find((r) => r.type === 'text')?.id as string
    await show(A.page, [noteId])
    await openEditor(A.page, noteId)
    await A.page.keyboard.type(' typing', { delay: 10 })
    await A.page.waitForTimeout(700)
    const toasts0 = (await toasts(A.page)).length
    // B: two forged pushes
    const lab = (await storedElement(stack, boardId, labelId)) as { version: number }
    const d = await bob.push([{ k: 'p', id: labelId, pv: lab.version, g: { bind: { containerId: null } } }])
    const lab2 = (await storedElement(stack, boardId, labelId)) as { version: number }
    const w = await bob.push([
      {
        k: 'p',
        id: labelId,
        pv: lab2.version,
        g: { text: { originalText: `bob ${i}` }, layout: { text: `bob ${i}` } },
      },
    ])
    // A keeps typing, then closes the editor
    await A.page.keyboard.type(' more', { delay: 10 })
    await A.page.waitForTimeout(1200)
    await A.page.keyboard.press('Escape')
    await expect.poll(async () => (await editorState(A.page)).phase, { timeout: 15_000 }).toBe('idle')
    await A.page.waitForTimeout(1000)
    const stored = (await storedElement(stack, boardId, labelId)) as {
      containerId: string | null
      originalText: string
    }
    const aSees = await A.page.evaluate((id) => window.lobbyCanvas?.get(id) ?? null, labelId)
    rows.push({
      i,
      detach: codes(d)[0],
      rewrite: codes(w)[0],
      storedContainer: stored.containerId,
      storedText: stored.originalText,
      aliceTextLost: !stored.originalText.includes('typing'),
      aSeesText: (aSees as { text?: string } | null)?.text ?? null,
      aSave: await A.page.evaluate(() => window.lobbyCanvas?.saveState().state),
      newToasts: (await toasts(A.page)).slice(toasts0),
    })
  }
  const snap = await harness.readSnapshot(stack, boardId)
  const inv = harness.checkInvariants(snap).violations
  console.log(
    'B3-L8-BIND',
    JSON.stringify({
      n: rows.length,
      detach: [...new Set(rows.map((r) => r.detach))],
      rewrite: [...new Set(rows.map((r) => r.rewrite))],
      aliceTextLost: rows.filter((r) => r.aliceTextLost).length,
      storedContainerNull: rows.filter((r) => r.storedContainer === null).length,
      aSave: [...new Set(rows.map((r) => r.aSave))],
      toasts: [...new Set(rows.flatMap((r) => r.newToasts as string[]))],
      sample: rows.slice(0, 2),
      invariantViolations: inv.length,
      invariantCodes: [...new Set(inv.map((v) => v.code))],
    }),
  )
  await bob.socket.close()
  expect(rows.filter((r) => r.aliceTextLost)).toEqual([])
  expect([...new Set(rows.map((r) => r.detach))]).toEqual(['LEASED'])
  expect(rows.filter((r) => r.storedContainer === null)).toEqual([])
  expect(inv).toEqual([])
})
