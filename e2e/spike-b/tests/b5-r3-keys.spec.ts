// B5 R3 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.3.3): each role (editor, commenter, viewer, limited guest)
// presses Ctrl+S, Ctrl+Alt+S, Ctrl+Shift+S, Ctrl+O, Ctrl+P, Alt+Shift+C, Ctrl+Shift+E, Ctrl+/,
// Ctrl+Backspace, Tab then Shift+Tab on a selected shape, Q, Shift+X, Ctrl+Arrow, and G, S, I, digits;
// then drops a file on the canvas. Separate Chromium processes per role on one board of a real stack.
// Owner O2; evidence docs/research/excalidraw/spike-b/B5-R3.md.
//
// Pass: no download, no File System Access picker call (counted with instrumentFilePickers), no file
// chooser, no dialog, no browser save or print (window.print counted), no element change (the page's map
// hash), no push; the drop is prevented for every role (and changes nothing for the read-only roles);
// limited viewers cannot copy (0 clipboard writes; the editor's copy is the positive control).
//
// The limited guest is a name-only guest let in by a view link with guests allowed (the api then limits
// exporting to editors, DANA2-01). Deviation: the spike board page applies "copy: editors only" to every
// read-only role (CanvasInput's default), not the board's export policy from the ticket.
//
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b5-r3   (SPIKE_B5_REPS, default 3)
import { expect, type Page, test } from '@playwright/test'
import {
  filePickerCalls,
  instrumentFilePickers,
  type PageWatch,
  watchPage,
} from '../../spike/support/watch.ts'
import { harness } from '../support/harness.ts'
import type { BrowserProcess } from '../support/types.ts'
import { converge, everywhere, focusCanvas, lc, pushCount, REPS, type Room, room, show } from './b3-kit.ts'

const N = REPS('B5', 3)
test.describe.configure({ mode: 'serial' })
test.setTimeout(60 * 60_000)

const KEYS = [
  'Control+s',
  'Control+Alt+s',
  'Control+Shift+s',
  'Control+o',
  'Control+p',
  'Alt+Shift+c',
  'Control+Shift+e',
  'Control+/',
  'Control+Backspace',
  'Tab',
  'Shift+Tab',
  'q',
  'Shift+x',
  'Control+ArrowRight',
  'Control+ArrowLeft',
  'g',
  's',
  'i',
  ...'1234567890'.split(''),
]

let r: Room
let G: BrowserProcess
const watches = new Map<string, PageWatch>()
const roles = () =>
  [
    ['editor', r.by.E],
    ['commenter', r.by.C],
    ['viewer', r.by.V],
    ['limited guest', G],
  ] as const

/** Counts pickers, print and clipboard writes, watches downloads/dialogs, then (re)opens the board. */
async function instrument(b: BrowserProcess, boardId: string, open = true): Promise<void> {
  await instrumentFilePickers(b.page)
  await b.context.addInitScript(() => {
    const w = window as unknown as { __r3: { prints: number; clipboard: number } }
    w.__r3 = { prints: 0, clipboard: 0 }
    window.print = () => {
      w.__r3.prints++
    }
    // clipboard API writes are counted and never reach the machine's clipboard
    const clip = navigator.clipboard
    if (clip) {
      for (const name of ['write', 'writeText'] as const)
        Object.defineProperty(clip, name, {
          configurable: true,
          value: () => {
            w.__r3.clipboard++
            return Promise.resolve()
          },
        })
    }
  })
  watches.set(b.name, watchPage(b.page))
  if (open) await b.openBoard(boardId)
}
const counters = (p: Page) =>
  p.evaluate(() => ({ ...(window as unknown as { __r3: { prints: number; clipboard: number } }).__r3 }))

/** A name-only guest let in by a view link with guests allowed (the api limits exporting to editors). */
async function joinAsLimitedGuest(owner: Page, guest: Page, boardId: string): Promise<void> {
  const url = await owner.evaluate(async (bid) => {
    const res = await fetch(`/api/boards/${bid}/review-links`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer', allowGuests: true }),
    })
    if (res.status !== 201) throw new Error(`review link: ${res.status}`)
    return ((await res.json()) as { url: string }).url
  }, boardId)
  const token = url.slice(url.lastIndexOf('/') + 1)
  await guest.goto('/')
  await guest.evaluate(async (t) => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => null)
    const res = await fetch(`/api/invitations/${t}/guest`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Lee' }),
    })
    if (res.status !== 201) throw new Error(`guest join: ${res.status}`)
  }, token)
}

