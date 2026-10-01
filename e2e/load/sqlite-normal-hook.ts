// Test-only preload for B9's fsync fallback comparison (docs/EXCALIDRAW-MIGRATION.md §2.13 "fsync is the
// unknown", mitigation step 3: "WAL with synchronous=NORMAL … needs the owner's explicit acceptance"). The
// owner pre-approved ONE comparison run for B9 if the §2.13 targets are missed after the free tuning steps.
//
// Sync's pragmas are the lead's `apps/sync/src/room/schema.ts` LB_PRAGMAS (`PRAGMA synchronous = FULL`),
// and no switch exists. For the comparison run only, this preload rewrites that one pragma when the
// module loads, so the same build runs with `synchronous = NORMAL`. It edits no file; the normal runs never
// load it. Sync's comparison container gets it through
// NODE_OPTIONS=--import=/app/e2e/load/sqlite-normal-hook.ts (nas-run.sh --env). Everything else is
// unchanged, so the report's `lobby_fsync_ms` histogram keeps its name (it then times a COMMIT that does
// not fsync the WAL).
import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context)
    if (!url.endsWith('/apps/sync/src/room/schema.ts')) return r
    const src = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source as Uint8Array)
    const next = src.replace(/'PRAGMA synchronous = FULL'/, "'PRAGMA synchronous = NORMAL'")
    if (next === src)
      throw new Error("sqlite-normal-hook: 'PRAGMA synchronous = FULL' not found in schema.ts")
    process.stderr.write('[sqlite-normal-hook] PRAGMA synchronous = NORMAL (the §2.13 step-3 comparison)\n')
    return { ...r, source: next }
  },
})
