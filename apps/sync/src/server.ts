// The sync process's entry (`node apps/sync/src/server.ts`): turns on Node's on-disk compile cache, then
// loads the server (server-main.ts). The cache has to be on before the server's module graph is compiled,
// and a static import graph is compiled before any of its modules runs, so the entry is this two-liner
// and the server itself is a dynamic import.
//
// Why (docs/EXCALIDRAW-MIGRATION.md §2.13; B9's restart window): after a SIGKILL the container restarts
// the same process in the same filesystem, and Node spent about 1.5 s at the whole 0.5 CPU quota loading
// and compiling the server's modules before the first reconnect could be answered: the one 10 s window
// that missed the 80 % CPU target held that boot plus 260 reconnects. With the cache (V8's code cache per
// module, keyed by the source, under os.tmpdir() by default or NODE_COMPILE_CACHE) the second boot skips
// the compilation. DRAFTROOM_COMPILE_CACHE=off turns it off (a read-only tmp, a diagnosis). Nothing of a
// board or a secret is in it: it holds compiled code only.
import { constants, enableCompileCache } from 'node:module'

if (process.env.DRAFTROOM_COMPILE_CACHE !== 'off') {
  try {
    const r = enableCompileCache()
    if (r.status === constants.compileCacheStatus.FAILED && r.message)
      console.error(`sync: compile cache off: ${r.message}`)
  } catch {
    // an older Node without the API: the server runs without the cache
  }
}

await import('./server-main.ts')
