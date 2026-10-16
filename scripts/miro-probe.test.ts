// scripts/miro-probe.mjs (wave R, R0.4): the owner-run Miro probe, against a fake Miro on loopback (never the real
// service). It reports types, shapes, connectors, groups, tags, the download host and its parameter NAMES, and never
// prints or writes the token, a signed URL or item content; it refuses redirects and the token on the command line.
import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeSignedUrl, makeClient, ProbeError, resourcePath, runProbe, scrub } from './miro-probe.mjs'

const TOKEN = 'eyJtaXJvLm9yaWdpbiI6ImV1MDEifQ_probe-SECRET-0123456789'
const SIGNED = 'https://r.miro.com/image.png?Expires=4102444800&Signature=SIGSECRETabc&Key-Pair-Id=KPSECRET'
const SCRIPT = fileURLToPath(new URL('./miro-probe.mjs', import.meta.url))
const IMAGE_PATH = '/v2/boards/uXjVOD1Ab2c=/resources/images/3458764517517819000'

let server: Server
let base = ''
const asked: string[] = []
let redirectBoards = false

function answer(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x')
  asked.push(`${req.method} ${url.pathname}`)
  const json = (status: number, body: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-ratelimit-limit': '100000',
      'x-ratelimit-remaining': '99000',
    })
    res.end(JSON.stringify(body))
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'bad token' })
  const p = url.pathname
  if (p === '/v1/oauth-token') return json(200, { team: { name: 'DBC Pitches' }, scopes: ['boards:read'] })
  if (p === '/v2/boards') {
    if (redirectBoards) {
      res.writeHead(302, { location: `https://evil.example/?t=${TOKEN}` })
      return res.end()
    }
    return json(200, {
      data: [
        { id: 'uXjVOD1Ab2c=', name: 'Pitch wall', modifiedAt: '2026-10-01T00:00:00Z' },
        { id: 'uXjVOD9Zz8y=', name: 'Retro', modifiedAt: '2026-09-01T00:00:00Z' },
      ],
      total: 2,
    })
  }
  if (p === '/v2/boards/uXjVOD1Ab2c=/items') {
    const cursor = url.searchParams.get('cursor')
    if (!cursor)
      return json(200, {
        data: [
          { id: '1', type: 'frame', position: { relativeTo: 'canvas_center' } },
          {
            id: '2',
            type: 'sticky_note',
            data: { shape: 'square', content: '<p>SECRET-NOTE-TEXT</p>' },
            parent: { id: '1' },
          },
          {
            id: '3',
            type: 'image',
            data: { imageUrl: `${base}${IMAGE_PATH}?format=preview&redirect=false` },
          },
        ],
        cursor: 'page2',
      })
    return json(200, { data: [{ id: '4', type: 'shape', data: { shape: 'flow_chart_decision' } }] })
  }
  if (p === '/v2/boards/uXjVOD1Ab2c=/connectors')
    return json(200, {
      data: [{ id: 'c1', shape: 'elbowed', style: { endStrokeCap: 'arrow' }, captions: [{}] }],
    })
  if (p === '/v2/boards/uXjVOD1Ab2c=/groups')
    return json(200, { data: [{ id: 'g1', data: { items: ['2', '4'] } }] })
  if (p === '/v2/boards/uXjVOD1Ab2c=/tags') return json(200, { data: [{ id: 't1' }] })
  if (p === IMAGE_PATH) {
    expect(url.searchParams.get('format')).toBe('original')
    expect(url.searchParams.get('redirect')).toBe('false')
    return json(200, { type: 'image', url: SIGNED })
  }
  return json(404, { message: 'not found' })
}

