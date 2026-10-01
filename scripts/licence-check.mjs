#!/usr/bin/env node
// Licence check for the production dependency trees of every app (docs/EXCALIDRAW-MIGRATION.md §1 goal 1,
// §2.12 "Licences", D13). Data source: the installed pnpm's own licence listing,
// `pnpm licenses list --prod --json --filter <workspace package>`, run once per workspace package.
//
// Usage:
//   node scripts/licence-check.mjs [--json <file>]
//   pnpm licence:check
//
// Rules (a finding fails the check unless the allowlist below covers it):
// - Every licence must be permissive (PERMISSIVE). SPDX expressions are evaluated: `A OR B` passes when one
//   side passes (Lobby elects that side), `A AND B` needs both, `X WITH exception` is judged by X.
// - Copyleft fails: GPL, AGPL, LGPL, SSPL, EUPL, MPL, OSL, CDDL, EPL, CPL, CPAL, RPL, CeCILL, CC-BY-SA, ODbL.
//   MPL-2.0 is treated as copyleft (file-level: changed MPL files must be published), so an MPL-only
//   production dependency fails like the others. A dual licence such as `(MPL-2.0 OR Apache-2.0)` passes,
//   because Lobby uses it under the permissive side.
// - A licence that needs payment, forbids commercial use or is not stated fails: `SEE LICENSE IN …`,
//   UNLICENSED, BUSL, Elastic, PolyForm, CC-BY-NC, Commons Clause, and anything pnpm reports as Unknown or
//   this script does not recognise.
// - tldraw (D13): the only tldraw packages allowed are @tldraw/tlschema, utils, store, state and validate
//   (MIT), and only as dependencies of packages/tldraw-import. (The cut-over grace, --before-cutover, left
//   with the tldraw board page at wave 4 part 2: docs/EXCALIDRAW-CUTOVER.md G10.)
//
// The listing covers the packages pnpm installed on this machine: platform-specific optional packages
// (sharp's libvips binaries) are checked for the platform that ran the install. CI (Linux x64) checks the
// binaries the Docker images use.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Workspace packages whose production trees are checked, with their workspace dependencies. */
const APP_DIR = 'apps'

const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'PSF-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'X11',
  'Zlib',
])
const COPYLEFT = /^(A?GPL|LGPL|SSPL|EUPL|MPL|OSL|CDDL|EPL|CPL|CPAL|RPL|CECILL|CC-BY-SA|ODbL)(-|$)/i
const PAID = /^(BUSL|Elastic|PolyForm|CC-BY-NC|Commons-Clause|UNLICENSED$|Commercial|Proprietary)/

/** The five MIT tldraw packages packages/tldraw-import keeps (D13). */
const TLDRAW_MIT = new Set([
  '@tldraw/tlschema',
  '@tldraw/utils',
  '@tldraw/store',
  '@tldraw/state',
  '@tldraw/validate',
])
const TLDRAW_IMPORT = '@draftroom/tldraw-import'

/**
 * Explicit exceptions. Each names the packages, the exact versions, the exact licence string pnpm reports,
 * the apps whose trees may contain them, and why. A version bump or a licence change needs a new review.
 */
const ALLOWLIST = [
  {
    names: ['khroma'],
    versions: ['2.1.0'],
    licence: 'Unknown',
    apps: ['@draftroom/web'],
    // The package.json has no licence field; the file it ships is the MIT licence text, pinned by hash.
    licenceFile: {
      name: 'license',
      sha256: '66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49',
    },
    reason:
      'MIT: package.json has no "license" field, and its `license` file is the MIT licence (Fabio Spampinato, Andrew Maney), pinned by sha256. Reached through mermaid <- @excalidraw/mermaid-to-excalidraw <- @excalidraw/excalidraw.',
  },
  {
    names: [
      '@img/sharp-libvips-linux-x64',
      '@img/sharp-libvips-linux-arm64',
      '@img/sharp-libvips-linuxmusl-x64',
      '@img/sharp-libvips-linuxmusl-arm64',
      '@img/sharp-libvips-darwin-arm64',
      '@img/sharp-libvips-darwin-x64',
    ],
    versions: ['1.3.3'],
    licence: 'LGPL-3.0-or-later',
    apps: ['@draftroom/worker'],
    reason:
      "libvips, the prebuilt shared library sharp loads (the worker's thumbnails). Used unmodified and dynamically linked, inside Lobby's own worker containers (NAS, optional Render worker); Lobby does not convey it to anyone, and the LGPL's conditions apply only on conveying. No fee. Not in the web, sync or api trees.",
  },
  {
    names: ['@img/sharp-win32-x64', '@img/sharp-win32-arm64', '@img/sharp-win32-ia32'],
    versions: ['0.35.4'],
    licence: 'Apache-2.0 AND LGPL-3.0-or-later',
    apps: ['@draftroom/worker'],
    reason:
      'The Windows build of sharp with libvips bundled (development machines only; the worker images are Linux). Same terms as the libvips entry above.',
  },
]

