// B3 L7 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.9.3): A goes offline (its board socket cut, §8.6.2) for
// 15 s while typing; B then opens N and types. Separate Chromium processes (A, B) on a real stack (O1's
// lease table and its TTL, LEASE_TTL_MS = 10 s from the last renewal). Owner O2; evidence
// docs/research/excalidraw/spike-b/B3.md.
//
// Pass: B gets the lease after the expiry (the room names nobody, then B); when A comes back while B
// types, A sees "Not saved — B is editing this note now" with "Copy my text" (the notice carries the
// text A typed offline, and the button copies it); A's text never overwrites B's (every map and the
// snapshot end with B's text; A pushes no text for N after the cut).
//
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b3-l7   (SPIKE_B3_L7_REPS, default 3)
import { expect, type Page, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import {
  allSaved,
  board,
  closeEditor,
  converge,
  editorState,
  focusCanvas,
  labelText,
  lc,
  note,
  openEditor,
  opsFor,
  pushCount,
  REPS,
  type Room,
  room,
  show,
  toasts,
  waitEditor,
  waitSaved,
} from './b3-kit.ts'

const N = REPS('B3_L7', 3)
const OFFLINE_MS = 15_000
test.describe.configure({ mode: 'serial' })
test.setTimeout(60 * 60_000)

let r: Room
const A = () => r.by.A?.page as Page
const B = () => r.by.B?.page as Page

test.beforeAll(async () => {
  r = await room(['A', 'B'])
})
test.afterAll(async () => {
  await r?.close()
})

/** Captures what the page's "Copy my text" writes (navigator.clipboard.writeText). */
async function captureClipboard(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as unknown as { __copied?: string[] }
    w.__copied = []
    const clip = navigator.clipboard
    if (clip)
      Object.defineProperty(clip, 'writeText', {
        configurable: true,
        value: async (t: string) => {
          w.__copied?.push(t)
        },
      })
  })
}
const copied = (p: Page) => p.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? [])

test('L7: A offline 15 s while typing; B gets the lease after the expiry; A sees "Not saved — B is editing" and can copy its text', async () => {
  const hooks = harness.testHooks(r.stack)
  await captureClipboard(A())
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < N; i++) {
    const base = `L7 ${i}`
    const n = await note(A(), r.browsers, { x: i * 500, y: 0 }, base)
    await show(A(), [n.id])
    await show(B(), [n.id])
    await openEditor(A(), n.id)
    await A().keyboard.press('End')
    await A().keyboard.type(' online')
    await waitSaved(A())
    // A's socket is cut (the relay holds its reconnects); A keeps typing
    await hooks.cutSocket(A())
    const tCut = Date.now()
    await expect.poll(async () => (await lc(A()).saveState()).state).toBe('offline')
    const fromA = await pushCount(A())
    await A().keyboard.type(' offline')
    const typedOffline = (await editorState(A())).value
    // before the expiry, B's open is refused (the room still names A)
    const t0 = (await toasts(B())).length
    await lc(B()).select([n.id])
    await focusCanvas(B())
    await B().keyboard.press('Enter')
    await B().waitForTimeout(800)
    const earlyDeny = (await toasts(B())).slice(t0).some((t) => /is typing in this note/.test(t))
    const earlyEditor = (await editorState(B())).phase
    await B().keyboard.press('Escape')
    // the room lets A's lease expire (no renewal from an offline session)
    await expect
      .poll(
        () =>
          lc(B())
            .leaseState()
            .then((s) => s.holders[n.id]?.name ?? null),
        { timeout: 30_000 },
      )
      .toBeNull()
    const expiredAfterMs = Date.now() - tCut
    await B().waitForTimeout(Math.max(0, OFFLINE_MS - (Date.now() - tCut)))
    // B opens N and types
    await openEditor(B(), n.id)
    await B().keyboard.press('End')
    await B().keyboard.type(' B')
    await waitSaved(B())
    // A comes back while B still types
    await hooks.restoreSocket(A())
    const offlineMs = Date.now() - tCut
    await waitEditor(A(), (e) => e.readOnly === true || e.phase === 'idle', 15_000)
    await expect
      .poll(() => board(A(), (b) => b.session.snapshot.notice?.kind ?? null), { timeout: 15_000 })
      .toBe('lost')
    const notice = await board(A(), (b) => {
      const n = b.session.snapshot.notice
      return n ? { kind: n.kind, message: n.message, text: n.text, holder: n.holder ?? null } : null
    })
    const banner = await A().locator('[data-testid="lease-notice"]').textContent()
    const copyButton = A().locator('[data-testid="lease-notice"] [data-testid="lease-copy"]')
    const hasCopy = (await copyButton.count()) === 1
    if (hasCopy) await copyButton.click()
    const clip = await copied(A())
    await B().keyboard.type(' more')
    await closeEditor(B())
    // A's editor: read-only since the loss; it closes without a submit
    await A().keyboard.press('Escape')
    await waitEditor(A(), (e) => e.phase === 'idle' && e.textareas === 0)
    await board(A(), (b) => b.session.dismissNotice())
    await allSaved(r.browsers)
    await converge(r)
    const final = await labelText(A(), n.label)
    const snap = await harness.readSnapshot(r.stack, r.boardId)
    const stored = (snap.elements.find((e) => e.id === n.label) as { originalText?: string } | undefined)
      ?.originalText
    const aTextOps = (await opsFor(A(), n.label as string, fromA)).length
    const want = `${base} online B more`
    const ok =
      earlyDeny &&
      earlyEditor === 'idle' &&
      expiredAfterMs < OFFLINE_MS &&
      notice?.kind === 'lost' &&
      /Not saved — .+ is editing/.test(notice?.message ?? '') &&
      !!notice?.text?.includes('offline') &&
      hasCopy &&
      clip.at(-1) === notice?.text &&
      final === want &&
      stored === want &&
      aTextOps === 0
    rows.push({
      i,
      ok,
      earlyDeny,
      earlyEditor,
      expiredAfterMs,
      offlineMs,
      notice,
      banner,
      hasCopy,
      copied: clip.at(-1) ?? null,
      typedOffline,
      final,
      stored,
      aTextOps,
    })
    console.log('row', JSON.stringify(rows.at(-1)))
    await captureClipboard(A())
  }
  console.log('B3-L7', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
