// The creation matrix (docs/DOMAIN-ACCESS-CONTRACTS.md §4.2, §11.1 creation-matrix.test.ts): every
// CREATOR_ROUTES entry with refuse 'always' is refused for an account that is not a creator, by the
// root guard AND (with the guard switched off) by the in-route checks alone; nothing is created; the
// answer does not depend on the id; creators still create; tenancy and guests are unchanged; and a
// source tripwire fails when a new creation or raise site appears in apps/api/src.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAKE_MIRO_TOKEN, type FakeMiro, startFakeMiro } from '@draftroom/miro-import/fake-miro'
import { RETRO_ID } from '@draftroom/miro-import/fixtures'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type FakeReceiver,
  slackHookUrl,
  startFakeReceiver,
} from '../../../../../e2e/tests/support/chat-hooks.ts'
import { CREATOR_ROUTES } from '../../../src/features/domain-access/guard.ts'
import { importRunnerOf } from '../../../src/features/imports/index.ts'
import { isPendingRoute } from '../../../src/features/pending-routes.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from '../../helpers.ts'
import { makeBackup } from '../backup/support.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from '../history/helpers.ts'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
/** Wave R's job id in the probes: a paused Miro job of alice's (WS1: resume is live). */
const IMPORT_JOB = 'imp_0123456789abcdefghij'
/** The calls that start work and answer 202 (WS1: a Miro import and a resume; WS4: a backup restore). */
const ACCEPTED = new Set([
  'POST /api/workspaces/:wid/imports/miro',
  'POST /api/imports/:id/resume',
  'POST /api/workspaces/:wid/backups',
])
/** The api's webhook key in these tests (chat hooks are off without it) */
const WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdefghij'
/** a valid, empty .lobby backup (wave R, WS4): a creator's restore of it is a 202 */
const BACKUP = await makeBackup()
const ALWAYS = Object.entries(CREATOR_ROUTES)
  .filter(([, r]) => r.refuse === 'always')
  .map(([key]) => key)
/**
 * The 'always' routes that are registered. A wave M route still pending (src/features/pending-routes.ts) is not
 * registered yet and answers as an unknown route (the last test below); once its owner implements it and removes it
 * from PENDING_ROUTES, every check here covers it.
 */
const LIVE = ALWAYS.filter((key) => !isPendingRoute(key))

interface World {
  api: TestApi
  /** the fake Slack: a chat hook's test message goes here, never to the real service */
  receiver: FakeReceiver
  /** a chat hook of Dev Studio, on the fake receiver */
  hook: string
  /** the fake Miro the import routes reach (DRAFTROOM_MIRO_TEST_ORIGINS) */
  miro: FakeMiro
  sync: FakeSync
  logs: Record<string, unknown>[]
  alice: Client // Dev Studio owner, a creator (dev)
  bob: Client // Dev Studio member, a creator
  outsider: Client // a Dev Studio ADMIN (a pre-existing role) who is not a creator, and owner of `board`
  member: Client // a Dev Studio member who is not a creator
  erin: Client // a creator outside Dev Studio
  board: string
  project: string
  snapshot: string
  link: string
  request: string
  archive: unknown
}

