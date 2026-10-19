// Every migration after the M1/M2/M3 schema (0009 onwards) on a real Postgres that already holds
// M1/M2/M3 data (the wave-3 postgres-integrity review's probe), and rolling an older build back onto
// the upgraded database (DRAFTROOM_ALLOW_NEWER_SCHEMA, docs/DEPLOY.md "Rollback"). Set
// DRAFTROOM_TEST_DATABASE_URL (a database these tests may create and drop a schema in); skipped otherwise.

import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Db, loadMigrations, migrate, openDb, pgErrorCode } from '@draftroom/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiServer } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { reviewLinkToken } from '../src/features/dashboard/review-links.ts'
import { sweepGuests } from '../src/features/guests/sweep.ts'
import { createRecordingNotifier } from '../src/notifier.ts'
import { ORIGIN, TICKET_SECRET, testEnv } from './helpers.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''

interface Scoped {
  db: Db
  schema: string
  drop(): Promise<void>
}

async function adminExec(sql: string): Promise<void> {
  const admin = await openDb({ kind: 'pg', connectionString: PG_URL, maxConnections: 1 })
  try {
    await admin.exec(sql)
  } finally {
    await admin.close()
  }
}

/** A new, empty schema (not migrated: the test decides how far). */
async function openSchema(prefix: string): Promise<Scoped> {
  const schema = `${prefix}_${process.pid}_${randomBytes(4).toString('hex')}`
  await adminExec(`CREATE SCHEMA ${schema}`)
  const u = new URL(PG_URL)
  u.searchParams.set('options', `-c search_path=${schema}`)
  const db = await openDb({ kind: 'pg', connectionString: u.toString(), maxConnections: 10 })
  return {
    db,
    schema,
    async drop() {
      await db.close()
      await adminExec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    },
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const H = 3600_000
const D = 24 * H

const U = {
  alice: 'usr_alice00000001',
  bob: 'usr_bob000000001',
  carol: 'usr_carol00000001', // M1 account that is a workspace GUEST (workspace invitation role guest)
  dave: 'usr_dave000000001', // clerk identity, raised by a workshop link
  erin: 'usr_erin000000001', // outsider who joined through a review link (workspace guest)
}
const W = { studio: 'wsp_studio0000001', other: 'wsp_other00000001' }
const B = { main: 'b-main00001', view: 'b-view00001', trash: 'b-trash0001', other: 'b-other0001' }
const INV = {
  single: 'inv_single0000001',
  wsGuest: 'inv_wsguest000001',
  board: 'inv_board00000001',
  review: 'inv_review0000001',
  workshop: 'inv_workshop00001',
  revoked: 'inv_revoked000001',
  expired: 'inv_expired000001',
}

async function ins(db: Db, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row)
  const vals = cols.map((c) => {
    const v = row[c]
    return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v
  })
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  )
}

