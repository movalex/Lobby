// 0035_board_imports and 0036_chat_hooks (the wave R foundation; docs/WAVE-R-CONTRACTS.md §2, §4): import jobs and the
// `importing` board status, and chat hooks with their preferences and outbox. An upgrade from 0034 changes nothing
// existing except the widened boards.status CHECK; keys, CHECKs and cascades hold. Runs on PGlite, and on a real
// Postgres with DRAFTROOM_TEST_DATABASE_URL set (src/testing.ts openTestDb).

import { afterEach, describe, expect, it } from 'vitest'
import { type Db, loadMigrations, migrate, openPglite, pgErrorCode } from '../src/index.ts'
import { openTestDb } from '../src/testing.ts'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

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

const sqlstate = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => pgErrorCode(e),
  )

const count = async (q: Db, table: string) =>
  (await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n

const U = 'usr_alice00000001'
const U2 = 'usr_bobby00000001'
const W = 'wsp_studio0000001'
const B = 'b-alpha00001'
const AST = 'ast_asst000000001'
const VER = 'ver_vers000000001'
const IMP = 'imp_job0000000001'
const IMB = 'imb_row0000000001'
const HOOK = 'chk_hook000000001'
const SEALED = Buffer.alloc(60, 7)

async function seed(q: Db) {
  await q.query(
    `INSERT INTO users (id, name, handle, color) VALUES ($1, 'alice', 'alice', '#3355ff'), ($2, 'bob', 'bob', '#3355ff')`,
    [U, U2],
  )
  await q.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Studio', $2)`, [W, U])
  await q.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [W, U, U2],
  )
}

const BOARD_SQL = `INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'B', $3)`

const NEW_TABLES = ['board_imports', 'board_import_files', 'chat_hooks', 'chat_hook_prefs', 'chat_deliveries']

describe('wave R migrations', () => {
  it('are 0035_board_imports and 0036_chat_hooks, right after 0034 (contiguous)', () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 35)?.name).toBe('0035_board_imports')
    expect(all.find((m) => m.version === 36)?.name).toBe('0036_chat_hooks')
    // wave S's 0037 follows (wave-s-0037.test.ts)
    expect(all.find((m) => m.version === 37)?.name).toBe('0037_client_review')
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1))
  })

  it('upgrade a 0034 database additively: five new tables, and only boards.status widened', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 34) })
    await seed(d)
    await d.query(BOARD_SQL, [B, W, U])
    const before = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 36) })).applied).toEqual([
      '0035_board_imports',
      '0036_chat_hooks',
    ])
    const after = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    const isNew = (k: string) => NEW_TABLES.some((t) => k.startsWith(`${t}.`))
    expect(after.columns.filter((k) => !isNew(k))).toEqual(before.columns)
    const status = (list: readonly string[]) => {
      const values = list.map((s) => `'${s}'::text`).join(', ')
      return `boards.boards_status_check:CHECK ((status = ANY (ARRAY[${values}])))`
    }
    const old = ['active', 'archived', 'trashed']
    expect(before.constraints).toContain(status(old))
    expect(after.constraints).toContain(status([...old, 'importing']))
    expect(after.constraints.filter((k) => !isNew(k) && k !== status([...old, 'importing']))).toEqual(
      before.constraints.filter((k) => k !== status(old)),
    )
    // the existing row is untouched, and the tables are empty
    expect(await d.one('SELECT status FROM boards WHERE id = $1', [B])).toEqual({ status: 'active' })
    for (const t of NEW_TABLES) expect(await count(d, t), t).toBe(0)
  })

  it('boards: importing is a status; nothing else new is, and the trashed rule holds', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const board = (id: string, status: string, trashed = false) =>
      q.query(
        `INSERT INTO boards (id, workspace_id, title, created_by, status, trashed_at)
         VALUES ($1, $2, 'B', $3, $4, $5)`,
        [id, W, U, status, trashed ? new Date() : null],
      )
    expect(await sqlstate(board('b-imp00000001', 'importing'))).toBe('no error')
    expect(await sqlstate(board('b-imp00000002', 'importing', true))).toBe('23514')
    expect(await sqlstate(board('b-imp00000003', 'deleted'))).toBe('23514')
  })
})

