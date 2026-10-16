// The egress request (wave R foundation; src/egress/fetch.ts): the vetted and pinned address, no redirects, one
// deadline, the byte cap after decompression, only the allowed headers out and in. Two ways in: a fake request
// function on the https path (no network: the address checks run), and a real loopback server through the test seam.
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type EgressDeps,
  EgressError,
  egressFetch,
  egressOpen,
  makeEgressPolicy,
  MIRO_API_RULE,
  MIRO_FILE_RULE,
  miroEgressPolicy,
  RedactedSecret,
  readBody,
} from '../../src/egress/index.ts'
import type { Lookup } from '../../src/features/link-preview/ssrf.ts'

const PUBLIC = '93.184.216.34'
const publicLookup: Lookup = async () => [{ address: PUBLIC, family: 4 }]
const TOKEN = new RedactedSecret('miro-token-0123456789-SECRET')

interface FakeAnswer {
  status?: number
  headers?: Record<string, string>
  body?: Buffer | string
  /** never answer (the deadline must end it) */
  hang?: boolean
  /** fail the connection */
  error?: boolean
}

/** A request function that records what it was asked and answers `answer` (the shape fetch.ts uses). */
function fakeRequest(answer: FakeAnswer, seen: Record<string, unknown>[] = []) {
  return ((opts: Record<string, unknown>, cb: (res: IncomingMessage) => void) => {
    seen.push(opts)
    const req = Object.assign(new EventEmitter(), {
      end() {
        if (answer.hang) return
        const refused = new Error(`connect ECONNREFUSED ${PUBLIC}`)
        if (answer.error) return setImmediate(() => req.emit('error', refused))
        const res = Object.assign(new PassThrough(), {
          statusCode: answer.status ?? 200,
          headers: answer.headers ?? { 'content-type': 'application/json' },
        }) as unknown as IncomingMessage
        cb(res)
        setImmediate(() => (res as unknown as PassThrough).end(answer.body ?? '{}'))
      },
      destroy() {
        req.emit('close')
      },
    })
    return req
  }) as never
}

const deps = (over: Partial<EgressDeps> = {}): EgressDeps => ({
  policy: miroEgressPolicy(null),
  lookup: publicLookup,
  userAgent: 'LobbyImport/1.0',
  ...over,
})

const GET = (url: string, more: Record<string, unknown> = {}) => ({
  method: 'GET' as const,
  url,
  accept: 'application/json',
  timeoutMs: 2_000,
  maxBytes: 1024,
  ...more,
})

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return e instanceof EgressError ? e.reason : `other: ${(e as Error).name}`
  }
}

