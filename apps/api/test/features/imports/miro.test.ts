// Import from Miro end to end on the api (wave R, WS1): the two Miro routes and the six job routes over the runner,
// against the fake Miro (packages/miro-import fake-miro.ts, behind the local-dev seam) and a sync fake whose seed runs
// the real converter. Covers: listing boards, the token's refusals, a whole job (files stored once, the report, the
// active board), files off (no resource is asked for), refused and expired downloads, 429 waits, cancel and pause
// mid-files, a restart (interrupted, resume with the token, nothing uploaded twice), the quota, who may see and
// control a job, the CSV, and the token never reaching a table, a log line or an answer.
import {
  importCancelPath,
  importJobPath,
  importListPath,
  importPausePath,
  importReportPath,
  importResumePath,
} from '@draftroom/contracts'
import { openTestDb } from '@draftroom/db/testing'
import { startFakeMiro } from '@draftroom/miro-import/fake-miro'
import { EMPTY_ID, fixtureBoards, RETRO_ID, SPRINT_ID, SPRINT_IDS } from '@draftroom/miro-import/fixtures'
import { afterEach, describe, expect, it } from 'vitest'
import { DEV_STUDIO } from '../../helpers.ts'
import { type MiroWorld, miroWorld } from './miro-support.ts'

let w: MiroWorld
afterEach(async () => {
  await w?.close()
})

const boardsOf = async (boardId: string) =>
  (
    await w.api.db.query<{
      id: string
      status: string
      title: string
      created_by: string
      visibility: string
    }>('SELECT id, status, title, created_by, visibility FROM boards WHERE id = $1', [boardId])
  ).rows
const versionsOf = async (boardId: string) =>
  (
    await w.api.db.query<{ id: string; kind: string; name: string }>(
      'SELECT id, kind, name FROM asset_versions WHERE board_id = $1',
      [boardId],
    )
  ).rows

describe('POST …/imports/miro/boards', () => {
  it('checks the token and lists the boards it can see, newest change first; a query narrows the list', async () => {
    w = await miroWorld()
    const res = await w.listBoards(w.alice)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.team).toEqual({ name: 'Fixture team' })
    expect(body.boards.map((b: { id: string }) => b.id)).toEqual([SPRINT_ID, RETRO_ID, EMPTY_ID])
    expect(body.boards[0]).toMatchObject({
      name: 'Sprint planning',
      viewLink: `https://miro.com/app/board/${SPRINT_ID}/`,
    })
    expect(body.total).toBe(3)
    const narrowed = (await w.listBoards(w.alice, { query: 'retro' })).json()
    expect(narrowed.boards.map((b: { id: string }) => b.id)).toEqual([RETRO_ID])
    // only Miro's API origin was asked, always with the token
    expect(w.miro.requests.every((r) => r.origin === 'api' && r.auth === 'token')).toBe(true)
  })

  it('refuses a missing, malformed or wrong token, a token without boards:read, and unknown fields', async () => {
    w = await miroWorld()
    const missing = await w.call(w.alice, 'POST', `/api/workspaces/${DEV_STUDIO}/imports/miro/boards`, {})
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error.code).toBe('MIRO_TOKEN_INVALID')
    const malformed = await w.listBoards(w.alice, { token: 'has spaces in it, no' })
    expect(malformed.json().error.code).toBe('MIRO_TOKEN_INVALID')
    const wrong = await w.listBoards(w.alice, { token: 'a-wrong-token-0123456789abcdef' })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.code).toBe('MIRO_TOKEN_INVALID')
    w.miro.behaviour.scopes = ['identity:read']
    const scope = await w.listBoards(w.alice)
    expect(scope.json().error.code).toBe('MIRO_SCOPE_MISSING')
    w.miro.behaviour.scopes = ['boards:read']
    const extra = await w.listBoards(w.alice, { bogus: 1 })
    expect(extra.statusCode).toBe(400)
    expect(extra.body).not.toContain(w.miro.token)
  })

  it('Miro failing is MIRO_UNAVAILABLE; 429s are waited out', async () => {
    w = await miroWorld()
    w.miro.behaviour.fail = { path: /^\/v2\/boards$/, status: 500 }
    expect((await w.listBoards(w.alice)).json().error.code).toBe('MIRO_UNAVAILABLE')
    w.miro.behaviour.fail = null
    w.miro.behaviour.rateLimitNext = 1
    const res = await w.listBoards(w.alice)
    expect(res.statusCode, res.body).toBe(200)
  })

  it('someone outside the workspace is refused before Miro is asked', async () => {
    w = await miroWorld()
    const erin = await w.api.login('erin')
    await w.api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      erin.userId,
      DEV_STUDIO,
    ])
    const res = await w.listBoards(erin)
    expect(res.statusCode).toBe(404)
    expect(w.miro.requests).toEqual([])
  })
})

