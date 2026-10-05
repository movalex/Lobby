// GET /api/diag/stream: the stream diagnostic the live smoke uses to tell whether a proxy in front of the
// api passes an event stream through as it is written (the board event stream depends on that).
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApi, type TestApi } from './helpers.ts'

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

describe('GET /api/diag/stream', () => {
  it('answers without auth, sends the padding first, then three ticks about a second apart, then ends', async () => {
    api = await createTestApi()
    await api.app.listen({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`
    const t0 = Date.now()
    const res = await fetch(`${base}/api/diag/stream`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const dec = new TextDecoder()
    let wire = ''
    const tickAt: number[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = dec.decode(value, { stream: true })
      wire += chunk
      for (const _ of chunk.matchAll(/data: \{"tick":\d\}/g)) tickAt.push(Date.now() - t0)
    }
    expect(wire.startsWith(`:${' '.repeat(2048)}\n\n`)).toBe(true)
    expect([...wire.matchAll(/data: \{"tick":(\d)\}/g)].map((m) => m[1])).toEqual(['1', '2', '3'])
    // written as it goes, not at the end: the first tick arrives well before the last
    expect(tickAt).toHaveLength(3)
    expect((tickAt[2] ?? 0) - (tickAt[0] ?? 0)).toBeGreaterThanOrEqual(1_500)
  }, 15_000)
})
