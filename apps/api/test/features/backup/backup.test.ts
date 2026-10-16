// Board backup and restore (wave R, WS4; src/features/backup, docs/WAVE-R-CONTRACTS.md §5), on PGlite:
//   - the round trip: a board with a frame, a labelled note, a bound arrow, a group, an image and a placed PDF page is
//     downloaded (a ticket, then the direct stream), restored into another workspace and comes back equal: the same
//     elements (fresh ids, the same structure), the same file bytes as NEW versions of the new private board, the
//     start view's frame, while the original is untouched. Comments, history, votes and members are not part of a
//     backup (votes and reactions are stripped from the elements, as the JSON export strips them);
//   - the download's guards: the export policy (403 EXPORT_DISABLED, at the ticket and again at the download), the
//     ticket (single use, its board, one minute, its session still signed in), the size limits;
//   - the restore's: a non-creator is refused before a byte is read; hostile and broken backups are refused (not a
//     ZIP, a traversal name, a newer Lobby, a bomb, a file whose bytes are not its sha256, an element with a `data:`
//     link, over the quota), and nothing is left behind: no board, no version, no stored file, no spool.
import { PassThrough } from 'node:stream'
import { bufferSource, openBackup, streamZipEntry, type ZipEntry } from '@draftroom/board-archive'
import { CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { BACKUP_INTERNAL_ONLY_MESSAGE } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_DOWNLOADS_PER_PROCESS } from '../../../src/features/backup/index.ts'
import { RESTORING_TITLE, spoolKey } from '../../../src/features/backup/restore.ts'
import { importRunnerOf } from '../../../src/features/imports/index.ts'
import { originalKey } from '../../../src/files/blobs.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../../helpers.ts'
import { newProject, setProject } from '../outside/internal-only-support.ts'
import {
  base,
  collect,
  type El,
  LobbySync,
  makeBackup,
  PDF,
  PNG,
  sha256,
  sourceBoard,
  uploadAs,
} from './support.ts'

let api: TestApi
let sync: LobbySync
let alice: Client // Dev Studio's owner (a creator); restores into her personal workspace
let carol: Client // a Dev Studio member, given viewer on the board
let boardId: string
let photo: { assetId: string; versionId: string }
let doc: { assetId: string; versionId: string }

async function setup(env: Record<string, string> = {}) {
  sync = new LobbySync()
  api = await createTestApi({ deps: { syncInternal: sync }, env })
  alice = await api.login('alice')
  carol = await api.login('carol')
  boardId = await createBoard(alice, DEV_STUDIO, 'Retro')
  photo = await uploadAs(api, alice, boardId, 'photo.png', 'image/png', PNG)
  doc = await uploadAs(api, alice, boardId, 'deck.pdf', 'application/pdf', PDF)
  sync.setBoard(boardId, sourceBoard(photo, doc), { startView: { x: 0, y: 0, w: 800, h: 600, frameId: 'F' } })
}

/** every key a restore wrote under imports/ (its spool), and those the blob store still holds */
let spooled: Set<string>
const spooledLeft = async () => {
  const left: string[] = []
  for (const key of spooled) if (await api.blobs.head(key)) left.push(key)
  return left
}

beforeEach(async () => {
  await setup()
  spooled = new Set()
  const put = api.blobs.put.bind(api.blobs)
  api.blobs.put = (key, body, opts) => {
    if (key.startsWith('imports/')) spooled.add(key)
    return put(key, body, opts)
  }
})
afterEach(() => api.close())

const runner = () => {
  const r = importRunnerOf(api.app)
  if (!r) throw new Error('no runner')
  return r
}

async function download(c: Client, bid = boardId) {
  const t = await c.req('POST', `/api/boards/${bid}/backup/ticket`)
  if (t.statusCode !== 200) return { ticket: t, file: null }
  const { url } = t.json() as { url: string }
  // the download itself carries no cookie (on Render it is another origin): the ticket alone
  const file = await api.app.inject({ method: 'GET', url })
  return { ticket: t, file, url }
}

const restore = (c: Client, workspaceId: string, body: Buffer, query = '') =>
  c.req('POST', `/api/workspaces/${workspaceId}/backups${query}`, body, {
    'content-type': 'application/vnd.lobby.board+zip',
  })

const counts = async () => {
  const n = async (sql: string) =>
    (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).n
  return {
    boards: await n('boards'),
    versions: await n('asset_versions'),
    pendingDeletes: await n('asset_gc_pending_deletes'),
  }
}

