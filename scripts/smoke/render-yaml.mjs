// What the live static site must answer, read from the Blueprint (render.yaml) instead of copied into the
// smoke script: its response headers per path, the Content-Security-Policy among them (enforced on staging
// since 2026-10-03). A small reader for the one shape render.yaml uses, so the script needs no YAML
// library: the static service's `headers:` list of `- path:` / `name:` / `value:` entries, where a value
// is a plain or quoted scalar or a folded block (`>-`, `>`) or a literal one (`|-`, `|`).

/** One `headers:` entry of the static site: the path pattern, the header name, its value. */
export function staticSiteHeaders(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const indentOf = (l) => l.length - l.trimStart().length
  const meaningful = (l) => l.trim() !== '' && !l.trimStart().startsWith('#')
  // The static web service: its `runtime: static` line, then its `headers:` key at the same indent.
  const runtime = lines.findIndex((l) => /^\s*runtime:\s*["']?static["']?\s*(#.*)?$/.test(l))
  if (runtime < 0) return []
  const serviceIndent = indentOf(lines[runtime])
  let i = runtime + 1
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (!meaningful(l)) continue
    if (indentOf(l) < serviceIndent) return [] // the next service, or the end of the list: no headers key
    if (indentOf(l) === serviceIndent && /^\s*headers:\s*(#.*)?$/.test(l)) break
  }
  if (i >= lines.length) return []
  const headersIndent = indentOf(lines[i])
  const out = []
  let cur = null
  for (i++; i < lines.length; i++) {
    const l = lines[i]
    if (!meaningful(l)) continue
    const ind = indentOf(l)
    if (ind <= headersIndent && !/^\s*-\s/.test(l)) break
    if (ind < headersIndent) break
    const item = /^\s*-\s+(.*)$/.exec(l)
    const body = item ? item[1] : l.trim()
    if (item) {
      cur = {}
      out.push(cur)
    }
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(body)
    if (!kv || !cur) continue
    const [, key, rest] = kv
    const keyIndent = item ? ind + (l.trimStart().length - body.length) : ind
    let value
    const block = /^([>|])([+-]?)\s*(#.*)?$/.exec(rest)
    if (block) {
      const parts = []
      for (i++; i < lines.length; i++) {
        const b = lines[i]
        if (b.trim() !== '' && indentOf(b) <= keyIndent) break
        parts.push(b.trim())
      }
      i--
      while (parts.length && parts.at(-1) === '') parts.pop()
      value = block[1] === '>' ? parts.join(' ').replace(/ {2,}/g, ' ') : parts.join('\n')
    } else value = unquote(rest.replace(/\s+#.*$/, '').trim())
    cur[key] = value
  }
  return out
    .filter((h) => typeof h.path === 'string' && typeof h.name === 'string' && typeof h.value === 'string')
    .map((h) => ({ path: h.path, name: h.name, value: h.value }))
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'")))
    return s.slice(1, -1)
  return s
}

/** The header `name` (any case) render.yaml sets for `path`, or null. */
export function headerFor(headers, path, name) {
  const h = headers.find((x) => x.path === path && x.name.toLowerCase() === name.toLowerCase())
  return h ? h.value : null
}

export const CSP = 'content-security-policy'
export const CSP_REPORT_ONLY = 'content-security-policy-report-only'

/** The CSP render.yaml sets for `/*`: which header (enforced or report-only) and its value, or null. */
export function expectedCsp(headers) {
  for (const name of [CSP, CSP_REPORT_ONLY]) {
    const value = headerFor(headers, '/*', name)
    if (value !== null) return { name, value }
  }
  return null
}

/** directive (lower case) -> its sources, in order. */
export function parseCsp(value) {
  const directives = new Map()
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) directives.set(name.toLowerCase(), sources)
  }
  return directives
}

/**
 * Directive by directive, sources as sets (order and case do not matter): what the live policy lacks
 * or adds compared with render.yaml's. Empty when they are the same policy.
 */
export function cspDifferences(live, expected) {
  const a = parseCsp(live)
  const b = parseCsp(expected)
  const out = []
  const norm = (list) => new Set(list.map((s) => s.toLowerCase()))
  for (const [name, want] of b) {
    if (!a.has(name)) {
      out.push(`${name} missing (render.yaml: ${want.join(' ')})`)
      continue
    }
    const got = norm(a.get(name))
    const exp = norm(want)
    const lacks = [...exp].filter((s) => !got.has(s))
    const adds = [...got].filter((s) => !exp.has(s))
    if (lacks.length || adds.length)
      out.push(
        `${name}: ${[lacks.length ? `lacks ${lacks.join(' ')}` : '', adds.length ? `adds ${adds.join(' ')}` : ''].filter(Boolean).join('; ')}`,
      )
  }
  for (const name of a.keys()) if (!b.has(name)) out.push(`${name} not in render.yaml`)
  return out
}
