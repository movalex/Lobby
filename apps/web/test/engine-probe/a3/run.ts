/**
 * Spike check A3 (plan §8.2): a server-made note matches the browser's layout.
 * Pass: line breaks differ in at most 3 of 208 labels.
 *
 *   node apps/web/test/engine-probe/a3/run.ts [--runs=3] [--port=7750]   (default: E2E_PORT_BASE + 10 when set)
 *
 * Each run: (1) the Node layout in a fresh plain-node child process, with and without kerning;
 * (2) a fresh headless Chromium lays the same corpus out with Excalidraw's canvas metrics and the
 * package's fonts; (3) the two are compared label by label.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildProbePage, openProbePage, probePort } from '../browser/browser.ts'
import { buildCorpus, type CorpusLabel } from './corpus.ts'
import type { LabelLayout } from './layout-labels.ts'

const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
const runs = Number(arg('runs', '3'))
const port = probePort(10, 7750)
const outDir = fileURLToPath(new URL('../../../../../test-results/engine-probe/', import.meta.url))
const nodeScript = fileURLToPath(new URL('./node-layout.ts', import.meta.url))
const MAX_DIFFERING = 3

interface NodeOut {
  runtime: unknown
  kerning: boolean
  ms: number
  stats: unknown
  layouts: LabelLayout[]
}

const nodeLayout = (labels: CorpusLabel[], kerning: boolean): NodeOut =>
  JSON.parse(
    execFileSync(process.execPath, [nodeScript, ...(kerning ? [] : ['--no-kerning'])], {
      input: JSON.stringify(labels),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  )

/** Supplementary (not the pass criterion): every label also in the other family, and in Comic Shanns. */
const variants = (corpus: CorpusLabel[]): Record<string, CorpusLabel[]> => ({
  swapFamily: corpus.map((l) => ({ ...l, id: `${l.id}-swap`, fontFamily: l.fontFamily === 6 ? 5 : 6 })),
  comicShanns: corpus.map((l) => ({ ...l, id: `${l.id}-mono`, fontFamily: 8 })),
})

const compare = (corpus: CorpusLabel[], node: LabelLayout[], browser: LabelLayout[]) => {
  const diffs = []
  let fontSizeDiffers = 0
  let maxNoteHeightDelta = 0
  let maxLabelWidthDelta = 0
  for (const [i, l] of corpus.entries()) {
    const n = node[i]
    const b = browser[i]
    if (!n || !b || n.id !== l.id || b.id !== l.id) throw new Error(`misaligned result at ${i}`)
    if (n.fontSize !== b.fontSize) fontSizeDiffers++
    maxNoteHeightDelta = Math.max(maxNoteHeightDelta, Math.abs(n.noteHeight - b.noteHeight))
    maxLabelWidthDelta = Math.max(maxLabelWidthDelta, Math.abs((n.labelWidth ?? 0) - (b.labelWidth ?? 0)))
    if (n.text !== b.text) {
      diffs.push({
        id: l.id,
        category: l.category,
        fontFamily: l.fontFamily,
        baseFontSize: l.baseFontSize,
        width: l.width,
        linesNode: (n.text ?? '').split('\n').length,
        linesBrowser: (b.text ?? '').split('\n').length,
        fontSizeNode: n.fontSize,
        fontSizeBrowser: b.fontSize,
        textNode: n.text,
        textBrowser: b.text,
      })
    }
  }
  const widthDeltas = corpus
    .map((l, i) => ({
      id: l.id,
      category: l.category,
      fontFamily: l.fontFamily,
      dw: Math.abs((node[i]?.labelWidth ?? 0) - (browser[i]?.labelWidth ?? 0)),
    }))
    .sort((a, b) => b.dw - a.dw)
    .slice(0, 8)
    .map((d) => ({ ...d, dw: +d.dw.toFixed(3) }))
  const byCategory: Record<string, number> = {}
  for (const d of diffs) byCategory[d.category] = (byCategory[d.category] ?? 0) + 1
  return {
    differing: diffs.length,
    fontSizeDiffers,
    maxNoteHeightDelta: +maxNoteHeightDelta.toFixed(3),
    maxLabelWidthDelta: +maxLabelWidthDelta.toFixed(3),
    byCategory,
    widthDeltas,
    diffs,
  }
}

