// Gate: "killed/restarted server keeps acknowledged changes". A push_result is only sent after the
// push's SQLite COMMIT, so every acked edit must be served after any kind of restart.
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape, type ShapeRecord } from '../harness/records.ts'
import type { SyncServer } from '../harness/server-process.ts'
import type { NodeSyncClient } from '../harness/sync-client.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()

type Edit = { id: string; kind: 'create' | 'update'; x: number } | { id: string; kind: 'delete' }

/** Each edit targets a distinct shape, so its effect after restart is unambiguous. */
function planRound(round: number, existing: string[]): Edit[] {
  const creates: Edit[] = []
  for (let i = 0; i < 60; i++)
    creates.push({ id: `shape:r${round}-${i}`, kind: 'create', x: round * 1000 + i })
  const changes: Edit[] = existing.map((id, i) =>
    i % 3 === 0 ? { id, kind: 'delete' } : { id, kind: 'update', x: round * 1000 + 500 + i },
  )
  // interleave creates with updates/deletes so the kill lands in a mixed stream
  const edits: Edit[] = []
  for (let i = 0; i < Math.max(creates.length, changes.length); i++) {
    const c = creates[i]
    const u = changes[i]
    if (c) edits.push(c)
    if (u) edits.push(u)
  }
  return edits
}

function apply(writer: NodeSyncClient, e: Edit) {
  if (e.kind === 'delete') writer.remove(e.id)
  else if (e.kind === 'create') writer.put(geoShape(e.id, { x: e.x }))
  else writer.update(e.id, (r) => ({ ...r, x: e.x }))
}

function missingAfterRestart(acked: Edit[], served: Map<string, ShapeRecord>): string[] {
  return acked
    .filter((e) => (e.kind === 'delete' ? served.has(e.id) : served.get(e.id)?.x !== e.x))
    .map((e) => `${e.kind} ${e.id}`)
}

/**
 * Streams the edits (one push each, ~1 ms apart, like fast typing/dragging) and calls `stop`
 * synchronously inside the socket handler when the `stopAfterAcks`-th commit arrives, so the kill
 * lands while the writer is still producing pushes.
 */
async function streamUntilStopped(
  writer: NodeSyncClient,
  edits: Edit[],
  stopAfterAcks: number,
  stop: () => void,
) {
  const byClock = new Map<number, Edit>()
  const acked: Edit[] = []
  const notCommitted: unknown[] = []
  let stopped = false
  const off = writer.onPushResult((r) => {
    const edit = byClock.get(r.clientClock)
    if (!edit || stopped) return
    if (r.action !== 'commit') notCommitted.push(r.action) // asserted by the caller, not thrown in a socket handler
    acked.push(edit)
    if (acked.length === stopAfterAcks) {
      stopped = true
      stop()
    }
  })
  const sent: Edit[] = []
  for (const e of edits) {
    if (stopped) break
    apply(writer, e)
    const clock = writer.lastPushClock()
    if (clock !== undefined) byClock.set(clock, e)
    sent.push(e)
    await sleep(1)
  }
  await waitFor(() => stopped, { describe: () => `${acked.length}/${stopAfterAcks} acks` })
  off()
  return { acked: [...acked], sent, notCommitted }
}

async function runKillRound(server: SyncServer, boardId: string, round: number, existing: string[]) {
  const writer = await h.connected(server, { boardId, user: 'alice', autoReconnect: false })
  const edits = planRound(round, existing)
  const { acked, sent, notCommitted } = await streamUntilStopped(
    writer,
    edits,
    Math.floor(edits.length / 2),
    () => {
      void server.kill('SIGKILL')
    },
  )
  await server.kill('SIGKILL') // resolves once the child has exited
  writer.dispose()
  await server.restart()
  const served = await h.freshView(server, boardId)
  expect(notCommitted).toEqual([])
  return { edits, acked, sent, served }
}

describe('durability across server restarts (real child process, same data dir)', () => {
  it('SIGKILL mid-stream: a fresh client sees every acked create/update/delete (3 rounds, 0 acked-but-missing)', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    let existing: string[] = []
    const report: string[] = []
    for (let round = 1; round <= 3; round++) {
      const { edits, acked, sent, served } = await runKillRound(server, boardId, round, existing)
      expect(acked.length).toBe(Math.floor(edits.length / 2))
      expect(missingAfterRestart(acked, served)).toEqual([])
      const unacked = sent.filter((e) => !acked.includes(e))
      const unackedButApplied = unacked.filter((e) =>
        e.kind === 'delete' ? !served.has(e.id) : served.get(e.id)?.x === e.x,
      )
      report.push(
        `round ${round}: ${edits.length} planned, ${sent.length} sent, ${acked.length} acked, ` +
          `${unackedButApplied.length}/${unacked.length} sent-but-unacked also persisted, 0 acked-but-missing`,
      )
      existing = [...served.keys()]
    }
    console.info(`[durability] ${report.join('; ')}`)
  })

  it('SIGINT graceful shutdown (server.close) right after deletes exits 0 and keeps every acked edit, deletes included (2 rounds)', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    let existing: string[] = []
    for (let round = 1; round <= 2; round++) {
      const writer = await h.connected(server, { boardId, user: 'alice', autoReconnect: false })
      const edits = planRound(round, existing)
      for (const e of edits) apply(writer, e)
      await writer.waitForAcked()
      expect(writer.pushResults.every((r) => r.action === 'commit')).toBe(true)
      // Runs the server's own SIGINT handler (close sockets, flush + close every room DB, exit 0)
      // while the deletes' tombstone-prune timer is still pending.
      const exit = await server.kill('SIGINT')
      expect(exit, server.logs()).toEqual({ code: 0, signal: null })
      writer.dispose()
      await server.restart()
      const served = await h.freshView(server, boardId)
      expect(missingAfterRestart(edits, served)).toEqual([])
      existing = [...served.keys()]
    }
  })

  it('a session open across a graceful restart reconnects by itself and pushes edits made while the server was down', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const a = await h.connected(server, { boardId, user: 'alice' })
    a.put(geoShape('before', { x: 1 }))
    await a.waitForAcked()

    expect(await server.kill('SIGINT')).toEqual({ code: 0, signal: null })
    await sleep(50)
    expect(a.status).toBe('offline') // not 'error': the close is not terminal for the client
    expect(a.closes.every((c) => c.code !== 4099)).toBe(true)
    a.put(geoShape('while-down', { x: 2 })) // kept in memory, pushed after reconnect

    await server.restart()
    await a.waitForAcked(15_000)
    const served = await h.freshView(server, boardId)
    expect(served.get('shape:before')?.x).toBe(1)
    expect(served.get('shape:while-down')?.x).toBe(2)
    expect(a.syncErrors).toEqual([])
  })
})
