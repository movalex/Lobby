import { createApiServer } from './app.ts'
import { type ApiConfig, loadConfig } from './config.ts'

let config: ApiConfig
try {
  config = loadConfig()
} catch (e) {
  // Operator error (missing secret, dev auth in production, bad PORT, ...): one line, no stack.
  console.error(`api: ${(e as Error).message}`)
  process.exit(1)
}

let server: Awaited<ReturnType<typeof createApiServer>>
try {
  server = await createApiServer(config, { logger: { level: process.env.LOG_LEVEL ?? 'info' } })
} catch (e) {
  console.error(`api: cannot start: ${(e as Error).message}`)
  process.exit(1)
}

let port: number
try {
  ;({ port } = await server.listen())
} catch (e) {
  console.error(`api: cannot listen on ${config.host}:${config.port}: ${(e as Error).message}`)
  process.exit(1)
}
// Tests and scripts that spawn this process parse this exact line (and the real port when PORT=0).
console.log(`api listening on ${config.host}:${port} (data: ${config.dataDir})`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    setTimeout(() => process.exit(1), 5_000).unref()
    server.close().then(
      () => process.exit(0),
      (e: unknown) => {
        console.error('api: shutdown failed', e)
        process.exit(1)
      },
    )
  })
}
