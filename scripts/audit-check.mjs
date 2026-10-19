#!/usr/bin/env node
// Dependency audit for CI (wave C4; docs/SECURITY-REVIEW-2026-10-02.md section 2). Runs the installed pnpm's
// `pnpm audit --prod --json` (the production trees of every workspace package) and judges it against the list of
// advisories the owner has been told about, each with the reason it is not fixed.
//
// Usage:
//   node scripts/audit-check.mjs [--input <audit.json>] [--json <report.json>]
//   pnpm audit:prod
//
// Rules:
// - An advisory of severity high or critical that is NOT allowlisted fails the check (exit 1). That is how a new
//   advisory, or a new dependency path to a known one, is noticed.
// - An allowlist entry names the advisory (GHSA id), the package, the exact installed version it was reviewed on
//   and the dependency route it was reviewed through. A different version or a different route is a new
//   finding, so a bump that changes either needs a new review rather than riding on the old one.
// - A moderate or low advisory that is not allowlisted is printed as a warning (exit 0): there is no fix to wait
//   for on a schedule, and a registry that learns of a moderate advisory next week must not block a merge.
// - An allowlist entry whose advisory is no longer reported is printed as removable (exit 0).
// - A registry or network failure (no JSON from pnpm) is exit 2, not a pass.
//
// `--input` judges a saved `pnpm audit --prod --json` instead of calling the registry (offline use, the tests).

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Severities that fail the check when an advisory is not allowlisted. */
export const FAIL_SEVERITIES = new Set(['high', 'critical'])

const NANOID_REASON =
  "Reached only through @excalidraw/excalidraw > @excalidraw/mermaid-to-excalidraw > nanoid. All four nanoid advisories need an attacker-chosen size or option; mermaid-to-excalidraw calls nanoid() with no argument (12 call sites in its dist) and Lobby never references Mermaid. The fix is nanoid 5, a major bump of a package Excalidraw pins; it clears when Excalidraw's next nightly moves mermaid-to-excalidraw, in the dedicated bump PR that runs the engine probe suite (docs/SECURITY-REVIEW-2026-10-02.md section 2)."

/**
 * The advisories the owner has been told about (docs/SECURITY-REVIEW-2026-10-02.md section 2: 5 remain after the two
 * exact-pinned overrides in pnpm-workspace.yaml). `route` is a substring of the dependency path pnpm reports.
 */
export const ALLOWLIST = [
  {
    ghsa: 'GHSA-mwcw-c2x4-8c55',
    package: 'nanoid',
    versions: ['4.0.2'],
    route: '@excalidraw/mermaid-to-excalidraw>nanoid',
    reason: NANOID_REASON,
  },
  {
    ghsa: 'GHSA-28wg-ghj8-5hjv',
    package: 'nanoid',
    versions: ['4.0.2'],
    route: '@excalidraw/mermaid-to-excalidraw>nanoid',
    reason: NANOID_REASON,
  },
  {
    ghsa: 'GHSA-2v37-7h3g-55p8',
    package: 'nanoid',
    versions: ['4.0.2'],
    route: '@excalidraw/mermaid-to-excalidraw>nanoid',
    reason: NANOID_REASON,
  },
  {
    ghsa: 'GHSA-xwg4-73v4-xw9w',
    package: 'nanoid',
    versions: ['4.0.2'],
    route: '@excalidraw/mermaid-to-excalidraw>nanoid',
    reason: NANOID_REASON,
  },
  {
    ghsa: 'GHSA-vfj7-8cjw-p6xm',
    package: 'braces',
    versions: ['3.0.3'],
    route: '@excalidraw/excalidraw>sass>chokidar>braces',
    reason:
      "Reached only through @excalidraw/excalidraw > sass > chokidar > braces. sass is a build-time dependency of the Excalidraw package that neither Lobby's source nor Excalidraw's compiled dist imports, and the vulnerable pattern comes from a file-watcher glob, not from user input. No patched release exists (the advisory's range is <=3.0.3, patched <0.0.0), so there is nothing to bump to (docs/SECURITY-REVIEW-2026-10-02.md section 2).",
  },
  {
    ghsa: 'GHSA-68fv-2mgg-jv7q',
    package: 'source-map-js',
    versions: ['1.2.1'],
    route: '@excalidraw/excalidraw>sass>source-map-js',
    reason:
      "Reached only through @excalidraw/excalidraw > sass > source-map-js, the same build-time-only sass as the braces entry: neither Lobby's source nor Excalidraw's compiled dist imports sass, so source-map-js never runs in the browser, the api, the sync or the worker, and it never parses a source map from user input. The fix (1.2.2) arrives with the dedicated @excalidraw/* bump PR that AGENTS.md requires; a pnpm override of a dependency inside the pinned engine is out of scope for wave W (reviewed 2026-10-19).",
  },
]

/**
 * Judges a `pnpm audit --json` report against `allowlist`.
 * Returns { failures, allowed, warnings, removable }: each failure/allowed/warning is
 * { ghsa, package, severity, title, versions, why }.
 */
