// Wave R (the foundation; docs/WAVE-R-CONTRACTS.md §2.4): a board an import job is still building (boards.status
// 'importing', migration 0035) is invisible to every existing list and route, for everyone, its own owner included:
// each answers as for a board that does not exist. And a source tripwire: no api query or check may say "not trashed"
// (which would take in `importing`); it names the statuses it keeps instead.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
} from './helpers.ts'

let api: TestApi
let alice: Client // Dev Studio's owner, and the importing board's owner
let bob: Client // a Dev Studio member
let visible: string
const HIDDEN = 'b-importing01'
const MISSING = 'b-nosuchboard'
const TITLE = 'Hidden import zebra'

beforeAll(async () => {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob')
  visible = await createBoard(alice, DEV_STUDIO, `Visible ${TITLE}`)
  await alice.req('PATCH', `/api/boards/${visible}`, { visibility: 'workspace_edit' })
  // what the import runner's first step leaves (features/imports/finalize.ts createImportingBoard): the row with its
  // owner's grant, here made as visible as a board can be
  await api.db.query(
    `INSERT INTO boards (id, workspace_id, title, created_by, status, visibility)
     VALUES ($1, $2, $3, $4, 'importing', 'workspace_edit')`,
    [HIDDEN, DEV_STUDIO, TITLE, alice.userId],
  )
  await api.db.query(
    `INSERT INTO board_members (board_id, user_id, role, added_by) VALUES ($1, $2, 'owner', $2)`,
    [HIDDEN, alice.userId],
  )
})
afterAll(() => api?.close())

const listed = async (c: Client, status: string) => {
  const res = await c.req('GET', `/api/workspaces/${DEV_STUDIO}/boards?status=${status}`)
  expect(res.statusCode, `${status}: ${res.body}`).toBe(200)
  return (res.json() as { boards: { id: string }[] }).boards.map((b) => b.id)
}

describe('an importing board', () => {
  it('is in no dashboard list, and no list can be asked for it', async () => {
    for (const who of [alice, bob]) {
      expect(await listed(who, 'active')).toContain(visible)
      for (const status of ['active', 'archived', 'trashed'])
        expect(await listed(who, status)).not.toContain(HIDDEN)
      const asked = await who.req('GET', `/api/workspaces/${DEV_STUDIO}/boards?status=importing`)
      expect(asked.statusCode).toBe(400)
    }
  })

  it('answers every board route exactly as a board that does not exist', async () => {
    const calls: [string, string, unknown][] = [
      ['GET', '/api/boards/:bid', undefined],
      ['POST', '/api/boards/:bid/ticket', {}],
      ['PATCH', '/api/boards/:bid', { title: 'Renamed' }],
      ['POST', '/api/boards/:bid/archive', {}],
      ['POST', '/api/boards/:bid/trash', {}],
      ['POST', '/api/boards/:bid/restore', {}],
      ['POST', '/api/boards/:bid/duplicate', {}],
      ['GET', '/api/boards/:bid/members', undefined],
      ['GET', '/api/boards/:bid/export', undefined],
      ['GET', '/api/boards/:bid/snapshots', undefined],
      ['GET', '/api/boards/:bid/comments', undefined],
    ]
    for (const who of [alice, bob])
      for (const [method, pattern, body] of calls) {
        const hidden = await who.req(method as 'GET', pattern.replace(':bid', HIDDEN), body)
        const missing = await who.req(method as 'GET', pattern.replace(':bid', MISSING), body)
        expect({ pattern, status: hidden.statusCode }).toEqual({ pattern, status: missing.statusCode })
        expect(hidden.statusCode, `${method} ${pattern}: ${hidden.body}`).toBe(404)
        expect(hidden.json(), pattern).toEqual(missing.json())
      }
    // nothing changed on it
    expect(await api.db.one('SELECT title, status FROM boards WHERE id = $1', [HIDDEN])).toEqual({
      title: TITLE,
      status: 'importing',
    })
  })

  it('gives the sync server no role for anyone (one pair, and many)', async () => {
    const secret = { 'x-draftroom-internal': INTERNAL_SECRET }
    const url = `/internal/access?boardId=${HIDDEN}&userId=${alice.userId}`
    const one = await api.anon('GET', url, undefined, secret)
    expect(one.statusCode).toBe(200)
    expect(one.json().role).toBeNull()
    const many = await api.anon(
      'POST',
      '/internal/access-many',
      {
        pairs: [
          { boardId: HIDDEN, userId: alice.userId },
          { boardId: visible, userId: alice.userId },
        ],
      },
      secret,
    )
    expect(many.statusCode, many.body).toBe(200)
    const roles = (many.json() as { results: { boardId: string; role: string | null }[] }).results
    expect(roles.find((r) => r.boardId === HIDDEN)?.role ?? null).toBeNull()
    expect(roles.find((r) => r.boardId === visible)?.role).toBe('owner')
  })
})

// ---- the source tripwire ------------------------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function sources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      out.push({ file: relative(SRC, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') })
  }
  return out
}

describe('source tripwire (apps/api/src)', () => {
  it('no query or check keeps boards by "not trashed" (it would keep importing boards too)', () => {
    const NOT_TRASHED = /(<>|!=|!==)\s*'trashed'|'trashed'\s*(<>|!=|!==)|NOT\s+IN\s*\(\s*'trashed'\s*\)/i
    const found = sources(SRC).flatMap(({ file, text }) =>
      text
        .split('\n')
        .map((line, i) => ({ file, line: i + 1, text: line }))
        .filter((l) => NOT_TRASHED.test(l.text)),
    )
    // thumbnails/index.ts filters a list the routes already built (only boards the caller may see): its two checks
    // only pick which of those get a thumbnail version
    const allowed = found.filter((l) => l.file !== 'features/thumbnails/index.ts')
    expect(allowed.map((l) => `${l.file}:${l.line}: ${l.text.trim()}`)).toEqual([])
    expect(NOT_TRASHED.test("WHERE b.status <> 'trashed'")).toBe(true)
    expect(NOT_TRASHED.test("status IN ('active', 'archived')")).toBe(false)
  })
})
