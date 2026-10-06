import { dataLayout } from '@draftroom/dev-assets'
import { createSyncServer } from './app.ts'
import { loadConfig, type SyncConfig } from './config.ts'
import { loadEngine } from './engine-switch.ts'

let config: SyncConfig
try {
  config = loadConfig()
} catch (e) {
  // Operator error (missing secret, bad PORT, ...): a one-line message, no stack, non-zero exit.
  console.error(`sync: ${(e as Error).message}`)
  process.exit(1)
}
// Security audit M2: said out loud at every start that is not production (an unknown value never gets here).
if (config.nodeEnv !== 'production')
  console.warn(
    `sync: NODE_ENV=${config.nodeEnv} (not production): the production refusals are off, so dev-only placeholder secrets, test hooks, a missing Origin check and loopback internal URLs are allowed when their own flags say so`,
  )

// The engine's own modules (the ElementRoom and its internal routes) register themselves before the
// server is built (engine-switch.ts).
let server: ReturnType<typeof createSyncServer>
try {
  await loadEngine()
  server = createSyncServer(config)
} catch (e) {
  console.error(`sync: cannot start: ${(e as Error).message}`)
  process.exit(1)
}
// CAP-L1 (wave J, room/warm-start.ts): loaded now, run right after the port opens (below)
const warm =
  process.env.DRAFTROOM_WARM_START === 'off' ? null : (await import('./room/warm-start.ts')).warmStart
let port: number
try {
  ;({ port } = await server.listen())
} catch (e) {
  console.error(`sync: cannot listen on ${config.host}:${config.port}: ${(e as Error).message}`)
  process.exit(1)
}
// Tests spawning this process parse this exact line (and the real port when PORT=0).
console.log(`sync listening on ${config.host}:${port} (data: ${config.dataDir})`)

// CAP-L1 (wave J, room/warm-start.ts): after a crash, the parsers are warmed and the rooms it left open are
// opened (one per macrotask) in the moment before the reconnects are back, not inside their storm; not before
// the port opens (that kept the clients' backoff waiting longer). The staged restores ran in listen(). Not in
// maintenance (no board is joined then). DRAFTROOM_WARM_START=off turns it off.
if (warm && !server.maintenance.on()) {
  const rooms = server.elementRooms
  warm({
    roomsDir: dataLayout(config.dataDir).rooms,
    open: rooms.prepareBoard
      ? (boardId) => rooms.prepareBoard?.(boardId) ?? Promise.resolve(false)
      : undefined,
    staged: new Set(),
    log: (...a: unknown[]) => console.log(...a),
  }).catch((e: unknown) => console.error(`sync: warm start stopped: ${(e as Error)?.name ?? 'error'}`))
}

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    // Acks are sent only after COMMIT, so even a forced exit loses nothing acknowledged.
    setTimeout(() => process.exit(1), 5_000).unref()
    server.close().then(
      () => process.exit(0),
      (e: unknown) => {
        console.error('sync: shutdown failed', e)
        process.exit(1)
      },
    )
  })
}
