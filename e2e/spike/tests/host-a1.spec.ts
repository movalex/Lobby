import { expect, type Page, test } from '@playwright/test'
import { watchPage } from '../support/watch.ts'
import { addNote, centerOf, elements, lab, openLab, resetLab } from './host-kit.ts'

// A1 (docs/EXCALIDRAW-MIGRATION.md §8.2): a note built with `created: null` renders without the date
// footer; Ctrl+D and Alt-drag copies get `created: null` through onDuplicate. Pass: no footer in pixel
// probes, 3 cases. Each case also runs a CONTROL that must show the footer, so the probe is proven to
// see it: a note stamped with a date (case 1) and the same gesture with Lobby's onDuplicate stamp off
// (/spike/host-lab?dup=off; cases 2 and 3).
//
// The footer is drawn right-aligned at (width - 16, height - 14) in 12px Helvetica, in the note's
// strokeColor (@excalidraw/element dist/dev/index.js:13623-13633; STICKY_NOTE_FOOTER, common :1811).
// The probe counts pixels in that box whose colour is far from the note's background (light theme).

interface Probe {
  id: string
  created: unknown
  ink: number
  painted: boolean
}

async function footerProbe(page: Page, id: string): Promise<Probe> {
  return page.evaluate((noteId) => {
    const spike = window.__lobbySpike
    const api = spike?.api
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')
    const ctx = canvas?.getContext('2d')
    if (!spike || !api || !canvas || !ctx) throw new Error('no canvas')
    const s = api.getAppState()
    const note = api.getSceneElements().find((e) => e.id === noteId)
    if (!note) throw new Error(`no note ${noteId}`)
    const box = canvas.getBoundingClientRect()
    const sx = canvas.width / box.width
    const sy = canvas.height / box.height
    const px = (x: number, y: number) => {
      const v = spike.lib.sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, s)
      return { x: Math.round((v.x - box.left) * sx), y: Math.round((v.y - box.top) * sy) }
    }
    const hex = note.backgroundColor.replace('#', '')
    const bg = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
    const corner = px(note.x + 10, note.y + 10)
    const c = ctx.getImageData(corner.x, corner.y, 1, 1).data
    const painted = [0, 1, 2].every((i) => Math.abs((c[i] ?? 0) - (bg[i] ?? 0)) <= 24)
    // Footer text box: right edge width-16, baseline height-14, 12px font -> [-64, +2] x [-12, +4].
    const a = px(note.x + note.width - 16 - 64, note.y + note.height - 14 - 12)
    const z = px(note.x + note.width - 16 + 2, note.y + note.height - 14 + 4)
    const data = ctx.getImageData(a.x, a.y, Math.max(1, z.x - a.x), Math.max(1, z.y - a.y)).data
    let ink = 0
    for (let i = 0; i < data.length; i += 4) {
      const d =
        Math.abs((data[i] ?? 0) - (bg[0] ?? 0)) +
        Math.abs((data[i + 1] ?? 0) - (bg[1] ?? 0)) +
        Math.abs((data[i + 2] ?? 0) - (bg[2] ?? 0))
      if (d > 90) ink++
    }
    return { id: noteId, created: (note as { created?: unknown }).created, ink, painted }
  }, id)
}

/** Polls until the note is painted, then returns a stable probe (two equal reads). */
async function settledProbe(page: Page, id: string): Promise<Probe> {
  let last: Probe | null = null
  await expect
    .poll(
      async () => {
        const p = await footerProbe(page, id)
        const same = last !== null && last.ink === p.ink && p.painted
        last = p
        return same
      },
      { timeout: 10_000, intervals: [100, 100, 200, 300] },
    )
    .toBe(true)
  if (!last) throw new Error('unreachable')
  return last
}

async function noteIds(page: Page): Promise<string[]> {
  return (await elements(page)).filter((e) => e.type === 'stickynote' && !e.isDeleted).map((e) => e.id)
}

const INK_MIN = 20 // a painted "28 Sep" footer covers far more than this; a clean one has 0

test.describe('A1: created null -> no date footer', () => {
  test('case 1: a note built with created null (control: created stamped)', async ({ page }) => {
    const watch = watchPage(page)
    await openLab(page)
    await resetLab(page)
    const lobby = await addNote(page, { x: 80, y: 120, size: 200, text: 'Lobby note' })
    const control = await addNote(page, { x: 380, y: 120, size: 200, text: 'Control', created: Date.now() })
    const p = await settledProbe(page, lobby.note)
    const q = await settledProbe(page, control.note)
    console.log('A1-CASE1', JSON.stringify({ lobby: p, control: q }))
    expect(p.created).toBeNull()
    expect(p.ink).toBe(0)
    expect(q.created).toEqual(expect.any(Number))
    expect(q.ink).toBeGreaterThanOrEqual(INK_MIN)
    expect(watch.pageErrors).toEqual([])
  })

  for (const gesture of ['ctrl+d', 'alt-drag'] as const) {
    test(`case ${gesture === 'ctrl+d' ? 2 : 3}: ${gesture} copies get created null through onDuplicate`, async ({
      page,
    }) => {
      const out: Record<string, unknown> = {}
      for (const dup of ['on', 'off'] as const) {
        await openLab(page, { dup })
        await resetLab(page)
        const src = await addNote(page, { x: 120, y: 140, size: 200, text: 'Source' })
        const c = await centerOf(page, src.note)
        await page.mouse.click(c.x + 60, c.y + 70) // select (away from the label)
        if (gesture === 'ctrl+d') {
          await page.keyboard.press('Control+d')
        } else {
          await page.keyboard.down('Alt')
          await page.mouse.move(c.x + 60, c.y + 70)
          await page.mouse.down()
          for (let s = 1; s <= 10; s++) await page.mouse.move(c.x + 60 + s * 30, c.y + 70, { steps: 2 })
          await page.mouse.up()
          await page.keyboard.up('Alt')
        }
        await expect.poll(() => noteIds(page).then((ids) => ids.length)).toBe(2)
        const copyId = (await noteIds(page)).find((id) => id !== src.note) ?? ''
        const copy = await settledProbe(page, copyId)
        const orig = await settledProbe(page, src.note)
        const labels = (await elements(page)).filter((e) => e.type === 'text' && !e.isDeleted).length
        out[dup === 'on' ? 'lobby' : 'control'] = { copy, orig, labels }
        if (dup === 'on') {
          expect(copy.created, 'copy created').toBeNull()
          expect(copy.ink, 'copy footer ink').toBe(0)
          expect(orig.ink, 'original footer ink').toBe(0)
          expect(labels, 'the label was copied too').toBe(2)
        } else {
          expect(copy.created, 'control copy created').toEqual(expect.any(Number))
          expect(copy.ink, 'control copy footer ink').toBeGreaterThanOrEqual(INK_MIN)
        }
      }
      const traces = await lab(page, (x) => x.counters)
      console.log(`A1-${gesture.toUpperCase()}`, JSON.stringify({ ...out, counters: traces }))
    })
  }
})
