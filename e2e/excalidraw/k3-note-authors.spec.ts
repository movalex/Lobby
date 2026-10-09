// K3-6 (wave K): the note-author label and a board open's workshop requests.
//  - Every template sticky was signed with whoever inserted the template. A note that arrived with its
//    words (a template's prompt, the sample's ideas, a paste) now shows no author until someone edits them
//    (features/workshops/ported/note-authors.ts `madeWithItsWords`, from the server's own stamps); a note
//    typed in with the note tool shows its author as before.
//  - The label read 4.08:1 on a light note and 2.93:1 through the dark theme's filter (it was drawn at 0.6
//    of the note's ink): measured here on the rendered pixels, like a11y-contrast.spec.ts W5-15, at 4.5:1 or
//    better on all 13 note colours in both themes.
//  - Labels stay off the slides while presenting.
//  - A board open asks /workshop and /private-brainstorm once each (they were fetched twice: once when the
//    store was made, once at the event stream's first resync).
import type { Page } from '@playwright/test'
import {
  expectSaved,
  sceneToScreen,
  select,
  setViewport,
  startTextEditingWithKeyboard,
  stopTextEditing,
  typeText,
} from '../tests/support/canvas.ts'
import { withCanvas } from './a11y-kit.ts'
import { startPresenting } from './present-kit.ts'
import { expect, expectItemsEverywhere, reloadBoard, test } from './workshops-kit.ts'

const label = (page: Page, id: string) => page.locator(`[data-testid="note-author"][data-note-id="${id}"]`)

/** Notes made in ONE write each, with their words, as a template insert or a paste makes them. */
async function insertWithWords(
  page: Page,
  notes: { id: string; x: number; y: number; text: string; prompt?: boolean; color?: string }[],
) {
  await page.evaluate((list) => {
    type Tx = { create(kind: string, props: Record<string, unknown>): string }
    const b = (
      window as unknown as { __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } } }
    ).__lobbyBoard
    b.canvas.transact('e2e insert', (tx) => {
      for (const n of list)
        tx.create('note', {
          id: n.id,
          x: n.x,
          y: n.y,
          text: n.text,
          ...(n.color ? { backgroundColor: n.color } : {}),
          ...(n.prompt ? { customData: { lobby: { prompt: 'true' } } } : {}),
        })
    })
  }, notes)
  await expectSaved(page)
}

/** A note made empty (the note tool's create), then typed in through the editor and its lease. */
async function typedNote(page: Page, id: string, x: number, y: number, text: string, color?: string) {
  await page.evaluate(
    (n) => {
      type Tx = { create(kind: string, props: Record<string, unknown>): string }
      const b = (
        window as unknown as { __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } } }
      ).__lobbyBoard
      b.canvas.transact('e2e note', (tx) => {
        tx.create('note', {
          id: n.id,
          x: n.x,
          y: n.y,
          size: 150,
          ...(n.color ? { backgroundColor: n.color } : {}),
        })
      })
    },
    { id, x, y, color },
  )
  await expectSaved(page)
  await startTextEditingWithKeyboard(page, id)
  await typeText(page, text)
  await stopTextEditing(page)
  await expectSaved(page)
}

test('K3-6: template and sample notes are nobody’s until edited; a typed note keeps its author; no labels on slides', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await a.page.evaluate(() => {
    type Tx = { create(kind: string, props: Record<string, unknown>): string }
    const c = (
      window as unknown as { __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } } }
    ).__lobbyBoard.canvas
    c.transact('e2e frame', (tx) => {
      tx.create('frame', { id: 'k3-deck', x: -100, y: -100, width: 1100, height: 500, name: 'Ideas' })
    })
  })
  await expectSaved(a.page)
  await insertWithWords(a.page, [
    { id: 'k3-prompt', x: 0, y: 0, text: 'What went well?', prompt: true },
    { id: 'k3-sample', x: 260, y: 0, text: 'Try a weekly podcast' },
  ])
  await typedNote(a.page, 'k3-typed', 520, 0, 'Alice wrote this')
  await expectItemsEverywhere([b], ['k3-prompt', 'k3-sample', 'k3-typed'])
  await setViewport(b.page, { x: -150, y: -150, zoom: 1 })
  const alice = a.name.split(' ')[0] ?? a.name
  const bob = b.name.split(' ')[0] ?? b.name

  await test.step('bob sees alice on her typed note, and no name on the template or sample notes', async () => {
    await expect(label(b.page, 'k3-typed')).toHaveText(alice, { timeout: 5_000 })
    await expect(label(b.page, 'k3-prompt')).toHaveCount(0)
    await expect(label(b.page, 'k3-sample')).toHaveCount(0)
    // alice, who inserted them, is not signed on them either
    await expect(label(a.page, 'k3-typed')).toHaveText(alice)
    await expect(label(a.page, 'k3-prompt')).toHaveCount(0)
  })

  await test.step('bob edits the template’s prompt: now it is his', async () => {
    await startTextEditingWithKeyboard(b.page, 'k3-prompt')
    await typeText(b.page, ' Shipping on time')
    await stopTextEditing(b.page)
    await expectSaved(b.page)
    await expect(label(a.page, 'k3-prompt')).toHaveText(bob, { timeout: 5_000 })
    await expect(label(b.page, 'k3-prompt')).toHaveText(bob)
    await expect(label(a.page, 'k3-sample')).toHaveCount(0)
  })

  await test.step('while alice presents, her slides carry no author labels; they come back after', async () => {
    await expect(label(a.page, 'k3-typed')).toBeVisible()
    await startPresenting(a.page.getByTestId('present-button'))
    await expect(a.page.getByTestId('present-overlay')).toBeVisible()
    await expect(a.page.getByTestId('note-author')).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('present-overlay')).toHaveCount(0)
    await expect(label(a.page, 'k3-typed')).toHaveText(alice)
  })
})