/** An element as the board shows it, without ids: what a round trip must keep, references by what they point at. */
function shape(el: El, all: Map<string, El>) {
  const kind = (id: unknown) => {
    const t = typeof id === 'string' ? all.get(id) : undefined
    return t ? `${t.type}:${t.name ?? t.text ?? t.x}` : null
  }
  const lobby = { ...(el.customData?.lobby ?? {}) }
  if (lobby.file) lobby.file = { ...lobby.file, assetId: '*', versionId: '*' }
  return {
    type: el.type,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    text: el.text ?? null,
    name: el.name ?? null,
    container: kind(el.containerId),
    frame: kind(el.frameId),
    start: kind(el.startBinding?.elementId),
    end: kind(el.endBinding?.elementId),
    bound: (el.boundElements ?? [])
      .map((b: { id: string; type: string }) => `${b.type}>${kind(b.id)}`)
      .sort(),
    groups: (el.groupIds ?? []).length,
    page: typeof el.fileId === 'string' ? (/\.p\d+$/.exec(el.fileId)?.[0] ?? '') : null,
    lobby,
  }
}
const shapes = (els: El[]) => {
  const all = new Map(els.map((e) => [e.id, e]))
  return els.map((e) => shape(e, all)).sort((a, b) => `${a.type}${a.x}`.localeCompare(`${b.type}${b.x}`))
}