async function world(opts: { guard?: boolean } = {}): Promise<World> {
  const sync = createFakeSync()
  const logs: Record<string, unknown>[] = []
  const receiver = await startFakeReceiver()
  const miro = await startFakeMiro()
  const api = await createTestApi({
    ...(opts.guard === false ? { domainAccessGuard: false } : {}),
    env: {
      DRAFTROOM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      DRAFTROOM_CHAT_HOOK_TEST_ORIGINS: receiver.origin,
      DRAFTROOM_MIRO_TEST_ORIGINS: `${miro.api},${miro.files}`,
    },
    deps: {
      syncInternal: sync,
      logger: { level: 'info', stream: { write: (l: string) => void logs.push(JSON.parse(l)) } },
    },
  })
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  const outsider = await api.login('pat', 'Pat', { email: 'pat@client.example.test' })
  const member = await api.login('sam', 'Sam', { email: 'sam@client.example.test' })
  await api.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'admin', now()), ($1, $3, 'member', now())`,
    [DEV_STUDIO, outsider.userId, member.userId],
  )
  const board = await createBoard(alice, DEV_STUDIO, 'Matrix board')
  const hookRes = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/chat-hooks`, {
    name: '#matrix',
    provider: 'slack',
    url: slackHookUrl(receiver.origin),
  })
  expect(hookRes.statusCode).toBe(201)
  const hook = hookRes.json().id as string
  sync.setBoard(board, [...baseRecords(), noteRec('n1', 'content')])
  for (const u of [outsider, member])
    await api.db.query(
      `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $3, now())`,
      [board, u.userId, alice.userId],
    )
  const project = (
    await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Lobby' })
  ).json().id as string
  const snapshot = (await alice.req('POST', `/api/boards/${board}/snapshots`, { name: 'v1' })).json()
    .id as string
  const link = (await alice.req('POST', `/api/boards/${board}/review-links`, { role: 'viewer' })).json()
    .id as string
  // the client link limited copying to editors (DANA2-01); its owner lets everyone copy again, so the board may be
  // a workspace template (ws-templates refuses a board limited to its editors)
  expect(
    (await alice.req('PUT', `/api/boards/${board}/export-policy`, { exportPolicy: 'everyone' })).statusCode,
  ).toBe(200)
  expect(
    (await carol.req('POST', `/api/boards/${board}/access-requests`, { role: 'viewer' })).statusCode,
  ).toBe(202)
  const request = (await api.db.one<{ id: string }>('SELECT id FROM access_requests')).id
  const archive = (await alice.req('GET', `/api/boards/${board}/export`)).json()
  // a paused Miro job of alice's, for the resume probe (WS1)
  await api.db.query(
    `INSERT INTO board_imports (id, batch_id, workspace_id, created_by, source, source_ref, title, position, status,
                                progress, created_at, updated_at)
     VALUES ('imb_0123456789abcdefghij', $1, $2, $3, 'miro', $4, 'Retro', 0, 'paused', '{}'::jsonb, now(), now())`,
    [IMPORT_JOB, DEV_STUDIO, alice.userId, RETRO_ID],
  )
  sync.seeds.length = 0
  sync.snapshots.length = 0
  logs.length = 0
  return {
    miro,
    api,
    receiver,
    hook,
    sync,
    logs,
    alice,
    bob,
    outsider,
    member,
    erin,
    board,
    project,
    snapshot,
    link,
    request,
    archive,
  }
}

