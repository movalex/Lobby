// Process supervisor for docker/api-worker.Dockerfile (Render staging, milestones 1-2 only).
//
// Why it exists: the M0/M1 file store is local disk under DRAFTROOM_DATA_DIR, shared by the API (which
// writes uploads and enqueues jobs) and the preview worker (which claims jobs and writes derivatives).
// A Render persistent disk attaches to exactly one service, so both processes must run in one container.
// When files move to object storage (milestone 3) the worker becomes its own background worker and this
// file goes away.
//
// Semantics:
// - Both children inherit env and stdio (they already prefix/format their own log lines).
// - The first SIGTERM/SIGINT is forwarded ONCE to each child. A second signal is ignored on purpose: the
//   worker treats a repeated signal as "abandon the current job now", which is not what a platform retry
//   of the same shutdown means.
// - A child that exits on its own is a failure: the other child is stopped and the supervisor exits
//   non-zero so the platform restarts the whole container (never a half-running pair).
// - Children still running KILL_AFTER_MS after the forwarded signal are SIGKILLed, so the container exits
//   inside Render's default 30 s shutdown delay.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const KILL_AFTER_MS = 25_000

const specs = [
  { name: 'api', script: fileURLToPath(new URL('../apps/api/src/server.ts', import.meta.url)) },
  { name: 'worker', script: fileURLToPath(new URL('../apps/worker/src/worker.ts', import.meta.url)) },
]

const log = (line) => console.log(`[supervisor] ${line}`)

let stopping = false
let failed = false
let running = specs.length

const children = specs.map(({ name, script }) => {
  const child = spawn(process.execPath, [script], { stdio: 'inherit' })
  let done = false
  const finished = (code, signal) => {
    if (done) return
    done = true
    running--
    const how = signal ? `signal ${signal}` : `code ${code}`
    if (!stopping) {
      log(`${name} exited on its own (${how}); stopping the other process`)
      failed = true
      stopAll('SIGTERM')
    } else {
      // A child without its own SIGTERM handler dies by the forwarded signal: that is a clean stop.
      if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') failed = true
      log(`${name} stopped (${how})`)
    }
    if (running === 0) process.exit(failed ? 1 : 0)
  }
  child.on('exit', finished)
  child.on('error', (err) => {
    log(`${name} could not be started: ${err.message}`)
    finished(1, null)
  })
  return { name, child, isDone: () => done }
})

log(`started ${children.map(({ name, child }) => `${name} (pid ${child.pid})`).join(' and ')}`)

function stopAll(signal) {
  stopping = true
  for (const { child, isDone } of children) if (!isDone()) child.kill(signal)
  setTimeout(() => {
    for (const { name, child, isDone } of children) {
      if (isDone()) continue
      log(`${name} did not stop within ${KILL_AFTER_MS} ms; killing it`)
      failed = true
      child.kill('SIGKILL')
    }
  }, KILL_AFTER_MS).unref()
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) {
      log(`${signal} again: already stopping`)
      return
    }
    log(`${signal}: stopping api and worker`)
    stopAll(signal)
  })
}
