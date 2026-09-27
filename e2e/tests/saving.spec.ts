// WRK-03: a save indicator that tells the truth (docs/research/saved-indicator.md). "Saved" only once
// the server acknowledged every document change this tab made; offline edits say they will sync; a
// change the server refused says so and never shows "Saved"; presence never moves the indicator; and
// read-only people send no document writes at all (the tldraw 5.4.2 user-record loop, §7).
import { join } from 'node:path'
import type { Dialog } from '@playwright/test'
import {
  boardDocument,
  edit,
  expectConn,
  getShape,
  insertFiles,
  pageShapes,
  read,
  type Session,
  shapeCenterOnScreen,
  shapeText,
  startTextEditing,
  stopTextEditing,
  toScreen,
  typeText,
  waitForBoard,
  waitForValue,
} from './support/board.ts'
import {
  countPushes,
  expectSaveState,
  focusCanvas,
  markSaveLog,
  openSessionWatched,
  type PushCounter,
  recordSaveStates,
  saveLog,
  saveStatus,
} from './support/collab-quality.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'
import { FIXTURES_DIR } from './support/stack.ts'

/** Only "Saving…" and "Saved" were shown, starting and ending on "Saved", with "Saving…" in between. */
function expectSavingThenSaved(log: string[]) {
  expect(log[0]).toBe('saved')
  expect(log.at(-1)).toBe('saved')
  expect(log).toContain('saving')
  expect(new Set(log)).toEqual(new Set(['saved', 'saving']))
}

test('WRK-03: each edit shows Saving… then Saved, and what Saved promised is on the server', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await expectSaveState(a.page, 'saved')
  await expectSaveState(b.page, 'saved')
  await expect(saveStatus(a.page)).toHaveText('Saved')
  await expect(saveStatus(a.page)).toHaveAttribute(
    'title',
    'Every change you made is stored on the board server',
  )
  // The live-connection pill is still there, separate from what was saved.
  await expect(a.page.getByTestId('conn-status')).toHaveText('Live')
  await recordSaveStates(a.page)
  await recordSaveStates(b.page)

  await test.step('a single change: exactly Saving… then Saved', async () => {
    await edit(
      a.page,
      (ed, id) => ed.createShape({ id, type: 'geo', x: 120, y: 140, props: { w: 160, h: 110 } }),
      'shape:saved-box',
    )
    await expect.poll(() => saveLog(a.page)).toEqual(['saved', 'saving', 'saved'])
  })

  await test.step('a mouse drag: Saving… while it lasts, Saved once it is stored', async () => {
    // Selected first (session state only): a drag inside an unselected hollow shape draws a selection box.
    await edit(a.page, (ed, id) => ed.select(id), 'shape:saved-box')
    await markSaveLog(a.page)
    const x0 = (await getShape(a.page, 'shape:saved-box'))?.x ?? Number.NaN
    const from = await shapeCenterOnScreen(a.page, 'shape:saved-box')
    await a.page.mouse.move(from.x, from.y)
    await a.page.mouse.down()
    await a.page.mouse.move(from.x + 260, from.y + 90, { steps: 25 })
    await a.page.mouse.up()
    await expect
      .poll(async () => ((await getShape(a.page, 'shape:saved-box'))?.x ?? x0) - x0)
      .toBeGreaterThan(200)
    // "Saving…" stays up at least 500 ms once shown, so it cannot slip between two checks.
    await expectSaveState(a.page, 'saving')
    await expectSaveState(a.page, 'saved')
    expectSavingThenSaved(await saveLog(a.page))
    const moved = (await getShape(a.page, 'shape:saved-box'))?.x
    await expect.poll(() => getShape(b.page, 'shape:saved-box').then((s) => s?.x)).toBe(moved)
  })

  await test.step('real typing into a note', async () => {
    await edit(a.page, (ed, id) => ed.createShape({ id, type: 'note', x: 520, y: 140 }), 'shape:saved-note')
    await expectSaveState(a.page, 'saving')
    await expectSaveState(a.page, 'saved')
    await markSaveLog(a.page)
    await startTextEditing(a.page, 'shape:saved-note')
    await typeText(a.page, 'Typed and saved')
    await expectSaveState(a.page, 'saving')
    await stopTextEditing(a.page)
    await expectSaveState(a.page, 'saved')
    expectSavingThenSaved(await saveLog(a.page))
  })

  // Bob changed nothing: other people's edits never move his indicator.
  expect(await saveLog(b.page)).toEqual(['saved'])

  // "Saved" meant stored: a session that loads the board from the server has all of it.
  const fresh = await session('carol')
  await expect.poll(() => shapeText(fresh.page, 'shape:saved-note')).toBe('Typed and saved')
  expect(await getShape(fresh.page, 'shape:saved-box').then((s) => s?.x)).toBe(
    await getShape(a.page, 'shape:saved-box').then((s) => s?.x),
  )
  await capture('save-status-saved.png', a.page.locator('.dr-topbar'), test.info())
})