beforeAll(async () => {
  server = createServer(answer)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('the Miro probe', () => {
  it('reports a board’s make-up and the download host; prints no secret, signed URL, content', async () => {
    redirectBoards = false
    const lines: string[] = []
    const summary = await runProbe({ token: TOKEN, base, boards: 1, print: (l: string) => lines.push(l) })
    const text = `${lines.join('\n')}\n${JSON.stringify(summary)}`
    const secrets = [TOKEN, encodeURIComponent(TOKEN), 'SIGSECRETabc', 'KPSECRET', SIGNED, 'SECRET-NOTE-TEXT']
    for (const secret of secrets) expect(text.includes(secret), secret).toBe(false)
    expect(lines[0]).toBe('Team: DBC Pitches')
    expect(summary.downloadHosts).toEqual(['r.miro.com'])
    const board = summary.boards[0]
    expect(board).toMatchObject({
      boardId: 'uXjVOD1Ab2c=',
      idInPath: 'as-is',
      items: 4,
      byType: { frame: 1, sticky_note: 1, image: 1, shape: 1 },
      shapes: { flow_chart_decision: 1 },
      stickyShapes: { square: 1 },
      withParent: 1,
      firstItemIds: ['1', '2', '3', '4'],
      connectors: { count: 1, shapes: { elbowed: 1 }, captions: 1 },
      groups: 1,
      tags: 1,
    })
    expect(board.files.image).toMatchObject({
      answerType: 'image',
      host: 'r.miro.com',
      scheme: 'https',
      params: ['Expires', 'Key-Pair-Id', 'Signature'],
    })
    // no board names in the summary unless asked
    expect(JSON.stringify(summary)).not.toContain('Pitch wall')
    // GET only, read paths only, nothing downloaded from the signed host
    expect(asked.every((a) => a.startsWith('GET /v1/') || a.startsWith('GET /v2/'))).toBe(true)
  })

  it('refuses a redirect, and answers codes for a bad token', async () => {
    redirectBoards = true
    await expect(runProbe({ token: TOKEN, base, boards: 1, print: () => {} })).rejects.toMatchObject({
      code: 'REDIRECT_REFUSED',
    })
    redirectBoards = false
    const e = await runProbe({ token: 'wrong-token-0123456789', base, print: () => {} }).catch(
      (x: unknown) => x,
    )
    expect(e).toBeInstanceOf(ProbeError)
    expect((e as ProbeError).code).toBe('TOKEN_INVALID')
  })

  it('calls api.miro.com only (a local fake is the only other base it accepts)', () => {
    expect(() => makeClient({ token: TOKEN, base: 'https://evil.example' })).toThrow()
    expect(() => makeClient({ token: TOKEN, base: 'http://10.0.0.1:80' })).toThrow()
    expect(() => makeClient({ token: TOKEN })).not.toThrow()
    const preview = 'https://api.miro.com/v2/boards/uXjVOD1Ab2c=/resources/images/1?format=preview'
    expect(resourcePath(preview)).toBe('/v2/boards/uXjVOD1Ab2c=/resources/images/1')
    expect(resourcePath('https://evil.example/v2/boards/uXjVOD1Ab2c=/resources/images/1')).toBeNull()
    expect(resourcePath('https://api.miro.com/v2/boards/uXjVOD1Ab2c=/items/1')).toBeNull()
    expect(describeSignedUrl('not a url')).toEqual({ host: null, scheme: null, params: [], expiresInS: null })
    expect(scrub(`a ${TOKEN} b ${encodeURIComponent(TOKEN)}`, TOKEN)).toBe('a [redacted] b [redacted]')
  })

  it('the command line refuses a token argument and runs nothing without a token', () => {
    const withArg = spawnSync(process.execPath, [SCRIPT, '--token', TOKEN], { encoding: 'utf8', env: {} })
    expect(withArg.status).toBe(1)
    expect(withArg.stderr).toMatch(/never on the command line/)
    expect(`${withArg.stdout}${withArg.stderr}`).not.toContain(TOKEN)
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: {} })
    expect(none.status).toBe(1)
    expect(none.stderr).toMatch(/Set MIRO_TOKEN/)
  })
})
