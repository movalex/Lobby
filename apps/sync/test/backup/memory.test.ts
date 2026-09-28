// A 50 MB board backup goes offsite without its size showing up in the process's memory (the sync
// instance has 512 MB): measured in a separate process (memory-child.ts) for the fs driver and for the
// R2 driver over a loopback S3 stand-in, next to a control that buffers the file and must show it.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackupEntry, backupBoard } from '../../src/backup/backup.ts'
import { boardDbPath, RoomRegistry } from '../../src/rooms.ts'
import { indexFor, note } from '../deleted/fixtures.ts'
import { type TempData, tempData } from './offsite-fixtures.ts'

const BOARD = 'big-board'
const MiB = 1024 * 1024
const child = fileURLToPath(new URL('./memory-child.ts', import.meta.url))
let data: TempData
let entry: BackupEntry
let s3: Server
/** Bytes the S3 stand-in received in object PUTs. */
let received = 0

interface Measured {
  mode: string
  ok: boolean
  sizeBytes: number
  baseline: number
  peak: number
  peakArrayBuffers: number
}

function measure(mode: 'fs' | 'r2' | 'buffered'): Promise<Measured> {
  const port = String((s3.address() as AddressInfo).port)
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--expose-gc', child, data.root, BOARD, mode, port], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (c: Buffer) => {
      out += c
    })
    p.stderr.on('data', (c: Buffer) => {
      err += c
    })
    const timer = setTimeout(() => p.kill(), 120_000)
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`memory child (${mode}) failed: ${err.slice(0, 2000)}`))
      const m = JSON.parse(out.trim().split('\n').at(-1) ?? '') as Measured
      // Printed with the test output, as evidence of the numbers.
      console.log(
        `[memory] ${mode}: file ${(m.sizeBytes / MiB).toFixed(1)} MiB, RSS +${((m.peak - m.baseline) / MiB).toFixed(1)} MiB, peak ArrayBuffers ${(m.peakArrayBuffers / MiB).toFixed(1)} MiB`,
      )
      resolve(m)
    })
  })
}

beforeAll(async () => {
  data = tempData('dr-offsite-memory-')
  s3 = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(404, { 'content-type': 'application/xml' })
      return void res.end('<Error><Code>NoSuchKey</Code></Error>')
    }
    const object = req.url?.endsWith('.sqlite') ?? false
    req.on('data', (c: Buffer) => {
      if (object) received += c.byteLength
    })
    req.on('end', () => res.writeHead(200).end())
  })
  await new Promise<void>((r) => s3.listen(0, '127.0.0.1', () => r()))
  const reg = new RoomRegistry({ dataDir: data.rooms, schema: draftroomSchema, backup: false })
  reg.getOrCreate(BOARD) // initializes the board database
  reg.closeAll()
  const db = new DatabaseSync(boardDbPath(data.rooms, BOARD))
  try {
    // ~53 MB of real, valid note records (random text: SQLite stores it as is)
    const insert = db.prepare('INSERT INTO documents (id, state, lastChangedClock) VALUES (?, ?, 1)')
    db.exec('BEGIN')
    for (let i = 0; i < 820; i++) {
      const rec = note(`big${i}`, randomBytes(50_000).toString('base64'), { index: indexFor(i + 10) })
      insert.run(rec.id, Buffer.from(JSON.stringify(rec)))
    }
    db.exec('UPDATE metadata SET documentClock = 1')
    db.exec('COMMIT')
    entry = await backupBoard({ db, boardId: BOARD, root: data.backups })
  } finally {
    db.close()
  }
}, 120_000)
afterAll(async () => {
  await new Promise<void>((r) => (s3 ? s3.close(() => r()) : r()))
  data?.cleanup()
})

describe('a 50 MB board backup uploads in constant memory', () => {
  it('is at least 50 MB', () => {
    expect(entry.sizeBytes).toBeGreaterThanOrEqual(50 * MiB)
  })

  it('the control that buffers the file shows its size (the measurement can see it)', async () => {
    const m = await measure('buffered')
    expect(m.ok).toBe(true)
    expect(m.peak - m.baseline).toBeGreaterThan(0.8 * m.sizeBytes)
  })

  it.each(['fs', 'r2'] as const)('%s driver: memory grows by a small fraction of the file', async (mode) => {
    received = 0
    const m = await measure(mode)
    expect(m.ok).toBe(true)
    if (mode === 'r2') expect(received).toBe(m.sizeBytes) // the bytes really went out
    // A few chunks in flight, never the file (measured on the dev PC: RSS +0-4 MiB, buffers < 6 MiB).
    expect(m.peakArrayBuffers).toBeLessThan(8 * MiB)
    expect(m.peak - m.baseline).toBeLessThan(16 * MiB)
  })
})