/** The request each CREATOR_ROUTES 'always' key is probed with (ids replaceable for the uniform check). */
function probe(
  w: World,
  key: string,
  ids: Partial<Record<'wid' | 'bid' | 'pid' | 'sid' | 'id' | 'rid', string>> = {},
): [Method, string, unknown] {
  const wid = ids.wid ?? DEV_STUDIO
  const bid = ids.bid ?? w.board
  const pid = ids.pid ?? w.project
  const sid = ids.sid ?? w.snapshot
  const link = ids.id ?? w.link
  const rid = ids.rid ?? w.request
  const table: Record<string, [Method, string, unknown]> = {
    'POST /api/workspaces/:wid/boards': ['POST', `/api/workspaces/${wid}/boards`, { title: 'New' }],
    'POST /api/workspaces/:wid/projects': ['POST', `/api/workspaces/${wid}/projects`, { name: 'New' }],
    'PATCH /api/projects/:pid': ['PATCH', `/api/projects/${pid}`, { name: 'Renamed' }],
    'POST /api/workspaces/:wid/boards/import': ['POST', `/api/workspaces/${wid}/boards/import`, w.archive],
    'POST /api/boards/:bid/duplicate': ['POST', `/api/boards/${bid}/duplicate`, {}],
    'POST /api/snapshots/:sid/restore-as-new': ['POST', `/api/snapshots/${sid}/restore-as-new`, {}],
    'POST /api/workspaces/:wid/invitations': [
      'POST',
      `/api/workspaces/${wid}/invitations`,
      { role: 'member', email: devEmail('newcomer') },
    ],
    'POST /api/boards/:bid/invitations': [
      'POST',
      `/api/boards/${bid}/invitations`,
      { role: 'viewer', email: 'newcomer@client.example.test' },
    ],
    'POST /api/boards/:bid/invitations/email': [
      'POST',
      `/api/boards/${bid}/invitations/email`,
      { role: 'viewer', email: 'newcomer@client.example.test' },
    ],
    'POST /api/boards/:bid/review-links': ['POST', `/api/boards/${bid}/review-links`, { role: 'viewer' }],
    'POST /api/boards/:bid/review-links/:id/extend': [
      'POST',
      `/api/boards/${bid}/review-links/${link}/extend`,
      { hours: 1 },
    ],
    'POST /api/access-requests/:id/approve': ['POST', `/api/access-requests/${rid}/approve`, {}],
    'POST /api/boards/:bid/transfer-ownership': [
      'POST',
      `/api/boards/${bid}/transfer-ownership`,
      { userId: w.bob.userId },
    ],
    // wave M (M8-3, W8): workspace templates
    'POST /api/workspaces/:wid/templates': [
      'POST',
      `/api/workspaces/${wid}/templates`,
      { boardId: bid, name: 'Our retro', category: 'review' },
    ],
    'DELETE /api/workspaces/:wid/templates/:bid': [
      'DELETE',
      `/api/workspaces/${wid}/templates/${bid}`,
      undefined,
    ],
    'POST /api/workspaces/:wid/templates/:bid/use': [
      'POST',
      `/api/workspaces/${wid}/templates/${bid}/use`,
      {},
    ],
    // wave R: WS1 (Miro, resume), WS4 (a backup restore), WS2 (chat hooks)
    'POST /api/workspaces/:wid/imports/miro/boards': [
      'POST',
      `/api/workspaces/${wid}/imports/miro/boards`,
      { token: FAKE_MIRO_TOKEN },
    ],
    'POST /api/workspaces/:wid/imports/miro': [
      'POST',
      `/api/workspaces/${wid}/imports/miro`,
      { token: FAKE_MIRO_TOKEN, boards: [{ miroBoardId: RETRO_ID }] },
    ],
    'POST /api/imports/:id/resume': ['POST', `/api/imports/${IMPORT_JOB}/resume`, { token: FAKE_MIRO_TOKEN }],
    'POST /api/workspaces/:wid/backups': ['POST', `/api/workspaces/${wid}/backups`, BACKUP],
    'GET /api/workspaces/:wid/chat-hooks': ['GET', `/api/workspaces/${wid}/chat-hooks`, undefined],
    'POST /api/workspaces/:wid/chat-hooks': [
      'POST',
      `/api/workspaces/${wid}/chat-hooks`,
      { name: '#lobby', provider: 'slack', url: 'https://hooks.slack.com/services/T1/B1/abc' },
    ],
    'PATCH /api/workspaces/:wid/chat-hooks/:hid': [
      'PATCH',
      `/api/workspaces/${wid}/chat-hooks/${w.hook}`,
      { name: '#renamed' },
    ],
    'POST /api/workspaces/:wid/chat-hooks/:hid/test': [
      'POST',
      `/api/workspaces/${wid}/chat-hooks/${w.hook}/test`,
      {},
    ],
    // wave V (WS3): a workshop link's join code (the probe's link is a viewer link: WS3 makes an editor one when it
    // implements the route)
    'POST /api/boards/:bid/review-links/:id/code': [
      'POST',
      `/api/boards/${bid}/review-links/${link}/code`,
      undefined,
    ],
  }
  const found = table[key]
  if (!found) throw new Error(`no probe for ${key}`)
  return found
}

const NONEXISTENT = {
  wid: 'wsp_Nonexistent0000000000',
  bid: 'b-nonexistent',
  pid: 'prj_Nonexistent0000000000',
  sid: 'snp_Nonexistent0000000000',
  id: 'inv_Nonexistent0000000000',
  rid: 'acr_Nonexistent0000000000',
}

async function counts(api: TestApi) {
  const n = async (sql: string) =>
    (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).n
  return {
    boards: await n('boards'),
    projects: await n('projects'),
    workspaces: await n('workspaces'),
    invitations: await n('invitations'),
    snapshots: await n('board_snapshots'),
    boardCreate: await n("audit_events WHERE action = 'board.create'"),
    boardMembers: await n('board_members'),
    workspaceMembers: await n('workspace_members'),
    projectNames: (await api.db.query<{ name: string }>('SELECT name FROM projects ORDER BY id')).rows,
    linkExpiry: (await api.db.query<{ e: Date }>('SELECT expires_at AS e FROM invitations WHERE multi_use'))
      .rows,
    requests: (await api.db.query<{ status: string }>('SELECT status FROM access_requests')).rows,
  }
}

