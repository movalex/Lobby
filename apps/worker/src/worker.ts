// Preview worker process (milestone 3): `node src/worker.ts`. An HTTP client of the API's /api/worker/*
// routes (docs/M3-STORAGE-CONTRACTS.md §4-§5): it holds only DRAFTROOM_WORKER_TOKEN, no database or
// storage credentials, and runs the same against the local api (fs mode), the Render api or from the NAS.
import { createApiCall, createWorkerApi } from './api-client.ts'
import { WORKER } from './config.ts'
import { loadWorkerEnv } from './env.ts'
import { localOfficeConverter, officeOff, sofficeCommand } from './office.ts'
import { socketOfficeConverter, sweepOfficeJobs } from './office-client.ts'
import { checkBgModel } from './ops/bg-model.ts'
import { reportedCapabilities } from './ops/capabilities.ts'
import { createWorkerOpsApi } from './ops/client.ts'
import { OP_RUNNERS } from './ops/dispatch.ts'
import { createExtractTextRunner } from './ops/extract-text.ts'
import { configureRenderPages } from './ops/render-pages.ts'
import { startRemoteWorker } from './remote-loop.ts'

const log = (line: string) => console.log(`[worker] ${line}`)

let cfg: ReturnType<typeof loadWorkerEnv>
try {
  cfg = loadWorkerEnv()
} catch (e) {
  // One line naming the variable (never its value); exit non-zero so a supervisor notices.
  console.error(`[worker] refusing to start: ${(e as Error).message}`)
  process.exit(1)
}
// Security audit M2: said out loud at every start that is not production (an unknown value never gets here).
if (cfg.nodeEnv !== 'production')
  log(
    `NODE_ENV=${cfg.nodeEnv} (not production): the production refusals are off, so a dev-only token placeholder, a local soffice and http blob URLs are allowed when their own flags say so`,
  )
const office =
  cfg.office.mode === 'socket'
    ? socketOfficeConverter({ socketPath: cfg.office.socketPath, jobsDir: cfg.office.jobsDir })
    : cfg.office.mode === 'local'
      ? localOfficeConverter({ command: sofficeCommand(cfg.office.sofficePath), workRoot: cfg.tmpDir })
      : officeOff()
// Documents a killed worker left staged in the shared volume (it outlives the containers).
const staleStages =
  cfg.office.mode === 'socket' ? sweepOfficeJobs(cfg.office.jobsDir, WORKER.tmpSweepAgeMs) : 0
const apiOptions = {
  baseUrl: cfg.apiUrl,
  token: cfg.token,
  workerId: cfg.workerId,
  requestTimeoutMs: WORKER.requestTimeoutMs,
  requireHttpsBlobs: cfg.production,
}
const api = createWorkerApi(apiOptions)
// Wave W: the op kinds this worker reports (a runner, WORKER_OPS, and for remove-bg a model file that passes its
// pinned sha256; ops/capabilities.ts). None reported: the worker never calls /api/worker/ops/*.
// WS4: render-pages converts an Office deck with the previews' converter and renders with their pdf child's heap
configureRenderPages({ office, officeTimeoutMs: cfg.office.timeoutMs, pdfHeapMb: cfg.pdfHeapMb })
const opsReport = reportedCapabilities({
  enabled: cfg.ops,
  runners: OP_RUNNERS,
  bgModel: checkBgModel(cfg.bgModelPath),
})
const worker = startRemoteWorker({
  ops: {
    api: createWorkerOpsApi(createApiCall(apiOptions)),
    capabilities: opsReport.capabilities,
    // wave W (WS3): extract-text reads Office documents through the same converter as previews (the sidecar)
    runners: { ...OP_RUNNERS, 'extract-text': createExtractTextRunner({ office }) },
  },
  api,
  concurrency: cfg.concurrency,
  pollMs: cfg.pollMs,
  pollMaxMs: cfg.pollMaxMs,
  tmpDir: cfg.tmpDir,
  process: {
    ffmpegPath: cfg.ffmpegPath,
    ffprobePath: cfg.ffprobePath,
    pdfHeapMb: cfg.pdfHeapMb,
    office,
    officeTimeoutMs: cfg.office.timeoutMs,
  },
  log,
})
// The origin only: DRAFTROOM_API_URL is refused with credentials, a path or a query (env.ts).
log(`started (api: ${cfg.apiUrl}, poll ${cfg.pollMs} ms)`)
log(`id ${cfg.workerId}, concurrency ${cfg.concurrency}, pdf heap ${cfg.pdfHeapMb} MB`)
if (staleStages) {
  log(
    `removed ${staleStages} leftover Office staging director${staleStages === 1 ? 'y' : 'ies'} (a worker stopped mid-conversion)`,
  )
}
log(`office previews: ${office.describe}`)
log(
  `worker ops: ${opsReport.capabilities.length ? opsReport.capabilities.join(', ') : 'none'}${opsReport.missing.length ? ` (not offered: ${opsReport.missing.map((m) => `${m.kind}: ${m.why}`).join('; ')})` : ''}`,
)
if (cfg.unusedSecrets.length) {
  log(
    `note: ${cfg.unusedSecrets.join(', ')} ${cfg.unusedSecrets.length === 1 ? 'is' : 'are'} set but never used by the worker; remove from its environment`,
  )
}

let requests = 0
function shutdown(reason: string) {
  requests++
  if (requests === 1) {
    const jobs = worker.currentJobs()
    log(
      `${reason}: stopping${jobs.length ? `, finishing ${jobs.join(', ')} (up to ${cfg.shutdownGraceMs} ms)` : ''}`,
    )
    void worker.stop(cfg.shutdownGraceMs)
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