export function evaluate(report, allowlist = ALLOWLIST) {
  const failures = []
  const allowed = []
  const warnings = []
  const seen = new Set()
  const advisories = Object.values(report?.advisories ?? {})
  for (const adv of advisories) {
    const ghsa = adv.github_advisory_id ?? `npm-${adv.id}`
    const severity = String(adv.severity ?? 'unknown').toLowerCase()
    const findings = adv.findings ?? []
    const versions = [...new Set(findings.map((f) => f.version))].sort()
    const paths = findings.flatMap((f) => f.paths ?? [])
    const base = { ghsa, package: adv.module_name, severity, title: adv.title, versions, paths }
    const entry = allowlist.find((e) => e.ghsa === ghsa && e.package === adv.module_name)
    let mismatch = null
    if (!entry) mismatch = 'not in the allowlist'
    else {
      const badVersion = versions.filter((v) => !entry.versions.includes(v))
      const badPath = paths.filter((p) => !p.includes(entry.route))
      if (badVersion.length)
        mismatch = `installed ${adv.module_name}@${badVersion.join(', ')} was not the reviewed version (${entry.versions.join(', ')})`
      else if (badPath.length)
        mismatch = `reached through a route the review did not cover: ${badPath[0]} (reviewed: ...${entry.route})`
    }
    if (entry && !mismatch) {
      seen.add(entry)
      allowed.push({ ...base, why: entry.reason })
    } else if (FAIL_SEVERITIES.has(severity)) {
      failures.push({ ...base, why: mismatch })
    } else {
      warnings.push({ ...base, why: mismatch })
    }
  }
  const removable = allowlist.filter((e) => !seen.has(e)).map((e) => `${e.ghsa} (${e.package})`)
  return { failures, allowed, warnings, removable }
}

/** Runs the installed pnpm; resolves { code, stdout, stderr } whatever the exit code (audit exits 1 on findings). */
function pnpm(args) {
  const execPath = process.env.npm_execpath
  const viaNode = execPath && /pnpm/i.test(basename(execPath)) && /.c?js$/i.test(execPath)
  const child = viaNode
    ? spawn(process.execPath, [execPath, ...args], { cwd: ROOT })
    : process.platform === 'win32'
      ? spawn(['pnpm', ...args].join(' '), { cwd: ROOT, shell: true })
      : spawn('pnpm', args, { cwd: ROOT })
  return new Promise((resolvePromise, reject) => {
    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', reject)
    child.on('close', (code) =>
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    )
  })
}

function parseArgs(argv) {
  const opts = { input: null, json: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--input') opts.input = argv[++i]
    else if (a.startsWith('--input=')) opts.input = a.slice('--input='.length)
    else if (a === '--json') opts.json = argv[++i]
    else if (a.startsWith('--json=')) opts.json = a.slice('--json='.length)
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/audit-check.mjs [--input <audit.json>] [--json <report.json>]')
      process.exit(0)
    } else {
      console.error(`audit-check: unknown argument ${a}`)
      process.exit(2)
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  let raw
  if (opts.input) raw = readFileSync(resolve(opts.input), 'utf8')
  else {
    const r = await pnpm(['audit', '--prod', '--json'])
    raw = r.stdout
    if (!raw.trim().startsWith('{')) {
      console.error(
        `audit-check: pnpm audit gave no JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
      )
      process.exitCode = 2
      return
    }
  }
  let report
  try {
    report = JSON.parse(raw)
  } catch (e) {
    console.error(`audit-check: the audit output is not JSON: ${e.message}`)
    process.exitCode = 2
    return
  }
  if (!report || typeof report !== 'object' || !('advisories' in report)) {
    console.error('audit-check: the audit output has no "advisories" field (an error body?)')
    process.exitCode = 2
    return
  }
  const { failures, allowed, warnings, removable } = evaluate(report)
  const line = (s = '') => console.log(s)
  const where = (r) => `${r.package}@${r.versions.join(', ')} via ${r.paths[0] ?? '(no path)'}`
  const counts = report.metadata?.vulnerabilities
  line(
    `Dependency audit (pnpm audit --prod): ${report.metadata?.totalDependencies ?? '?'} production dependencies` +
      (counts
        ? `; reported ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low`
        : ''),
  )
  line()
  line(`FAIL (${failures.length}): high or critical, not allowlisted`)
  for (const r of failures) line(`  - ${r.ghsa} [${r.severity}] ${r.title}: ${where(r)}; ${r.why}`)
  line()
  line(`Allowed by the allowlist (${allowed.length}), each reviewed in docs/SECURITY-REVIEW-2026-10-02.md`)
  for (const r of allowed) line(`  - ${r.ghsa} [${r.severity}] ${r.package}@${r.versions.join(', ')}`)
  if (warnings.length) {
    line()
    line(`Warnings (${warnings.length}): moderate or low, not allowlisted (do not fail the check)`)
    for (const r of warnings) line(`  - ${r.ghsa} [${r.severity}] ${r.title}: ${where(r)}`)
  }
  if (removable.length) {
    line()
    line(`Allowlist entries no longer reported (remove them): ${removable.join(', ')}`)
  }
  line()
  line(failures.length ? `Result: FAIL (${failures.length} advisories)` : 'Result: PASS')
  if (opts.json) {
    writeFileSync(
      resolve(opts.json),
      `${JSON.stringify({ ok: failures.length === 0, failures, allowed, warnings, removable }, null, 2)}\n`,
    )
  }
  process.exitCode = failures.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`audit-check: ${err.message}`)
    process.exitCode = 2
  })
}