const expectCreatorRequired = (res: LightMyRequestResponse, what: string) => {
  expect(res.statusCode, `${what}: ${res.body}`).toBe(403)
  expect(res.json().error.code, what).toBe('CREATOR_REQUIRED')
}

let w: World
afterEach(async () => {
  await w?.api.close()
  await w?.receiver.close()
  await w?.miro.close()
})

describe('the creation matrix', () => {
  it('every CREATOR_ROUTES key is a registered route, or a pending one that is not (and the table has a probe for each "always" key)', async () => {
    w = await world()
    for (const key of Object.keys(CREATOR_ROUTES)) {
      const [method, url] = key.split(' ') as [Method, string]
      expect(w.api.app.hasRoute({ method, url }), key).toBe(!isPendingRoute(key))
    }
    for (const key of ALWAYS) expect(() => probe(w, key)).not.toThrow()
    // 13 until wave M, the three workspace-template routes (M8-3), wave R's eight (four that make boards: Miro's
    // two, resume, a backup restore; four that manage chat hooks), and wave V's join code (a link's access)
    expect(ALWAYS).toHaveLength(25)
  })

  it('the guard: an outsider (workspace admin, board owner) gets 403 CREATOR_REQUIRED everywhere, logged "by guard"; nothing is created', async () => {
    w = await world()
    const before = await counts(w.api)
    for (const who of [w.outsider, w.member]) {
      for (const key of LIVE) {
        const [method, url, body] = probe(w, key)
        w.logs.length = 0
        expectCreatorRequired(await who.req(method, url, body), key)
        const refusal = w.logs.find((l) => l.evt === 'creator.refused')
        expect(refusal, key).toMatchObject({
          userId: who.userId,
          route: key.split(' ')[1],
          by: 'guard',
          reason: 'outside',
          purpose: CREATOR_ROUTES[key]?.purpose,
          emailDomains: ['client.example.test'],
        })
      }
    }
    expect(await counts(w.api)).toEqual(before)
    expect(w.sync.seeds).toEqual([])
    expect(w.sync.snapshots).toEqual([])
  })

  it('the same 403 for ids that do not exist (the answer depends only on the caller)', async () => {
    w = await world()
    for (const key of LIVE) {
      const [method, url, body] = probe(w, key, NONEXISTENT)
      expectCreatorRequired(await w.outsider.req(method, url, body), `${key} (nonexistent)`)
    }
  })

  it('without the guard, the in-route checks alone refuse every entry ("by route"); nothing is created', async () => {
    w = await world({ guard: false })
    const before = await counts(w.api)
    for (const key of LIVE) {
      const [method, url, body] = probe(w, key)
      w.logs.length = 0
      expectCreatorRequired(await w.outsider.req(method, url, body), key)
      const refusals = w.logs.filter((l) => l.evt === 'creator.refused')
      expect(refusals.length, key).toBeGreaterThan(0)
      for (const r of refusals) expect(r, key).toMatchObject({ userId: w.outsider.userId, by: 'route' })
    }
    expect(await counts(w.api)).toEqual(before)
    expect(w.sync.seeds).toEqual([])
    expect(w.sync.snapshots).toEqual([])
  })

  it('a creator gets 201/200 on the same calls (204 only for a DELETE)', async () => {
    w = await world()
    // The DELETE rows last: wave M's template removal (M8-3) removes what the use row before it starts from.
    const deletesLast = [...LIVE].sort(
      (a, b) => Number(a.startsWith('DELETE ')) - Number(b.startsWith('DELETE ')),
    )
    for (const key of deletesLast) {
      const [method, url, body] = probe(w, key)
      const res = await w.alice.req(method, url, body)
      // A create or share call that answers 204 created nothing, so only a DELETE row (wave M's template removal,
      // M8-3) may answer 204, and it must; a call that starts a job (wave R) answers 202.
      const ok = key.startsWith('DELETE ') ? [204] : ACCEPTED.has(key) ? [202] : [200, 201]
      expect(ok, `${key}: ${res.statusCode} ${res.body}`).toContain(res.statusCode)
      // a job it started runs to its end before the next call (one unfinished job per person)
      await importRunnerOf(w.api.app)?.idle()
    }
  })

  it('tenancy is unchanged: a creator outside the workspace gets 404 on its ids', async () => {
    w = await world()
    for (const key of LIVE) {
      const [method, url, body] = probe(w, key)
      const res = await w.erin.req(method, url, body)
      expect(res.statusCode, `${key}: ${res.body}`).toBe(404)
    }
  })

  it('name-only guests still get GUEST_ACCOUNT_REQUIRED', async () => {
    w = await world()
    const link = (
      await w.alice.req('POST', `/api/boards/${w.board}/review-links`, {
        role: 'commenter',
        allowGuests: true,
      })
    ).json() as { url: string }
    const joined = await w.api.anon('POST', `/api/invitations/${link.url.split('/').pop()}/guest`, {
      name: 'Gia',
    })
    expect(joined.statusCode, joined.body).toBe(201)
    const cookie = `dr_session=${joined.cookies.find((c) => c.name === 'dr_session')?.value}`
    for (const key of LIVE) {
      const [method, url, body] = probe(w, key)
      const res = await w.api.anon(method, url, body, { cookie })
      expect(res.statusCode, `${key}: ${res.body}`).toBe(403)
      expect(res.json().error.code, key).toBe('GUEST_ACCOUNT_REQUIRED')
    }
  })

  it('a pending wave M creator route is not registered yet: the unknown route answer for everyone, nothing created', async () => {
    w = await world()
    const pending = ALWAYS.filter((key) => isPendingRoute(key))
    expect(pending.length + LIVE.length).toBe(ALWAYS.length)
    const before = await counts(w.api)
    for (const key of pending) {
      const [method, url, body] = probe(w, key)
      for (const who of [w.alice, w.outsider, w.erin]) {
        const res = await who.req(method, url, body)
        expect(res.statusCode, `${key}: ${res.body}`).toBe(404)
        expect(res.json(), key).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
      }
    }
    expect(await counts(w.api)).toEqual(before)
    expect(w.sync.seeds).toEqual([])
  })
})

