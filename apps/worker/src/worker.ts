// Preview worker process (milestone 0): `node src/worker.ts` with DRAFTROOM_DATA_DIR set.
// Runs outside the sync process; it only reads originals and writes derivatives + meta.json.
import { dataLayout, ensureLayout, resolveDataDir } from '@draftroom/dev-assets'
import { WORKER } from './config.ts'
import { startWorker } from './loop.ts'

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`)
  return n
}

const log = (line: string) => console.log(`[worker] ${line}`)

const layout = ensureLayout(dataLayout(resolveDataDir()))
const pollMs = intEnv('WORKER_POLL_MS', WORKER.pollMs, 10) // 0 would spin the CPU
const graceMs = intEnv('WORKER_SHUTDOWN_GRACE_MS', WORKER.shutdownGraceMs, 0)
const worker = startWorker(layout, {
  pollMs,
  ffmpegPath: process.env.FFMPEG_PATH || undefined,
  ffprobePath: process.env.FFPROBE_PATH || undefined,
  log,
})
log(`started (data: ${layout.root}, poll ${pollMs} ms)`)

let requests = 0
function shutdown(reason: string) {
  requests++
  if (requests === 1) {
    const job = worker.currentJob()
    log(`${reason}: stopping${job ? `, finishing ${job} (up to ${graceMs} ms)` : ''}`)
    void worker.stop(graceMs)
  } else {
    log(`${reason} again: releasing the current job now`)
    void worker.stop(0)
  }
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
// Windows cannot deliver a catchable SIGINT/SIGTERM from another process (child.kill() terminates
// outright), so a supervisor that spawned us with an IPC channel can ask for the same shutdown.
if (process.send) {
  process.on('message', (m) => {
    if (m === 'shutdown') shutdown('shutdown message')
  })
}

await worker.done
log('stopped')
if (process.connected) process.disconnect()