function parseArgs(argv) {
  const opts = { json: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--json') opts.json = argv[++i]
    else if (a.startsWith('--json=')) opts.json = a.slice('--json='.length)
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/licence-check.mjs [--json <file>]')
      process.exit(0)
    } else {
      console.error(`licence-check: unknown argument ${a}`)
      process.exit(2)
    }
  }
  return opts
}

/** Runs the installed pnpm (the one that started this script when there is one). */
function pnpm(args) {
  const execPath = process.env.npm_execpath
  const viaNode = execPath && /pnpm/i.test(basename(execPath)) && /.c?js$/i.test(execPath)
  // On Windows `pnpm` is a .cmd shim, which needs a shell; the arguments are this script's own constants
  // and workspace package names, quoted.
  const child = viaNode
    ? spawn(process.execPath, [execPath, ...args], { cwd: ROOT })
    : process.platform === 'win32'
      ? spawn(['pnpm', ...args.map((a) => `"${a}"`)].join(' '), { cwd: ROOT, shell: true })
      : spawn('pnpm', args, { cwd: ROOT })
  return new Promise((resolvePromise, reject) => {
    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8')
      if (code === 0) resolvePromise(stdout)
      else {
        const detail = (Buffer.concat(err).toString('utf8') || stdout).trim()
        reject(new Error(`pnpm ${args.join(' ')} exited ${code}: ${detail}`))
      }
    })
  })
}

/** Maps with at most `limit` calls in flight. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Workspace packages and their production workspace dependencies (dependencies + optionalDependencies). */
async function workspaceGraph() {
  const projects = JSON.parse(await pnpm(['ls', '-r', '--depth', '-1', '--json']))
  const byName = new Map()
  for (const p of projects) {
    if (!p.name || resolve(p.path) === ROOT) continue
    const manifest = readJson(join(p.path, 'package.json'))
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies }
    const workspaceDeps = Object.entries(deps)
      .filter(([, spec]) => String(spec).startsWith('workspace:'))
      .map(([name]) => name)
    byName.set(p.name, { name: p.name, dir: relative(ROOT, p.path).replaceAll('\\', '/'), workspaceDeps })
  }
  return byName
}

function closure(graph, start) {
  const seen = new Set()
  const stack = [start]
  while (stack.length) {
    const name = stack.pop()
    if (seen.has(name)) continue
    const node = graph.get(name)
    if (!node) throw new Error(`workspace package ${name} not found`)
    seen.add(name)
    stack.push(...node.workspaceDeps)
  }
  return [...seen].sort()
}

/** pnpm's listing for one workspace package: its external production packages (pnpm does not follow workspace links). */
async function listing(name) {
  const out = (await pnpm(['licenses', 'list', '--prod', '--json', '--filter', name])).trim()
  if (!out.startsWith('{')) {
    if (/no licenses/i.test(out)) return []
    throw new Error(`unexpected pnpm licenses output for ${name}: ${out.slice(0, 200)}`)
  }
  const entries = []
  for (const [group, pkgs] of Object.entries(JSON.parse(out))) {
    for (const p of pkgs) {
      p.versions.forEach((version, i) => {
        entries.push({
          name: p.name,
          version,
          licence: p.license ?? group,
          path: p.paths?.[i] ?? p.paths?.[0],
        })
      })
    }
  }
  return entries
}

// ---- SPDX expressions ----------------------------------------------------------------------------------

