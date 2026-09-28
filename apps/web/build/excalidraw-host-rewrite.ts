import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type Plugin, parseSync, type ResolvedConfig } from 'vite'

// Third-party hosts rewritten out of the Excalidraw engine at build time (docs/EXCALIDRAW-MIGRATION.md
// §2.12, layer 2; spike check A12, docs/research/excalidraw/spike-a/A12.md).
//
// The engine hard-codes hosts for features Lobby never uses (share links, the library browser, its own
// collaboration and AI backends, help and social links, the embed allowlist and embed URL builders) and
// one it cannot turn off: every font gets https://esm.sh/... as its last @font-face source, so any local
// font miss goes third-party (ExcalidrawFontFace.createUrls, @excalidraw/excalidraw
// dist/dev/chunk-FN755BR4.js:1225-1277). Its dependencies (mermaid, katex, codemirror, radix, lodash…)
// carry more, mostly documentation links in error messages.
//
// Scope: every module of the engine's dependency tree, i.e. @excalidraw/excalidraw and every package it
// depends on, transitively (engineDependencyTree; React is a peer and stays out). Lobby's own code and
// tldraw are never touched.
//
// What is rewritten, to `blocked.invalid` (RFC 6761: never resolves): host text inside string, template
// and regex LITERALS only (found with Vite's parser, so code and comments are never touched; `@license`
// comments stay verbatim):
//   - the host of every absolute URL (`https://host`, `//host`, `\/\/host` in a regex source), except the
//     XML namespace hosts in NON_REQUEST_HOSTS (identifiers, never requested);
//   - every host in REWRITTEN_HOSTS anywhere in a literal, dots raw or escaped (`"player.vimeo.com"`,
//     `youtube\.com` in the embed regexes).
// After the rewrite each module's literals are scanned again; any foreign host left (a bare hostname of a
// host not listed) fails the build, so an Excalidraw bump that adds one breaks the build until it is added
// to REWRITTEN_HOSTS.
//
// Active when VITE_LOBBY_ENGINE=excalidraw (the engine is only bundled then). LOBBY_HOST_REWRITE=off
// disables it (the "before" inventory of A12). LOBBY_HOST_REWRITE_VERIFY=report records leftovers
// instead of failing. LOBBY_HOST_REWRITE_REPORT=<file> writes the per-module counts as JSON.

/** Replaces every rewritten host. `.invalid` never resolves (RFC 6761 §6.4). */
export const BLOCKED_HOST = 'blocked.invalid'

/**
 * Hosts rewritten wherever they appear in a literal (URL or bare). Plan §2.12 listed the first 16; the
 * others were found by the A12 inventory of the pinned engine (0.18.0-1118751). Longest first.
 */
export const REWRITTEN_HOSTS: readonly string[] = [
  // plan §2.12
  'us-central1-excalidraw-room-persistence.cloudfunctions.net',
  'excalidraw-room-persistence.firebaseio.com',
  'libraries.excalidraw.com',
  'oss-collab.excalidraw.com',
  'json.excalidraw.com',
  'oss-ai.excalidraw.com',
  'plus.excalidraw.com',
  'docs.excalidraw.com',
  'app.excalidraw.com',
  'player.vimeo.com',
  'www.youtube.com',
  'mermaid.js.org',
  'discord.gg',
  'github.com',
  'esm.sh',
  'x.com',
  // not in plan §2.12 (A12 inventory): Firebase config, library URL allowlist, embed allowlist and
  // embed URL builders (@excalidraw/element), help links
  'excalidraw-room-persistence.firebaseapp.com',
  'excalidraw-room-persistence.appspot.com',
  'raw.githubusercontent.com',
  'platform.twitter.com',
  'forms.microsoft.com',
  'link.excalidraw.com',
  'drive.google.com',
  'embed.reddit.com',
  'gist.github.com',
  'stackblitz.com',
  'www.figma.com',
  'excalidraw.com',
  'twitter.com',
  'youtube.com',
  'reddit.com',
  'figma.com',
  'giphy.com',
  'vimeo.com',
  'youtu.be',
]
  .slice()
  .sort((a, b) => b.length - a.length)

