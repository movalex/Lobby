import { expect, type Page, test } from '@playwright/test'
import { watchPage } from '../support/watch.ts'
import {
  acquires,
  addNote,
  agreement,
  bodyPoint,
  centerOf,
  editor,
  element,
  elements,
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
  toClient,
  waitEditor,
} from './host-kit.ts'

// A16 fix round 2: the second verifier's defects (docs/research/excalidraw/SPIKE-A-REPORT.md §0), each
// turned into a regression gate. host-lab's monitor (independent of EditorLease) runs in every case: no
// textarea may be writable or take input unless this session HOLDS the lease ("created here" is not a
// lease; only the FIRST open of a just-created element may be writable before its grant, while the
// acquire is out and the server names no other holder); 'pending' always has exactly one live request
// and a visible affordance; 'idle' has none.
//
//  1 (high)  "created here" is one-shot: a later open of a note this session created is an ordinary lease
//            request, and never overrides another session's live lease (plan open item 7).
//  2 (med)   cancel, then re-open within one round trip: the re-open gets its own request and answer.
//  5 (low)   a granted Enter on an unlabelled container whose centre another text covers opens the
//            container's own label.
//  6 (low)   a remote delete or label re-create while typing closes the editor WITHOUT Excalidraw's submit:
//            nothing is resurrected or duplicated, and the typed text is offered ("Copy my text").
//  7 (low)   the lease lost while open: read-only at once, the lost-lease banner, no write after the loss,
//            no release sent.
//  8 (low)   selecting another element while a request is pending cancels it (keys discarded, notice).

const N = Number(process.env.SPIKE_FIX2_REPS ?? 10)

async function warm(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.load('20px Nunito', 'Note A B zqxkKIMEok'))
}

const labelOf = async (page: Page, containerId: string) =>
  (await elements(page)).filter((e) => e.type === 'text' && e.containerId === containerId && !e.isDeleted)

const noticesOf = (page: Page) =>
  lab(page, (x) =>
    x.notices.map(
      (n: { kind: string; leaseId: string; text: string | null; message: string; copied: boolean }) => ({
        kind: n.kind,
        leaseId: n.leaseId,
        text: n.text,
        message: n.message,
        copied: n.copied,
      }),
    ),
  ) as Promise<{ kind: string; leaseId: string; text: string | null; message: string; copied: boolean }[]>

const traceTypes = (page: Page) =>
  lab(page, (x) =>
    x.traces.filter((t: { type: string }) => t.type !== 'key').map((t: { type: string }) => t.type),
  ) as Promise<string[]>

const upReleases = (page: Page) =>
  lab(page, (x) =>
    x.lease
      .log()
      .filter(
        (l: { dir: string; message: { type: string } }) =>
          l.dir === 'up' && l.message.type === 'lease.release',
      )
      .map((l: { message: { id: string } }) => l.message.id),
  ) as Promise<string[]>

const unheldWrites = (r: MonitorReport) =>
  r.textWrites.filter((w) => !w.held && !(w as { provisional?: boolean }).provisional)

/** Lobby's N tool: a note created here, opened at once (New element), `text` typed, closed, answered. */
async function noteWithN(page: Page, text: string, at = { x: 300, y: 260 }): Promise<NoteIds> {
  await focusCanvas(page)
  await page.keyboard.press('n')
  const p = await toClient(page, at.x, at.y)
  await page.mouse.click(p.x, p.y)
  await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly)
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null)
  await lab(page, (x) => x.lease.flush())
  await settle(page, 60)
  const note = (await elements(page)).find((e) => e.type === 'stickynote' && !e.isDeleted)
  if (!note) throw new Error('no note')
  const label = (await labelOf(page, note.id))[0]
  return { note: note.id, label: label?.id ?? null }
}

/** P5: a click on the note's body (selects it), a pause, a click on its label. */
async function p5(page: Page, ids: NoteIds): Promise<void> {
  const pb = await bodyPoint(page, ids.note)
  await page.mouse.click(pb.x, pb.y)
  await page.waitForTimeout(600)
  const lb = await centerOf(page, ids.label ?? '')
  await page.mouse.click(lb.x, lb.y)
}

function report(name: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const fails = rows.filter((r) => !r.ok)
  console.log(
    name,
    JSON.stringify({
      pass: rows.length - fails.length,
      of: rows.length,
      sample: rows[0],
      fails: fails.slice(0, 3),
    }),
  )
  return fails
}

