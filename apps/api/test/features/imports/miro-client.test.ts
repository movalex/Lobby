// The Miro client of an import (apps/api features/imports/miro/client.ts) against the fake Miro over the egress
// module (the Miro policy with the fake's origins standing for its rules): pacing, 429 waits until the reset and the
// give-up, the status → code mapping, cursor and offset paging, the resource answer, the egress refusals (a path
// off the allowlist, a redirect, a Bearer toward the files host), and errors that carry codes only.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MIRO_RATE } from '@draftroom/contracts'
import { FAKE_MIRO_TOKEN, type FakeMiro, startFakeMiro } from '@draftroom/miro-import/fake-miro'
import { RETRO_ID, SPRINT_ID } from '@draftroom/miro-import/fixtures'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EgressError,
  egressDeps,
  egressFetch,
  MIRO_EGRESS_USER_AGENT,
  miroEgressPolicy,
  RedactedSecret,
} from '../../../src/egress/index.ts'
import { MiroClient, MiroError } from '../../../src/features/imports/miro/client.ts'

let miro: FakeMiro
beforeEach(async () => {
  miro = await startFakeMiro()
})
afterEach(() => miro.close())

function client(opts: { token?: string; files?: boolean } = {}) {
  let now = 1_000_000
  const sleeps: number[] = []
  const deps = egressDeps(
    miroEgressPolicy({ api: miro.api, files: opts.files === false ? null : miro.files }),
    MIRO_EGRESS_USER_AGENT,
  )
  const c = new MiroClient(deps, new RedactedSecret(opts.token ?? FAKE_MIRO_TOKEN), {
    apiOrigin: miro.api,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  })
  return { c, sleeps, deps }
}

const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(MiroError)
    expect(JSON.stringify(e)).not.toContain(FAKE_MIRO_TOKEN)
    expect(String((e as Error).message)).not.toContain('127.0.0.1')
    return (e as MiroError).code
  }
  return 'no error'
}

describe('the Miro client', () => {
  it('paces its requests (at most MIRO_RATE.maxRequestsPerSecond a second)', async () => {
    const { c, sleeps } = client()
    for (let i = 0; i < 4; i++) await c.board(SPRINT_ID)
    expect(sleeps.length).toBeGreaterThanOrEqual(3)
    for (const s of sleeps) expect(s).toBeLessThanOrEqual(Math.ceil(1000 / MIRO_RATE.maxRequestsPerSecond))
    expect(c.requests).toBe(4)
  })

  it('waits out 429s until Miro’s reset, then gives up after MIRO_RATE.retries with MIRO_RATE_LIMITED', async () => {
    const a = client()
    miro.behaviour.rateLimitNext = 2
    expect((await a.c.board(SPRINT_ID)).name).toBe('Sprint planning')
    expect(a.sleeps.filter((s) => s >= 1000)).toHaveLength(2)
    for (const s of a.sleeps) expect(s).toBeLessThanOrEqual(MIRO_RATE.maxWaitMs)
    const b = client()
    miro.behaviour.rateLimitNext = MIRO_RATE.retries + 1
    expect(await code(b.c.board(SPRINT_ID))).toBe('MIRO_RATE_LIMITED')
  })

  it('maps Miro’s statuses to codes', async () => {
    expect(await code(client({ token: 'not-the-fake-token-0123456789' }).c.tokenContext())).toBe(
      'MIRO_TOKEN_INVALID',
    )
    expect(await code(client().c.board('uXjVmissing0='))).toBe('MIRO_BOARD_NOT_VISIBLE')
    miro.behaviour.fail = { path: /./, status: 403 }
    expect(await code(client().c.board(SPRINT_ID))).toBe('MIRO_SCOPE_MISSING')
    miro.behaviour.fail = { path: /./, status: 502 }
    expect(await code(client().c.board(SPRINT_ID))).toBe('MIRO_UNAVAILABLE')
    miro.behaviour.fail = null
    miro.behaviour.scopes = ['identity:read']
    expect(await code(client().c.tokenContext())).toBe('MIRO_SCOPE_MISSING')
  })

  it('reads every cursor page and every offset page', async () => {
    const { c } = client()
    const items = await c.cursorList(`/v2/boards/${SPRINT_ID}/items`, { max: 10_000 })
    expect(items.over).toBe(false)
    expect(items.data).toHaveLength(miro.boards[0]?.items.length ?? 0)
    expect(miro.requests.filter((r) => r.path.endsWith('/items')).length).toBe(3)
    const over = await c.cursorList(`/v2/boards/${SPRINT_ID}/items`, { max: 12 })
    expect(over).toMatchObject({ over: true })
    expect(over.data).toHaveLength(12)
    const tags = await c.offsetList(`/v2/boards/${SPRINT_ID}/tags`, { max: 100 })
    expect(tags.data).toHaveLength(2)
    const retro = await c.cursorList(`/v2/boards/${RETRO_ID}/connectors`, { max: 100 })
    expect(retro.data).toEqual([])
  })

  it('a resource answer’s signed URL; only resource paths are asked for', async () => {
    const { c } = client()
    const url = await c.resourceUrl(`/v2/boards/${SPRINT_ID}/resources/images/3458764518000000001`)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/3458764518000000001\.png\?Expires=\d+&Signature=fake/)
    expect(miro.requests.at(-1)?.path).toContain('/resources/images/')
    expect(await c.resourceUrl('/v2/boards/x/items')).toBeNull()
  })
})