describe('backup and restore: the round trip', () => {
  it('a board with images, a frame and its structure comes back equal, as a new private board of new files', async () => {
    const before = structuredClone(sync.boards.get(boardId))
    const { ticket, file } = await download(alice)
    expect(ticket.statusCode).toBe(200)
    const t = ticket.json() as { url: string; expiresAt: number }
    // no DRAFTROOM_EVENTS_ORIGIN in tests: the same origin (on Render: the api's own origin)
    expect(t.url).toMatch(new RegExp(`^/api/boards/${boardId}/backup\\?ticket=bkt_[A-Za-z0-9_-]{43}$`))
    expect(t.expiresAt - api.clock.now().getTime()).toBeLessThanOrEqual(60_000)
    expect(file?.statusCode).toBe(200)
    expect(file?.headers['content-type']).toBe('application/vnd.lobby.board+zip')
    expect(file?.headers['content-disposition']).toContain('attachment; filename="Retro.lobby"')
    expect(file?.headers['cache-control']).toBe('no-store')
    const zip = file?.rawPayload as Buffer
    const opened = await openBackup(bufferSource(zip), { contractsRev: CONTRACTS_REV })
    expect(opened.manifest).toMatchObject({ title: 'Retro', counts: { elements: 7, files: 2 } })
    expect(opened.manifest.files.map((f) => [f.versionId, f.sha256, f.omitted]).sort()).toEqual(
      [
        [photo.versionId, sha256(PNG), false],
        [doc.versionId, sha256(PDF), false],
      ].sort(),
    )

    // restored by alice into her personal workspace (another workspace, the same deployment)
    const target = alice.personalWorkspaceId
    const res = await restore(alice, target, zip)
    expect(res.statusCode, res.body).toBe(202)
    const { importId, location } = res.json() as { importId: string; location: string }
    expect(location).toBe(`/api/imports/${importId}`)
    await runner().idle()
    const row = await api.db.one<{ status: string; board_id: string; source_ref: string; title: string }>(
      'SELECT status, board_id, source_ref, title FROM board_imports WHERE batch_id = $1',
      [importId],
    )
    // the job names its spool (rsp_…), queued once the upload was whole and checked
    expect(row).toMatchObject({ status: 'done', title: 'Retro' })
    expect(row.source_ref).toMatch(/^rsp_[0-9A-Za-z]{20}$/)
    const newId = row.board_id
    expect(newId).not.toBe(boardId)
    const board = await alice.req('GET', `/api/boards/${newId}`)
    expect(board.statusCode).toBe(200)
    expect(board.json()).toMatchObject({
      board: { title: 'Retro', visibility: 'private', workspaceId: target },
    })
    expect((await carol.req('GET', `/api/boards/${newId}`)).statusCode).toBe(404)

    // the elements: the same board, fresh ids, votes stripped (as the JSON export strips them)
    const seeded = sync.seeds.find((s) => s.boardId === newId)?.body
    expect(seeded?.format).toBe('lobby-elements')
    const restored = seeded?.elements as El[]
    const expected = ((before?.elements ?? []) as El[]).map((e) => {
      const c = structuredClone(e)
      if (c.customData?.lobby) delete c.customData.lobby['plusOne:usr_voter']
      return c
    })
    expect(shapes(restored)).toEqual(shapes(expected))
    const oldIds = new Set(((before?.elements ?? []) as El[]).map((e) => e.id))
    for (const el of restored) expect(oldIds.has(el.id), el.id).toBe(false)
    // the start view's frame follows the frame
    const frame = restored.find((e) => e.type === 'frame') as El
    expect(seeded?.doc).toEqual({ startView: { x: 0, y: 0, w: 800, h: 600, frameId: frame.id } })

    // the files: NEW versions of the new board, the same bytes, queued for previews
    const versions = await api.db.query<{
      id: string
      asset_id: string
      workspace_id: string
      sha256: string
      kind: string
      name: string
      uploaded_by: string
    }>(
      'SELECT id, asset_id, workspace_id, sha256, kind, name, uploaded_by FROM asset_versions WHERE board_id = $1',
      [newId],
    )
    expect(versions.rows.map((v) => [v.sha256, v.kind, v.name]).sort()).toEqual(
      [
        [sha256(PNG), 'image', 'photo.png'],
        [sha256(PDF), 'pdf', 'deck.pdf'],
      ].sort(),
    )
    for (const v of versions.rows) {
      expect([photo.versionId, doc.versionId]).not.toContain(v.id)
      expect([photo.assetId, doc.assetId]).not.toContain(v.asset_id)
      expect(v).toMatchObject({ workspace_id: target, uploaded_by: alice.userId })
      const obj = await api.blobs.get(originalKey(v.asset_id, v.id))
      expect(sha256(await collect(obj?.body as AsyncIterable<Uint8Array>))).toBe(v.sha256)
      const served = await alice.req('GET', `/files/${v.asset_id}/${v.id}/original?board=${newId}`)
      expect(served.statusCode).toBe(200)
    }
    const jobs = await api.db.query<{ status: string }>(
      'SELECT j.status FROM preview_jobs j JOIN asset_versions v ON v.id = j.version_id WHERE v.board_id = $1',
      [newId],
    )
    expect(jobs.rows.map((j) => j.status)).toEqual(['queued', 'queued'])
    // the images show the new versions (a PDF page keeps its page), their facts the new ids
    const byVersion = new Map(versions.rows.map((v) => [v.sha256, v]))
    const image = restored.find((e) => e.type === 'image' && !e.fileId.includes('.p')) as El
    const page = restored.find((e) => e.type === 'image' && e.fileId.includes('.p')) as El
    const newPhoto = byVersion.get(sha256(PNG))
    const newDoc = byVersion.get(sha256(PDF))
    expect(image.fileId).toBe(newPhoto?.id)
    expect(image.customData.lobby.file).toMatchObject({
      assetId: newPhoto?.asset_id,
      versionId: newPhoto?.id,
    })
    expect(page.fileId).toBe(`${newDoc?.id}.p2`)
    expect(page.customData.lobby.file).toMatchObject({ assetId: newDoc?.asset_id, versionId: newDoc?.id })

    // the original is unchanged; the spool is gone; the board was audited as a backup restore
    expect(sync.boards.get(boardId)).toEqual(before)
    const kept = await api.db.query('SELECT 1 FROM asset_versions WHERE id = ANY($1::text[])', [
      [photo.versionId, doc.versionId],
    ])
    expect(kept.rows).toHaveLength(2)
    expect(await api.blobs.head(spoolKey(row.source_ref))).toBeNull()
    expect(await spooledLeft()).toEqual([])
    const audit = await api.db.one<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_events WHERE action = 'board.create' AND target = $1",
      [newId],
    )
    expect(audit.detail).toMatchObject({ via: 'backup', elements: 7, files: 2 })
  })

  it('a title given with the restore is the new board’s; a restore into the same workspace works too', async () => {
    const zip = (await download(alice)).file?.rawPayload as Buffer
    const res = await restore(alice, DEV_STUDIO, zip, '?title=From%20backup')
    expect(res.statusCode, res.body).toBe(202)
    await runner().idle()
    const row = await api.db.one<{ board_id: string; status: string }>(
      'SELECT board_id, status FROM board_imports WHERE batch_id = $1',
      [(res.json() as { importId: string }).importId],
    )
    expect(row.status).toBe('done')
    expect((await alice.req('GET', `/api/boards/${row.board_id}`)).json()).toMatchObject({
      board: { title: 'From backup', workspaceId: DEV_STUDIO, visibility: 'private' },
    })
  })
})

