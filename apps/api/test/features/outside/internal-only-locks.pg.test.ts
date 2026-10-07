// The "Internal only" switches' locks on a real Postgres (PGlite has one connection, so two transactions
// never wait for each other there): set DRAFTROOM_TEST_DATABASE_URL to a database these tests may create and
// drop schemas in. Skipped otherwise. The decisions themselves are tested on PGlite in internal-only*.test.ts.
//
// IO-1, IO-2 and IO-3 (wave J pre-deploy review) decide the switch inside each route's transaction under the
// workspace row lock the switch takes (routes/workspaces.ts setSwitch: the workspace row FOR NO KEY UPDATE,
// then the project row), before the board row (access.ts, step 0 before step 1; outside.ts
// lockBoardWorkspace). Those paths had never run with more than one connection. Each test below races the
// REAL routes against a switch change (or a move) on separate connections, many rounds, and checks two
// things:
//   1. no deadlock: nothing answers 5xx (a 40P01 is a 500), and every answer is one the route may give;
//   2. the rule: nobody outside (a non-creator account, a name-only guest) gets NEW access in a scope whose
//      switch was on when their grant committed, and a board leaves an internal-only project only through
//      someone who may turn the switch off.
// (2) is checked by the database itself, at the moment each transaction commits: deferred constraint
// triggers (installed in this test's own schema only; `watch` below) fire at COMMIT, inside the committing
// transaction, and read the switches as committed at that instant (READ COMMITTED: every statement of a
// volatile function takes a new snapshot). A grant whose transaction decided on a switch read before the
// switch's commit, and committed after it, is seen there with the switch on and recorded. A recorded row is
// therefore a real break (the switch had committed before this grant did); the only thing the trigger can
// miss is a switch that commits in the instant between the trigger and the grant's own commit record.
//
// What each race covers:
//   (a) PATCH /api/boards/:bid moving a board out of / into a project, against that project's switch;
//   (b) PATCH workspace member guest -> member, against a board moved into an internal-only project;
//   (c) PUT board members, the email invite (its "granted" path, under the Clerk fake) and accepting an
//       invitation or joining through a guest link, against the switch;
//   (d) an access-request approval against the switch;
//   (e) "Duplicate, keep sharing" against the switch;
//   (f) a review, workshop or guest link created, extended ("+1 h") or opened to guests, against the switch
//       (IO-5, wave J refix round 1: those decided under the board row alone, or only in the root hook).
// Each path is raced at random (many rounds; DRAFTROOM_PG_STRESS_ITER, default 20) and once more stopped at
// the statement it decides on, with the switch (or the move) started against it (the forced interleavings
// below), which must wait for it.
//
// Found here, the first time these ran on Postgres (bc0f0b28): accepting a BOARD invitation and joining
// through a guest link decided the switch under the board row alone (routes/invitations.ts lockInvitation
// took the workspace row only for a workspace invitation), so a switch turned on between that read and the
// redeem's commit let an outside account or a name-only guest in (the four (c) accept/join tests fail
// there). lockInvitation now takes the workspace row first for every invitation. With the lock taken out
// again by hand (a patch-revert), PATCH /api/boards/:bid's lock is caught by (b) at random and by the forced
// (a) and (b), PUT board members' and the approval's by (c) and (d) both ways.

import { InvitationCreated } from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type PausingDb, pausingDb, waitedOrFinished } from '../../race-support.ts'
import { clerkUser, clerkWorld } from '../domain-access/clerk-fake.ts'
import { freshIp, guestLink, joinRequest, tokenOf } from '../guests/support.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from '../history/helpers.ts'
import { addMember, move, newProject, setProject } from './internal-only-support.ts'

vi.mock('@clerk/backend', async () => (await import('../domain-access/clerk-fake.ts')).clerkBackendModule)

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 20)

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

// ---- the commit-time watch ------------------------------------------------------------------------

/**
 * Deferred constraint triggers that record, at each COMMIT, a new outside grant, membership or visibility in
 * a scope that is internal only at that instant, and a move out of an internal-only project. `outsiders`
 * are the non-creator accounts of the test (name-only guests count by `users.kind`). The tables and
 * functions live in this api's own test schema (search_path), dropped with it.
 */
