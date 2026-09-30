// B8's content-leak search (e2e/spike-b/b8/leak-check.ts, leak-match.ts; §8.6.7), on a SYNTHETIC canary
// board (no staging data): V3 (part-3 round) found the search saw only a verbatim, whole copy of a board
// line. These cases failed on de3dc40 (the escaped, wrapped and partial copies gave 0 matches; a 4-character
// string matched inside any word) and pass with leak-match.ts.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
