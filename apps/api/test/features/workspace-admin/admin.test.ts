// Wave W (WS5): the workspace admin routes (docs/WAVE-W-CONTRACTS.md §7). Owners and admins only: everyone else gets
// the unknown route's 404 (never a 401 or a 403), and so does everyone while DRAFTROOM_WORKSPACE_ADMIN is off. The
// routes read and change nothing; the page's changes go through the existing routes, which these tests call the way
// the page does (a revoke from the admin page IS the Share dialog's revoke).
//
// The world (guests/support.ts): alice owns Dev Studio; bob is a member and owns `board` (private); carol is a member
// with no access to it; erin is an outsider with an account (not in Dev Studio).
import {
  ADMIN_LIMITS,
  ADMIN_RETENTION_FACT_IDS,
  ADMIN_ROUTE_KEYS,
  AdminAuditResponse,
  AdminInvitationsResponse,
  AdminLinksResponse,
  AdminMembersResponse,
  AdminRetentionResponse,
  AdminStorageResponse,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audit } from '../../../src/audit.ts'
import { workspaceUsage } from '../../../src/files/usage.ts'
import { type Client, createBoard, DEV_STUDIO, devEmail } from '../../helpers.ts'
import {
  type GuestClient,
  guestLink,
  joinAsGuest,
  type Method,
  setupWorld,
  tokenOf,
  type World,
} from '../guests/support.ts'

const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }
const ROUTES = Object.values(ADMIN_ROUTE_KEYS)
const path = (key: string, wid: string) => (key.split(' ')[1] ?? '').replace(':wid', wid)
const get = (c: { req: Client['req'] }, tail: string, wid = DEV_STUDIO) =>
  c.req('GET', `/api/workspaces/${wid}/admin/${tail}`)

let w: World
afterEach(async () => {
  await w?.api.close()
})

/** erin, an account outside Dev Studio, gets a board invitation by email and accepts it: a workspace guest. */
async function makeWorkspaceGuest(): Promise<void> {
  const inv = await w.bob.req('POST', `/api/boards/${w.board}/invitations`, {
    role: 'viewer',
    email: devEmail('erin'),
  })
  expect(inv.statusCode, inv.body).toBe(201)
  const accepted = await w.erin.req('POST', `/api/invitations/${tokenOf(inv.json().url)}/accept`)
  expect(accepted.statusCode, accepted.body).toBe(200)
  const role = await w.api.db.one<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [DEV_STUDIO, w.erin.userId],
  )
  expect(role.role).toBe('guest')
}

/**
 * `n` rows made `aheadMs` from now on the test clock. Their times tie in pairs and differ by single microseconds,
 * which a millisecond cursor would lose (and a cursor on time alone would skip or repeat).
 */
const seedTime = (aheadMs: number) =>
  `($3::timestamptz + ${aheadMs} * interval '1 millisecond' - (n / 2) * interval '1 microsecond')`

/** `n` pending single-use workspace invitations (`inv_seed<tag>…`), each locked to an address. */
async function seedInvitations(tag: string, n: number, aheadMs = 0): Promise<void> {
  await w.api.db.query(
    `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, created_at, expires_at,
                              invited_email)
     SELECT 'inv_seed' || $4 || lpad(n::text, 6, '0'), md5($4 || n) || md5('t' || $4 || n), $1, NULL, 'member', $2,
            ${seedTime(aheadMs)}, $3::timestamptz + interval '7 days', 'p' || n || '@client.example'
       FROM generate_series(1, $5::int) AS n`,
    [DEV_STUDIO, w.alice.userId, w.api.clock.now(), tag, n],
  )
}

/** `n` open review links on bob's board (`inv_seed<tag>…`). */
async function seedLinks(tag: string, n: number, aheadMs = 0): Promise<void> {
  await w.api.db.query(
    `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, created_at, expires_at,
                              multi_use, allow_guests)
     SELECT 'inv_seed' || $4 || lpad(n::text, 6, '0'), md5($4 || n) || md5('t' || $4 || n), $1, $6, 'viewer', $2,
            ${seedTime(aheadMs)}, $3::timestamptz + interval '7 days', true, true
       FROM generate_series(1, $5::int) AS n`,
    [DEV_STUDIO, w.bob.userId, w.api.clock.now(), tag, n, w.board],
  )
}

