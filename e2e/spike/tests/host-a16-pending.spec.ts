import { type CDPSession, expect, type Page, test } from '@playwright/test'
import { watchPage } from '../support/watch.ts'
import {
  acquires,
  addNote,
  agreement,
  bodyPoint,
  centerOf,
  editor,
  element,
  focusCanvas,
  lab,
  type MonitorReport,
  monitorReport,
  monitorStart,
  type NoteIds,
  openLab,
  resetLab,
  select,
  settle,
  waitEditor,
} from './host-kit.ts'

// A16 regression (the independent verifier's break and repeat probes, turned into gates): an editor that
// Excalidraw opens on another element while a Lobby lease request is pending must never be writable.
//
// Rule under test (apps/web/src/canvas/lease/editorLease.ts): any editingTextElement that is not the
// element of a granted Lobby lease is unrequested, whatever the session's phase. Its textarea is
// read-only from the task it appeared in (beforeinput, paste and drop into it are prevented); it is then
// closed unchanged when another request is in flight, or re-queued as its own lease request (the plan's
// P5 guard) when Lobby is idle.
//
// Changed in fix round 2 (the second verifier's defect 8): SELECTING another element while a Lobby
// request is pending cancels that request. The plan's buffer rule has no re-targeting, so A's buffered
// keys are discarded with a notice ("You selected something else…"). Every B action below starts by
// selecting B (a click, the first click of a double-click), so A is cancelled first and B then goes
// through its own lease: these cases used to expect the keys typed after B's action to land in A.
// 'deny' now holds B too, so B's own request is the one denied.
//
// host-lab's monitor checks, independently of EditorLease: no textarea is ever writable (at a task
// boundary) or receives input unless this session HOLDS the lease of the element it edits ("created
// here" no longer counts); after every engine change Lobby's session agrees with Excalidraw's
// editingTextElement; 'pending' always has exactly one live request and a visible affordance; every
// write of a label's text happens while its lease is held; every release happens after the label's final
// text is written.

// SPIKE_REPS lowers the repetitions for a quick look (the gate is 20).
const N = Number(process.env.SPIKE_REPS ?? 20)

type BAction = 'dblclick-label' | 'p5' | 'type-to-edit'
type Outcome = 'grant' | 'manual-grant' | 'deny' | 'escape'

/** Timed grants: long enough that B's action lands while A's request is pending. */
const GRANT_MS: Record<BAction, number> = { 'dblclick-label': 300, p5: 1500, 'type-to-edit': 300 }
/** Timed grant for B's own request (set after A's request went out). */
const B_GRANT_MS = 1500

async function warm(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.load('20px Nunito', 'Note A B zqxkKIMEok'))
}

async function labelText(page: Page, ids: NoteIds): Promise<string | undefined> {
  return (await element(page, ids.label ?? ''))?.originalText as string | undefined
}

async function answered(page: Page): Promise<boolean> {
  return lab(page, (x) =>
    x.lease
      .log()
      .some(
        (l: { dir: string; message: { type: string } }) => l.dir === 'down' && l.message.type !== 'lease',
      ),
  )
}

async function bAction(page: Page, action: BAction, B: NoteIds): Promise<void> {
  if (action === 'dblclick-label') {
    const lb = await centerOf(page, B.label ?? '')
    await page.mouse.dblclick(lb.x, lb.y)
    return
  }
  const pb = await bodyPoint(page, B.note)
  await page.mouse.click(pb.x, pb.y)
  if (action === 'type-to-edit') {
    await page.keyboard.press('x')
    return
  }
  await page.waitForTimeout(600) // the next click must not pair with this one
  const lb = await centerOf(page, B.label ?? '')
  await page.mouse.click(lb.x, lb.y)
}

function textWritesOf(r: MonitorReport, id: string) {
  return r.textWrites.filter((w) => w.id === id)
}