async function seedOldData(db: Db, now: Date) {
  const t = (ms: number) => new Date(now.getTime() + ms)
  for (const [k, id] of Object.entries(U))
    await ins(db, 'users', { id, name: k[0]?.toUpperCase() + k.slice(1), handle: k, color: '#3355ff' })
  for (const k of ['alice', 'bob', 'carol', 'erin'] as const)
    await ins(db, 'identities', { provider: 'dev', subject: k, user_id: U[k] })
  await ins(db, 'identities', { provider: 'clerk', subject: 'user_dave123', user_id: U.dave })
  await ins(db, 'sessions', {
    id_hash: sha('s-alice'),
    user_id: U.alice,
    expires_at: t(D),
    clerk_session_id: 'sess_abc123',
  })
  await ins(db, 'sessions', { id_hash: sha('s-bob'), user_id: U.bob, expires_at: t(D), revoked_at: now })
  await ins(db, 'sessions', {
    id_hash: sha('s-carol'),
    user_id: U.carol,
    created_at: t(-10 * D),
    expires_at: t(-3 * D),
  })
  await ins(db, 'sessions', { id_hash: sha('s-erin'), user_id: U.erin, expires_at: t(D) })
  // The dev sign-in's shared workspace (fixed id), created by carol before anything else: migration
  // 0021's backfill must not mark it as anyone's personal workspace.
  await ins(db, 'workspaces', {
    id: 'wsp_DevStudio00000000000',
    name: 'Dev Studio',
    created_by: U.carol,
    created_at: t(-30 * D),
  })
  await ins(db, 'workspaces', { id: W.studio, name: 'Studio', created_by: U.alice })
  await ins(db, 'workspaces', { id: W.other, name: 'Other', created_by: U.bob })
  for (const [u, role] of [
    [U.alice, 'owner'],
    [U.bob, 'member'],
    [U.carol, 'guest'],
    [U.dave, 'admin'],
    [U.erin, 'guest'],
  ])
    await ins(db, 'workspace_members', { workspace_id: W.studio, user_id: u, role })
  await ins(db, 'workspace_members', { workspace_id: W.other, user_id: U.bob, role: 'owner' })
  await ins(db, 'projects', { id: 'prj_proj000000001', workspace_id: W.studio, name: 'Campaign' })
  await ins(db, 'projects', {
    id: 'prj_arch000000001',
    workspace_id: W.studio,
    name: 'Old',
    archived_at: now,
  })
  await ins(db, 'boards', {
    id: B.main,
    workspace_id: W.studio,
    project_id: 'prj_proj000000001',
    title: 'Main',
    created_by: U.alice,
    last_opened_at: now,
  })
  await ins(db, 'boards', {
    id: B.view,
    workspace_id: W.studio,
    title: 'View',
    visibility: 'workspace_view',
    created_by: U.bob,
  })
  await ins(db, 'boards', {
    id: B.trash,
    workspace_id: W.studio,
    title: 'Trash',
    status: 'trashed',
    trashed_at: now,
    created_by: U.alice,
  })
  await ins(db, 'boards', { id: B.other, workspace_id: W.other, title: 'Other', created_by: U.bob })
  for (const [u, role] of [
    [U.alice, 'owner'],
    [U.bob, 'editor'],
    [U.carol, 'viewer'],
    [U.dave, 'commenter'],
  ])
    await ins(db, 'board_members', { board_id: B.main, user_id: u, role, added_by: U.alice })
  await ins(db, 'board_members', { board_id: B.other, user_id: U.bob, role: 'owner' })

  // invitations: single-use workspace (pending, redeemed as guest), single-use board, review link
  // (redeemed through the 0005 trigger), workshop link (raises dave), revoked, expired + swept
  await ins(db, 'invitations', {
    id: INV.single,
    token_hash: sha('tok-single'),
    workspace_id: W.studio,
    role: 'member',
    created_by: U.alice,
    expires_at: t(7 * D),
  })
  await ins(db, 'invitations', {
    id: INV.wsGuest,
    token_hash: sha('tok-wsguest'),
    workspace_id: W.studio,
    role: 'guest',
    created_by: U.alice,
    expires_at: t(7 * D),
    redeemed_by: U.carol,
    redeemed_at: now,
  })
  await ins(db, 'invitations', {
    id: INV.board,
    token_hash: sha('tok-board'),
    workspace_id: W.studio,
    board_id: B.main,
    role: 'viewer',
    created_by: U.alice,
    expires_at: t(7 * D),
  })
  const link = (id: string) => sha(reviewLinkToken(TICKET_SECRET, id))
  await ins(db, 'invitations', {
    id: INV.review,
    token_hash: link(INV.review),
    workspace_id: W.studio,
    board_id: B.main,
    role: 'viewer',
    created_by: U.alice,
    created_at: t(-D),
    expires_at: t(6 * D),
    multi_use: true,
    max_uses: 5,
  })
  await ins(db, 'invitations', {
    id: INV.workshop,
    token_hash: link(INV.workshop),
    workspace_id: W.studio,
    board_id: B.main,
    role: 'editor',
    created_by: U.alice,
    created_at: t(-H),
    expires_at: t(2 * H),
    multi_use: true,
  })
  await ins(db, 'invitations', {
    id: INV.revoked,
    token_hash: link(INV.revoked),
    workspace_id: W.studio,
    board_id: B.main,
    role: 'commenter',
    created_by: U.alice,
    created_at: t(-2 * D),
    expires_at: t(5 * D),
    revoked_at: t(-D),
    multi_use: true,
  })
  await ins(db, 'invitations', {
    id: INV.expired,
    token_hash: link(INV.expired),
    workspace_id: W.studio,
    board_id: B.main,
    role: 'viewer',
    created_by: U.alice,
    created_at: t(-40 * D),
    expires_at: t(-11 * D),
    multi_use: true,
    swept_at: t(-11 * D),
  })
  // erin joins the review link (the old accept path: grant, then redeemed_by -> trigger)
  await ins(db, 'board_members', {
    board_id: B.main,
    user_id: U.erin,
    role: 'viewer',
    added_by: U.alice,
    created_at: now,
  })
  await db.query('UPDATE invitations SET redeemed_by = $2, redeemed_at = $3 WHERE id = $1', [
    INV.review,
    U.erin,
    now,
  ])
  // dave joins the workshop link: raised commenter -> editor
  await db.query("UPDATE board_members SET role = 'editor' WHERE board_id = $1 AND user_id = $2", [
    B.main,
    U.dave,
  ])
  await db.query('UPDATE invitations SET redeemed_by = $2, redeemed_at = $3 WHERE id = $1', [
    INV.workshop,
    U.dave,
    now,
  ])
  await db.query(
    "UPDATE invitation_redemptions SET previous_role = 'commenter' WHERE invitation_id = $1 AND user_id = $2",
    [INV.workshop, U.dave],
  )
  await ins(db, 'audit_events', {
    workspace_id: W.studio,
    actor_id: U.alice,
    action: 'board.create',
    target: B.main,
    detail: { title: 'Main' },
  })
  await ins(db, 'audit_events', {
    workspace_id: W.studio,
    actor_id: U.erin,
    action: 'invitation.accept',
    target: INV.review,
  })

  // 0002 comments
  await ins(db, 'comment_threads', {
    id: 'thr_thread0000001',
    workspace_id: W.studio,
    board_id: B.main,
    anchor: { kind: 'point', x: 1, y: 2 },
    created_by: U.bob,
  })
  await ins(db, 'comment_threads', {
    id: 'thr_thread0000002',
    workspace_id: W.studio,
    board_id: B.main,
    anchor: { kind: 'shape', shapeId: 'shape:a', u: 0.5, v: 0.5 },
    status: 'resolved',
    created_by: U.bob,
    resolved_by: U.alice,
    resolved_at: now,
  })
  await ins(db, 'comments', {
    id: 'cmt_comment000001',
    thread_id: 'thr_thread0000001',
    workspace_id: W.studio,
    board_id: B.main,
    author_id: U.bob,
    body: 'Hello @alice',
  })
  await ins(db, 'comments', {
    id: 'cmt_comment000002',
    thread_id: 'thr_thread0000001',
    workspace_id: W.studio,
    board_id: B.main,
    author_id: U.erin,
    body: 'gone',
    deleted_at: now,
  })
  await ins(db, 'comment_mentions', {
    comment_id: 'cmt_comment000001',
    user_id: U.alice,
    workspace_id: W.studio,
  })
  await ins(db, 'comment_reads', {
    thread_id: 'thr_thread0000001',
    user_id: U.alice,
    workspace_id: W.studio,
    read_at: now,
  })
  await ins(db, 'notifications', {
    workspace_id: W.studio,
    user_id: U.alice,
    kind: 'mention',
    board_id: B.main,
    thread_id: 'thr_thread0000001',
    comment_id: 'cmt_comment000001',
    actor_id: U.bob,
  })
  await ins(db, 'notifications', {
    workspace_id: W.studio,
    user_id: U.alice,
    kind: 'access_request',
    board_id: B.view,
    actor_id: U.carol,
  })
  // 0003 history
  await ins(db, 'board_snapshots', {
    id: 'snp_snap000000001',
    workspace_id: W.studio,
    board_id: B.main,
    name: 'Before',
    kind: 'manual',
    created_by: U.alice,
    document_clock: 5,
    record_count: 10,
    size_bytes: 1234,
    storage_key: `snapshots/${B.main}/snp_snap000000001.json`,
  })
  await ins(db, 'board_asset_links', {
    workspace_id: W.studio,
    board_id: B.view,
    asset_id: 'ast_asset00000001',
    version_id: 'ver_ver0000000001',
  })
  // 0004 workshops
  await ins(db, 'workshop_timers', {
    board_id: B.main,
    workspace_id: W.studio,
    status: 'running',
    duration_ms: 300_000,
    started_at: now,
    ends_at: t(300_000),
    remaining_ms: 300_000,
    started_by: U.alice,
  })
  await ins(db, 'vote_sessions', {
    id: 'vot_vote000000001',
    workspace_id: W.studio,
    board_id: B.main,
    title: 'Pick',
    votes_per_person: 3,
    scope: 'board',
    created_by: U.alice,
  })
  await ins(db, 'vote_sessions', {
    id: 'vot_vote000000002',
    workspace_id: W.studio,
    board_id: B.view,
    title: 'Done',
    votes_per_person: 1,
    scope: 'frame',
    frame_id: 'shape:frame1',
    shape_types: ['note'],
    status: 'revealed',
    created_by: U.alice,
    closed_at: now,
    revealed_at: now,
  })
  await ins(db, 'votes', {
    session_id: 'vot_vote000000001',
    workspace_id: W.studio,
    user_id: U.bob,
    shape_id: 'shape:abc',
    count: 2,
  })
  await ins(db, 'vote_done', { session_id: 'vot_vote000000001', workspace_id: W.studio, user_id: U.bob })
  // 0005 dashboard
  await ins(db, 'board_stars', { user_id: U.alice, board_id: B.main, workspace_id: W.studio })
  await ins(db, 'access_requests', {
    id: 'acr_req0000000001',
    workspace_id: W.studio,
    board_id: B.view,
    user_id: U.carol,
    role_requested: 'editor',
    message: 'please',
  })
  await ins(db, 'access_requests', {
    id: 'acr_req0000000002',
    workspace_id: W.studio,
    board_id: B.main,
    user_id: U.carol,
    role_requested: 'viewer',
    status: 'approved',
    decided_by: U.alice,
    decided_at: now,
    role_granted: 'viewer',
  })
  // 0007 assets
  const ver = (id: string, extra: Record<string, unknown>) =>
    ins(db, 'asset_versions', {
      id,
      asset_id: `ast_${id.slice(4)}`,
      workspace_id: W.studio,
      board_id: B.main,
      name: 'f.png',
      declared_mime_type: 'image/png',
      mime_type: 'image/png',
      kind: 'image',
      size_bytes: 3_000_000_000, // > 2^31: bigint as a string in node-postgres
      sha256: 'a'.repeat(64),
      uploaded_by: U.bob,
      ...extra,
    })
  await ver('ver_ver0000000001', { asset_id: 'ast_asset00000001', status: 'ready' })
  await ver('ver_ver0000000002', {
    kind: 'pdf',
    mime_type: 'application/pdf',
    declared_mime_type: 'application/pdf',
  })
  await ver('ver_ver0000000003', { status: 'failed', error_code: 'BAD_FILE', error_message: 'Unreadable.' })
  await ins(db, 'asset_derivatives', {
    id: 'drv_drv0000000001',
    version_id: 'ver_ver0000000001',
    position: 0,
    role: 'thumb',
    width: 10,
    height: 10,
    mime_type: 'image/webp',
    bytes: 100,
    blob_key: 'assets/ast_asset00000001/ver_ver0000000001/d/drv_drv0000000001.webp',
  })
  await ins(db, 'preview_jobs', {
    version_id: 'ver_ver0000000001',
    profile: 'p1',
    status: 'done',
    lease_owner: 'nas-1',
  })
  await ins(db, 'preview_jobs', {
    version_id: 'ver_ver0000000002',
    profile: 'p1',
    status: 'running',
    lease_owner: 'nas-1',
    lease_until: t(60_000),
    attempts: 1,
  })
  await ins(db, 'preview_jobs', {
    version_id: 'ver_ver0000000003',
    profile: 'p1',
    status: 'failed',
    attempts: 3,
  })
  await ins(db, 'asset_derivative_reservations', {
    id: 'drv_res0000000001',
    version_id: 'ver_ver0000000002',
    attempt: 1,
    role: 'page',
    page: 1,
    width: 10,
    height: 10,
    mime_type: 'image/png',
    bytes: 10,
    blob_key: 'assets/ast_ver0000000002/ver_ver0000000002/d/drv_res0000000001.png',
  })
}