function verdict(checks: Record<string, boolean>) {
  return { ok: Object.values(checks).every(Boolean), failed: Object.keys(checks).filter((k) => !checks[k]) }
}

// --- 1. "created here" ---------------------------------------------------------------------------------

test.describe('fix 1: "created here" is the first open only, and never overrides a live lease', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000)
    await openLab(page, { grant: 'manual' })
    await warm(page)
  })

  test('the first open of a note just made with N opens at once, the acquire goes out in parallel; the monitor allows it only until the grant', async ({
    page,
  }) => {
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await monitorStart(page)
      await focusCanvas(page)
      await page.keyboard.press('n')
      const p = await toClient(page, 300 + i, 260)
      await page.mouse.click(p.x, p.y)
      const st = await waitEditor(
        page,
        (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly,
      )
      await page.keyboard.type('new')
      await settle(page, 40)
      const acq = await acquires(page)
      const note = (await elements(page)).find((e) => e.type === 'stickynote')?.id ?? ''
      const heldBeforeGrant = await lab(page, (x, id) => x.lease.isHeld(id), note)
      await lab(page, (x) => x.lease.flush())
      await settle(page, 40)
      const heldAfterGrant = await lab(page, (x, id) => x.lease.isHeld(id), note)
      await page.keyboard.type('!')
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null)
      await lab(page, (x) => x.lease.flush())
      const r = await monitorReport(page)
      const stored = (await labelOf(page, note))[0]?.originalText
      rows.push({
        i,
        ...verdict({
          openedAtOnce: st.origin === 'new' && acq.length === 1 && acq[0] === note && !heldBeforeGrant,
          grantHeld: heldAfterGrant,
          stored: stored === 'new!',
          noViolations: r.violations.length === 0,
          writesHeldOrProvisional: unheldWrites(r).length === 0,
          releasedAfterWrite: r.releases.length === 1 && r.releases[0]?.text === 'new!',
        }),
        stored,
        violations: r.violations.slice(0, 3),
      })
    }
    expect(report('FIX1-FIRST-OPEN', rows)).toEqual([])
  })

  for (const path of ['P1-enter', 'P2-type', 'P5-click'] as const) {
    test(`a later ${path} on a note this session made, while Alice holds its lease: never writable, acquire sent, nothing written; ${N}/${N}`, async ({
      page,
    }) => {
      const watch = watchPage(page)
      const rows: Record<string, unknown>[] = []
      for (let i = 0; i < N; i++) {
        await resetLab(page)
        const ids = await noteWithN(page, 'mine', { x: 300 + i, y: 260 })
        await lab(page, (x, id) => x.lease.holdByOther(id), ids.note)
        await monitorStart(page)
        const acq0 = (await acquires(page)).length
        if (path === 'P5-click') {
          await p5(page, ids)
        } else {
          await select(page, [ids.note])
          await focusCanvas(page)
          await page.keyboard.press(path === 'P1-enter' ? 'Enter' : 'q')
        }
        await settle(page, 150)
        const opened = await editor(page)
        await page.keyboard.type('EVIL')
        await settle(page, 60)
        const typed = await editor(page)
        await lab(page, (x) => x.lease.flush())
        await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null, 3000).catch(() => {})
        await settle(page, 60)
        const acq = (await acquires(page)).slice(acq0)
        const r = await monitorReport(page)
        const stored = (await labelOf(page, ids.note))[0]?.originalText
        const toasts = await lab(page, (x) => x.toasts)
        rows.push({
          i,
          ...verdict({
            notNew: opened.origin !== 'new',
            neverWritable:
              (opened.textarea === null || opened.textarea.readOnly) &&
              (typed.textarea === null || typed.textarea.readOnly),
            acquireSent: acq.length === 1 && acq[0] === ids.note,
            unchanged: stored === 'mine' && r.textWrites.length === 0,
            denied: toasts.some((t: string) => t.includes('Alice')),
            noViolations: r.violations.length === 0,
            idleAtEnd: (await agreement(page)).ok,
          }),
          opened: { phase: opened.phase, origin: opened.origin, readOnly: opened.textarea?.readOnly ?? null },
          stored,
          violations: r.violations.slice(0, 3),
        })
      }
      expect(report(`FIX1-LATER-${path}-ALICE`, rows)).toEqual([])
      expect(watch.pageErrors).toEqual([])
    })
  }

  test(`a later P5 on a note this session made, nobody holding it: the lease is asked for and held for every keystroke; ${N}/${N}`, async ({
    page,
  }) => {
    await lab(page, (x) => x.lease.setDelay(30))
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      await lab(page, (x) => x.lease.setDelay(30))
      const ids = await noteWithN(page, 'mine', { x: 300 + i, y: 260 })
      await monitorStart(page)
      const acq0 = (await acquires(page)).length
      await p5(page, ids)
      const opened = await waitEditor(page, (e) => e.phase === 'open' && !e.textarea?.readOnly, 3000).catch(
        () => editor(page),
      )
      const held: boolean[] = []
      for (const ch of ['a', 'b', 'c']) {
        await page.keyboard.type(ch)
        held.push(await lab(page, (x, id) => x.lease.isHeld(id), ids.note))
      }
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null, 3000).catch(() => {})
      await settle(page, 80)
      const r = await monitorReport(page)
      const stored = String((await labelOf(page, ids.note))[0]?.originalText ?? '')
      rows.push({
        i,
        ...verdict({
          guarded: opened.origin === 'guard',
          acquired: (await acquires(page)).slice(acq0).join() === ids.note,
          heldWhileTyping: held.every(Boolean),
          stored: stored.replace('abc', '') === 'mine',
          writesHeld: r.textWrites.length > 0 && r.textWrites.every((w) => w.held),
          noViolations: r.violations.length === 0,
        }),
        stored,
        held,
      })
    }
    expect(report('FIX1-LATER-P5-FREE', rows)).toEqual([])
  })

  test('created here, but another session is known to hold the lease before the first open: no New-element open (open item 7)', async ({
    page,
  }) => {
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      const ids = await addNote(page, { id: `C${i}`, x: 200, y: 160, size: 200, text: '' })
      await lab(page, (x, id) => x.lease.holdByOther(id), ids.note)
      await monitorStart(page)
      const started = await lab(
        page,
        (x, id) => {
          x.lease.client.markCreated(id)
          return x.input.editorLease.requestEdit(id, { reason: 'new-note', caretEnd: true })
        },
        ids.note,
      )
      await settle(page, 80)
      const st = await editor(page)
      await page.keyboard.type('EVIL')
      await lab(page, (x) => x.lease.flush())
      await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null, 3000).catch(() => {})
      const r = await monitorReport(page)
      rows.push({
        i,
        ...verdict({
          started,
          ordinaryRequest: st.origin === 'lobby' && st.phase === 'pending' && st.textarea === null,
          nothingWritten:
            r.textWrites.length === 0 &&
            !(await elements(page)).some((e) => e.type === 'text' && String(e.originalText).includes('EVIL')),
          noViolations: r.violations.length === 0,
        }),
        st: { phase: st.phase, origin: st.origin },
      })
    }
    expect(report('FIX1-CREATED-BUT-HELD', rows)).toEqual([])
  })

  test('CONTROL: the monitor flags a writable editor on a created-here note after its first open (the old bypass)', async ({
    page,
  }) => {
    await resetLab(page)
    const ids = await noteWithN(page, 'mine')
    await monitorStart(page)
    await p5(page, ids)
    await settle(page, 60)
    const st = await editor(page)
    // What the old "created here" shortcut did: the guard's textarea writable with no lease.
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')
      if (ta) ta.readOnly = false
    })
    await settle(page, 60)
    const r = await monitorReport(page)
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')
      if (ta) ta.readOnly = true
    })
    await page.keyboard.press('Escape')
    const flagged = r.violations.filter((v) => v.kind === 'writable-editor-without-lease')
    console.log(
      'FIX1-MONITOR-CONTROL',
      JSON.stringify({ st: { phase: st.phase, origin: st.origin }, flagged: flagged.slice(0, 2) }),
    )
    expect(st).toMatchObject({ phase: 'pending', origin: 'guard' })
    expect(flagged.length).toBeGreaterThan(0)
    expect(flagged[0]).toMatchObject({ createdHere: true, firstOpen: false })
  })
})

