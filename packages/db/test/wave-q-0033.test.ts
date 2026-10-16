// 0033_library (owner WS2), landed by the wave Q foundation: four new tables, nothing existing changed (an upgrade from
// 0032 keeps every column and constraint), their keys, CHECKs, cascades and indexes. Runs on PGlite, and on a real
// Postgres with DRAFTROOM_TEST_DATABASE_URL set (src/testing.ts openTestDb).

import { afterEach, describe, expect, it } from 'vitest'
import { type Db, loadMigrations, migrate, openPglite, pgErrorCode } from '../src/index.ts'
import { openTestDb } from '../src/testing.ts'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

async function sqlstate(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => 'no error',
    (e: unknown) => pgErrorCode(e),
  )
}

const columnsOf = async (q: Db, table?: string) =>
  (
    await q.query<{ k: string }>(
      `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS k
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND ($1::text IS NULL OR table_name = $1)
        ORDER BY 1`,
      [table ?? null],
    )
  ).rows.map((r) => r.k)

const constraintsOf = async (q: Db) =>
  (
    await q.query<{ k: string }>(
      `SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) AS k
         FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY 1`,
    )
  ).rows.map((r) => r.k)

const U = { alice: 'usr_alice00000001', bob: 'usr_bobby00000001' }
const W = { studio: 'wsp_studio0000001', other: 'wsp_others0000001' }
const B = { a: 'b-alpha00001', o: 'b-other00001' }
const ITEM = { one: 'lbi_item000000001', two: 'lbi_item000000002', mine: 'lbi_item000000003' }
const FOLDER = { team: 'lbf_fold000000001', mine: 'lbf_fold000000002', other: 'lbf_fold000000003' }
const VER = { a: 'ver_vers000000001', o: 'ver_vers000000002' }
const AST = { a: 'ast_asst000000001', o: 'ast_asst000000002' }

const NEW_TABLES = ['library_folders', 'library_items', 'library_item_files', 'library_marks']
const isNew = (k: string) => NEW_TABLES.some((t) => k.startsWith(`${t}.`))

async function seed(q: Db) {
  for (const [id, name] of [
    [U.alice, 'alice'],
    [U.bob, 'bob'],
  ] as const)
    await q.query(`INSERT INTO users (id, name, handle, color) VALUES ($1, $2, $2, '#3355ff')`, [id, name])
  for (const id of Object.values(W))
    await q.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Studio', $2)`, [id, U.alice])
  for (const [id, ws] of [
    [B.a, W.studio],
    [B.o, W.other],
  ] as const)
    await q.query(`INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'Board', $3)`, [
      id,
      ws,
      U.alice,
    ])
  for (const [ver, ast, ws, board] of [
    [VER.a, AST.a, W.studio, B.a],
    [VER.o, AST.o, W.other, B.o],
  ] as const)
    await q.query(
      `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                   size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, $3, $4, 'a.png', 'image/png', 'image/png', 'image', 10, repeat('a', 64), $5)`,
      [ver, ast, ws, board, U.alice],
    )
}

