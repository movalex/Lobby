import { writeFileSync } from 'node:fs'
import type { Plugin, ResolvedConfig } from 'vite'

// Third-party hosts rewritten out of the Excalidraw engine at build time (docs/EXCALIDRAW-MIGRATION.md
// §2.12, layer 2; spike check A12).
//
// The engine packages hard-code hosts for features Lobby never uses (share links, the library browser,
// Excalidraw's own collaboration and AI backends, help and social links, the embed allowlist) and one it
// cannot turn off: every font gets https://esm.sh/... as its last @font-face source, so any local font
// miss goes third-party (ExcalidrawFontFace.createUrls, @excalidraw/excalidraw dist/dev/chunk-FN755BR4.js
// ~1225-1277; SCAFFOLD.md finding 1). Each listed host is replaced with `blocked.invalid` (RFC 6761: never
// resolves) inside the engine's modules only, so nothing in the shipped engine can reach it.
//
// Only literal host text is touched, never code: a host is rewritten when it follows `//` (a URL, also
// `\/\/` inside a regex), sits directly inside quotes (an allowlist entry, `includes("player.vimeo.com")`),
// or is written with escaped dots (`youtube\.com`, only possible inside a regex or a string). A bare
// `x.com` could be a minified property access and is left alone.
//
// After the rewrite every engine module is scanned for any foreign host at all, with the same context
// rules: a host that is neither rewritten nor on the short non-request allowlist (XML namespace URIs)
// fails the build. An Excalidraw bump that adds a host therefore breaks the build until the host is
// added below. `@license` block comments are kept verbatim (a URL in a comment is never fetched).
//
// Active when VITE_LOBBY_ENGINE=excalidraw (the engine is only bundled then). LOBBY_HOST_REWRITE=off
// disables it (for the "before" inventory of A12 only). LOBBY_HOST_REWRITE_REPORT=<file> writes the
// per-module replacement counts as JSON.

/** Replaces every rewritten host. `.invalid` never resolves (RFC 6761 §6.4). */
export const BLOCKED_HOST = 'blocked.invalid'

/**
 * Every foreign host found in the pinned engine (0.18.0-1118751: @excalidraw/excalidraw, element, common,
 * math, fractional-indexing), longest first so a subdomain is matched before its parent. Plan §2.12 listed
 * the first 16; the rest were found by the A12 inventory (docs/research/excalidraw/spike-a/A12.md).
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
  'be.com', // `youtu(?:be\.com|\.be)` in the YouTube embed regex: the host is split across a group
]
  .slice()
  .sort((a, b) => b.length - a.length)

/** Hosts that appear only as identifiers and are never requested: XML namespace URIs in SVG code. */
export const NON_REQUEST_HOSTS: ReadonlySet<string> = new Set(['www.w3.org'])

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?'
/** A dot, raw or escaped as in a regex (`\.`). */
const DOT = '\\\\?\\.'
/** Top-level domains a bare (non-URL) host must end with to count; keeps file names like "index.js" out. */
const TLDS = 'com|org|net|io|sh|gg|dev|app|be|tv|ly|me|co|so|ai|cloud|page|us|uk|de|fr|jp|cn|edu|gov'

/** Context that makes a host literal text: after `//` (raw or `\/\/`), or directly after a quote. */
const BEFORE_URL = '(?:\\\\?\\/){2}'
const BEFORE_QUOTE = '["\'`]'

/** The host's labels joined by `sep` (a regex source). Labels are [A-Za-z0-9-] only: nothing to escape. */
const hostSource = (host: string, sep: string) => host.split('.').join(sep)

interface Segment {
  text: string
  keep: boolean
}

/** Splits out `@license` block comments (and `/*!` legal comments), which are kept verbatim. */
function splitLicenseComments(code: string): Segment[] {
  const out: Segment[] = []
  const re = /\/\*[\s\S]*?\*\//g
  let last = 0
  for (const m of code.matchAll(re)) {
    const text = m[0]
    if (!(text.startsWith('/*!') || text.includes('@license') || text.includes('@preserve'))) continue
    const at = m.index ?? 0
    if (at > last) out.push({ text: code.slice(last, at), keep: false })
    out.push({ text, keep: true })
    last = at + text.length
  }
  if (last < code.length) out.push({ text: code.slice(last), keep: false })
  return out
}

/** Not followed by more host: a label character, or a (possibly escaped) dot and a label. */
const HOST_END = `(?![A-Za-z0-9_-])(?!${DOT}[A-Za-z0-9])`

const hostRe = (host: string) =>
  new RegExp(
    // (a) right after // or \/\/ or a quote, dots raw or escaped; or (b) anywhere with escaped dots
    // (`youtube\.com`: only a regex or a string can contain a backslash there)
    `(?<=${BEFORE_URL}|${BEFORE_QUOTE})${hostSource(host, DOT)}${HOST_END}` +
      `|(?<![A-Za-z0-9_.\\\\-])${hostSource(host, '\\\\\\.')}${HOST_END}`,
    'g',
  )

const HOST_RES: readonly [string, RegExp][] = REWRITTEN_HOSTS.map((h) => [h, hostRe(h)])

export interface RewriteResult {
  code: string
  /** Replacements per host. */
  replaced: Record<string, number>
}