// --- 2. cancel, then re-open within one round trip ---------------------------------------------------

test.describe('fix 2: cancel then re-open within one round trip', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000)
    await openLab(page, { grant: 'manual' })
    await warm(page)
  })

  for (const variant of [
    'P1-manual',
    'P1-timed-300',
    'P2-manual',
    'guard-then-dblclick',
    'deny-then-reopen',
  ] as const) {
    test(`${variant}: the re-open gets its own request and answer; never stuck pending; ${N}/${N}`, async ({
      page,
    }) => {
      const rows: Record<string, unknown>[] = []
      for (let i = 0; i < N; i++) {
        await resetLab(page)
        await lab(page, (x, d) => x.lease.setDelay(d), variant === 'P1-timed-300' ? 300 : 'manual')
        const A = await addNote(page, { id: `A${variant}${i}`, x: 120, y: 160, size: 200, text: 'Note A' })
        if (variant === 'deny-then-reopen') await lab(page, (x, id) => x.lease.holdByOther(id), A.note)
        await monitorStart(page)
        const k = variant === 'P2-manual' ? 'k' : 'Enter'
        let affordance = false
        if (variant === 'guard-then-dblclick') {
          await p5(page, A)
          await settle(page, 60)
          const empty = await toClient(page, 700, 600)
          await page.mouse.click(empty.x, empty.y)
          await settle(page, 60)
          await page.waitForTimeout(400)
          const lb = await centerOf(page, A.label ?? '')
          await page.mouse.dblclick(lb.x, lb.y)
        } else {
          await select(page, [A.note])
          await focusCanvas(page)
          await page.keyboard.press(k)
          await settle(page, 20)
          if (variant === 'deny-then-reopen') {
            await lab(page, (x) => x.lease.flush())
            await settle(page, 30)
            await lab(page, (x, id) => x.lease.clearOther(id), A.note)
          } else {
            await page.keyboard.press('Escape')
          }
          await settle(page, 20)
          await focusCanvas(page)
          await select(page, [A.note])
          await page.keyboard.press(k)
        }
        await settle(page, 40)
        affordance = await lab(page, (x) => x.pendingVisible())
        const pendingState = await editor(page)
        await page.keyboard.type('abc')
        await lab(page, (x) => x.lease.flush())
        await page.waitForTimeout(variant === 'P1-timed-300' ? 900 : 300)
        await lab(page, (x) => x.lease.flush())
        const opened = await waitEditor(
          page,
          (e) => e.phase === 'open' && !!e.textarea && !e.textarea.readOnly,
          3000,
        ).catch(() => editor(page))
        await page.keyboard.type('def')
        await settle(page, 40)
        await page.keyboard.press('Escape')
        await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null, 3000).catch(() => {})
        await lab(page, (x) => x.lease.flush())
        await settle(page, 60)
        // A timed server answers the release after its delay.
        await page
          .waitForFunction(
            (id) =>
              (
                window as unknown as {
                  __lobbySpike: { extra: { lease: { server: { holderOf(i: string): unknown } } } }
                }
              ).__lobbySpike.extra.lease.server.holderOf(id) === null,
            A.note,
            { timeout: 2000 },
          )
          .catch(() => {})
        const r = await monitorReport(page)
        const stored = String((await element(page, A.label ?? ''))?.originalText ?? '')
        const typed = `${k === 'k' ? 'k' : ''}abcdef`
        const rest = stored.replace(typed, '')
        rows.push({
          i,
          ...verdict({
            pendingWithAffordance: pendingState.phase === 'pending' && affordance,
            opened: opened.phase === 'open' && opened.leaseId === A.note,
            stored: stored.includes(typed) && (rest === 'Note A' || rest === ''),
            nothingHeld: !(await lab(page, (x, id) => x.lease.isHeld(id), A.note)),
            serverFree: (await lab(page, (x, id) => x.lease.server.holderOf(id), A.note)) === null,
            noViolations: r.violations.length === 0,
            agreeEnd: (await agreement(page)).ok,
          }),
          pendingState: { phase: pendingState.phase, origin: pendingState.origin },
          opened: { phase: opened.phase, origin: opened.origin },
          stored,
          violations: r.violations.slice(0, 3),
          log: await lab(page, (x) =>
            x.lease
              .log()
              .map(
                (l: { dir: string; message: { type: string; req?: number } }) =>
                  `${l.dir}:${l.message.type}:${l.message.req ?? ''}`,
              ),
          ),
        })
      }
      expect(report(`FIX2-${variant}`, rows)).toEqual([])
    })
  }

  test("CONTROL: the monitor flags 'pending' with no live request (the old stuck state)", async ({
    page,
  }) => {
    await resetLab(page)
    const A = await addNote(page, { id: 'Actl', x: 120, y: 160, size: 200, text: 'Note A' })
    await monitorStart(page)
    await select(page, [A.note])
    await focusCanvas(page)
    await page.keyboard.press('Enter')
    // What the old LeaseClient left behind: Lobby pending while its request is already resolved/cancelled.
    await lab(page, (x, id) => x.lease.client.cancel(id), A.note)
    await settle(page, 60)
    const r = await monitorReport(page)
    await page.keyboard.press('Escape')
    const flagged = r.violations.filter((v) => v.kind === 'pending-invariant')
    console.log('FIX2-MONITOR-CONTROL', JSON.stringify(flagged.slice(0, 1)))
    expect(flagged.length).toBeGreaterThan(0)
  })
})

