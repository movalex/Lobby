// Board event streams over real sockets (SSE cannot go through app.inject: the route hijacks the
// response). Each stream is a fetch that parses `data:` frames until the server ends it or we abort.

import type { AddressInfo } from 'node:net'
import { ORIGIN, type TestApi } from './helpers.ts'

export interface SseEvent {
  type: string
  data: unknown
}

export interface SseStream {
  status: number
  headers: Headers
  /** The JSON body of a refused (non-200) stream. */
  body: unknown
  events: SseEvent[]
  /** Raw `retry:` values the server sent (the browser's reconnect delay). */
  retries: number[]
  waitFor(type: string, timeoutMs?: number): Promise<SseEvent>
  /** True once the server ended the stream (the reader finished without our abort). */
  ended(): boolean
  /** Resolves when the server ends the stream, or rejects after timeoutMs. */
  waitEnded(timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

export async function listen(api: TestApi): Promise<string> {
  await api.app.listen({ host: '127.0.0.1', port: 0 })
  return `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

export function openSse(base: string, boardId: string, cookie: string): Promise<SseStream> {
  return openSseAt(`${base}/api/boards/${boardId}/events`, { cookie, origin: ORIGIN })
}

/**
 * A stream at any URL with exactly these request headers (wave H1: a ticket in Authorization and no
 * cookie, another Origin, a query string).
 */
export async function openSseAt(url: string, headers: Record<string, string>): Promise<SseStream> {
  const controller = new AbortController()
  const res = await fetch(url, { headers, signal: controller.signal })
  const events: SseEvent[] = []
  const retries: number[] = []
  let body: unknown = null
  let serverEnded = false
  let aborted = false
  const pump = (async () => {
    if (res.status !== 200) {
      body = await res.json().catch(() => null)
      serverEnded = true
      return
    }
    if (!res.body) return
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          if (!aborted) serverEnded = true
          return
        }
        buf += dec.decode(value, { stream: true })
        let i = buf.indexOf('\n\n')
        while (i >= 0) {
          const lines = buf.slice(0, i).split('\n')
          buf = buf.slice(i + 2)
          for (const l of lines) {
            if (l.startsWith('retry: ')) retries.push(Number(l.slice(7)))
            if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6)))
          }
          i = buf.indexOf('\n\n')
        }
      }
    } catch {
      // aborted by us
    }
  })()
  if (res.status !== 200) await pump
  const stream: SseStream = {
    status: res.status,
    headers: res.headers,
    get body() {
      return body
    },
    events,
    retries,
    async waitFor(type, timeoutMs = 3_000) {
      const until = Date.now() + timeoutMs
      for (;;) {
        const e = events.find((x) => x.type === type)
        if (e) return e
        if (Date.now() > until)
          throw new Error(`no ${type} event; got ${JSON.stringify(events.map((x) => x.type))}`)
        await tick()
      }
    },
    ended: () => serverEnded,
    async waitEnded(timeoutMs = 3_000) {
      const until = Date.now() + timeoutMs
      while (!serverEnded) {
        if (Date.now() > until)
          throw new Error(`the stream is still open; got ${JSON.stringify(events.map((x) => x.type))}`)
        await tick()
      }
    },
    async close() {
      aborted = true
      controller.abort()
      await pump
    },
  }
  return stream
}

/** Polls until `check` holds (the server's close handlers run when it notices a socket is gone). */
export async function until(check: () => boolean, timeoutMs = 3_000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick()
  }
}
