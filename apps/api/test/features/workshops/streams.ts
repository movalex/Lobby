// Real board event streams for the workshops tests (raise hand follows their lifetime): the app
// listens on an ephemeral port and each stream is a fetch that reads `data:` frames until aborted.

import type { AddressInfo } from 'node:net'
import { ORIGIN } from '../../helpers.ts'
import type { World } from './support.ts'

export interface OpenStream {
  events: { type: string; data: unknown }[]
  waitFor(type: string, pred?: (data: unknown) => boolean): Promise<{ type: string; data: unknown }>
  /** Aborts the request (the browser tab closing) and waits until the server has let go of it. */
  close(): Promise<void>
}

export async function listen(w: World): Promise<string> {
  await w.api.app.listen({ host: '127.0.0.1', port: 0 })
  return `http://127.0.0.1:${(w.api.app.server.address() as AddressInfo).port}`
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

export async function openStream(w: World, base: string, cookie: string): Promise<OpenStream> {
  const before = w.hub.subscriberCount(w.boardId)
  const controller = new AbortController()
  const res = await fetch(`${base}/api/boards/${w.boardId}/events`, {
    headers: { cookie, origin: ORIGIN },
    signal: controller.signal,
  })
  if (res.status !== 200) throw new Error(`stream refused: ${res.status}`)
  const events: { type: string; data: unknown }[] = []
  const pump = (async () => {
    if (!res.body) return
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        let i = buf.indexOf('\n\n')
        while (i >= 0) {
          const line = buf
            .slice(0, i)
            .split('\n')
            .find((l) => l.startsWith('data: '))
          buf = buf.slice(i + 2)
          if (line) events.push(JSON.parse(line.slice(6)))
          i = buf.indexOf('\n\n')
        }
      }
    } catch {
      // aborted
    }
  })()
  const waitFor: OpenStream['waitFor'] = async (type, pred = () => true) => {
    for (let i = 0; i < 150; i++) {
      const e = events.find((x) => x.type === type && pred(x.data))
      if (e) return e
      await tick()
    }
    throw new Error(`no ${type} event; got ${JSON.stringify(events.map((e) => e.type))}`)
  }
  await waitFor('hello')
  // The stream is subscribed (and counted as open) once the hub has one more listener.
  for (let i = 0; i < 100 && w.hub.subscriberCount(w.boardId) <= before; i++) await tick()
  return {
    events,
    waitFor,
    async close() {
      const n = w.hub.subscriberCount(w.boardId)
      controller.abort()
      await pump
      // The server's close handlers run when it notices the socket is gone.
      for (let i = 0; i < 150 && w.hub.subscriberCount(w.boardId) >= n; i++) await tick()
      if (w.hub.subscriberCount(w.boardId) >= n)
        throw new Error('the server never noticed the stream closing')
    },
  }
}
