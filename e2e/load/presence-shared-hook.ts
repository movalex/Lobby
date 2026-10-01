// Test-only preload for B9's presence-mode comparison (docs/EXCALIDRAW-MIGRATION.md §2.13: "Spike B
// compares one shared frame (serialized once) against per-view frames and picks the cheaper"; §8.3 B9).
//
// O1's room has no switch between the two modes (apps/sync/src/room/presence.ts): a board with at most
// CURSORS_PER_RECIPIENT + 1 sessions gets ONE presence frame per tick, serialized once for everyone (with
// no cursor cap), and a larger board gets per-recipient frames with the 40-cursor cap, preferring peers in
// the recipient's view. L1's 200-session board is therefore always in the per-view mode. For the one
// comparison run only, this preload raises the constant when the module loads, so the same L1 board runs
// O1's shared-frame branch. It edits no file; the normal runs never load it. Sync's comparison container
// gets it through NODE_OPTIONS=--import=/app/e2e/load/presence-shared-hook.ts (nas-run.sh
// --presence-env). The room code, the protocol and the clients are unchanged.
import { registerHooks } from 'node:module'

const SHARED_CAP = 100_000

registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context)
    if (!url.endsWith('/packages/canvas-schema/src/limits.ts')) return r
    const src = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source as Uint8Array)
    const next = src.replace(
      /export const CURSORS_PER_RECIPIENT = 40\b/,
      `export const CURSORS_PER_RECIPIENT = ${SHARED_CAP}`,
    )
    if (next === src)
      throw new Error('presence-shared-hook: CURSORS_PER_RECIPIENT = 40 not found in limits.ts')
    process.stderr.write(`[presence-shared-hook] CURSORS_PER_RECIPIENT = ${SHARED_CAP} (one shared frame)\n`)
    return { ...r, source: next }
  },
})
