/**
 * Writes `packages/canvas-schema/src/engine/text-metrics-table.json`: the server's text metrics,
 * measured in headless Chromium from Excalidraw's own fonts (plan §2.11). Re-run on any Excalidraw
 * bump or font change, then re-run A3.
 *
 *   node apps/web/test/engine-probe/a3/calibrate-table.ts
 *
 * `CALIBRATE_FAMILIES=7` (a comma-separated list) measures only those families and merges them into the
 * existing table, leaving every other family's numbers as they are (how Lilita One, 7, was added for D3).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildProbePage, openProbePage } from '../browser/browser.ts'
import { corpusChars } from './corpus.ts'

const tablePath = fileURLToPath(
  new URL('../../../../../packages/canvas-schema/src/engine/text-metrics-table.json', import.meta.url),
)
const outDir = fileURLToPath(new URL('../../../../../test-results/engine-probe/', import.meta.url))

const buildMs = await buildProbePage()
const s = await openProbePage(Number(process.env.PROBE_PORT ?? 7750))
try {
  const heldOut = [...corpusChars()]
  const only = process.env.CALIBRATE_FAMILIES
    ? process.env.CALIBRATE_FAMILIES.split(',').map((x) => Number(x.trim()))
    : undefined
  const r = await s.page.evaluate(([h, o]) => window.__probe.calibrate?.(h, o), [heldOut, only] as const)
  if (!r) throw new Error('calibrate() missing')
  if (only) {
    const cur = JSON.parse(readFileSync(tablePath, 'utf8')) as { families: Record<string, unknown> }
    const add = (r.table as { families: Record<string, unknown> }).families
    const families = Object.fromEntries(
      Object.entries({ ...cur.families, ...add }).sort(([a], [b]) => Number(a) - Number(b)),
    )
    writeFileSync(tablePath, `${JSON.stringify({ ...cur, families })}\n`)
  } else writeFileSync(tablePath, `${JSON.stringify(r.table)}\n`)
  mkdirSync(outDir, { recursive: true })
  const lin = r.linearity.map((x) => ({ ...x, relErr: Math.abs(x.measured - x.scaled) / x.measured }))
  writeFileSync(
    `${outDir}a3-calibration.json`,
    JSON.stringify(
      {
        browser: s.browserVersion,
        buildMs: Math.round(buildMs),
        foreignRequests: s.foreignRequests,
        pageErrors: s.pageErrors,
        excludedSamples: r.excludedSamples,
        spread: r.spread,
        maxLinearityRelErr: Math.max(...lin.map((x) => x.relErr)),
        linearity: lin,
      },
      null,
      1,
    ),
  )
  const t = r.table as { families: Record<string, { adv: object; kern: object; classes: object }> }
  for (const [id, f] of Object.entries(t.families))
    console.log(
      `family ${id}: adv ${Object.keys(f.adv).length}, kern pairs ${Object.keys(f.kern).length}, classes ${JSON.stringify(f.classes)}`,
    )
  console.log('max linearity rel err', Math.max(...lin.map((x) => x.relErr)))
  console.log('foreign requests', s.foreignRequests.length, 'page errors', s.pageErrors.length)
} finally {
  await s.close()
}
