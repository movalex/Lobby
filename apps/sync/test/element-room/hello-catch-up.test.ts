// The raw protocol clients' hello (support/client.ts, harness/element-client.ts) against a room that serves a
// REUSED snapshot: the joiner gets the welcome at the snapshot's clock, the gzip snapshot, then a `changes`
// frame with the rows written since it, and the room's `contracts` frame last (element-room.ts `hello`,
// SNAPSHOT_REUSE, since 2026-10-01). hello() used to resolve on the snapshot alone, so a test that read the
// joiner's copy right after connecting raced that `changes` frame: bound-arrows.test.ts read
// `confirmed.get('A')` as undefined now and then on a 2-vCPU Linux box (the likeliest cause of CI's red unit
// shard 4/4). The second test replays the real room's frames with the `changes` frame held back, which fails
// on the old hello every time instead of now and then.

import { ELEMENT_SCHEMA_VERSION, PROTO } from '@draftroom/canvas-schema/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { type RawData, WebSocketServer } from 'ws'
import { ProtocolClient } from '../harness/element-client.ts'
import { boardSocketTarget } from '../harness/tickets.ts'
import { RawClient, ticketFor } from './support/client.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const fakes: WebSocketServer[] = []
afterEach(async () => {
  for (const s of fakes.splice(0)) {
    for (const c of s.clients) c.terminate()
    await new Promise((r) => s.close(() => r(undefined)))
  }
})

type Frame = { data: Buffer; binary: boolean; type: string }

/** Everything the room sends `user` for one hello, up to and including its `contracts` frame. */
async function recordHello(wsUrl: string, boardId: string, user: string): Promise<Frame[]> {
  const tab = `tab-${user}`
  const target = boardSocketTarget(
    `${wsUrl}/connect/${boardId}?sessionId=${encodeURIComponent(tab)}`,
    ticketFor(boardId, user),
  )
  const ws = new WebSocket(target.url, target.protocols)
  const frames: Frame[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no contracts frame within 20 s')), 20_000)
      ws.once('error', reject)
      ws.once('open', () =>
        ws.send(
          JSON.stringify({
            type: 'hello',
            proto: PROTO,
            schema: ELEMENT_SCHEMA_VERSION,
            since: 0,
            epoch: null,
            tab,
          }),
        ),
      )
      ws.on('message', (raw: RawData, binary) => {
        const data = Buffer.from(raw as Buffer)
        const type = binary ? 'snapshot' : (JSON.parse(data.toString('utf8')) as { type: string }).type
        frames.push({ data, binary, type })
        if (type === 'contracts') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
  } finally {
    ws.terminate()
  }
  return frames
}

describe('hello against a reused snapshot', () => {
  it('the room answers a joiner with an older snapshot and the rows since it, then its contracts frame', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const setup = await st.client({ boardId: b, user: 'setup' }) // its reset caches the empty board's snapshot
    await setup.create([rect('X', { x: 0, y: 0, width: 100, height: 50 })])
    const frames = await recordHello(st.server.wsUrl, b, 'bob')
    expect(frames.map((f) => f.type).slice(0, 4)).toEqual(['welcome', 'snapshot', 'changes', 'contracts'])
    const welcome = JSON.parse((frames[0] as Frame).data.toString('utf8'))
    const changes = JSON.parse((frames[2] as Frame).data.toString('utf8'))
    expect(welcome.reset).toBe(true)
    expect(welcome.clock).toBeLessThan(changes.clock)
    expect(JSON.stringify(changes.ops)).toContain('"X"')
    // and through the client: once hello() is done, the joiner holds X
    const bob = await st.client({ boardId: b, user: 'bob' })
    expect(bob.confirmed.get('X')).toBeDefined()
    expect(bob.clock).toBe(changes.clock)
  })

  it('hello() waits for the catch-up that follows a reused snapshot, however late it comes', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const setup = await st.client({ boardId: b, user: 'setup' })
    await setup.create([rect('X', { x: 0, y: 0, width: 100, height: 50 })])
    const frames = await recordHello(st.server.wsUrl, b, 'bob')
    // A stand-in room that replays those frames and holds the `changes` frame back for 300 ms.
    const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    fakes.push(fake)
    await new Promise((r) => fake.once('listening', r))
    fake.on('connection', (sock) => {
      sock.once('message', async () => {
        for (const f of frames) {
          if (f.type === 'changes') await new Promise((r) => setTimeout(r, 300))
          sock.send(f.data, { binary: f.binary })
        }
      })
    })
    const wsUrl = `ws://127.0.0.1:${(fake.address() as { port: number }).port}`
    // both raw clients: the element-room one and the harness's (the negative suite's)
    for (const connect of [RawClient.connect, ProtocolClient.connect]) {
      const bob = await connect({ wsUrl, boardId: b, user: 'bob' })
      try {
        expect(
          bob.confirmed.get('X'),
          connect === RawClient.connect ? 'RawClient' : 'ProtocolClient',
        ).toBeDefined()
        expect(bob.schemaErrors).toEqual([])
      } finally {
        bob.terminate()
      }
    }
  })
})