const folder = (q: Db, id: string, ws: string, owner: string | null, name: string) =>
  q.query(
    `INSERT INTO library_folders (id, workspace_id, owner_id, name, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [id, ws, owner, name, owner ?? U.alice],
  )

interface ItemRow {
  id: string
  ws?: string
  owner?: string | null
  folder?: string | null
  name?: string
  tags?: string[]
  elements?: unknown
  count?: number
  bytes?: number
  source?: unknown
}
const item = (q: Db, r: ItemRow) =>
  q.query(
    `INSERT INTO library_items (id, workspace_id, owner_id, folder_id, name, tags, elements, element_count, bytes,
                                width, height, source, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 100, 50, $10::jsonb, $11, $11)`,
    [
      r.id,
      r.ws ?? W.studio,
      r.owner ?? null,
      r.folder ?? null,
      r.name ?? 'Flow',
      r.tags ?? [],
      JSON.stringify(r.elements ?? [{ id: 'a', type: 'rectangle' }]),
      r.count ?? 1,
      r.bytes ?? 40,
      JSON.stringify(r.source ?? { kind: 'board', boardId: B.a }),
      r.owner ?? U.alice,
    ],
  )
const count = async (q: Db, table: string) =>
  (await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n

describe('wave Q migration', () => {
  it('is 0033_library, right after wave N’s 0032 (contiguous)', () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 33)?.name).toBe('0033_library')
    // the review fixes' 0034 follows (wave-q-0034.test.ts), then wave R's 0035 and 0036 (wave-r-0035-0036.test.ts)
    expect(all.filter((m) => m.version > 33).map((m) => m.name)).toEqual([
      '0034_library_place',
      '0035_board_imports',
      '0036_chat_hooks',
      '0037_client_review',
    ])
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1))
  })

  it('upgrades a 0032 database additively: every existing column and constraint unchanged, four new tables', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 32) })
    const before = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 33) })).applied).toEqual([
      '0033_library',
    ])
    const after = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    expect(after.columns.filter((k) => !isNew(k))).toEqual(before.columns)
    expect(after.constraints.filter((k) => !isNew(k))).toEqual(before.constraints)
    expect(await columnsOf(d, 'library_folders')).toEqual([
      'library_folders.created_at:timestamp with time zone:NO',
      'library_folders.created_by:text:YES',
      'library_folders.id:text:NO',
      'library_folders.name:text:NO',
      'library_folders.owner_id:text:YES',
      'library_folders.position:integer:NO',
      'library_folders.workspace_id:text:NO',
    ])
    expect(await columnsOf(d, 'library_items')).toEqual([
      'library_items.bytes:integer:NO',
      'library_items.created_at:timestamp with time zone:NO',
      'library_items.created_by:text:YES',
      'library_items.deleted_at:timestamp with time zone:YES',
      'library_items.element_count:integer:NO',
      'library_items.elements:jsonb:NO',
      'library_items.folder_id:text:YES',
      'library_items.height:real:NO',
      'library_items.id:text:NO',
      'library_items.image_count:integer:NO',
      'library_items.internal_only:boolean:NO',
      'library_items.name:text:NO',
      'library_items.owner_id:text:YES',
      'library_items.revision:integer:NO',
      'library_items.source:jsonb:NO',
      'library_items.tags:ARRAY:NO',
      'library_items.updated_at:timestamp with time zone:NO',
      'library_items.updated_by:text:YES',
      'library_items.width:real:NO',
      'library_items.workspace_id:text:NO',
    ])
    expect(await columnsOf(d, 'library_item_files')).toEqual([
      'library_item_files.asset_id:text:NO',
      'library_item_files.item_id:text:NO',
      'library_item_files.version_id:text:NO',
      'library_item_files.workspace_id:text:NO',
    ])
    expect(await columnsOf(d, 'library_marks')).toEqual([
      'library_marks.favourite:boolean:NO',
      'library_marks.key:text:NO',
      'library_marks.used_at:timestamp with time zone:YES',
      'library_marks.user_id:text:NO',
      'library_marks.workspace_id:text:NO',
    ])
  })

  it('has the indexes the panel lists, searches and the GC reads by', async () => {
    db = await openTestDb()
    const rows = await db.query<{ name: string; def: string }>(
      `SELECT indexname AS name, indexdef AS def FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = ANY($1::text[]) ORDER BY 1`,
      [NEW_TABLES],
    )
    const defs = Object.fromEntries(rows.rows.map((r) => [r.name, r.def]))
    expect(defs.library_items_list_idx).toMatch(
      /\(workspace_id, owner_id, folder_id, updated_at DESC, id\) WHERE \(deleted_at IS NULL\)/,
    )
    expect(defs.library_items_deleted_idx).toMatch(/WHERE \(deleted_at IS NOT NULL\)/)
    expect(defs.library_items_tags_idx).toMatch(/USING gin \(tags\)/)
    expect(defs.library_item_files_ver_idx).toMatch(/\(workspace_id, version_id\)/)
    expect(defs.library_marks_recent_idx).toMatch(/\(user_id, workspace_id, used_at DESC\)/)
    expect(defs.library_folders_name_idx).toMatch(
      /UNIQUE INDEX .*COALESCE\(owner_id, ''::text\), lower\(name\)/,
    )
  })
})

describe('0033_library: folders and items', () => {
  it('folder names are unique per scope whatever their case; the same name in another scope is fine', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    expect(await sqlstate(folder(d, FOLDER.team, W.studio, null, 'Flows'))).toBe('no error')
    expect(await sqlstate(folder(d, 'lbf_fold000000009', W.studio, null, 'flows'))).toBe('23505')
    expect(await sqlstate(folder(d, FOLDER.mine, W.studio, U.bob, 'Flows'))).toBe('no error')
    expect(await sqlstate(folder(d, FOLDER.other, W.other, null, 'Flows'))).toBe('no error')
    for (const [id, name] of [
      ['lbf_short', 'Ok'],
      ['lbf_fold000000010', ''],
      ['lbf_fold000000011', 'x'.repeat(61)],
    ])
      expect(await sqlstate(folder(d, id as string, W.studio, U.alice, name as string)), id).toBe('23514')
  })

  it('an item: its CHECKs (id, name, tags, counts, bytes, JSON shapes, source kind)', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    expect(await sqlstate(item(d, { id: ITEM.one }))).toBe('no error')
    const bad: [string, ItemRow][] = [
      ['id', { id: 'lbi_x' }],
      ['empty name', { id: ITEM.two, name: '' }],
      ['long name', { id: ITEM.two, name: 'x'.repeat(81) }],
      ['tags', { id: ITEM.two, tags: Array(11).fill('t') }],
      ['no elements', { id: ITEM.two, count: 0 }],
      ['too many', { id: ITEM.two, count: 501 }],
      ['too big', { id: ITEM.two, bytes: 262_145 }],
      ['elements object', { id: ITEM.two, elements: { a: 1 } }],
      ['source kind', { id: ITEM.two, source: { kind: 'url', url: 'https://example.com' } }],
      ['source array', { id: ITEM.two, source: ['board'] }],
    ]
    for (const [what, row] of bad) expect(await sqlstate(item(d, row)), what).toBe('23514')
    const row = await d.one<{
      revision: number
      internal_only: boolean
      image_count: number
      deleted_at: null
    }>('SELECT revision, internal_only, image_count, deleted_at FROM library_items WHERE id = $1', [ITEM.one])
    expect(row).toEqual({ revision: 1, internal_only: false, image_count: 0, deleted_at: null })
  })

  it('a folder of another workspace is refused; deleting a folder leaves its items, folderless', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    await folder(d, FOLDER.team, W.studio, null, 'Flows')
    await folder(d, FOLDER.other, W.other, null, 'Flows')
    expect(await sqlstate(item(d, { id: ITEM.one, folder: FOLDER.team }))).toBe('no error')
    expect(await sqlstate(item(d, { id: ITEM.two, folder: FOLDER.other }))).toBe('23503')
    await d.query('DELETE FROM library_folders WHERE id = $1', [FOLDER.team])
    const left = await d.one<{ folder_id: string | null; workspace_id: string }>(
      'SELECT folder_id, workspace_id FROM library_items WHERE id = $1',
      [ITEM.one],
    )
    expect(left).toEqual({ folder_id: null, workspace_id: W.studio })
  })

  it('a personal library goes with its person; a workspace library with its workspace; an author leaves the item', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    await folder(d, FOLDER.mine, W.studio, U.bob, 'Mine')
    await item(d, { id: ITEM.one })
    await item(d, { id: ITEM.mine, owner: U.bob, folder: FOLDER.mine })
    await item(d, { id: ITEM.two, ws: W.other })
    // bob created nothing in the workspace scope here; alice authored ITEM.one
    await d.query('DELETE FROM users WHERE id = $1', [U.bob])
    expect(await count(d, 'library_folders')).toBe(0)
    expect((await d.query('SELECT id FROM library_items ORDER BY id')).rows).toEqual([
      { id: ITEM.one },
      { id: ITEM.two },
    ])
    await d.query('DELETE FROM workspaces WHERE id = $1', [W.other])
    expect(await count(d, 'library_items')).toBe(1)
    const fks = await d.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'library_items'::regclass AND contype = 'f' ORDER BY 1`,
    )
    expect(fks.rows.map((r) => r.def)).toEqual([
      'FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL',
      'FOREIGN KEY (folder_id, workspace_id) REFERENCES library_folders(id, workspace_id) ON DELETE SET NULL (folder_id)',
      'FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE',
      'FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL',
      'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    ])
  })
})

