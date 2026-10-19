// 0037_client_review (the wave S foundation; docs/WAVE-S-CONTRACTS.md): review rounds, items and events, the version
// chain, the comment spot, the review-link landing, and the bell and chat kind 'review_status'. An upgrade from 0036
// changes nothing existing except the three widened CHECKs (notification kinds, the no-thread kinds, chat kinds); keys,
// CHECKs and cascades hold. Runs on PGlite, and on a real Postgres with DRAFTROOM_TEST_DATABASE_URL set.

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
const G = 'usr_guest00000001'
const W = 'wsp_studio0000001'
const B = 'b-alpha00001'
const B2 = 'b-beta000001'
const AST = 'ast_asst000000001'
const AST2 = 'ast_asst000000002'
const V1 = 'ver_vers000000001'
const V2 = 'ver_vers000000002'
const V3 = 'ver_vers000000003'
const VX = 'ver_other00000001'
const THR = 'thr_thread0000001'
const THR2 = 'thr_thread0000002'
const RVR = 'rvr_round00000001'
const RVI = 'rvi_item000000001'
const RVE = 'rve_event00000001'
const HOOK = 'chk_hook000000001'

async function seed(q: Db) {
  await q.query(`INSERT INTO users (id, name, handle, color) VALUES ($1, 'alice', 'alice', '#3355ff')`, [U])
  await q.query(
    `INSERT INTO users (id, name, handle, color, kind, guest_name) VALUES ($1, 'Ana (guest)', NULL, '#3355ff', 'guest', 'Ana')`,
    [G],
  )
  await q.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Studio', $2)`, [W, U])
  await q.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    W,
    U,
  ])
  for (const b of [B, B2])
    await q.query(`INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'B', $3)`, [
      b,
      W,
      U,
    ])
}

const version = (q: Db, id: string, asset = AST, supersedes: string | null = null, board = B) =>
  q.query(
    `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                 size_bytes, sha256, uploaded_by, supersedes)
     VALUES ($1, $2, $3, $4, 'cut.mov', 'video/quicktime', 'video/quicktime', 'video', 10, repeat('a', 64), $5, $6)`,
    [id, asset, W, board, U, supersedes],
  )

