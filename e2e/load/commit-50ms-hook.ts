// Test-only preload for B9's §2.13 mitigation-ladder step 1 ("raise the minimum interval between a busy
// room's commits from 25 ms to 50 ms (adds ≤ 50 ms to acks)"), the free tuning step the owner's fallback
// condition names: one comparison run of L1 with the room's DRAIN.minCommitIntervalMs at 50.
//
// The constant is 2A's (apps/sync/src/room/element-room.ts `DRAIN`); this preload rewrites it when the
// module loads, for that one sync process. It edits no file; the normal runs never load it. Sync's
// comparison container gets it through NODE_OPTIONS=--import=/app/e2e/load/commit-50ms-hook.ts
// (nas-run.sh --env). Everything else is unchanged.
import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context)
    if (!url.endsWith('/apps/sync/src/room/element-room.ts')) return r
    const src = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source as Uint8Array)
    const next = src.replace(/minCommitIntervalMs: 25\b/, 'minCommitIntervalMs: 50')
    if (next === src)
      throw new Error('commit-50ms-hook: `minCommitIntervalMs: 25` not found in element-room.ts')
    process.stderr.write('[commit-50ms-hook] DRAIN.minCommitIntervalMs = 50 (the §2.13 step-1 comparison)\n')
    return { ...r, source: next }
  },
})
