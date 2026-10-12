// Wave N.1 (wave N follow-up 5): NetworkLog.settle() (./workshops.ts) waited for every /api response body, and the body
// of a thumbnail upload the api refused (429) could stay pending for good, so a spec that settled hung. The log now
// skips that body and gives up on any body after BODY_READ_TIMEOUT_MS (./network-bodies.ts), recording both as unread.
import { describe, expect, it } from 'vitest'
import { type BodyResponse, isRefusedUpload, readBody } from './network-bodies.ts'
import { NetworkLog } from './workshops.ts'

const never = () => new Promise<string>(() => {})
const response = (method: string, status: number, text: () => Promise<string>): BodyResponse => ({
  status: () => status,
  text,
  request: () => ({ method: () => method }),
})

describe('readBody', () => {
  it('a refused thumbnail upload is not read at all', async () => {
    let asked = 0
    const res = response('PUT', 429, () => {
      asked++
      return never()
    })
    expect(await readBody(res, '/api/boards/b-123/thumbnail')).toEqual({ body: '', unread: 'refused-upload' })
    expect(asked).toBe(0)
    expect(isRefusedUpload('PUT', '/api/boards/b-123/thumbnail', 200)).toBe(false)
    expect(isRefusedUpload('GET', '/api/boards/b-123/thumbnail', 404)).toBe(false)
    expect(isRefusedUpload('PUT', '/api/boards/b-123/thumbnail/meta', 429)).toBe(false)
  })

  it('a body that never comes is given up on after the timeout; a body that comes is read', async () => {
    expect(await readBody(response('GET', 200, never), '/api/me', 30)).toEqual({ body: '', unread: 'timeout' })
    const ok = response('GET', 200, async () => '{"ok":true}')
    expect(await readBody(ok, '/api/me', 30)).toEqual({ body: '{"ok":true}', unread: null })
    // a body whose text is the word itself is still a body
    expect(await readBody(response('GET', 200, async () => 'timeout'), '/api/x', 30)).toEqual({
      body: 'timeout',
      unread: null,
    })
    // a body the browser cannot give (a failed request) is not recorded, as before
    const failed = response('GET', 200, () => Promise.reject(new Error('gone')))
    expect(await readBody(failed, '/api/me', 30)).toBeNull()
  })
})

/** A page and context with just what NetworkLog.attach uses; `respond` fires a page 'response' event. */
function fakeBrowser() {
  const listeners: ((res: unknown) => void)[] = []
  const page = {
    on(event: string, fn: (res: unknown) => void) {
      if (event === 'response') listeners.push(fn)
    },
  }
  const cdp = { on() {}, send: async () => ({}) }
  const context = { newCDPSession: async () => cdp }
  const respond = (method: string, url: string, status: number, text: () => Promise<string>) => {
    for (const l of listeners) l({ url: () => url, ...response(method, status, text) })
  }
  return { page, context, respond }
}

describe('NetworkLog.settle', () => {
  it('ends with a refused thumbnail upload pending, and records it as unread', async () => {
    const b = fakeBrowser()
    const log = new NetworkLog()
    await log.attach(b.context as never, b.page as never)
    b.respond('GET', 'http://web/api/me', 200, async () => '{"me":1}')
    b.respond('PUT', 'http://web/api/boards/b-123/thumbnail', 429, never)
    const settled = await Promise.race([
      log.settle().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('hung'), 2_000)),
    ])
    expect(settled).toBe('settled')
    // in the order the bodies were read (the refused upload's at once)
    expect(log.responses.map((r) => [r.path, r.status, r.body]).sort()).toEqual([
      ['/api/boards/b-123/thumbnail', 429, ''],
      ['/api/me', 200, '{"me":1}'],
    ])
    expect(log.unread).toEqual([{ path: '/api/boards/b-123/thumbnail', status: 429, why: 'refused-upload' }])
  })
})