async function pendingCase(
  page: Page,
  action: BAction,
  outcome: Outcome,
  i: number,
): Promise<Record<string, unknown>> {
  await resetLab(page)
  await lab(page, (x, d) => x.lease.setDelay(d), outcome === 'grant' ? GRANT_MS[action] : 'manual')
  const A = await addNote(page, { id: `A${i}`, x: 80, y: 160, size: 200, text: 'Note A' })
  const B = await addNote(page, { id: `B${i}`, x: 480, y: 160, size: 200, text: 'Note B' })
  if (outcome === 'deny') {
    await lab(page, (x, id) => x.lease.holdByOther(id), A.note)
    await lab(page, (x, id) => x.lease.holdByOther(id), B.note)
  }
  await monitorStart(page)

  // 1. Lobby's request for A (P1 Enter or P2 type-to-edit), pending.
  const startKey = i % 2 === 0 ? 'Enter' : 'k'
  await select(page, [A.note])
  await focusCanvas(page)
  await page.keyboard.press(startKey)
  // Timed grants: B's own request (made after A is cancelled) must still be out when the IME text and
  // the keys arrive, or they would legitimately land in a granted B (run 2 of fix round 2 caught that race).
  if (outcome === 'grant') await lab(page, (x, d) => x.lease.setDelay(d), B_GRANT_MS)
  const beforeB = await editor(page)
  const affordance = await lab(page, (x) => x.pendingVisible())
  // 2. B's action while A's answer is still out: it selects B first, which cancels A (defect 8).
  await bAction(page, action, B)
  const answeredBeforeB = await answered(page)
  await settle(page, 40)
  const afterB = await editor(page)
  const agreeAfterB = await agreement(page)
  const aCancelled = await lab(
    page,
    (x, id) =>
      x.notices.some(
        (n: { kind: string; leaseId: string }) => n.kind === 'cancelled-selection' && n.leaseId === id,
      ),
    A.note,
  )
  // 3. Text with no keydown (an IME commit, the emoji panel, dictation).
  await page.keyboard.insertText('IME')
  await settle(page, 40)
  const bAfterIme = await labelText(page, B)
  const valueAfterIme = (await editor(page)).textarea?.value ?? null
  // 4. Typed keys (B's request is the pending one now).
  await page.keyboard.type('zq')
  await settle(page, 40)
  // 5. The answer (for 'manual-grant' and 'deny' A's cancelled request is answered first).
  if (outcome === 'escape') await page.keyboard.press('Escape')
  else if (outcome !== 'grant') await lab(page, (x) => x.lease.flush())
  const granted = outcome === 'grant' || outcome === 'manual-grant'
  const afterAnswer = await waitEditor(
    page,
    (e) =>
      granted ? e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly : e.phase === 'idle',
    5000,
  ).catch(() => editor(page))
  await settle(page, 40)
  const agreeAfterAnswer = await agreement(page)
  if (granted) {
    await page.keyboard.type('KK')
    await settle(page, 40)
  }
  // 6. Close.
  await lab(page, (x) => x.lease.flush())
  if (granted) await page.keyboard.press('Escape')
  await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null).catch(() => {})
  await settle(page, 60)
  await lab(page, (x) => x.lease.flush())
  const agreeEnd = await agreement(page)
  const report = await monitorReport(page)
  const acq = await acquires(page)
  const aText = await labelText(page, A)
  const bText = await labelText(page, B)
  const typed = `${action === 'type-to-edit' ? 'x' : ''}zqKK`
  // B granted: its buffered keys, then KK, at the caret its open placed: the end (P2, P3), Excalidraw's
  // click position (P5), or replacing the whole text (a guard opened by a double-click selects all).
  const bRest = bText?.replace(typed, '')
  const bOk = granted ? !!bText?.includes(typed) && (bRest === 'Note B' || bRest === '') : bText === 'Note B'
  const aWrites = textWritesOf(report, A.note)
  const bWrites = textWritesOf(report, B.note)
  const bReleases = report.releases.filter((r) => r.id === B.note)
  const heldAtEnd = await lab(page, (x, ids) => ids.filter((id: string) => x.lease.isHeld(id)), [
    A.note,
    B.note,
  ])
  // A timed server applies the release of A's late grant after its delay (in request order).
  if (outcome !== 'deny') {
    await expect
      .poll(() => lab(page, (x, id) => x.lease.server.holderOf(id)?.name ?? null, A.note), { timeout: 5000 })
      .toBeNull()
      .catch(() => {})
  }
  const aOnServer = await lab(page, (x, id) => x.lease.server.holderOf(id)?.name ?? null, A.note)

  const checks: Record<string, boolean> = {
    precondition:
      !answeredBeforeB &&
      beforeB.leaseId === A.note &&
      beforeB.phase === 'pending' &&
      beforeB.origin === 'lobby' &&
      affordance,
    aCancelledBySelection: aCancelled && afterB.leaseId !== A.note,
    noViolations: report.violations.length === 0,
    agreeAfterB: agreeAfterB.ok,
    agreeAfterAnswer: agreeAfterAnswer.ok,
    agreeEnd:
      agreeEnd.ok && agreeEnd.phase === 'idle' && agreeEnd.textareas === 0 && agreeEnd.editing === null,
    noWritableEditorAfterB: afterB.textarea === null || afterB.textarea.readOnly,
    aUnchanged: aText === 'Note A' && aWrites.length === 0,
    aNotKept: outcome === 'deny' ? aOnServer === 'Alice' : aOnServer === null,
    noImeAnywhere: bAfterIme === 'Note B' && !`${aText}${bText}`.includes('IME'),
    oneAcquireEach:
      acq.filter((id) => id === A.note).length === 1 && acq.filter((id) => id === B.note).length === 1,
    bText: bOk,
    bWritesHeld: bWrites.every((w) => w.held) && (granted ? bWrites.length > 0 : bWrites.length === 0),
    bReleasedAfterWrite: granted ? bReleases.length === 1 && bReleases[0]?.text === bText : true,
    answerState: granted
      ? afterAnswer.phase === 'open' && afterAnswer.leaseId === B.note
      : afterAnswer.phase === 'idle',
    nothingHeld: heldAtEnd.length === 0,
  }
  const ok = Object.values(checks).every(Boolean)
  return {
    i,
    ok,
    failed: Object.keys(checks).filter((k) => !checks[k]),
    startKey,
    afterB: {
      phase: afterB.phase,
      lease: afterB.leaseId,
      origin: afterB.origin,
      editing: afterB.editingId,
      textareas: afterB.textareas,
      readOnly: afterB.textarea?.readOnly ?? null,
    },
    valueAfterIme,
    bAfterIme,
    stored: { A: aText, B: bText },
    acquires: acq,
    releases: report.releases,
    violations: report.violations.slice(0, 6),
    agreement: { afterB: agreeAfterB.issues, afterAnswer: agreeAfterAnswer.issues, end: agreeEnd.issues },
  }
}

