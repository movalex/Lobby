// 0039_formats (the wave W foundation; docs/WAVE-W-CONTRACTS.md §10): worker ops and their output reservations, the
// capabilities seen, a version's derived_from_version_id, file text (state and pages) and board_file_refs. An upgrade
// from 0038 adds six tables and one nullable column and changes nothing existing; keys, CHECKs, the one-active-op index
// and the cascades hold. Runs on PGlite, and on a real Postgres with DRAFTROOM_TEST_DATABASE_URL set.

import { afterEach, describe, expect, it } from 'vitest'
import { type Db, loadMigrations, migrate, openPglite, pgErrorCode } from '../src/index.ts'
import { openTestDb } from '../src/testing.ts'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

const columnsOf = async (q: Db) =>
  (
    await q.query<{ k: string }>(
      `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS k
         FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY 1`,
    )
  ).rows.map((r) => r.k)

const constraintsOf = async (q: Db) =>
  (
    await q.query<{ k: string }>(
      `SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) AS k
         FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY 1`,
    )
  ).rows.map((r) => r.k)

const sqlstate = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => pgErrorCode(e),
  )

const count = async (q: Db, table: string) =>
  (await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n

const U = 'usr_alice00000001'
const W = 'wsp_studio0000001'
const W2 = 'wsp_other00000001'
const B = 'b-alpha00001'
const BX = 'b-other00001'
const AST = 'ast_asset00000001'
const V1 = 'ver_version000001'
const V2 = 'ver_version000002'
const VX = 'ver_versionx00001'
const OP = 'wop_operation0001'

async function seed(q: Db) {
  await q.query(`INSERT INTO users (id, name, handle, color) VALUES ($1, 'alice', 'alice', '#3355ff')`, [U])
  for (const w of [W, W2])
    await q.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Studio', $2)`, [w, U])
  for (const [b, w] of [
    [B, W],
    [BX, W2],
  ])
    await q.query(`INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'B', $3)`, [b, w, U])
  for (const [v, w, b] of [
    [V1, W, B],
    [V2, W, B],
    [VX, W2, BX],
  ])
    await q.query(
      `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                   size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, $3, $4, 'deck.pdf', 'application/pdf', 'application/pdf', 'pdf', 10, repeat('a', 64), $5)`,
      [v, AST, w, b, U],
    )
}

const op = (q: Db, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: OP,
    workspace_id: W,
    board_id: B,
    kind: 'remove-bg',
    source_version_id: V1,
    params: {},
    params_key: '-',
    status: 'queued',
    lease_owner: null,
    lease_until: null,
    result: null,
    result_version_id: null,
    requested_by: U,
    error_code: null,
    finished_at: null,
    ...over,
  }
  const cols = Object.keys(row)
  const vals = cols.map((c) => (c === 'params' || c === 'result') && row[c] !== null ? JSON.stringify(row[c]) : row[c])
  return q.query(
    `INSERT INTO worker_ops (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  )
}

const output = (q: Db, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: 'wpo_output0000001',
    op_id: OP,
    attempt: 1,
    role: 'original',
    page: null,
    width: 10,
    height: 10,
    mime_type: 'image/png',
    bytes: 5,
    asset_id: 'ast_newasset00001',
    version_id: 'ver_newversion001',
    derivative_id: null,
    blob_key: 'assets/ast_newasset00001/ver_newversion001/original',
    ...over,
  }
  const cols = Object.keys(row)
  return q.query(
    `INSERT INTO worker_op_outputs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c]),
  )
}

const NEW_TABLES = [
  'worker_ops',
  'worker_op_outputs',
  'worker_capabilities_seen',
  'file_text_state',
  'file_text_pages',
  'board_file_refs',
]
const NEW_COLUMNS = ['asset_versions.derived_from_version_id:text:YES']

