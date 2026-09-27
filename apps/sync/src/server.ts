import { createSyncServer } from './app.ts'
import { loadConfig, type SyncConfig } from './config.ts'

let config: SyncConfig
try {
  config = loadConfig()
} catch (e) {
  // Operator error (missing secret, bad PORT, ...): a one-line message, no stack, non-zero exit.
  console.error(`sync: ${(e as Error).message}`)
  process.exit(1)
}

const server = createSyncServer(config)
let port: number
try {
  ;({ port } = await server.listen())
} catch (e) {
  console.error(`sync: cannot listen on ${config.host}:${config.port}: ${(e as Error).message}`)
  process.exit(1)
}
// Tests spawning this process parse this exact line (and the real port when PORT=0).
console.log(`sync listening on ${config.host}:${port} (data: ${config.dataDir})`)

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