describe('0035_board_imports', () => {
  const row = (q: Db, over: Record<string, unknown> = {}) => {
    const r = {
      id: IMB,
      batch_id: IMP,
      workspace_id: W,
      created_by: U,
      source: 'miro',
      source_ref: 'uXjVOD1Ab2c=',
      title: 'Pitch wall',
      status: 'queued',
      board_id: null,
      error_code: null,
      report: null,
      finished_at: null,
      ...over,
    }
    return q.query(
      `INSERT INTO board_imports (id, batch_id, workspace_id, created_by, source, source_ref, title, status, board_id,
                                  error_code, report, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        r.id,
        r.batch_id,
        r.workspace_id,
        r.created_by,
        r.source,
        r.source_ref,
        r.title,
        r.status,
        r.board_id,
        r.error_code,
        // as JSON text, as the api writes it: node-postgres sends a JS array as a Postgres array literal ([] is '{}',
        // which jsonb reads as an empty OBJECT), so the array case below passed on real Postgres and failed on PGlite
        r.report == null ? null : JSON.stringify(r.report),
        r.finished_at,
      ],
    )
  }

  it('CHECKs: ids, sources, statuses, codes, the finished rules and the report cap', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const now = new Date()
    const bad: Record<string, unknown>[] = [
      { id: 'imp_wrongprefix01' },
      { batch_id: 'imb_wrongprefix01' },
      { source: 'trello' },
      { source_ref: 'has space' },
      { source_ref: `eyJ${'x'.repeat(200)}` },
      { status: 'paused-ish' },
      { error_code: 'miro said no' },
      { title: '' },
      // finished rows have their time, and a failed one its code, a done one its report
      { status: 'done', report: { total: 0 } },
      { status: 'failed', finished_at: now },
      { status: 'done', finished_at: now },
      { status: 'running', finished_at: now },
      { status: 'done', finished_at: now, report: { pad: 'x'.repeat(262_200) } },
      // the cap is the jsonb's text form (a space after each ':' and ','): compact JSON under it, Postgres's over
      {
        status: 'done',
        finished_at: now,
        report: { rows: Array.from({ length: 20_000 }, () => [1, 2, 3, 4, 5]) },
      },
      { report: [] },
      { report: 'text' },
    ]
    for (const over of bad)
      expect(await sqlstate(row(q, over)), JSON.stringify(over).slice(0, 80)).toBe('23514')
    const done = { status: 'done', finished_at: now, report: { total: 0 } }
    expect(await sqlstate(row(q, done))).toBe('no error')
    const another = { id: 'imb_row0000000002', batch_id: 'imp_job0000000002' }
    expect(await sqlstate(row(q, another))).toBe('no error')
    // (position defaults to 0: a second board of the same job needs its own)
    expect(
      await sqlstate(
        q.query(
          `INSERT INTO board_imports (id, batch_id, workspace_id, created_by, source, title, position)
           VALUES ('imb_row0000000003', $1, $2, $3, 'lobby-backup', 'Copy', 0)`,
          [IMP, W, U],
        ),
      ),
    ).toBe('23505')
  })

  it('the board: SET NULL when it goes, one import per board; files go with their versions', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await q.query(
      `INSERT INTO boards (id, workspace_id, title, created_by, status) VALUES ($1, $2, 'Pitch wall', $3, 'importing')`,
      [B, W, U],
    )
    expect(await sqlstate(row(q, { board_id: 'b-missing0001' }))).toBe('23503')
    expect(await sqlstate(row(q, { status: 'running', board_id: B }))).toBe('no error')
    expect(await sqlstate(row(q, { id: 'imb_row0000000002', board_id: B, status: 'running' }))).toBe('23505')
    await q.query(
      `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                   size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, $3, $4, 'a.png', 'image/png', 'image/png', 'image', 10, repeat('a', 64), $5)`,
      [VER, AST, W, B, U],
    )
    const file = (key: string, ver: string | null, status: string, note: string | null = null) =>
      q.query(
        'INSERT INTO board_import_files (import_id, source_key, version_id, status, note) VALUES ($1, $2, $3, $4, $5)',
        [IMB, key, ver, status, note],
      )
    expect(await sqlstate(file('3458764517517819000', VER, 'stored'))).toBe('no error')
    expect(await sqlstate(file('3458764517517819000', VER, 'stored'))).toBe('23505')
    expect(await sqlstate(file('3458764517517819001', null, 'failed', 'file-host-refused'))).toBe('no error')
    expect(await sqlstate(file('3458764517517819002', VER, 'failed'))).toBe('23514')
    expect(await sqlstate(file('3458764517517819003', null, 'stored'))).toBe('23514')
    expect(await sqlstate(file('https://r.miro.com/x', null, 'failed'))).toBe('23514')
    expect(await sqlstate(file('3458764517517819004', null, 'failed', 'Has a URL: https://x'))).toBe('23514')
    // the board goes (a failed import's cleanup): its versions cascade, their file rows too, the job row stays
    await q.query('DELETE FROM boards WHERE id = $1', [B])
    expect(await q.one('SELECT board_id FROM board_imports WHERE id = $1', [IMB])).toEqual({ board_id: null })
    expect(await count(q, 'board_import_files')).toBe(1)
    // the job row goes with its workspace, and its file rows with it
    await q.query('DELETE FROM workspaces WHERE id = $1', [W])
    expect(await count(q, 'board_imports')).toBe(0)
    expect(await count(q, 'board_import_files')).toBe(0)
  })
})

describe('0036_chat_hooks', () => {
  const hook = (q: Db, over: Record<string, unknown> = {}) => {
    const h = {
      id: HOOK,
      workspace_id: W,
      name: '#lobby-pitches',
      provider: 'slack',
      url_sealed: SEALED,
      key_id: 'k1',
      url_hint: 'hooks.slack.com/…/•••WXYZ',
      created_by: U,
      disabled_at: null,
      disabled_reason: null,
      ...over,
    }
    return q.query(
      `INSERT INTO chat_hooks (id, workspace_id, name, provider, url_sealed, key_id, url_hint, created_by, disabled_at,
                               disabled_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        h.id,
        h.workspace_id,
        h.name,
        h.provider,
        h.url_sealed,
        h.key_id,
        h.url_hint,
        h.created_by,
        h.disabled_at,
        h.disabled_reason,
      ],
    )
  }

  it('hooks: CHECKs on the sealed URL, key id, provider and the disabled pair', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const bad: Record<string, unknown>[] = [
      { id: 'hok_wrongprefix01' },
      { provider: 'discord' },
      { url_sealed: Buffer.alloc(28) },
      { url_sealed: Buffer.alloc(3000) },
      { key_id: 'key-1' },
      { name: '' },
      { disabled_at: new Date() },
      { disabled_reason: 'not-found' },
      { disabled_at: new Date(), disabled_reason: 'channel_not_found' },
    ]
    for (const over of bad)
      expect(await sqlstate(hook(q, over)), JSON.stringify(Object.keys(over))).toBe('23514')
    const disabled = { disabled_at: new Date(), disabled_reason: 'not-found' }
    expect(await sqlstate(hook(q, disabled))).toBe('no error')
    // the creator's account goes: the hook stays, the workspace's
    await q.query('DELETE FROM workspace_members WHERE user_id = $1', [U])
    await q.query('UPDATE workspaces SET created_by = $1', [U2])
    await q.query('DELETE FROM users WHERE id = $1', [U])
    const kept = await q.one('SELECT created_by FROM chat_hooks WHERE id = $1', [HOOK])
    expect(kept).toEqual({ created_by: null })
  })

  it('prefs: kinds from the opt-in list only; they go with the membership and with the hook', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await hook(q)
    const pref = (user: string, kinds: string[]) =>
      q.query('INSERT INTO chat_hook_prefs (user_id, workspace_id, hook_id, kinds) VALUES ($1, $2, $3, $4)', [
        user,
        W,
        HOOK,
        kinds,
      ])
    expect(await sqlstate(pref(U2, ['mention', 'resolved']))).toBe('23514')
    expect(await sqlstate(pref(U2, ['access_granted']))).toBe('23514')
    expect(await sqlstate(pref(U2, ['mention', 'reply']))).toBe('no error')
    expect(await sqlstate(pref(U, []))).toBe('no error')
    expect(await sqlstate(pref(U2, ['mention']))).toBe('23505')
    // not a member of the workspace: refused
    const carol = `INSERT INTO users (id, name, handle, color) VALUES ('usr_carol00000001', 'c', 'c', '#3355ff')`
    await q.query(carol)
    expect(await sqlstate(pref('usr_carol00000001', ['mention']))).toBe('23503')
    // a member removal deletes their prefs; the hook's deletion deletes the rest
    await q.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [W, U2])
    expect(await count(q, 'chat_hook_prefs')).toBe(1)
    await q.query('DELETE FROM chat_hooks WHERE id = $1', [HOOK])
    expect(await count(q, 'chat_hook_prefs')).toBe(0)
  })

  it('deliveries: one per hook and notification, statuses, leases; gone with the notification', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await hook(q)
    await q.query(BOARD_SQL, [B, W, U])
    const ntf = (
      await q.one<{ id: string }>(
        `INSERT INTO notifications (workspace_id, user_id, kind, board_id) VALUES ($1, $2, 'access_request', $3)
         RETURNING id`,
        [W, U2, B],
      )
    ).id
    const delivery = (over: Record<string, unknown> = {}) => {
      const d = {
        notification_id: ntf,
        status: 'queued',
        lease_until: null,
        sent_at: null,
        last_code: null,
        ...over,
      }
      return q.query(
        `INSERT INTO chat_deliveries (hook_id, notification_id, recipient_id, status, lease_until, sent_at, last_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [HOOK, d.notification_id, U2, d.status, d.lease_until, d.sent_at, d.last_code],
      )
    }
    expect(await sqlstate(delivery({ status: 'delivered' }))).toBe('23514')
    expect(await sqlstate(delivery({ status: 'sending' }))).toBe('23514')
    expect(await sqlstate(delivery({ status: 'sent' }))).toBe('23514')
    const words = { last_code: 'channel_not_found: the channel was archived' }
    expect(await sqlstate(delivery(words))).toBe('23514')
    expect(await sqlstate(delivery())).toBe('no error')
    expect(await sqlstate(delivery())).toBe('23505')
    // a test message or a digest has no notification (NULL is never a duplicate)
    const test = { notification_id: null, status: 'sent', sent_at: new Date() }
    expect(await sqlstate(delivery(test))).toBe('no error')
    expect(await sqlstate(delivery({ notification_id: null, status: 'coalesced' }))).toBe('no error')
    // one row per hook per event of a many-recipient kind (event_key): a second notification of the event is refused
    const second = (
      await q.one<{ id: string }>(
        `INSERT INTO notifications (workspace_id, user_id, kind, board_id) VALUES ($1, $2, 'access_request', $3)
         RETURNING id`,
        [W, U, B],
      )
    ).id
    const keyed = (id: string, key: string) =>
      q.query(
        'INSERT INTO chat_deliveries (hook_id, notification_id, recipient_id, event_key) VALUES ($1, $2, $3, $4)',
        [HOOK, id, U, key],
      )
    const key = `access_request:${B}:-:${U2}:20261016120000000000`
    expect(await sqlstate(keyed(second, 'access request with spaces'))).toBe('23514')
    expect(await sqlstate(keyed(second, `x:${'a'.repeat(251)}`))).toBe('23514')
    await q.query('UPDATE chat_deliveries SET event_key = $1 WHERE notification_id = $2', [key, ntf])
    expect(await sqlstate(keyed(second, key))).toBe('23505')
    expect(await sqlstate(keyed(second, `${key}1`))).toBe('no error')
    await q.query('DELETE FROM chat_deliveries WHERE notification_id = $1', [second])
    await q.query('DELETE FROM notifications WHERE id = $1', [ntf])
    expect(await count(q, 'chat_deliveries')).toBe(2)
    await q.query('DELETE FROM chat_hooks WHERE id = $1', [HOOK])
    expect(await count(q, 'chat_deliveries')).toBe(0)
  })
})