mkdirSync(outDir, { recursive: true })
const corpus = buildCorpus()
const categories: Record<string, number> = {}
for (const l of corpus) categories[l.category] = (categories[l.category] ?? 0) + 1
const extra = variants(corpus)
const buildMs = await buildProbePage()
const results = []
for (let run = 1; run <= runs; run++) {
  const node = nodeLayout(corpus, true)
  const nodeNoKern = nodeLayout(corpus, false)
  const nodeExtra = Object.fromEntries(
    Object.entries(extra).map(([k, labels]) => [k, nodeLayout(labels, true)]),
  )
  const s = await openProbePage(port)
  let browser: { layouts: LabelLayout[]; ms: number; fontFaces: unknown }
  const browserExtra: Record<string, LabelLayout[]> = {}
  let a8: unknown
  try {
    const r = await s.page.evaluate((labels) => window.__probe.layout?.(labels), corpus)
    if (!r) throw new Error('layout() missing')
    browser = r
    for (const [k, labels] of Object.entries(extra)) {
      const x = await s.page.evaluate((l) => window.__probe.layout?.(l), labels)
      if (!x) throw new Error('layout() missing')
      browserExtra[k] = x.layouts
    }
    a8 = await s.page.evaluate(() => window.__probe.a8?.())
  } finally {
    await s.close()
  }
  const withKerning = compare(corpus, node.layouts, browser.layouts)
  const perCharOnly = compare(corpus, nodeNoKern.layouts, browser.layouts)
  const supplementary = Object.fromEntries(
    Object.entries(extra).map(([k, labels]) => {
      const c = compare(labels, nodeExtra[k]?.layouts ?? [], browserExtra[k] ?? [])
      return [
        k,
        {
          differing: c.differing,
          byCategory: c.byCategory,
          fontSizeDiffers: c.fontSizeDiffers,
          diffs: c.diffs,
        },
      ]
    }),
  )
  const pass =
    withKerning.differing <= MAX_DIFFERING && s.foreignRequests.length === 0 && s.pageErrors.length === 0
  const result = {
    run,
    pass,
    corpus: { labels: corpus.length, categories },
    browser: { version: s.browserVersion, ms: browser.ms, fontFaces: browser.fontFaces },
    node: { runtime: node.runtime, ms: node.ms, stats: node.stats },
    foreignRequests: s.foreignRequests,
    pageErrors: s.pageErrors,
    consoleErrors: s.consoleErrors.slice(0, 10),
    withKerning,
    perCharOnly: {
      differing: perCharOnly.differing,
      byCategory: perCharOnly.byCategory,
      fontSizeDiffers: perCharOnly.fontSizeDiffers,
      diffs: perCharOnly.diffs,
    },
    supplementary,
    a8Browser: a8,
  }
  results.push(result)
  writeFileSync(`${outDir}a3-run${run}.json`, JSON.stringify(result, null, 1))
  console.log(
    `run ${run}: ${pass ? 'PASS' : 'FAIL'} — line breaks differ in ${withKerning.differing}/${corpus.length} ` +
      `(per-char table without kerning: ${perCharOnly.differing}); font size differs in ${withKerning.fontSizeDiffers}; ` +
      `by category ${JSON.stringify(withKerning.byCategory)}; foreign requests ${s.foreignRequests.length}; ` +
      `node ${node.ms.toFixed(1)} ms, browser ${browser.ms.toFixed(1)} ms; supplementary ` +
      Object.entries(supplementary)
        .map(([k, v]) => `${k} ${v.differing}/${corpus.length} ${JSON.stringify(v.byCategory)}`)
        .join(', '),
  )
}
console.log(`build ${Math.round(buildMs)} ms; ${results.filter((r) => r.pass).length}/${runs} runs pass`)
process.exitCode = results.every((r) => r.pass) ? 0 : 1
