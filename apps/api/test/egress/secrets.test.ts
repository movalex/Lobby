// A token never reaches a log, an error or a response (wave R foundation; src/egress/secret.ts and index.ts): the
// RedactedSecret prints as [redacted] in every way a value is printed (pino included); an egress error holds a reason
// code only, whatever the other side answered (a Location, a header or a body that echoes the token); withSecrets
// rebuilds whatever a step throws without the secret. The runner's own test (features/imports/runner.test.ts) scans
// the database, the logs and the job views after whole jobs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { format, inspect } from 'node:util'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EgressError,
  egressFetch,
  errorFacts,
  miroEgressPolicy,
  REDACTED,
  RedactedSecret,
  redact,
  SecretSafeError,
  secretSafe,
  withSecrets,
} from '../../src/egress/index.ts'
import { ApiError } from '../../src/errors.ts'

const RAW = 'eyJtaXJvLm9yaWdpbiI6ImV1MDEifQ_tok3n+with/odd=chars'
const TOKEN = new RedactedSecret(RAW)
const leaks = (text: string) => text.includes(RAW) || text.includes(encodeURIComponent(RAW))

/** Every way a value commonly gets printed. */
function printed(v: unknown): string[] {
  return [
    String(v),
    `${v}`,
    JSON.stringify(v) ?? '',
    JSON.stringify({ v }),
    inspect(v, { depth: 10, showHidden: true }),
    inspect({ nested: { v } }, { depth: 10 }),
    format('%s %o %O %j', v, v, v, v),
    v instanceof Error ? `${v.message}\n${v.stack}\n${JSON.stringify(v)}\n${inspect(v.cause)}` : '',
  ]
}

describe('RedactedSecret', () => {
  it('prints as [redacted] everywhere; only reveal() gives the value', () => {
    for (const text of printed(TOKEN)) expect(leaks(text), text).toBe(false)
    expect(String(TOKEN)).toBe(REDACTED)
    expect(JSON.stringify({ token: TOKEN })).toBe(`{"token":"${REDACTED}"}`)
    expect(Object.keys(TOKEN)).toEqual([])
    expect(JSON.stringify({ ...TOKEN })).toBe('{}')
    expect(JSON.stringify(structuredClone({ t: TOKEN }))).not.toContain(RAW)
    expect(TOKEN.reveal()).toBe(RAW)
    expect(() => new RedactedSecret('')).toThrow()
  })

  it('pino (the api logger) writes [redacted], in objects, arrays and nested fields', async () => {
    const lines: string[] = []
    const app = Fastify({ logger: { level: 'info', stream: { write: (l: string) => void lines.push(l) } } })
    app.log.info({ token: TOKEN, job: { secrets: [TOKEN] } }, 'starting')
    app.log.warn({ err: new SecretSafeError('MIRO_UNAVAILABLE') }, 'failed')
    await app.close()
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(leaks(l), l).toBe(false)
    expect(lines[0]).toContain(REDACTED)
  })

  it('redact() scrubs a text of every secret, as written and percent-encoded', () => {
    const text = `Bearer ${RAW} and ?t=${encodeURIComponent(RAW)} twice ${RAW}`
    const clean = redact(text, [TOKEN])
    expect(leaks(clean)).toBe(false)
    expect(clean).toBe(`Bearer ${REDACTED} and ?t=${REDACTED} twice ${REDACTED}`)
    expect(TOKEN.isIn(text)).toBe(true)
    expect(TOKEN.isIn(clean)).toBe(false)
  })
})