// ---- the source tripwire ------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url))

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

// A table name as SQL may spell it: optionally schema-qualified, optionally double-quoted.
const name = (tables: string) => `(?:"?public"?\\s*\\.\\s*)?"?(${tables})"?`
const INSERT_RE = new RegExp(
  `INSERT\\s+INTO\\s+${name('workspaces|projects|boards|invitations|board_members|workspace_members')}(?=[\\s(])`,
  'gi',
)
const UPDATE_RE = new RegExp(
  `UPDATE\\s+${name('invitations|boards|board_members|workspace_members')}(?:\\s+(?:AS\\s+)?(?!SET\\b)\\w+)?\\s+SET\\s+([\\s\\S]*?)(?:\\bWHERE\\b|\\bFROM\\b|\\bRETURNING\\b|[\`'"]\\s*[,)])`,
  'gi',
)
const RAISES: Record<string, RegExp> = {
  invitations: /\b(role|expires_at)\s*=/i,
  boards: /\bvisibility\s*=/i,
  board_members: /\brole\s*=/i,
  workspace_members: /\brole\s*=/i,
}

/**
 * Every site, reviewed one by one (docs/DOMAIN-ACCESS-CONTRACTS.md §14 item 1): each is behind
 * requireCreator, is a lowering path, or is sign-in provisioning of a creator. A new site fails this
 * test until it is gated and listed here.
 */
