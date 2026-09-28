// export-control (docs/WAVE3-CONTRACTS.md): the per-board "viewers and commenters can export, copy and
// download files" policy. The route matrix is role × policy × route: with 'editors', viewers, commenters
// and review-link guests get 403 EXPORT_DISABLED for original downloads, the board archive, duplicate and
// restore-as-new, while previews and PDF pages (derivatives), the meta route and media elements that
// render the board from an original (<video>, an animated GIF) keep working for everyone.

import {
  EXPORT_CONTROL_EVENTS,
  EXPORT_DISABLED_CODE,
  EXPORT_DISABLED_MESSAGE,
  type ExportPolicy,
  ExportPolicyState,
  ReviewLinkCreated,
} from '@draftroom/contracts'
import type { AssetVersionMeta } from '@draftroom/dev-assets'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { addDerivative } from '../../files/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../../helpers.ts'
import {
  assertValid,
  baseRecords,
  createFakeSync,
  type FakeSync,
  fileCardRec,
  imageAssetRec,
  imageRec,
  noteRec,
  type Rec,
} from '../history/helpers.ts'

// A 1x1 PNG (stored and hashed only: no worker runs in these tests).
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
)

let api: TestApi
let sync: FakeSync
let events: EventHub
let published: { type: string; data: unknown }[]
/** Dev Studio owner (first login): the board's owner through the workspace. */
let alice: Client
let editor: Client
let commenter: Client
/** A Dev Studio member with a viewer grant: may create boards, so duplicate is open to them. */
let viewer: Client
/** Outsiders who joined through review links: workspace guests. */
let guestViewer: Client
let guestCommenter: Client
let outsider: Client
let board: string
let files: Record<'image' | 'pdf' | 'video' | 'zip', AssetVersionMeta>
let pdfPage: string

async function uploadFile(c: Client, boardId: string, name: string, contentType: string, bytes = PNG) {
  const res = await api.app.inject({
    method: 'POST',
    url: `/api/boards/${boardId}/assets`,
    payload: bytes,
    headers: {
      origin: ORIGIN,
      'content-type': contentType,
      'x-file-name': encodeURIComponent(name),
      cookie: c.cookie,
    },
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json() as AssetVersionMeta
}

async function joinByReviewLink(c: Client, role: 'viewer' | 'commenter') {
  const res = await alice.req('POST', `/api/boards/${board}/review-links`, { role })
  expect(res.statusCode, res.body).toBe(201)
  const { url } = ReviewLinkCreated.parse(res.json())
  const accepted = await c.req('POST', `/api/invitations/${url.slice(url.lastIndexOf('/') + 1)}/accept`)
  expect(accepted.statusCode, accepted.body).toBe(200)
}

const setPolicy = (c: Client, exportPolicy: ExportPolicy, bid = board) =>
  c.req('PUT', `/api/boards/${bid}/export-policy`, { exportPolicy })

const original = (c: Client, m: { assetId: string; versionId: string }, headers = {}, bid = board) =>
  c.req('GET', `/files/${m.assetId}/${m.versionId}/original?board=${bid}`, undefined, headers)

function expectExportDisabled(res: LightMyRequestResponse, what: string) {
  expect(res.statusCode, `${what}: ${res.body}`).toBe(403)
  expect(res.json(), what).toEqual({
    error: { code: EXPORT_DISABLED_CODE, message: EXPORT_DISABLED_MESSAGE },
  })
}

beforeEach(async () => {
  events = new EventHub()
  sync = createFakeSync()
  api = await createTestApi({ deps: { events, syncInternal: sync } })
  alice = await api.login('alice')
  editor = await api.login('bob')
  commenter = await api.login('carol')
  viewer = await api.login('dave')
  guestViewer = await api.login('erin')
  guestCommenter = await api.login('frank')
  outsider = await api.login('olga')
  for (const c of [guestViewer, guestCommenter, outsider])
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      c.userId,
      DEV_STUDIO,
    ])
  board = await createBoard(alice, DEV_STUDIO, 'Client pitch')
  for (const [c, role] of [
    [editor, 'editor'],
    [commenter, 'commenter'],
    [viewer, 'viewer'],
  ] as const) {
    const res = await alice.req('PUT', `/api/boards/${board}/members/${c.userId}`, { role })
    expect(res.statusCode, res.body).toBe(200)
  }
  await joinByReviewLink(guestViewer, 'viewer')
  await joinByReviewLink(guestCommenter, 'commenter')

  files = {
    image: await uploadFile(editor, board, 'hero.png', 'image/png'),
    pdf: await uploadFile(editor, board, 'brief.pdf', 'application/pdf', Buffer.from('%PDF-1.7 test')),
    video: await uploadFile(editor, board, 'cut.mp4', 'video/mp4', Buffer.from('not really a video')),
    zip: await uploadFile(editor, board, 'assets.zip', 'application/zip', Buffer.from('PK')),
  }
  // A published PDF page image (what the worker's `complete` leaves behind).
  pdfPage = (await addDerivative({ db: api.db, blobs: api.blobs }, files.pdf)).id

  const records: Rec[] = [
    ...baseRecords(),
    noteRec('n1', 'Tagline'),
    imageAssetRec('hero', files.image.assetId, files.image.versionId),
    imageRec('img', 'hero'),
    fileCardRec('brief', files.pdf.assetId, files.pdf.versionId),
    { ...fileCardRec('cut', files.video.assetId, files.video.versionId, 'a4') },
  ]
  assertValid(records)
  sync.setBoard(board, records)

  published = []
  events.subscribe(board, (e) => published.push({ type: e.type, data: e.data }))
})
afterEach(() => api.close())

