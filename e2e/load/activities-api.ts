// OWNER: WS1 (wave V). The api process of the live activities load run (./activities.ts; docs/WAVE-V-CONTRACTS.md
// §2.6): the real api (apps/api createApiServer, its migrations, routes, guards, tally and event hub) on the
// Postgres in DATABASE_URL, configured by the environment exactly as the server is (loadConfig). The one difference
// from apps/api/src/server.ts: no sync server runs in the load run, so the canvas engine is fixed (TLDRAW_ONLY, as
// the api's own tests do) instead of asked of a sync that is not there. Nothing here is a production entry point: it
// refuses NODE_ENV=production and needs DRAFTROOM_DEV_AUTH=1 (the load's facilitator signs in with a dev identity).
//
//   DATABASE_URL=postgres://… DRAFTROOM_LIVE_ACTIVITIES=on DRAFTROOM_DEV_AUTH=1 AUTH_PROVIDER=dev TRUST_PROXY=true \
//     PUBLIC_ORIGIN=http://load.test DRAFTROOM_TICKET_SECRET=… DRAFTROOM_INTERNAL_SECRET=… DRAFTROOM_WORKER_TOKEN=… \
//     DRAFTROOM_DATA_DIR=/tmp/x HOST=127.0.0.1 PORT=3101 node e2e/load/activities-api.ts
//
// The api modules are loaded by URL at run time so the e2e project's type check does not compile the api's sources
// under its own settings (the api checks them itself).

import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.env.NODE_ENV === 'production') {
  console.error('activities-api: refused under NODE_ENV=production (a load-run launcher)')
  process.exit(1)
}
if (process.env.DRAFTROOM_DEV_AUTH !== '1') {
  console.error('activities-api: needs DRAFTROOM_DEV_AUTH=1 (the load facilitator is a dev identity)')
  process.exit(1)
}

const src = (p: string) =>
  pathToFileURL(fileURLToPath(new URL(`../../apps/api/src/${p}`, import.meta.url))).href
type Mod = Record<string, unknown>
const appMod = (await import(src('app.ts'))) as Mod
const configMod = (await import(src('config.ts'))) as Mod
const engineMod = (await import(src('canvas-engine.ts'))) as Mod

const loadConfig = configMod.loadConfig as () => { live: { activities: boolean }; host: string; port: number }
const createApiServer = appMod.createApiServer as (
  config: unknown,
  deps: Record<string, unknown>,
) => Promise<{ listen(): Promise<{ port: number }>; close(): Promise<void> }>

const config = loadConfig()
if (!config.live.activities) {
  console.error('activities-api: DRAFTROOM_LIVE_ACTIVITIES must be on for the load run')
  process.exit(1)
}
const server = await createApiServer(config, {
  canvasEngine: engineMod.TLDRAW_ONLY,
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
})
const { port } = await server.listen()
console.log(`activities-api listening on ${config.host}:${port}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