async function watch(db: Db, outsiders: readonly string[]): Promise<void> {
  await db.exec(`
    CREATE TABLE io_outsiders (user_id text PRIMARY KEY);
    CREATE TABLE io_breaks (id bigserial PRIMARY KEY, what text NOT NULL, detail text NOT NULL);

    CREATE FUNCTION io_quiet() RETURNS boolean LANGUAGE sql VOLATILE AS
      $f$ SELECT coalesce(current_setting('io.quiet', true), '') = '1' $f$;
    CREATE FUNCTION io_rank(r text) RETURNS int LANGUAGE sql IMMUTABLE AS
      $f$ SELECT array_position(ARRAY['viewer', 'commenter', 'editor', 'owner']::text[], r) $f$;
    CREATE FUNCTION io_vis_role(v text) RETURNS text LANGUAGE sql IMMUTABLE AS
      $f$ SELECT CASE v WHEN 'workspace_view' THEN 'viewer' WHEN 'workspace_edit' THEN 'editor' END $f$;
    CREATE FUNCTION io_outside(uid text) RETURNS boolean LANGUAGE sql VOLATILE AS
      $f$ SELECT EXISTS (SELECT 1 FROM io_outsiders WHERE user_id = uid)
              OR EXISTS (SELECT 1 FROM users WHERE id = uid AND kind = 'guest') $f$;
    -- the board's scope as committed now (and as this transaction changed it)
    CREATE FUNCTION io_board_on(bid text) RETURNS boolean LANGUAGE sql VOLATILE AS
      $f$ SELECT coalesce((SELECT w.internal_only OR coalesce(p.internal_only, false)
                             FROM boards b JOIN workspaces w ON w.id = b.workspace_id
                             LEFT JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
                            WHERE b.id = bid), false) $f$;

    -- A new or higher board grant for someone outside.
    CREATE FUNCTION io_grant_check() RETURNS trigger LANGUAGE plpgsql AS $f$
    DECLARE cur text;
    BEGIN
      IF io_quiet() OR NOT io_outside(NEW.user_id) THEN RETURN NULL; END IF;
      IF TG_OP = 'UPDATE' AND io_rank(NEW.role) <= io_rank(OLD.role) THEN RETURN NULL; END IF;
      SELECT role INTO cur FROM board_members WHERE board_id = NEW.board_id AND user_id = NEW.user_id;
      IF cur IS NOT NULL AND io_board_on(NEW.board_id) THEN
        INSERT INTO io_breaks (what, detail) VALUES ('grant', NEW.board_id || ' ' || NEW.user_id || ' ' || cur);
      END IF;
      RETURN NULL;
    END $f$;
    CREATE CONSTRAINT TRIGGER io_grant AFTER INSERT OR UPDATE ON board_members
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION io_grant_check();

    -- Someone outside made a workspace member (or more) while the workspace is internal only, or while that
    -- reaches a board of an internal-only project that is not private (outside.ts memberRoleReachesProject).
    CREATE FUNCTION io_member_check() RETURNS trigger LANGUAGE plpgsql AS $f$
    DECLARE cur text;
    BEGIN
      IF io_quiet() OR NEW.role = 'guest' OR NOT io_outside(NEW.user_id) THEN RETURN NULL; END IF;
      IF TG_OP = 'UPDATE' AND OLD.role <> 'guest' THEN RETURN NULL; END IF;
      SELECT role INTO cur FROM workspace_members WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id;
      IF cur IS NULL OR cur = 'guest' THEN RETURN NULL; END IF;
      IF (SELECT internal_only FROM workspaces WHERE id = NEW.workspace_id) OR EXISTS (
           SELECT 1 FROM boards b JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
             LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = NEW.user_id
            WHERE b.workspace_id = NEW.workspace_id AND p.internal_only AND b.visibility <> 'private'
              AND (bm.role IS NULL OR io_rank(bm.role) < io_rank(io_vis_role(b.visibility)))) THEN
        INSERT INTO io_breaks (what, detail) VALUES ('member', NEW.workspace_id || ' ' || NEW.user_id || ' ' || cur);
      END IF;
      RETURN NULL;
    END $f$;
    CREATE CONSTRAINT TRIGGER io_member AFTER INSERT OR UPDATE ON workspace_members
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION io_member_check();

    -- A board made, or its visibility raised, in an internal-only scope while that reaches a workspace member
    -- outside (IO-2b, and the copy's rule in IO-2a); a board taken out of an internal-only project (IO-1:
    -- nobody who moves a board in these tests may do that).
    CREATE FUNCTION io_board_check() RETURNS trigger LANGUAGE plpgsql AS $f$
    DECLARE b record;
    BEGIN
      IF io_quiet() THEN RETURN NULL; END IF;
      SELECT * INTO b FROM boards WHERE id = NEW.id;
      IF b.id IS NULL THEN RETURN NULL; END IF;
      IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM b.project_id
         AND (SELECT internal_only FROM projects WHERE id = OLD.project_id)
         AND NOT coalesce((SELECT internal_only FROM projects WHERE id = b.project_id), false) THEN
        INSERT INTO io_breaks (what, detail) VALUES ('move-out', b.id || ' ' || OLD.project_id || ' -> ' || coalesce(b.project_id, 'none'));
      END IF;
      IF b.visibility <> 'private'
         AND (TG_OP = 'INSERT' OR coalesce(io_rank(io_vis_role(OLD.visibility)), 0) < io_rank(io_vis_role(b.visibility)))
         AND io_board_on(b.id) AND EXISTS (
           SELECT 1 FROM workspace_members wm
             LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = wm.user_id
            WHERE wm.workspace_id = b.workspace_id AND wm.role = 'member' AND io_outside(wm.user_id)
              AND (bm.role IS NULL OR io_rank(bm.role) < io_rank(io_vis_role(b.visibility)))) THEN
        INSERT INTO io_breaks (what, detail) VALUES ('visibility', b.id || ' ' || b.visibility);
      END IF;
      RETURN NULL;
    END $f$;
    CREATE CONSTRAINT TRIGGER io_board AFTER INSERT OR UPDATE ON boards
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION io_board_check();

    -- A review, workshop or guest link created, given more time, or opened to name-only guests while its
    -- board is internal only (IO-5). Revoking, a redemption's use count and turning guests off never count.
    CREATE FUNCTION io_link_check() RETURNS trigger LANGUAGE plpgsql AS $f$
    DECLARE i record;
    BEGIN
      IF io_quiet() THEN RETURN NULL; END IF;
      SELECT * INTO i FROM invitations WHERE id = NEW.id;
      IF i.id IS NULL OR NOT i.multi_use OR i.board_id IS NULL OR i.revoked_at IS NOT NULL THEN RETURN NULL; END IF;
      IF (TG_OP = 'INSERT' OR i.expires_at > OLD.expires_at OR (i.allow_guests AND NOT OLD.allow_guests))
         AND io_board_on(i.board_id) THEN
        INSERT INTO io_breaks (what, detail) VALUES ('link', i.id || ' ' || lower(TG_OP));
      END IF;
      RETURN NULL;
    END $f$;
    CREATE CONSTRAINT TRIGGER io_link AFTER INSERT OR UPDATE ON invitations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION io_link_check();
  `)
  for (const id of outsiders) await db.query('INSERT INTO io_outsiders (user_id) VALUES ($1)', [id])
}

