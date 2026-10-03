// scripts/audit-check.mjs (wave C4): the CI dependency audit's judgement of a `pnpm audit --prod --json` report.
// The fixture is the five advisories the owner has been told about (docs/SECURITY-REVIEW-2026-10-02.md section 2),
// in the shape pnpm 10.34.5 prints them.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALLOWLIST, evaluate } from './audit-check.mjs'

const SCRIPT = fileURLToPath(new URL('./audit-check.mjs', import.meta.url))
const NANOID_PATH = 'apps__web>@excalidraw/excalidraw>@excalidraw/mermaid-to-excalidraw>nanoid'
const BRACES_PATH = 'apps__web>@excalidraw/excalidraw>sass>chokidar>braces'

interface Adv {
  id: number
  github_advisory_id: string
  module_name: string
  severity: string
  title: string
  findings: { version: string; paths: string[] }[]
}
const adv = (
  id: number,
  ghsa: string,
  name: string,
  severity: string,
  version: string,
  path: string,
): Adv => ({
  id,
  github_advisory_id: ghsa,
  module_name: name,
  severity,
  title: `${name} advisory ${ghsa}`,
  findings: [{ version, paths: [path] }],
})
const report = (...list: Adv[]) => ({
  advisories: Object.fromEntries(list.map((a) => [String(a.id), a])),
  metadata: { totalDependencies: 451 },
})

const KNOWN = [
  adv(1109564, 'GHSA-mwcw-c2x4-8c55', 'nanoid', 'moderate', '4.0.2', NANOID_PATH),
  adv(1138810, 'GHSA-28wg-ghj8-5hjv', 'nanoid', 'high', '4.0.2', NANOID_PATH),
  adv(1139455, 'GHSA-2v37-7h3g-55p8', 'nanoid', 'high', '4.0.2', NANOID_PATH),
  adv(1153188, 'GHSA-xwg4-73v4-xw9w', 'nanoid', 'high', '4.0.2', NANOID_PATH),
  adv(1240992, 'GHSA-vfj7-8cjw-p6xm', 'braces', 'high', '3.0.3', BRACES_PATH),
]

describe('the allowlist', () => {
  it('lists the 5 known advisories, each with a reason', () => {
    expect(ALLOWLIST.map((e) => e.ghsa).sort()).toEqual(KNOWN.map((a) => a.github_advisory_id).sort())
    for (const e of ALLOWLIST) expect(e.reason.length).toBeGreaterThan(80)
  })
})

describe('evaluate', () => {
  it("passes today's report: 5 advisories (4 high, 1 moderate), all allowlisted", () => {
    const r = evaluate(report(...KNOWN))
    expect(r.failures).toEqual([])
    expect(r.allowed).toHaveLength(5)
    expect(r.warnings).toEqual([])
    expect(r.removable).toEqual([])
  })

  it('fails a new high advisory, even in a package that is already allowlisted for other advisories', () => {
    const r = evaluate(
      report(...KNOWN, adv(9, 'GHSA-new0-new0-new0', 'nanoid', 'high', '4.0.2', NANOID_PATH)),
    )
    expect(r.failures.map((f) => f.ghsa)).toEqual(['GHSA-new0-new0-new0'])
    expect(r.failures[0]?.why).toBe('not in the allowlist')
  })

  it('fails a new critical advisory in another package', () => {
    const r = evaluate(
      report(adv(10, 'GHSA-crit-crit-crit', 'fastify', 'critical', '5.12.5', 'apps__api>fastify')),
    )
    expect(r.failures).toHaveLength(1)
  })

  it('fails a known advisory on a version the review did not cover (a bump needs a new review)', () => {
    const r = evaluate(report(adv(1240992, 'GHSA-vfj7-8cjw-p6xm', 'braces', 'high', '3.0.2', BRACES_PATH)))
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]?.why).toMatch(/was not the reviewed version \(3\.0\.3\)/)
  })

  it('fails a known advisory reached through a new dependency route', () => {
    const r = evaluate(
      report(
        adv(1240992, 'GHSA-vfj7-8cjw-p6xm', 'braces', 'high', '3.0.3', 'apps__api>fastify>some-dep>braces'),
      ),
    )
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]?.why).toMatch(/route the review did not cover/)
  })

  it('warns, without failing, about a new moderate or low advisory', () => {
    const r = evaluate(
      report(
        ...KNOWN,
        adv(11, 'GHSA-mod0-mod0-mod0', 'zod', 'moderate', '4.6.5', 'packages__contracts>zod'),
        adv(12, 'GHSA-low0-low0-low0', 'ws', 'low', '8.21.3', 'apps__sync>ws'),
      ),
    )
    expect(r.failures).toEqual([])
    expect(r.warnings.map((w) => w.ghsa).sort()).toEqual(['GHSA-low0-low0-low0', 'GHSA-mod0-mod0-mod0'])
  })

  it('names the allowlist entries whose advisory is gone', () => {
    const r = evaluate(report(KNOWN[4] as Adv))
    expect(r.failures).toEqual([])
    expect(r.removable).toEqual([
      'GHSA-mwcw-c2x4-8c55 (nanoid)',
      'GHSA-28wg-ghj8-5hjv (nanoid)',
      'GHSA-2v37-7h3g-55p8 (nanoid)',
      'GHSA-xwg4-73v4-xw9w (nanoid)',
    ])
  })

  it('passes a clean report (no advisories at all)', () => {
    expect(evaluate({ advisories: {} }).failures).toEqual([])
  })
})

describe('the command', () => {
  const run = (body: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-check-'))
    try {
      const file = join(dir, 'audit.json')
      writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
      return spawnSync(process.execPath, [SCRIPT, '--input', file], { encoding: 'utf8' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('exits 0 on the known advisories, 1 on a new high one, 2 on output that is not an audit', () => {
    const ok = run(report(...KNOWN))
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('Result: PASS')
    const bad = run(
      report(...KNOWN, adv(9, 'GHSA-new0-new0-new0', 'lodash-es', 'high', '4.18.1', 'apps__web>lodash-es')),
    )
    expect(bad.status).toBe(1)
    expect(bad.stdout).toContain('GHSA-new0-new0-new0')
    expect(run('<html>502 Bad Gateway</html>').status).toBe(2)
    expect(run({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }).status).toBe(2)
  })
})