test.beforeAll(async () => {
  r = await room(['E', 'C', 'V'], { roles: { C: 'commenter', V: 'viewer' } })
  for (const b of r.browsers) await instrument(b, r.boardId)
  // launched as a dev user (the harness has no guest sign-in yet), then signed out and let in as a guest
  G = await harness.launchBrowser(r.stack, harness.devUser('r3-guest'), { name: 'G' })
  await instrument(G, r.boardId, false)
  await joinAsLimitedGuest(r.by.E?.page as Page, G.page, r.boardId)
  await G.openBoard(r.boardId)
})
test.afterAll(async () => {
  await G?.close().catch(() => {})
  await r?.close()
})

/** Drops a small file on the canvas centre; returns whether the drop's default was prevented. */
const dropFile = (p: Page) =>
  p.evaluate(() => {
    const target =
      document.querySelector<HTMLElement>('.excalidraw canvas.interactive') ??
      document.querySelector<HTMLElement>('.excalidraw')
    if (!target) return null
    const rect = target.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.items.add(new File(['hello'], 'hello.txt', { type: 'text/plain' }))
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at })
    target.dispatchEvent(over)
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at })
    target.dispatchEvent(drop)
    return { over: over.defaultPrevented, drop: drop.defaultPrevented }
  })

test('R3: keys, a file drop and copy per role: nothing downloads, opens, prints or changes; the drop is prevented', async () => {
  const E = r.by.E?.page as Page
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < N; i++) {
    const rect = await lc(E).create('rectangle', { x: i * 400, y: 0, width: 160, height: 100, roughness: 0 })
    const noteId = await lc(E).create('note', { x: i * 400, y: 200, text: `R3 ${i}` })
    await everywhere([...r.browsers, G], rect)
    await everywhere([...r.browsers, G], noteId)
    for (const [role, b] of roles()) {
      const p = (b as BrowserProcess).page
      const w = watches.get((b as BrowserProcess).name) as PageWatch
      await show(p, [rect])
      await lc(p).select([rect])
      await focusCanvas(p)
      w.reset()
      const pickers0 = Object.values(await filePickerCalls(p)).reduce((a, c) => a + c, 0)
      const c0 = await counters(p)
      const hash0 = await lc(p).hash()
      const push0 = await pushCount(p)
      for (const k of KEYS) {
        await p.keyboard.press(k)
        await p.waitForTimeout(25)
      }
      await p.waitForTimeout(400)
      const hash1 = await lc(p).hash()
      const push1 = await pushCount(p)
      const pickers = Object.values(await filePickerCalls(p)).reduce((a, c) => a + c, 0) - pickers0
      const c1 = await counters(p)
      await lc(p).setTool('select')
      // copy with the shape selected: a synthetic copy event with its own DataTransfer (the machine's
      // clipboard is never touched), as the browser's Ctrl+C sends it; an editor's copy leaves Excalidraw's
      // clipboard data in it (the positive control), a read-only role's is stopped by Lobby's policy
      await lc(p).select([rect])
      await focusCanvas(p)
      const copy0 = (await counters(p)).clipboard
      const copyEvent = await p.evaluate(() => {
        const dt = new DataTransfer()
        const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true })
        ;(document.activeElement ?? document.body).dispatchEvent(ev)
        return { types: [...dt.types], prevented: ev.defaultPrevented }
      })
      await p.waitForTimeout(100)
      const copies = copyEvent.types.length + (await counters(p)).clipboard - copy0
      // the drop
      const dropHash0 = await lc(p).hash()
      const dropped = await dropFile(p)
      await p.waitForTimeout(500)
      const dropHash1 = await lc(p).hash()
      const readOnly = role !== 'editor'
      const ok =
        w.downloads === 0 &&
        w.fileChoosers === 0 &&
        w.dialogs === 0 &&
        w.popups === 0 &&
        pickers === 0 &&
        c1.prints - c0.prints === 0 &&
        hash1 === hash0 &&
        push1 === push0 &&
        dropped?.drop === true &&
        (!readOnly || dropHash1 === dropHash0) &&
        (readOnly ? copies === 0 : copies > 0)
      rows.push({
        i,
        role,
        ok,
        downloads: w.downloads,
        fileChoosers: w.fileChoosers,
        dialogs: w.dialogs,
        popups: w.popups,
        pickers,
        prints: c1.prints - c0.prints,
        changed: hash1 !== hash0,
        pushes: push1 - push0,
        dropped,
        dropChanged: dropHash1 !== dropHash0,
        copies,
      })
      if (!ok) console.log('row', JSON.stringify(rows.at(-1)))
      await p.keyboard.press('Escape')
    }
    await converge(r, [...r.browsers, G])
  }
  console.log(
    'B5-R3',
    JSON.stringify({ n: rows.length, sample: rows.slice(0, 4), failed: rows.filter((x) => !x.ok) }),
  )
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
