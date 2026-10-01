// B8's content-leak search (e2e/spike-b/b8/leak-check.ts, leak-match.ts; §8.6.7), on a SYNTHETIC canary
// board (no staging data): V3 (part-3 round) found the search saw only a verbatim, whole copy of a board
// line. These cases failed on de3dc40 (the escaped, wrapped and partial copies gave 0 matches; a 4-character
// string matched inside any word) and pass with leak-match.ts.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { countMatches, hasToken, needlesOf, normalizeText } from '../../../../e2e/spike-b/b8/leak-match.ts'

const REPO = resolve(import.meta.dirname, '../../../..')
const LINE = 'Zephyr "Q9" roadmap review with Quillfeather & Brambleton partners'

describe('leak-match: the forms a board line takes in an output', () => {
  const n = needlesOf([LINE, 'Todo'])
  const count = (text: string) => countMatches(text, n).strings
  it.each([
    ['verbatim', `x ${LINE} y`],
    ['JSON-escaped', JSON.stringify({ text: LINE })],
    [
      'HTML-escaped',
      '<td>Zephyr &quot;Q9&quot; roadmap review with Quillfeather &amp; Brambleton partners</td>',
    ],
    [
      'wrapped by the engine',
      JSON.stringify({ text: 'Zephyr "Q9" roadmap review with\nQuillfeather & Brambleton partners' }),
    ],
    ['in part', 'detail: roadmap review with Quillfeather'],
  ])('%s: found', (_name, text) => {
    expect(count(text)).toBeGreaterThan(0)
  })

  it('unrelated text and ordinary short phrases are not matches', () => {
    expect(count('a review with partners of the roadmap, at the same time')).toBe(0)
    expect(count('')).toBe(0)
  })

  it('a short string matches only as a whole token, and is counted apart (never gating)', () => {
    expect(hasToken(normalizeText('the Todos list'), 'Todo')).toBe(false)
    expect(countMatches('the Todos list', n)).toEqual({ strings: 0, short: 0, repoShared: 0 })
    expect(countMatches('Todo: ship it', n)).toEqual({ strings: 0, short: 1, repoShared: 0 })
  })

  it('a string the repo itself holds (a template line) is counted apart as repo-shared', () => {
    const shared = needlesOf(['Brainstorm your ideas here together'])
    const m = countMatches('... Brainstorm your ideas here together ...', shared, () => true)
    expect(m.strings).toBe(0)
    expect(m.repoShared).toBeGreaterThan(0)
  })
})

describe('leak-check.ts on a synthetic restored board', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leak-check-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const rooms = join(dir, 'tmp', 'dr-restore-drill-FAKE', 'rooms')
  mkdirSync(rooms, { recursive: true })
  const db = new DatabaseSync(join(rooms, 'board-b-fake000001.sqlite'))
  db.exec('CREATE TABLE documents (id TEXT PRIMARY KEY, state TEXT NOT NULL)')
  db.prepare('INSERT INTO documents (id, state) VALUES (?, ?)').run(
    'shape:canary',
    JSON.stringify({ id: 'shape:canary', typeName: 'shape', type: 'note', props: { text: LINE } }),
  )
  db.close()
  const run = (name: string, text: string) => {
    const out = join(dir, `out-${name}`)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'r.json'), text)
    const r = spawnSync(
      process.execPath,
      [join(REPO, 'e2e/spike-b/b8/leak-check.ts'), '--no-defaults', '--scan', out],
      {
        env: { ...process.env, SPIKE_B8_DIR: dir },
        encoding: 'utf8',
      },
    )
    const m = /leak-check: (\d+) matches/.exec(r.stdout)
    // it prints counts only: never the canary
    expect(r.stdout.includes('Quillfeather')).toBe(false)
    return { status: r.status, matches: Number(m?.[1] ?? -1) }
  }
  it.each([
    ['json', JSON.stringify({ text: LINE })],
    ['html', '<td>Zephyr &quot;Q9&quot; roadmap review with Quillfeather &amp; Brambleton partners</td>'],
    ['partial', 'detail: roadmap review with Quillfeather'],
    [
      'wrapped',
      JSON.stringify({ text: 'Zephyr "Q9" roadmap review with\nQuillfeather & Brambleton partners' }),
    ],
  ])('an output with the %s copy fails the check', (name, text) => {
    const r = run(name, text)
    expect(r.matches).toBeGreaterThan(0)
    expect(r.status).toBe(1)
  })
  it('an output without it passes', () => {
    const r = run('clean', JSON.stringify({ text: 'nothing of the board here' }))
    expect(r).toEqual({ status: 0, matches: 0 })
  })
})