const RANK = { permissive: 0, copyleft: 1, unknown: 2, paid: 3 }

function classifyId(raw) {
  const id = raw.replace(/\+$/, '')
  if (PERMISSIVE.has(id)) return 'permissive'
  if (COPYLEFT.test(id)) return 'copyleft'
  if (PAID.test(id)) return 'paid'
  return 'unknown'
}

function tokenize(expr) {
  return expr.replace(/[()]/g, ' $& ').split(/\s+/).filter(Boolean)
}

/** Returns 'permissive' | 'copyleft' | 'unknown' | 'paid' for a licence string. */
export function classifyLicence(licence) {
  const text = String(licence ?? '').trim()
  if (!text || /^unknown$/i.test(text) || /^see licen[cs]e in/i.test(text)) return 'unknown'
  const tokens = tokenize(text)
  let pos = 0
  const peek = () => tokens[pos]
  const fail = () => {
    throw new Error('bad expression')
  }
  const factor = () => {
    const t = tokens[pos++]
    if (t === undefined) fail()
    let v
    if (t === '(') {
      v = expr()
      if (tokens[pos++] !== ')') fail()
    } else if (/^(AND|OR|WITH|\))$/i.test(t)) fail()
    else v = classifyId(t)
    if (/^WITH$/i.test(peek() ?? '')) {
      pos++
      if (tokens[pos++] === undefined) fail()
    }
    return v
  }
  const term = () => {
    let v = factor()
    while (/^AND$/i.test(peek() ?? '')) {
      pos++
      const w = factor()
      if (RANK[w] > RANK[v]) v = w
    }
    return v
  }
  const expr = () => {
    let v = term()
    while (/^OR$/i.test(peek() ?? '')) {
      pos++
      const w = term()
      if (RANK[w] < RANK[v]) v = w
    }
    return v
  }
  try {
    const v = expr()
    return pos === tokens.length ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

// ---- The check -----------------------------------------------------------------------------------------

function rawLicenceField(path) {
  try {
    const m = readJson(join(path, 'package.json'))
    if (typeof m.license === 'string') return m.license
    if (m.license && typeof m.license === 'object') return JSON.stringify(m.license)
    if (Array.isArray(m.licenses)) return JSON.stringify(m.licenses)
    return '(no licence field)'
  } catch {
    return '(package.json unreadable)'
  }
}

function allowlistEntryFor(pkg) {
  return ALLOWLIST.find((e) => e.names.includes(pkg.name))
}

/** null when the entry covers the package in every app that has it, else the reason it does not. */
function allowlistMismatch(entry, pkg) {
  if (!entry.versions.includes(pkg.version)) return `version ${pkg.version} is not in the allowlist entry`
  if (entry.licence !== pkg.licence)
    return `licence "${pkg.licence}" differs from the reviewed "${entry.licence}"`
  const outside = pkg.apps.filter((a) => !entry.apps.includes(a))
  if (outside.length)
    return `allowed only in ${entry.apps.join(', ')}, also reached from ${outside.join(', ')}`
  if (entry.licenceFile) {
    const file = pkg.path && join(pkg.path, entry.licenceFile.name)
    if (!file || !existsSync(file)) return `licence file ${entry.licenceFile.name} not found`
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (sha !== entry.licenceFile.sha256)
      return `licence file ${entry.licenceFile.name} changed (sha256 ${sha})`
  }
  return null
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const pnpmVersion = (await pnpm(['--version'])).trim()
  const graph = await workspaceGraph()
  const apps = [...graph.values()].filter((p) => p.dir.startsWith(`${APP_DIR}/`)).map((p) => p.name)
  apps.sort()

  const appClosures = new Map(apps.map((a) => [a, closure(graph, a)]))
  const members = [...new Set([...appClosures.values()].flat())].sort()
  const listed = await mapLimit(members, 4, listing)
  const listings = new Map(members.map((m, i) => [m, listed[i]]))

  // One record per name@version: licence, path, the apps and the workspace packages that reach it.
  const pkgs = new Map()
  for (const [app, closureMembers] of appClosures) {
    for (const member of closureMembers) {
      for (const e of listings.get(member)) {
        const key = `${e.name}@${e.version}`
        let rec = pkgs.get(key)
        if (!rec) {
          rec = { ...e, apps: [], importers: [] }
          pkgs.set(key, rec)
        }
        if (!rec.apps.includes(app)) rec.apps.push(app)
        if (!rec.importers.includes(member)) rec.importers.push(member)
      }
    }
  }

  const fail = []
  const allowed = []
  const usedAllowlist = new Set()

  for (const rec of [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    rec.apps.sort()
    rec.importers.sort()
    rec.class = classifyLicence(rec.licence)
    const isTldraw = rec.name === 'tldraw' || rec.name.startsWith('@tldraw/')

    if (isTldraw && !TLDRAW_MIT.has(rec.name)) {
      const field = rawLicenceField(rec.path)
      fail.push({
        ...rec,
        rule: 'tldraw',
        why:
          rec.class === 'permissive'
            ? `tldraw package outside the five packages/tldraw-import keeps (D13); licence "${field}"`
            : `tldraw package outside the five packages/tldraw-import keeps (D13); licence "${field}": needs a paid production licence key`,
      })
      continue
    }

    if (rec.class !== 'permissive') {
      const entry = allowlistEntryFor(rec)
      const mismatch = entry ? allowlistMismatch(entry, rec) : 'not in the allowlist'
      if (entry && !mismatch) {
        usedAllowlist.add(entry)
        allowed.push({ ...rec, rule: 'allowlist', why: entry.reason })
      } else {
        fail.push({
          ...rec,
          rule: rec.class,
          why: `${rec.class} licence (package.json: "${rawLicenceField(rec.path)}"); ${mismatch}`,
        })
      }
    }

    if (isTldraw && TLDRAW_MIT.has(rec.name)) {
      const outside = rec.importers.filter((i) => i !== TLDRAW_IMPORT)
      if (outside.length) {
        fail.push({
          ...rec,
          rule: 'tldraw-outside-import',
          why: `MIT tldraw package reached from ${outside.join(', ')}; only ${TLDRAW_IMPORT} may depend on it (D13)`,
        })
      }
    }
  }

  const unusedAllowlist = ALLOWLIST.filter((e) => !usedAllowlist.has(e)).map((e) => e.names.join(', '))

  // ---- Report ----
  const line = (s = '') => console.log(s)
  const where = (r) => `apps: ${r.apps.join(', ')}; via ${r.importers.join(', ')}`
  line(
    `Licence check: production dependencies of ${apps.join(', ')} (pnpm ${pnpmVersion} licence listing; strict mode)`,
  )
  line()
  for (const app of apps) {
    const recs = [...pkgs.values()].filter((r) => r.apps.includes(app))
    const byLicence = new Map()
    for (const r of recs) byLicence.set(r.licence, (byLicence.get(r.licence) ?? 0) + 1)
    const hist = [...byLicence.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`)
    line(`  ${app}: ${recs.length} packages (workspace: ${appClosures.get(app).join(', ')})`)
    line(`    ${hist.join('; ')}`)
  }
  line()
  line(`FAIL (${fail.length})`)
  for (const r of fail) line(`  - ${r.name}@${r.version}: ${r.why} [${where(r)}]`)
  line()
  line(`Allowed by the allowlist (${allowed.length})`)
  for (const r of allowed) line(`  - ${r.name}@${r.version} "${r.licence}": ${r.why} [${where(r)}]`)
  if (unusedAllowlist.length) {
    line()
    line(
      `Allowlist entries not installed on this platform (${unusedAllowlist.length}): ${unusedAllowlist.join(' | ')}`,
    )
  }
  line()
  line(fail.length ? `Result: FAIL (${fail.length} finding${fail.length === 1 ? '' : 's'})` : 'Result: PASS')

  if (opts.json) {
    const report = {
      ok: fail.length === 0,
      mode: 'strict',
      pnpm: pnpmVersion,
      apps: Object.fromEntries([...appClosures].map(([a, c]) => [a, c])),
      packages: pkgs.size,
      fail,
      allowed,
      unusedAllowlist,
    }
    writeFileSync(resolve(opts.json), `${JSON.stringify(report, null, 2)}\n`)
  }
  process.exitCode = fail.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`licence-check: ${err.message}`)
    process.exitCode = 2
  })
}