/** What the watch recorded (and clears it). */
async function breaks(db: Db): Promise<string[]> {
  const rows = await db.query<{ what: string; detail: string }>(
    'DELETE FROM io_breaks RETURNING what, detail',
  )
  return rows.rows.map((r) => `${r.what}: ${r.detail}`)
}

/** A test's own set-up between rounds, which the watch ignores (one transaction). */
async function reset(db: Db, steps: [string, unknown[]][]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SELECT set_config('io.quiet', '1', true)")
    for (const [sql, params] of steps) await tx.query(sql, params)
  })
}

// ---- races ----------------------------------------------------------------------------------------

type Res = LightMyRequestResponse
const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 12))

/**
 * Runs the sides at once (each after a short random delay) and returns their answers. An answer that is
 * not one of the side's `ok` statuses (a 5xx above all: a deadlock, 40P01, is a 500) is a failure.
 */
async function race(
  round: number,
  failures: string[],
  sides: Record<string, { run: () => Promise<Res>; ok: readonly number[] }>,
): Promise<Record<string, Res>> {
  const names = Object.keys(sides)
  const answers = await Promise.all(names.map((n) => jitter().then(() => sides[n]?.run() as Promise<Res>)))
  const out: Record<string, Res> = {}
  for (const [i, n] of names.entries()) {
    const res = answers[i] as Res
    out[n] = res
    if (!sides[n]?.ok.includes(res.statusCode))
      failures.push(`round ${round} ${n}: ${res.statusCode} ${res.body.slice(0, 300)}`)
  }
  return out
}

const S = { ok: [200], okOr409: [200, 409] } as const

interface World {
  api: TestApi
  sync: FakeSync
  alice: Client // Dev Studio owner (creator): the switch
  bob: Client // creator member: moves, shares, duplicates (not an admin, so he may not take a board out)
  pat: Client // outside account, Dev Studio guest
  quinn: Client // outside account, no membership (requests access, accepts an invitation)
  project: string // "Secret": the switch under test
  open: string // a project whose switch stays off
  board: string // bob's board
  /** Set by world({ paused: true }): the api's transactions can be stopped midway (race-support.ts). */
  paused: PausingDb | null
}

async function world(opts: { paused?: boolean } = {}): Promise<World> {
  const sync = createFakeSync()
  const base = opts.paused ? await openTestDb() : null
  const paused = base ? pausingDb(base) : null
  const api = await createTestApi({ deps: { syncInternal: sync }, ...(paused ? { db: paused.db } : {}) })
  cleanup.push(async () => {
    await api.close()
    await base?.close()
  })
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
  const quinn = await api.login('quinn', 'Quinn Client', { email: 'quinn@client.example.test' })
  await addMember(api, DEV_STUDIO, pat.userId, 'guest')
  await api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
    DEV_STUDIO,
    quinn.userId,
  ])
  const project = await newProject(bob, DEV_STUDIO, 'Secret')
  const open = await newProject(bob, DEV_STUDIO, 'Open')
  const board = await createBoard(bob, DEV_STUDIO, 'Internal plan')
  sync.setBoard(board, [...baseRecords(), noteRec('n1', 'x')])
  expect((await move(bob, board, project)).statusCode).toBe(200)
  await watch(api.db, [pat.userId, quinn.userId])
  return { api, sync, alice, bob, pat, quinn, project, open, board, paused }
}

