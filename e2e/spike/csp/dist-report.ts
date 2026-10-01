// Spike checks A12 (bundle greps clean) and A13 (bundle size of the board route), from built output.
//
//   node e2e/spike/csp/dist-report.ts [--run N] [--reuse] [--port 7723]
//
// Builds apps/web three times with --manifest (folders keyed on --port, default 7723, so parallel runs
// never share one):
//   normal   the production build (no dev auth)
//   engine   VITE_DRAFTROOM_DEV_AUTH=1 (the spike pages), host-rewrite plugin on
//   before   the same with LOBBY_HOST_REWRITE=off (the "before" inventory of A12)
// A13: the static-import closure (JS + CSS) of each route from the manifest, gzip (zlib default level),
//      gzip -9 and brotli -11. Routes: the app shell, the Excalidraw engine route (index.html + SpikeRoute +
//      pages/engine.tsx: ExcalidrawHost alone) and the render-lab page (the engine plus Lobby's loader,
//      overrides and guard). (The tldraw board route left at wave 4 part 2.)
// A12: foreign hosts (literal text outside license comments) before and after the rewrite, in the
//      engine route's files (static and dynamic imports) and in the whole dist. Exit 1 when a host the
//      plugin lists remains in a chunk of the engine route.
// Writes e2e/test-results/spike-a12-a13/run-<N>.json.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  engineDependencyTree,
  hostsInLiteral,
  literalRanges,
} from '../../../apps/web/build/excalidraw-host-rewrite.ts'
import { packagesAtOffsets, packagesOf } from './attribution.ts'
import { closure, inventory, keyFor, kib, REWRITTEN_HOSTS, readManifest, sumSizes } from './dist.ts'

const { values: args } = parseArgs({
  options: {
    run: { type: 'string', default: '1' },
    reuse: { type: 'boolean', default: false },
    port: { type: 'string', default: '7723' },
  },
})
const REPO = resolve(import.meta.dirname, '../../..')
const WEB = join(REPO, 'apps/web')
const OUT = join(REPO, 'e2e/test-results/spike-a12-a13')
mkdirSync(OUT, { recursive: true })

const builds = {
  normal: { dir: `dist/a13-normal-${args.port}`, env: {} },
  engine: {
    dir: `dist/a13-engine-${args.port}`,
    env: { VITE_DRAFTROOM_DEV_AUTH: '1' },
  },
  before: {
    dir: `dist/a12-before-${args.port}`,
    env: { VITE_DRAFTROOM_DEV_AUTH: '1', LOBBY_HOST_REWRITE: 'off' },
  },
  // the same two builds with source maps, only for the per-package attribution (sizes come from above)
  normalMaps: { dir: `dist/a13-normal-maps-${args.port}`, env: {}, maps: true },
  engineMaps: {
    dir: `dist/a13-engine-maps-${args.port}`,
    env: { VITE_DRAFTROOM_DEV_AUTH: '1' },
    maps: true,
  },
} as const