/** Hosts that appear only as identifiers and are never requested: XML namespace URIs. */
export const NON_REQUEST_HOSTS: ReadonlySet<string> = new Set(['www.w3.org'])

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?'
/** A dot, raw or escaped as in a regex source (`\.`). */
const DOT = '\\\\?\\.'
/** `//` raw, or `\/\/` as in a regex source. */
const SLASHES = '(?:\\\\?\\/){2}'
/** Top-level domains a bare (non-URL) hostname must end with to count as one. */
const TLDS = 'com|org|net|io|sh|gg|dev|app|be|tv|ly|me|co|so|ai|cloud|page|us|uk|de|fr|jp|cn|edu|gov|js'

const URL_HOST_RE = new RegExp(`(${SLASHES})(${LABEL}(?:${DOT}${LABEL})+)`, 'g')
const HOST_END = `(?![A-Za-z0-9_-])(?!${DOT}[A-Za-z0-9])`
const listedRe = (host: string) =>
  new RegExp(`(?<![A-Za-z0-9_.\\\\-])${host.split('.').join(DOT)}${HOST_END}`, 'g')
const LISTED_RES: readonly [string, RegExp][] = REWRITTEN_HOSTS.map((h) => [h, listedRe(h)])
/** A whole literal that is just a hostname: "player.vimeo.com", 'excalidraw.com'. */
const BARE_HOST_RE = new RegExp(`^((?:${LABEL}${DOT})+(?:${TLDS}))$`, 'i')

const plain = (host: string) => host.replace(/\\/g, '').toLowerCase()
/** Not a remote host: localhost, an IPv4 literal, or a file name (`.//index.js` in an import path). */
const isLocal = (host: string) =>
  host === 'localhost' ||
  /^\d+(\.\d+){3}$/.test(host) ||
  /\.(m?js|cjs|ts|tsx|jsx|json|css|scss|map|wasm|png|svg|jpe?g|webp|gif|woff2?|ttf|html?)$/.test(host)

export interface RewriteCounts {
  /** URL hosts rewritten, per host. */
  url: Record<string, number>
  /** Listed hosts rewritten outside URLs, per host. */
  listed: Record<string, number>
}

/** Rewrites one literal's source text (quotes, slashes and all). */
export function rewriteLiteral(text: string, counts: RewriteCounts = { url: {}, listed: {} }): string {
  let out = text.replace(URL_HOST_RE, (m, slashes: string, host: string) => {
    const h = plain(host)
    if (NON_REQUEST_HOSTS.has(h) || h === BLOCKED_HOST || isLocal(h)) return m
    counts.url[h] = (counts.url[h] ?? 0) + 1
    return `${slashes}${host.includes('\\.') ? BLOCKED_HOST.replace('.', '\\.') : BLOCKED_HOST}`
  })
  for (const [host, re] of LISTED_RES) {
    out = out.replace(re, (m) => {
      counts.listed[host] = (counts.listed[host] ?? 0) + 1
      return m.includes('\\.') ? BLOCKED_HOST.replace('.', '\\.') : BLOCKED_HOST
    })
  }
  return out
}

export interface HostHit {
  host: string
  kind: 'url' | 'bare' | 'listed'
  context: string
}