const switchOff = (w: World): [string, unknown[]] => [
  'UPDATE projects SET internal_only = false WHERE id = $1',
  [w.project],
]
const noGrantsFor = (...users: string[]): [string, unknown[]] => [
  'DELETE FROM board_members WHERE user_id = ANY($1::text[])',
  [users],
]
const grantOf = async (api: TestApi, board: string, userId: string) =>
  (
    await api.db.maybeOne<{ role: string }>(
      'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
      [board, userId],
    )
  )?.role ?? null
const switchIsOn = async (w: World) =>
  (await w.api.db.one<{ on: boolean }>('SELECT internal_only AS on FROM projects WHERE id = $1', [w.project]))
    .on

describe.skipIf(!PG)('Internal only: the switch against the paths it guards (real Postgres)', () => {
  it('(a) moving a board out of and into the project, against its switch turned on and off', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER * 2; i++) {
      const on = Math.random() < 0.5
      const inside = Math.random() < 0.6
      await reset(w.api.db, [
        ['UPDATE projects SET internal_only = $2 WHERE id = $1', [w.project, on]],
        ['UPDATE boards SET project_id = $2 WHERE id = $1', [w.board, inside ? w.project : null]],
      ])
      const to = inside ? (Math.random() < 0.5 ? null : w.open) : w.project
      const r = await race(i, failures, {
        // turning it off is for a workspace owner or admin who is a creator: alice
        flip: { run: () => setProject(w.alice, w.project, !on), ok: S.ok },
        // a move out of the project is refused while it is on (bob is a member, not an admin)
        move: { run: () => move(w.bob, w.board, to), ok: inside ? S.okOr409 : S.ok },
      })
      expect(await breaks(w.api.db), `round ${i}`).toEqual([])
      // A move that went through left the board where bob asked; a refused one, where it was.
      const where = (
        await w.api.db.one<{ p: string | null }>('SELECT project_id AS p FROM boards WHERE id = $1', [
          w.board,
        ])
      ).p
      expect(where, `round ${i}`).toBe(r.move?.statusCode === 200 ? to : inside ? w.project : null)
    }
    expect(failures).toEqual([])
  })

  it('(b) raising a workspace guest to member, against a workspace-visible board moved into the internal-only project', async () => {
    const w = await world()
    // the switch is on; bob's board stays in it, private (nothing reaches pat through it)
    await reset(w.api.db, [
      ['UPDATE projects SET internal_only = true WHERE id = $1', [w.project]],
      ["UPDATE boards SET visibility = 'private' WHERE id = $1", [w.board]],
    ])
    const other = await createBoard(w.bob, DEV_STUDIO, 'Team board')
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      await reset(w.api.db, [
        [
          "UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2",
          [DEV_STUDIO, w.pat.userId],
        ],
        ["UPDATE boards SET project_id = NULL, visibility = 'workspace_edit' WHERE id = $1", [other]],
        noGrantsFor(w.pat.userId),
      ])
      await race(i, failures, {
        raise: {
          run: () =>
            w.alice.req('PATCH', `/api/workspaces/${DEV_STUDIO}/members/${w.pat.userId}`, { role: 'member' }),
          ok: S.okOr409,
        },
        moveIn: { run: () => move(w.bob, other, w.project), ok: S.ok },
      })
      expect(await breaks(w.api.db), `round ${i}`).toEqual([])
    }
    expect(failures).toEqual([])
  })

  it('(c) PUT board members, against the switch turned on and against a move into the project', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      const viaMove = i % 2 === 1
      await reset(w.api.db, [
        ['UPDATE projects SET internal_only = $2 WHERE id = $1', [w.project, viaMove]],
        ['UPDATE boards SET project_id = $2 WHERE id = $1', [w.board, viaMove ? w.open : w.project]],
        noGrantsFor(w.pat.userId),
      ])
      const r = await race(i, failures, {
        change: viaMove
          ? { run: () => move(w.bob, w.board, w.project), ok: S.ok }
          : { run: () => setProject(w.alice, w.project, true), ok: S.ok },
        put: {
          run: () => w.alice.req('PUT', `/api/boards/${w.board}/members/${w.pat.userId}`, { role: 'editor' }),
          ok: S.okOr409,
        },
      })
      expect(await breaks(w.api.db), `round ${i}`).toEqual([])
      expect(await grantOf(w.api, w.board, w.pat.userId), `round ${i}`).toBe(
        r.put?.statusCode === 200 ? 'editor' : null,
      )
    }
    expect(failures).toEqual([])
  })

  it('(c) accepting an invitation from before the switch, against the switch turned on', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      await reset(w.api.db, [
        switchOff(w),
        noGrantsFor(w.quinn.userId),
        [
          'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
          [DEV_STUDIO, w.quinn.userId],
        ],
      ])
      // the per-person accept limit (30 a minute) stays out of the way
      if (i % 25 === 24) w.api.clock.advance(61_000)
      const made = await w.bob.req('POST', `/api/boards/${w.board}/invitations`, {
        role: 'commenter',
        email: 'quinn@client.example.test',
      })
      expect(made.statusCode, made.body).toBe(201)
      const inv = InvitationCreated.parse(made.json())
      await race(i, failures, {
        on: { run: () => setProject(w.alice, w.project, true), ok: S.ok },
        accept: {
          run: () => w.quinn.req('POST', `/api/invitations/${tokenOf(inv.url)}/accept`),
          ok: S.okOr409,
        },
      })
      expect(await breaks(w.api.db), `round ${i}`).toEqual([])
    }
    expect(failures).toEqual([])
  })

  it('(c) joining through a guest link from before the switch, against the switch turned on', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      await reset(w.api.db, [
        switchOff(w),
        [
          'UPDATE invitations SET revoked_at = now() WHERE board_id = $1 AND multi_use AND revoked_at IS NULL',
          [w.board],
        ],
      ])
      const link = await guestLink(w.bob, w.board, { role: 'viewer' })
      await race(i, failures, {
        on: { run: () => setProject(w.alice, w.project, true), ok: S.ok },
        join: {
          run: () => joinRequest(w.api, tokenOf(link.url), { name: `Guest ${i}` }, { ip: freshIp() }),
          ok: [200, 201, 409],
        },
      })
      expect(await breaks(w.api.db), `round ${i}`).toEqual([])
    }
    expect(failures).toEqual([])
  })

  it('(d) approving an outside account’s access request, against the switch turned on', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      await reset(w.api.db, [
        switchOff(w),
        noGrantsFor(w.quinn.userId),
        [
          'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
          [DEV_STUDIO, w.quinn.userId],
        ],
        ['DELETE FROM access_requests WHERE user_id = $1', [w.quinn.userId]],
      ])
      // the per-person request limit (10 per 10 minutes) stays out of the way
      w.api.clock.advance(61_000)
      const asked = await w.quinn.req('POST', `/api/boards/${w.board}/access-requests`, { role: 'editor' })
      expect(asked.statusCode, asked.body).toBe(202)
      const id = (
        await w.api.db.one<{ id: string }>(
          "SELECT id FROM access_requests WHERE user_id = $1 AND status = 'pending'",
          [w.quinn.userId],
        )
      ).id
      const r = await race(i, failures, {
        on: { run: () => setProject(w.alice, w.project, true), ok: S.ok },
        approve: { run: () => w.bob.req('POST', `/api/access-requests/${id}/approve`, {}), ok: S.okOr409 },
      })
      expect(await breaks(w.api.db), `round ${i}`).toEqual([])
      expect(await grantOf(w.api, w.board, w.quinn.userId), `round ${i}`).toBe(
        r.approve?.statusCode === 200 ? 'editor' : null,
      )
    }
    expect(failures).toEqual([])
  })

  it('(e) "Duplicate, keep sharing", against the switch turned on', async () => {
    const w = await world()
    // pat (a workspace guest) has a grant on the source; sam (outside) is a workspace member, whom the
    // source's workspace visibility reaches.
    const sam = await w.api.login('sam', 'Sam Client', { email: 'sam@client.example.test' })
    await reset(w.api.db, [
      switchOff(w),
      ['INSERT INTO io_outsiders (user_id) VALUES ($1)', [sam.userId]],
      ["UPDATE boards SET visibility = 'workspace_view' WHERE id = $1", [w.board]],
      [
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'member'`,
        [DEV_STUDIO, sam.userId],
      ],
      [
        `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'commenter', $3, now())`,
        [w.board, w.pat.userId, w.bob.userId],
      ],
    ])
    const failures: string[] = []
    // the copy route's own limit (60 a minute, wall-clock: routes HEAVY) caps the rounds here
    for (let i = 0; i < Math.min(ITER, 50); i++) {
      await reset(w.api.db, [switchOff(w)])
      const r = await race(i, failures, {
        on: { run: () => setProject(w.alice, w.project, true), ok: S.ok },
        copy: {
          run: () => w.bob.req('POST', `/api/boards/${w.board}/duplicate`, { keepSharing: true }),
          ok: [201],
        },
      })
      expect(await breaks(w.api.db), `round ${i}`).toEqual([])
      if (r.copy?.statusCode === 201) {
        const copy = (r.copy.json() as { board: { id: string; visibility: string } }).board
        const pats = await grantOf(w.api, copy.id, w.pat.userId)
        // the copy is wholly one side of the switch: pat's grant and the copy's visibility agree
        expect(copy.visibility === 'private', `round ${i}`).toBe(pats === null)
      }
    }
    expect(failures).toEqual([])
    expect(await switchIsOn(w)).toBe(true)
  })

  it('(f) creating, extending and opening a link to guests, against the switch turned on', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      await reset(w.api.db, [
        switchOff(w),
        [
          'UPDATE invitations SET revoked_at = now() WHERE board_id = $1 AND multi_use AND revoked_at IS NULL',
          [w.board],
        ],
      ])
      const link = await guestLink(w.bob, w.board, { role: 'viewer', allowGuests: false })
      const kind = (['create', 'extend', 'guests'] as const)[i % 3] ?? 'create'
      const path =
        kind === 'create'
          ? () => w.bob.req('POST', `/api/boards/${w.board}/review-links`, { role: 'commenter' })
          : kind === 'extend'
            ? () => w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/extend`, { hours: 1 })
            : () =>
                w.bob.req('PATCH', `/api/boards/${w.board}/review-links/${link.id}`, { allowGuests: true })
      await race(i, failures, {
        on: { run: () => setProject(w.alice, w.project, true), ok: S.ok },
        [kind]: { run: path, ok: kind === 'create' ? [201, 409] : S.okOr409 },
      })
      expect(await breaks(w.api.db), `round ${i}`).toEqual([])
    }
    expect(failures).toEqual([])
  })
})

