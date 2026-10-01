// zod under Lobby's Content-Security-Policy (docs/EXCALIDRAW-MIGRATION.md §2.12; cut-over G3). zod 4 runs
// `new Function('')` once to decide whether it may compile a fast parser (zod/v4/core/util.js allowsEval),
// when the first object schema is built. Under a script-src with no 'unsafe-eval' the throw is caught, but
// Chrome still reports a securitypolicyviolation on every page (spike A12: one per sign-in, dashboard and
// board load). `jitless` skips the probe and the compiled fast path; parsing is the plain path, which is
// what every test runs. zod's own advice for a strict CSP.
//
// Set on zod's global config object before any bundle runs: zod keeps it at globalThis.__zod_globalConfig
// (zod/v4/core/core.js `globalThis.__zod_globalConfig ??= {}`; z.config() writes into that object), so a
// value put there first is the one zod reads. Nothing inside the bundle can do this reliably: Vite merges a
// page's module scripts into one entry whose shared chunks (zod with the api's schemas among them) are
// evaluated before the entry's own statements, so a `z.config({ jitless: true })` in main.tsx, or in a
// module script of its own, ran after the probe. A blocking classic <script src> in index.html's <head>
// (same-origin, so inside the CSP) runs before every module script. src/lib/zod-jitless.test.ts runs this
// file against zod and asserts index.html's order. Keep it tiny, classic and dependency-free.
;(() => {
  const g = globalThis
  g.__zod_globalConfig = Object.assign(g.__zod_globalConfig || {}, { jitless: true })
})()
