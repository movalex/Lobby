// Link previews (D2): the api reads a pasted link's <head> for its link card, inside the api's network,
// so the SSRF rules are the point of these tests: only public web servers on the default ports, every
// DNS answer and every redirect checked, the vetted address pinned for the connection, time and size
// limits, and a refusal that looks like an unreachable page. Plus the route: who may ask, and the limits.
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseLinkPreviewTestOrigins } from '../../../src/config.ts'
import { FetchRefused, guardedFetch } from '../../../src/features/link-preview/fetch.ts'
import { LINK_PREVIEW_LIMITS, readPreview } from '../../../src/features/link-preview/index.ts'
import {
  decodeEntities,
  iconCandidates,
  iconType,
  parseHead,
} from '../../../src/features/link-preview/parse.ts'
import {
  checkUrl,
  isPublicAddress,
  type Lookup,
  vetAddress,
} from '../../../src/features/link-preview/ssrf.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

const NONE = { allowOrigins: new Set<string>() }
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
)

describe('which addresses and URLs the api may fetch', () => {
  it('only public unicast addresses', () => {
    for (const a of [
      '93.184.216.34',
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700:4700::1111',
      '2a00:1450:4001:82a::200e',
    ])
      expect(isPublicAddress(a), a).toBe(true)
    for (const a of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '172.16.4.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '192.0.2.1',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      '2001:db8::1',
      '2002:7f00:1::1',
      '2001:0:4136:e378::1', // Teredo
      'not-an-ip',
    ])
      expect(isPublicAddress(a), a).toBe(false)
  })

  it('http(s) links of a board only; private hosts and other ports are blocked before any lookup', () => {
    expect(checkUrl('https://example.com/a?b=1#frag', NONE)).toMatchObject({ host: 'example.com', port: 443 })
    expect((checkUrl('https://example.com/a#frag', NONE) as { url: URL }).url.href).toBe(
      'https://example.com/a',
    )
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com/x',
      'file:///etc/passwd',
      'mailto:a@example.com',
      '/relative/path',
      'https://user:pass@example.com/',
      'https://bucket.example.com/x?X-Amz-Signature=abc',
      `https://example.com/${'a'.repeat(2100)}`,
      '',
      42,
    ])
      expect(checkUrl(bad, NONE), String(bad).slice(0, 40)).toBe('invalid')
    for (const blocked of [
      'http://127.0.0.1/',
      'http://2130706433/', // 127.0.0.1 as one number
      'http://0x7f.1/',
      'http://[::1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/',
      'http://intranet/',
      'http://printer.local/',
      'http://db.internal/',
      'http://app.localhost/',
      'https://example.com:8443/',
      'http://example.com:22/',
    ])
      expect(checkUrl(blocked, NONE), blocked).toBe('blocked')
  })

  it('every DNS answer must be public (a name that also points inside is refused)', async () => {
    const t = checkUrl('https://news.example.com/', NONE)
    if (t === 'invalid' || t === 'blocked') throw new Error('unexpected')
    const answer =
      (...addresses: string[]): Lookup =>
      async () =>
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    expect(await vetAddress(t, answer('93.184.216.34'))).toEqual({ address: '93.184.216.34', family: 4 })
    expect(await vetAddress(t, answer('93.184.216.34', '10.0.0.1'))).toBe('blocked')
    expect(await vetAddress(t, answer('::1'))).toBe('blocked')
    expect(await vetAddress(t, answer())).toBe('blocked')
    expect(
      await vetAddress(t, async () => {
        throw new Error('ENOTFOUND')
      }),
    ).toBe('blocked')
  })

  it('the test seam is an exact origin list, behind the local-dev guard only', () => {
    expect(parseLinkPreviewTestOrigins({}, false)).toEqual([])
    expect(
      parseLinkPreviewTestOrigins({ DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS: 'http://127.0.0.1:6830' }, true),
    ).toEqual(['http://127.0.0.1:6830'])
    expect(() =>
      parseLinkPreviewTestOrigins({ DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS: 'http://127.0.0.1:6830' }, false),
    ).toThrow(/requires DRAFTROOM_DEV_AUTH=1/)
    expect(() =>
      parseLinkPreviewTestOrigins(
        { DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS: 'http://127.0.0.1:6830/path' },
        true,
      ),
    ).toThrow(/origins/)
    const seam = { allowOrigins: new Set(['http://127.0.0.1:6830']) }
    expect(checkUrl('http://127.0.0.1:6830/page', seam)).toMatchObject({ seam: true })
    expect(checkUrl('http://127.0.0.1:6831/page', seam)).toBe('blocked')
    expect(checkUrl('http://127.0.0.1/page', seam)).toBe('blocked')
  })
})