// ---- the setting --------------------------------------------------------------------------------

describe('GET/PUT /api/boards/:bid/export-policy', () => {
  it("defaults to 'everyone'; every role reads it with its own canExport; outsiders get 404, signed-out 401", async () => {
    for (const c of [alice, editor, commenter, viewer, guestViewer, guestCommenter]) {
      const res = await c.req('GET', `/api/boards/${board}/export-policy`)
      expect(res.statusCode, res.body).toBe(200)
      expect(ExportPolicyState.parse(res.json())).toEqual({ exportPolicy: 'everyone', canExport: true })
    }
    expect((await outsider.req('GET', `/api/boards/${board}/export-policy`)).statusCode).toBe(404)
    expect((await api.anon('GET', `/api/boards/${board}/export-policy`)).statusCode).toBe(401)
    expect((await alice.req('GET', '/api/boards/b-nope000000/export-policy')).statusCode).toBe(404)

    expect((await setPolicy(alice, 'editors')).json()).toEqual({ exportPolicy: 'editors', canExport: true })
    const expected: [Client, boolean][] = [
      [alice, true],
      [editor, true],
      [commenter, false],
      [viewer, false],
      [guestViewer, false],
      [guestCommenter, false],
    ]
    for (const [c, canExport] of expected) {
      const res = await c.req('GET', `/api/boards/${board}/export-policy`)
      expect(res.json(), c.me.user.name).toEqual({ exportPolicy: 'editors', canExport })
    }
  })

  it('only board owners change it (manage_access); others get 403, outsiders 404; bad bodies 400', async () => {
    for (const c of [editor, commenter, viewer, guestViewer, guestCommenter]) {
      const res = await setPolicy(c, 'editors')
      expect(res.statusCode, c.me.user.name).toBe(403)
    }
    expect((await setPolicy(outsider, 'editors')).statusCode).toBe(404)
    for (const body of [{}, { exportPolicy: 'nobody' }, { exportPolicy: 'editors', extra: 1 }, null]) {
      const res = await alice.req('PUT', `/api/boards/${board}/export-policy`, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }
    // Cross-site mutations are refused before the route runs (CSRF).
    const foreign = await alice.req(
      'PUT',
      `/api/boards/${board}/export-policy`,
      { exportPolicy: 'editors' },
      { origin: 'https://evil.example' },
    )
    expect(foreign.statusCode).toBe(403)
    expect((await alice.req('GET', `/api/boards/${board}/export-policy`)).json()).toMatchObject({
      exportPolicy: 'everyone',
    })
    expect(published).toEqual([])
  })

  it('a board owner by grant (not a workspace admin) changes it too, and it is stored with who changed it', async () => {
    await alice.req('PUT', `/api/boards/${board}/members/${editor.userId}`, { role: 'owner' })
    const res = await setPolicy(editor, 'editors')
    expect(res.statusCode, res.body).toBe(200)
    const row = await api.db.one<{ policy: string; updated_by: string; workspace_id: string }>(
      'SELECT policy, updated_by, workspace_id FROM board_export_policies WHERE board_id = $1',
      [board],
    )
    expect(row).toEqual({ policy: 'editors', updated_by: editor.userId, workspace_id: DEV_STUDIO })
  })

  it('a change publishes one identity-free board event; setting the same value again publishes nothing', async () => {
    expect((await setPolicy(alice, 'editors')).statusCode).toBe(200)
    expect((await setPolicy(alice, 'editors')).statusCode).toBe(200)
    expect((await setPolicy(alice, 'everyone')).statusCode).toBe(200)
    expect(published).toEqual([
      { type: EXPORT_CONTROL_EVENTS.policy, data: { exportPolicy: 'editors' } },
      { type: EXPORT_CONTROL_EVENTS.policy, data: { exportPolicy: 'everyone' } },
    ])
  })

  it('archived boards: the owner can still change it and still export; viewers stay limited', async () => {
    expect((await alice.req('POST', `/api/boards/${board}/archive`)).statusCode).toBe(200)
    expect((await setPolicy(alice, 'editors')).statusCode).toBe(200)
    expect((await alice.req('GET', `/api/boards/${board}/export`)).statusCode).toBe(200)
    expect((await original(alice, files.zip)).statusCode).toBe(200)
    // An editor of an archived board is read-only, but still an editor for exporting.
    expect((await original(editor, files.zip)).statusCode).toBe(200)
    expectExportDisabled(await original(viewer, files.zip), 'archived, viewer')
    expectExportDisabled(await viewer.req('GET', `/api/boards/${board}/export`), 'archived, viewer archive')
  })

  it('trashed boards: 404 for everyone, as for every other board route', async () => {
    expect((await alice.req('POST', `/api/boards/${board}/trash`)).statusCode).toBe(200)
    expect((await alice.req('GET', `/api/boards/${board}/export-policy`)).statusCode).toBe(404)
    expect((await setPolicy(alice, 'editors')).statusCode).toBe(404)
  })

  it('the row is deleted with its board', async () => {
    const scratch = await createBoard(alice, DEV_STUDIO, 'Scratch')
    expect((await setPolicy(alice, 'editors', scratch)).statusCode).toBe(200)
    await api.db.query('DELETE FROM boards WHERE id = $1', [scratch])
    const { n } = await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_export_policies')
    expect(n).toBe(0)
  })
})

// ---- enforcement matrix -------------------------------------------------------------------------

type Who = 'owner' | 'editor' | 'commenter' | 'viewer' | 'guest viewer' | 'guest commenter'
const WHO: Who[] = ['owner', 'editor', 'commenter', 'viewer', 'guest viewer', 'guest commenter']
const LIMITED = new Set<Who>(['commenter', 'viewer', 'guest viewer', 'guest commenter'])
const client = (who: Who): Client =>
  ({
    owner: alice,
    editor,
    commenter,
    viewer,
    'guest viewer': guestViewer,
    'guest commenter': guestCommenter,
  })[who]

describe.each(['everyone', 'editors'] as const)("policy '%s'", (policy) => {
  beforeEach(async () => {
    if (policy === 'editors') expect((await setPolicy(alice, 'editors')).statusCode).toBe(200)
  })
  const refused = (who: Who) => policy === 'editors' && LIMITED.has(who)

  it.each(WHO)('%s: original downloads (GET and HEAD, every kind)', async (who) => {
    const c = client(who)
    for (const kind of ['image', 'pdf', 'video', 'zip'] as const) {
      // No Fetch Metadata (curl, a script) and what browsers send for a download, a new tab and fetch().
      for (const dest of [undefined, 'document', 'empty', 'iframe']) {
        const headers: Record<string, string> = dest ? { 'sec-fetch-dest': dest } : {}
        for (const method of ['GET', 'HEAD'] as const) {
          const res = await c.req(
            method as 'GET',
            `/files/${files[kind].assetId}/${files[kind].versionId}/original?board=${board}`,
            undefined,
            headers,
          )
          const what = `${who} ${method} ${kind} dest=${dest ?? '-'}`
          if (refused(who)) {
            expect(res.statusCode, what).toBe(403)
            if (method === 'GET') expectExportDisabled(res, what)
          } else {
            expect(res.statusCode, what).toBe(200)
            expect(res.headers.vary, what).toBe('Sec-Fetch-Dest')
          }
        }
      }
    }
  })

  it.each(WHO)('%s: media elements that render the board keep loading originals', async (who) => {
    const c = client(who)
    const img = await original(c, files.image, { 'sec-fetch-dest': 'image' })
    expect(img.statusCode, `${who} <img>`).toBe(200)
    expect(img.headers['content-type']).toBe('image/png')
    const video = await original(c, files.video, { 'sec-fetch-dest': 'video', range: 'bytes=0-3' })
    expect(video.statusCode, `${who} <video>`).toBe(206)
    // A media element pointed at something the board never renders from its original is a download.
    for (const kind of ['pdf', 'zip'] as const) {
      const res = await original(c, files[kind], { 'sec-fetch-dest': 'image' })
      if (refused(who)) expectExportDisabled(res, `${who} <img> ${kind}`)
      else expect(res.statusCode).toBe(200)
    }
  })

  it.each(WHO)('%s: previews, PDF pages and file meta always render', async (who) => {
    const c = client(who)
    const page = await c.req(
      'GET',
      `/files/${files.pdf.assetId}/${files.pdf.versionId}/d/${pdfPage}?board=${board}`,
    )
    expect(page.statusCode, `${who} derivative`).toBe(200)
    const meta = await c.req('GET', `/api/boards/${board}/assets/${files.pdf.assetId}/${files.pdf.versionId}`)
    expect(meta.statusCode, `${who} meta`).toBe(200)
  })

  it.each(WHO)('%s: the board archive (.lobby.json)', async (who) => {
    const res = await client(who).req('GET', `/api/boards/${board}/export`)
    if (refused(who)) expectExportDisabled(res, who)
    else expect(res.statusCode, res.body).toBe(200)
  })

  it.each(WHO)('%s: duplicate and restore-as-new (a full copy of your own)', async (who) => {
    const c = client(who)
    const snap = await alice.req('POST', `/api/boards/${board}/snapshots`, { name: 'Before review' })
    expect(snap.statusCode, snap.body).toBe(201)
    const sid = (snap.json() as { id: string }).id
    const dup = await c.req('POST', `/api/boards/${board}/duplicate`, {})
    const restored = await c.req('POST', `/api/snapshots/${sid}/restore-as-new`, {})
    for (const [res, what] of [
      [dup, 'duplicate'],
      [restored, 'restore-as-new'],
    ] as const) {
      if (who.startsWith('guest')) {
        // Guests never create boards, whatever the policy (history's own rule, unchanged).
        expect(res.statusCode, `${who} ${what}`).toBe(403)
        expect(res.json().error.code, `${who} ${what}`).toBe('FORBIDDEN')
      } else if (refused(who)) expectExportDisabled(res, `${who} ${what}`)
      else expect(res.statusCode, `${who} ${what}: ${res.body}`).toBe(201)
    }
  })
})

describe('no existence leak', () => {
  it('someone who cannot view the board gets 404 for its files, never 403 EXPORT_DISABLED', async () => {
    await setPolicy(alice, 'editors')
    for (const headers of [{}, { 'sec-fetch-dest': 'video' }]) {
      expect((await original(outsider, files.video, headers)).statusCode).toBe(404)
      expect((await original(outsider, files.zip, headers)).statusCode).toBe(404)
    }
    expect((await outsider.req('GET', `/api/boards/${board}/export`)).statusCode).toBe(404)
    expect(
      (await api.anon('GET', `/files/${files.zip.assetId}/${files.zip.versionId}/original?board=${board}`))
        .statusCode,
    ).toBe(401)
  })

  it("a limited viewer's media load of another board's file is still a 404 from the file routes", async () => {
    const other = await createBoard(alice, DEV_STUDIO, 'Other')
    const elsewhere = await uploadFile(alice, other, 'secret.mp4', 'video/mp4', Buffer.from('elsewhere'))
    await setPolicy(alice, 'editors')
    // dest=video on a version this board does not show: refused as a download (it renders nothing here).
    expectExportDisabled(await original(viewer, elsewhere, { 'sec-fetch-dest': 'video' }), 'foreign video')
    // An editor, who is never limited, gets the file routes' own 404 for it.
    expect((await original(editor, elsewhere, { 'sec-fetch-dest': 'video' })).statusCode).toBe(404)
  })
})

describe('linked files (a board made from another board)', () => {
  it("a copy's viewers are limited by the COPY's policy; its media still render from the linked originals", async () => {
    const dup = await alice.req('POST', `/api/boards/${board}/duplicate`, { title: 'Pitch copy' })
    expect(dup.statusCode, dup.body).toBe(201)
    const copy = (dup.json() as { board: { id: string }; linkedFiles: number }).board.id
    expect((dup.json() as { linkedFiles: number }).linkedFiles).toBeGreaterThan(0)
    await alice.req('PUT', `/api/boards/${copy}/members/${viewer.userId}`, { role: 'viewer' })

    // The source board's policy does not follow the file.
    await setPolicy(alice, 'editors', board)
    expect((await original(viewer, files.zip, {}, board)).statusCode).toBe(403)
    expect((await original(viewer, files.video, {}, copy)).statusCode).toBe(200)

    await setPolicy(alice, 'editors', copy)
    expectExportDisabled(await original(viewer, files.video, {}, copy), 'copy, download')
    const played = await original(viewer, files.video, { 'sec-fetch-dest': 'video' }, copy)
    expect(played.statusCode).toBe(200)
    const shown = await original(viewer, files.image, { 'sec-fetch-dest': 'image' }, copy)
    expect(shown.statusCode).toBe(200)
  })
})

describe('failed versions', () => {
  it('a failed version is served as an attachment, so a media element cannot load it while exporting is off', async () => {
    await api.db.query(
      "UPDATE asset_versions SET status = 'failed', error_code = 'DECODE_FAILED', error_message = 'Preview failed.' WHERE id = $1",
      [files.video.versionId],
    )
    await setPolicy(alice, 'editors')
    expectExportDisabled(await original(viewer, files.video, { 'sec-fetch-dest': 'video' }), 'failed video')
    expect((await original(editor, files.video)).statusCode).toBe(200)
  })
})