const thread = (
  q: Db,
  id: string,
  anchor: object,
  spot: [number | null, number | null] = [null, null],
  board = B,
) =>
  q.query(
    `INSERT INTO comment_threads (id, workspace_id, board_id, anchor, created_by, spot_u, spot_v)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [id, W, board, JSON.stringify(anchor), U, spot[0], spot[1]],
  )
const assetAnchor = (versionId = V1) => ({
  kind: 'asset',
  shapeId: 'shape:card-1',
  assetId: AST,
  versionId,
  timeMs: 12_400,
})

const NEW_TABLES = ['review_rounds', 'review_items', 'review_events']
const NEW_COLUMNS = [
  'asset_versions.supersedes:text:YES',
  'comment_threads.spot_u:double precision:YES',
  'comment_threads.spot_v:double precision:YES',
  'invitations.landing:text:NO',
  'notifications.review_event_id:text:YES',
]

describe('wave S migration', () => {
  it('is 0037_client_review, right after 0036 (contiguous)', () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 37)?.name).toBe('0037_client_review')
    // wave V's 0038 follows (wave-v-0038.test.ts)
    expect(all.find((m) => m.version === 38)?.name).toBe('0038_live_sessions')
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1))
  })

  it('upgrades a 0036 database additively: three new tables, five new columns, three CHECKs widened', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 36) })
    await seed(d)
    await d.query(
      `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                   size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, $3, $4, 'cut.mov', 'video/quicktime', 'video/quicktime', 'video', 10, repeat('a', 64), $5)`,
      [V1, AST, W, B, U],
    )
    await d.query(
      `INSERT INTO comment_threads (id, workspace_id, board_id, anchor, created_by) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [THR, W, B, JSON.stringify(assetAnchor()), U],
    )
    await d.query(
      `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, expires_at, multi_use)
       VALUES ('inv_link00000001', repeat('b', 64), $1, $2, 'commenter', $3, now() + interval '1 day', true)`,
      [W, B, U],
    )
    await d.query(
      `INSERT INTO notifications (workspace_id, user_id, kind, board_id, thread_id) VALUES ($1, $2, 'new_comment', $3, $4)`,
      [W, U, B, THR],
    )
    const before = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 37) })).applied).toEqual([
      '0037_client_review',
    ])
    const after = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    const isNew = (k: string) => NEW_TABLES.some((t) => k.startsWith(`${t}.`))
    expect(after.columns.filter((k) => !isNew(k) && !NEW_COLUMNS.includes(k))).toEqual(before.columns)
    for (const c of NEW_COLUMNS) expect(after.columns, c).toContain(c)
    const widened = [
      'notifications.notifications_kind_check',
      'notifications.notifications_check',
      'chat_hook_prefs.chat_hook_prefs_kinds_check',
    ]
    const isWidened = (k: string) => widened.some((w) => k.startsWith(`${w}:`))
    // every constraint that was there is still there, unchanged, but the three widened ones
    expect(before.constraints.filter((k) => !after.constraints.includes(k)).sort()).toEqual(
      before.constraints.filter(isWidened).sort(),
    )
    for (const w of widened) {
      const now = after.constraints.find((k) => k.startsWith(`${w}:`))
      expect(now, w).toContain("'review_status'")
    }
    // the existing rows are untouched, and the new tables empty
    expect(await d.one('SELECT supersedes FROM asset_versions WHERE id = $1', [V1])).toEqual({
      supersedes: null,
    })
    expect(await d.one('SELECT spot_u, spot_v FROM comment_threads WHERE id = $1', [THR])).toEqual({
      spot_u: null,
      spot_v: null,
    })
    expect(await d.one('SELECT landing FROM invitations')).toEqual({ landing: 'board' })
    expect(await d.one('SELECT review_event_id FROM notifications')).toEqual({ review_event_id: null })
    for (const t of NEW_TABLES) expect(await count(d, t), t).toBe(0)
  })
})

describe('0037: the version chain', () => {
  it('stays inside one asset, never names itself, is linear; a gone predecessor leaves the chain unlinked', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    expect(await sqlstate(version(q, V1))).toBe('no error')
    expect(await sqlstate(version(q, VX, AST2))).toBe('no error')
    // a version of another asset cannot be superseded into this chain
    expect(await sqlstate(version(q, V2, AST, VX))).toBe('23503')
    expect(await sqlstate(version(q, V2, AST, 'ver_missing000001'))).toBe('23503')
    expect(await sqlstate(version(q, 'ver_selfself00001', AST, 'ver_selfself00001'))).toBe('23514')
    // v2 supersedes v1 (and may be uploaded to another board of the workspace)
    expect(await sqlstate(version(q, V2, AST, V1, B2))).toBe('no error')
    // a second version superseding v1 too: refused (the chain is linear)
    expect(await sqlstate(version(q, V3, AST, V1))).toBe('23505')
    expect(await sqlstate(version(q, V3, AST, V2))).toBe('no error')
    // v1 goes (its board, or the collector): v2 stays, now the first of what is left
    await q.query('DELETE FROM asset_versions WHERE id = $1', [V1])
    expect(await q.one('SELECT supersedes FROM asset_versions WHERE id = $1', [V2])).toEqual({
      supersedes: null,
    })
    expect(await q.one('SELECT supersedes FROM asset_versions WHERE id = $1', [V3])).toEqual({
      supersedes: V2,
    })
  })
})