describe('wave W migration', () => {
  it('is 0039_formats, right after 0038 (contiguous, the last)', () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 39)?.name).toBe('0039_formats')
    expect(all.at(-1)?.version).toBe(39)
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1))
  })

  it('upgrades a 0038 database additively: six new tables, one new column, no constraint changed', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 38) })
    await seed(d)
    const before = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    expect((await migrate(d)).applied).toEqual(['0039_formats'])
    const after = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    const isNew = (k: string) => NEW_TABLES.some((t) => k.startsWith(`${t}.`))
    expect(after.columns.filter((k) => !isNew(k) && !NEW_COLUMNS.includes(k))).toEqual(before.columns)
    for (const c of NEW_COLUMNS) expect(after.columns, c).toContain(c)
    expect(before.constraints.filter((k) => !after.constraints.includes(k))).toEqual([])
    const added = after.constraints.filter((k) => !before.constraints.includes(k))
    expect(
      added
        .filter((k) => !isNew(k))
        .map((k) => k.split(':')[0])
        .sort(),
    ).toEqual(['asset_versions.asset_versions_derived_from_version_id_fkey'])
    // existing versions are untouched: nothing is derived
    expect((await d.query('SELECT id FROM asset_versions WHERE derived_from_version_id IS NOT NULL')).rows).toEqual([])
    for (const t of NEW_TABLES) expect(await count(d, t), t).toBe(0)
  })
})

describe('0039: worker ops', () => {
  it('ids, kinds, params, params_key and results are checked; the board stays inside its workspace', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    expect(await sqlstate(op(q, { id: 'wop_bad' }))).toBe('23514')
    expect(await sqlstate(op(q, { kind: 'ocr' }))).toBe('23514')
    expect(await sqlstate(op(q, { params: ['x'] }))).toBe('23514')
    expect(await sqlstate(op(q, { params: { pad: 'x'.repeat(1100) } }))).toBe('23514')
    expect(await sqlstate(op(q, { params_key: 'Has Space' }))).toBe('23514')
    expect(await sqlstate(op(q, { board_id: BX }))).toBe('23503')
    expect(await sqlstate(op(q, { source_version_id: 'ver_nothere000001' }))).toBe('23503')
    expect(await sqlstate(op(q, {}))).toBe('no error')
  })

  it('the status decides the lease, finished_at, the error code and the result version', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const t = '2099-01-01T00:00:00Z'
    let n = 0
    const id = () => `wop_status${String(++n).padStart(7, '0')}`
    // each case on its own source and params_key so the active index never interferes
    for (const [over, want] of [
      [{ status: 'running' }, '23514'],
      [{ status: 'running', lease_owner: 'nas-1', lease_until: t }, 'no error'],
      [{ status: 'done' }, '23514'],
      [{ status: 'done', finished_at: t }, 'no error'],
      [{ status: 'queued', finished_at: t }, '23514'],
      [{ status: 'failed', finished_at: t }, '23514'],
      [{ status: 'failed', finished_at: t, error_code: 'REMOVE_BG_FAILED' }, 'no error'],
      [{ status: 'cancelled', finished_at: t, error_code: 'CANCELLED' }, 'no error'],
      [{ status: 'done', finished_at: t, error_code: 'INTERNAL' }, '23514'],
      [{ status: 'failed', finished_at: t, error_code: 'not a code' }, '23514'],
      [{ status: 'done', finished_at: t, result_version_id: V2 }, 'no error'],
      [{ status: 'queued', result_version_id: V2 }, '23514'],
      [{ status: 'done', finished_at: t, kind: 'render-pages', result_version_id: V2 }, '23514'],
      [{ status: 'done', finished_at: t, result: { pad: 'x'.repeat(5000) } }, '23514'],
      [{ status: 'done', finished_at: t, result: { pageCount: 40, rendered: [9, 10] } }, 'no error'],
    ] as const) {
      const key = `k${n + 1}`
      expect(await sqlstate(op(q, { id: id(), params_key: key, ...over })), JSON.stringify(over)).toBe(want)
    }
  })

  it('one active op per kind, source and params_key; finished ones do not count', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await op(q, { id: 'wop_active0000001' })
    expect(await sqlstate(op(q, { id: 'wop_active0000002' }))).toBe('23505')
    expect(
      await sqlstate(op(q, { id: 'wop_active0000003', status: 'running', lease_owner: 'w', lease_until: 'now()' })),
    ).toBe('23505')
    // another kind, another source or other params are separate
    expect(await sqlstate(op(q, { id: 'wop_active0000004', kind: 'extract-text' }))).toBe('no error')
    expect(await sqlstate(op(q, { id: 'wop_active0000005', source_version_id: V2 }))).toBe('no error')
    expect(
      await sqlstate(op(q, { id: 'wop_active0000006', kind: 'render-pages', params_key: '9-38' })),
    ).toBe('no error')
    expect(
      await sqlstate(op(q, { id: 'wop_active0000007', kind: 'render-pages', params_key: '39-40' })),
    ).toBe('no error')
    // once the first is done, a new one may queue
    await q.query(`UPDATE worker_ops SET status = 'done', finished_at = now() WHERE id = 'wop_active0000001'`)
    expect(await sqlstate(op(q, { id: 'wop_active0000008' }))).toBe('no error')
  })

  it('cascades with its source version and board; the result version and the requester are SET NULL', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const U2 = 'usr_bob0000000001'
    await q.query(`INSERT INTO users (id, name, handle, color) VALUES ($1, 'bob', 'bob', '#3355ff')`, [U2])
    await op(q, { status: 'done', finished_at: '2099-01-01T00:00:00Z', result_version_id: V2, requested_by: U2 })
    await output(q)
    await q.query('DELETE FROM asset_versions WHERE id = $1', [V2])
    expect(await q.one('SELECT result_version_id FROM worker_ops')).toEqual({ result_version_id: null })
    await q.query('DELETE FROM users WHERE id = $1', [U2])
    expect(await q.one('SELECT requested_by FROM worker_ops')).toEqual({ requested_by: null })
    await q.query('DELETE FROM asset_versions WHERE id = $1', [V1])
    expect(await count(q, 'worker_ops')).toBe(0)
    expect(await count(q, 'worker_op_outputs')).toBe(0)
    await op(q, { id: 'wop_operation0002', source_version_id: VX, workspace_id: W2, board_id: BX })
    await q.query('DELETE FROM boards WHERE id = $1', [BX])
    expect(await count(q, 'worker_ops')).toBe(0)
  })
})