test.describe('A16 regression: another editor while a lease request is pending', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000)
    await openLab(page, { grant: 'manual' })
    await warm(page)
  })

  for (const action of ['dblclick-label', 'p5', 'type-to-edit'] as const) {
    for (const outcome of ['grant', 'manual-grant', 'deny', 'escape'] as const) {
      test(`pending A + ${action} on B, then ${outcome}: selecting B cancels A (keys discarded, notice); B only through its own lease; no lease-less writable editor; 20/20`, async ({
        page,
      }) => {
        const watch = watchPage(page)
        const rows: Record<string, unknown>[] = []
        for (let i = 0; i < N; i++) rows.push(await pendingCase(page, action, outcome, i))
        const fails = rows.filter((r) => !r.ok)
        console.log(
          `A16-PENDING-${action}-${outcome}`,
          JSON.stringify({ pass: N - fails.length, of: N, sample: rows[0], fails: fails.slice(0, 4) }),
        )
        expect(fails).toEqual([])
        expect(watch.pageErrors).toEqual([])
      })
    }
  }
})

// --- Text that arrives without a keydown ------------------------------------------------------------

type Channel = 'insertText' | 'ime' | 'key229' | 'paste' | 'drop'
const CHANNELS: Channel[] = ['insertText', 'ime', 'key229', 'paste', 'drop']

/** Sends text into the focused textarea through one channel (CDP for IME, 229 and drop). */
async function send(page: Page, cdp: CDPSession, channel: Channel): Promise<string> {
  switch (channel) {
    case 'insertText':
      await page.keyboard.insertText('IME')
      return 'IME'
    case 'ime':
      await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 })
      await cdp.send('Input.imeSetComposition', { text: 'かな', selectionStart: 2, selectionEnd: 2 })
      await cdp.send('Input.insertText', { text: 'かな' })
      return 'かな'
    case 'key229':
      // An Android soft keyboard / IME: keydown 229 ("Process"), then the text as an input.
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        windowsVirtualKeyCode: 229,
        nativeVirtualKeyCode: 229,
        key: 'Process',
        code: 'KeyP',
      })
      await cdp.send('Input.insertText', { text: 'p229' })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 229,
        key: 'Process',
        code: 'KeyP',
      })
      return 'p229'
    case 'paste':
      // Excalidraw's own editable.onpaste writes Excalidraw clipboard text into the value by script
      // (index.js 25303-25320), which readOnly alone would not stop.
      await page.evaluate(() => {
        const ta = document.activeElement as HTMLTextAreaElement | null
        if (ta?.tagName !== 'TEXTAREA') throw new Error('no focused textarea')
        const dt = new DataTransfer()
        const text = {
          type: 'text',
          id: 'pasted',
          x: 0,
          y: 0,
          width: 50,
          height: 25,
          text: 'PASTE',
          originalText: 'PASTE',
          fontSize: 20,
          fontFamily: 6,
          isDeleted: false,
        }
        dt.setData(
          'application/vnd.excalidraw.clipboard+json',
          JSON.stringify({ type: 'excalidraw/clipboard', elements: [text], files: {} }),
        )
        dt.setData(
          'text/plain',
          JSON.stringify({ type: 'excalidraw/clipboard', elements: [text], files: {} }),
        )
        ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })
      await settle(page, 60)
      return 'PASTE'
    case 'drop': {
      const box = await page.evaluate(() => {
        const r = document.activeElement?.getBoundingClientRect()
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
      })
      if (!box) throw new Error('no focused element')
      const data = { items: [{ mimeType: 'text/plain', data: 'DROP' }], dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await cdp.send('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data })
      }
      return 'DROP'
    }
  }
}

