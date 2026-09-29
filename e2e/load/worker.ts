// One load worker thread (runner.ts runInWorkers): regenerates the profile's boards (deterministic),
// loads O2's headless client, runs its share of the sessions and posts their reports back.
import { parentPort, workerData } from 'node:worker_threads'
import { loadHeadlessFactory } from './headless.ts'
import { boardsOf } from './plan.ts'
import { PROFILES } from './profiles.ts'
import { runInThread, type WorkerJob } from './runner.ts'

const job = workerData as WorkerJob
try {
  const profile = PROFILES[job.profileName]
  if (!profile) throw new Error(`unknown profile ${job.profileName}`)
  const boards = boardsOf(profile, { fileIds: job.fileIds })
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
    },
    createClient,
  )
  parentPort?.postMessage(result)
} catch (e) {
  parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) })
}
