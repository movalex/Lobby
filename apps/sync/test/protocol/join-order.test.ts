// PERF-05: joins are serialized (one TLSync connect per macrotask, src/join-queue.ts). A socket's own
// frames must keep their order behind its queued connect, and people already on the board keep
// editing while a crowd joins.
import { draftroomSchema } from '@draftroom/canvas-schema'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import type { NetworkDiff, ServerMessage } from '../harness/sync-client.ts'
import { mintTicket } from '../harness/tickets.ts'
import { waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()

interface RawPeer {
  ws: WebSocket
  messages: ServerMessage[]
  opened: Promise<void>
}

function rawPeer(wsUrl: string, boardId: string, user: string): RawPeer {
  const q = new URLSearchParams({ sessionId: `raw-${user}`, ticket: mintTicket(boardId, user) })
  const ws = new WebSocket(`${wsUrl}/connect/${boardId}?${q}`)
  const messages: ServerMessage[] = []
  ws.on('message', (d) => messages.push(JSON.parse(String(d)) as ServerMessage))
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return { ws, messages, opened }
}

/** The protocol version a real TLSyncClient speaks (sync-core keeps its getter internal). */
let protocolVersion = 0
const connectFrame = (id: string) =>
  JSON.stringify({
    type: 'connect',
    connectRequestId: id,
    schema: draftroomSchema.serialize(),
    protocolVersion,
    lastServerClock: -1,
  })
const pushFrame = (clientClock: number, diff: NetworkDiff) =>
  JSON.stringify({ type: 'push', clientClock, diff })

/** Server events flattened out of `data` batches. */
function events(p: RawPeer): { type: string; clientClock?: number; action?: unknown }[] {
  return p.messages.flatMap((m) =>
    m.type === 'data' ? (m.data as { type: string }[]) : [m as unknown as { type: string }],
  )
}

describe('join serialization', () => {
  it("a newcomer's push sent right behind its connect is applied after it, while 12 others join at once", async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const editor = await h.connected(server, { boardId, user: 'alice' })
    protocolVersion = editor.sent.flatMap((m) => (m.type === 'connect' ? [m.protocolVersion] : []))[0] ?? 0
    // Enough records that each join's full snapshot is real work for the server.
    const diff: NetworkDiff = {}
    for (let i = 0; i < 400; i++) {
      const s = geoShape(`seed-${i}`, { x: i * 3 })
      diff[s.id] = ['put', s]
    }
    editor.sendRawPush(diff)
    await editor.waitForAcked()

    const crowd = Array.from({ length: 12 }, (_, i) => rawPeer(server.wsUrl, boardId, `joiner${i}`))
    const newcomer = rawPeer(server.wsUrl, boardId, 'newcomer')
    await Promise.all([...crowd, newcomer].map((p) => p.opened))

    // Everyone's connect in one burst; the newcomer's push goes out in the same tick as its connect.
    for (const [i, p] of crowd.entries()) p.ws.send(connectFrame(`c${i}`))
    const ordered = geoShape('ordered', { x: 7 })
    newcomer.ws.send(connectFrame('n'))
    newcomer.ws.send(pushFrame(1, { [ordered.id]: ['put', ordered] }))
    // An editor already on the board keeps working meanwhile.
    editor.put(geoShape('during-joins', { x: 9 }))

    await waitFor(() => events(newcomer).some((e) => e.type === 'push_result'), {
      timeoutMs: 20_000,
      describe: () => JSON.stringify(events(newcomer).map((e) => e.type)),
    })
    const seen = events(newcomer)
    const connectAt = seen.findIndex((e) => e.type === 'connect')
    const resultAt = seen.findIndex((e) => e.type === 'push_result')
    expect(connectAt).toBe(0) // the push was not handled before the connect it followed
    expect(resultAt).toBeGreaterThan(connectAt)
    expect(seen[resultAt]).toMatchObject({ clientClock: 1, action: 'commit' })

    await waitFor(() => crowd.every((p) => events(p).some((e) => e.type === 'connect')), {
      timeoutMs: 20_000,
    })
    await editor.waitForAcked()
    expect(editor.pushResults.at(-1)?.action).toBe('commit')
    for (const p of [...crowd, newcomer]) expect(p.ws.readyState).toBe(WebSocket.OPEN)

    const served = await h.freshView(server, boardId)
    expect(served.has(ordered.id)).toBe(true)
    expect(served.has(geoShape('during-joins').id)).toBe(true)
    expect(served.size).toBe(402)
    for (const p of [...crowd, newcomer]) p.ws.close()
  })

  it('a socket that closes while its connect is queued leaves nothing behind; the next join works', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const editor = await h.connected(server, { boardId, user: 'alice' })
    protocolVersion = editor.sent.flatMap((m) => (m.type === 'connect' ? [m.protocolVersion] : []))[0] ?? 0
    const quitter = rawPeer(server.wsUrl, boardId, 'quitter')
    await quitter.opened
    quitter.ws.send(connectFrame('q'))
    quitter.ws.terminate() // gone before (or right as) its turn comes
    const next = await h.connected(server, { boardId, user: 'bob' })
    next.put(geoShape('after-quitter'))
    await next.waitForAcked()
    await waitFor(() => editor.get(geoShape('after-quitter').id))
    expect(next.pushResults.at(-1)?.action).toBe('commit')
  })
})
