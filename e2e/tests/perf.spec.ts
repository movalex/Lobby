// perf (docs/WAVE4-CONTRACTS.md §2): what the performance fixes must keep true, and a smoke run of the
// measurement harness (e2e/perf) so it keeps working as the app changes. The numbers themselves are
// the opt-in budget run (`pnpm --filter @draftroom/e2e perf`), not this suite: this machine is shared.
import type { Page } from '@playwright/test'
import { measureFps } from '../perf/fps.ts'
import { initScript, measureLatency } from '../perf/latency.ts'
import { seedHeavyBoard } from '../perf/seed.ts'
import { edit, getShape, read, shapeBounds, waitForBoard } from './support/board.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'

const NOTE = 'shape:perf-label-note'
const MARKER = 'Label cache marker'

/** Counts the text measurements (tldraw TextManager.measureHtml) of the test note's text in this tab. */
async function countNoteMeasures(page: Page) {
  await page.evaluate((marker) => {
    const w = window as unknown as {
      editor: { textMeasure: { measureHtml: (html: string, ...rest: unknown[]) => unknown } }
      __noteMeasures?: number
    }
    const tm = w.editor.textMeasure
    const original = tm.measureHtml.bind(tm)
    w.__noteMeasures = 0
    tm.measureHtml = (html: string, ...rest: unknown[]) => {
      if (html.includes(marker)) w.__noteMeasures = (w.__noteMeasures ?? 0) + 1
      return original(html, ...rest)
    }
  }, MARKER)
  return () => page.evaluate(() => (window as unknown as { __noteMeasures?: number }).__noteMeasures ?? 0)
}

test('note labels: a colour, a tag or a move never measures the text again; new text and size do (both tabs)', async ({
  session,
}) => {
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    a.page,
    (ed, arg) =>
      ed.createShape({
        id: arg.id,
        type: 'note',
        x: 160,
        y: 160,
        props: { richText: arg.text, font: 'sans' },
      }),
    { id: NOTE, text: richText(`${MARKER} short`) },
  )
  await expect.poll(() => getShape(b.page, NOTE).then((s) => !!s)).toBe(true)
  const measuresA = await countNoteMeasures(a.page)
  const measuresB = await countNoteMeasures(b.page)

  await test.step('colour, a meta key (a tag) and a move: no measurement anywhere', async () => {
    await edit(a.page, (ed, id) => ed.updateShape({ id, type: 'note', props: { color: 'light-blue' } }), NOTE)
    await edit(
      a.page,
      (ed, id) =>
        ed.updateShape({ id, type: 'note', meta: { 'drTags:idea': { name: 'Idea', color: 'violet' } } }),
      NOTE,
    )
    await edit(a.page, (ed, id) => ed.updateShape({ id, type: 'note', x: 240 }), NOTE)
    await expect
      .poll(() => getShape(b.page, NOTE).then((s) => [s?.x, s?.props.color, !!s?.meta['drTags:idea']]))
      .toEqual([240, 'light-blue', true])
    // both tabs re-derived the note's geometry for these (props and meta changed) without measuring
    await read(b.page, (ed, id) => ed.getShapePageBounds(id), NOTE)
    expect(await measuresA()).toBe(0)
    expect(await measuresB()).toBe(0)
  })

  await test.step('longer text: measured, and the note grows to fit in both tabs', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `${MARKER} line ${i + 1}`).join('\n')
    await edit(
      a.page,
      (ed, arg) => ed.updateShape({ id: arg.id, type: 'note', props: { richText: arg.text } }),
      { id: NOTE, text: richText(long) },
    )
    await expect.poll(() => shapeBounds(b.page, NOTE).then((r) => r?.h ?? 0)).toBeGreaterThan(260)
    expect(await measuresA()).toBeGreaterThan(0)
    expect(await measuresB()).toBeGreaterThan(0)
    const grown = (await getShape(a.page, NOTE))?.props.growY
    expect(grown).toBeGreaterThan(0)
    expect((await getShape(b.page, NOTE))?.props.growY).toBe(grown)
  })

  await test.step('a bigger size measures again and grows the note further', async () => {
    const before = (await shapeBounds(b.page, NOTE))?.h ?? 0
    const counted = await measuresA()
    await edit(a.page, (ed, id) => ed.updateShape({ id, type: 'note', props: { size: 'xl' } }), NOTE)
    await expect.poll(() => shapeBounds(b.page, NOTE).then((r) => r?.h ?? 0)).toBeGreaterThan(before)
    expect(await measuresA()).toBeGreaterThan(counted)
  })
})

test('perf harness smoke: seeds a small heavy board, measures edit visibility between two tabs and pan frame rate', async ({
  session,
  board,
}) => {
  test.setTimeout(240_000)
  const log = (s: string) => test.info().annotations.push({ type: 'perf', description: s })
  const a = await session('alice')
  const seeded = await seedHeavyBoard(a.page, board, { frames: 2, notes: 120, images: 4, comments: 2 }, log)
  expect(seeded.shapes).toBe(2 + 120 + 4)
  const b = await session('bob')
  // The harness's WebSocket timing wrapper must be in place before the app connects.
  for (const s of [a, b]) {
    await s.context.addInitScript(initScript)
    await s.page.reload()
    await waitForBoard(s.page)
    await expect.poll(() => read(s.page, (ed) => ed.getCurrentPageShapes().length)).toBe(seeded.shapes)
  }
  await expect(b.page.getByTestId('comment-pin')).toHaveCount(2)

  const latency = await measureLatency({
    writerPage: a.page,
    observerPage: b.page,
    writerName: 'alice',
    view: '100',
    edits: 30,
    warmup: 5,
    log,
  })
  expect(latency.seen).toBe(30)
  expect(latency.visible.n).toBe(30)
  // sanity only (a shared CI machine): every edit showed up, within seconds, and the split adds up
  expect(latency.visible.p95).toBeGreaterThan(0)
  expect(latency.visible.p95).toBeLessThan(5_000)
  expect(latency.split.wire.n).toBe(30)

  const cdp = await a.context.newCDPSession(a.page)
  const [fps] = await measureFps({
    page: a.page,
    cdp,
    views: ['fit'],
    reps: 1,
    durationMs: 1_000,
    trace: true,
    profile: false,
    log,
  })
  expect(fps?.visibleShapes).toBe(seeded.shapes)
  expect(fps?.medianFps).toBeGreaterThan(1)
  expect(fps?.trace?.drawFrames).toBeGreaterThan(0)
})