/** Rewrites every listed host in literal text; license comments are left untouched. */
export function rewriteHosts(code: string): RewriteResult {
  const replaced: Record<string, number> = {}
  const segments = splitLicenseComments(code).map((seg) => {
    if (seg.keep) return seg.text
    let text = seg.text
    for (const [host, re] of HOST_RES) {
      text = text.replace(re, (m) => {
        replaced[host] = (replaced[host] ?? 0) + 1
        return m.includes('\\.') ? BLOCKED_HOST.replace('.', '\\.') : BLOCKED_HOST
      })
    }
    return text
  })
  return { code: segments.join(''), replaced }
}

export interface HostHit {
  host: string
  /** url: after // ; quoted: directly inside quotes ; escaped: written with `\.` (a regex) */
  kind: 'url' | 'quoted' | 'escaped'
  index: number
  context: string
}

const FOREIGN_RES: readonly [HostHit['kind'], RegExp][] = [
  ['url', new RegExp(`${BEFORE_URL}(${LABEL}(?:${DOT}${LABEL})+)`, 'g')],
  ['quoted', new RegExp(`${BEFORE_QUOTE}((?:${LABEL}\\.)+(?:${TLDS}))(?=["'\`/:])`, 'gi')],
  ['escaped', new RegExp(`(?<![A-Za-z0-9_-])((?:${LABEL}\\\\\\.)+(?:${TLDS}))(?![A-Za-z0-9_-])`, 'gi')],
]

/**
 * Every host that appears as literal text (same context rules as the rewrite), outside license comments.
 * `ignore` hosts (the blocked host and the non-request allowlist by default) are left out.
 */
export function findHosts(
  code: string,
  ignore: ReadonlySet<string> = new Set([BLOCKED_HOST, ...NON_REQUEST_HOSTS]),
): HostHit[] {
  const hits: HostHit[] = []
  let offset = 0
  for (const seg of splitLicenseComments(code)) {
    if (!seg.keep) {
      for (const [kind, re] of FOREIGN_RES) {
        for (const m of seg.text.matchAll(re)) {
          const host = (m[1] ?? '').replace(/\\/g, '').toLowerCase()
          if (!host || ignore.has(host)) continue
          // a relative or local reference is not foreign
          if (host === 'localhost' || /^\d+(\.\d+){3}$/.test(host)) continue
          const index = offset + (m.index ?? 0)
          hits.push({
            host,
            kind,
            index,
            context: code.slice(Math.max(0, index - 40), index + host.length + 40),
          })
        }
      }
    }
    offset += seg.text.length
  }
  return hits
}

/** True for a module of the engine packages (pnpm path or plain node_modules path). */
export const isEngineModule = (id: string) => /[\\/]@excalidraw[\\/]/.test(id) && !/\.d\.ts$/.test(id)
const isDevDep = (id: string) => /[\\/]node_modules[\\/]\.vite[\\/]deps[\\/]/.test(id)

export function excalidrawHostRewrite(): Plugin {
  let enabled = false
  let isBuild = false
  const report: Record<string, Record<string, number>> = {}
  const cleanId = (id: string) => id.split('?')[0] ?? id
  return {
    name: 'lobby:excalidraw-host-rewrite',
    enforce: 'pre',
    configResolved(config: ResolvedConfig) {
      enabled = config.env.VITE_LOBBY_ENGINE === 'excalidraw' && process.env.LOBBY_HOST_REWRITE !== 'off'
      isBuild = config.command === 'build'
    },
    transform(code, rawId) {
      if (!enabled) return null
      const id = cleanId(rawId)
      const engine = isEngineModule(id)
      // vite dev serves pre-bundled deps from node_modules/.vite/deps (rewrite only, no scan: other
      // libraries share those files)
      if (!engine && !(isDevDep(id) && !isBuild)) return null
      if (!/\.(m?js|css)$/.test(id)) return null
      const out = rewriteHosts(code)
      if (Object.keys(out.replaced).length) report[id] = out.replaced
      if (engine) {
        const left = findHosts(out.code)
        if (left.length) {
          this.error(
            `foreign host(s) left in ${id} after the rewrite: ${[...new Set(left.map((h) => h.host))].join(', ')}. ` +
              'Add them to REWRITTEN_HOSTS (or, for a namespace URI that is never requested, NON_REQUEST_HOSTS) ' +
              'in apps/web/build/excalidraw-host-rewrite.ts.',
          )
        }
      }
      return out.code === code ? null : { code: out.code, map: null }
    },
    generateBundle(_options, bundle) {
      if (!enabled) return
      // The shipped chunks that carry engine code must not name a rewritten host (this checks the
      // minified output, after every other plugin). The whole-dist grep is e2e/spike/csp/grep-hosts.ts.
      const listed = new Set(REWRITTEN_HOSTS)
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue
        if (!file.moduleIds.some((m) => isEngineModule(cleanId(m)))) continue
        const left = findHosts(file.code).filter((h) => listed.has(h.host))
        if (left.length) {
          this.error(
            `${file.fileName} still names ${[...new Set(left.map((h) => h.host))].join(', ')} after the rewrite`,
          )
        }
      }
      const reportFile = process.env.LOBBY_HOST_REWRITE_REPORT
      if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2))
    },
  }
}