// V3's re-check (wave 5): the forms and files the search still missed. Each failed on f336ae4 (0 matches,
// or "files scanned: 0" for the files it skipped by extension or size) and fails the check now.
describe('leak-check.ts: the forms and files V3 found unsearched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leak-check2-'))
  const outside = mkdtempSync(join(tmpdir(), 'leak-check2-out-'))
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const rooms = join(dir, 'tmp', 'dr-restore-drill-FAKE', 'rooms')
  mkdirSync(rooms, { recursive: true })
  const board = join(rooms, 'board-b-fake000002.sqlite')
  const db = new DatabaseSync(board)
  db.exec('CREATE TABLE documents (id TEXT PRIMARY KEY, state TEXT NOT NULL)')
  db.prepare('INSERT INTO documents (id, state) VALUES (?, ?)').run(
    'shape:canary',
    JSON.stringify({ id: 'shape:canary', typeName: 'shape', type: 'note', props: { text: LINE } }),
  )
  db.close()
  const bs = String.fromCharCode(92)
  const scan = (target: string, env: Record<string, string> = {}) => {
    const r = spawnSync(
      process.execPath,
      [join(REPO, 'e2e/spike-b/b8/leak-check.ts'), '--no-defaults', '--scan', target],
      { env: { ...process.env, SPIKE_B8_DIR: dir, ...env }, encoding: 'utf8' },
    )
    expect(r.stdout.includes('Quillfeather')).toBe(false)
    expect(r.stdout.toLowerCase().includes('quillfeather')).toBe(false)
    return {
      status: r.status,
      matches: Number(/leak-check: (\d+) matches/.exec(r.stdout)?.[1] ?? -1),
      apart: Number(/not gating: (\d+) in binary files/.exec(r.stdout)?.[1] ?? -1),
      scanned: Number(/files scanned: (\d+)/.exec(r.stdout)?.[1] ?? -1),
      chunked: Number(/(\d+) read in chunks/.exec(r.stdout)?.[1] ?? -1),
    }
  }
  const write = (root: string, name: string, file: string, body: string | Buffer) => {
    const out = join(root, `out-${name}`)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, file), body)
    return out
  }
  it.each([
    ['url', 'r.log', `GET /api/search?q=${encodeURIComponent(LINE)} 200`],
    ['form', 'r.log', `body q=${encodeURIComponent(LINE).replace(/%20/g, '+')}`],
    ['upper', 'r.log', `LABEL: ${LINE.toUpperCase()}`],
    ['zero-width', 'r.log', LINE.replace(/ /g, ' \u200b')],
    ['ansi', 'r.log', LINE.replace(/ /g, ' \u001b[0m')],
    ['truncated', 'r.log', `text="${LINE.slice(0, 24)}…"`],
    ['base64', 'r.log', Buffer.from(LINE).toString('base64')],
    ['jsonl', 'r.jsonl', `${JSON.stringify({ text: LINE })}\n`],
    ['no extension', 'stdout', `x ${LINE} y\n`],
    ['excalidraw export', 'board.excalidraw', JSON.stringify({ elements: [{ type: 'text', text: LINE }] })],
    ['double JSON', 'r.json', JSON.stringify(JSON.stringify({ text: LINE }))],
    [
      'unicode escapes',
      'r.json',
      JSON.stringify({ text: LINE }).replace(
        /[a-z]/g,
        (c) => `${bs}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ),
    ],
    ['nbsp', 'r.html', `<p>${LINE.replace(/ /g, '&nbsp;')}</p>`],
    ['numeric entities', 'r.html', `<p>${[...LINE].map((c) => `&#${c.charCodeAt(0)};`).join('')}</p>`],
    ['tabs', 'r.log', LINE.replace(/ /g, '\t')],
    ['CSV', 'r.csv', `"${LINE.replace(/"/g, '""')}"\n`],
  ])('the %s copy fails the check', (name, file, body) => {
    const r = scan(write(dir, name.replace(/\W+/g, '-'), file, body))
    expect(r.matches).toBeGreaterThan(0)
    expect(r.status).toBe(1)
  })

  it('a file over the chunk size is read in chunks, never skipped', () => {
    const out = write(dir, 'big', 'huge.log', `${'x'.repeat(3 * 1024 * 1024)}\n${LINE}\n`)
    const r = scan(out, { LEAK_CHECK_CHUNK_BYTES: String(1024 * 1024) })
    expect(r).toMatchObject({ status: 1, scanned: 1, chunked: 1 })
    expect(r.matches).toBeGreaterThan(0)
  })

  it('a SQLite copy outside SPIKE_B8_DIR fails; inside it (a data dir §8.6.7 allows) it is counted apart', () => {
    const copy = readFileSync(board)
    const out = write(outside, 'sqlite', 'x.sqlite', copy)
    const r = scan(out)
    expect(r.status).toBe(1)
    expect(r.matches).toBeGreaterThan(0)
    const inside = scan(write(dir, 'sqlite-in', 'x.sqlite', copy))
    expect(inside).toMatchObject({ status: 0, matches: 0 })
    expect(inside.apart).toBeGreaterThan(0)
  })

  it('ordinary text with none of it passes, upper-cased or not', () => {
    const r = scan(write(dir, 'clean2', 'r.log', 'A REVIEW WITH PARTNERS OF THE ROADMAP, at the same time'))
    expect(r).toMatchObject({ status: 0, matches: 0 })
  })
})
