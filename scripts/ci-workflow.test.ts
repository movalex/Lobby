// .github/workflows/ci.yml (wave C4): what the workflow must keep doing. There is no YAML parser among the
// repository's dependencies and the workflow has never run on GitHub, so these read it as text: the triggers are
// the owner's (unchanged), actions stay pinned, every pnpm script a job calls exists, and the gates the backlog said
// were missing (production build, StrictMode, CSP, audit, probes, Postgres, WebKit and Firefox) stay in.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const ci = read('.github/workflows/ci.yml')
const lines = ci.split(/\r?\n/)
/** the workflow without full-line comments */
const code = lines.filter((l) => !/^\s*#/.test(l)).join('\n')

/** The jobs: name -> its text (the lines under `jobs:` from `  <id>:` to the next job). */
const jobs = new Map<string, string>()
{
  const start = lines.indexOf('jobs:')
  let id: string | null = null
  let body: string[] = []
  for (const l of lines.slice(start + 1)) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(l)
    if (m) {
      if (id) jobs.set(id, body.join('\n'))
      id = m[1] ?? null
      body = []
    } else body.push(l)
  }
  if (id) jobs.set(id, body.join('\n'))
}

/** package name -> script names, for every workspace package and the root */
const scripts = new Map<string, Set<string>>()
const rootScripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts))
for (const dir of [
  'e2e',
  ...['apps', 'packages'].flatMap((d) => readdirSync(join(ROOT, d)).map((n) => `${d}/${n}`)),
]) {
  try {
    const p = JSON.parse(read(`${dir}/package.json`)) as { name: string; scripts?: Record<string, string> }
    scripts.set(p.name, new Set(Object.keys(p.scripts ?? {})))
  } catch {
    // not a package
  }
}

describe('ci.yml', () => {
  it('keeps the triggers the owner has: pushes to main and pull requests', () => {
    expect(ci).toContain('\non:\n  push:\n    branches: [main]\n  pull_request:\n\npermissions:\n')
  })

  it('pins every action to a full commit SHA and gives every job a timeout and a runner', () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? '')
    expect(uses.length).toBeGreaterThan(8)
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/)
    expect([...jobs.keys()]).toEqual([
      'checks',
      'postgres',
      'probes',
      'audit',
      'xbrowser',
      'build-gates',
      'e2e-smoke',
      'e2e',
    ])
    for (const [id, body] of jobs) {
      expect(body, `${id} has a timeout`).toMatch(/\n {4}timeout-minutes: \d+/)
      expect(body, `${id} has a runner`).toMatch(/\n {4}runs-on: ubuntu-24\.04/)
    }
  })

  it('only calls pnpm scripts that exist (root, or the package named by --filter)', () => {
    const calls = [...code.matchAll(/pnpm (--filter (\S+) )?([a-z][\w:.-]*)((?: [^\n]*)?)/g)]
    const builtin = new Set(['install', 'exec', 'audit', 'vitest', 'run', 'licenses'])
    const checked: string[] = []
    for (const m of calls) {
      const [, , filter, name = '', rest = ''] = m
      if (builtin.has(name)) continue
      const known = filter ? scripts.get(filter) : rootScripts
      expect(known, `${filter} is a workspace package`).toBeDefined()
      expect(known?.has(name), `pnpm ${filter ?? ''} ${name}${rest.slice(0, 30)}`).toBe(true)
      checked.push(`${filter ?? 'root'}:${name}`)
    }
    expect(checked).toEqual(
      expect.arrayContaining([
        'root:lint',
        'root:licence:check',
        'root:typecheck',
        'root:fixtures',
        'root:test',
        'root:audit:prod',
        '@draftroom/e2e:csp:cutover',
        '@draftroom/web:probe:engine',
        '@draftroom/web:probe:layout',
        '@draftroom/e2e:xbrowser',
        '@draftroom/e2e:excalidraw:prod',
        '@draftroom/e2e:excalidraw:dev',
      ]),
    )
  })

  it('runs the gates the backlog found missing', () => {
    // production build, StrictMode dev server and the CSP, after the checks
    const gates = jobs.get('build-gates') ?? ''
    expect(gates).toContain('needs: checks')
    for (const cmd of ['excalidraw:prod', 'excalidraw:dev', '@draftroom/e2e csp:cutover'])
      expect(gates).toContain(cmd)
    // the audit with its allowlist, the probes, the cross-browser smoke
    expect(jobs.get('audit')).toContain('pnpm audit:prod')
    expect(jobs.get('probes')).toContain('probe:engine')
    expect(jobs.get('xbrowser')).toContain('install --with-deps webkit firefox')
    expect(jobs.get('xbrowser')).toContain('@draftroom/e2e xbrowser')
    // the licence check, the type checks and every vitest project
    const checks = jobs.get('checks') ?? ''
    for (const cmd of ['pnpm licence:check', 'pnpm typecheck', 'pnpm test']) expect(checks).toContain(cmd)
    // Postgres 18 for the api's *.pg.test.ts files
    const pg = jobs.get('postgres') ?? ''
    expect(pg).toContain('image: postgres:18')
    expect(pg).toContain('DRAFTROOM_TEST_DATABASE_URL: postgres://')
    expect(pg).toContain('pnpm vitest run --project api')
  })

  it('shards the full suite on pushes to main and runs a subset on pull requests', () => {
    const e2e = jobs.get('e2e') ?? ''
    const shards = /shard: \[([\d, ]+)\]/
      .exec(e2e)?.[1]
      ?.split(',')
      .map((s) => s.trim())
    expect(shards).toEqual(['1', '2', '3', '4', '5', '6'])
    // each shard runs `--shard=<n>/<total>` with the real total
    expect(e2e).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/6/)
    expect(e2e).toContain("if: github.event_name == 'push'")
    expect(e2e).toContain('fail-fast: false')
    const smoke = jobs.get('e2e-smoke') ?? ''
    expect(smoke).toContain("if: github.event_name == 'pull_request'")
    const specs = [...smoke.matchAll(/excalidraw\/([\w-]+)\.spec\.ts/g)].map((m) => m[1])
    expect(specs).toContain('xbrowser-smoke')
    expect(specs).toContain('a11y-audit')
    // every named spec exists
    for (const s of specs) expect(() => read(`e2e/excalidraw/${s}.spec.ts`), s).not.toThrow()
  })

  it('lets only the audit, the WebKit and Firefox smoke and the A3 probe fail without failing the run', () => {
    expect(jobs.get('audit')).toContain('continue-on-error: true')
    expect(jobs.get('xbrowser')).toContain('continue-on-error: true')
    expect(jobs.get('probes')).toMatch(/Text layout probe \(A3\)\n\s+continue-on-error: true/)
    expect(code.match(/continue-on-error: true/g)).toHaveLength(3)
  })
})
