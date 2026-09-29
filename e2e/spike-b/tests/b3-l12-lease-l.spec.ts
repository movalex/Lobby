import { expect, type Page, test } from '@playwright/test'
import {
  addNote,
  agreement,
  bodyPoint,
  centerOf,
  editor,
  element,
  lab,
  monitorReport,
  monitorStart,
  type NoteIds,
  openLab,
  resetLab,
  settle,
  toClient,
  waitEditor,
} from '../../spike/tests/host-kit.ts'

// Spike B, B3 L12 (guard regressions): the lease verifier's L1-L4 on spike A's fix round 2
// (docs/research/excalidraw/spike-b/OPEN-FROM-SPIKE-A.md), as their repros describe them, on
// /spike/host-lab (spike A's page, fake lease server, no api or sync). Owner O2.
//
//   L1  a guard-caught editor opened while Alice types must never write its old copy back: the deny,
//       Escape, a click away and a blur each close it with Alice's newer text kept
//   L2  on the grant, the guard's editor shows the label's CURRENT text (Alice's last keystrokes), so the
//       first keystroke appends to it (P5 and a double-click on the label)
//   L3  a New element denied after the holder wrote its label: the holder's text stays (it used to be
//       emptied and the label deleted)
//   L4  keys typed into a pending editor left by a click away or a blur are offered back ("Copy my text")
//
// Every case failed before the fix (see docs/research/excalidraw/spike-b/L12-verifier-l.md for the runs).
// The deny of L1 is delivered by `flush` (grant=manual) rather than a 150 ms timer, so the remote keystroke
// lands before the answer every time; the verifier's timed variant is the same code path.
//
// Run: SPIKE_B_PORT_BASE=7870 pnpm --filter @draftroom/e2e spike-b -- b3-l12-lease-l   (SPIKE_REPS: default 20)

const N = Number(process.env.SPIKE_REPS ?? 20)

async function labelOf(page: Page, ids: NoteIds): Promise<{ text: string | null; deleted: boolean }> {
  const el = await element(page, ids.label ?? '')
  return { text: (el?.originalText as string | undefined) ?? null, deleted: el ? !!el.isDeleted : true }
}

/** Alice's keystroke, as the sync adapter applies a remote change (captureUpdate NEVER). */
async function remoteText(page: Page, labelId: string, text: string): Promise<void> {
  await lab(
    page,
    (x, a) => x.recorder.applyRemote([{ id: a.id, patch: { originalText: a.text, text: a.text } }]),
    { id: labelId, text },
  )
}

async function emptyPoint(page: Page): Promise<{ x: number; y: number }> {
  return toClient(page, 900, 620)
}

type Open = 'dblclick-label' | 'p5'

async function openGuard(page: Page, ids: NoteIds, how: Open): Promise<void> {
  if (how === 'dblclick-label') {
    const lb = await centerOf(page, ids.label ?? '')
    await page.mouse.dblclick(lb.x, lb.y)
  } else {
    const b = await bodyPoint(page, ids.note)
    await page.mouse.click(b.x, b.y)
    await page.waitForTimeout(600) // the next click must not pair with this one
    const lb = await centerOf(page, ids.label ?? '')
    await page.mouse.click(lb.x, lb.y)
  }
  await waitEditor(page, (e) => e.phase === 'pending' && e.origin === 'guard' && !!e.textarea?.readOnly)
}

async function setup(page: Page, i: number, holdByOther: boolean): Promise<NoteIds> {
  await resetLab(page)
  await lab(page, (x) => x.lease.setDelay('manual'))
  const ids = await addNote(page, {
    id: `A${i}-${Date.now().toString(36)}`,
    x: 80,
    y: 160,
    size: 200,
    text: 'memo',
  })
  if (holdByOther) await lab(page, (x, id) => x.lease.holdByOther(id), ids.note)
  await monitorStart(page)
  return ids
}

async function idle(page: Page): Promise<void> {
  await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null)
  await settle(page, 60)
}

type L1Exit = 'deny' | 'escape' | 'click-away' | 'blur'

async function l1Case(page: Page, exit: L1Exit, i: number) {
  const ids = await setup(page, i, true)
  await openGuard(page, ids, i % 2 === 0 ? 'dblclick-label' : 'p5')
  const opened = (await editor(page)).textarea?.value
  await remoteText(page, ids.label ?? '', 'memo by alice')
  if (exit === 'deny') await lab(page, (x) => x.lease.flush())
  else if (exit === 'escape') await page.keyboard.press('Escape')
  else if (exit === 'click-away') {
    const p = await emptyPoint(page)
    await page.mouse.click(p.x, p.y)
  } else {
    await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.blur(),
    )
  }
  await lab(page, (x) => x.lease.flush())
  await idle(page)
  const label = await labelOf(page, ids)
  const report = await monitorReport(page)
  const writes = report.textWrites.filter((w) => w.id === ids.note).map((w) => w.text)
  const agree = await agreement(page)
  const denied = await lab(page, (x) => x.toasts.length)
  const ok =
    opened === 'memo' &&
    label.text === 'memo by alice' &&
    !label.deleted &&
    // the only text write is Alice's (the remote one): nothing of this client's reached the label
    JSON.stringify(writes) === JSON.stringify(['memo by alice']) &&
    agree.ok &&
    (exit !== 'deny' || denied === 1)
  return { i, exit, ok, opened, label, writes, agree: agree.issues, denied }
}