/** Foreign hosts in one literal's text (after a rewrite, anything here is a leftover). */
export function hostsInLiteral(text: string): HostHit[] {
  const hits: HostHit[] = []
  for (const m of text.matchAll(URL_HOST_RE)) {
    const h = plain(m[2] ?? '')
    if (!NON_REQUEST_HOSTS.has(h) && h !== BLOCKED_HOST && !isLocal(h))
      hits.push({ host: h, kind: 'url', context: text.slice(0, 120) })
  }
  const inner = text.replace(/^["'`/]|["'`]$|\/[a-z]*$/g, '')
  const bare = BARE_HOST_RE.exec(inner)
  if (bare?.[1]) {
    const h = plain(bare[1])
    if (!NON_REQUEST_HOSTS.has(h) && h !== BLOCKED_HOST && !/\.js$/.test(h))
      hits.push({ host: h, kind: 'bare', context: text.slice(0, 120) })
  }
  for (const [host, re] of LISTED_RES) {
    re.lastIndex = 0
    if (re.test(text)) hits.push({ host, kind: 'listed', context: text.slice(0, 120) })
  }
  return hits
}

/** Source ranges of every string, template and regex literal of a JS module (null: not parseable). */
export function literalRanges(id: string, code: string): [number, number][] | null {
  let program: unknown = null
  for (const sourceType of ['module', 'commonjs', 'script'] as const) {
    try {
      const result = parseSync(id.replace(/\.(cjs|mjs)$/, '.js'), code, { sourceType, lang: 'js' })
      if (result.errors.length) continue
      program = result.program
      break
    } catch {}
  }
  if (!program) return null
  const ranges: [number, number][] = []
  /** Indices (in `ranges`) of the string literals, for the offset check. */
  const strings: number[] = []
  const stack: unknown[] = [program]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const n of node) stack.push(n)
      continue
    }
    const n = node as {
      type?: string
      start?: number
      end?: number
      value?: unknown
      regex?: unknown
      source?: unknown
    }
    // module specifiers are paths, not text: never rewrite them
    if (
      n.type === 'ImportDeclaration' ||
      n.type === 'ExportAllDeclaration' ||
      n.type === 'ExportNamedDeclaration' ||
      n.type === 'ImportExpression'
    ) {
      for (const [k, v] of Object.entries(n)) if (k !== 'source' && v && typeof v === 'object') stack.push(v)
      continue
    }
    if (
      typeof n.start === 'number' &&
      typeof n.end === 'number' &&
      ((n.type === 'Literal' && (typeof n.value === 'string' || n.regex)) || n.type === 'TemplateElement')
    ) {
      ranges.push([n.start, n.end])
      if (n.type === 'Literal' && typeof n.value === 'string') strings.push(ranges.length - 1)
      continue
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'parent' && v && typeof v === 'object') stack.push(v)
  }
  // Offsets must be string (UTF-16) offsets: every string literal must start and end with the same
  // quote. Vite 8's parser reports UTF-16 offsets; should a version report UTF-8 byte offsets (they
  // differ once a module has a non-ASCII character), they are mapped.
  const valid = (list: [number, number][]) =>
    list.every(([s, e]) => e <= code.length && s >= 0) &&
    strings.every((i) => {
      const [s, e] = list[i] as [number, number]
      const c = code[s]
      return (c === '"' || c === "'") && code[e - 1] === c
    })
  let out: [number, number][] | null = null
  if (valid(ranges)) out = ranges
  else if (/[\u0080-\uffff]/.test(code)) {
    const mapped = utf8ToUtf16Offsets(code, ranges)
    if (valid(mapped)) out = mapped
  }
  return out ? out.slice().sort((a, b) => a[0] - b[0]) : null
}

/** Converts sorted [start, end) UTF-8 byte offsets of `code` to UTF-16 string offsets. */
function utf8ToUtf16Offsets(code: string, ranges: [number, number][]): [number, number][] {
  const points = [...new Set(ranges.flat())].sort((a, b) => a - b)
  const map = new Map<number, number>()
  let byte = 0
  let k = 0
  for (let i = 0; i <= code.length && k < points.length; i++) {
    while (k < points.length && (points[k] ?? 0) <= byte) {
      map.set(points[k] as number, i)
      k++
    }
    if (i === code.length) break
    const c = code.charCodeAt(i)
    if (c < 0x80) byte += 1
    else if (c < 0x800) byte += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      byte += 4 // a surrogate pair is one 4-byte code point
      i++
    } else byte += 3
  }
  return ranges.map(([s, e]) => [map.get(s) ?? -1, map.get(e) ?? -1])
}

export interface ModuleRewrite {
  code: string
  counts: RewriteCounts
  left: HostHit[]
  literals: number
  /** true when the module could not be parsed and was scanned as plain text (CSS) */
  text: boolean
}

