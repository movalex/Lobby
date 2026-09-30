// B8's content-leak search (docs/EXCALIDRAW-MIGRATION.md §8.6.7 "Checked before every commit, by O4").
// O4 runs it; the lead never does (it reads the restored staging boards).
//
//   node e2e/spike-b/b8/leak-check.ts [--no-defaults] [--scan <dir or file>]...
//
// It copies each restored staging board (SPIKE_B8_DIR/tmp/dr-restore-drill-*/rooms/*.sqlite) into a
// scratch folder INSIDE SPIKE_B8_DIR, reads every text field of the copies (tldraw documents and the
// "Recently deleted" rows: every string leaf of every record, split into lines, plus the deleted-by names),
// deletes the copies, and searches the given outputs (default: §8.6.7's scope below) for any of those
// strings; --scan adds more (V3's worktree outputs and probes), --no-defaults searches only those.
//
// It prints ONLY counts: the number of matches (must be 0), the files scanned and the strings searched.
// No string, file name of a match or position is ever printed. Strings shorter than 4 characters, ids,
// the values of structural keys (ids and tldraw schema enums: typeName, type, color, …), numbers and
// short strings are not searched (they would match everywhere and are not
// board content); the report says how many were skipped.
//
// How a string is found (leak-match.ts, since V3's part-3 check): verbatim, JSON- or HTML-escaped,
// wrapped (line breaks inserted), or in part (word windows); a string under 8 characters only as a whole
// token, counted apart and never gating; a string also in the repo's own sources (templates, converter
// fixtures) counted apart as repo-shared.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { countMatches, needlesOf, normalizeText } from './leak-match.ts'

const REPO = resolve(import.meta.dirname, '../../..')
const B8 = process.env.SPIKE_B8_DIR
if (!B8) {
  console.log('SPIKE_B8_DIR is not set')
  process.exit(2)
}

const args = process.argv.slice(2)
const extraScans: string[] = []
for (let i = 0; i < args.length; i++)
  if (args[i] === '--scan' && args[i + 1]) extraScans.push(resolve(args[++i] as string))
const noDefaults = args.includes('--no-defaults')

// ---- 1. the strings of the restored boards (read from copies, never printed) ----

const ID_LIKE =
  /^(?:[a-z]+:[A-Za-z0-9_.:-]+|(?:usr|ast|ver|drv|pbs|pnt|ws|b)[_-][A-Za-z0-9_-]+|(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{16,})$/
const ENUMS = new Set([
  'none',
  'semi',
  'solid',
  'pattern',
  'fill',
  'lined-fill',
  'draw',
  'dashed',
  'dotted',
  'sans',
  'serif',
  'mono',
  'start',
  'middle',
  'end',
  'start-legacy',
  'middle-legacy',
  'end-legacy',
  'black',
  'grey',
  'white',
  'blue',
  'green',
  'yellow',
  'orange',
  'violet',
  'light-blue',
  'light-green',
  'light-red',
  'light-violet',
  'red',
  'rectangle',
  'ellipse',
  'diamond',
  'triangle',
  'arrow',
  'note',
  'text',
  'frame',
  'group',
  'image',
  'video',
  'embed',
  'bookmark',
  'line',
  'highlight',
  'geo',
  'free',
  'straight',
  'cubic',
  'elbow',
  'arc',
  'shape',
  'binding',
  'document',
  'page',
  'asset',
  'paragraph',
  'doc',
  'bold',
  'italic',
  'link',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'hardBreak',
  'codeBlock',
  'image/png',
  'image/jpeg',
  'ready',
  'queued',
  'processing',
  'failed',
  'other',
  'pdf',
  'edge',
  'center',
  'Page 1',
  'Frame',
])
const strings = new Set<string>()
let skipped = 0
const addString = (raw: string) => {
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim()
    if (
      s.length < 4 ||
      ENUMS.has(s) ||
      ID_LIKE.test(s) ||
      /^[-+0-9.e#,: ]+$/i.test(s) ||
      /^#[0-9a-f]{3,8}$/i.test(s)
    ) {
      if (s.length) skipped++
      continue
    }
    strings.add(s)
  }
}
/** Keys whose values are ids or tldraw schema enums, never board content (their values are not searched). */
const STRUCTURAL_KEYS = new Set([
  'id',
  'typeName',
  'type',
  'parentId',
  'index',
  'fromId',
  'toId',
  'assetId',
  'versionId',
  'posterDerivativeId',
  'color',
  'labelColor',
  'fill',
  'dash',
  'size',
  'font',
  'align',
  'verticalAlign',
  'textAlign',
  'geo',
  'kind',
  'spline',
  'arrowheadStart',
  'arrowheadEnd',
  'terminal',
  'snap',
  'mimeType',
  'status',
  'side',
  'rootId',
  'childId',
  'session',
  'sessionId',
  'author',
  'textLastEditedBy',
])
const walk = (v: unknown, depth = 0, key = '') => {
  if (depth > 64) return
  if (typeof v === 'string') {
    if (!STRUCTURAL_KEYS.has(key)) addString(v)
    else skipped++
  } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1, key)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, depth + 1, k)
}

