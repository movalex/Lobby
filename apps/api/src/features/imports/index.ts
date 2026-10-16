// OWNER: the wave R foundation (the lead): import jobs (@draftroom/contracts imports.ts; migration 0035_board_imports;
// docs/WAVE-R-CONTRACTS.md §2). The runner (runner.ts), the job rows (jobs.ts) and the importing board (finalize.ts)
// are shared by WS1 (Miro import, features/imports/miro) and WS4 (backup restore, features/backup), which register
// their sources with `importRunnerOf(app).useSource(…)` and do not edit these files.
//
//   GET  /api/imports/:id                 the job's view                          WS1 (R1-4) implements it here
//   GET  /api/workspaces/:wid/imports     recent jobs (?mine=1)                   WS1 (R1-4)
//   POST /api/imports/:id/cancel          stop it; finished boards stay           WS1 (R1-4)
//   POST /api/imports/:id/pause           stop at the next step; keep what is done WS1 (R1-4)
//   POST /api/imports/:id/resume          go on (a Miro job needs its token again) WS1 (R1-4)
//   GET  /api/imports/:id/report.csv      the per-item report                     WS1 (R1-4)
//
// The guard rows are in place: every route refuses a name-only guest (guests/guard.ts, IMPORT_GUESTS), and resume
// needs a creator (domain-access/guard.ts 'always': it makes boards). The routes are pending (../pending-routes.ts):
// none is registered, so each answers as an unknown route (404). The runner itself runs from here (it is idle until a
// source is registered and a job started): the rows of a process that is gone become `interrupted` (at start-up, then
// every IMPORT_STALE_HEARTBEAT_MS), and the hourly sweep removes importing boards nobody will finish.

import { IMPORT_STALE_HEARTBEAT_MS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { errorFacts } from '../../egress/index.ts'
import type { FeatureContext } from '../context.ts'
import { registerImportRoutes } from './routes.ts'
import { createImportRunner, type ImportRunner } from './runner.ts'

export const IMPORT_SWEEP_INTERVAL_MS = 60 * 60_000

const runners = new WeakMap<FastifyInstance, ImportRunner>()
/** The app's import runner (WS1 and WS4 register their sources on it; tests drive it). */
export function importRunnerOf(app: FastifyInstance): ImportRunner | undefined {
  return runners.get(app)
}

export async function registerImports(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const runner = createImportRunner(ctx, app.log)
  runners.set(app, runner)

  let timer: ReturnType<typeof setInterval> | null = null
  let recovering: ReturnType<typeof setInterval> | null = null
  let sweeping: Promise<void> | null = null
  const recover = async () => {
    const n = await runner.recover()
    if (n) app.log.info({ feature: 'imports', interrupted: n }, 'imports interrupted by a restart')
  }
  app.addHook('onReady', async () => {
    await recover()
    recovering = setInterval(() => {
      recover().catch((e) =>
        app.log.warn({ feature: 'imports', err: errorFacts(e) }, 'import recovery failed'),
      )
    }, IMPORT_STALE_HEARTBEAT_MS)
    recovering.unref()
    timer = setInterval(() => {
      if (sweeping) return
      sweeping = runner
        .sweep()
        .then((removed) => {
          if (removed) app.log.info({ feature: 'imports', removed }, 'import sweep')
        })
        .catch((e) => app.log.warn({ feature: 'imports', err: errorFacts(e) }, 'import sweep failed'))
        .finally(() => {
          sweeping = null
        })
    }, IMPORT_SWEEP_INTERVAL_MS)
    timer.unref()
  })
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer)
    if (recovering) clearInterval(recovering)
    timer = null
    recovering = null
    await runner.close()
  })

  // the six job routes (WS1, R1-4): ./routes.ts
  await registerImportRoutes(app, ctx, runner)
}