describe('0033_library: item files and marks', () => {
  const file = (q: Db, itemId: string, ws: string, ast: string, ver: string) =>
    q.query(
      `INSERT INTO library_item_files (item_id, workspace_id, asset_id, version_id) VALUES ($1, $2, $3, $4)`,
      [itemId, ws, ast, ver],
    )

  it('a file row names a real version, under the item’s own workspace, once per item', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    await item(d, { id: ITEM.one })
    expect(await sqlstate(file(d, ITEM.one, W.studio, AST.a, VER.a))).toBe('no error')
    expect(await sqlstate(file(d, ITEM.one, W.studio, AST.a, VER.a))).toBe('23505')
    // the item is not in that workspace
    expect(await sqlstate(file(d, ITEM.one, W.other, AST.o, VER.o))).toBe('23503')
    // a version that does not exist, or whose asset is another
    expect(await sqlstate(file(d, ITEM.one, W.studio, AST.a, 'ver_nothing000001'))).toBe('23503')
    await item(d, { id: ITEM.two })
    expect(await sqlstate(file(d, ITEM.two, W.studio, AST.o, VER.a))).toBe('23503')
    expect(await sqlstate(file(d, ITEM.one, W.studio, AST.a, 'data:image/png'))).toBe('23514')
  })

  it('goes with its item and with its version; a soft-deleted item keeps its files (the GC root)', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    await item(d, { id: ITEM.one })
    await item(d, { id: ITEM.two })
    await file(d, ITEM.one, W.studio, AST.a, VER.a)
    await file(d, ITEM.two, W.studio, AST.a, VER.a)
    await d.query('UPDATE library_items SET deleted_at = now() WHERE id = $1', [ITEM.two])
    expect(await count(d, 'library_item_files')).toBe(2)
    await d.query('DELETE FROM library_items WHERE id = $1', [ITEM.one])
    expect(await count(d, 'library_item_files')).toBe(1)
    await d.query('DELETE FROM asset_versions WHERE id = $1', [VER.a])
    expect(await count(d, 'library_item_files')).toBe(0)
  })

  it('marks: one row per (person, workspace, key), keys of the three grammars only', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    const mark = (key: string, user = U.alice) =>
      d.query(
        `INSERT INTO library_marks (user_id, workspace_id, key, favourite, used_at) VALUES ($1, $2, $3, true, now())`,
        [user, W.studio, key],
      )
    for (const key of [
      'icon:lucide:arrow-right@1.49.0',
      'icon:tabler:a-b-2@3.48.0',
      'piece:decision',
      `item:${ITEM.one}`,
    ])
      expect(await sqlstate(mark(key)), key).toBe('no error')
    expect(await sqlstate(mark('piece:decision'))).toBe('23505')
    expect(await sqlstate(mark('piece:decision', U.bob))).toBe('no error')
    for (const key of [
      'icon:lucide:arrow-right',
      'icon:feather:x@1.0.0',
      'icon:lucide:Arrow@1.0.0',
      'piece:Decision',
      'item:lbi_x',
      'board:b-alpha00001',
      'pi',
    ])
      expect(await sqlstate(mark(key)), key).toBe('23514')
    await d.query('DELETE FROM users WHERE id = $1', [U.bob])
    expect(await count(d, 'library_marks')).toBe(4)
    await d.query('DELETE FROM workspaces WHERE id = $1', [W.studio])
    expect(await count(d, 'library_marks')).toBe(0)
  })
})