// ---- forced interleavings -------------------------------------------------------------------------
//
// The random rounds above hit the window between a path's switch read and its commit only now and then (a
// move's window is a single statement: (a) passed 300 random rounds with the PATCH route's workspace lock
// taken out). So each path is also stopped right after the statement it decides on (pausingDb), holding
// only the locks it has taken so far, and the switch change (or the move) is started against it: it must
// WAIT for the paused transaction (which holds the workspace row), and when both have finished nothing has
// broken the rule. A path that decided under the board row alone lets the switch finish first, and then
// commits a grant the watch records.

// The statements the paths decide on, inside their transactions. The root hooks read on the pool, outside
// any transaction, so they never match (pausingDb stops transactions only).
/** outside.ts boardInternalOnly (PUT members, accepting, joining, approving, the email invite's grant). */
const BOARD_SCOPE_READ = /SELECT w\.internal_only AS ws, p\.internal_only AS prj/
/** outside.ts assertProjectMoveAllowed (PATCH /api/boards/:bid with a projectId). */
const MOVE_READ = /SELECT id, internal_only FROM projects WHERE workspace_id = \$1 AND id = ANY/
/** outside.ts memberRoleReachesProject (PATCH workspace member to member). */
const MEMBER_REACH_READ =
  /FROM boards b JOIN projects p ON p\.id = b\.project_id AND p\.workspace_id = b\.workspace_id\s+LEFT JOIN board_members/