describe('0039: op outputs', () => {
  it('an original names its new asset and version; a page its page and derivative id; keys are assets/…', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await op(q, { status: 'running', lease_owner: 'w', lease_until: '2099-01-01T00:00:00Z' })
    expect(await sqlstate(output(q))).toBe('no error')
    expect(await sqlstate(output(q, { id: 'wpo_output0000002', role: 'original', page: 3 }))).toBe('23514')
    const page = {
      id: 'wpo_output0000003',
      role: 'page',
      page: 9,
      asset_id: AST,
      version_id: V1,
      derivative_id: 'drv_derivative001',
      blob_key: `assets/${AST}/${V1}/d/drv_derivative001.webp`,
      mime_type: 'image/webp',
    }
    expect(await sqlstate(output(q, page))).toBe('no error')
    expect(await sqlstate(output(q, { ...page, id: 'wpo_output0000004', page: null }))).toBe('23514')
    expect(
      await sqlstate(output(q, { ...page, id: 'wpo_output0000005', derivative_id: null, blob_key: 'x' })),
    ).toBe('23514')
    expect(
      await sqlstate(output(q, { ...page, id: 'wpo_output0000006', page: 10000, blob_key: `${page.blob_key}x` })),
    ).toBe('23514')
    expect(await sqlstate(output(q, { id: 'wpo_output0000007', blob_key: '../etc/passwd' }))).toBe('23514')
    // a key is used once
    expect(await sqlstate(output(q, { ...page, id: 'wpo_output0000008', page: 10 }))).toBe('23505')
    expect(await sqlstate(output(q, { id: 'wpo_output0000009', mime_type: 'image/svg+xml' }))).toBe('23514')
  })
})