describe('the download’s guards', () => {
  it('the export policy: a limited viewer gets no ticket (403 EXPORT_DISABLED), others do', async () => {
    await alice.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'viewer' })
    expect((await download(carol)).file?.statusCode).toBe(200)
    const policy = { exportPolicy: 'editors' }
    expect((await alice.req('PUT', `/api/boards/${boardId}/export-policy`, policy)).statusCode).toBe(200)
    const { ticket } = await download(carol)
    expect(ticket.statusCode).toBe(403)
    expect(ticket.json().error.code).toBe('EXPORT_DISABLED')
    // the owner still can
    expect((await download(alice)).file?.statusCode).toBe(200)
  })

  it('the policy is checked again when the download starts', async () => {
    await alice.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'viewer' })
    const t = await carol.req('POST', `/api/boards/${boardId}/backup/ticket`)
    expect(t.statusCode).toBe(200)
    await alice.req('PUT', `/api/boards/${boardId}/export-policy`, { exportPolicy: 'editors' })
    const file = await api.app.inject({ method: 'GET', url: (t.json() as { url: string }).url })
    expect(file.statusCode).toBe(403)
    expect(file.json().error.code).toBe('EXPORT_DISABLED')
  })

  it('someone who cannot see the board gets 404, at the ticket', async () => {
    expect((await carol.req('POST', `/api/boards/${boardId}/backup/ticket`)).statusCode).toBe(404)
  })

  it('a ticket is single use, for its board, for a minute, and only while its session lasts', async () => {
    const t1 = (await alice.req('POST', `/api/boards/${boardId}/backup/ticket`)).json() as { url: string }
    expect((await api.app.inject({ method: 'GET', url: t1.url })).statusCode).toBe(200)
    expect((await api.app.inject({ method: 'GET', url: t1.url })).statusCode).toBe(401)
    const other = await createBoard(alice, DEV_STUDIO, 'Other')
    const t2 = (await alice.req('POST', `/api/boards/${boardId}/backup/ticket`)).json() as { url: string }
    const ticket = new URL(t2.url, ORIGIN).searchParams.get('ticket')
    const elsewhere = `/api/boards/${other}/backup?ticket=${ticket}`
    expect((await api.app.inject({ method: 'GET', url: elsewhere })).statusCode).toBe(401)
    const t3 = (await alice.req('POST', `/api/boards/${boardId}/backup/ticket`)).json() as { url: string }
    api.clock.advance(61_000)
    expect((await api.app.inject({ method: 'GET', url: t3.url })).statusCode).toBe(401)
    const t4 = (await alice.req('POST', `/api/boards/${boardId}/backup/ticket`)).json() as { url: string }
    expect((await alice.req('POST', '/api/auth/logout')).statusCode).toBeLessThan(300)
    expect((await api.app.inject({ method: 'GET', url: t4.url })).statusCode).toBe(401)
    for (const url of [`/api/boards/${boardId}/backup`, `/api/boards/${boardId}/backup?ticket=evt_x`])
      expect((await api.app.inject({ method: 'GET', url })).statusCode, url).toBe(401)
  })

  it('a board over the file limits is refused at the ticket (413 BACKUP_TOO_LARGE), with the numbers', async () => {
    await api.db.query('UPDATE asset_versions SET size_bytes = $2 WHERE id = $1', [
      photo.versionId,
      3 * 1024 ** 3,
    ])
    const t = await alice.req('POST', `/api/boards/${boardId}/backup/ticket`)
    expect(t.statusCode).toBe(413)
    expect(t.json().error).toMatchObject({ code: 'BACKUP_TOO_LARGE' })
    expect(t.json().error.message).toContain('3.0 GB of files, of at most 2.0 GB')
  })

  it('a stored file that no longer matches its sha256 ends the download instead of finishing a broken backup', async () => {
    await api.blobs.put(originalKey(photo.assetId, photo.versionId), Buffer.alloc(PNG.length, 1), {
      contentType: 'application/octet-stream',
      contentLength: PNG.length,
    })
    const t = (await alice.req('POST', `/api/boards/${boardId}/backup/ticket`)).json() as { url: string }
    // the stream fails part way: the response is destroyed, never ended as if it were whole
    const res = await api.app.inject({ method: 'GET', url: t.url }).catch((e: unknown) => e)
    expect(res).toBeInstanceOf(Error)
    expect((res as Error).message).toContain('destroyed')
  })
})

