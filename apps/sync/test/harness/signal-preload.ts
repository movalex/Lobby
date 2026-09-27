// Preloaded into the sync server child (node --import) by spawnSyncServer.
//
// On Windows `child.kill('SIGINT' | 'SIGTERM')` is a hard TerminateProcess, so the server's own
// graceful-shutdown handlers can never be exercised that way. The harness instead sends
// { type: 'signal', signal } over IPC and we re-emit it, which runs exactly the listeners the server
// registered with process.on(signal). The server code is untouched.
process.on('message', (msg: unknown) => {
  if (!msg || typeof msg !== 'object') return
  const { type, signal } = msg as { type?: unknown; signal?: unknown }
  if (type !== 'signal' || (signal !== 'SIGINT' && signal !== 'SIGTERM')) return
  if (process.listenerCount(signal) === 0) process.exit(128) // nothing registered: behave like an unhandled signal
  process.emit(signal, signal)
})

// The IPC channel must not keep the server alive on its own: a shutdown handler that just closes
// its servers (without process.exit) has to be able to end the process.
process.channel?.unref()

// If the test runner dies, do not leave an orphaned server listening.
process.on('disconnect', () => process.exit(1))