describe('0039: capabilities, derived versions, file text and board refs', () => {
  it('a capability is a versioned word; one row per capability', async () => {
    db = await openTestDb()
    const q = db
    const cap = (c: string) =>
      q.query('INSERT INTO worker_capabilities_seen (capability, last_seen_at, worker_id) VALUES ($1, now(), $2)', [
        c,
        'nas-1',
      ])
    expect(await sqlstate(cap('remove-bg:u2netp@1'))).toBe('no error')
    expect(await sqlstate(cap('extract-text@1'))).toBe('no error')
    expect(await sqlstate(cap('extract-text@1'))).toBe('23505')
    for (const bad of ['remove-bg', 'Remove-bg@1', 'x@0', 'a b@1']) expect(await sqlstate(cap(bad)), bad).toBe('23514')
  })

  it('derived_from_version_id names a version and is SET NULL when it goes', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    expect(
      await sqlstate(q.query('UPDATE asset_versions SET derived_from_version_id = $1 WHERE id = $2', ['ver_nope00000001', V2])),
    ).toBe('23503')
    await q.query('UPDATE asset_versions SET derived_from_version_id = $1 WHERE id = $2', [V1, V2])
    await q.query('DELETE FROM asset_versions WHERE id = $1', [V1])
    expect(await q.one('SELECT derived_from_version_id FROM asset_versions WHERE id = $1', [V2])).toEqual({
      derived_from_version_id: null,
    })
  })

  it('file text: pages 1..300 of at most 8,000 characters, a state per version; both cascade with it', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const page = (p: number, body: string, v = V1) =>
      q.query(
        `INSERT INTO file_text_pages (version_id, workspace_id, page, body, tsv)
         VALUES ($1, $2, $3, $4, to_tsvector('english', $4) || to_tsvector('simple', lower($4)))`,
        [v, W, p, body],
      )
    expect(await sqlstate(page(1, 'Quarterly brief'))).toBe('no error')
    expect(await sqlstate(page(1, 'again'))).toBe('23505')
    expect(await sqlstate(page(0, 'x'))).toBe('23514')
    expect(await sqlstate(page(301, 'x'))).toBe('23514')
    expect(await sqlstate(page(2, ''))).toBe('23514')
    expect(await sqlstate(page(3, '漢'.repeat(8001)))).toBe('23514')
    expect(await sqlstate(page(4, '漢'.repeat(8000)))).toBe('no error')
    const state = (over: Record<string, unknown> = {}) => {
      const row = { version_id: V1, workspace_id: W, status: 'done', pages: 2, bytes: 100, extractor: 'pdfjs-6.3.289', ...over }
      const cols = Object.keys(row)
      return q.query(
        `INSERT INTO file_text_state (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map((c) => (row as Record<string, unknown>)[c]),
      )
    }
    expect(await sqlstate(state({ status: 'ocr' }))).toBe('23514')
    expect(await sqlstate(state({ bytes: 524_289 }))).toBe('23514')
    expect(await sqlstate(state({ extractor: 'PDF.js 6' }))).toBe('23514')
    expect(await sqlstate(state())).toBe('no error')
    const hit = await q.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM file_text_pages WHERE tsv @@ to_tsquery('english', 'brief')`,
    )
    expect(hit.n).toBe(1)
    await q.query('DELETE FROM asset_versions WHERE id = $1', [V1])
    expect(await count(q, 'file_text_pages')).toBe(0)
    expect(await count(q, 'file_text_state')).toBe(0)
  })

  it('board_file_refs: a board of the workspace and a version; cascades with either', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const ref = (b: string, w: string, v: string) =>
      q.query('INSERT INTO board_file_refs (board_id, workspace_id, version_id) VALUES ($1, $2, $3)', [b, w, v])
    expect(await sqlstate(ref(B, W, V1))).toBe('no error')
    expect(await sqlstate(ref(B, W, V1))).toBe('23505')
    expect(await sqlstate(ref(B, W2, V2))).toBe('23503')
    expect(await sqlstate(ref(B, W, V2))).toBe('no error')
    await q.query('DELETE FROM asset_versions WHERE id = $1', [V1])
    expect(await count(q, 'board_file_refs')).toBe(1)
    await q.query('DELETE FROM boards WHERE id = $1', [B])
    expect(await count(q, 'board_file_refs')).toBe(0)
  })
})