// --- 5. a granted Enter on an unlabelled container covered by another text ------------------------------

test.describe('fix 5: a granted Enter on an unlabelled container opens its own label', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000)
    await openLab(page, { grant: 'manual' })
    await warm(page)
  })

  for (const variant of ['free-text', 'other-note-label', 'uncovered'] as const) {
    test(`${variant}: the typed keys land in the container's own label; the other text is unchanged; ${N}/${N}`, async ({
      page,
    }) => {
      const rows: Record<string, unknown>[] = []
      for (let i = 0; i < N; i++) {
        await resetLab(page)
        const ids = await lab(
          page,
          (x, v) => {
            const r = x.fixture.add([
              {
                type: 'rectangle',
                id: `R${v}`,
                x: 100,
                y: 100,
                width: 300,
                height: 200,
                backgroundColor: '#ffffff',
                fillStyle: 'solid',
              },
            ])[0]
            if (v === 'free-text') {
              const t = x.fixture.add([
                { type: 'text', id: `T${v}`, x: 200, y: 185, text: 'Free T', fontSize: 20, fontFamily: 6 },
              ])[0]
              return { r, other: t, otherText: 'Free T' }
            }
            if (v === 'other-note-label') {
              const n = x.fixture.note({ id: `M${v}`, x: 150, y: 120, size: 200, text: 'Note M' })
              return { r, other: n.label, otherText: 'Note M' }
            }
            return { r, other: null, otherText: null }
          },
          variant,
        )
        await monitorStart(page)
        await select(page, [ids.r])
        await focusCanvas(page)
        await page.keyboard.press('Enter')
        await page.keyboard.type('hello')
        await lab(page, (x) => x.lease.flush())
        const opened = await waitEditor(
          page,
          (e) => e.phase === 'open' && !!e.textarea && !e.textarea.readOnly,
          3000,
        ).catch(() => editor(page))
        await page.keyboard.type('XY')
        await settle(page, 40)
        await page.keyboard.press('Escape')
        await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null, 3000).catch(() => {})
        await lab(page, (x) => x.lease.flush())
        await settle(page, 60)
        const els = await elements(page)
        const rLabels = els.filter((e) => e.type === 'text' && e.containerId === ids.r && !e.isDeleted)
        const other = ids.other ? els.find((e) => e.id === ids.other) : null
        const r = await monitorReport(page)
        const traces = await traceTypes(page)
        rows.push({
          i,
          ...verdict({
            openedOnR: opened.phase === 'open' && opened.leaseId === ids.r,
            ownLabel: rLabels.length === 1 && rLabels[0]?.originalText === 'helloXY',
            otherUnchanged: ids.otherText === null || other?.originalText === ids.otherText,
            labelPrecreatedOnlyWhenCovered: traces.includes('own-label') === (variant !== 'uncovered'),
            noViolations: r.violations.length === 0,
            nothingHeld: !(await lab(page, (x, id) => x.lease.isHeld(id), ids.r)),
          }),
          rLabels: rLabels.map((e) => e.originalText),
          other: other?.originalText ?? null,
          traces,
          violations: r.violations.slice(0, 3),
        })
      }
      expect(report(`FIX5-${variant}`, rows)).toEqual([])
    })
  }
})