const scratch = join(B8, 'leak-check-tmp')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
let boards = 0
try {
  const tmp = join(B8, 'tmp')
  const drills = existsSync(tmp) ? readdirSync(tmp).filter((d) => d.startsWith('dr-restore-drill-')) : []
  for (const d of drills) {
    const rooms = join(tmp, d, 'rooms')
    if (!existsSync(rooms)) continue
    for (const f of readdirSync(rooms).filter((n) => n.endsWith('.sqlite'))) {
      const copy = join(scratch, f)
      cpSync(join(rooms, f), copy)
      for (const ext of ['-wal', '-shm'])
        if (existsSync(join(rooms, f + ext))) cpSync(join(rooms, f + ext), copy + ext)
      const db = new DatabaseSync(copy, { readOnly: true })
      try {
        for (const r of db.prepare('SELECT state FROM documents').iterate() as Iterable<{
          state: Uint8Array | string
        }>) {
          try {
            walk(JSON.parse(typeof r.state === 'string' ? r.state : Buffer.from(r.state).toString('utf8')))
          } catch {
            // an unreadable row holds nothing searchable
          }
        }
        const hasDeleted = db
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'dr_deleted_records'")
          .get() as { n: number }
        if (Number(hasDeleted.n))
          for (const r of db
            .prepare('SELECT state, deleted_by_name FROM dr_deleted_records')
            .iterate() as Iterable<{ state: string; deleted_by_name: string }>) {
            addString(r.deleted_by_name)
            try {
              walk(JSON.parse(r.state))
            } catch {
              // skip
            }
          }
      } finally {
        db.close()
      }
      boards++
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

// ---- 2. the outputs to search ----

// §8.6.7's scope: the B8 evidence files, the drill and conversion reports, and every Playwright output
// folder (SPIKE_B8_DIR/test-results and this worktree's e2e/test-results). Source code is not in it: code
// written without reading a staging board can only match a common word by coincidence (V3's probes, which
// do read the copies, are added with --scan).
const evidenceDir = join(REPO, 'docs/research/excalidraw/spike-b')
const defaults = [
  ...(existsSync(evidenceDir)
    ? readdirSync(evidenceDir)
        .filter((n) => /^B8/i.test(n))
        .map((n) => join(evidenceDir, n))
    : []),
  join(REPO, 'e2e/test-results'),
  join(B8, 'test-results'),
  join(B8, 'work'),
  join(B8, 'reports'),
]
const TEXT = /\.(md|json|txt|log|html|ts|js|mjs|csv|ya?ml|xml|svg)$/i
const MAX_BYTES = 64 * 1024 * 1024
const files: string[] = []
const collect = (p: string, depth = 0) => {
  if (!existsSync(p) || depth > 20) return
  const st = statSync(p)
  if (st.isFile()) {
    if (TEXT.test(p) && st.size <= MAX_BYTES) files.push(p)
    return
  }
  if (!st.isDirectory()) return
  for (const n of readdirSync(p)) {
    if (n === 'node_modules' || n === '.git') continue
    collect(join(p, n), depth + 1)
  }
}
for (const p of [...(noDefaults ? [] : defaults), ...extraScans]) collect(p)

// the repo's own sources a board made from a template shares text with (public, not board content)
const repoFiles: string[] = []
const collectRepo = (p: string, depth = 0) => {
  if (!existsSync(p) || depth > 12) return
  const st = statSync(p)
  if (st.isFile()) {
    if (/.(ts|json)$/.test(p) && st.size <= MAX_BYTES) repoFiles.push(p)
    return
  }
  if (!st.isDirectory()) return
  for (const n of readdirSync(p)) if (n !== 'node_modules') collectRepo(join(p, n), depth + 1)
}
collectRepo(join(REPO, 'packages/templates/src'))
collectRepo(join(REPO, 'packages/tldraw-import/test/fixtures'))
const repoText = normalizeText(repoFiles.map((f) => readFileSync(f, 'utf8')).join(' '))
const sharedMemo = new Map<string, boolean>()
const isRepoShared = (needle: string) => {
  const known = sharedMemo.get(needle)
  if (known !== undefined) return known
  const v = repoText.includes(needle)
  sharedMemo.set(needle, v)
  return v
}

const needles = needlesOf(strings)
let matches = 0
let shortMatches = 0
let repoShared = 0
for (const f of files) {
  let text = ''
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const m = countMatches(text, needles, isRepoShared)
  matches += m.strings
  shortMatches += m.short
  repoShared += m.repoShared
}

console.log(
  `leak-check: ${matches} matches (boards read: ${boards}, strings searched: ${needles.long.length} and ${needles.windows.length} word windows, short/id/enum values not searched: ${skipped}, files scanned: ${files.length}; not gating: ${shortMatches} whole-token matches of ${needles.short.length} short strings, ${repoShared} repo-shared)`,
)
process.exit(matches === 0 ? 0 : 1)
