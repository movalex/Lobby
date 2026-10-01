// One load worker thread (runner.ts runInWorkers): regenerates the profile's boards (deterministic),
// loads O2's headless client, runs its share of the sessions and posts their reports back.
import { parentPort, workerData } from 'node:worker_threads'
import { loadHeadlessFactory } from './headless.ts'
import { boardsOf } from './plan.ts'
import { PROFILES } from './profiles.ts'
import { boardsFromSpecs, runInThread, type WorkerJob } from './runner.ts'
import { thinClientFactory } from './thin.ts'

const job = workerData as WorkerJob
let stop = false
parentPort?.on('message', (m: { type?: string }) => {
  if (m?.type === 'stop') stop = true
})
try {
  const profile = PROFILES[job.profileName]
  if (!profile) throw new Error(`unknown profile ${job.profileName}`)
  const boards = job.boardSpecs
    ? boardsFromSpecs(job.boardSpecs)
    : boardsOf(profile, { fileIds: job.fileIds })
  const createClient = await loadHeadlessFactory()
  const result = await runInThread(
    {
      profile,
      boards,
      plans: job.plans,
      syncHttpUrl: job.syncHttpUrl,
      t0: job.t0,
      durationMs: job.durationMs,
      probeSids: new Map(job.probeSids),
      reconnectAfterMs: job.reconnectAfterMs,
      stopped: () => stop,
      createThinClient: thinClientFactory,
    },
    createClient,
  )
  parentPort?.postMessage(result)
  parentPort?.close()
} catch (e) {
  parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) })
}