function build(name: keyof typeof builds) {
  const b = builds[name]
  const env: NodeJS.ProcessEnv = { ...process.env, ...b.env }
  if (!('VITE_DRAFTROOM_DEV_AUTH' in b.env)) delete env.VITE_DRAFTROOM_DEV_AUTH
  if (!('LOBBY_HOST_REWRITE' in b.env)) delete env.LOBBY_HOST_REWRITE
  const t0 = Date.now()
  const maps = 'maps' in b && b.maps ? ' --sourcemap' : ''
  const r = spawnSync(`pnpm exec vite build --outDir ${b.dir} --emptyOutDir --manifest${maps}`, {
    cwd: WEB,
    env,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.status !== 0) throw new Error(`build ${name} failed:\n${r.stdout}\n${r.stderr}`)
  return Date.now() - t0
}

const buildMs: Record<string, number> = {}
if (!args.reuse)
  for (const name of Object.keys(builds) as (keyof typeof builds)[]) buildMs[name] = build(name)

const dist = (name: keyof typeof builds) => join(WEB, builds[name].dir)

// ---- A13 ----------------------------------------------------------------------------------------
const route = (name: keyof typeof builds, sources: string[], dynamic = false) => {
  const m = readManifest(dist(name))
  const keys = sources.map((s) => keyFor(m, s))
  const c = closure(m, keys, dynamic)
  return { js: sumSizes(dist(name), c.js), css: sumSizes(dist(name), c.css) }
}
const summary = (r: ReturnType<typeof route>) => ({
  jsFiles: r.js.files,
  cssFiles: r.css.files,
  jsGzipKiB: kib(r.js.gzip),
  cssGzipKiB: kib(r.css.gzip),
  totalGzipKiB: kib(r.js.gzip + r.css.gzip),
  totalGzip9KiB: kib(r.js.gzip9 + r.css.gzip9),
  totalBrotliKiB: kib(r.js.brotli + r.css.brotli),
  totalRawKiB: kib(r.js.raw + r.css.raw),
  top: [...r.js.rows, ...r.css.rows]
    .sort((a, b) => b.gzip - a.gzip)
    .slice(0, 8)
    .map((x) => `${x.file} ${kib(x.gzip)} KiB gz`),
})
const ENTRY = 'index.html'
const a13 = {
  boardRoute: summary(route('normal', [ENTRY, 'src/canvas/board/LobbyBoardPage.tsx'])),
  appShell: summary(route('normal', [ENTRY])),
  excalidrawEngineRoute: summary(
    route('engine', [ENTRY, 'src/canvas/spike/SpikeRoute.tsx', 'src/canvas/spike/pages/engine.tsx']),
  ),
  excalidrawRenderLabRoute: summary(
    route('engine', [ENTRY, 'src/canvas/spike/SpikeRoute.tsx', 'src/canvas/spike/pages/render-lab.tsx']),
  ),
  excalidrawEngineRouteWithLazy: summary(
    route('engine', [ENTRY, 'src/canvas/spike/SpikeRoute.tsx', 'src/canvas/spike/pages/engine.tsx'], true),
  ),
}

// Per-package attribution (source maps) of the two routes' JS: what is tldraw, what is Excalidraw, what
// is Lobby. Gzip per package is the chunk's gzip split by raw share (an estimate).
const TLDRAW_FAMILY =
  /^(tldraw|@tldraw\/|@tiptap\/|prosemirror-|orderedmap$|rope-sequence$|w3c-keyname$|linkifyjs$|@floating-ui\/|lz-string$|idb$|classnames$|@use-gesture\/|signia|@radix-ui\/)/
const ENGINE_FAMILY =
  /^(@excalidraw\/|roughjs$|perfect-freehand$|jotai|pako$|png-chunk|browser-fs-access$|fractional-indexing$|es6-promise-pool$|nanoid$|open-color$|tunnel-rat$|image-blob-reduce$|pica$|fuzzy$|lodash|@braintree\/|points-on-|path-data-parser$|hachure-fill$|clsx$|radix-ui$|@radix-ui\/|crc-32$|canvas-roundrect-polyfill$|sass$|tinyglobby|@codemirror\/|@lezer\/|crelt$|style-mod$)/
const attributionOf = (name: 'normalMaps' | 'engineMaps', sources: string[]) => {
  const m = readManifest(dist(name))
  const c = closure(
    m,
    sources.map((s) => keyFor(m, s)),
    false,
  )
  const pk = packagesOf(dist(name), c.js)
  const group = (re: RegExp) =>
    Object.entries(pk)
      .filter(([p]) => re.test(p))
      .reduce((a, [, v]) => a + v.gzip, 0)
  const lobby = Object.entries(pk)
    .filter(([p]) => p.startsWith('lobby'))
    .reduce((a, [, v]) => a + v.gzip, 0)
  const top = Object.entries(pk)
    .sort((a, b) => b[1].gzip - a[1].gzip)
    .slice(0, 25)
    .map(([p, v]) => `${p} ${kib(v.gzip)}`)
  const total = Object.values(pk).reduce((a, v) => a + v.gzip, 0)
  return {
    totalJsGzipKiB: kib(total),
    tldrawFamilyKiB: kib(group(TLDRAW_FAMILY)),
    engineFamilyKiB: kib(group(ENGINE_FAMILY)),
    lobbyKiB: kib(lobby),
    top,
    packages: pk,
  }
}
const boardAttr = attributionOf('normalMaps', [ENTRY, 'src/canvas/board/LobbyBoardPage.tsx'])
const shellAttr = attributionOf('normalMaps', [ENTRY])
const engineAttr = attributionOf('engineMaps', [
  ENTRY,
  'src/canvas/spike/SpikeRoute.tsx',
  'src/canvas/spike/pages/engine.tsx',
])
// since wave 4 part 2 the tldraw family must be 0 KiB everywhere (docs/EXCALIDRAW-CUTOVER.md G10)
const shellTldraw = shellAttr.tldrawFamilyKiB
const attribution = {
  boardRoute: { ...boardAttr, packages: undefined },
  appShell: { ...shellAttr, packages: undefined },
  excalidrawEngineRoute: { ...engineAttr, packages: undefined },
}

// ---- A12 ----------------------------------------------------------------------------------------
const engineFiles = (name: 'engine' | 'before') => {
  const m = readManifest(dist(name))
  const keys = [ENTRY, 'src/canvas/spike/SpikeRoute.tsx', 'src/canvas/spike/pages/engine.tsx'].map((s) =>
    keyFor(m, s),
  )
  const eager = closure(m, keys, false)
  const all = closure(m, keys, true)
  return { eager: [...eager.js, ...eager.css], all: [...all.js, ...all.css] }
}
const listed = new Set(REWRITTEN_HOSTS)
const pick = (inv: ReturnType<typeof inventory>, onlyListed: boolean) =>
  Object.fromEntries(
    Object.entries(inv.hosts)
      .filter(([h]) => !onlyListed || listed.has(h))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([h, v]) => [h, { hits: v.hits, kinds: v.kinds, files: v.files.slice(0, 6) }]),
  )