describe('egress on the https path (a fake request function)', () => {
  it('connects to the vetted address, pinned; sends the Bearer token, nothing of the caller’s', async () => {
    const seen: Record<string, unknown>[] = []
    let lookups = 0
    const got = await egressFetch(
      deps({
        lookup: async () => {
          lookups++
          return lookups === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]
        },
        request: fakeRequest({ body: '{"data":[]}' }, seen),
      }),
      GET('https://api.miro.com/v2/boards?limit=50', { bearer: TOKEN }),
    )
    expect(got.status).toBe(200)
    expect(got.body.toString()).toBe('{"data":[]}')
    expect(lookups).toBe(1)
    const opts = seen[0] as {
      host: string
      servername: string
      path: string
      method: string
      agent: unknown
      headers: Record<string, string>
      lookup: (h: string, o: object, cb: (e: unknown, a: string) => void) => void
    }
    expect(opts).toMatchObject({
      host: 'api.miro.com',
      servername: 'api.miro.com',
      method: 'GET',
      agent: false,
    })
    expect(opts.path).toBe('/v2/boards?limit=50')
    expect(await new Promise((r) => opts.lookup('api.miro.com', {}, (_e, a) => r(a)))).toBe(PUBLIC)
    const sent = Object.keys(opts.headers).sort()
    expect(sent).toEqual(['Accept', 'Accept-Encoding', 'Authorization', 'User-Agent'])
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN.reveal()}`)
    expect(opts.headers['User-Agent']).toBe('LobbyImport/1.0')
  })

  it('refuses before resolving anything: a host, path, method or Bearer the policy refuses', async () => {
    let lookups = 0
    const seen: Record<string, unknown>[] = []
    const d = deps({
      lookup: async () => {
        lookups++
        return [{ address: PUBLIC, family: 4 }]
      },
      request: fakeRequest({}, seen),
    })
    const refused = [
      'https://evil.example/v2/boards',
      'https://api.miro.com/v2/orgs',
      'http://api.miro.com/v2/boards',
    ]
    for (const url of refused)
      expect(await reasonOf(egressFetch(d, GET(url, { bearer: TOKEN })))).toBe('refused')
    expect(await reasonOf(egressFetch(d, { ...GET('https://api.miro.com/v2/boards'), method: 'POST' }))).toBe(
      'refused',
    )
    const files = makeEgressPolicy([MIRO_API_RULE, { ...MIRO_FILE_RULE, host: ['r.miro.com'] }])
    const exp = Math.floor(Date.now() / 1000) + 60
    const signed = `https://r.miro.com/x.png?Expires=${exp}`
    const withToken = egressFetch({ ...d, policy: files }, GET(signed, { bearer: TOKEN }))
    expect(await reasonOf(withToken)).toBe('refused')
    expect(lookups).toBe(0)
    expect(seen).toEqual([])
  })

  it('a host with any address that is not public is blocked (all checked), before connecting', async () => {
    const seen: Record<string, unknown>[] = []
    for (const answer of [
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '10.0.0.5', family: 4 }],
      [
        { address: PUBLIC, family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      [{ address: '::ffff:127.0.0.1', family: 6 }],
      [],
    ])
      expect(
        await reasonOf(
          egressFetch(
            deps({ lookup: async () => answer, request: fakeRequest({}, seen) }),
            GET('https://api.miro.com/v2/boards'),
          ),
        ),
        JSON.stringify(answer),
      ).toBe('blocked')
    expect(seen).toEqual([])
  })

  it('a redirect is refused, never followed (the Location is not asked for)', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const seen: Record<string, unknown>[] = []
      const p = egressFetch(
        deps({ request: fakeRequest({ status, headers: { location: 'https://169.254.169.254/' } }, seen) }),
        GET('https://api.miro.com/v2/boards'),
      )
      await expect(p).rejects.toMatchObject({ reason: 'redirect', status })
      expect(seen).toHaveLength(1)
    }
  })

  it('other statuses are answered (the caller decides), with only the kept headers', async () => {
    const got = await egressFetch(
      deps({
        request: fakeRequest({
          status: 429,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'session=abc',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1760000000',
            'retry-after': '30',
            server: 'nginx',
          },
          body: '{"status":429}',
        }),
      }),
      GET('https://api.miro.com/v2/boards'),
    )
    expect(got.status).toBe(429)
    expect(got.headers).toEqual({
      'content-type': 'application/json',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1760000000',
      'retry-after': '30',
    })
  })

  it('the deadline ends a request that never answers; a connection error is "network"', async () => {
    const t0 = Date.now()
    const boards = 'https://api.miro.com/v2/boards'
    const hung = egressFetch(deps({ request: fakeRequest({ hang: true }) }), GET(boards, { timeoutMs: 150 }))
    expect(await reasonOf(hung)).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(2_000)
    const broken = egressFetch(deps({ request: fakeRequest({ error: true }) }), GET(boards))
    expect(await reasonOf(broken)).toBe('network')
  })

  it('the byte cap applies after decompression (a gzip bomb stops there)', async () => {
    const bomb = gzipSync(Buffer.alloc(5_000_000, 0x61))
    expect(bomb.length).toBeLessThan(10_000)
    const p = egressFetch(
      deps({ request: fakeRequest({ headers: { 'content-encoding': 'gzip' }, body: bomb }) }),
      GET('https://api.miro.com/v2/boards', { maxBytes: 64 * 1024 }),
    )
    await expect(p).rejects.toMatchObject({ reason: 'too-large' })
    const small = await egressFetch(
      deps({ request: fakeRequest({ headers: { 'content-encoding': 'gzip' }, body: gzipSync('{"ok":1}') }) }),
      GET('https://api.miro.com/v2/boards'),
    )
    expect(small.body.toString()).toBe('{"ok":1}')
  })
})

describe('egress to a real loopback server (the test seam)', () => {
  let server: Server
  let origin = ''
  const heard: { url: string; headers: IncomingMessage['headers']; body: string }[] = []
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end('{}')
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        heard.push({ url: req.url ?? '', headers: req.headers, body })
        handler(req, res)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  const seamDeps = () =>
    deps({ policy: miroEgressPolicy({ api: origin, files: null }), lookup: async () => [] })

  it('the token arrives as the Bearer header, and the answer streams under its cap', async () => {
    heard.length = 0
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[1,2,3]}')
    }
    const got = await egressFetch(seamDeps(), GET(`${origin}/v2/boards?limit=50`, { bearer: TOKEN }))
    expect(JSON.parse(got.body.toString())).toEqual({ data: [1, 2, 3] })
    expect(heard[0]?.headers.authorization).toBe(`Bearer ${TOKEN.reveal()}`)
    expect(heard[0]?.headers.cookie).toBeUndefined()
    expect(heard[0]?.url).toBe('/v2/boards?limit=50')
  })

  it('a download past its cap fails mid-stream, and the reader sees "too-large"', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      const chunk = Buffer.alloc(16 * 1024, 1)
      let n = 0
      const pump = () => {
        while (n < 64) {
          n++
          if (!res.write(chunk)) return res.once('drain', pump)
        }
        res.end()
      }
      pump()
    }
    const answer = await egressOpen(seamDeps(), GET(`${origin}/v2/boards`, { maxBytes: 100 * 1024 }))
    expect(answer.status).toBe(200)
    await expect(readBody(answer.body)).rejects.toMatchObject({ reason: 'too-large' })
    // the cap is hit before anyone reads: no unhandled error, and the late reader still sees it
    const late = await egressOpen(seamDeps(), GET(`${origin}/v2/boards`, { maxBytes: 100 * 1024 }))
    await new Promise((r) => setTimeout(r, 200))
    await expect(readBody(late.body)).rejects.toMatchObject({ reason: 'too-large' })
  })

  it('a body the reader stops reading early ends the request (no leak)', async () => {
    handler = (_req, res) => {
      res.writeHead(200)
      res.write(Buffer.alloc(1024))
      // never ends on its own
    }
    const answer = await egressOpen(seamDeps(), GET(`${origin}/v2/boards`, { timeoutMs: 5_000 }))
    answer.body.destroy()
    await new Promise((r) => setTimeout(r, 50))
    expect(answer.body.destroyed).toBe(true)
  })
})