async function tables(db: Db, schema: string): Promise<string[]> {
  const r = await db.query<{ t: string }>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1",
    [schema],
  )
  return r.rows.map((x) => x.t)
}

async function counts(db: Db, schema: string) {
  const out: Record<string, number> = {}
  for (const t of await tables(db, schema))
    out[t] = (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).n
  return out
}

interface Shape {
  columns: Map<string, string>
  constraints: Map<string, string>
  indexes: Map<string, string>
  triggers: Set<string>
}
async function shapeOf(db: Db, schema: string): Promise<Shape> {
  const cols = await db.query<{ k: string; v: string }>(
    `SELECT table_name || '.' || column_name AS k,
            data_type || '|' || is_nullable || '|' || coalesce(column_default, '') AS v
       FROM information_schema.columns WHERE table_schema = $1`,
    [schema],
  )
  const cons = await db.query<{ k: string; v: string }>(
    `SELECT conrelid::regclass::text || '.' || conname AS k, pg_get_constraintdef(oid) AS v
       FROM pg_constraint WHERE connamespace = $1::regnamespace`,
    [schema],
  )
  const idx = await db.query<{ k: string; v: string }>(
    'SELECT indexname AS k, indexdef AS v FROM pg_indexes WHERE schemaname = $1',
    [schema],
  )
  const trg = await db.query<{ k: string }>(
    `SELECT tgrelid::regclass::text || '.' || tgname AS k FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = $1::regnamespace AND NOT tgisinternal`,
    [schema],
  )
  return {
    columns: new Map(cols.rows.map((r) => [r.k, r.v])),
    constraints: new Map(cons.rows.map((r) => [r.k, r.v])),
    indexes: new Map(idx.rows.map((r) => [r.k, r.v])),
    triggers: new Set(trg.rows.map((r) => r.k)),
  }
}