const before = engineFiles('before')
const after = engineFiles('engine')
const a12 = {
  engineRouteEager: {
    before: pick(inventory(dist('before'), before.eager), false),
    after: pick(inventory(dist('engine'), after.eager), false),
  },
  engineRouteWithLazy: {
    before: pick(inventory(dist('before'), before.all), false),
    after: pick(inventory(dist('engine'), after.all), false),
  },
  wholeDistListedHosts: {
    normal: pick(inventory(dist('normal')), true),
    before: pick(inventory(dist('before')), true),
    after: pick(inventory(dist('engine')), true),
  },
}
const leftEager = Object.keys(a12.engineRouteEager.after).filter((h) => listed.has(h))
const leftLazy = Object.keys(a12.engineRouteWithLazy.after).filter((h) => listed.has(h))

// Which package each host literal left in the engine route comes from (source maps of the same build
// with --sourcemap). The pass condition: none from the engine's dependency tree.
const tree = engineDependencyTree('@excalidraw/excalidraw', WEB)
const leftByPackage: Record<string, Record<string, number>> = {}
{
  const m = readManifest(dist('engineMaps'))
  const keys = [ENTRY, 'src/canvas/spike/SpikeRoute.tsx', 'src/canvas/spike/pages/engine.tsx'].map((s) =>
    keyFor(m, s),
  )
  for (const f of closure(m, keys, true).js) {
    const code = readFileSync(join(dist('engineMaps'), f), 'utf8')
    const ranges = literalRanges(f, code) ?? []
    const hits: { host: string; at: number }[] = []
    for (const [s, e] of ranges)
      for (const h of hostsInLiteral(code.slice(s, e))) hits.push({ host: h.host, at: s })
    const pkgs = packagesAtOffsets(
      dist('engineMaps'),
      f,
      hits.map((h) => h.at),
    )
    hits.forEach((h, i) => {
      const pkg = pkgs[i] ?? '?'
      const e = leftByPackage[pkg] ?? {}
      leftByPackage[pkg] = e
      e[h.host] = (e[h.host] ?? 0) + 1
    })
  }
}
const fromEngineTree = Object.entries(leftByPackage).filter(([pkg]) => tree.has(pkg))

const report = {
  at: new Date().toISOString(),
  run: args.run,
  buildMs,
  a13,
  attribution,
  a12: { ...a12, leftByPackage, fromEngineTree, engineTreePackages: tree.size },
  leftEager,
  leftLazy,
}
const file = join(OUT, `run-${args.run}.json`)
writeFileSync(file, JSON.stringify(report, null, 2))
const t = a13.boardRoute
const e = a13.excalidrawEngineRoute
console.log(
  `A13 run ${args.run}: board route ${t.totalGzipKiB} KiB gzip (${t.jsGzipKiB} JS + ${t.cssGzipKiB} CSS, ${t.jsFiles}+${t.cssFiles} files); ` +
    `Excalidraw engine route ${e.totalGzipKiB} KiB gzip (${e.jsGzipKiB} JS + ${e.cssGzipKiB} CSS, ${e.jsFiles}+${e.cssFiles} files); ` +
    `app shell ${a13.appShell.totalGzipKiB} KiB (tldraw family in it ~${shellTldraw} KiB); render-lab ${a13.excalidrawRenderLabRoute.totalGzipKiB} KiB`,
)
console.log(
  `A12 run ${args.run}: listed hosts left in the engine route: eager [${leftEager.join(', ')}], with lazy chunks [${leftLazy.join(', ')}]; ` +
    `engine-route hosts before ${Object.keys(a12.engineRouteWithLazy.before).length}, after ${Object.keys(a12.engineRouteWithLazy.after).length}; ` +
    `host literals left, by package: ${Object.entries(leftByPackage)
      .map(([p, h]) => `${p} (${Object.keys(h).length})`)
      .join(', ')}; from the engine's dependency tree (${tree.size} packages): ${fromEngineTree.length}`,
)
console.log(`report: ${file}`)
process.exit(fromEngineTree.length ? 1 : 0)