describe('egress errors hold no secret, whatever the other side answers', () => {
  let server: Server
  let origin = ''
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end()
  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  const call = async (maxBytes = 1024, timeoutMs = 2_000) => {
    try {
      await egressFetch(
        {
          policy: miroEgressPolicy({ api: origin, files: null }),
          lookup: async () => [],
          userAgent: 'LobbyImport/1.0',
        },
        { method: 'GET', url: `${origin}/v2/boards?token=x`, bearer: TOKEN, timeoutMs, maxBytes },
      )
      return null
    } catch (e) {
      return e
    }
  }

  it('a redirect to a URL with the token, a reset after an echo, a body over its cap, a timeout', async () => {
    const echo = (req: IncomingMessage) => String(req.headers.authorization ?? '')
    const cases: [string, (req: IncomingMessage, res: ServerResponse) => void, string][] = [
      [
        'redirect',
        (req, res) => {
          res.writeHead(302, { location: `https://evil.example/?t=${encodeURIComponent(echo(req))}` })
          res.end()
        },
        'redirect',
      ],
      [
        'reset',
        (req, res) => {
          res.writeHead(200, { 'x-echo': echo(req) })
          res.write(echo(req))
          res.socket?.destroy()
        },
        'network',
      ],
      [
        'too large',
        (req, res) => {
          res.writeHead(200, { 'x-echo': echo(req) })
          res.end(`${echo(req)}${'x'.repeat(4096)}`)
        },
        'too-large',
      ],
      ['timeout', () => {}, 'timeout'],
    ]
    for (const [name, h, reason] of cases) {
      handler = h
      const e = await call(1024, name === 'timeout' ? 200 : 2_000)
      expect(e, name).toBeInstanceOf(EgressError)
      expect((e as EgressError).reason, name).toBe(reason)
      for (const text of printed(e)) expect(leaks(text), `${name}: ${text}`).toBe(false)
      for (const text of printed(errorFacts(e))) expect(leaks(text), name).toBe(false)
    }
  })

  it('a 401 whose body echoes the token is an answer (the caller maps it), not an error', async () => {
    handler = (req, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'x-echo': String(req.headers.authorization) })
      res.end(JSON.stringify({ message: `bad token ${req.headers.authorization}` }))
    }
    const got = await egressFetch(
      { policy: miroEgressPolicy({ api: origin, files: null }), lookup: async () => [], userAgent: 'x' },
      { method: 'GET', url: `${origin}/v2/boards`, bearer: TOKEN, timeoutMs: 2_000, maxBytes: 4096 },
    )
    expect(got.status).toBe(401)
    // the echoing header is not kept; the body is the caller's to drop (WS1 maps 401 to MIRO_TOKEN_INVALID)
    expect(JSON.stringify(got.headers)).not.toContain(RAW)
  })
})

describe('withSecrets', () => {
  it('rebuilds a foreign error without its message, stack or cause; keeps an upper-case code', async () => {
    const thrown: unknown[] = [
      new Error(`Miro said: invalid token ${RAW}`),
      Object.assign(new Error(`oops ${RAW}`), { code: 'MIRO_SCOPE_MISSING' }),
      Object.assign(new Error(`oops ${RAW}`), { code: `E_${RAW}` }),
      new Error('wrapped', { cause: new Error(RAW) }),
      new TypeError(`Cannot read ${encodeURIComponent(RAW)}`),
      RAW,
      { message: RAW, token: RAW },
    ]
    for (const t of thrown) {
      const e = await withSecrets([TOKEN], async () => {
        throw t
      }).catch((err: unknown) => err)
      expect(e).toBeInstanceOf(SecretSafeError)
      for (const text of printed(e)) expect(leaks(text), text).toBe(false)
    }
    const coded = secretSafe(Object.assign(new Error(RAW), { code: 'MIRO_SCOPE_MISSING' }), [TOKEN])
    expect((coded as SecretSafeError).code).toBe('MIRO_SCOPE_MISSING')
    expect((secretSafe(new Error(RAW), [TOKEN]) as SecretSafeError).code).toBe('INTERNAL')
  })

  it('keeps an EgressError as it is; scrubs an ApiError’s message (its code and status kept)', async () => {
    const egress = new EgressError('timeout')
    expect(secretSafe(egress, [TOKEN])).toBe(egress)
    const api = new ApiError(400, 'MIRO_TOKEN_INVALID', `The token ${RAW} was refused.`)
    const safe = secretSafe(api, [TOKEN]) as ApiError
    expect(safe).toBeInstanceOf(ApiError)
    expect(safe.status).toBe(400)
    expect(safe.code).toBe('MIRO_TOKEN_INVALID')
    expect(safe.message).toBe(`The token ${REDACTED} was refused.`)
    for (const text of printed(safe)) expect(leaks(text), text).toBe(false)
    const plain = new ApiError(404, 'NOT_FOUND', 'Not found.')
    expect(secretSafe(plain, [TOKEN])).toBe(plain)
    // and a success passes through
    expect(await withSecrets([TOKEN], async () => 42)).toBe(42)
  })

  it('errorFacts says kinds and codes only', () => {
    expect(errorFacts(new EgressError('blocked'))).toEqual({
      name: 'EgressError',
      reason: 'blocked',
      status: null,
      detail: null,
    })
    expect(errorFacts(new ApiError(429, 'RATE_LIMITED', RAW))).toEqual({
      name: 'ApiError',
      code: 'RATE_LIMITED',
      status: 429,
    })
    expect(errorFacts(new Error(RAW))).toEqual({ name: 'Error' })
    expect(errorFacts({ name: RAW })).toEqual({ name: REDACTED })
  })
})
