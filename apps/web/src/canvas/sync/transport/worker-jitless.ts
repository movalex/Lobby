/**
 * N1-1 (wave N, PERF-3a): zod jitless in the snapshot worker, set before zod is evaluated. It is the worker's
 * FIRST import (./snapshot.worker.ts; snapshot-worker.test.ts checks the order): a module worker never runs the
 * page's classic head script (public/zod-jitless.js), and zod's `new Function('')` probe (zod/v4/core/util.js
 * allowsEval, run when the first object schema is built) must never run under Lobby's CSP (no 'unsafe-eval'). The
 * same object public/zod-jitless.js writes: zod reads its config from `globalThis.__zod_globalConfig` (zod/v4/core/
 * core.js `globalThis.__zod_globalConfig ??= {}`), so a value put there first is the one it reads.
 */
const g = globalThis as { __zod_globalConfig?: Record<string, unknown> }
g.__zod_globalConfig = Object.assign(g.__zod_globalConfig ?? {}, { jitless: true })

export {}