test('WRK-03: with the sync server killed, 10 edits say "Offline — changes will sync", then Saved, and all 10 reach a fresh session', async ({
  session,
  stack,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await expectSaveState(a.page, 'saved')
  await recordSaveStates(a.page)
  await focusCanvas(a.page) // a real click: Chrome only asks "leave site?" after a user gesture
  const ids = Array.from({ length: 10 }, (_, i) => `shape:offline-${i}`)

  await stack.sync.kill()
  await expectConn(a.page, 'offline')
  // Nothing was waiting: offline, but not "changes will sync".
  await expectSaveState(a.page, 'offline')
  await expectSaveState(b.page, 'offline')
  await expect(saveStatus(a.page)).toHaveText('Offline')

  for (const [i, id] of ids.entries()) {
    await edit(
      a.page,
      (ed, arg) =>
        ed.createShape({
          id: arg.id,
          type: 'geo',
          x: 80 + (arg.i % 5) * 150,
          y: 100 + Math.floor(arg.i / 5) * 150,
          props: { w: 120, h: 100, color: 'blue' },
        }),
      { id, i },
    )
  }
  await expectSaveState(a.page, 'offline-pending')
  await expect(saveStatus(a.page)).toHaveText('Offline — changes will sync')
  await expect(saveStatus(a.page)).toHaveAttribute(
    'title',
    /Reloading or closing the tab now would lose them/,
  )
  // Bob made no edits: his tab has nothing to lose.
  await expectSaveState(b.page, 'offline')
  await capture('save-status-offline-pending.png', a.page.locator('.dr-topbar'), test.info())

  await test.step('leaving now asks first (beforeunload), and staying keeps the edits', async () => {
    const dialogs: string[] = []
    const onDialog = (d: Dialog) => {
      dialogs.push(d.type())
      void d.dismiss() // "Stay on page"
    }
    a.page.on('dialog', onDialog)
    // Staying on the page cancels the reload: it never loads (Playwright reports a timeout).
    const reload = await a.page.reload({ timeout: 3000 }).then(
      () => 'reloaded',
      () => 'stayed',
    )
    a.page.off('dialog', onDialog)
    expect(dialogs).toEqual(['beforeunload'])
    expect(reload).toBe('stayed')
    await expectSaveState(a.page, 'offline-pending')
    expect((await pageShapes(a.page)).filter((s) => ids.includes(s.id))).toHaveLength(10)
  })

  await stack.sync.start()
  await expectConn(a.page, 'online')
  await expectSaveState(a.page, 'saved', 30_000)
  // Never "Saved" while the server was down: offline, then pending, then saving, then saved.
  expect(await saveLog(a.page)).toEqual(['saved', 'offline', 'offline-pending', 'saving', 'saved'])
  await expectSaveState(b.page, 'saved')

  const onBoard = async (s: Session) =>
    (await pageShapes(s.page))
      .filter((sh) => ids.includes(sh.id))
      .map((sh) => sh.id)
      .sort()
  await expect.poll(() => onBoard(b)).toEqual([...ids].sort())
  const fresh = await session('carol')
  await expect.poll(() => onBoard(fresh)).toEqual([...ids].sort())

  // Saved: nothing to lose, so a reload does not ask.
  const dialogs: string[] = []
  a.page.on('dialog', (d) => {
    dialogs.push(d.type())
    void d.dismiss()
  })
  await a.page.reload()
  await waitForBoard(a.page)
  expect(dialogs).toEqual([])
  expect(await onBoard(a)).toEqual([...ids].sort())
})

test('WRK-03: a viewer’s forged write shows "Change not saved", never "Saved", and never reaches the server', async ({
  session,
  browser,
  board,
  users,
}) => {
  const NOTE = 'shape:owner-note'
  const FORGED = 'shape:forged-by-viewer'
  const a = await session('alice')
  await edit(
    a.page,
    (ed, arg) =>
      ed.createShape({
        id: arg.id,
        type: 'note',
        x: 160,
        y: 160,
        props: { color: 'yellow', richText: arg.text },
      }),
    { id: NOTE, text: richText('Owner note') },
  )
  await expectSaveState(a.page, 'saved')
  const v = await session('bob', { role: 'viewer' })
  await expectSaveState(v.page, 'readonly')
  await expect(saveStatus(v.page)).toHaveText('View only')
  await recordSaveStates(v.page)

  // What a client that ignores its read-only flag does (the UI guard is client-side only).
  await edit(
    v.page,
    (ed, ids) => {
      ed.updateInstanceState({ isReadonly: false })
      ed.createShape({ id: ids.forged, type: 'geo', x: 600, y: 200, props: { w: 100, h: 100 } })
      ed.updateShape({ id: ids.note, type: 'note', props: { color: 'red' } })
    },
    { forged: FORGED, note: NOTE },
  )
  await expectSaveState(v.page, 'rejected')
  await expect(saveStatus(v.page)).toHaveText('Change not saved')
  await expect(saveStatus(v.page)).toHaveAttribute(
    'title',
    'Your last change was not saved: you can only view this board',
  )
  await expect(v.page.getByTestId('save-rejected-toast')).toHaveText(
    'You can only view this board, so your change was not saved.',
  )
  expect(await saveLog(v.page)).toEqual(['readonly', 'saving', 'rejected'])
  await capture('save-status-rejected.png', v.page, test.info())

  // Rolled back locally; never on the owner's tab or the server.
  await expect.poll(() => getShape(v.page, FORGED)).toBeNull()
  await expect.poll(() => getShape(v.page, NOTE).then((s) => s?.props.color)).toBe('yellow')
  expect(await getShape(a.page, FORGED)).toBeNull()
  expect(await getShape(a.page, NOTE).then((s) => s?.props.color)).toBe('yellow')
  const fresh = await openSessionWatched(browser, board, await users.get('alice'), () => {})
  try {
    expect(await getShape(fresh.page, NOTE).then((s) => s?.props.color)).toBe('yellow')
    expect(await getShape(fresh.page, FORGED)).toBeNull()
  } finally {
    await fresh.context.close()
  }
  // The hold ends (8 s) and the viewer is back to "View only", without ever having said "Saved".
  await edit(v.page, (ed) => ed.updateInstanceState({ isReadonly: true }))
  await expectSaveState(v.page, 'readonly', 15_000)
  expect(await saveLog(v.page)).toEqual(['readonly', 'saving', 'rejected', 'readonly'])
})

test('WRK-03: a write vetoed by the text lease shows "Change not saved", never "Saved"', async ({
  session,
}) => {
  const N = 'shape:lease-veto-note'
  const a = await session('alice')
  const b = await session('bob')
  await edit(a.page, (ed, id) => ed.createShape({ id, type: 'note', x: 240, y: 140 }), N)
  await expect(b.page.locator(`[data-shape-id="${N}"]`)).toBeVisible()
  await startTextEditing(a.page, N)
  await typeText(a.page, 'alice holds the lease')
  await expect.poll(() => shapeText(b.page, N)).toBe('alice holds the lease')
  await expectSaveState(b.page, 'saved')
  await recordSaveStates(b.page)

  await startTextEditing(b.page, N)
  await typeText(b.page, ' and bob')
  await expect(b.page.getByTestId('lease-toast')).toHaveText(`${a.name} is editing this text`)
  await expectSaveState(b.page, 'rejected')
  await expect(saveStatus(b.page)).toHaveAttribute(
    'title',
    'Your last change was not saved: someone else is editing that text',
  )
  // Bob's typing was answered, checked and refused: "Saving…" then "Change not saved", no "Saved".
  expect(await saveLog(b.page)).toEqual(['saved', 'saving', 'rejected'])
  // The lease toast already explains it; no second toast.
  await expect(b.page.getByTestId('save-rejected-toast')).toHaveCount(0)
  await expect.poll(() => shapeText(b.page, N)).toBe('alice holds the lease')
  await stopTextEditing(b.page)
  // Alice was never refused.
  await stopTextEditing(a.page)
  await expectSaveState(a.page, 'saved')
})

test('WRK-03: presence-only activity (cursors, selection) never moves either indicator', async ({
  session,
  browser,
  board,
  users,
}) => {
  const a = await session('alice')
  await edit(
    a.page,
    (ed, id) => ed.createShape({ id, type: 'geo', x: 300, y: 200, props: { w: 160, h: 110 } }),
    'shape:presence-box',
  )
  await expectSaveState(a.page, 'saved')
  let pushes: PushCounter | undefined
  const b = await openSessionWatched(browser, board, await users.grant(board, 'bob'), (page) => {
    pushes = countPushes(page)
  })
  try {
    await expectSaveState(b.page, 'saved')
    await recordSaveStates(a.page)
    await recordSaveStates(b.page)
    pushes?.reset()

    // Bob and alice move their cursors around and bob selects the shape: presence only.
    await edit(b.page, (ed, id) => ed.select(id), 'shape:presence-box')
    for (let round = 0; round < 6; round++) {
      for (const s of [b, a] as const) {
        const p = await toScreen(s.page, { x: 700 + (round % 2) * 200, y: 380 + (round % 3) * 60 })
        await s.page.mouse.move(p.x, p.y, { steps: 20 })
      }
    }
    await edit(b.page, (ed) => ed.selectNone())
    // Alice saw bob's cursor move: the presence really flowed.
    await expect
      .poll(() =>
        read(a.page, (ed, n) => ed.getCollaborators().find((c) => c.userName === n)?.cursor ?? null, b.name),
      )
      .toMatchObject({ x: expect.any(Number) })
    expect(pushes?.presencePushes()).toBeGreaterThan(10)
    expect(pushes?.documentPushes()).toBe(0)
    expect(await saveLog(a.page)).toEqual(['saved'])
    expect(await saveLog(b.page)).toEqual(['saved'])
  } finally {
    await b.context.close()
  }
})

test('a viewer and a commenter see "View only" and send no document pushes (no user-record loop)', async ({
  session,
  browser,
  board,
  users,
}) => {
  const a = await session('alice')
  await edit(
    a.page,
    (ed, arg) => ed.createShape({ id: arg.id, type: 'note', x: 200, y: 180, props: { richText: arg.text } }),
    { id: 'shape:readers-note', text: richText('Readers look here') },
  )
  const counters: Record<string, PushCounter> = {}
  const readers: Session[] = []
  try {
    for (const [handle, role] of [
      ['bob', 'viewer'],
      ['carol', 'commenter'],
    ] as const) {
      const user = await users.grant(board, handle, role)
      readers.push(
        await openSessionWatched(browser, board, user, (page) => {
          counters[handle] = countPushes(page)
        }),
      )
    }
    for (const r of readers) {
      await expectSaveState(r.page, 'readonly')
      await expect(saveStatus(r.page)).toHaveText('View only')
    }

    // Five seconds of an ordinary visit with the owner present (so the clients sync at full rate):
    // moving around and selecting. Before the fix, each reader re-sent its user record ~14×/s.
    const until = Date.now() + 5000
    let round = 0
    while (Date.now() < until) {
      for (const r of readers) {
        const p = await toScreen(r.page, { x: 500 + (round % 2) * 250, y: 300 + (round % 3) * 80 })
        await r.page.mouse.move(p.x, p.y, { steps: 10 })
      }
      round++
    }
    for (const r of readers) await edit(r.page, (ed, id) => ed.select(id), 'shape:readers-note')
    await a.page.waitForTimeout(Math.max(0, until + 500 - Date.now()))

    for (const [handle, c] of Object.entries(counters)) {
      expect(
        { documentPushes: c.documentPushes(), recordsTouched: c.touched() },
        `${handle}'s document pushes`,
      ).toEqual({ documentPushes: 0, recordsTouched: [] })
      expect(c.presencePushes(), `${handle}'s presence pushes`).toBeGreaterThan(5)
    }
    // Their names still reach others through presence, under their account id.
    for (const r of readers) {
      await expect(
        a.page.locator(`[data-testid="presence-user"][data-user-id="${r.id}"] button`),
      ).toHaveAttribute('title', r.name)
    }
    // And no reader's user record was written into the board (nor attempted, see above).
    const userRecords = await read(a.page, (ed) =>
      ed.store
        .allRecords()
        .filter((rec) => rec.typeName === 'user')
        .map((rec) => rec.id),
    )
    for (const r of readers) expect(userRecords).not.toContain(`user:${r.id}`)
  } finally {
    await Promise.all(readers.map((r) => r.context.close()))
  }
})

test('a viewer upgraded to editor while the board is open goes from "View only" to "Saved", and saves', async ({
  session,
  users,
  board,
}) => {
  const a = await session('alice')
  const b = await session('bob', { role: 'viewer' })
  await expectSaveState(b.page, 'readonly')
  // Upgraded: the sync server closes his session and he reconnects with an editor ticket.
  await users.grant(board, 'bob', 'editor')
  await expect(b.page.getByTestId('readonly-pill')).toHaveCount(0, { timeout: 30_000 })
  await expectSaveState(b.page, 'saved', 30_000)
  await recordSaveStates(b.page)
  await edit(
    b.page,
    (ed, id) => ed.createShape({ id, type: 'geo', x: 300, y: 300, props: { w: 100, h: 100 } }),
    'shape:by-upgraded-bob',
  )
  await expectSaveState(b.page, 'saving')
  await expectSaveState(b.page, 'saved')
  expect(await saveLog(b.page)).toEqual(['saved', 'saving', 'saved'])
  await expect.poll(() => getShape(a.page, 'shape:by-upgraded-bob').then((s) => s !== null)).toBe(true)
  // As an editor he has a user record again (attribution), written under his account id.
  await expect
    .poll(() => read(a.page, (ed, id) => ed.store.allRecords().some((r) => r.id === id), `user:${b.id}`))
    .toBe(true)
})

test('WRK-03: an image stays "Saving…" until its bytes are uploaded, although its shape is already shared', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await expectSaveState(a.page, 'saved')
  // Hold the upload request until the test lets it go.
  let release: () => void = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  await a.page.route('**/api/boards/*/assets', async (route) => {
    await held
    await route.continue()
  })
  await recordSaveStates(a.page)
  await focusCanvas(a.page)
  await insertFiles(a.page, [join(FIXTURES_DIR, 'image.png')])
  const imageId = await waitForValue(
    async () => (await pageShapes(a.page)).find((s) => s.type === 'image')?.id,
  )
  // tldraw shares the shape (and a placeholder asset) before the upload: bob already has it...
  await expect.poll(() => getShape(b.page, imageId).then((s) => s !== null)).toBe(true)
  // ...but alice's file is not on the server yet, so her indicator does not say Saved. Held well past
  // the display's smoothing (≤ 750 ms): this duration is what is under test.
  await expect(saveStatus(a.page)).toHaveAttribute('title', 'Uploading a file to the board server')
  await a.page.waitForTimeout(1500)
  await expectSaveState(a.page, 'saving')
  expect(await saveLog(a.page)).toEqual(['saved', 'saving'])

  release()
  // Once the worker's preview is ready, the app writes it into the asset record too (meta.previewStatus,
  // board/ExternalContent.tsx watchImagePreview): a second document change that may share the
  // upload's save or come just after it. Wait for it, so the log below is complete.
  await expect
    .poll(
      () =>
        read(
          a.page,
          (ed, id) => {
            const assetId = (ed.getShape(id)?.props as { assetId?: string } | undefined)?.assetId
            const asset = ed.store.allRecords().find((r) => r.id === assetId) as
              | { meta?: { previewStatus?: string } }
              | undefined
            return asset?.meta?.previewStatus ?? null
          },
          imageId,
        ),
      { timeout: 30_000 },
    )
    .toBe('ready')
  await a.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await expectSaveState(a.page, 'saved', 30_000)
  // Never "Saved" until the bytes landed (checked above while held); then Saved, and at most one
  // more Saving… → Saved for the preview status.
  expect((await saveLog(a.page)).join(' ')).toMatch(/^saved saving saved( saving saved)?$/)
  // Saved means the stable file reference is in the stored asset record.
  const fresh = await session('carol')
  await expect
    .poll(async () => {
      const doc = await boardDocument(fresh.page)
      const assetId = String(doc.shapes[imageId]?.props.assetId)
      return (doc.assets[assetId] as { props?: { src?: unknown } } | undefined)?.props?.src ?? null
    })
    .toMatch(/^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/original$/)
})