/** outside.ts scopeIn (the keep-sharing copy, IO-2a). */
const COPY_SCOPE_READ = /SELECT w\.internal_only AS ws,\s+\(SELECT p\.internal_only/

/**
 * Stops `path`'s transaction after the statement `decides`, starts `other` against it, and reports whether
 * `other` waited for it. Returns both answers.
 */
async function forced(
  paused: PausingDb,
  db: Db,
  decides: RegExp,
  path: () => Promise<Res>,
  other: () => Promise<Res>,
): Promise<{ path: Res; other: Res; order: 'waited' | 'finished' }> {
  const pause = paused.arm(decides, 'after')
  const first = path()
  let second: Promise<Res> | null = null
  let order: 'waited' | 'finished' = 'finished'
  try {
    const pid = await Promise.race([
      pause.reached,
      first.then((r): never => {
        throw new Error(`the path ended before its decision: ${r.statusCode} ${r.body.slice(0, 200)}`)
      }),
    ])
    second = other()
    order = await waitedOrFinished(db, pid, second)
  } finally {
    pause.release()
  }
  const [a, b] = await Promise.all([first, second as Promise<Res>])
  return { path: a, other: b, order }
}

/** The usual outcome: the switch (or move) waited, both went through, the rule held. */
async function expectSerialised(w: { api: TestApi }, r: Awaited<ReturnType<typeof forced>>, path = 200) {
  expect(r.order, 'the switch (or the move) waits for the path that decided first').toBe('waited')
  expect(r.path.statusCode, r.path.body).toBe(path)
  expect(r.other.statusCode, r.other.body).toBe(200)
  expect(await breaks(w.api.db)).toEqual([])
}

describe.skipIf(!PG)(
  'Internal only: each path stopped at its decision, the switch started against it (real Postgres)',
  () => {
    const on = (w: World) => () => setProject(w.alice, w.project, true)
    const pausedOf = (w: World) => w.paused as PausingDb

    it('(a) a move out of the project, against the switch turned on', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [switchOff(w)])
      const r = await forced(pausedOf(w), w.api.db, MOVE_READ, () => move(w.bob, w.board, null), on(w))
      await expectSerialised(w, r)
    })

    it('(b) a guest raised to member, against a workspace-visible board moved into the internal-only project', async () => {
      const w = await world({ paused: true })
      const other = await createBoard(w.bob, DEV_STUDIO, 'Team board')
      await reset(w.api.db, [
        ['UPDATE projects SET internal_only = true WHERE id = $1', [w.project]],
        ["UPDATE boards SET visibility = 'private' WHERE id = $1", [w.board]],
        ["UPDATE boards SET visibility = 'workspace_edit' WHERE id = $1", [other]],
      ])
      const r = await forced(
        pausedOf(w),
        w.api.db,
        MEMBER_REACH_READ,
        () =>
          w.alice.req('PATCH', `/api/workspaces/${DEV_STUDIO}/members/${w.pat.userId}`, { role: 'member' }),
        () => move(w.bob, other, w.project),
      )
      await expectSerialised(w, r)
    })

    it('(c) PUT board members, against the switch turned on', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [switchOff(w)])
      const r = await forced(
        pausedOf(w),
        w.api.db,
        BOARD_SCOPE_READ,
        () => w.alice.req('PUT', `/api/boards/${w.board}/members/${w.pat.userId}`, { role: 'editor' }),
        on(w),
      )
      await expectSerialised(w, r)
    })

    it('(c) PUT board members, against a move into the internal-only project', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [
        ['UPDATE projects SET internal_only = true WHERE id = $1', [w.project]],
        ['UPDATE boards SET project_id = $2 WHERE id = $1', [w.board, w.open]],
      ])
      const r = await forced(
        pausedOf(w),
        w.api.db,
        BOARD_SCOPE_READ,
        () => w.alice.req('PUT', `/api/boards/${w.board}/members/${w.pat.userId}`, { role: 'editor' }),
        () => move(w.bob, w.board, w.project),
      )
      await expectSerialised(w, r)
    })

    it('(c) accepting an invitation from before the switch, against the switch turned on', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [switchOff(w)])
      const made = await w.bob.req('POST', `/api/boards/${w.board}/invitations`, {
        role: 'commenter',
        email: 'quinn@client.example.test',
      })
      expect(made.statusCode, made.body).toBe(201)
      const inv = InvitationCreated.parse(made.json())
      const r = await forced(
        pausedOf(w),
        w.api.db,
        BOARD_SCOPE_READ,
        () => w.quinn.req('POST', `/api/invitations/${tokenOf(inv.url)}/accept`),
        on(w),
      )
      // Before the fix (lockInvitation took a board invitation's board row only) the switch finished first,
      // and the accept then committed quinn's grant in a project that was internal only by then.
      await expectSerialised(w, r)
    })

    it('(c) joining through a guest link from before the switch, against the switch turned on', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [switchOff(w)])
      const link = await guestLink(w.bob, w.board, { role: 'viewer' })
      const r = await forced(
        pausedOf(w),
        w.api.db,
        BOARD_SCOPE_READ,
        () => joinRequest(w.api, tokenOf(link.url), { name: 'Guest' }, { ip: freshIp() }),
        on(w),
      )
      await expectSerialised(w, r, r.path.statusCode === 201 ? 201 : 200)
    })

    it('(d) approving an outside account’s access request, against the switch turned on', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [switchOff(w)])
      const asked = await w.quinn.req('POST', `/api/boards/${w.board}/access-requests`, { role: 'editor' })
      expect(asked.statusCode, asked.body).toBe(202)
      const { id } = await w.api.db.one<{ id: string }>('SELECT id FROM access_requests WHERE user_id = $1', [
        w.quinn.userId,
      ])
      const r = await forced(
        pausedOf(w),
        w.api.db,
        BOARD_SCOPE_READ,
        () => w.bob.req('POST', `/api/access-requests/${id}/approve`, {}),
        on(w),
      )
      await expectSerialised(w, r)
    })

    it('(e) "Duplicate, keep sharing", against the switch turned on', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [
        switchOff(w),
        [
          `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'commenter', $3, now())`,
          [w.board, w.pat.userId, w.bob.userId],
        ],
      ])
      const r = await forced(
        pausedOf(w),
        w.api.db,
        COPY_SCOPE_READ,
        () => w.bob.req('POST', `/api/boards/${w.board}/duplicate`, { keepSharing: true }),
        on(w),
      )
      await expectSerialised(w, r, 201)
      // decided before the switch: pat's grant was copied, and it committed before the switch did
      const copy = (r.path.json() as { board: { id: string } }).board.id
      expect(await grantOf(w.api, copy, w.pat.userId)).toBe('commenter')
    })

    it('(f) creating a link, against the switch turned on', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [switchOff(w)])
      const r = await forced(
        pausedOf(w),
        w.api.db,
        BOARD_SCOPE_READ,
        () => w.bob.req('POST', `/api/boards/${w.board}/review-links`, { role: 'commenter' }),
        on(w),
      )
      // Before IO-5 the creation held the board row alone: the switch finished first, and the link then
      // committed on a board that was internal only by then.
      await expectSerialised(w, r, 201)
    })

    it('(f) "+1 h" on a link, against the switch turned on', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [switchOff(w)])
      const link = await guestLink(w.bob, w.board, { role: 'viewer' })
      const r = await forced(
        pausedOf(w),
        w.api.db,
        BOARD_SCOPE_READ,
        () => w.bob.req('POST', `/api/boards/${w.board}/review-links/${link.id}/extend`, { hours: 1 }),
        on(w),
      )
      // Before IO-5 the route never read the switch in its transaction (only the root hook did, before it).
      await expectSerialised(w, r)
    })

    it('(f) opening a link to guests, against the switch turned on', async () => {
      const w = await world({ paused: true })
      await reset(w.api.db, [switchOff(w)])
      const link = await guestLink(w.bob, w.board, { role: 'viewer', allowGuests: false })
      const r = await forced(
        pausedOf(w),
        w.api.db,
        BOARD_SCOPE_READ,
        () => w.bob.req('PATCH', `/api/boards/${w.board}/review-links/${link.id}`, { allowGuests: true }),
        on(w),
      )
      await expectSerialised(w, r)
    })

    it('(c) the email invite’s granted path (Clerk), against the switch turned on', async () => {
      const base = await openTestDb()
      const paused = pausingDb(base)
      const w = await clerkWorld({ db: paused.db })
      cleanup.push(async () => {
        await w.api.close()
        await base.close()
      })
      clerkUser('user_alice', ['lobby-test-alice@darkburn.com'])
      clerkUser('user_kim', ['kim@client.example.test'])
      const alice = await w.signIn('user_alice')
      const kim = await w.signIn('user_kim')
      const wid = alice.personalWorkspaceId
      const project = await newProject(alice, wid, 'Secret')
      const board = await createBoard(alice, wid, 'Plan')
      expect((await move(alice, board, project)).statusCode).toBe(200)
      await watch(w.api.db, [kim.userId])
      const r = await forced(
        paused,
        w.api.db,
        BOARD_SCOPE_READ,
        () =>
          alice.req('POST', `/api/boards/${board}/invitations/email`, {
            role: 'editor',
            email: 'kim@client.example.test',
          }),
        () => setProject(alice, project, true),
      )
      await expectSerialised(w, r)
      expect((r.path.json() as { mode: string }).mode).toBe('granted')
    })
  },
)

