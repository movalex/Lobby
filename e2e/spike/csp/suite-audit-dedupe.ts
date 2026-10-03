// Summarises a whole-suite CSP audit (suite-audit.config.ts): reads the collector's reports.jsonl and the
// reporter's timeline.jsonl from --dir, files each report under the test that was running when it
// arrived, and groups the reports by (effective directive, blocked resource, source file name). The
// blocked resource is reduced to a keyword (inline, eval, wasm-eval, data, blob, ...) or scheme://host.
// For a source file in the build's /assets/, --dist adds the bundle text around line:column (so the
// feature can be named without sourcemaps). Prints the summary as JSON (or writes --out). No board
// content: document paths are reduced to their route (/b/<id>), query strings dropped.
//
//   node e2e/spike/csp/suite-audit-dedupe.ts --dir <audit dir> --dist apps/web/dist/csp-audit-6532 [--out f]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string' },
    dist: { type: 'string' },
    out: { type: 'string' },
    context: { type: 'string', default: '90' },
  },
})
if (!args.dir) throw new Error('--dir is required (the folder with reports.jsonl and timeline.jsonl)')
const dir = resolve(args.dir)
const CONTEXT = Number(args.context)

interface Report {
  t: number
  document: string
  directive: string
  blocked: string
  source: string
  line: number
  column: number
  sample: string
  disposition: string
  status: number
}

const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : []

/** report-uri bodies ({"csp-report": {...}}) and Reporting API entries ({type, body: {...}}) alike. */
function normalise(line: Record<string, unknown>): Report | null {
  const raw = line.report as Record<string, unknown> | string
  if (!raw || typeof raw !== 'object') return null
  const legacy = raw['csp-report'] as Record<string, unknown> | undefined
  const api = (raw.type === 'csp-violation' ? raw.body : undefined) as Record<string, unknown> | undefined
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  if (legacy)
    return {
      t: Number(line.t),
      document: s(legacy['document-uri']),
      directive: s(legacy['effective-directive']) || s(legacy['violated-directive']),
      blocked: s(legacy['blocked-uri']),
      source: s(legacy['source-file']),
      line: n(legacy['line-number']),
      column: n(legacy['column-number']),
      sample: s(legacy['script-sample']),
      disposition: s(legacy.disposition),
      status: n(legacy['status-code']),
    }
  if (api)
    return {
      t: Number(line.t),
      document: s(api.documentURL),
      directive: s(api.effectiveDirective),
      blocked: s(api.blockedURL),
      source: s(api.sourceFile),
      line: n(api.lineNumber),
      column: n(api.columnNumber),
      sample: s(api.sample),
      disposition: s(api.disposition),
      status: n(api.statusCode),
    }
  return null
}

/** inline / eval / wasm-eval / data / blob / ... stay keywords; a URL becomes scheme://host[:port]. */
function reduceBlocked(b: string): string {
  if (!b) return '(empty)'
  if (/^[a-z-]+$/.test(b)) return b
  try {
    const u = new URL(b)
    if (u.protocol === 'data:' || u.protocol === 'blob:') return u.protocol.slice(0, -1)
    return `${u.protocol}//${u.host}`
  } catch {
    return b.slice(0, 40)
  }
}

const basename = (src: string) => {
  if (!src) return '(none)'
  try {
    const u = new URL(src)
    return u.pathname.split('/').pop() || u.href.slice(0, 60)
  } catch {
    return src.split('/').pop() || src
  }
}

/** The document's route: board ids and other ids masked, no query or fragment. */
function route(doc: string): string {
  try {
    const u = new URL(doc)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}…`
    const segs = u.pathname.split('/')
    return segs
      .map((seg, i) =>
        (i > 1 && segs[i - 1] === 'b') || /^[0-9a-f-]{8,}$|^[A-Za-z0-9_-]{16,}$/.test(seg) ? '<id>' : seg,
      )
      .join('/')
  } catch {
    return doc.slice(0, 40)
  }
}

const bundles = new Map<string, string[]>()
function snippet(src: string, line: number, column: number): string | undefined {
  if (!args.dist || !line) return undefined
  let path: string
  try {
    path = new URL(src).pathname
  } catch {
    return undefined
  }
  if (!path.startsWith('/assets/') && !path.endsWith('.js')) return undefined
  const file = join(resolve(args.dist), decodeURIComponent(path))
  if (!existsSync(file)) return undefined
  let text = bundles.get(file)
  if (!text) {
    text = readFileSync(file, 'utf8').split('\n')
    bundles.set(file, text)
  }
  const l = text[line - 1]
  if (l === undefined) return undefined
  const at = Math.max(0, column - 1)
  return l.slice(Math.max(0, at - CONTEXT), at + CONTEXT)
}

const reports = lines(join(dir, 'reports.jsonl'))
  .map(normalise)
  .filter((r): r is Report => r !== null)
const timeline = lines(join(dir, 'timeline.jsonl'))
const begins = timeline
  .filter((e) => e.ev === 'begin')
  .map((e) => ({ t: Number(e.t), spec: `${e.file}:${e.line}`, title: String(e.title) }))
  .sort((a, b) => a.t - b.t)
const testAt = (t: number) => {
  let hit: (typeof begins)[number] | undefined
  for (const b of begins) {
    if (b.t <= t) hit = b
    else break
  }
  return hit
}

interface Group {
  directive: string
  blocked: string
  sourceFile: string
  count: number
  representative: string
  sample: string
  bundleSnippet?: string
  dispositions: string[]
  specs: Record<string, number>
  tests: string[]
  documents: Record<string, number>
}
const groups = new Map<string, Group>()
for (const r of reports) {
  const blocked = reduceBlocked(r.blocked)
  const src = basename(r.source)
  const key = `${r.directive}|${blocked}|${src}`
  let g = groups.get(key)
  if (!g) {
    g = {
      directive: r.directive,
      blocked,
      sourceFile: src,
      count: 0,
      representative: `${r.source ? route(r.source) : '(none)'}:${r.line}:${r.column}`,
      sample: r.sample.slice(0, 60),
      bundleSnippet: snippet(r.source, r.line, r.column),
      dispositions: [],
      specs: {},
      tests: [],
      documents: {},
    }
    groups.set(key, g)
  }
  g.count++
  if (!g.dispositions.includes(r.disposition)) g.dispositions.push(r.disposition)
  const test = testAt(r.t)
  const spec = test?.spec.split(':')[0] ?? '(before the first test)'
  g.specs[spec] = (g.specs[spec] ?? 0) + 1
  if (test && g.tests.length < 8 && !g.tests.includes(`${test.spec} ${test.title.slice(0, 80)}`))
    g.tests.push(`${test.spec} ${test.title.slice(0, 80)}`)
  const doc = route(r.document)
  g.documents[doc] = (g.documents[doc] ?? 0) + 1
}

const end = timeline.find((e) => e.ev === 'run-end')
const summary = {
  reports: reports.length,
  groups: [...groups.values()].sort((a, b) => b.count - a.count),
  run: end ?? null,
  tests: {
    began: begins.length,
    failed: timeline
      .filter((e) => e.ev === 'end' && e.outcome === 'unexpected')
      .map((e) => `${e.file}:${e.line} ${String(e.title).slice(0, 80)} — ${e.error ?? ''}`),
  },
}
const text = JSON.stringify(summary, null, 2)
if (args.out) writeFileSync(resolve(args.out), text)
else console.log(text)