describe('what a page says about itself', () => {
  it('og:title, then twitter:title, then <title>; entities decoded, control characters gone, capped', () => {
    const head = (inner: string) =>
      parseHead(`<html><head>${inner}</head><body><title>not this</title></body>`)
    expect(head('<title>Plain &amp; simple</title>').title).toBe('Plain & simple')
    expect(head('<title>a</title><meta property="og:title" content="OG &#8212; title">').title).toBe(
      'OG — title',
    )
    expect(head("<meta name='twitter:title' content='Tw'><title>t</title>").title).toBe('Tw')
    expect(head('<title>‮evil\u0007 \n\n text</title>').title).toBe('evil text')
    expect(head(`<title>${'x'.repeat(500)}</title>`).title?.length).toBe(200)
    expect(head('<!-- <title>hidden</title> --><script>"<title>no</title>"</script>').title).toBeNull()
    expect(head('<meta property="og:site_name" content="The Site">').siteName).toBe('The Site')
    expect(decodeEntities('&lt;b&gt; &#x1F600; &#0; &unknown;')).toBe('<b> 😀  &unknown;')
  })

  it('icons: a small PNG or ICO first, never SVG, then /favicon.ico; only by their bytes', () => {
    const meta = parseHead(
      '<head><link rel="apple-touch-icon" href="/apple.png"><link rel="icon" type="image/svg+xml" href="/i.svg">' +
        '<link rel="shortcut icon" sizes="32x32" href="/fav-32.png"></head>',
    )
    expect(iconCandidates(meta, new URL('https://example.com/a/b'))).toEqual([
      'https://example.com/fav-32.png',
      'https://example.com/apple.png',
      'https://example.com/favicon.ico',
    ])
    expect(iconType(PNG)).toBe('image/png')
    expect(iconType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(iconType(Buffer.from('<html>'))).toBeNull()
    expect(iconType(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe('image/x-icon')
  })
})

// ---- the fetch, against a local server reached through the test seam ---------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void
let server: Server
let origin = ''
let handler: Handler = (_req, res) => res.end()
const hits: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
beforeEach(() => {
  hits.length = 0
})

const seamDeps = () => ({
  policy: { allowOrigins: new Set([origin]) },
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
})
const LIMITS = { timeoutMs: 1_500, maxBytes: 64 * 1024, maxRedirects: 4 }

describe('the guarded fetch', () => {
  it('reads a page (gzip too) and its icon; the icon comes back as a data: URL', async () => {
    handler = (req, res) => {
      if (req.url === '/page') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('content-encoding', 'gzip')
        res.end(
          gzipSync(
            '<html><head><title>Lobby — the brief</title><meta property="og:site_name" content="DBC">' +
              '<link rel="icon" href="/icon.png"></head><body>…</body></html>',
          ),
        )
      } else if (req.url === '/icon.png') {
        res.setHeader('content-type', 'image/png')
        res.end(PNG)
      } else res.writeHead(404).end()
    }
    expect(await readPreview(seamDeps(), `${origin}/page`)).toEqual({
      title: 'Lobby — the brief',
      siteName: 'DBC',
      icon: `data:image/png;base64,${PNG.toString('base64')}`,
    })
  })

  it('follows redirects inside the rules, and refuses one that points inside the network', async () => {
    handler = (req, res) => {
      if (req.url === '/moved') res.writeHead(302, { location: '/page' }).end()
      else if (req.url === '/to-metadata')
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end()
      else if (req.url === '/to-other-port') res.writeHead(301, { location: 'http://127.0.0.1:1/' }).end()
      else if (req.url === '/loop') res.writeHead(302, { location: '/loop' }).end()
      else res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Here</title>')
    }
    expect((await guardedFetch(seamDeps(), `${origin}/moved`, '*/*', LIMITS)).url.pathname).toBe('/page')
    for (const [path, reason] of [
      ['/to-metadata', 'blocked'],
      ['/to-other-port', 'blocked'],
      ['/loop', 'redirects'],
    ] as const) {
      await expect(guardedFetch(seamDeps(), `${origin}${path}`, '*/*', LIMITS)).rejects.toMatchObject({
        reason,
      })
    }
    expect(await readPreview(seamDeps(), `${origin}/to-metadata`)).toEqual({
      title: null,
      siteName: null,
      icon: null,
    })
  })

  it('stops at the byte limit (after decompression) and at the time limit', async () => {
    handler = (req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
        // 8 MB of zeros, compressed to a few KB: read only up to the limit
        res.end(gzipSync(Buffer.alloc(8 * 1024 * 1024)))
      } else if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.write('<html><head>')
        // never ends
      } else res.writeHead(500).end()
    }
    const big = await guardedFetch(seamDeps(), `${origin}/big`, '*/*', LIMITS)
    expect(big.body.length).toBe(LIMITS.maxBytes)
    expect(big.truncated).toBe(true)
    const t0 = Date.now()
    await expect(
      guardedFetch(seamDeps(), `${origin}/slow`, '*/*', { ...LIMITS, timeoutMs: 400 }),
    ).rejects.toMatchObject({ reason: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(1_500)
    await expect(guardedFetch(seamDeps(), `${origin}/err`, '*/*', LIMITS)).rejects.toBeInstanceOf(
      FetchRefused,
    )
  })

  it('an icon that is too large, or not a raster image by its bytes, is left out', async () => {
    handler = (req, res) => {
      if (req.url === '/page')
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<head><title>T</title><link rel="icon" href="/big.png"></head>')
      else if (req.url === '/big.png')
        res
          .writeHead(200, { 'content-type': 'image/png' })
          .end(Buffer.concat([PNG, Buffer.alloc(LINK_PREVIEW_LIMITS.iconMaxBytes)]))
      else if (req.url === '/favicon.ico')
        res.writeHead(200, { 'content-type': 'image/x-icon' }).end('<svg onload="alert(1)"/>')
      else res.writeHead(404).end()
    }
    expect(await readPreview(seamDeps(), `${origin}/page`)).toEqual({
      title: 'T',
      siteName: null,
      icon: null,
    })
    expect(hits).toEqual(['/page', '/big.png', '/favicon.ico'])
  })

  it('connects to the vetted address, whatever a second lookup would say (no DNS rebinding)', async () => {
    const seen: Record<string, unknown>[] = []
    const fakeRequest = ((opts: Record<string, unknown>, cb: (res: IncomingMessage) => void) => {
      seen.push(opts)
      const req = Object.assign(new EventEmitter(), {
        end() {
          const res = Object.assign(new PassThrough(), {
            statusCode: 200,
            headers: { 'content-type': 'text/html' },
          }) as unknown as IncomingMessage
          cb(res)
          ;(res as unknown as PassThrough).end('<title>Public</title>')
        },
        destroy() {
          req.emit('close')
        },
      })
      return req
    }) as never
    let lookups = 0
    const rebinding: Lookup = async () => {
      lookups++
      return lookups === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]
    }
    const got = await guardedFetch(
      { policy: NONE, lookup: rebinding, request: fakeRequest },
      'https://news.example.com/story',
      '*/*',
      LIMITS,
    )
    expect(got.body.toString()).toContain('Public')
    expect(lookups).toBe(1)
    const opts = seen[0] as {
      host: string
      servername: string
      lookup: (host: string, opts: object, cb: (e: unknown, a: string) => void) => void
      headers: Record<string, string>
    }
    expect(opts.host).toBe('news.example.com')
    expect(opts.servername).toBe('news.example.com')
    const pinned = await new Promise((r) =>
      opts.lookup('news.example.com', {}, (_e: unknown, a: string) => r(a)),
    )
    expect(pinned).toBe('93.184.216.34')
    // no cookie, no credentials, nothing of the caller's
    expect(Object.keys(opts.headers).map((h) => h.toLowerCase())).not.toContain('cookie')
    expect(Object.keys(opts.headers).map((h) => h.toLowerCase())).not.toContain('authorization')
  })
})

// ---- the route --------------------------------------------------------------------------------------------

describe('POST /api/boards/:bid/link-preview', () => {
  let api: TestApi
  let alice: Client
  let viewer: Client
  let outsider: Client
  let board: string
  beforeEach(async () => {
    api = await createTestApi({ env: { DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS: origin } })
    alice = await api.login('alice')
    viewer = await api.login('dave')
    outsider = await api.login('olga')
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      outsider.userId,
      DEV_STUDIO,
    ])
    board = await createBoard(alice, DEV_STUDIO, 'Links')
    const res = await alice.req('PUT', `/api/boards/${board}/members/${viewer.userId}`, { role: 'viewer' })
    expect(res.statusCode, res.body).toBe(200)
    handler = (req, res) => {
      if (req.url === '/page')
        res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Board link</title>')
      else res.writeHead(404).end()
    }
  })
  afterEach(() => api.close())

  const ask = (c: Client | null, url: unknown, bid = board) =>
    c
      ? c.req('POST', `/api/boards/${bid}/link-preview`, { url })
      : api.anon('POST', `/api/boards/${bid}/link-preview`, { url })

  it('anyone who can view the board; nobody else; never a link a board cannot hold', async () => {
    for (const c of [alice, viewer]) {
      const res = await ask(c, `${origin}/page`)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ title: 'Board link', siteName: null, icon: null })
    }
    expect((await ask(null, `${origin}/page`)).statusCode).toBe(401)
    expect((await ask(outsider, `${origin}/page`)).statusCode).toBe(404)
    const bad = await ask(alice, 'javascript:alert(1)')
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('INVALID_LINK')
    expect((await ask(alice, 42)).statusCode).toBe(400)
  })

  it('a blocked address answers like an unreachable page, and nothing is fetched', async () => {
    hits.length = 0
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:1/',
      'http://10.0.0.1/',
    ]) {
      const res = await ask(alice, url)
      expect(res.statusCode, url).toBe(200)
      expect(res.json()).toEqual({ title: null, siteName: null, icon: null })
    }
    expect(hits).toEqual([])
  })

  it('answers from its cache; fresh fetches are limited per person', async () => {
    hits.length = 0
    for (let i = 0; i < 3; i++) expect((await ask(alice, `${origin}/page`)).statusCode).toBe(200)
    expect(hits.filter((h) => h === '/page')).toHaveLength(1)
    let last = 200
    for (let i = 0; i < LINK_PREVIEW_LIMITS.perUserPerMinute + 2; i++) {
      last = (await ask(viewer, `${origin}/page?n=${i}`)).statusCode
      if (last === 429) break
    }
    expect(last).toBe(429)
  })
})
