// Preloaded (node --import) into the sync server and worker that the e2e stack spawns with an IPC
// channel. If the Playwright worker that owns them dies without running its cleanup (crash, hard
// kill), the channel closes and the child exits instead of lingering on the fixed e2e port.
process.on('disconnect', () => process.exit(1))
// The channel alone must not keep the child alive.
process.channel?.unref()