// --- 6. remote delete / label re-create while typing -------------------------------------------------

async function remoteChange(page: Page, variant: string, A: NoteIds): Promise<void> {
  await lab(
    page,
    (_x, a) => {
      const spike = (
        window as unknown as {
          __lobbySpike: {
            api: {
              getSceneElementsIncludingDeleted(): Record<string, unknown>[]
              updateScene(d: unknown): void
            }
            lib: { CaptureUpdateAction: { NEVER: unknown } }
          }
        }
      ).__lobbySpike
      const els = spike.api.getSceneElementsIncludingDeleted()
      const bump = (e: Record<string, unknown>, patch: Record<string, unknown>) => ({
        ...e,
        ...patch,
        version: (e.version as number) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
      })
      let next = els
      if (a.variant === 'delete-note-and-label') {
        next = els.map((e) => (e.id === a.note || e.id === a.label ? bump(e, { isDeleted: true }) : e))
      } else if (a.variant === 'delete-label') {
        next = els.map((e) =>
          e.id === a.label
            ? bump(e, { isDeleted: true })
            : e.id === a.note
              ? bump(e, { boundElements: [] })
              : e,
        )
      } else {
        const old = els.find((e) => e.id === a.label) ?? {}
        const fresh = {
          ...old,
          id: `${a.label}-remote`,
          text: 'Remote',
          originalText: 'Remote',
          version: 1,
          versionNonce: 7,
          seed: 7,
        }
        next = [
          ...els.map((e) =>
            e.id === a.label
              ? bump(e, { isDeleted: true })
              : e.id === a.note
                ? bump(e, { boundElements: [{ type: 'text', id: `${a.label}-remote` }] })
                : e,
          ),
          fresh,
        ]
      }
      spike.api.updateScene({ elements: next, captureUpdate: spike.lib.CaptureUpdateAction.NEVER })
    },
    { variant, note: A.note, label: A.label },
  )
}

