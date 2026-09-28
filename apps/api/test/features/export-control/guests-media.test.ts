// export-control, round-2 follow-ups (docs/WAVE3-CONTRACTS.md "export-control"):
// - SEAM-04: with policy 'editors', name-only guests are limited like viewers, whatever their board role
//   (a workshop link makes them editors). People with an account keep what their role gives them.
// - SEAM-10: the media-element exception (Sec-Fetch-Dest image/video/audio) serves an original only
//   where the canvas really renders from it: a video, an animated GIF within the canvas's limits, a
//   small image still processing, or an image with no still preview. A still image that has a preview
//   is refused, since the canvas shows the preview.

import {
  CANVAS_ORIGINAL_LIMITS,
  EXPORT_DISABLED_CODE,
  type ExportPolicy,
  ExportPolicyState,
  GuestJoined,
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
let alice: Client
let editor: Client
let viewer: Client
/** An outsider WITH an account who joined through the workshop (editor) link. */
let accountGuest: Client
let board: string
let ipSeq = 0

interface Guest {
  userId: string
  req(
    method: 'GET' | 'HEAD',
    url: string,
    body?: undefined,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>
}

async function upload(name: string, contentType: string, bytes: Buffer = PNG) {
  const res = await api.app.inject({
    method: 'POST',
    url: `/api/boards/${board}/assets`,
    payload: bytes,
    headers: {
      origin: ORIGIN,
      'content-type': contentType,
      'x-file-name': encodeURIComponent(name),
      cookie: editor.cookie,
    },
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json() as AssetVersionMeta
}

async function link(role: 'viewer' | 'editor', allowGuests = true) {
  const res = await alice.req('POST', `/api/boards/${board}/review-links`, { role, allowGuests })
  expect(res.statusCode, res.body).toBe(201)
  const { url } = ReviewLinkCreated.parse(res.json())
  return url.slice(url.lastIndexOf('/') + 1)
}

async function joinAsGuest(token: string, name: string): Promise<Guest> {
  const res = await api.app.inject({
    method: 'POST',
    url: `/api/invitations/${token}/guest`,
    payload: { name },
    headers: { origin: ORIGIN },
    remoteAddress: `10.66.0.${++ipSeq}`,
  })
  expect(res.statusCode, res.body).toBe(201)
  const cookie = res.cookies.find((c) => c.name === 'dr_session')
  if (!cookie) throw new Error('no session cookie')
  const joined = GuestJoined.parse(res.json())
  return {
    userId: joined.user.id,
    req: (method, url, _body, headers = {}) =>
      api.app.inject({
        method,
        url,
        headers: { origin: ORIGIN, cookie: `dr_session=${cookie.value}`, ...headers },
      }),
  }
}

const setPolicy = (exportPolicy: ExportPolicy) =>
  alice.req('PUT', `/api/boards/${board}/export-policy`, { exportPolicy })

const originalUrl = (m: { assetId: string; versionId: string }) =>
  `/files/${m.assetId}/${m.versionId}/original?board=${board}`

const code = (res: LightMyRequestResponse) => (res.json() as { error?: { code?: string } }).error?.code

beforeEach(async () => {
  sync = createFakeSync()
  api = await createTestApi({ deps: { events: new EventHub(), syncInternal: sync } })
  alice = await api.login('alice')
  editor = await api.login('bob')
  viewer = await api.login('dave')
  accountGuest = await api.login('olga')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    accountGuest.userId,
    DEV_STUDIO,
  ])
  board = await createBoard(alice, DEV_STUDIO, 'Client pitch')
  for (const [c, role] of [
    [editor, 'editor'],
    [viewer, 'viewer'],
  ] as const)
    expect((await alice.req('PUT', `/api/boards/${board}/members/${c.userId}`, { role })).statusCode).toBe(
      200,
    )
})
afterEach(() => api.close())

describe('SEAM-04: name-only guests are limited like viewers under "editors", whatever their role', () => {
  it('a workshop (editor) guest: canExport, originals and the archive follow the policy; account holders do not change', async () => {
    const zip = await upload('deal-terms.zip', 'application/zip', Buffer.from('PK\x03\x04secret'))
    const video = await upload('cut.mp4', 'video/mp4', Buffer.from('not really a video'))
    const records: Rec[] = [
      ...baseRecords(),
      fileCardRec('terms', zip.assetId, zip.versionId),
      fileCardRec('cut', video.assetId, video.versionId, 'a2'),
    ]
    assertValid(records)
    sync.setBoard(board, records)
    const workshop = await link('editor')
    const eddie = await joinAsGuest(workshop, 'Eddie')
    const val = await joinAsGuest(await link('viewer'), 'Val')
    expect((await accountGuest.req('POST', `/api/invitations/${workshop}/accept`)).statusCode).toBe(200)
    const role = await eddie.req('GET', `/api/boards/${board}`)
    expect((role.json() as { role: string }).role).toBe('editor')

    const state = async (c: { req(method: 'GET', url: string): Promise<LightMyRequestResponse> }) =>
      ExportPolicyState.parse((await c.req('GET', `/api/boards/${board}/export-policy`)).json())

    // 'everyone' (the default): nobody is limited.
    for (const c of [eddie, val]) {
      expect(await state(c)).toEqual({ exportPolicy: 'everyone', canExport: true })
      expect((await c.req('GET', originalUrl(zip))).statusCode).toBe(200)
      expect((await c.req('GET', `/api/boards/${board}/export`)).statusCode).toBe(200)
    }

    expect((await setPolicy('editors')).statusCode).toBe(200)
    for (const [who, c] of [
      ['guest editor', eddie],
      ['guest viewer', val],
    ] as const) {
      expect(await state(c), who).toEqual({ exportPolicy: 'editors', canExport: false })
      for (const method of ['GET', 'HEAD'] as const) {
        const res = await c.req(method, originalUrl(zip))
        expect(res.statusCode, `${who} ${method} original`).toBe(403)
        if (method === 'GET') expect(code(res), who).toBe(EXPORT_DISABLED_CODE)
      }
      const archive = await c.req('GET', `/api/boards/${board}/export`)
      expect(archive.statusCode, `${who} archive`).toBe(403)
      expect(code(archive)).toBe(EXPORT_DISABLED_CODE)
      // What the board renders from an original keeps playing for them, as for viewers.
      const played = await c.req('GET', originalUrl(video), undefined, { 'sec-fetch-dest': 'video' })
      expect(played.statusCode, `${who} <video>`).toBe(200)
    }
    // People with an account keep their role's rights: an outside editor, a member editor.
    for (const c of [accountGuest, editor]) {
      expect(await state(c)).toEqual({ exportPolicy: 'editors', canExport: true })
      expect((await c.req('GET', originalUrl(zip))).statusCode).toBe(200)
      expect((await c.req('GET', `/api/boards/${board}/export`)).statusCode).toBe(200)
    }
    // The viewer with an account stays limited (unchanged).
    expect((await state(viewer)).canExport).toBe(false)
  })
})

describe('SEAM-10: the media-element exception serves only what the canvas renders from the original', () => {
  const MiB = 1024 * 1024
  const asImage = { 'sec-fetch-dest': 'image' }

  async function version(
    name: string,
    set: {
      mime?: string
      status?: 'queued' | 'ready'
      sizeBytes?: number
      probe?: object
      preview?: boolean
    },
  ) {
    const m = await upload(name, 'image/png')
    await api.db.query(
      `UPDATE asset_versions SET mime_type = coalesce($2, mime_type), status = coalesce($3, status),
              size_bytes = coalesce($4, size_bytes), probe = coalesce($5::jsonb, probe)
        WHERE id = $1`,
      [
        m.versionId,
        set.mime ?? null,
        set.status ?? null,
        set.sizeBytes ?? null,
        set.probe ? JSON.stringify(set.probe) : null,
      ],
    )
    if (set.preview) await addDerivative({ db: api.db, blobs: api.blobs }, m)
    return m
  }

  it('limited viewers (an account viewer, a name-only workshop guest): allowed and refused cases; editors always load', async () => {
    const L = CANVAS_ORIGINAL_LIMITS
    expect(L).toEqual({
      smallOriginalBytes: 1.5 * MiB,
      animatedMaxBytes: 8 * MiB,
      animatedMaxPixels: 25_000_000,
    })
    const cases = {
      // The canvas resolves a ready still image with a preview to the preview (never the original).
      'ready PNG with a preview': [await version('photo.png', { status: 'ready', preview: true }), false],
      'ready PNG without a preview': [await version('raw.png', { status: 'ready' }), true],
      'processing PNG, small': [await version('small.png', {}), true],
      'processing PNG, over the small-original size': [
        await version('big.png', { sizeBytes: L.smallOriginalBytes + 1 }),
        false,
      ],
      'ready GIF with a preview (plays from the original)': [
        await version('loop.gif', {
          mime: 'image/gif',
          status: 'ready',
          probe: { width: 320, height: 200 },
          preview: true,
        }),
        true,
      ],
      'ready GIF over the animated byte limit': [
        await version('huge.gif', {
          mime: 'image/gif',
          status: 'ready',
          sizeBytes: L.animatedMaxBytes + 1,
          preview: true,
        }),
        false,
      ],
      'ready GIF over the animated pixel limit': [
        await version('wide.gif', {
          mime: 'image/gif',
          status: 'ready',
          probe: { width: 6000, height: 6000 },
          preview: true,
        }),
        false,
      ],
      // The server cannot tell an animated WebP from a still one: the canvas shows its preview to
      // limited viewers (web asset-store), so the original is refused.
      'ready WebP with a preview': [
        await version('anim.webp', { mime: 'image/webp', status: 'ready', preview: true }),
        false,
      ],
    } as const
    await setPolicy('editors')
    const guest = await joinAsGuest(await link('editor'), 'Eddie')
    for (const [who, c] of [
      ['viewer', viewer],
      ['name-only guest editor', guest],
    ] as const) {
      for (const [what, [m, allowed]] of Object.entries(cases)) {
        const res = await c.req('GET', originalUrl(m), undefined, asImage)
        if (allowed) expect(res.statusCode, `${who}: ${what}`).toBe(200)
        else {
          expect(res.statusCode, `${who}: ${what}: ${res.body}`).toBe(403)
          expect(code(res)).toBe(EXPORT_DISABLED_CODE)
        }
      }
    }
    // Editors with an account are never limited: every original loads, as a media element or not.
    for (const [what, [m]] of Object.entries(cases)) {
      if (what.includes('over the')) continue // sizes faked in the row only: the bytes do not match
      expect((await editor.req('GET', originalUrl(m), undefined, asImage)).statusCode, what).toBe(200)
    }
    // With 'everyone', the viewer loads the preview-backed original too.
    await setPolicy('everyone')
    const [photo] = cases['ready PNG with a preview']
    expect((await viewer.req('GET', originalUrl(photo), undefined, asImage)).statusCode).toBe(200)
  })

  it('still-image previews themselves keep rendering for limited viewers', async () => {
    const photo = await version('photo.png', { status: 'ready' })
    const preview = await addDerivative({ db: api.db, blobs: api.blobs }, photo)
    assertValid([
      ...baseRecords(),
      imageAssetRec('hero', photo.assetId, photo.versionId),
      imageRec('img', 'hero'),
    ])
    await setPolicy('editors')
    const res = await viewer.req(
      'GET',
      `/files/${photo.assetId}/${photo.versionId}/d/${preview.id}?board=${board}`,
    )
    expect(res.statusCode, res.body).toBe(200)
  })
})
