// Board thumbnails (docs/WAVE3-CONTRACTS.md "thumbnails"): upload permissions and validation, the rate
// limit, serving headers and caching, replacement cleanup, and `thumbnailVersion` on board lists.
// alice owns Dev Studio (first login); bob (member) owns the private board; carol (member) gets grants;
// gus is a workspace guest; erin is an outsider (removed from Dev Studio).

import {
  ListBoardsWithThumbnailsResponse,
  THUMBNAIL_MAX_BODY_BYTES,
  ThumbnailMetaResponse,
  ThumbnailUploaded,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../../helpers.ts'
import { apng, jpeg, png, webpExtended, webpLossy } from './images.ts'

let api: TestApi
let alice: Client
let bob: Client
let carol: Client
let gus: Client
let erin: Client
let board: string

const url = (bid: string) => `/api/boards/${bid}/thumbnail`

beforeEach(async () => {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  gus = await api.login('gus')
  erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  await api.db.query("UPDATE workspace_members SET role = 'guest' WHERE user_id = $1 AND workspace_id = $2", [
    gus.userId,
    DEV_STUDIO,
  ])
  board = await createBoard(bob, DEV_STUDIO, 'Campaign review')
})
afterEach(() => api.close())

const grant = async (c: Client, role: string, bid = board) => {
  const res = await bob.req('PUT', `/api/boards/${bid}/members/${c.userId}`, { role })
  expect(res.statusCode, res.body).toBe(200)
}

const put = (c: Client, bytes: Buffer, type = 'image/png', bid = board) =>
  c.req('PUT', url(bid), bytes, { 'content-type': type })

async function upload(c: Client, bytes: Buffer = png(48, 30), type = 'image/png', bid = board) {
  const res = await put(c, bytes, type, bid)
  expect(res.statusCode, res.body).toBe(200)
  return ThumbnailUploaded.parse(res.json()).thumbnail
}

const keyOf = (version: string, bid = board) => `thumbnails/${DEV_STUDIO}/${bid}/${version}`
const rowCount = async () =>
  (await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_thumbnails')).n

describe('board thumbnails: upload and serve', () => {
  it('an editor uploads; anyone who can view loads the bytes with safe headers; others get 404', async () => {
    await grant(carol, 'viewer')
    const image = png(480, 300)
    const t = await upload(bob, image)
    expect(t).toMatchObject({ mimeType: 'image/png', width: 480, height: 300, bytes: image.length })
    expect(await api.blobs.head(keyOf(t.version))).toMatchObject({ contentLength: image.length })

    for (const c of [bob, carol, alice]) {
      const res = await c.req('GET', url(board))
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload.equals(image)).toBe(true)
      expect(res.headers['content-type']).toBe('image/png')
      expect(res.headers['content-length']).toBe(String(image.length))
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toMatch(/^sandbox\b/)
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
      expect(res.headers.etag).toBe(`"${t.version}"`)
      expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate')
    }

    // No access: the same 404 as a board that does not exist, and as a board without a thumbnail.
    const hidden = await erin.req('GET', url(board))
    const missing = await erin.req('GET', url('b-0000000000'))
    expect(hidden.statusCode).toBe(404)
    expect(hidden.body).toBe(missing.body)
    const member = await gus.req('GET', url(board)) // guest without a grant on this board
    expect(member.statusCode).toBe(404)
    expect(member.body).toBe(missing.body)
    const other = await createBoard(bob, DEV_STUDIO, 'Empty')
    expect((await bob.req('GET', url(other))).statusCode).toBe(404)
    expect((await api.anon('GET', url(board))).statusCode).toBe(401)

    // Meta: the same rule (view), and nothing about the image beyond its version and size.
    const meta = ThumbnailMetaResponse.parse((await carol.req('GET', `${url(board)}/meta`)).json())
    expect(meta.thumbnail).toEqual(t)
    expect(ThumbnailMetaResponse.parse((await bob.req('GET', `${url(other)}/meta`)).json())).toEqual({
      thumbnail: null,
    })
    const hiddenMeta = await erin.req('GET', `${url(board)}/meta`)
    expect(hiddenMeta.statusCode).toBe(404)
    expect(hiddenMeta.body).toBe(missing.body)
  })

  it('accepts WebP and JPEG as well, served with the type their bytes show', async () => {
    const webp = await upload(bob, webpLossy(480, 300), 'image/webp')
    expect(webp.mimeType).toBe('image/webp')
    expect((await bob.req('GET', url(board))).headers['content-type']).toBe('image/webp')
    api.clock.advance(30_000)
    const j = await upload(bob, jpeg(320, 200), 'image/jpeg')
    expect(j).toMatchObject({ mimeType: 'image/jpeg', width: 320, height: 200 })
    // Content-Type parameters are ignored when matching the declared type.
    api.clock.advance(30_000)
    expect((await put(bob, png(8, 5), 'image/png; charset=binary')).statusCode).toBe(200)
  })

  it('caching: ETag revalidation, and a long private cache only for the current ?v=', async () => {
    const t = await upload(bob)
    const fresh = await bob.req('GET', url(board), undefined, { 'if-none-match': `"${t.version}"` })
    expect(fresh.statusCode).toBe(304)
    expect(fresh.body).toBe('')
    expect(fresh.headers.etag).toBe(`"${t.version}"`)
    const stale = await bob.req('GET', url(board), undefined, { 'if-none-match': '"0000"' })
    expect(stale.statusCode).toBe(200)

    const versioned = await bob.req('GET', `${url(board)}?v=${t.version}`)
    expect(versioned.headers['cache-control']).toBe('private, max-age=2592000, immutable')
    const old = await bob.req('GET', `${url(board)}?v=${'0'.repeat(24)}`)
    expect(old.statusCode).toBe(200)
    expect(old.headers['cache-control']).toBe('private, max-age=0, must-revalidate')

    // Revalidation still checks access: a 304 is never an answer for someone who cannot view.
    const hidden = await erin.req('GET', url(board), undefined, { 'if-none-match': `"${t.version}"` })
    expect(hidden.statusCode).toBe(404)
  })

  it('HEAD answers with the headers and no body', async () => {
    const t = await upload(bob)
    const res = await api.app.inject({ method: 'HEAD', url: url(board), headers: { cookie: bob.cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe(`"${t.version}"`)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.body).toBe('')
    const hidden = await api.app.inject({ method: 'HEAD', url: url(board), headers: { cookie: erin.cookie } })
    expect(hidden.statusCode).toBe(404)
  })
})

describe('board thumbnails: who may upload', () => {
  it('viewers, commenters and guests (even with edit) are refused; outsiders get the missing-board 404', async () => {
    await grant(carol, 'viewer')
    expect((await put(carol, png(4, 4))).statusCode).toBe(403)
    await grant(carol, 'commenter')
    expect((await put(carol, png(4, 4))).statusCode).toBe(403)
    await grant(gus, 'editor')
    const guest = await put(gus, png(4, 4))
    expect(guest.statusCode).toBe(403)
    expect(guest.json().error.message).toBe("Guests can't update board thumbnails.")
    expect((await gus.req('DELETE', url(board))).statusCode).toBe(403)

    const hidden = await put(erin, png(4, 4))
    const missing = await put(erin, png(4, 4), 'image/png', 'b-0000000000')
    expect(hidden.statusCode).toBe(404)
    expect(hidden.body).toBe(missing.body)
    expect((await api.anon('PUT', url(board), png(4, 4), { 'content-type': 'image/png' })).statusCode).toBe(
      401,
    )
    expect(await rowCount()).toBe(0)

    // An editor grant and a workspace owner (alice) may.
    await grant(carol, 'editor')
    await upload(carol)
    api.clock.advance(30_000)
    await upload(alice)
    expect(await rowCount()).toBe(1)
  })

  it('a refusal is decided before the body is read, and the connection is not kept', async () => {
    await grant(carol, 'viewer')
    const res = await put(carol, Buffer.alloc(THUMBNAIL_MAX_BODY_BYTES, 7))
    expect(res.statusCode).toBe(403)
    expect(res.headers.connection).toBe('close')
  })

  it('cross-origin uploads are refused (CSRF), like every mutation', async () => {
    const res = await bob.req('PUT', url(board), png(4, 4), {
      'content-type': 'image/png',
      origin: 'https://evil.example',
    })
    expect(res.statusCode).toBe(403)
    expect(await rowCount()).toBe(0)
    expect(ORIGIN).not.toBe('https://evil.example')
  })

  it('archived boards are read-only (403 for the owner); trashed boards are gone (404)', async () => {
    await upload(bob)
    api.clock.advance(30_000)
    expect((await bob.req('POST', `/api/boards/${board}/archive`)).statusCode).toBe(200)
    expect((await put(bob, png(4, 4))).statusCode).toBe(403)
    // Still viewable while archived.
    expect((await bob.req('GET', url(board))).statusCode).toBe(200)
    expect((await bob.req('POST', `/api/boards/${board}/restore`)).statusCode).toBe(200)
    expect((await bob.req('POST', `/api/boards/${board}/trash`)).statusCode).toBe(200)
    expect((await put(bob, png(4, 4))).statusCode).toBe(404)
    expect((await bob.req('GET', url(board))).statusCode).toBe(404)
  })
})

describe('board thumbnails: validation', () => {
  it('refuses other content types, oversized bodies, lies about the type, and bad headers', async () => {
    const cases: [string, Buffer, string, number][] = [
      ['html', Buffer.from('<html></html>'), 'text/html', 415],
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 415],
      ['json', Buffer.from('{}'), 'application/json', 415],
      ['gif', Buffer.from('GIF89a'), 'image/gif', 415],
      ['over 256 KB', Buffer.concat([png(4, 4), Buffer.alloc(THUMBNAIL_MAX_BODY_BYTES)]), 'image/png', 413],
      ['empty', Buffer.alloc(0), 'image/png', 400],
      ['not an image', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 400],
      ['png declared as webp', png(4, 4), 'image/webp', 400],
      ['webp declared as png', webpLossy(4, 4), 'image/png', 400],
      ['trailing html', Buffer.concat([png(4, 4), Buffer.from('<script>')]), 'image/png', 400],
      ['too wide', png(1025, 1), 'image/png', 400],
      ['too tall (header only)', webpExtended(10, 4000), 'image/webp', 400],
      ['zero size', png(0, 0), 'image/png', 400],
      ['animated', webpExtended(8, 8, { animated: true }), 'image/webp', 400],
      ['animated png (APNG)', apng(64, 40), 'image/png', 400],
    ]
    for (const [name, bytes, type, status] of cases) {
      const res = await put(bob, bytes, type)
      expect(res.statusCode, `${name}: ${res.body}`).toBe(status)
      expect(res.json().error.code, name).toMatch(/^[A-Z_]+$/)
    }
    // None of them was stored, and none used up the board's window: a valid one goes through now.
    expect(await rowCount()).toBe(0)
    await upload(bob)
  })

  it('accepts 1024 × 1024 at most, and an image at the body cap', async () => {
    await upload(bob, webpExtended(1024, 1024), 'image/webp')
    api.clock.advance(30_000)
    const big = webpLossy(480, 300, THUMBNAIL_MAX_BODY_BYTES - 30)
    expect(big.length).toBe(THUMBNAIL_MAX_BODY_BYTES)
    await upload(bob, big, 'image/webp')
  })
})

describe('board thumbnails: rate limit and replacement', () => {
  it('one person uploads at most 30 per minute across boards; a refusal uses up neither window', async () => {
    const boards: string[] = []
    for (let i = 0; i < 31; i++) boards.push(await createBoard(bob, DEV_STUDIO, `B${i}`))
    for (const b of boards.slice(0, 30)) await upload(bob, png(4, 4), 'image/png', b)
    const over = await put(bob, png(4, 4), 'image/png', boards[30])
    expect(over.statusCode).toBe(429)
    // The per-user refusal did not use the 31st board's own window: once the minute has passed, it goes.
    api.clock.advance(60_000)
    await upload(bob, png(4, 4), 'image/png', boards[30])
  })

  it('one accepted upload per board per 30 s (Retry-After); other boards are independent', async () => {
    await upload(bob)
    const again = await put(bob, png(4, 4))
    expect(again.statusCode).toBe(429)
    expect(Number(again.headers['retry-after'])).toBeGreaterThanOrEqual(29)
    // Another editor of the same board shares the board's window.
    await grant(carol, 'editor')
    expect((await put(carol, png(4, 4))).statusCode).toBe(429)
    // Another board is unaffected.
    const second = await createBoard(bob, DEV_STUDIO, 'Second')
    await upload(bob, png(4, 4), 'image/png', second)
    api.clock.advance(29_000)
    expect((await put(bob, png(4, 4))).statusCode).toBe(429)
    api.clock.advance(1_000)
    await upload(carol)
  })

  it('a new upload replaces the row and deletes the previous blob; DELETE clears both', async () => {
    const first = await upload(bob, png(10, 10))
    api.clock.advance(30_000)
    const second = await upload(bob, png(20, 10))
    expect(second.version).not.toBe(first.version)
    expect(await api.blobs.head(keyOf(first.version))).toBeNull()
    expect(await api.blobs.head(keyOf(second.version))).not.toBeNull()
    expect(await rowCount()).toBe(1)
    const res = await bob.req('GET', url(board))
    expect(res.rawPayload.equals(png(20, 10))).toBe(true)

    // Removal: editors only, rate limited like uploads, idempotent.
    await grant(carol, 'viewer')
    expect((await carol.req('DELETE', url(board))).statusCode).toBe(403)
    expect((await bob.req('DELETE', url(board))).statusCode).toBe(429)
    api.clock.advance(30_000)
    expect((await bob.req('DELETE', url(board))).statusCode).toBe(204)
    expect(await api.blobs.head(keyOf(second.version))).toBeNull()
    expect(await rowCount()).toBe(0)
    expect((await bob.req('GET', url(board))).statusCode).toBe(404)
    expect((await bob.req('DELETE', url(board))).statusCode).toBe(204)
  })

  it('a storage failure stores nothing and leaves the current thumbnail in place', async () => {
    const t = await upload(bob)
    api.clock.advance(30_000)
    const put0 = api.blobs.put.bind(api.blobs)
    api.blobs.put = async () => {
      throw new Error('disk full')
    }
    try {
      expect((await put(bob, png(6, 6))).statusCode).toBe(500)
    } finally {
      api.blobs.put = put0
    }
    const meta = ThumbnailMetaResponse.parse((await bob.req('GET', `${url(board)}/meta`)).json())
    expect(meta.thumbnail?.version).toBe(t.version)
    expect(await api.blobs.head(keyOf(t.version))).not.toBeNull()
  })
})

describe('board thumbnails: board lists', () => {
  it('lists carry thumbnailVersion (null without one), the starred list too; trashed boards never do', async () => {
    const other = await createBoard(bob, DEV_STUDIO, 'Other')
    const t = await upload(bob)
    await bob.req('PUT', `/api/boards/${board}/star`)

    const listed = async (c: Client, path: string) => {
      const res = await c.req('GET', path)
      expect(res.statusCode, res.body).toBe(200)
      for (const b of res.json().boards) expect(b).toHaveProperty('thumbnailVersion')
      return Object.fromEntries(
        ListBoardsWithThumbnailsResponse.parse(res.json()).boards.map((b) => [b.id, b.thumbnailVersion]),
      )
    }
    expect(await listed(bob, `/api/workspaces/${DEV_STUDIO}/boards`)).toEqual({
      [board]: t.version,
      [other]: null,
    })
    expect(await listed(bob, `/api/workspaces/${DEV_STUDIO}/boards/starred`)).toEqual({ [board]: t.version })
    // The dashboard's starred flag is still there.
    const res = await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)
    expect(
      ListBoardsWithThumbnailsResponse.parse(res.json()).boards.find((b) => b.id === board)?.starred,
    ).toBe(true)
    // carol cannot see the private board: it is not listed, so neither is its version.
    expect(await listed(carol, `/api/workspaces/${DEV_STUDIO}/boards`)).toEqual({})

    await bob.req('POST', `/api/boards/${board}/trash`)
    expect(await listed(bob, `/api/workspaces/${DEV_STUDIO}/boards?status=trashed`)).toEqual({
      [board]: null,
    })
  })
})