/** `n` name-only guests (`usr_seed<tag>…`) who joined Dev Studio and can open bob's board. */
async function seedGuests(tag: string, n: number, aheadMs = 0): Promise<void> {
  await w.api.db.query(
    `INSERT INTO users (id, name, color, kind, guest_name)
     SELECT 'usr_seed' || $1 || lpad(n::text, 6, '0'), $1 || n || ' (guest)', '#1d4ed8', 'guest', $1 || n
       FROM generate_series(1, $2::int) AS n`,
    [tag, n],
  )
  // seedTime reads its base as $3
  await w.api.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
     SELECT $1, 'usr_seed' || $2 || lpad(n::text, 6, '0'), 'guest', ${seedTime(aheadMs)}
       FROM generate_series(1, $4::int) AS n`,
    [DEV_STUDIO, tag, w.api.clock.now(), n],
  )
  await w.api.db.query(
    `INSERT INTO board_members (board_id, user_id, role)
     SELECT $1, 'usr_seed' || $2 || lpad(n::text, 6, '0'), 'viewer' FROM generate_series(1, $3::int) AS n`,
    [w.board, tag, n],
  )
}

/** The seeded invitation ids `where` picks, newest first by (created_at, id). */
async function seededOrder(where: string): Promise<string[]> {
  const rows = await w.api.db.query<{ id: string }>(
    `SELECT i.id FROM invitations i WHERE ${where} ORDER BY i.created_at DESC, i.id DESC`,
  )
  return rows.rows.map((r) => r.id)
}

describe('who may see the admin page', () => {
  let sam: GuestClient
  beforeEach(async () => {
    w = await setupWorld()
    sam = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'commenter' })).url, 'Sam')
    await makeWorkspaceGuest()
  })

  it('the owner and an admin read every route; nobody else learns they exist (404 like an unknown route)', async () => {
    // carol becomes an admin through the existing route
    const promoted = await w.alice.req('PATCH', `/api/workspaces/${DEV_STUDIO}/members/${w.carol.userId}`, {
      role: 'admin',
    })
    expect(promoted.statusCode, promoted.body).toBe(200)
    for (const who of [w.alice, w.carol])
      for (const key of ROUTES) {
        const res = await who.req('GET', path(key, DEV_STUDIO))
        expect(res.statusCode, `${key}: ${res.body}`).toBe(200)
      }
    const refused: [string, (m: Method, u: string) => Promise<{ statusCode: number; json(): unknown }>][] = [
      ['signed out', (m, u) => w.api.anon(m, u)],
      ['a member (bob owns a board here)', (m, u) => w.bob.req(m, u)],
      ['a workspace guest with an account', (m, u) => w.erin.req(m, u)],
      ['a name-only guest', (m, u) => sam.req(m, u)],
    ]
    for (const [who, call] of refused)
      for (const key of ROUTES) {
        const res = await call('GET', path(key, DEV_STUDIO))
        expect({ who, key, status: res.statusCode }).toEqual({ who, key, status: 404 })
        expect(res.json(), `${who} ${key}`).toEqual(UNKNOWN)
      }
    // someone of another workspace: bob owns his personal workspace, carol is no member of it (and an admin of Dev
    // Studio is nothing there); a malformed workspace id is the same answer
    for (const key of ROUTES) {
      for (const [who, wid] of [
        [w.carol, w.bob.personalWorkspaceId],
        [w.alice, w.bob.personalWorkspaceId],
        [w.alice, 'not-a-workspace'],
      ] as const) {
        const res = await who.req('GET', path(key, wid))
        expect(res.statusCode, `${key} ${wid}`).toBe(404)
        expect(res.json()).toEqual(UNKNOWN)
      }
    }
    // a demoted admin loses it at once
    await w.alice.req('PATCH', `/api/workspaces/${DEV_STUDIO}/members/${w.carol.userId}`, { role: 'member' })
    expect((await get(w.carol, 'members')).statusCode).toBe(404)
  })

  it('a paging cursor, good or malformed, changes nothing for anyone else: still the unknown route 404', async () => {
    const tails = [
      'invitations?before=1792400000123456.inv_0123456789abcdefghij',
      'invitations?before=nonsense',
      'links?linksBefore=1792400000123456.inv_0123456789abcdefghij',
      'links?guestsBefore=1792400000123456.usr_0123456789abcdefghij',
      'links?linksBefore=nonsense&guestsBefore=nonsense',
    ]
    const refused: [string, (m: Method, u: string) => Promise<{ statusCode: number; json(): unknown }>][] = [
      ['signed out', (m, u) => w.api.anon(m, u)],
      ['a member', (m, u) => w.bob.req(m, u)],
      ['a workspace guest with an account', (m, u) => w.erin.req(m, u)],
      ['a name-only guest', (m, u) => sam.req(m, u)],
      [
        'the owner of another workspace',
        (m, u) => w.alice.req(m, u.replace(DEV_STUDIO, w.bob.personalWorkspaceId)),
      ],
    ]
    for (const [who, call] of refused)
      for (const tail of tails) {
        const res = await call('GET', `/api/workspaces/${DEV_STUDIO}/admin/${tail}`)
        expect({ who, tail, status: res.statusCode }).toEqual({ who, tail, status: 404 })
        expect(res.json(), `${who} ${tail}`).toEqual(UNKNOWN)
      }
    // the owner: a good cursor is a page, a malformed one a 400
    expect((await get(w.alice, tails[0] ?? '')).statusCode).toBe(200)
    expect((await get(w.alice, tails[1] ?? '')).statusCode).toBe(400)
    expect((await get(w.alice, tails[2] ?? '')).statusCode).toBe(200)
    expect((await get(w.alice, tails[4] ?? '')).statusCode).toBe(400)
  })

  it('the rate limit counts owners and admins only (a member never sees a 429)', async () => {
    for (let i = 0; i < ADMIN_LIMITS.rate.max + 5; i++)
      expect((await get(w.bob, 'retention')).statusCode).toBe(404)
    for (let i = 0; i < ADMIN_LIMITS.rate.max; i++)
      expect((await get(w.alice, 'retention')).statusCode).toBe(200)
    expect((await get(w.alice, 'members')).statusCode).toBe(429)
    w.api.clock.advance(ADMIN_LIMITS.rate.timeWindow + 1)
    expect((await get(w.alice, 'members')).statusCode).toBe(200)
  })
})

describe('the switch', () => {
  it('off: every admin route is an unknown route for the owner too', async () => {
    w = await setupWorld({ env: { DRAFTROOM_WORKSPACE_ADMIN: 'off' } })
    for (const key of ROUTES) {
      const res = await w.alice.req('GET', path(key, DEV_STUDIO))
      expect(res.statusCode, key).toBe(404)
      expect(res.json()).toEqual(UNKNOWN)
    }
    for (const tail of [
      'invitations?before=1792400000123456.inv_0123456789abcdefghij',
      'links?linksBefore=nonsense',
    ]) {
      const res = await get(w.alice, tail)
      expect(res.statusCode, tail).toBe(404)
      expect(res.json()).toEqual(UNKNOWN)
    }
  })
})

describe('the tabs', () => {
  beforeEach(async () => {
    w = await setupWorld()
  })

  it('members: role, creator, board grants and the outside markers; never a visit time', async () => {
    await makeWorkspaceGuest()
    const other = await createBoard(w.bob, DEV_STUDIO, 'Second')
    expect(
      (await w.bob.req('PUT', `/api/boards/${other}/members/${w.carol.userId}`, { role: 'editor' }))
        .statusCode,
    ).toBe(200)
    // a visit is recorded for alice: it must not appear anywhere in the answer
    await w.api.db.query('INSERT INTO board_visits (board_id, user_id, seen_at) VALUES ($1, $2, $3)', [
      w.board,
      w.alice.userId,
      new Date('2026-10-01T10:00:00Z'),
    ])
    const res = await get(w.alice, 'members')
    expect(res.statusCode, res.body).toBe(200)
    const body = AdminMembersResponse.parse(res.json())
    const byId = new Map(body.members.map((m) => [m.user.id, m]))
    expect(body.members[0]?.role).toBe('owner')
    expect(byId.get(w.alice.userId)).toMatchObject({ role: 'owner', creator: true })
    expect(byId.get(w.bob.userId)).toMatchObject({ role: 'member', creator: true, boardGrants: 2 })
    expect(byId.get(w.carol.userId)).toMatchObject({ role: 'member', boardGrants: 1 })
    expect(byId.get(w.erin.userId)).toMatchObject({ role: 'guest', boardGrants: 1 })
    for (const m of res.json().members as Record<string, unknown>[])
      expect(Object.keys(m).sort()).toEqual(
        ['boardGrants', 'creator', 'emailDomain', 'emailHint', 'outside', 'role', 'user'].sort(),
      )
    expect(res.body).not.toMatch(/visit|lastSeen|last_seen|2026-10-01/i)
  })

  it('invitations: pending ones only, workspace and board, the email hint and never the address or token', async () => {
    const ws = await w.alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
      role: 'member',
      email: 'dana.lee@client.example',
    })
    expect(ws.statusCode, ws.body).toBe(201)
    const board = await w.bob.req('POST', `/api/boards/${w.board}/invitations`, {
      role: 'commenter',
      email: 'frank@studio.example',
    })
    expect(board.statusCode, board.body).toBe(201)
    // a used one and a revoked one are not pending
    await makeWorkspaceGuest()
    const revoked = await w.bob.req('POST', `/api/boards/${w.board}/invitations`, {
      role: 'viewer',
      email: 'gone@studio.example',
    })
    expect((await w.bob.req('DELETE', `/api/invitations/${revoked.json().id}`)).statusCode).toBe(204)
    // a link is not an invitation (the links tab lists it)
    await guestLink(w.bob, w.board)

    const res = await get(w.alice, 'invitations')
    expect(res.statusCode, res.body).toBe(200)
    const body = AdminInvitationsResponse.parse(res.json())
    expect(body.more).toBe(false)
    expect(body.invitations.map((i) => i.id).sort()).toEqual([ws.json().id, board.json().id].sort())
    const wsRow = body.invitations.find((i) => i.id === ws.json().id)
    expect(wsRow).toMatchObject({
      scope: 'workspace',
      board: null,
      role: 'member',
      emailHint: 'd•••@client.example',
    })
    expect(wsRow?.invitedBy?.id).toBe(w.alice.userId)
    const boardRow = body.invitations.find((i) => i.id === board.json().id)
    expect(boardRow).toMatchObject({ scope: 'board', board: { id: w.board, title: 'Client review' } })
    expect(boardRow?.emailHint).toBe('f•••@studio.example')
    expect(res.body).not.toContain('dana.lee')
    expect(res.body).not.toContain('frank@')
    expect(res.body).not.toContain(tokenOf(ws.json().url))
    // revoking from the page is the existing DELETE /api/invitations/:id: an admin who did not send it may
    expect((await w.alice.req('DELETE', `/api/invitations/${board.json().id}`)).statusCode).toBe(204)
    const after = AdminInvitationsResponse.parse((await get(w.alice, 'invitations')).json())
    expect(after.invitations.map((i) => i.id)).toEqual([ws.json().id])
  })

  it('storage: by board and by uploader add up to exactly what workspaceUsage counts', async () => {
    const second = await createBoard(w.alice, DEV_STUDIO, 'Big files')
    let n = 0
    const version = async (board: string, by: Client, bytes: number, previews: number[]) => {
      n++
      const id = `ver_admin${String(n).padStart(12, '0')}`
      const asset = `ast_admin${String(n).padStart(12, '0')}`
      await w.api.db.query(
        `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                     size_bytes, sha256, uploaded_by, status)
         VALUES ($1, $2, $3, $4, 'f.png', 'image/png', 'image/png', 'image', $5, $6, $7, 'ready')`,
        [id, asset, DEV_STUDIO, board, bytes, 'b'.repeat(64), by.userId],
      )
      for (const [i, b] of previews.entries())
        await w.api.db.query(
          `INSERT INTO asset_derivatives (id, version_id, position, role, width, height, mime_type, bytes, blob_key)
           VALUES ($1, $2, $3, 'thumb', 10, 10, 'image/webp', $4, $5)`,
          [
            `drv_admin${String(n).padStart(8, '0')}${i}000`,
            id,
            i,
            b,
            `assets/${asset}/${id}/d/drv_admin${String(n).padStart(8, '0')}${i}000.webp`,
          ],
        )
    }
    await version(w.board, w.bob, 1_000_000, [2_000, 3_000])
    await version(w.board, w.alice, 50_000, [])
    await version(second, w.alice, 4_000_000, [10_000])
    await version(second, w.carol, 700, [5])
    await w.api.db.query(
      `INSERT INTO board_thumbnails (board_id, workspace_id, version, blob_key, mime_type, width, height, bytes, sha256,
                                     updated_by)
       VALUES ($1, $2, $3, $4, 'image/webp', 100, 100, 7777, $5, $6)`,
      [
        w.board,
        DEV_STUDIO,
        'a'.repeat(24),
        `thumbnails/${DEV_STUDIO}/${w.board}/${'a'.repeat(24)}`,
        'c'.repeat(64),
        w.bob.userId,
      ],
    )
    const usage = await workspaceUsage(w.api.db, DEV_STUDIO)
    for (const tail of ['storage/by-board', 'storage/by-uploader']) {
      const res = await get(w.alice, tail)
      expect(res.statusCode, res.body).toBe(200)
      const body = AdminStorageResponse.parse(res.json())
      expect(body.total).toEqual({
        versions: usage.files,
        bytes: usage.used,
        quotaBytes: w.api.config.uploads.workspaceQuotaBytes,
      })
      expect(
        body.rows.reduce((s, r) => s + r.bytes, 0),
        tail,
      ).toBe(usage.used)
      expect(
        body.rows.reduce((s, r) => s + r.versions, 0),
        tail,
      ).toBe(usage.files)
      expect(body.fileTextBytes).toBe(0)
      // largest first
      expect(body.rows.map((r) => r.bytes)).toEqual([...body.rows.map((r) => r.bytes)].sort((a, b) => b - a))
    }
    const byBoard = AdminStorageResponse.parse((await get(w.alice, 'storage/by-board')).json())
    expect(byBoard.rows.map((r) => [r.board?.id, r.bytes])).toEqual([
      [second, 4_010_705],
      [w.board, 1_062_777],
    ])
    const byUploader = AdminStorageResponse.parse((await get(w.alice, 'storage/by-uploader')).json())
    expect(byUploader.rows.map((r) => [r.uploader?.id ?? null, r.bytes])).toEqual([
      [w.alice.userId, 4_060_000],
      [w.bob.userId, 1_005_000],
      [null, 7777],
      [w.carol.userId, 705],
    ])
  })

  it('audit: newest first by id; pages stay stable while rows are written; filters by action and person', async () => {
    const at = new Date()
    const write = (action: 'library.folder.create' | 'board.visibility', actorId: string | null, i: number) =>
      audit(w.api.db, {
        workspaceId: DEV_STUDIO,
        actorId,
        action,
        target: action === 'board.visibility' ? w.board : `workspace-${i}`,
        detail:
          action === 'board.visibility' ? { from: 'private', to: 'workspace_view' } : { scope: 'workspace' },
        at,
      })
    for (let i = 0; i < 230; i++)
      await write(i % 3 ? 'library.folder.create' : 'board.visibility', i % 2 ? w.bob.userId : null, i)
    // and a row of another workspace, never listed here
    await audit(w.api.db, {
      workspaceId: w.bob.personalWorkspaceId,
      actorId: w.bob.userId,
      action: 'board.create',
      target: 'other',
      at,
    })
    const all = await w.api.db.query<{ id: number }>(
      'SELECT id::float8 AS id FROM audit_events WHERE workspace_id = $1 ORDER BY id DESC',
      [DEV_STUDIO],
    )
    const expected = all.rows.map((r) => Number(r.id))
    const seen: number[] = []
    let before: number | null = null
    for (let page = 0; page < 10; page++) {
      const res = await get(w.alice, `audit${before === null ? '' : `?before=${before}`}`)
      expect(res.statusCode, res.body).toBe(200)
      const body = AdminAuditResponse.parse(res.json())
      seen.push(...body.events.map((e) => e.id))
      // someone acts while the admin reads: new rows go on top, never into a later page
      await write('library.folder.create', w.alice.userId, 1000 + page)
      before = body.nextBefore
      if (before === null) break
    }
    expect(seen).toEqual(expected)
    expect(new Set(seen).size).toBe(seen.length)

    const visibility = AdminAuditResponse.parse(
      (await get(w.alice, 'audit?action=board.visibility&limit=100')).json(),
    )
    expect(visibility.events.length).toBeGreaterThan(0)
    for (const e of visibility.events) {
      expect(e.action).toBe('board.visibility')
      expect(e.board).toEqual({ id: w.board, title: 'Client review' })
      expect(e.detail).toEqual({ from: 'private', to: 'workspace_view' })
    }
    const prefix = AdminAuditResponse.parse((await get(w.alice, 'audit?action=library.&limit=5')).json())
    expect(prefix.events.length).toBe(5)
    for (const e of prefix.events) expect(e.action.startsWith('library.')).toBe(true)
    const bobs = AdminAuditResponse.parse(
      (await get(w.alice, `audit?actor=${w.bob.userId}&limit=100`)).json(),
    )
    expect(bobs.events.length).toBeGreaterThan(0)
    for (const e of bobs.events) expect(e.actor?.id).toBe(w.bob.userId)
    // a malformed query is the caller's mistake (the admin is already known)
    expect((await get(w.alice, 'audit?limit=101')).statusCode).toBe(400)
    expect((await get(w.alice, 'audit?actor=nobody')).statusCode).toBe(400)
  })

  it('audit: a detail shows only its allowlist: never a URL, token, email, webhook hint, file or checkpoint name', async () => {
    const at = new Date()
    const rows: [Parameters<typeof audit>[1]['action'], object][] = [
      [
        'invitation.create',
        {
          boardId: w.board,
          role: 'viewer',
          emailLocked: true,
          emailDomain: 'client.example',
          url: 'https://lobby.example/invite/SECRETTOKEN',
          token: 'SECRETTOKEN',
        },
      ],
      [
        'chat_hook.create',
        { provider: 'slack', url: 'https://hooks.slack.com/services/T0/B0/SECRET', hint: '…CRET' },
      ],
      [
        'chat_hook.update',
        { changed: ['url', 'name'], url: 'https://hooks.slack.com/services/T0/B0/SECRET2' },
      ],
      [
        'asset.gc_delete',
        {
          boardId: w.board,
          name: 'Secret plan.pdf',
          kind: 'pdf',
          bytes: 1234,
          assetId: 'ast_0123456789abcdefghij',
        },
      ],
      [
        'board.checkpoint.delete',
        { snapshotId: 'snp_0123456789abcdefghij', name: 'Private checkpoint name', kind: 'manual' },
      ],
      [
        'board.member.put',
        { userId: w.carol.userId, role: 'https://evil.example/x', via: 'someone@client.example' },
      ],
      [
        'workspace.member.remove',
        { userId: w.bob.userId, linksKept: 2, linkIdsKept: ['inv_0123456789abcdefghij'] },
      ],
      [
        'comment.moderate_delete',
        { commentId: 'cmt_0123456789abcdefghij', authorId: w.bob.userId, body: 'Private words' },
      ],
    ]
    for (const [action, detail] of rows)
      await audit(w.api.db, {
        workspaceId: DEV_STUDIO,
        actorId: w.alice.userId,
        action,
        target: w.board,
        detail,
        at,
      })
    const res = await get(w.alice, 'audit?limit=20')
    expect(res.statusCode, res.body).toBe(200)
    for (const banned of [
      'http',
      'SECRET',
      '@',
      'client.example',
      'hooks.slack',
      'Secret plan',
      'Private checkpoint',
      'Private words',
      'inv_0123456789abcdefghij',
    ])
      expect(res.body, banned).not.toContain(banned)
    const body = AdminAuditResponse.parse(res.json())
    const of = (action: string) => body.events.find((e) => e.action === action)?.detail
    expect(of('invitation.create')).toEqual({ boardId: 'Client review', role: 'viewer', emailLocked: true })
    expect(of('chat_hook.create')).toEqual({ provider: 'slack' })
    expect(of('chat_hook.update')).toEqual({ changed: 2 })
    expect(of('asset.gc_delete')).toEqual({
      boardId: 'Client review',
      kind: 'pdf',
      bytes: 1234,
      assetId: 'ast_0123456789abcdefghij',
    })
    expect(of('board.checkpoint.delete')).toEqual({ snapshotId: 'snp_0123456789abcdefghij', kind: 'manual' })
    // a value that fails its kind's check is left out, not shown as it is; a person is shown by name
    expect(of('board.member.put')).toEqual({ userId: 'carol' })
    expect(of('workspace.member.remove')).toEqual({ userId: 'bob', linksKept: 2 })
    expect(of('comment.moderate_delete')).toEqual({ commentId: 'cmt_0123456789abcdefghij', authorId: 'bob' })
  })

  it('links: equal to the per-board lists; revoking from the admin page is the Share dialog revoke; a guest is taken off a board', async () => {
    const review = await guestLink(w.bob, w.board, { role: 'commenter' })
    const workshop = await guestLink(w.bob, w.board, { role: 'editor' })
    const second = await createBoard(w.alice, DEV_STUDIO, 'Workshop day')
    const third = await guestLink(w.alice, second, { role: 'viewer', allowGuests: false, maxUses: 5 })
    const sam = await joinAsGuest(w.api, review.url, 'Sam')
    const kim = await joinAsGuest(w.api, workshop.url, 'Kim')

    const res = await get(w.alice, 'links')
    expect(res.statusCode, res.body).toBe(200)
    const body = AdminLinksResponse.parse(res.json())
    // the same rows as each board's Share dialog list
    for (const [board, by] of [
      [w.board, w.bob],
      [second, w.alice],
    ] as const) {
      const share = await by.req('GET', `/api/boards/${board}/invitations`)
      const ids = (share.json().invitations as { id: string; kind: string }[])
        .filter((i) => i.kind === 'review')
        .map((i) => i.id)
        .sort()
      expect(
        body.links
          .filter((l) => l.board.id === board)
          .map((l) => l.id)
          .sort(),
        board,
      ).toEqual(ids)
    }
    const row = (id: string) => body.links.find((l) => l.id === id)
    expect(row(review.id)).toMatchObject({
      kind: 'review',
      role: 'commenter',
      allowGuests: true,
      hasJoinCode: false,
      uses: 1,
    })
    expect(row(workshop.id)).toMatchObject({ kind: 'workshop', role: 'editor' })
    expect(row(third.id)).toMatchObject({ kind: 'review', allowGuests: false, maxUses: 5, uses: 0 })
    expect(row(review.id)?.createdBy?.id).toBe(w.bob.userId)
    // never a token or a URL
    for (const l of [review, workshop, third]) expect(res.body).not.toContain(tokenOf(l.url))
    expect(res.body).not.toContain('/invite/')
    // the name-only guests, with the boards they hold
    expect(body.guests.map((g) => g.user.id).sort()).toEqual([sam.userId, kim.userId].sort())
    expect(body.guests.find((g) => g.user.id === sam.userId)).toMatchObject({
      grants: 1,
      boards: [{ id: w.board, title: 'Client review' }],
    })

    // alice (the workspace owner, no grant of her own on bob's board) revokes the review link the Share dialog's way,
    // removing the people who joined through it
    const revoked = await w.alice.req('POST', `/api/boards/${w.board}/review-links/${review.id}/revoke`, {
      removeAccess: true,
    })
    expect(revoked.statusCode, revoked.body).toBe(200)
    expect(revoked.json()).toEqual({ removed: 1 })
    // and takes kim off the board the existing way
    const off = await w.alice.req('DELETE', `/api/boards/${w.board}/members/${kim.userId}`)
    expect(off.statusCode, off.body).toBe(200)

    const after = AdminLinksResponse.parse((await get(w.alice, 'links')).json())
    expect(after.links.map((l) => l.id).sort()).toEqual([workshop.id, third.id].sort())
    expect(after.guests).toEqual([])
    const share = await w.bob.req('GET', `/api/boards/${w.board}/invitations`)
    expect((share.json().invitations as { id: string }[]).map((i) => i.id)).not.toContain(review.id)
    expect((await sam.req('GET', `/api/boards/${w.board}`)).statusCode).not.toBe(200)
    // the audit log says who did it, as for any revoke
    const log = AdminAuditResponse.parse((await get(w.alice, 'audit?action=invitation.revoke')).json())
    expect(log.events[0]).toMatchObject({ actor: { id: w.alice.userId }, board: { id: w.board } })
  })

  it('invitations: page 1 (100) and page 2 of 150, no duplicate or gap, also when invitations are made between the calls', async () => {
    await seedInvitations('I', 150)
    const expected = await seededOrder("i.id LIKE 'inv_seedI%'")
    expect(expected).toHaveLength(150)
    const first = AdminInvitationsResponse.parse((await get(w.alice, 'invitations')).json())
    expect(first.invitations).toHaveLength(ADMIN_LIMITS.pageSize)
    expect(first.more).toBe(true)
    expect(typeof first.next).toBe('string')
    // someone sends five more while the admin reads: they go on top, never into page 2
    await seedInvitations('J', 5, 1000)
    const res = await get(w.alice, `invitations?before=${encodeURIComponent(first.next ?? '')}`)
    expect(res.statusCode, res.body).toBe(200)
    const second = AdminInvitationsResponse.parse(res.json())
    expect(second.more).toBe(false)
    expect(second.next).toBeNull()
    const seen = [...first.invitations, ...second.invitations].map((i) => i.id)
    expect(seen).toEqual(expected)
    expect(new Set(seen).size).toBe(150)
    // the newest page now starts with the five made meanwhile
    const again = AdminInvitationsResponse.parse((await get(w.alice, 'invitations')).json())
    expect(again.invitations.slice(0, 5).every((i) => i.id.startsWith('inv_seedJ'))).toBe(true)
    // only the hint ever: never an address
    expect(res.body).not.toMatch(/p\d+@client/)
    expect(second.invitations[0]?.emailHint).toBe('p•••@client.example')
  })

  it('links and guests: each list pages apart past 100, stable while links and guests are added between the calls', async () => {
    await seedLinks('L', 150)
    await seedGuests('G', 150)
    const expectedLinks = await seededOrder("i.id LIKE 'inv_seedL%'")
    const expectedGuests = (
      await w.api.db.query<{ id: string }>(
        `SELECT wm.user_id AS id FROM workspace_members wm
          WHERE wm.workspace_id = $1 AND wm.user_id LIKE 'usr_seedG%'
          ORDER BY wm.created_at DESC, wm.user_id DESC`,
        [DEV_STUDIO],
      )
    ).rows.map((r) => r.id)
    const first = AdminLinksResponse.parse((await get(w.alice, 'links')).json())
    expect(first.links).toHaveLength(ADMIN_LIMITS.pageSize)
    expect(first.guests).toHaveLength(ADMIN_LIMITS.pageSize)
    expect(first.more).toBe(true)
    expect(typeof first.nextLinks).toBe('string')
    expect(typeof first.nextGuests).toBe('string')
    // a link is made and a guest joins while the admin reads
    await seedLinks('M', 3, 1000)
    await seedGuests('H', 3, 1000)
    const links2 = AdminLinksResponse.parse(
      (await get(w.alice, `links?linksBefore=${encodeURIComponent(first.nextLinks ?? '')}`)).json(),
    )
    // only the list given a cursor is read
    expect(links2.guests).toEqual([])
    expect(links2.nextGuests).toBeNull()
    expect(links2.nextLinks).toBeNull()
    expect(links2.more).toBe(false)
    const seenLinks = [...first.links, ...links2.links].map((l) => l.id)
    expect(seenLinks).toEqual(expectedLinks)
    expect(new Set(seenLinks).size).toBe(150)
    const guests2 = AdminLinksResponse.parse(
      (await get(w.alice, `links?guestsBefore=${encodeURIComponent(first.nextGuests ?? '')}`)).json(),
    )
    expect(guests2.links).toEqual([])
    expect(guests2.nextLinks).toBeNull()
    expect(guests2.nextGuests).toBeNull()
    const seenGuests = [...first.guests, ...guests2.guests].map((g) => g.user.id)
    expect(seenGuests).toEqual(expectedGuests)
    expect(new Set(seenGuests).size).toBe(150)
    // each paged guest still names its board
    expect(guests2.guests[0]?.boards).toEqual([{ id: w.board, title: 'Client review' }])
    // both cursors at once: both lists go on
    const both = AdminLinksResponse.parse(
      (
        await get(
          w.alice,
          `links?linksBefore=${encodeURIComponent(first.nextLinks ?? '')}&guestsBefore=${encodeURIComponent(first.nextGuests ?? '')}`,
        )
      ).json(),
    )
    expect(both.links.map((l) => l.id)).toEqual(links2.links.map((l) => l.id))
    expect(both.guests.map((g) => g.user.id)).toEqual(guests2.guests.map((g) => g.user.id))
  })

  it('a malformed cursor is the caller mistake (400 for an owner); a cursor of the right form that matches no row ends the list', async () => {
    for (const tail of [
      'invitations?before=nonsense',
      'invitations?before=12.inv_short',
      'invitations?before=1792400000123456.brd_0123456789abcdefghij',
      'invitations?before=-5.inv_0123456789abcdefghij',
      'links?linksBefore=1792400000123456',
      'links?guestsBefore=x.usr_0123456789abcdefghij',
    ]) {
      const res = await get(w.alice, tail)
      expect(res.statusCode, `${tail}: ${res.body}`).toBe(400)
    }
    w.api.clock.advance(ADMIN_LIMITS.rate.timeWindow + 1)
    // the oldest possible time: nothing is older
    const none = AdminInvitationsResponse.parse(
      (await get(w.alice, 'invitations?before=0.inv_0123456789abcdefghij')).json(),
    )
    expect(none).toEqual({ invitations: [], more: false, next: null })
  })

  it('retention: read-only facts, every documented id, nothing that deletes', async () => {
    const res = await get(w.alice, 'retention')
    expect(res.statusCode, res.body).toBe(200)
    const body = AdminRetentionResponse.parse(res.json())
    expect(body.facts.map((f) => f.id)).toEqual([...ADMIN_RETENTION_FACT_IDS])
    const fact = (id: string) => body.facts.find((f) => f.id === id)
    expect(fact('trash')?.value).toMatch(/Kept until restored/)
    expect(fact('checkpoints.hourly')?.value).toBe('One an hour for 48 hours')
    expect(fact('asset-gc')).toMatchObject({ source: 'env', value: expect.stringMatching(/never deleted/) })
    expect(fact('visits')?.value).toBe('180 days')
    expect(fact('board.backups')?.source).toBe('documented')
    // the admin routes are GET only: none of them can change anything
    for (const key of ROUTES) expect(key.startsWith('GET ')).toBe(true)
  })
})