async function l2Case(page: Page, how: Open, i: number) {
  const ids = await setup(page, i, true)
  await openGuard(page, ids, how)
  await remoteText(page, ids.label ?? '', 'memo by alice')
  await lab(page, (x, id) => x.lease.clearOther(id), ids.note) // Alice released
  await lab(page, (x) => x.lease.flush()) // our grant
  const granted = await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea && !e.textarea.readOnly)
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await settle(page, 40)
  await page.keyboard.press('Escape')
  await idle(page)
  const label = await labelOf(page, ids)
  const agree = await agreement(page)
  const ok = label.text === 'memo by alice!' && !label.deleted && agree.ok
  return { i, how, ok, valueAtGrant: granted.textarea?.value, label, agree: agree.issues }
}

async function l3Case(page: Page, i: number) {
  await resetLab(page)
  await lab(page, (x) => x.lease.setDelay('manual'))
  await monitorStart(page)
  await lab(page, (x) => x.tools.setTool('note'))
  const at = await toClient(page, 360, 360)
  await page.mouse.click(at.x, at.y)
  const opened = await waitEditor(
    page,
    (e) => e.phase === 'open' && e.origin === 'new' && !!e.textarea?.focused,
  )
  const noteId = opened.leaseId as string
  const labelId = opened.editingId as string
  await page.keyboard.type('XY')
  await settle(page, 40)
  await lab(page, (x, id) => x.lease.holdByOther(id), noteId) // Alice holds the just-created note after all
  await waitEditor(page, (e) => !!e.textarea?.readOnly)
  await remoteText(page, labelId, 'alice was here')
  await lab(page, (x) => x.lease.flush()) // the deny
  await idle(page)
  const label = await labelOf(page, { note: noteId, label: labelId })
  const notices = await lab(page, (x) =>
    x.notices.map((n: { kind: string; text: string | null }) => [n.kind, n.text]),
  )
  const ok =
    label.text === 'alice was here' &&
    !label.deleted &&
    notices.some(([k, t]: [string, string | null]) => k === 'new-denied' && t === 'XY')
  return { i, ok, label, notices }
}

async function l4Case(page: Page, exit: 'click-away' | 'blur', i: number) {
  const ids = await setup(page, i, false)
  await openGuard(page, ids, 'p5')
  await page.keyboard.type('QS')
  await settle(page, 40)
  const buffered = (await lab(page, (x) => x.input.editorLease.state().buffered)) as number
  if (exit === 'click-away') {
    const p = await emptyPoint(page)
    await page.mouse.click(p.x, p.y)
  } else {
    await page.evaluate(() =>
      document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.blur(),
    )
  }
  await lab(page, (x) => x.lease.flush())
  await idle(page)
  const label = await labelOf(page, ids)
  const notices = await lab(page, (x) =>
    x.notices.map((n: { kind: string; text: string | null }) => [n.kind, n.text]),
  )
  const offered = notices.filter(([, t]: [string, string | null]) => t === 'QS')
  const agree = await agreement(page)
  const ok = buffered === 2 && label.text === 'memo' && offered.length === 1 && agree.ok
  return { i, exit, ok, buffered, label, notices, agree: agree.issues }
}

async function run<T extends { ok: boolean }>(
  name: string,
  one: (i: number) => Promise<T>,
): Promise<{ passed: number; runs: number; failures: T[] }> {
  const failures: T[] = []
  let passed = 0
  for (let i = 0; i < N; i++) {
    const r = await one(i)
    if (r.ok) passed++
    else failures.push(r)
  }
  console.log(`B3-L12-${name}`, JSON.stringify({ passed, runs: N, failures: failures.slice(0, 3) }))
  return { passed, runs: N, failures }
}

test.describe('B3 L12: the lease verifier L1-L4 (guard regressions on host-lab)', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(600_000)
    await openLab(page, { grant: 'manual' })
    await page.evaluate(() => document.fonts.load('20px Nunito', 'memo by alice XYQS!'))
  })

  for (const exit of ['deny', 'escape', 'click-away', 'blur'] as const) {
    test(`L1 ${exit}: a guard editor opened while Alice types never writes its old copy back`, async ({
      page,
    }) => {
      const r = await run(`L1-${exit}`, (i) => l1Case(page, exit, i))
      expect(r.failures).toEqual([])
    })
  }

  for (const how of ['p5', 'dblclick-label'] as const) {
    test(`L2 ${how}: on the grant the editor holds Alice's last text; the first key appends to it`, async ({
      page,
    }) => {
      const r = await run(`L2-${how}`, (i) => l2Case(page, how, i))
      expect(r.failures).toEqual([])
    })
  }

  test("L3: a New element denied after Alice wrote its label keeps Alice's text", async ({ page }) => {
    const r = await run('L3', (i) => l3Case(page, i))
    expect(r.failures).toEqual([])
  })

  for (const exit of ['click-away', 'blur'] as const) {
    test(`L4 ${exit}: keys typed into a pending editor that is left are offered back`, async ({ page }) => {
      const r = await run(`L4-${exit}`, (i) => l4Case(page, exit, i))
      expect(r.failures).toEqual([])
    })
  }
})