describe.skipIf(!PG)(
  'Internal only: the email invite’s granted path against the switch (Clerk, real Postgres)',
  () => {
    it('(c) POST …/invitations/email for an existing outside account, against the switch turned on', async () => {
      const w = await clerkWorld()
      cleanup.push(() => w.api.close())
      clerkUser('user_alice', ['lobby-test-alice@darkburn.com'])
      clerkUser('user_kim', ['kim@client.example.test'])
      const alice = await w.signIn('user_alice')
      const kim = await w.signIn('user_kim')
      const wid = alice.personalWorkspaceId
      const project = await newProject(alice, wid, 'Secret')
      const board = await createBoard(alice, wid, 'Plan')
      expect((await move(alice, board, project)).statusCode).toBe(200)
      await watch(w.api.db, [kim.userId])
      const failures: string[] = []
      for (let i = 0; i < ITER; i++) {
        await reset(w.api.db, [
          ['UPDATE projects SET internal_only = false WHERE id = $1', [project]],
          ['DELETE FROM board_members WHERE user_id = $1', [kim.userId]],
        ])
        // the per-person email invite limit (20 an hour) stays out of the way
        w.api.clock.advance(4 * 60_000)
        const r = await race(i, failures, {
          on: { run: () => setProject(alice, project, true), ok: S.ok },
          invite: {
            run: () =>
              alice.req('POST', `/api/boards/${board}/invitations/email`, {
                role: 'editor',
                email: 'kim@client.example.test',
              }),
            ok: S.okOr409,
          },
        })
        if (r.invite?.statusCode === 200) expect((r.invite.json() as { mode: string }).mode).toBe('granted')
        expect(await breaks(w.api.db), `round ${i}`).toEqual([])
      }
      expect(failures).toEqual([])
    })
  },
)