describe('a Miro import job', () => {
  it('imports a board of every item type: files stored once each, the report, an active private board', async () => {
    w = await miroWorld()
    const importId = await w.start(w.alice, [{ miroBoardId: SPRINT_ID }])
    const view = await w.until(w.alice, importId, (v) => v.status === 'done')
    const board = view.boards[0]
    expect(board).toMatchObject({
      status: 'done',
      title: 'Sprint planning',
      sourceRef: SPRINT_ID,
      errorCode: null,
    })
    expect(board?.summary?.total).toBe(33)
    expect(board?.summary?.counts.failed).toBe(0)
    const boardId = board?.boardId as string
    expect(await boardsOf(boardId)).toEqual([
      {
        id: boardId,
        status: 'active',
        title: 'Sprint planning',
        created_by: w.alice.userId,
        visibility: 'private',
      },
    ])
    // the image (shown twice) once, the document once: versions of this board
    const versions = await versionsOf(boardId)
    expect(versions.map((v) => [v.kind, v.name]).sort()).toEqual([
      ['image', 'diagram.png'],
      ['pdf', 'brief.pdf'],
    ])
    // the seed body held no URL, and the elements show the versions
    const seed = w.sync.miroSeeds[0]
    expect(JSON.stringify(seed?.body)).not.toMatch(/https?:\/\/[^"]*(resources|r\/)/)
    const els = w.sync.boards.get(boardId)?.elements ?? []
    const fileIds = els.filter((e) => e.type === 'image').map((e) => (e as { fileId: string }).fileId)
    expect(new Set(fileIds)).toEqual(new Set(versions.map((v) => v.id)))
    // the files origin got no Authorization; the API origin always the token
    expect(w.miro.requests.filter((r) => r.origin === 'files').every((r) => r.auth === 'none')).toBe(true)
    expect(w.miro.requests.filter((r) => r.origin === 'api').every((r) => r.auth === 'token')).toBe(true)
    // items were read in 3 cursor pages
    expect(w.miro.requests.filter((r) => r.path.endsWith('/items')).length).toBeGreaterThanOrEqual(3)
    // the list and the CSV
    const list = (await w.call(w.alice, 'GET', importListPath(DEV_STUDIO, true))).json()
    expect(list.imports.map((j: { importId: string }) => j.importId)).toEqual([importId])
    const csv = await w.call(w.alice, 'GET', importReportPath(importId))
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    const lines = csv.body.trim().split('\r\n')
    expect(lines[0]).toBe('board,source_id,type,result,element_id,note')
    expect(lines).toHaveLength(34)
    expect(csv.body).toContain(`Sprint planning,${SPRINT_IDS.cloud},shape,approximate,`)
  })

  it('a document that claims to be audio but is HTML (song.mp3) stays an attachment, as an upload would', async () => {
    const boards = fixtureBoards().map((b) => ({
      ...b,
      items: b.items.map((i) =>
        i.type === 'document' ? { ...i, data: { ...(i.data as object), title: 'song.mp3' } } : i,
      ),
    }))
    const miro = await startFakeMiro({ boards })
    try {
      miro.behaviour.document = {
        contentType: 'audio/mpeg',
        bytes: Buffer.from('<!doctype html><script>alert(1)</script>'),
      }
      w = await miroWorld({ miro })
      const importId = await w.start(w.alice, [{ miroBoardId: SPRINT_ID }])
      const view = await w.until(w.alice, importId, (v) => v.status === 'done')
      const boardId = view.boards[0]?.boardId as string
      const rows = await w.api.db.query<{ name: string; mime_type: string }>(
        "SELECT name, mime_type FROM asset_versions WHERE board_id = $1 AND name = 'song.mp3'",
        [boardId],
      )
      expect(rows.rows).toEqual([{ name: 'song.mp3', mime_type: 'application/octet-stream' }])
      // the element names what is stored: no audio type
      const els = w.sync.boards.get(boardId)?.elements ?? []
      const files = els
        .map(
          (e) => (e as { customData?: { lobby?: { file?: { name: string; mimeType: string } } } }).customData,
        )
        .map((c) => c?.lobby?.file)
        .filter((f) => f?.name === 'song.mp3')
      expect(files.map((f) => f?.mimeType)).toEqual(['application/octet-stream'])
    } finally {
      // the world first (it does not close a fake it was given), then the fake
      await w?.close()
      w = undefined as unknown as MiroWorld
      await miro.close()
    }
  })

  it('files off (no download host): no resource is asked for; images and documents are “not imported yet”', async () => {
    w = await miroWorld({ files: false })
    const importId = await w.start(w.alice, [{ miroBoardId: SPRINT_ID }])
    const view = await w.until(w.alice, importId, (v) => v.status === 'done')
    expect(view.boards[0]?.summary?.notes['file-not-imported-yet']).toBe(3)
    expect(w.miro.requests.some((r) => r.path.includes('/resources/'))).toBe(false)
    expect(w.miro.requests.some((r) => r.origin === 'files')).toBe(false)
    expect(await versionsOf(view.boards[0]?.boardId as string)).toEqual([])
  })

  it('a download host the rules refuse, and an expired URL: placeholders, reported; the board still imports', async () => {
    w = await miroWorld()
    w.miro.behaviour.fileHost = 'evil'
    const a = await w.start(w.alice, [{ miroBoardId: SPRINT_ID }])
    const refused = await w.until(w.alice, a, (v) => v.status === 'done')
    expect(refused.boards[0]?.summary?.notes['file-host-refused']).toBe(3)
    w.miro.behaviour.fileHost = 'files'
    w.miro.behaviour.expired = true
    const b = await w.start(w.alice, [{ miroBoardId: SPRINT_ID, title: 'Again' }])
    const expired = await w.until(w.alice, b, (v) => v.status === 'done')
    expect(expired.boards[0]?.summary?.notes['file-failed']).toBe(3)
    expect(w.miro.requests.some((r) => r.origin === 'files')).toBe(false)
  })

  it('two boards in one job, a board the token cannot see refused at the start, the PDF reference refused', async () => {
    w = await miroWorld()
    const importId = await w.start(w.alice, [
      { miroBoardId: RETRO_ID, title: 'Our retro' },
      { miroBoardId: EMPTY_ID },
    ])
    const view = await w.until(w.alice, importId, (v) => v.status === 'done')
    expect(view.boards.map((b) => [b.title, b.status])).toEqual([
      ['Our retro', 'done'],
      ['Empty board', 'done'],
    ])
    const missing = await w.call(w.alice, 'POST', `/api/workspaces/${DEV_STUDIO}/imports/miro`, {
      token: w.miro.token,
      boards: [{ miroBoardId: 'uXjVnotHere0=' }],
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('MIRO_BOARD_NOT_VISIBLE')
    const pdf = await w.call(w.alice, 'POST', `/api/workspaces/${DEV_STUDIO}/imports/miro`, {
      token: w.miro.token,
      boards: [{ miroBoardId: RETRO_ID }],
      referencePdf: 'ver_0123456789abcdef',
    })
    expect(pdf.statusCode).toBe(400)
  })

  it('sync busy is tried again; sync refusing fails the board with a code, and the board is gone', async () => {
    w = await miroWorld()
    w.sync.failNext = [503]
    const a = await w.start(w.alice, [{ miroBoardId: RETRO_ID }])
    expect((await w.until(w.alice, a, (v) => v.status === 'done', 60_000)).boards[0]?.status).toBe('done')
    w.sync.failNext = [413]
    const b = await w.start(w.alice, [{ miroBoardId: RETRO_ID }])
    const failed = await w.until(w.alice, b, (v) => v.status === 'failed')
    expect(failed.boards[0]).toMatchObject({ errorCode: 'IMPORT_TOO_LARGE', boardId: null })
    const left = await w.api.db.query("SELECT id FROM boards WHERE status = 'importing'")
    expect(left.rows).toEqual([])
  }, 60_000)

  it('cancel mid-files: the board and every file it stored are removed', async () => {
    w = await miroWorld()
    const hold = w.hold()
    const importId = await w.start(w.alice, [{ miroBoardId: SPRINT_ID }, { miroBoardId: RETRO_ID }])
    await w.until(w.alice, importId, (v) => v.boards[0]?.progress.phase === 'files')
    const res = await w.call(w.alice, 'POST', importCancelPath(importId))
    expect(res.statusCode, res.body).toBe(202)
    hold.open()
    await w.runner.idle()
    const view = await w.view(w.alice, importId)
    expect(view.status).toBe('cancelled')
    expect(view.boards.map((b) => b.status)).toEqual(['cancelled', 'cancelled'])
    expect((await w.api.db.query("SELECT id FROM boards WHERE status = 'importing'")).rows).toEqual([])
    expect((await w.api.db.query('SELECT id FROM asset_versions')).rows).toEqual([])
  })

  it('pause mid-files, resume (the token again): files stored before the pause are not uploaded twice', async () => {
    w = await miroWorld()
    const hold = w.hold()
    const importId = await w.start(w.alice, [{ miroBoardId: SPRINT_ID }])
    await w.until(w.alice, importId, (v) => v.boards[0]?.progress.phase === 'files')
    expect((await w.call(w.alice, 'POST', importPausePath(importId))).statusCode).toBe(202)
    hold.open()
    await w.runner.idle()
    const paused = await w.view(w.alice, importId)
    expect(paused).toMatchObject({ status: 'paused', resumable: true, resumeNeedsToken: true })
    const stored = (
      await w.api.db.query('SELECT version_id FROM board_import_files WHERE status = $1', ['stored'])
    ).rows
    const before = (await w.api.db.query<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions'))
      .rows[0]?.n
    // without the token: refused; with it: done, nothing uploaded again
    const noToken = await w.call(w.alice, 'POST', importResumePath(importId), {})
    expect(noToken.statusCode).toBe(400)
    expect(noToken.json().error.code).toBe('IMPORT_SECRET_REQUIRED')
    const wrong = await w.call(w.alice, 'POST', importResumePath(importId), {
      token: 'a-wrong-token-0123456789abcdef',
    })
    expect(wrong.json().error.code).toBe('MIRO_TOKEN_INVALID')
    const filesBefore = w.miro.requests.filter((r) => r.origin === 'files').length
    const res = await w.call(w.alice, 'POST', importResumePath(importId), { token: w.miro.token })
    expect(res.statusCode, res.body).toBe(202)
    const done = await w.until(w.alice, importId, (v) => v.status === 'done')
    const versions = await versionsOf(done.boards[0]?.boardId as string)
    expect(versions).toHaveLength(2)
    const downloadsAfter = w.miro.requests.filter((r) => r.origin === 'files').length - filesBefore
    expect(downloadsAfter).toBe(2 - stored.length)
    expect(before).toBeLessThanOrEqual(2)
  })

  it('an api restart mid-files interrupts the job; after it, resume with the token finishes it without duplicates', async () => {
    const db = await openTestDb()
    const first = await miroWorld({ db })
    w = first
    const hold = first.hold()
    const importId = await first.start(first.alice, [{ miroBoardId: SPRINT_ID }])
    await first.until(first.alice, importId, (v) => v.boards[0]?.progress.phase === 'files')
    // the api shuts down (a deploy): the job's token goes with it
    const closing = first.api.close()
    hold.open()
    await closing
    first.miro.behaviour.holdFiles = null
    const second = await miroWorld({ db, miro: first.miro })
    w = second
    const view = await second.view(second.alice, importId)
    expect(view).toMatchObject({ status: 'interrupted', resumable: true, resumeNeedsToken: true })
    const res = await second.call(second.alice, 'POST', importResumePath(importId), {
      token: second.miro.token,
    })
    expect(res.statusCode, res.body).toBe(202)
    const done = await second.until(second.alice, importId, (v) => v.status === 'done')
    expect(await versionsOf(done.boards[0]?.boardId as string)).toHaveLength(2)
    await second.close()
    await first.miro.close()
    await db.close()
    w = undefined as never
  })

  it('the workspace quota: the board fails QUOTA_EXCEEDED and nothing of it stays', async () => {
    w = await miroWorld({ env: { DRAFTROOM_WORKSPACE_MAX_FILES: '1' } })
    const importId = await w.start(w.alice, [{ miroBoardId: SPRINT_ID }])
    const view = await w.until(w.alice, importId, (v) => v.status === 'failed')
    expect(view.boards[0]?.errorCode).toBe('QUOTA_EXCEEDED')
    expect((await w.api.db.query("SELECT id FROM boards WHERE status = 'importing'")).rows).toEqual([])
    expect((await w.api.db.query('SELECT id FROM asset_versions')).rows).toEqual([])
  })

  it('who may see and control a job: its starter; owners and admins see it; nobody else learns it exists', async () => {
    w = await miroWorld()
    const hold = w.hold()
    const importId = await w.start(w.bob, [{ miroBoardId: SPRINT_ID }])
    await w.until(w.bob, importId, (v) => v.boards[0]?.progress.phase === 'files')
    // alice owns the workspace: she sees it, but may not control it
    expect((await w.call(w.alice, 'GET', importJobPath(importId))).statusCode).toBe(200)
    expect((await w.call(w.alice, 'POST', importCancelPath(importId))).statusCode).toBe(404)
    expect((await w.call(w.alice, 'POST', importPausePath(importId))).statusCode).toBe(404)
    const all = (await w.call(w.alice, 'GET', importListPath(DEV_STUDIO))).json()
    expect(all.imports).toHaveLength(1)
    expect((await w.call(w.alice, 'GET', importListPath(DEV_STUDIO, true))).json().imports).toEqual([])
    // a stranger: 404 everywhere
    const erin = await w.api.login('erin')
    await w.api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      erin.userId,
      DEV_STUDIO,
    ])
    expect((await w.call(erin, 'GET', importJobPath(importId))).statusCode).toBe(404)
    expect((await w.call(erin, 'GET', importListPath(DEV_STUDIO))).statusCode).toBe(404)
    expect((await w.call(erin, 'GET', importReportPath(importId))).statusCode).toBe(404)
    expect((await w.call(w.alice, 'GET', '/api/imports/not-an-id')).statusCode).toBe(404)
    // the starter's own one-unfinished-job rule
    const busy = await w.call(w.bob, 'POST', `/api/workspaces/${DEV_STUDIO}/imports/miro`, {
      token: w.miro.token,
      boards: [{ miroBoardId: RETRO_ID }],
    })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().error.code).toBe('IMPORT_BUSY')
    hold.open()
    await w.until(w.bob, importId, (v) => v.status === 'done')
    // the CSV: its starter; alice owns no board of it (bob's private board), so not hers
    expect((await w.call(w.bob, 'GET', importReportPath(importId))).statusCode).toBe(200)
    expect((await w.call(w.alice, 'GET', importReportPath(importId))).statusCode).toBe(404)
  })
})

describe('the token', () => {
  it('never reaches a table, a log line or an answer, after jobs that fail, pause, resume and finish', async () => {
    w = await miroWorld()
    const raw = w.miro.token
    // a failing board (Miro answers 500 for its items), a 429 on the way, a finished one, a paused and resumed one
    w.miro.behaviour.fail = { path: /\/connectors$/, status: 500 }
    const a = await w.start(w.alice, [{ miroBoardId: RETRO_ID }])
    expect((await w.until(w.alice, a, (v) => v.status === 'failed')).boards[0]?.errorCode).toBe(
      'MIRO_UNAVAILABLE',
    )
    w.miro.behaviour.fail = null
    w.miro.behaviour.rateLimitNext = 1
    const hold = w.hold()
    const b = await w.start(w.alice, [{ miroBoardId: SPRINT_ID }])
    await w.until(w.alice, b, (v) => v.boards[0]?.progress.phase === 'files')
    await w.call(w.alice, 'POST', importPausePath(b))
    hold.open()
    await w.runner.idle()
    await w.call(w.alice, 'POST', importResumePath(b), { token: raw })
    await w.until(w.alice, b, (v) => v.status === 'done')
    await w.call(w.alice, 'GET', importReportPath(b))
    await w.listBoards(w.alice, { token: `${raw}x` })
    // every table, every row, as text
    const tables = await w.api.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    )
    expect(tables.rows.length).toBeGreaterThan(40)
    for (const { table_name } of tables.rows) {
      const rows = await w.api.db.query<{ t: string }>(
        `SELECT row_to_json(x)::text AS t FROM "${table_name}" x`,
      )
      for (const r of rows.rows) {
        expect(r.t.includes(raw), table_name).toBe(false)
        expect(r.t.includes(encodeURIComponent(raw)), table_name).toBe(false)
      }
    }
    expect(w.logs.length).toBeGreaterThan(0)
    for (const l of w.logs) expect(l.includes(raw), l).toBe(false)
    expect(w.bodies.length).toBeGreaterThan(5)
    for (const body of w.bodies) expect(body.includes(raw)).toBe(false)
    // and the sync seed bodies hold none either (nor a signed URL)
    expect(JSON.stringify(w.sync.miroSeeds).includes(raw)).toBe(false)
    expect(JSON.stringify(w.sync.miroSeeds)).not.toContain('Signature=')
    // three jobs, a 429 wait and a scan of every table: about 6 s on this PC, past vitest's default 5 s
  }, 30_000)
})