const ALLOWED_INSERTS: Record<string, number> = {
  // sign-in provisioning, creators only (users.ts ensurePersonalWorkspace; dev.ts Dev Studio for new creators)
  'auth/users.ts workspaces': 1,
  'auth/users.ts workspace_members': 1,
  'auth/dev.ts workspaces': 1,
  'auth/dev.ts workspace_members': 1,
  // open email sign-in only (docs/OPEN-SIGNIN.md, AUTH_PROVIDER=email + DRAFTROOM_OPEN_SIGNIN=1, where every
  // account is a creator): the shared workspace, its built-in owner, and each signed-in account as a member
  'auth/shared-workspace.ts workspaces': 1,
  'auth/shared-workspace.ts workspace_members': 2,
  // open email sign-in only: partner boards (Bearer DRAFTROOM_PARTNER_TOKEN, no session), owned by the
  // shared workspace's built-in owner
  'routes/partner.ts boards': 1,
  'routes/partner.ts board_members': 1,
  // gated: POST /api/workspaces/:wid/boards (the board and its creator's owner grant)
  'routes/boards.ts boards': 1,
  'routes/boards.ts board_members': 1,
  // gated: POST /api/workspaces/:wid/projects
  'routes/workspaces.ts projects': 1,
  // gated: createInvitation; redeemInvitation only redeems a creator's (locked or multi-use) invitation
  'routes/invitations.ts invitations': 1,
  'routes/invitations.ts workspace_members': 2,
  'routes/invitations.ts board_members': 1,
  // PUT members: raising and adding gated in-route; lowering open
  'routes/members.ts board_members': 1,
  // gated: approve
  'features/dashboard/access-requests.ts workspace_members': 1,
  'features/dashboard/access-requests.ts board_members': 1,
  // gated: the email route's grant
  'features/dashboard/email-invites.ts workspace_members': 1,
  'features/dashboard/email-invites.ts board_members': 1,
  // gated: review, workshop and guest links
  'features/dashboard/review-links.ts invitations': 1,
  // gated: transfer of ownership (caller and target creators)
  'features/dashboard/sharing.ts board_members': 1,
  // gated: createBoardFrom (restore, duplicate, import): the board, its owner, keep-sharing (capped at editor)
  'features/history/new-board.ts boards': 1,
  'features/history/new-board.ts board_members': 2,
  // gated: an import job's board (wave R, features/imports/finalize.ts createImportingBoard: the workspace row, the
  // creating role and requireCreator, as createBoardFrom; again at activation) and its creator's owner grant
  'features/imports/finalize.ts boards': 1,
  'features/imports/finalize.ts board_members': 1,
}
const ALLOWED_RAISES: Record<string, number> = {
  // gated: "+1 h" (extend)
  'features/dashboard/review-links.ts invitations': 1,
  // lowering: an expired or revoked link's grants go back
  'features/dashboard/review-links.ts board_members': 1,
  // lowering: transfer steps the caller's own owner grant down to editor
  'features/dashboard/sharing.ts board_members': 1,
  // PATCH visibility: raising gated in-route; lowering open
  'routes/boards.ts boards': 1,
  // lowering: a keep-sharing copy in an internal-only scope is made private (wave J pre-deploy review IO-2a)
  'features/history/new-board.ts boards': 1,
  // authz-006 PATCH workspace members: raising gated in-route (a creator caller; admin and owner only for a
  // creator target); lowering open
  'routes/workspaces.ts workspace_members': 1,
}

describe('source tripwire (apps/api/src)', () => {
  it('the patterns tolerate newlines, AS aliases, quoted and schema-qualified names', () => {
    const sample = [
      'INSERT INTO\n  public.boards (id)',
      'insert into "board_members" AS bm (board_id)',
      'INSERT INTO "public"."workspace_members"(workspace_id)',
      "UPDATE board_members bm\n   SET role = 'editor' WHERE x",
      'UPDATE public.invitations AS i SET expires_at = $2 WHERE id = $1',
      'UPDATE "boards" SET title = $2, visibility = $3 RETURNING id',
      'UPDATE invitations SET revoked_at = $2 WHERE id = $1',
    ].join('\n;\n')
    expect([...sample.matchAll(INSERT_RE)].map((m) => m[1]?.toLowerCase())).toEqual([
      'boards',
      'board_members',
      'workspace_members',
    ])
    const raised = [...sample.matchAll(UPDATE_RE)]
      .filter((m) => RAISES[m[1]?.toLowerCase() ?? '']?.test(m[2] ?? ''))
      .map((m) => m[1]?.toLowerCase())
    expect(raised).toEqual(['board_members', 'invitations', 'boards'])
  })

  it('every INSERT into an access table and every raising UPDATE is a reviewed, gated site', () => {
    const inserts: Record<string, number> = {}
    const raises: Record<string, number> = {}
    for (const { file, text } of sources(SRC)) {
      for (const m of text.matchAll(INSERT_RE)) {
        const k = `${file} ${m[1]?.toLowerCase()}`
        inserts[k] = (inserts[k] ?? 0) + 1
      }
      for (const m of text.matchAll(UPDATE_RE)) {
        const table = m[1]?.toLowerCase() ?? ''
        if (!RAISES[table]?.test(m[2] ?? '')) continue
        const k = `${file} ${table}`
        raises[k] = (raises[k] ?? 0) + 1
      }
    }
    expect(inserts).toEqual(ALLOWED_INSERTS)
    expect(raises).toEqual(ALLOWED_RAISES)
  })
})
