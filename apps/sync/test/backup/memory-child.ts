// Child process of memory.test.ts: uploads one existing local backup offsite and reports its RSS.
//
//   node --expose-gc memory-child.ts <dataRoot> <boardId> <fs|r2|buffered> [<s3 stand-in port>]
//
// fs: the offsite copy (offsite.ts) into the fs store under <dataRoot>/blobs.
// r2: the same through the R2 driver against the parent's loopback S3 stand-in, which discards what it
//     receives (the real network path: fetch with a streamed body).
// buffered: the control: the file read into memory whole, then stored. It must show the file's size.
//
// A full GC runs at every sample, so garbage that merely has not been collected yet does not count:
// what shows is memory the upload keeps alive.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { type BlobStore, createFsBlobStore, createR2BlobStore } from '@draftroom/blob-store'
import { readManifest } from '../../src/backup/backup.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { backupSigningKey } from '../../src/backup/signing.ts'

const [root = '', board = '', mode = 'fs'] = process.argv.slice(2)
const gc = (globalThis as { gc?: () => void }).gc
if (!gc) throw new Error('run with --expose-gc')

const backups = join(root, 'backups')
const entry = readManifest(backups, board)?.backups.at(-1)
if (!entry) throw new Error('no local backup')

let store: BlobStore
if (mode === 'r2') {
  // The S3 stand-in runs in the parent (memory.test.ts), so only the sending side is measured here.
  const port = Number(process.argv[5])
  store = createR2BlobStore({
    accountId: '0123456789abcdef0123456789abcdef',
    accessKeyId: 'AKIAFAKEACCESSKEY0001',
    secretAccessKey: 'fakeSecretAccessKey0123456789',
    bucket: 'draftroom-test',
    endpoint: `http://127.0.0.1:${port}`,
  })
} else store = createFsBlobStore(join(root, 'blobs'))

// Warm up every code path once on small objects (a streamed and a byte PUT, a GET), so module, JIT
// and HTTP-client memory are in the baseline.
const warm = Buffer.alloc(1024 * 1024, 7)
await store.put('warmup/stream', Readable.from([warm.subarray(0, 512 * 1024), warm.subarray(512 * 1024)]), {
  contentType: 'application/octet-stream',
  contentLength: warm.byteLength,
})
await store.put('warmup/bytes', Buffer.from('x'), { contentType: 'text/plain', contentLength: 1 })
await store.get('warmup/missing')
for (let i = 0; i < 3; i++) gc()
const baseline = process.memoryUsage().rss
let peak = baseline
let peakArrayBuffers = 0
const sample = () => {
  gc()
  const m = process.memoryUsage()
  peak = Math.max(peak, m.rss)
  peakArrayBuffers = Math.max(peakArrayBuffers, m.arrayBuffers)
}
const timer = setInterval(sample, 5)

let ok = false
if (mode === 'buffered') {
  const bytes = readFileSync(join(backups, board, entry.file))
  sample()
  await store.put(`backups/sync/${board}/${entry.file}`, bytes, {
    contentType: 'application/vnd.sqlite3',
    contentLength: bytes.byteLength,
  })
  sample()
  ok = bytes.byteLength === entry.sizeBytes
} else {
  const signingKey = backupSigningKey('test-only-internal-secret-0123456789-abcdef')
  const offsite = new OffsiteBackups({ store, localRoot: backups, signingKey })
  await offsite.syncBoard(board)
  const status = offsite.status().boards[0]
  ok = status?.lastSuccessFile === entry.file && status.failures === 0
  if (!ok) console.error(JSON.stringify(status))
}
clearInterval(timer)
sample()
console.log(JSON.stringify({ mode, ok, sizeBytes: entry.sizeBytes, baseline, peak, peakArrayBuffers }))