/** Rewrites the literals of one module; CSS is handled as text without its comments. */
export function rewriteModule(id: string, code: string): ModuleRewrite {
  const counts: RewriteCounts = { url: {}, listed: {} }
  if (/\.css$/.test(id)) {
    const out = code.replace(/\/\*[\s\S]*?\*\/|url\((['"]?)([^)'"]+)\1\)/g, (m) =>
      m.startsWith('/*') ? m : rewriteLiteral(m, counts),
    )
    const left = [...out.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)].flatMap((m) => hostsInLiteral(m[0]))
    return { code: out, counts, left, literals: 0, text: true }
  }
  const ranges = literalRanges(id, code)
  if (!ranges) {
    // not parseable as JS: leave it, but report every URL host it names
    return { code, counts, left: hostsInLiteral(code), literals: 0, text: true }
  }
  let out = ''
  let last = 0
  const left: HostHit[] = []
  for (const [s, e] of ranges) {
    if (s < last) continue // nested (a template element inside an already copied range)
    const lit = code.slice(s, e)
    const next = rewriteLiteral(lit, counts)
    left.push(...hostsInLiteral(next))
    out += code.slice(last, s) + next
    last = e
  }
  out += code.slice(last)
  return { code: out, counts, left, literals: ranges.length, text: false }
}

/** The npm package a module id belongs to (the last node_modules segment), or null for app code. */
export function packageOfId(id: string): string | null {
  const parts = id.replace(/\\/g, '/').split('/node_modules/')
  if (parts.length < 2) return null
  const rest = parts[parts.length - 1] ?? ''
  const m = /^(@[^/]+\/[^/]+|[^/.][^/]*)\//.exec(rest)
  return m?.[1] ?? null
}

/**
 * The engine's dependency tree: `root` and every package it depends on, transitively (dependencies and
 * optionalDependencies, not peers). Found by walking the installed package.json files (pnpm puts a
 * package's dependencies next to it in .pnpm/<pkg>/node_modules).
 */
export function engineDependencyTree(root = '@excalidraw/excalidraw', from = process.cwd()): Set<string> {
  const names = new Set<string>()
  const locate = (name: string, dir: string): string | null => {
    for (let d = dir; ; ) {
      const candidate = path.join(d, 'node_modules', name, 'package.json')
      if (existsSync(candidate)) return candidate
      if (path.basename(d) === 'node_modules') {
        const sibling = path.join(d, name, 'package.json')
        if (existsSync(sibling)) return sibling
      }
      const up = path.dirname(d)
      if (up === d) return null
      d = up
    }
  }
  const visit = (name: string, dir: string) => {
    if (names.has(name)) return
    const pj = locate(name, dir)
    if (!pj) return
    names.add(name)
    const real = realpathSync(path.dirname(pj))
    const pkg = JSON.parse(readFileSync(path.join(real, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, real)
  }
  visit(root, from)
  return names
}

const isDevDep = (id: string) => /[\\/]node_modules[\\/]\.vite[\\/]deps[\\/]/.test(id)

export interface RewriteReport {
  tree: string[]
  modules: number
  urlHosts: Record<string, number>
  listedHosts: Record<string, number>
  textModules: string[]
  left: Record<string, string[]>
}

export function excalidrawHostRewrite(): Plugin {
  let enabled = false
  let isBuild = false
  let tree = new Set<string>()
  const report: RewriteReport = {
    tree: [],
    modules: 0,
    urlHosts: {},
    listedHosts: {},
    textModules: [],
    left: {},
  }
  const verify = process.env.LOBBY_HOST_REWRITE_VERIFY === 'report' ? 'report' : 'error'
  const cleanId = (id: string) => id.split('?')[0] ?? id
  const inTree = (id: string) => {
    const pkg = packageOfId(id)
    return pkg !== null && tree.has(pkg)
  }
  const add = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v
  }
  return {
    name: 'lobby:excalidraw-host-rewrite',
    enforce: 'pre',
    configResolved(config: ResolvedConfig) {
      enabled = config.env.VITE_LOBBY_ENGINE === 'excalidraw' && process.env.LOBBY_HOST_REWRITE !== 'off'
      isBuild = config.command === 'build'
      if (enabled) tree = engineDependencyTree('@excalidraw/excalidraw', config.root)
      report.tree = [...tree].sort()
    },
    transform(code, rawId) {
      if (!enabled) return null
      const id = cleanId(rawId)
      // vite dev serves pre-bundled deps from node_modules/.vite/deps: rewrite them, never fail on them
      const dev = !isBuild && isDevDep(id)
      if (!dev && !inTree(id)) return null
      if (!/\.(m?js|cjs|css)$/.test(id)) return null
      const out = rewriteModule(id, code)
      report.modules++
      add(report.urlHosts, out.counts.url)
      add(report.listedHosts, out.counts.listed)
      if (out.text && !id.endsWith('.css')) report.textModules.push(id)
      if (out.left.length && !dev) {
        const hosts = [...new Set(out.left.map((h) => h.host))]
        report.left[id] = hosts
        if (verify === 'error') {
          this.error(
            `foreign host(s) left in ${id} after the rewrite: ${hosts.join(', ')}. Add them to ` +
              'REWRITTEN_HOSTS (or, for a namespace URI that is never requested, NON_REQUEST_HOSTS) in ' +
              'apps/web/build/excalidraw-host-rewrite.ts.',
          )
        }
      }
      return out.code === code ? null : { code: out.code, map: null }
    },
    generateBundle() {
      if (!enabled) return
      const reportFile = process.env.LOBBY_HOST_REWRITE_REPORT
      if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2))
    },
  }
}
