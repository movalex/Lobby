// Wave M, M5-6 review: the api's /healthz/deep probe has a connection of its own (Db.ping), outside the capped pool,
// and every bound is the client's own: a database that refuses, or one that accepts and then says nothing (a hung
// connection), makes ping reject by its timeout, never hang. No Postgres needed: both are local sockets on this
// workstream's test ports.
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openPgPool } from '../src/pg.ts'
import type { Db } from '../src/types.ts'

const SILENT_PORT = 7498
const CLOSED_PORT = 7497

let db: Db | null = null
let server: Server | null = null
const sockets = new Set<Socket>()
afterEach(async () => {
  await db?.close()
  db = null
  for (const s of sockets) s.destroy()
  sockets.clear()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

const open = (port: number) =>
  openPgPool({ connectionString: `postgres://lobby:none@127.0.0.1:${port}/lobby`, maxConnections: 2 })

describe('Db.ping on Postgres (its own connection)', () => {
  it('a database that refuses: ping rejects at once', async () => {
    db = await open(CLOSED_PORT)
    expect(typeof db.ping).toBe('function')
    const started = Date.now()
    await expect(db.ping?.(1_000)).rejects.toBeTruthy()
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('a database that accepts and then says nothing: ping rejects by its timeout, and the next ping asks again', async () => {
    let connections = 0
    server = createServer((socket) => {
      connections++
      sockets.add(socket)
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => server?.listen(SILENT_PORT, '127.0.0.1', () => resolve()))
    db = await open(SILENT_PORT)
    for (let i = 1; i <= 2; i++) {
      const started = Date.now()
      await expect(db.ping?.(300)).rejects.toBeTruthy()
      const took = Date.now() - started
      expect(took).toBeGreaterThanOrEqual(250)
      expect(took).toBeLessThan(2_000)
      // the timed-out connection was dropped: the next ping opens its own
      expect(connections).toBe(i)
    }
  })
})