test.describe('fix 6: a remote delete or label re-create while typing', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000)
    await openLab(page, { grant: 30 })
    await warm(page)
  })

  for (const start of ['granted', 'guard-pending'] as const) {
    for (const variant of ['delete-note-and-label', 'delete-label', 'recreate-label'] as const) {
      test(`${start}, ${variant}: the editor closes without Excalidraw's submit; nothing resurrected or duplicated; text offered; ${N}/${N}`, async ({
        page,
      }) => {
        const watch = watchPage(page)
        const rows: Record<string, unknown>[] = []
        for (let i = 0; i < N; i++) {
          await resetLab(page)
          await lab(page, (x, d) => x.lease.setDelay(d), start === 'granted' ? 30 : 'manual')
          const A = await addNote(page, { id: `A${variant}${i}`, x: 120, y: 160, size: 200, text: 'Note A' })
          if (start === 'granted') {
            await select(page, [A.note])
            await focusCanvas(page)
            await page.keyboard.press('Enter')
            await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly)
            await page.keyboard.type('zq')
          } else {
            await p5(page, A)
            await waitEditor(
              page,
              (e) => e.phase === 'pending' && e.origin === 'guard' && !!e.textarea?.readOnly,
            )
            await page.keyboard.type('zq') // buffered
          }
          await settle(page, 60)
          const before = await element(page, A.label ?? '')
          await monitorStart(page)
          await remoteChange(page, variant, A)
          await settle(page, 200)
          const after = await editor(page)
          await page.keyboard.type('KK').catch(() => {})
          await lab(page, (x) => x.lease.flush())
          await settle(page, 100)
          const copied = await lab(page, (x) => x.copyNoticeText())
          const els = await elements(page)
          const noteEl = els.find((e) => e.id === A.note)
          const old = els.find((e) => e.id === A.label)
          const bound = els.filter((e) => e.type === 'text' && e.containerId === A.note && !e.isDeleted)
          const r = await monitorReport(page)
          const notices = await noticesOf(page)
          const gone = notices.find((n) => n.kind === 'label-gone')
          const oldUnchanged =
            !!old &&
            !!before &&
            old.originalText === before.originalText &&
            old.version === (before.version as number) + 1 &&
            old.isDeleted === true
          const shape: Record<string, boolean> = {
            'delete-note-and-label': noteEl?.isDeleted === true && bound.length === 0,
            'delete-label':
              noteEl?.isDeleted === false &&
              bound.length === 0 &&
              (noteEl?.boundElements as unknown[] | undefined)?.length === 0,
            'recreate-label':
              noteEl?.isDeleted === false &&
              bound.length === 1 &&
              bound[0]?.id === `${A.label}-remote` &&
              bound[0]?.originalText === 'Remote' &&
              JSON.stringify(noteEl?.boundElements) ===
                JSON.stringify([{ type: 'text', id: `${A.label}-remote` }]),
          }
          rows.push({
            i,
            ...verdict({
              closed: after.phase === 'idle' && after.textareas === 0,
              oldLabelStaysDeletedUnwritten: oldUnchanged,
              sceneAsRemoteLeftIt: shape[variant] === true,
              noWriteAfterRemote: r.textWrites.length === 0,
              textOffered: !!gone && (gone.text ?? '').includes('zq') && copied === 1,
              noViolations: r.violations.length === 0,
              nothingHeld: !(await lab(page, (x, id) => x.lease.isHeld(id), A.note)),
              agreeEnd: (await agreement(page)).ok,
            }),
            after: { phase: after.phase, textareas: after.textareas },
            old: old ? { text: old.originalText, isDeleted: old.isDeleted, version: old.version } : null,
            before: before ? { text: before.originalText, version: before.version } : null,
            bound: bound.map((e) => ({ id: e.id, text: e.originalText })),
            noteBound: noteEl?.boundElements,
            notices,
            violations: r.violations.slice(0, 3),
          })
        }
        expect(report(`FIX6-${start}-${variant}`, rows)).toEqual([])
        expect(watch.pageErrors).toEqual([])
      })
    }
  }
})