describe.skipIf(!PG_URL)('every migration after 0008 on a real Postgres holding M1/M2/M3 data', () => {
  let s: Scoped
  const now = new Date()
  const all = loadMigrations()
  const old = all.filter((m) => m.version <= 8)
  const upgrade = all.filter((m) => m.version > 8).map((m) => m.name)
  let before: Shape
  let beforeCounts: Record<string, number>

  beforeAll(async () => {
    s = await openSchema('mig_probe')
    expect((await migrate(s.db, { migrations: old })).applied).toHaveLength(8)
    await seedOldData(s.db, now)
    before = await shapeOf(s.db, s.schema)
    beforeCounts = await counts(s.db, s.schema)
  })
  afterAll(async () => {
    await s?.drop()
  })

  it('every M1/M2/M3 table holds rows before the upgrade', () => {
    const empty = Object.entries(beforeCounts).filter(([, n]) => n === 0)
    console.log('row counts before', beforeCounts)
    expect(empty).toEqual([])
    expect(Object.keys(beforeCounts)).toHaveLength(29) // 28 tables + schema_migrations
  })

  it('applies 0009 onwards; every CHECK validated against the existing rows; nothing existing changed', async () => {
    const t0 = Date.now()
    const r = await migrate(s.db)
    console.log('upgrade took ms', Date.now() - t0)
    expect(r.applied).toEqual(upgrade)
    expect(upgrade.slice(0, 4)).toEqual([
      '0009_guests',
      '0010_private_notes',
      '0011_board_thumbnails',
      '0012_board_export_policy',
    ])
    const notValid = await s.db.query<{ c: string }>(
      `SELECT conrelid::regclass::text || '.' || conname AS c FROM pg_constraint
        WHERE connamespace = $1::regnamespace AND NOT convalidated`,
      [s.schema],
    )
    expect(notValid.rows).toEqual([])
    const after = await shapeOf(s.db, s.schema)
    const changed: string[] = []
    for (const [k, v] of before.columns)
      if (after.columns.get(k) !== v) changed.push(`column ${k}: ${v} -> ${after.columns.get(k)}`)
    for (const [k, v] of before.constraints)
      if (after.constraints.get(k) !== v) changed.push(`constraint ${k}: ${v} -> ${after.constraints.get(k)}`)
    for (const [k, v] of before.indexes) if (after.indexes.get(k) !== v) changed.push(`index ${k}`)
    for (const k of before.triggers) if (!after.triggers.has(k)) changed.push(`trigger ${k}`)
    // The intended changes to existing objects (each a drop and re-add of a CHECK); anything else is still a
    // failure. 0017_comment_notifications and 0024 widen the notification kinds ('new_comment', then
    // 'access_granted', which like 'access_request' has no thread); 0024 widens the vote scopes
    // ('selection'). The texts are what PGlite 18.3 prints for them (checked there 2026-10-03).
    const anyOf = (col: string, list: string[]) =>
      `(${col} = ANY (ARRAY[${list.map((k) => `'${k}'::text`).join(', ')}]))`
    // 0026 (wave J) widens both notification CHECKs again ('outsider_joined', no thread either), and 0037 (wave S)
    // once more ('review_status', no thread needed: it names its review event).
    // 0025_open_signin widens the M1 identities.provider CHECK ('email'; user_emails is from 0021, so its
    // source CHECK is not an existing object here).
    const m1Kinds = ['mention', 'reply', 'resolved', 'access_request']
    // 0035_board_imports (wave R) widens the M1 board statuses ('importing'; the same text is checked on PGlite in
    // packages/db/test/wave-r-0035-0036.test.ts).
    const m1Statuses = ['active', 'archived', 'trashed']
    expect([...changed].sort()).toEqual(
      [
        `constraint boards.boards_status_check: CHECK (${anyOf('status', m1Statuses)}) -> CHECK (${anyOf('status', [...m1Statuses, 'importing'])})`,
        `constraint identities.identities_provider_check: CHECK (${anyOf('provider', ['dev', 'clerk'])}) -> CHECK (${anyOf('provider', ['dev', 'clerk', 'email'])})`,
        `constraint notifications.notifications_kind_check: CHECK (${anyOf('kind', m1Kinds)}) -> CHECK (${anyOf('kind', [...m1Kinds, 'new_comment', 'access_granted', 'outsider_joined', 'review_status'])})`,
        `constraint notifications.notifications_check: CHECK (((kind = 'access_request'::text) OR (thread_id IS NOT NULL))) -> CHECK ((${anyOf('kind', ['access_request', 'access_granted', 'outsider_joined', 'review_status'])} OR (thread_id IS NOT NULL)))`,
        `constraint vote_sessions.vote_sessions_scope_check: CHECK (${anyOf('scope', ['board', 'frame'])}) -> CHECK (${anyOf('scope', ['board', 'frame', 'selection'])})`,
      ].sort(),
    )
    // New columns on existing tables: NOT NULL ones need a default (an old build's INSERTs omit them).
    const added = [...after.columns].filter(
      ([k]) => !before.columns.has(k) && before.columns.has(`${k.split('.')[0]}.id`),
    )
    console.log('columns added to existing tables', added)
    for (const [k, v] of added) {
      const [, nullable, dflt] = v.split('|')
      if (nullable === 'NO') expect(dflt, k).not.toBe('')
    }
    const addedCons = [...after.constraints.keys()].filter((k) => !before.constraints.has(k))
    console.log('constraints added', addedCons)
    // Existing rows read as accounts / links without guests.
    expect(
      (await s.db.query("SELECT id FROM users WHERE kind <> 'account' OR guest_name IS NOT NULL")).rows,
    ).toEqual([])
    expect((await s.db.query('SELECT id FROM invitations WHERE allow_guests')).rows).toEqual([])
    // 0021_domain_access (docs/DOMAIN-ACCESS-CONTRACTS.md §3.2, D3): the open single-use links bound
    // to nobody are revoked; redeemed, multi-use, already revoked and expired ones are untouched.
    const revoked = Object.fromEntries(
      (
        await s.db.query<{ id: string; revoked_at: Date | null }>('SELECT id, revoked_at FROM invitations')
      ).rows.map((r) => [r.id, r.revoked_at]),
    )
    expect(revoked[INV.single]).toBeInstanceOf(Date)
    expect(revoked[INV.board]).toBeInstanceOf(Date)
    for (const id of [INV.wsGuest, INV.review, INV.workshop, INV.expired]) expect(revoked[id], id).toBeNull()
    expect(revoked[INV.revoked]?.getTime()).toBe(now.getTime() - D)
    expect((await s.db.query('SELECT id FROM invitations WHERE invited_email IS NOT NULL')).rows).toEqual([])
    // Personal workspaces are marked (each creator's earliest one), Dev Studio never.
    const personal = Object.fromEntries(
      (
        await s.db.query<{ id: string; personal_of: string | null }>('SELECT id, personal_of FROM workspaces')
      ).rows.map((r) => [r.id, r.personal_of]),
    )
    expect(personal).toEqual({ [W.studio]: U.alice, [W.other]: U.bob, wsp_DevStudio00000000000: null })
    // Nobody is confirmed yet, and no address is stored.
    expect((await s.db.query('SELECT id FROM users WHERE identity_checked_at IS NOT NULL')).rows).toEqual([])
    expect((await s.db.one<{ n: number }>('SELECT count(*)::int AS n FROM user_emails')).n).toBe(0)
    const afterCounts = await counts(s.db, s.schema)
    for (const [t, n] of Object.entries(beforeCounts))
      if (t !== 'schema_migrations') expect(afterCounts[t], t).toBe(n)
    // Wave M (the foundation): 0029_usage_daily and 0030_workspace_templates are new tables only (no existing
    // object changed, checked above), empty after the upgrade.
    expect(upgrade.slice(-11, -9)).toEqual(['0029_usage_daily', '0030_workspace_templates'])
    expect(afterCounts.usage_daily).toBe(0)
    expect(afterCounts.workspace_templates).toBe(0)
    // Wave N (the foundation): 0031_board_visits and 0032_board_links are new tables only, empty after the upgrade.
    expect(upgrade.slice(-9, -7)).toEqual(['0031_board_visits', '0032_board_links'])
    expect(afterCounts.board_visits).toBe(0)
    expect(afterCounts.board_links).toBe(0)
    expect(afterCounts.board_link_scans).toBe(0)
    // Wave Q (the foundation): 0033_library is new tables only, empty after the upgrade.
    expect(upgrade.slice(-7, -6)).toEqual(['0033_library'])
    for (const t of ['library_folders', 'library_items', 'library_item_files', 'library_marks'])
      expect(afterCounts[t], t).toBe(0)
    // The wave Q review fixes: 0034_library_place is a new table and a defaulted column of 0033's library_items.
    expect(upgrade.slice(-6, -5)).toEqual(['0034_library_place'])
    expect(afterCounts.library_place_pending).toBe(0)
    // Wave R (the foundation): 0035_board_imports widens boards.status (no existing row changes) and adds two tables;
    // 0036_chat_hooks adds three. All empty after the upgrade.
    expect(upgrade.slice(-5, -3)).toEqual(['0035_board_imports', '0036_chat_hooks'])
    const waveR = ['board_imports', 'board_import_files', 'chat_hooks', 'chat_hook_prefs', 'chat_deliveries']
    for (const t of waveR) expect(afterCounts[t], t).toBe(0)
    // Wave S (the foundation): 0037_client_review adds three tables, five nullable or defaulted columns (checked above)
    // and widens the two notification CHECKs. All empty after the upgrade; existing rows land on 'board' links.
    expect(upgrade.slice(-3, -2)).toEqual(['0037_client_review'])
    for (const t of ['review_rounds', 'review_items', 'review_events']) expect(afterCounts[t], t).toBe(0)
    expect((await s.db.query("SELECT id FROM invitations WHERE landing <> 'board'")).rows).toEqual([])
    // Wave V (the foundation): 0038_live_sessions adds four tables and two nullable or defaulted columns of invitations
    // (checked above: no existing object changed). All empty after the upgrade; no existing link has a join code.
    expect(upgrade.slice(-2, -1)).toEqual(['0038_live_sessions'])
    for (const t of ['live_activities', 'live_answers', 'breakout_sessions', 'breakout_members'])
      expect(afterCounts[t], t).toBe(0)
    expect(
      (await s.db.query('SELECT id FROM invitations WHERE join_code_hash IS NOT NULL OR join_code_n <> 0'))
        .rows,
    ).toEqual([])
    // Wave W (the foundation): 0039_formats adds six tables and one nullable column of asset_versions (checked above:
    // no existing object changed). All empty after the upgrade; no existing version is derived from another.
    expect(upgrade.slice(-1)).toEqual(['0039_formats'])
    for (const t of [
      'worker_ops',
      'worker_op_outputs',
      'worker_capabilities_seen',
      'file_text_state',
      'file_text_pages',
      'board_file_refs',
    ])
      expect(afterCounts[t], t).toBe(0)
    expect(
      (await s.db.query('SELECT id FROM asset_versions WHERE derived_from_version_id IS NOT NULL')).rows,
    ).toEqual([])
  })

  it('the checksum guard accepts re-runs (also from a CRLF checkout) and refuses an edited file', async () => {
    expect((await migrate(s.db)).applied).toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'dr-crlf-'))
    try {
      for (const m of all) writeFileSync(join(dir, `${m.name}.sql`), m.sql.replace(/\r?\n/g, '\r\n'))
      expect((await migrate(s.db, { dir })).applied).toEqual([])
      writeFileSync(join(dir, '0011_board_thumbnails.sql'), `${all[10]?.sql}\n-- edited`)
      await expect(migrate(s.db, { dir })).rejects.toThrow(
        /0011_board_thumbnails changed after it was applied/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // Two api instances starting at once (advisory lock): both succeed, nothing applied twice.
    const [a, b] = await Promise.all([migrate(s.db), migrate(s.db)])
    expect([...a.applied, ...b.applied]).toEqual([])
  })

  it('an OLD api build (migrations 0001-0008 only) refuses to start on the upgraded database', async () => {
    await expect(migrate(s.db, { migrations: old })).rejects.toThrow(
      /database has migration 0009_guests, which this build does not know/,
    )
  })

  it('rolled back with DRAFTROOM_ALLOW_NEWER_SCHEMA, the old build starts: it applies nothing and reports the newer migrations', async () => {
    const recorded = async () =>
      (await s.db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY version')).rows.map(
        (r) => r.name,
      )
    const before = await recorded()
    expect(await migrate(s.db, { migrations: old, allowNewerSchema: true })).toEqual({
      applied: [],
      newer: upgrade,
    })
    // A build between the two (it knows 0009-0012): only what it does not know is "newer".
    const middle = all.filter((m) => m.version <= 12)
    expect((await migrate(s.db, { migrations: middle, allowNewerSchema: true })).newer).toEqual(
      upgrade.slice(4),
    )
    expect(await recorded()).toEqual(before)
    // Never with a gap below what it knows, or with an edited file.
    await expect(
      migrate(s.db, { migrations: all.filter((m) => m.version !== 10), allowNewerSchema: true }),
    ).rejects.toThrow(/database has migration 0010_private_notes, which this build does not know/)
    const edited = old.map((m) => (m.version === 5 ? { ...m, checksum: 'x'.repeat(64) } : m))
    await expect(migrate(s.db, { migrations: edited, allowNewerSchema: true })).rejects.toThrow(
      /0005_dashboard changed after it was applied/,
    )
  })

  it("an old build's writes still work: INSERT/UPDATE without the new columns", async () => {
    await s.db.query(
      `INSERT INTO users (id, name, handle, color) VALUES ('usr_oldbuild00001', 'Old', 'oldb', '#112233')`,
    )
    await s.db.query(
      `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, created_at, expires_at, multi_use, max_uses)
       VALUES ('inv_oldbuild00001', $1, $2, $3, 'viewer', $4, now(), now() + interval '1 day', true, NULL)`,
      [sha('old-build-link'), W.studio, B.main, U.alice],
    )
    const row = await s.db.one<{ kind: string; allow: boolean }>(
      `SELECT u.kind, i.allow_guests AS allow FROM users u, invitations i
        WHERE u.id = 'usr_oldbuild00001' AND i.id = 'inv_oldbuild00001'`,
    )
    expect(row).toEqual({ kind: 'account', allow: false })
    await s.db.query("UPDATE users SET name = 'Renamed' WHERE id = 'usr_oldbuild00001'")
  })

  it('the new api on the upgraded data: accounts keep working, guests join next to them', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-mig-api-'))
    const config = loadConfig(testEnv(dataDir))
    const notifier = createRecordingNotifier()
    const server = await createApiServer(config, { db: s.db, notifier, now: () => new Date() })
    await server.app.ready()
    const inject = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
      server.app.inject({
        method: method as 'GET',
        url,
        ...(body === undefined ? {} : { payload: body as object }),
        headers: { origin: ORIGIN, ...headers },
      })
    try {
      const login = async (handle: string) => {
        const res = await inject('POST', '/api/auth/dev/login', { handle })
        expect(res.statusCode, res.body).toBe(200)
        const c = res.cookies.find((x) => x.name === 'dr_session')
        return { cookie: `dr_session=${c?.value}`, me: res.json() as { user: { id: string }; kind?: string } }
      }
      const alice = await login('alice')
      expect(alice.me.user.id).toBe(U.alice)
      const carol = await login('carol')
      expect(carol.me.user.id).toBe(U.carol)
      const me = await inject('GET', '/api/me', undefined, { cookie: carol.cookie })
      expect(me.statusCode).toBe(200)
      expect((me.json() as { kind: string }).kind).toBe('account')

      const list = await inject('GET', `/api/workspaces/${W.studio}/boards`, undefined, {
        cookie: alice.cookie,
      })
      expect(list.statusCode, list.body).toBe(200)
      for (const b of (list.json() as { boards: { thumbnailVersion: unknown }[] }).boards)
        expect(b.thumbnailVersion).toBeNull()

      // the old review link: no guests
      const oldTok = reviewLinkToken(TICKET_SECRET, INV.review)
      const preview = await inject('GET', `/api/invitations/${oldTok}`)
      expect(preview.statusCode, preview.body).toBe(200)
      expect((preview.json() as { allowGuests: boolean }).allowGuests).toBe(false)
      const refused = await inject('POST', `/api/invitations/${oldTok}/guest`, { name: 'Sam' })
      expect(refused.statusCode, refused.body).toBe(403)

      // old boards: no export policy stored, so the default (read before any new link below: since
      // cdaf361 the first client link on such a board stores 'editors')
      const polBefore = await inject('GET', `/api/boards/${B.main}/export-policy`, undefined, {
        cookie: carol.cookie,
      })
      expect(polBefore.statusCode, polBefore.body).toBe(200)
      expect(polBefore.json()).toEqual({ exportPolicy: 'everyone', canExport: true, policySet: false })

      // a new guest link and a guest next to the accounts
      const created = await inject(
        'POST',
        `/api/boards/${B.main}/review-links`,
        { role: 'commenter', allowGuests: true },
        { cookie: alice.cookie },
      )
      expect(created.statusCode, created.body).toBe(201)
      const url = (created.json() as { url: string }).url
      const joined = await inject('POST', `/api/invitations/${url.slice(url.lastIndexOf('/') + 1)}/guest`, {
        name: 'Sam',
      })
      expect(joined.statusCode, joined.body).toBe(201)
      const g = await s.db.one<{ kind: string; name: string; guest_name: string; handle: string | null }>(
        "SELECT kind, name, guest_name, handle FROM users WHERE kind = 'guest'",
      )
      expect(g).toEqual({ kind: 'guest', name: 'Sam (guest)', guest_name: 'Sam', handle: null })

      // the workshop link from before the upgrade still extends (allow_guests false)
      const ext = await inject(
        'POST',
        `/api/boards/${B.main}/review-links/${INV.workshop}/extend`,
        { hours: 1 },
        {
          cookie: alice.cookie,
        },
      )
      expect(ext.statusCode, ext.body).toBe(200)
      // DANA2-01 (cdaf361): that first commenter (client) link stored 'editors' on the old board, whose
      // owner never chose a policy; carol, not an editor there, may no longer export
      const pol = await inject('GET', `/api/boards/${B.main}/export-policy`, undefined, {
        cookie: carol.cookie,
      })
      expect(pol.json()).toEqual({ exportPolicy: 'editors', canExport: false, policySet: true })
      // the owner's explicit choice on the old board is stored and kept
      const put = await inject(
        'PUT',
        `/api/boards/${B.main}/export-policy`,
        { exportPolicy: 'everyone' },
        {
          cookie: alice.cookie,
        },
      )
      expect(put.statusCode, put.body).toBe(200)
      const polAfter = await inject('GET', `/api/boards/${B.main}/export-policy`, undefined, {
        cookie: carol.cookie,
      })
      expect(polAfter.json()).toEqual({ exportPolicy: 'everyone', canExport: true, policySet: true })
      // private brainstorm on the old board
      const start = await inject(
        'POST',
        `/api/boards/${B.main}/private-brainstorm`,
        {
          prompt: 'Ideas?',
          anonymous: false,
          target: { frameId: 'shape:f1', pageId: 'page:page', x: 0, y: 0, w: 100, h: 100 },
        },
        { cookie: alice.cookie },
      )
      expect(start.statusCode, start.body).toBe(201)

      // the CHECKs hold for new writes
      const bad1 = await s.db
        .query(
          `INSERT INTO invitations (id, token_hash, workspace_id, role, created_by, expires_at, allow_guests)
           VALUES ('inv_badguest00001', $1, $2, 'member', $3, now() + interval '1 day', true)`,
          [sha('bad'), W.studio, U.alice],
        )
        .catch((e) => e)
      expect(pgErrorCode(bad1)).toBe('23514')
      const bad2 = await s.db.query("UPDATE users SET name = 'Sam' WHERE kind = 'guest'").catch((e) => e)
      expect(pgErrorCode(bad2)).toBe('23514')
      const bad3 = await s.db
        .query("UPDATE users SET kind = 'guest' WHERE id = $1", [U.carol])
        .catch((e) => e)
      expect(pgErrorCode(bad3)).toBe('23514')

      // sweeps on the mixed data
      const r = await sweepGuests({
        db: s.db,
        now: () => new Date(),
        sessions: { announceRevoked: () => {} },
        notifier: { accessChanged: () => {}, drain: async () => {} },
        events: { publish: () => {} },
      } as never)
      expect(r).toEqual({ signedOut: [], removed: [] })
    } finally {
      await server.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