test.describe('A16 regression: text without a keydown', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000)
    await openLab(page, { grant: 'manual' })
    await warm(page)
  })

  test('idle guard: P5 on B, then insertText, IME, keyCode 229, paste and drop into its read-only editor; then B is granted; 20/20', async ({
    page,
  }) => {
    const watch = watchPage(page)
    const cdp = await page.context().newCDPSession(page)
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await lab(page, (x) => x.lease.setDelay('manual'))
      const B = await addNote(page, { id: `B${i}`, x: 480, y: 160, size: 200, text: 'Note B' })
      await monitorStart(page)
      const pb = await bodyPoint(page, B.note)
      await page.mouse.click(pb.x, pb.y)
      await page.waitForTimeout(600)
      const lb = await centerOf(page, B.label ?? '')
      await page.mouse.click(lb.x, lb.y)
      await settle(page, 40)
      const s0 = await editor(page)
      const perChannel: Record<string, unknown> = {}
      for (const ch of CHANNELS) {
        const before = (await editor(page)).textarea?.value ?? null
        await send(page, cdp, ch)
        await settle(page, 40)
        const st = await editor(page)
        perChannel[ch] = {
          unchanged: st.textarea?.value === before && before === 'Note B',
          stored: await labelText(page, B),
          open: st.phase,
        }
      }
      const beforeGrant = await editor(page)
      await lab(page, (x) => x.lease.flush())
      const opened = await waitEditor(
        page,
        (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly,
      ).catch(() => editor(page))
      await page.keyboard.type('ok')
      await settle(page, 40)
      const value = (await editor(page)).textarea?.value ?? null
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null).catch(() => {})
      await lab(page, (x) => x.lease.flush())
      await settle(page, 40)
      const report = await monitorReport(page)
      const stored = await labelText(page, B)
      const bReleases = report.releases.filter((r) => r.id === B.note)
      const checks: Record<string, boolean> = {
        guarded: s0.phase === 'pending' && s0.origin === 'guard' && s0.textarea?.readOnly === true,
        channelsBlocked: Object.values(perChannel).every(
          (c) =>
            (c as { unchanged: boolean; stored: string }).unchanged &&
            (c as { stored: string }).stored === 'Note B',
        ),
        stillGuarded: beforeGrant.phase === 'pending' && beforeGrant.textarea?.readOnly === true,
        opened: opened.phase === 'open',
        typedAfterGrant: value !== null && value.replace('ok', '') === 'Note B',
        stored: stored === value,
        noViolations: report.violations.length === 0,
        writesHeld: report.textWrites.every((w) => w.held),
        releasedAfterWrite: bReleases.length === 1 && bReleases[0]?.text === value,
        // No input event reached a textarea whose lease was not held (beforeinput is blocked before it).
        noUnleasedInput: report.inputs.filter((x) => x.type === 'input' && !x.leased).length === 0,
      }
      rows.push({
        i,
        ok: Object.values(checks).every(Boolean),
        failed: Object.keys(checks).filter((k) => !checks[k]),
        perChannel,
        value,
        stored,
        violations: report.violations.slice(0, 4),
      })
    }
    const fails = rows.filter((r) => !r.ok)
    console.log(
      'A16-NOKEYDOWN-GUARD',
      JSON.stringify({ pass: N - fails.length, of: N, sample: rows[0], fails: fails.slice(0, 4) }),
    )
    expect(fails).toEqual([])
    expect(watch.pageErrors).toEqual([])
  })

  // Drop is not a live channel even into a granted editor: Excalidraw's container prevents every dragover
  // and drop (disableEvent, index.js:43022, attached at 49404-49416). Lobby prevents it earlier for a
  // not-granted editor anyway.
  test('CONTROL: insertText, IME, keyCode 229 and paste DO type into a granted editor (the probes are live)', async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page)
    await lab(page, (x) => x.lease.setDelay(30))
    const live: Record<string, boolean> = {}
    for (const ch of CHANNELS) {
      await resetLab(page)
      const A = await addNote(page, { x: 200, y: 160, size: 200, text: 'Note A' })
      await select(page, [A.note])
      await focusCanvas(page)
      await page.keyboard.press('Enter')
      await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly)
      const text = await send(page, cdp, ch)
      await settle(page, 60)
      live[ch] = ((await editor(page)).textarea?.value ?? '').includes(text)
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle').catch(() => {})
    }
    console.log('A16-NOKEYDOWN-CONTROL', JSON.stringify(live))
    expect(live).toEqual({ insertText: true, ime: true, key229: true, paste: true, drop: false })
  })

  test('A granted and open, then a double-click on B: A written before its release; B only through its own lease; 20/20', async ({
    page,
  }) => {
    const watch = watchPage(page)
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await lab(page, (x) => x.lease.setDelay('manual'))
      const A = await addNote(page, { id: `A${i}`, x: 80, y: 160, size: 200, text: 'Note A' })
      const B = await addNote(page, { id: `B${i}`, x: 480, y: 160, size: 200, text: 'Note B' })
      await monitorStart(page)
      await select(page, [A.note])
      await focusCanvas(page)
      await page.keyboard.press('Enter')
      await lab(page, (x) => x.lease.flush())
      await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly)
      await page.keyboard.type('zq')
      await settle(page, 40)
      const lb = await centerOf(page, B.label ?? '')
      await page.mouse.dblclick(lb.x, lb.y)
      await settle(page, 60)
      const afterB = await editor(page)
      const agreeAfterB = await agreement(page)
      await page.keyboard.insertText('IME')
      await settle(page, 40)
      const bAfterIme = await labelText(page, B)
      await lab(page, (x) => x.lease.flush())
      const bOpen = await waitEditor(
        page,
        (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly,
        3000,
      ).catch(() => editor(page))
      if (bOpen.phase === 'open') await page.keyboard.type('ok')
      await settle(page, 40)
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null).catch(() => {})
      await lab(page, (x) => x.lease.flush())
      await settle(page, 40)
      const report = await monitorReport(page)
      const aText = await labelText(page, A)
      const bText = await labelText(page, B)
      const aRel = report.releases.filter((r) => r.id === A.note)
      const bRel = report.releases.filter((r) => r.id === B.note)
      const checks: Record<string, boolean> = {
        noViolations: report.violations.length === 0,
        agreeAfterB: agreeAfterB.ok,
        aWritten: aText === 'Note Azq',
        aReleasedAfterWrite: aRel.length === 1 && aRel[0]?.text === 'Note Azq',
        bNotWrittenBeforeGrant: bAfterIme === 'Note B',
        bWritesHeld: textWritesOf(report, B.note).every((w) => w.held),
        bResult:
          bOpen.phase === 'open'
            ? bText !== undefined &&
              // a double-click opens with all the text selected (the replay replaces it), a click at a caret
              (bText === 'ok' || bText.replace('ok', '') === 'Note B') &&
              bRel.length === 1 &&
              bRel[0]?.text === bText
            : bText === 'Note B',
        agreeEnd: (await agreement(page)).ok,
      }
      rows.push({
        i,
        ok: Object.values(checks).every(Boolean),
        failed: Object.keys(checks).filter((k) => !checks[k]),
        afterB: {
          phase: afterB.phase,
          origin: afterB.origin,
          lease: afterB.leaseId,
          readOnly: afterB.textarea?.readOnly ?? null,
        },
        bOpened: bOpen.phase,
        stored: { A: aText, B: bText },
        releases: report.releases,
        violations: report.violations.slice(0, 4),
      })
    }
    const fails = rows.filter((r) => !r.ok)
    console.log(
      'A16-GRANTED-THEN-B',
      JSON.stringify({ pass: N - fails.length, of: N, sample: rows[0], fails: fails.slice(0, 4) }),
    )
    expect(fails).toEqual([])
    expect(watch.pageErrors).toEqual([])
  })
})