// --- 7. the lease lost while the editor is open -----------------------------------------------------

test.describe('fix 7: the lease lost while open (§2.9.3, minimal)', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000)
    await openLab(page, { grant: 30 })
    await warm(page)
  })

  for (const leave of ['escape', 'click-away'] as const) {
    test(`read-only at once, the banner, no write after the loss, no release sent; left with ${leave}; ${N}/${N}`, async ({
      page,
    }) => {
      const watch = watchPage(page)
      const rows: Record<string, unknown>[] = []
      for (let i = 0; i < N; i++) {
        await resetLab(page)
        const A = await addNote(page, { id: `L${leave}${i}`, x: 120, y: 160, size: 200, text: 'Note A' })
        await select(page, [A.note])
        await focusCanvas(page)
        await page.keyboard.press('Enter')
        await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea?.focused && !e.textarea.readOnly)
        await page.keyboard.type('zq')
        await settle(page, 60)
        await monitorStart(page)
        const releases0 = (await upReleases(page)).length
        // Alice takes the lease (the server's broadcast), and within the same task: read-only already?
        const atLoss = await lab(
          page,
          (x, id) => {
            x.lease.holdByOther(id)
            const ta = document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')
            return {
              readOnly: ta?.readOnly ?? null,
              banner: document.querySelector('[data-testid="lease-notice"]')?.textContent ?? '',
            }
          },
          A.note,
        )
        await page.keyboard.type('after')
        await page.keyboard.insertText('IME')
        await settle(page, 60)
        const whileLost = await editor(page)
        const status = await page.evaluate(
          () => document.querySelector<HTMLElement>('[data-testid="lease-status"]')?.textContent ?? '',
        )
        // Alice's own text arrives while A's editor is still open.
        await lab(
          page,
          (x, id) => {
            const label = x.elements().find((e: { id: string }) => e.id === id)
            x.recorder.applyRemote([
              {
                id,
                patch: { originalText: 'Alice text', text: 'Alice text', version: (label?.version ?? 1) + 1 },
              },
            ])
          },
          A.label ?? '',
        )
        await settle(page, 60)
        if (leave === 'escape') {
          await page.keyboard.press('Escape')
        } else {
          const empty = await toClient(page, 700, 600)
          await page.mouse.click(empty.x, empty.y)
        }
        await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null, 3000).catch(() => {})
        await settle(page, 80)
        const r = await monitorReport(page)
        const stored = (await element(page, A.label ?? ''))?.originalText
        const notices = await noticesOf(page)
        const lost = notices.find((n) => n.kind === 'lost')
        const copied = await lab(page, (x) => x.copyNoticeText())
        const localWrites = r.textWrites.filter((w) => w.text !== 'Alice text')
        rows.push({
          i,
          ...verdict({
            readOnlyAtOnce: atLoss.readOnly === true,
            bannerAtOnce: atLoss.banner.includes('Alice'),
            staysOpenReadOnly:
              whileLost.phase === 'open' &&
              whileLost.textarea?.readOnly === true &&
              whileLost.textarea?.value === 'Note Azq',
            statusShown: status.includes('Alice'),
            aliceTextKept: stored === 'Alice text',
            noLocalWriteAfterLoss: localWrites.length === 0,
            noReleaseSent: (await upReleases(page)).length === releases0,
            textOffered: !!lost && lost.text === 'Note Azq' && copied >= 1,
            noViolations: r.violations.length === 0,
            closed: (await agreement(page)).ok,
          }),
          atLoss,
          whileLost: {
            phase: whileLost.phase,
            readOnly: whileLost.textarea?.readOnly ?? null,
            value: whileLost.textarea?.value ?? null,
          },
          stored,
          localWrites,
          notices,
          violations: r.violations.slice(0, 3),
        })
      }
      expect(report(`FIX7-${leave}`, rows)).toEqual([])
      expect(watch.pageErrors).toEqual([])
    })
  }
})