describe('the egress rules hold for the client', () => {
  let other: Server
  let otherOrigin = ''
  beforeEach(async () => {
    other = createServer((_req, res) => {
      res.writeHead(307, { location: 'https://evil.example/' })
      res.end()
    })
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
  })
  afterEach(() => new Promise<void>((r) => other.close(() => r())))

  it('a path off the allowlist, a Bearer toward the files host, a host no rule names, a redirect: refused', async () => {
    const { deps } = client()
    const token = new RedactedSecret(FAKE_MIRO_TOKEN)
    const req = (url: string, bearer?: RedactedSecret) =>
      egressFetch(deps, {
        method: 'GET',
        url,
        timeoutMs: 2000,
        maxBytes: 4096,
        ...(bearer ? { bearer } : {}),
      })
    await expect(req(`${miro.api}/v2/boards/${SPRINT_ID}/comments`, token)).rejects.toMatchObject({
      reason: 'refused',
    })
    await expect(req(`${miro.files}/r/1.png?Expires=9999999999`, token)).rejects.toMatchObject({
      reason: 'refused',
      detail: 'bearer',
    })
    await expect(req(`${otherOrigin}/v2/boards`, token)).rejects.toBeInstanceOf(EgressError)
    // the API origin answering a redirect: refused, never followed
    const redirecting = egressDeps(
      miroEgressPolicy({ api: otherOrigin, files: null }),
      MIRO_EGRESS_USER_AGENT,
    )
    await expect(
      egressFetch(redirecting, {
        method: 'GET',
        url: `${otherOrigin}/v2/boards`,
        timeoutMs: 2000,
        maxBytes: 4096,
        bearer: token,
      }),
    ).rejects.toMatchObject({ reason: 'redirect' })
    // the real Miro is never reached: no rule's host was called but the fakes
    expect(miro.requests.every((r) => r.auth !== 'other')).toBe(true)
  })

  it('an expired signed URL is refused before any request (the file rule’s check)', async () => {
    const { deps } = client()
    const past = Math.floor(Date.now() / 1000) - 5
    await expect(
      egressFetch(deps, {
        method: 'GET',
        url: `${miro.files}/r/1.png?Expires=${past}`,
        timeoutMs: 2000,
        maxBytes: 4096,
      }),
    ).rejects.toMatchObject({ reason: 'refused', detail: 'check' })
    expect(miro.requests.filter((r) => r.origin === 'files')).toEqual([])
  })
})