describe('0037: review rounds, items and events', () => {
  const round = (q: Db, over: Record<string, unknown> = {}) => {
    const r = { id: RVR, number: 1, title: 'Round 1', closed_at: null, ...over }
    return q.query(
      `INSERT INTO review_rounds (id, workspace_id, board_id, number, title, opened_by, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [r.id, W, B, r.number, r.title, U, r.closed_at],
    )
  }
  const reviewItem = (q: Db, over: Record<string, unknown> = {}) => {
    const r = {
      id: RVI,
      board_id: B,
      element_id: 'frame-1',
      kind: 'frame',
      asset_id: null,
      label: 'Key art',
      status: 'pending',
      status_version_id: null,
      round_id: null,
      removed_at: null,
      ...over,
    }
    return q.query(
      `INSERT INTO review_items (id, workspace_id, board_id, element_id, kind, asset_id, label, status,
                                 status_version_id, round_id, created_by, removed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        r.id,
        W,
        r.board_id,
        r.element_id,
        r.kind,
        r.asset_id,
        r.label,
        r.status,
        r.status_version_id,
        r.round_id,
        U,
        r.removed_at,
      ],
    )
  }
  const event = (q: Db, over: Record<string, unknown> = {}) => {
    const e = {
      id: RVE,
      item_id: RVI,
      round_id: null,
      kind: 'status',
      status: 'approved',
      previous_status: 'pending',
      reason: 'set',
      version_id: null,
      thread_id: null,
      actor_id: G,
      actor_name: 'Ana',
      actor_kind: 'guest',
      item_count: null,
      ...over,
    }
    return q.query(
      `INSERT INTO review_events (id, workspace_id, board_id, item_id, round_id, kind, status, previous_status, reason,
                                  version_id, thread_id, actor_id, actor_name, actor_kind, item_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        e.id,
        W,
        B,
        e.item_id,
        e.round_id,
        e.kind,
        e.status,
        e.previous_status,
        e.reason,
        e.version_id,
        e.thread_id,
        e.actor_id,
        e.actor_name,
        e.actor_kind,
        e.item_count,
      ],
    )
  }

  it('rounds: numbered once per board, at most one open, titles 1..80', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    expect(await sqlstate(round(q, { title: '' }))).toBe('23514')
    expect(await sqlstate(round(q, { number: 101 }))).toBe('23514')
    expect(await sqlstate(round(q, { id: 'rnd_wrongprefix1' }))).toBe('23514')
    expect(await sqlstate(round(q))).toBe('no error')
    // a second open round: refused; once the first is closed, round 2 opens
    expect(await sqlstate(round(q, { id: 'rvr_round00000002', number: 2 }))).toBe('23505')
    await q.query('UPDATE review_rounds SET closed_at = now() WHERE id = $1', [RVR])
    expect(await sqlstate(round(q, { id: 'rvr_round00000003', number: 1 }))).toBe('23505')
    expect(await sqlstate(round(q, { id: 'rvr_round00000002', number: 2 }))).toBe('no error')
  })

  it('items: a file names its asset, a frame none; one live item per element; a status version is of the asset', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await version(q, V1)
    await version(q, VX, AST2)
    const bad: Record<string, unknown>[] = [
      { kind: 'file' },
      { asset_id: AST },
      { kind: 'slide' },
      { status: 'rejected' },
      { label: '' },
      { label: 'x'.repeat(121) },
      { element_id: 'has space' },
      { status_version_id: V1 },
    ]
    for (const over of bad) expect(await sqlstate(reviewItem(q, over)), JSON.stringify(over)).toBe('23514')
    // a file item's status version must be a version of ITS asset
    const file = { kind: 'file', asset_id: AST, element_id: 'card-1' }
    expect(await sqlstate(reviewItem(q, { ...file, status_version_id: VX }))).toBe('23503')
    expect(await sqlstate(reviewItem(q, { ...file, status_version_id: V1 }))).toBe('no error')
    // re-pointing a file item (its card now shows another asset): the asset and the version change together
    const repoint = (asset: string, ver: string) =>
      q.query('UPDATE review_items SET asset_id = $2, status_version_id = $3 WHERE id = $1', [
        RVI,
        asset,
        ver,
      ])
    expect(await sqlstate(repoint(AST2, V1))).toBe('23503')
    expect(await sqlstate(repoint(AST2, VX))).toBe('no error')
    expect(await sqlstate(repoint(AST, V1))).toBe('no error')
    expect(await sqlstate(reviewItem(q, { id: 'rvi_item000000002' }))).toBe('no error')
    // the same element again while it is live: refused; removed, it can be marked again (a new live row)
    expect(await sqlstate(reviewItem(q, { id: 'rvi_item000000003' }))).toBe('23505')
    await q.query('UPDATE review_items SET removed_at = now() WHERE id = $1', ['rvi_item000000002'])
    expect(await sqlstate(reviewItem(q, { id: 'rvi_item000000003' }))).toBe('no error')
    // a round of another board is refused; the version goes: the status's version is null, the item stays
    await q.query(
      `INSERT INTO review_rounds (id, workspace_id, board_id, number, title) VALUES ($1, $2, $3, 1, 'Round 1')`,
      [RVR, W, B2],
    )
    expect(await sqlstate(reviewItem(q, { id: 'rvi_item000000004', element_id: 'f-4', round_id: RVR }))).toBe(
      '23503',
    )
    await q.query('DELETE FROM asset_versions WHERE id = $1', [V1])
    expect(await q.one('SELECT status_version_id FROM review_items WHERE id = $1', [RVI])).toEqual({
      status_version_id: null,
    })
    // the board goes: its items go
    await q.query('DELETE FROM boards WHERE id = $1', [B])
    expect(await count(q, 'review_items')).toBe(0)
  })

  it('events: the kind decides what a row holds; the note thread is of the same board; cascades', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await round(q)
    await reviewItem(q)
    await thread(q, THR, { kind: 'shape', shapeId: 'shape:frame-1', u: 1, v: 0 })
    await thread(q, THR2, { kind: 'shape', shapeId: 'shape:frame-1', u: 1, v: 0 }, [null, null], B2)
    const bad: Record<string, unknown>[] = [
      { status: null },
      { reason: null },
      { reason: 'because' },
      { kind: 'deleted' },
      { actor_kind: 'robot' },
      { actor_name: '' },
      { kind: 'added', status: null, reason: null },
      // a round event names no item, and always its round
      { kind: 'round_opened', round_id: RVR, status: null, previous_status: null, reason: null },
      { kind: 'round_closed', item_id: null, status: null, previous_status: null, reason: null },
      {
        kind: 'round_opened',
        status: null,
        previous_status: null,
        reason: null,
        round_id: RVR,
        item_count: 2,
      },
      { kind: 'added', status: null, previous_status: null, reason: null, item_count: 1 },
      { id: 'evt_wrongprefix1' },
    ]
    for (const over of bad) expect(await sqlstate(event(q, over)), JSON.stringify(over)).toBe('23514')
    // the note's thread must be on the same board
    expect(await sqlstate(event(q, { thread_id: THR2 }))).toBe('23503')
    expect(await sqlstate(event(q, { thread_id: THR }))).toBe('no error')
    const roundEvent = {
      id: 'rve_event00000002',
      item_id: null,
      round_id: RVR,
      kind: 'round_opened',
      status: null,
      previous_status: null,
      reason: null,
      actor_id: U,
      actor_name: 'alice',
      actor_kind: 'account',
      item_count: 3,
    }
    expect(await sqlstate(event(q, roundEvent))).toBe('no error')
    const added = {
      id: 'rve_event00000003',
      kind: 'added',
      status: null,
      previous_status: null,
      reason: null,
    }
    expect(await sqlstate(event(q, added))).toBe('no error')
    // the thread goes: the event stays without it; the guest's account goes: the event keeps the name it had
    await q.query('DELETE FROM comment_threads WHERE id = $1', [THR])
    expect(await q.one('SELECT thread_id FROM review_events WHERE id = $1', [RVE])).toEqual({
      thread_id: null,
    })
    await q.query('DELETE FROM users WHERE id = $1', [G])
    expect(
      await q.one('SELECT actor_id, actor_name, actor_kind FROM review_events WHERE id = $1', [RVE]),
    ).toEqual({
      actor_id: null,
      actor_name: 'Ana',
      actor_kind: 'guest',
    })
    // the item row goes (never by the api: it removes softly): its events go; the round's stays
    await q.query('DELETE FROM review_items WHERE id = $1', [RVI])
    expect((await q.query('SELECT id FROM review_events')).rows).toEqual([{ id: 'rve_event00000002' }])
  })

  it('the bell: review_status names its event of the same board, and goes with it; other kinds name none', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await reviewItem(q)
    await event(q)
    const ntf = (kind: string, ev: string | null, board = B) =>
      q.query(
        `INSERT INTO notifications (workspace_id, user_id, kind, board_id, review_event_id) VALUES ($1, $2, $3, $4, $5)`,
        [W, U, kind, board, ev],
      )
    expect(await sqlstate(ntf('review_status', null))).toBe('23514')
    expect(await sqlstate(ntf('access_request', RVE))).toBe('23514')
    expect(await sqlstate(ntf('review_status', RVE, B2))).toBe('23503')
    expect(await sqlstate(ntf('review_status', RVE))).toBe('no error')
    expect(await sqlstate(ntf('review_stats', null))).toBe('23514')
    // the bell's review caps read a recipient's rows on one board within a window (features/review/store.ts)
    expect(
      await q.one<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'notifications_review_window_idx'",
      ),
    ).toEqual({
      indexdef: expect.stringContaining(
        "notifications USING btree (board_id, user_id, created_at) WHERE (kind = 'review_status'::text)",
      ),
    })
    await q.query('DELETE FROM review_events WHERE id = $1', [RVE])
    expect(await count(q, 'notifications')).toBe(0)
  })
})

describe('0037: the comment spot, the landing and the chat kind', () => {
  it('a spot: both or neither, in [0, 1], asset anchors only', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const shape = { kind: 'shape', shapeId: 'shape:frame-1', u: 1, v: 0 }
    expect(await sqlstate(thread(q, 'thr_t00000000001', assetAnchor(), [0.25, null]))).toBe('23514')
    expect(await sqlstate(thread(q, 'thr_t00000000002', assetAnchor(), [1.5, 0.5]))).toBe('23514')
    expect(await sqlstate(thread(q, 'thr_t00000000003', shape, [0.5, 0.5]))).toBe('23514')
    expect(await sqlstate(thread(q, 'thr_t00000000004', assetAnchor(), [0.25, 0.75]))).toBe('no error')
    expect(
      await q.one('SELECT spot_u, spot_v FROM comment_threads WHERE id = $1', ['thr_t00000000004']),
    ).toEqual({
      spot_u: 0.25,
      spot_v: 0.75,
    })
  })

  it('landing: review only for a board’s multi-use link', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const inv = (id: string, multi: boolean, landing: string, board: string | null = B) =>
      q.query(
        `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, expires_at, multi_use, landing,
                                  invited_email)
         VALUES ($1, md5($1) || md5($1), $2, $3, $4, $5, now() + interval '1 day', $6, $7, $8)`,
        [id, W, board, board ? 'commenter' : 'member', U, multi, landing, multi ? null : 'ana@darkburn.com'],
      )
    expect(await sqlstate(inv('inv_link00000001', true, 'review'))).toBe('no error')
    expect(await sqlstate(inv('inv_link00000002', true, 'canvas'))).toBe('23514')
    expect(await sqlstate(inv('inv_link00000003', false, 'review'))).toBe('23514')
    expect(await sqlstate(inv('inv_link00000004', false, 'review', null))).toBe('23514')
    expect(await sqlstate(inv('inv_link00000005', false, 'board'))).toBe('no error')
  })

  it('chat preferences may opt into review_status', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await q.query(
      `INSERT INTO chat_hooks (id, workspace_id, name, provider, url_sealed, key_id, url_hint)
       VALUES ($1, $2, '#pitches', 'slack', $3, 'k1', 'hooks.slack.com/…')`,
      [HOOK, W, Buffer.alloc(60, 7)],
    )
    const pref = (kinds: string[]) =>
      q.query(
        `INSERT INTO chat_hook_prefs (user_id, workspace_id, hook_id, kinds) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, hook_id) DO UPDATE SET kinds = EXCLUDED.kinds`,
        [U, W, HOOK, kinds],
      )
    expect(await sqlstate(pref(['mention', 'review_status']))).toBe('no error')
    expect(await sqlstate(pref(['review_statuses']))).toBe('23514')
  })
})
