// The disk's commit cost on the volume sync's data dir is on (docs/EXCALIDRAW-MIGRATION.md §2.13 "fsync is
// the unknown", §8.3 B9 "Disk: fsync p50/p99 on the NAS volume"): n single-row SQLite commits with sync's
// own pragmas (WAL, synchronous=FULL), and n raw 4 KiB write+fsync calls, each timed; prints JSON and
// removes its files. On the NAS it runs in a --network none container on the data folder:
//   node e2e/load/fsync-probe.ts --dir /var/data --n 2000
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { LB_PRAGMAS } from '../../apps/sync/src/room/schema.ts'
import { summarize } from './stats.ts'

const { values } = parseArgs({ options: { dir: { type: 'string' }, n: { type: 'string', default: '2000' } } })
if (!values.dir) throw new Error('--dir is required')
const n = Number(values.n)
const dir = mkdtempSync(join(values.dir, 'fsync-probe-'))
try {
  const raw: number[] = []
  const fd = openSync(join(dir, 'raw.bin'), 'w')
  const buf = Buffer.alloc(4096, 7)
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint()
    writeSync(fd, buf)
    fsyncSync(fd)
    raw.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  closeSync(fd)
  const db = new DatabaseSync(join(dir, 'probe.sqlite'))
  for (const p of LB_PRAGMAS) db.exec(p)
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, data TEXT NOT NULL)')
  const ins = db.prepare('INSERT INTO t (data) VALUES (?)')
  const commits: number[] = []
  const row = 'x'.repeat(1200) // about a note with its label (§2.13)
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint()
    db.exec('BEGIN IMMEDIATE')
    ins.run(row)
    db.exec('COMMIT')
    commits.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  db.close()
  console.log(
    JSON.stringify({ n, dir: values.dir, rawFsyncMs: summarize(raw), sqliteCommitMs: summarize(commits) }),
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