// --- 8. selecting another element while a request is pending ------------------------------------------

test.describe('fix 8: selecting another element while a request is pending cancels it', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000)
    await openLab(page, { grant: 'manual' })
    await warm(page)
  })

  test(`pending A, click B, Enter, type: B gets the keys through its own lease; A unchanged; notice; ${N}/${N}`, async ({
    page,
  }) => {
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      const A = await addNote(page, { id: `A8${i}`, x: 80, y: 160, size: 200, text: 'Note A' })
      const B = await addNote(page, { id: `B8${i}`, x: 480, y: 160, size: 200, text: 'Note B' })
      await monitorStart(page)
      await select(page, [A.note])
      await focusCanvas(page)
      await page.keyboard.press('Enter')
      await page.keyboard.type('forA')
      const pb = await bodyPoint(page, B.note)
      await page.mouse.click(pb.x, pb.y)
      await settle(page, 40)
      const afterClick = await editor(page)
      await page.keyboard.press('Enter')
      await page.keyboard.type('forB')
      await lab(page, (x) => x.lease.flush())
      await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea && !e.textarea.readOnly, 3000).catch(
        () => {},
      )
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null, 3000).catch(() => {})
      await lab(page, (x) => x.lease.flush())
      await settle(page, 60)
      const r = await monitorReport(page)
      const notices = await noticesOf(page)
      const cancel = notices.find((n) => n.kind === 'cancelled-selection' && n.leaseId === A.note)
      const a = (await element(page, A.label ?? ''))?.originalText
      const b = (await element(page, B.label ?? ''))?.originalText
      rows.push({
        i,
        ...verdict({
          cancelledOnSelect: afterClick.phase === 'idle' && !!cancel && cancel.text === 'forA',
          aUnchanged: a === 'Note A',
          bTyped: b === 'Note BforB',
          acquires: (await acquires(page)).join() === `${A.note},${B.note}`,
          aNotKept: (await lab(page, (x, id) => x.lease.server.holderOf(id), A.note)) === null,
          noViolations: r.violations.length === 0,
          writesHeld: r.textWrites.every((w) => w.held),
        }),
        stored: { A: a, B: b },
        notices,
        violations: r.violations.slice(0, 3),
      })
    }
    expect(report('FIX8-SELECT-B', rows)).toEqual([])
  })

  test(`CONTROL: a click on A itself (its selection unchanged) keeps A's request; the keys land in A; ${N}/${N}`, async ({
    page,
  }) => {
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < N; i++) {
      await resetLab(page)
      const A = await addNote(page, { id: `A8c${i}`, x: 80, y: 160, size: 200, text: 'Note A' })
      await monitorStart(page)
      await select(page, [A.note])
      await focusCanvas(page)
      await page.keyboard.press('Enter')
      const pa = await bodyPoint(page, A.note)
      await page.mouse.click(pa.x, pa.y)
      await focusCanvas(page)
      await page.keyboard.type('zq')
      const st = await editor(page)
      await lab(page, (x) => x.lease.flush())
      await waitEditor(page, (e) => e.phase === 'open' && !!e.textarea && !e.textarea.readOnly, 3000).catch(
        () => {},
      )
      await page.keyboard.press('Escape')
      await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null, 3000).catch(() => {})
      const r = await monitorReport(page)
      const a = (await element(page, A.label ?? ''))?.originalText
      rows.push({
        i,
        ...verdict({
          stillPending: st.phase === 'pending' && st.leaseId === A.note,
          aTyped: a === 'Note Azq',
          noViolations: r.violations.length === 0,
        }),
        a,
      })
    }
    expect(report('FIX8-CONTROL-SAME', rows)).toEqual([])
  })
})
