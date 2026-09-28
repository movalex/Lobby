// Office documents on the file routes (wave 4): an upload named .docx/.pptx/.xlsx/.odt/.odp/.ods is
// kind 'pdf' (previewed as the pages of its PDF conversion by the worker) with its own 100 MB limit, and
// its original is ALWAYS served as a download: an Office type is never inline, before or after the
// worker confirms it. Who may do what is unchanged: editors upload, anyone who can view the board sees
// the previews, and the original follows the board's export policy like every other file.
import { type AssetVersionMeta, LIMITS, OFFICE_FORMATS } from '@draftroom/dev-assets'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uploadLimitLabel } from '../../src/files/mime.ts'
import { userFailure } from '../../src/worker/protocol.ts'
import {
  addDerivative,
  parseRaw,
  rawExchange,
  req,
  setVersion,
  startApp,
  type TestApp,
  upload,
  uploadHead,
} from './helpers.ts'

let t: TestApp
beforeAll(async () => {
  t = await startApp()
})
afterAll(async () => {
  await t.stop()
})
beforeEach(() => {
  t.auth.roles = { 'board-a': 'editor' }
})

const original = (m: AssetVersionMeta) => `/files/${m.assetId}/${m.versionId}/original?board=${m.boardId}`
const DOCX = OFFICE_FORMATS[0]?.mime ?? ''
// A few bytes stand in for the document: the api never looks inside, the worker does.
const body = Buffer.from('PK\u0003\u0004 stand-in office bytes')

describe('Office uploads', () => {
  it('are kind pdf by extension or declared type, and start out served as an octet-stream', async () => {
    for (const [type, name] of [
      ['application/octet-stream', 'Q3 plan.docx'],
      ['', 'Deck.PPTX'],
      [DOCX, 'from-a-phone'],
      ['application/vnd.oasis.opendocument.spreadsheet', 'budget.ods'],
    ]) {
      const res = await upload(t.port, { type: type || 'application/octet-stream', name, body })
      expect(res.status, name).toBe(201)
      expect(res.json(), name).toMatchObject({
        kind: 'pdf',
        mimeType: 'application/octet-stream',
        status: 'queued',
      })
    }
    // Macro-enabled and legacy formats stay attachments.
    for (const name of ['macro.docm', 'old.doc', 'old.xls']) {
      expect(
        (await upload(t.port, { type: 'application/octet-stream', name, body })).json(),
        name,
      ).toMatchObject({
        kind: 'other',
      })
    }
  })

  it('413 above the 100 MB Office limit names Office documents (and a PDF still names PDFs)', async () => {
    expect(LIMITS.maxOfficeBytes).toBe(100 * 1024 * 1024)
    for (const [type, name, label] of [
      ['application/octet-stream', 'huge.pptx', 'Office documents'],
      [DOCX, 'huge', 'Office documents'],
      ['application/pdf', 'huge.pdf', 'PDFs'],
    ] as const) {
      const raw = await rawExchange(t.port, (s) =>
        s.write(uploadHead({ type, name, length: LIMITS.maxOfficeBytes + 1 })),
      )
      const r = parseRaw(raw)
      expect(r.status, name).toBe(413)
      expect(r.json.error).toEqual({
        code: 'TOO_LARGE',
        message: `The file is larger than the 100 MB limit for ${label}.`,
      })
    }
    expect(uploadLimitLabel('pdf', 'application/pdf', 'scan.docx')).toBeNull() // declared a PDF: a PDF
    expect(uploadLimitLabel('other', '', 'a.docm')).toBeNull()
  })

  it('the original is a download before and after the worker confirms an Office type; the previews are images', async () => {
    const m = (
      await upload(t.port, { type: 'application/octet-stream', name: 'Q3 plan.docx', body })
    ).json<AssetVersionMeta>()
    const queued = await req(t.port, { path: original(m) })
    expect(queued.headers['content-type']).toBe('application/octet-stream')
    expect(queued.headers['content-disposition']).toMatch(/^attachment; filename="Q3 plan.docx"/)
    // What `complete` stores for a converted document: ready, the Office type, page derivatives.
    const page = await addDerivative(t, m, { publish: true })
    await setVersion(t.db, m.versionId, { status: 'ready', mimeType: DOCX })
    const meta = (
      await req(t.port, { path: `/api/boards/board-a/assets/${m.assetId}/${m.versionId}` })
    ).json<AssetVersionMeta>()
    expect(meta).toMatchObject({ kind: 'pdf', mimeType: DOCX, status: 'ready' })
    const ready = await req(t.port, { path: original(m) })
    expect(ready.status).toBe(200)
    expect(ready.headers['content-type']).toBe('application/octet-stream')
    expect(ready.headers['content-disposition']).toMatch(/^attachment; /)
    expect(ready.headers['x-content-type-options']).toBe('nosniff')
    expect(ready.body.equals(body)).toBe(true)
    const d = await req(t.port, { path: `/files/${m.assetId}/${m.versionId}/d/${page.id}?board=board-a` })
    expect(d.status).toBe(200)
    expect(d.headers['content-type']).toBe('image/webp')
  })

  it('viewers see an Office document’s previews and download it (export on) but cannot upload one', async () => {
    const m = (
      await upload(t.port, { type: 'application/octet-stream', name: 'notes.odt', body })
    ).json<AssetVersionMeta>()
    t.auth.roles = { 'board-a': 'viewer' }
    const before = await t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')
    const refused = await upload(t.port, { type: 'application/octet-stream', name: 'more.docx', body })
    expect(refused.status).toBe(403)
    expect((await t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')).n).toBe(before.n)
    expect((await req(t.port, { path: original(m) })).status).toBe(200)
  })

  it('shows the Office failure messages the worker reports, not the INTERNAL fallback', () => {
    expect(userFailure('OFFICE_ENCRYPTED')).toEqual({
      code: 'OFFICE_ENCRYPTED',
      message: 'This document is password-protected. Download it to open it.',
    })
    for (const code of ['OFFICE_INVALID', 'OFFICE_TOO_MANY_PAGES', 'OFFICE_UNAVAILABLE']) {
      expect(userFailure(code).code).toBe(code)
      expect(userFailure(code).message).toMatch(/document|Office/)
    }
  })
})

describe('an unauthorized caller', () => {
  it('learns nothing and stores nothing', async () => {
    t.auth.roles = {}
    const res = await upload(t.port, { type: 'application/octet-stream', name: 'x.xlsx', body })
    expect(res.status).toBe(404)
    // (earlier tests stored their own versions; this one added no blob or row)
    const rows = await t.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM asset_versions WHERE name = 'x.xlsx'`,
    )
    expect(rows.n).toBe(0)
  })
})