describe('the restore’s guards', () => {
  it('a non-creator member is refused before anything is read or made', async () => {
    const pat = await api.login('pat', 'Pat', { email: 'pat@client.example.test' })
    await api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'admin', now())`,
      [DEV_STUDIO, pat.userId],
    )
    const zip = (await download(alice)).file?.rawPayload as Buffer
    const before = await counts()
    const res = await restore(pat, DEV_STUDIO, zip)
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('CREATOR_REQUIRED')
    expect(await counts()).toEqual(before)
    expect((await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_imports')).n).toBe(0)
  })

  it('a creator outside the workspace gets 404; a project of another workspace is refused', async () => {
    const zip = await makeBackup()
    const erin = await api.login('erin')
    expect((await restore(erin, alice.personalWorkspaceId, zip)).statusCode).toBe(404)
    const elsewhere = await restore(alice, DEV_STUDIO, zip, '?projectId=prj_0123456789abcdefghij')
    expect(elsewhere.statusCode).toBe(400)
    expect((await restore(alice, DEV_STUDIO, zip, '?evil=1')).statusCode).toBe(400)
  })

  const hostile = async (name: string, body: Buffer, status: number, code: string) => {
    const before = await counts()
    const res = await restore(alice, DEV_STUDIO, body)
    expect(res.statusCode, `${name}: ${res.body}`).toBe(status)
    expect(res.json().error.code, name).toBe(code)
    await runner().idle()
    // checked before any job is made: no job, no board, no version, and the spool removed
    expect((await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_imports')).n, name).toBe(0)
    expect(spooled.size, name).toBeGreaterThan(0)
    expect(await spooledLeft(), name).toEqual([])
    expect(await counts(), name).toEqual(before)
    spooled.clear()
  }

  it('hostile and broken backups are refused at once, and leave nothing behind', async () => {
    const good = await makeBackup()
    await hostile('not a zip', Buffer.from('{"format":"lobby-board","version":2}'), 400, 'BACKUP_INVALID')
    await hostile('truncated', good.subarray(0, good.length - 30), 400, 'BACKUP_INVALID')
    // an extra entry with a traversal name (same length as board.json, so the archive stays well-formed)
    const evil = Buffer.from(good)
    let at = evil.indexOf('board.json')
    while (at >= 0) {
      evil.write('../x.jsonx', at, 'latin1')
      at = evil.indexOf('board.json', at + 1)
    }
    await hostile('traversal', evil, 400, 'BACKUP_INVALID')
    const newer = await makeBackup({ contractsRev: CONTRACTS_REV + 1 })
    await hostile('newer', newer, 400, 'BACKUP_FROM_NEWER_LOBBY')
    // 40 MiB of board.json that deflates to a few KiB: refused before it is inflated
    const pad = { customData: { lobby: { pad: 'a'.repeat(40 * 1024 * 1024) } } }
    const bomb = await makeBackup({ elements: [base('X', 'rectangle', pad)] })
    await hostile('bomb', bomb, 413, 'BACKUP_TOO_LARGE')
  })

  it('a file whose bytes are not its sha256 fails the job; its board and stored files are removed', async () => {
    const zip = (await download(alice)).file?.rawPayload as Buffer
    // the photo's bytes swapped for others of the same length, with a CRC to match (a forger can fix CRCs)
    const forged = Buffer.from(zip)
    const at = forged.indexOf(PNG)
    expect(at).toBeGreaterThan(0)
    const fake = Buffer.alloc(PNG.length, 7)
    fake.copy(forged, at)
    const { crc32 } = await import('node:zlib')
    const fix = (buf: Buffer, crc: number, next: number) => {
      let i = buf.indexOf(Buffer.from([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24]))
      while (i >= 0) {
        buf.writeUInt32LE(next, i)
        i = buf.indexOf(Buffer.from([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24]), i + 1)
      }
    }
    fix(forged, crc32(PNG), crc32(fake))
    // the archive itself is well-formed (the CRCs agree): only the sha256 tells
    const forgedBackup = await openBackup(bufferSource(forged), { contractsRev: CONTRACTS_REV })
    const entry = forgedBackup.files.get(sha256(PNG)) as ZipEntry
    for await (const _ of streamZipEntry(bufferSource(forged), entry)) {
      // drain: no CRC error
    }
    const before = await counts()
    const res = await restore(alice, alice.personalWorkspaceId, forged)
    expect(res.statusCode, res.body).toBe(202)
    await runner().idle()
    const row = await api.db.one<{ status: string; error_code: string; board_id: string | null }>(
      'SELECT status, error_code, board_id FROM board_imports',
    )
    expect(row).toMatchObject({ status: 'failed', error_code: 'BACKUP_INVALID', board_id: null })
    const after = await counts()
    expect({ boards: after.boards, versions: after.versions }).toEqual({
      boards: before.boards,
      versions: before.versions,
    })
    expect(after.pendingDeletes).toBe(0)
  })

  it('an element the server refuses (a data: link) fails the job with BACKUP_INVALID', async () => {
    const zip = await makeBackup({ elements: [base('X', 'rectangle', { link: 'data:text/html,<b>x</b>' })] })
    const res = await restore(alice, DEV_STUDIO, zip)
    expect(res.statusCode, res.body).toBe(202)
    await runner().idle()
    expect(await api.db.one('SELECT status, error_code FROM board_imports')).toMatchObject({
      status: 'failed',
      error_code: 'BACKUP_INVALID',
    })
    const made = await api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM boards WHERE title = 'Backed up'",
    )
    expect(made.n).toBe(0)
  })

  it('a file missing from the backup (omitted) leaves its element as a missing file; the rest is restored', async () => {
    const zip = await makeBackup({
      elements: [
        base('I', 'image', { fileId: photo.versionId, scale: [1, 1], crop: null, status: 'saved' }),
        base('J', 'image', {
          fileId: doc.versionId,
          scale: [1, 1],
          crop: null,
          status: 'saved',
          index: 'a2',
        }),
      ],
      files: [
        {
          versionId: photo.versionId,
          assetId: photo.assetId,
          name: 'photo.png',
          mimeType: 'image/png',
          kind: 'image',
          bytes: PNG,
        },
        {
          versionId: doc.versionId,
          assetId: doc.assetId,
          name: 'deck.pdf',
          mimeType: 'application/pdf',
          kind: 'pdf',
          bytes: PDF,
          omitted: true,
        },
      ],
    })
    const res = await restore(alice, alice.personalWorkspaceId, zip)
    expect(res.statusCode, res.body).toBe(202)
    await runner().idle()
    const view = await runner().view((res.json() as { importId: string }).importId, alice.userId)
    expect(view?.status).toBe('done')
    expect(view?.boards[0]?.summary).toMatchObject({ notes: { 'file-not-included': 1, 'file-missing': 1 } })
    const newId = view?.boards[0]?.boardId as string
    const els = sync.seeds.find((s) => s.boardId === newId)?.body.elements as El[]
    const versions = await api.db.query<{ id: string }>('SELECT id FROM asset_versions WHERE board_id = $1', [
      newId,
    ])
    expect(versions.rows).toHaveLength(1)
    expect(els.map((e) => e.fileId).sort()).toEqual([versions.rows[0]?.id, doc.versionId].sort())
  })

  it('over the workspace quota: refused from Content-Length at once, or by file count in the job (nothing left)', async () => {
    await api.close()
    await setup({ DRAFTROOM_WORKSPACE_MAX_FILES: '3' })
    const zip = (await download(alice)).file?.rawPayload as Buffer
    // Dev Studio holds 2 files: one more fits, two do not
    const before = await counts()
    const res = await restore(alice, DEV_STUDIO, zip)
    expect(res.statusCode, res.body).toBe(202)
    await runner().idle()
    expect(await api.db.one('SELECT status, error_code FROM board_imports')).toMatchObject({
      status: 'failed',
      error_code: 'QUOTA_EXCEEDED',
    })
    const after = await counts()
    expect({ boards: after.boards, versions: after.versions }).toEqual({
      boards: before.boards,
      versions: before.versions,
    })
    await api.close()
    await setup({ DRAFTROOM_WORKSPACE_QUOTA_MB: '1' })
    const big = await makeBackup({
      files: [
        {
          versionId: 'ver_0123456789abcdefghij',
          assetId: 'ast_0123456789abcdefghij',
          name: 'big.bin',
          mimeType: 'application/octet-stream',
          kind: 'other',
          bytes: Buffer.alloc(1_200_000, 3),
        },
      ],
    })
    const refused = await restore(alice, DEV_STUDIO, big)
    expect(refused.statusCode).toBe(413)
    expect(refused.json().error.code).toBe('QUOTA_EXCEEDED')
    expect((await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_imports')).n).toBe(0)
  })

  it('one restore at a time per person: a second is refused before its body is read', async () => {
    const zip = await makeBackup()
    await api.db.query(
      `INSERT INTO board_imports (id, batch_id, workspace_id, created_by, source, title, status)
       VALUES ('imb_0123456789abcdefghij', 'imp_0123456789abcdefghij', $1, $2, 'lobby-backup', 'Busy', 'running')`,
      [DEV_STUDIO, alice.userId],
    )
    const res = await restore(alice, DEV_STUDIO, zip)
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('IMPORT_BUSY')
  })
})

describe('internal only (DOMAIN-ACCESS §23): a backup does not take an internal-only project’s files out', () => {
  let project: string
  beforeEach(async () => {
    project = await newProject(alice, DEV_STUDIO, 'Secret')
    expect((await alice.req('PATCH', `/api/boards/${boardId}`, { projectId: project })).statusCode).toBe(200)
    expect((await setProject(alice, project, true)).statusCode).toBe(200)
    await alice.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'viewer' })
  })
  const manifestOf = async (c: Client) => {
    const { file } = await download(c)
    expect(file?.statusCode, file?.body).toBe(200)
    const zip = file?.rawPayload as Buffer
    return { zip, manifest: (await openBackup(bufferSource(zip), { contractsRev: CONTRACTS_REV })).manifest }
  }

  it('a member’s backup lists the files it can view only on that project’s boards as omitted; an owner’s includes them', async () => {
    const mine = await manifestOf(carol)
    expect(mine.manifest.internalOnly).toBe(true)
    expect(mine.manifest.counts.files).toBe(0)
    expect(mine.manifest.files.map((f) => [f.versionId, f.omitted]).sort()).toEqual(
      [
        [photo.versionId, true],
        [doc.versionId, true],
      ].sort(),
    )
    const owners = await manifestOf(alice)
    expect(owners.manifest).toMatchObject({ internalOnly: true, counts: { files: 2 } })
    // a file also shown on a board outside the project is outside the switch already: included for the member
    const open = await createBoard(alice, DEV_STUDIO, 'Open')
    await api.db.query(
      'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
      [DEV_STUDIO, open, photo.assetId, photo.versionId],
    )
    await alice.req('PUT', `/api/boards/${open}/members/${carol.userId}`, { role: 'viewer' })
    const after = await manifestOf(carol)
    expect(after.manifest.files.find((f) => f.versionId === photo.versionId)?.omitted).toBe(false)
    expect(after.manifest.files.find((f) => f.versionId === doc.versionId)?.omitted).toBe(true)
    // a board outside every internal-only scope makes a backup without the flag
    expect((await setProject(alice, project, false)).statusCode).toBe(200)
    expect((await manifestOf(carol)).manifest).toMatchObject({ internalOnly: false, counts: { files: 2 } })
  })

  it('a restore of an internal-only backup outside every internal-only scope needs a workspace owner or admin creator', async () => {
    const { zip } = await manifestOf(alice)
    const before = await counts()
    const res = await restore(carol, DEV_STUDIO, zip)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error).toMatchObject({ code: 'INTERNAL_ONLY', message: BACKUP_INTERNAL_ONLY_MESSAGE })
    const open = await newProject(alice, DEV_STUDIO, 'Open')
    expect((await restore(carol, DEV_STUDIO, zip, `?projectId=${open}`)).statusCode).toBe(409)
    expect(await counts()).toEqual(before)
    expect((await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_imports')).n).toBe(0)
    expect(spooled.size).toBe(2)
    expect(await spooledLeft()).toEqual([])
    // into the internal-only project: allowed
    const inside = await restore(carol, DEV_STUDIO, zip, `?projectId=${project}`)
    expect(inside.statusCode, inside.body).toBe(202)
    await runner().idle()
    // the owner (a creator) may restore it anywhere
    const owner = await restore(alice, DEV_STUDIO, zip)
    expect(owner.statusCode, owner.body).toBe(202)
    await runner().idle()
    const rows = await api.db.query<{ status: string }>('SELECT status FROM board_imports')
    expect(rows.rows.map((r) => r.status)).toEqual(['done', 'done'])
  })
})

describe('the backup routes’ slots (BACKUP_DOWNLOADS_PER_PROCESS)', () => {
  /** sync's snapshot (the start of every plan) held until `open()` */
  const gate = () => {
    let release: () => void = () => {}
    const opened = new Promise<void>((r) => {
      release = r
    })
    const real = sync.snapshot.bind(sync)
    let waiting = 0
    sync.snapshot = async (id: string) => {
      waiting++
      await opened
      return real(id)
    }
    return { open: () => release(), waiting: () => waiting }
  }
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
    expect(ok()).toBe(true)
  }

  it('tickets: a plan takes a slot before it is built; past the slots the answer is 503 at once', async () => {
    const g = gate()
    const first = Array.from({ length: BACKUP_DOWNLOADS_PER_PROCESS }, () =>
      alice.req('POST', `/api/boards/${boardId}/backup/ticket`),
    )
    await until(() => g.waiting() === BACKUP_DOWNLOADS_PER_PROCESS)
    const asked = alice.req('POST', `/api/boards/${boardId}/backup/ticket`)
    const extra = await Promise.race([asked, new Promise<null>((r) => setTimeout(() => r(null), 1_000))])
    expect(g.waiting()).toBe(BACKUP_DOWNLOADS_PER_PROCESS)
    g.open()
    expect(extra?.statusCode).toBe(503)
    expect(extra?.json().error.code).toBe('TOO_MANY_BACKUPS')
    await asked
    for (const r of await Promise.all(first)) expect(r.statusCode).toBe(200)
    // the slots are free again
    expect((await alice.req('POST', `/api/boards/${boardId}/backup/ticket`)).statusCode).toBe(200)
  })

  it('downloads: the slot is taken before the plan, so concurrent downloads never build more plans than slots', async () => {
    // a session keeps at most four tickets: the fifth from a second session of alice's
    const again = await api.login('alice')
    const urls: string[] = []
    for (let i = 0; i <= BACKUP_DOWNLOADS_PER_PROCESS; i++) {
      const c = i < BACKUP_DOWNLOADS_PER_PROCESS ? alice : again
      urls.push(((await c.req('POST', `/api/boards/${boardId}/backup/ticket`)).json() as { url: string }).url)
    }
    const g = gate()
    const all = urls.map((url) => api.app.inject({ method: 'GET', url }))
    await until(() => g.waiting() >= BACKUP_DOWNLOADS_PER_PROCESS)
    await new Promise((r) => setTimeout(r, 100))
    expect(g.waiting()).toBe(BACKUP_DOWNLOADS_PER_PROCESS)
    g.open()
    const codes = (await Promise.all(all)).map((r) => r.statusCode).sort()
    expect(codes).toEqual([...Array(BACKUP_DOWNLOADS_PER_PROCESS).fill(200), 503])
    // all released: a new ticket and download work
    const t = (await alice.req('POST', `/api/boards/${boardId}/backup/ticket`)).json() as { url: string }
    expect((await api.app.inject({ method: 'GET', url: t.url })).statusCode).toBe(200)
  })
})

describe('a restore’s upload', () => {
  it('holds no import slot: the job is queued only once the whole body has arrived', async () => {
    const zip = await makeBackup({ title: 'Slow' })
    const body = new PassThrough()
    const pending = api.app.inject({
      method: 'POST',
      url: `/api/workspaces/${DEV_STUDIO}/backups`,
      payload: body,
      headers: {
        origin: ORIGIN,
        cookie: alice.cookie,
        'content-type': 'application/vnd.lobby.board+zip',
        'content-length': String(zip.length),
      },
    })
    body.write(zip.subarray(0, 100))
    await new Promise((r) => setTimeout(r, 150))
    // half an upload: no job, so no slot of the runner's (two per process) is held by it
    expect((await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_imports')).n).toBe(0)
    body.end(zip.subarray(100))
    const res = await pending
    expect(res.statusCode, res.body).toBe(202)
    await runner().idle()
    const row = await api.db.one<{ status: string; title: string }>('SELECT status, title FROM board_imports')
    expect(row).toEqual({ status: 'done', title: 'Slow' })
    expect(await spooledLeft()).toEqual([])
  })

  it('the title (the manifest’s or the one typed) is cleaned as a board title: NUL, bidi and control characters', async () => {
    const zip = await makeBackup({ title: ' Pi\u0000tch‮  v2\u0007​ ' })
    const res = await restore(alice, DEV_STUDIO, zip)
    expect(res.statusCode, res.body).toBe(202)
    await runner().idle()
    const row = await api.db.one<{ board_id: string }>('SELECT board_id FROM board_imports')
    const title = async (id: string) =>
      (await api.db.one<{ title: string }>('SELECT title FROM boards WHERE id = $1', [id])).title
    expect(await title(row.board_id)).toBe('Pitch v2')
    await api.db.query('DELETE FROM board_imports')
    const typed = await restore(alice, DEV_STUDIO, zip, `?title=${encodeURIComponent('⁧From⁩ backup\u0001')}`)
    expect(typed.statusCode, typed.body).toBe(202)
    await runner().idle()
    const row2 = await api.db.one<{ board_id: string }>('SELECT board_id FROM board_imports')
    expect(await title(row2.board_id)).toBe('From backup')
    await api.db.query('DELETE FROM board_imports')
    // nothing left once cleaned: the default
    const blank = await makeBackup({ title: '‮\u0000​' })
    expect((await restore(alice, DEV_STUDIO, blank)).statusCode).toBe(202)
    await runner().idle()
    const row3 = await api.db.one<{ board_id: string }>('SELECT board_id FROM board_imports')
    expect(await title(row3.board_id)).toBe(RESTORING_TITLE)
  })
})
