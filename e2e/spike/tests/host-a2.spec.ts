import { expect, test } from '@playwright/test'
import { watchPage } from '../support/watch.ts'
import { addNote, centerOf, editor, element, lab, openLab, resetLab, rng, waitEditor } from './host-kit.ts'

// A2 (docs/EXCALIDRAW-MIGRATION.md §8.2): after a lease grant, a synthetic Enter opens the editor on a
// note's label, and creates the label when there is none; keys typed while the grant is pending are
// buffered and replayed in order. Pass: 20/20, no lost or reordered key.
//
// Each case: a note (even cases with a label, odd without), a real click selects it, the fake lease
// server answers after a random 120-420 ms, and the user starts with Enter (P1) or a printable key (P2,
// type-to-edit) and keeps typing (letters, digits, punctuation, spaces, Shift, Backspace, Enter) with a
// per-case key delay of 0 or 30 ms, so some cases finish typing before the grant and some straddle it.
// Expected text = Lobby's semantics: the caret goes to the END of the existing text (A11Y-12, COL-04),
// then every key applies in order.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?-_()@#'
const CASES = 20

type Key = { kind: 'char'; ch: string } | { kind: 'Backspace' } | { kind: 'Enter' }

function apply(text: string, keys: Key[]): string {
  let t = text
  for (const k of keys) {
    if (k.kind === 'char') t += k.ch
    else if (k.kind === 'Enter') t += '\n'
    else t = t.slice(0, -1)
  }
  return t
}

test('A2: grant -> synthetic Enter opens (or creates) the label; buffered keys replay in order, 20/20', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const watch = watchPage(page)
  await openLab(page, { grant: 200 })
  const results: Record<string, unknown>[] = []
  const rand = rng(0xa2)

  for (let i = 0; i < CASES; i++) {
    await resetLab(page)
    const withLabel = i % 2 === 0
    const seed = withLabel ? `Seed ${i}` : undefined
    const ids = await addNote(page, { x: 220, y: 160, size: 200, text: seed })
    const delay = 120 + Math.floor(rand() * 300)
    await lab(page, (x, d) => x.lease.setDelay(d), delay)
    // A real click selects the note (not on the label: a second click there would be P5).
    const c = await centerOf(page, ids.note)
    await page.mouse.click(c.x + 60, c.y + 70)
    await expect
      .poll(() => page.evaluate(() => window.__lobbySpike?.api?.getAppState().selectedElementIds))
      .toEqual({
        [ids.note]: true,
      })

    const startWithEnter = i % 4 < 2
    const keys: Key[] = []
    if (!startWithEnter) keys.push({ kind: 'char', ch: ALPHABET[Math.floor(rand() * 52)] ?? 'x' })
    const n = 6 + Math.floor(rand() * 9)
    for (let j = 0; j < n; j++) {
      const r = rand()
      if (r < 0.08 && keys.length > 0) keys.push({ kind: 'Backspace' })
      else if (r < 0.14) keys.push({ kind: 'Enter' })
      else keys.push({ kind: 'char', ch: ALPHABET[Math.floor(rand() * ALPHABET.length)] ?? 'y' })
    }
    const keyDelay = i % 3 === 0 ? 30 : 0

    const t0 = Date.now()
    if (startWithEnter) await page.keyboard.press('Enter')
    for (const k of keys) {
      if (k.kind === 'char') await page.keyboard.type(k.ch)
      else await page.keyboard.press(k.kind)
      if (keyDelay) await page.waitForTimeout(keyDelay)
    }
    const typedMs = Date.now() - t0
    const expected = apply(seed ?? '', keys)

    const st = await waitEditor(
      page,
      (e) => e.phase === 'open' && e.textarea?.value === expected,
      5000,
    ).catch(async () => editor(page))
    const traces = await lab(page, (x) => x.traces.filter((t: { type: string }) => t.type !== 'key'))
    const buffered = traces.filter((t: { type: string }) => t.type === 'buffer').length
    const opened = traces.find((t: { type: string }) => t.type === 'open') as
      | { replayedCount?: number }
      | undefined
    const acquire = traces.filter((t: { type: string }) => t.type === 'acquire')
    const grant = traces.find((t: { type: string }) => t.type === 'grant') as { at: number } | undefined
    const synthetic = traces.find((t: { type: string }) => t.type === 'synthetic-enter') as
      | { at: number }
      | undefined

    // The editor opened only after the grant, through the synthetic Enter.
    const orderOk = !!grant && !!synthetic && synthetic.at >= grant.at
    const valueOk = st.textarea?.value === expected

    await page.keyboard.press('Escape')
    await waitEditor(page, (e) => e.phase === 'idle' && e.textarea === null)
    const note = await element(page, ids.note)
    const labelId = note?.boundElements?.find((b) => b.type === 'text')?.id
    const label = labelId ? await element(page, labelId) : undefined
    const stored = (label?.originalText as string | undefined) ?? ''
    const expectStored = expected.trim() ? expected : ''
    const labelOk = expected.trim()
      ? !!label && label.containerId === ids.note && !label.isDeleted && stored === expected
      : true
    const released = await lab(page, (x, id) => !x.lease.isHeld(id), ids.note)

    results.push({
      case: i,
      withLabel,
      start: startWithEnter ? 'Enter (P1)' : 'printable (P2)',
      delay,
      keyDelay,
      keys: keys.length,
      typedMs,
      buffered,
      replayed: opened?.replayedCount ?? null,
      acquires: acquire.length,
      labelCreated: !withLabel && !!label,
      orderOk,
      valueOk,
      labelOk,
      released,
      expected: JSON.stringify(expected),
      got: JSON.stringify(st.textarea?.value ?? null),
      stored: JSON.stringify(stored),
      expectStored: JSON.stringify(expectStored),
    })
  }

  console.log('A2-RESULTS', JSON.stringify(results))
  const pass = results.filter((r) => r.orderOk && r.valueOk && r.labelOk && r.released && r.acquires === 1)
  console.log('A2-SUMMARY', JSON.stringify({ pass: pass.length, of: CASES }))
  expect(
    results.filter((r) => !(r.orderOk && r.valueOk && r.labelOk && r.released && r.acquires === 1)),
  ).toEqual([])
  expect(
    results.some((r) => (r.buffered as number) > 0 && (r.buffered as number) < (r.keys as number) + 1),
  ).toBe(true) // some cases straddled the grant
  expect(watch.pageErrors).toEqual([])
  expect(watch.foreignRequests()).toEqual([])
})