// ---- contrast, as a11y-contrast.spec.ts reads it: device pixels of the label's box ---------------------------

test.describe('K3-6: the note-author label reads at 4.5:1', () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })

  interface Rgb {
    r: number
    g: number
    b: number
  }
  const lum = ({ r, g, b }: Rgb) => {
    const ch = (v: number) => {
      const s = v / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
  }
  const ratio = (a: Rgb, b: Rgb) => {
    const [x, y] = [lum(a), lum(b)]
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const hex = ({ r, g, b }: Rgb) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

  /** The box's background (its most common colour) and ink (the pixel with the most contrast against it). */
  async function inkOn(page: Page, box: { x: number; y: number; width: number; height: number }) {
    const png = await page.screenshot({ clip: box, scale: 'device', animations: 'disabled' })
    const data = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D
      g.drawImage(bmp, 0, 0)
      return Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data)
    }, png.toString('base64'))
    const px: Rgb[] = []
    for (let i = 0; i < data.length; i += 4)
      px.push({ r: data[i] as number, g: data[i + 1] as number, b: data[i + 2] as number })
    const counts = new Map<string, { c: Rgb; n: number }>()
    for (const p of px) {
      const k = hex(p)
      const e = counts.get(k)
      if (e) e.n++
      else counts.set(k, { c: p, n: 1 })
    }
    const bg = [...counts.values()].sort((x, y) => y.n - x.n)[0]?.c as Rgb
    let ink = bg
    for (const p of px) if (ratio(p, bg) > ratio(ink, bg)) ink = p
    return { bg, ink, ratio: Number(ratio(ink, bg).toFixed(2)) }
  }

  async function setTheme(page: Page, scheme: 'light' | 'dark') {
    await page.emulateMedia({ colorScheme: scheme })
    await expect.poll(() => withCanvas(page, (c) => c.theme(), null)).toBe(scheme)
    await page.waitForTimeout(300)
  }

  // the 13 note colours (board-ops elements/palette.ts NOTE_FILL), as a11y-contrast.spec.ts W5-15 lists them
  const FILLS: Record<string, string> = {
    black: '#f8e48f',
    yellow: '#f6c453',
    orange: '#f4a874',
    'light-red': '#f6bfc4',
    red: '#ef8c82',
    'light-violet': '#e3c9f4',
    violet: '#c5a4ea',
    blue: '#a7b7f6',
    'light-blue': '#a6d8f3',
    green: '#93cfa6',
    'light-green': '#cde7a2',
    grey: '#d6d9de',
    white: '#ffffff',
  }

  test('on every note colour, in the light and the dark theme', async ({ join }, testInfo) => {
    const a = await join('alice')
    const names = Object.keys(FILLS)
    const ids: string[] = []
    for (const [i, n] of names.entries()) {
      const id = `k3-c-${n}`
      ids.push(id)
      await typedNote(a.page, id, (i % 5) * 170, Math.floor(i / 5) * 190, 'Ag', FILLS[n])
    }
    // no reload: the label of the note typed last shows too (the server's stamp lands as the save settles)
    // nothing selected: the style panel (top right) covers no note
    await select(a.page, [])
    await setViewport(a.page, { x: -40, y: -40, zoom: 1 })
    for (const id of ids) await expect(label(a.page, id)).toBeVisible()
    const seen: string[] = []
    const low: string[] = []
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(a.page, scheme)
      for (const [i, id] of ids.entries()) {
        const box = await label(a.page, id).boundingBox()
        if (!box) throw new Error(`no label box on ${id}`)
        // the label's own box: its text and the note's fill under it
        const m = await inkOn(a.page, {
          x: box.x,
          y: box.y,
          width: Math.max(8, box.width),
          height: box.height,
        })
        const what = `${scheme} ${names[i]} ${hex(m.ink)} on ${hex(m.bg)} ${m.ratio}:1`
        seen.push(what)
        if (m.ratio < 4.5) low.push(what)
      }
    }
    testInfo.annotations.push({ type: 'contrast', description: seen.join('; ') })
    console.log(`K3-6 contrast: ${seen.join('; ')}`)
    await a.page.screenshot({ path: testInfo.outputPath('k3-author-labels-dark.png') })
    expect(low).toEqual([])
    // the label is in the corner, inside its note (where tldraw drew it)
    const b = await withCanvas(a.page, (c, id) => c.bounds(id), ids[0] as string)
    if (!b) throw new Error('no note')
    const br = await sceneToScreen(a.page, { x: b.x + b.width, y: b.y + b.height })
    const box = await label(a.page, ids[0] as string).boundingBox()
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(br.x + 1)
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(br.y + 1)
  })
})

test('K3-6: a board open asks /workshop and /private-brainstorm once each', async ({ join, board }) => {
  const a = await join('alice')
  const count = (path: string) => a.net.responses.filter((r) => r.path === path).length
  const workshop = `/api/boards/${board}/workshop`
  const brainstorm = `/api/boards/${board}/private-brainstorm`
  // past the stores' fallback (3 s): a second request would have been sent by now
  await a.page.waitForTimeout(4_000)
  expect(count(workshop)).toBe(1)
  expect(count(brainstorm)).toBe(1)
  // a reload is a new open: one more each
  await reloadBoard(a)
  await a.page.waitForTimeout(4_000)
  expect(count(workshop)).toBe(2)
  expect(count(brainstorm)).toBe(2)
})
