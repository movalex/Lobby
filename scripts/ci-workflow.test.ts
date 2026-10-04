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

/** a job's text without its full-line comments */
const jobCode = (id: string) =>
  (jobs.get(id) ?? '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')

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
  it('keeps the trigger the owner has: by hand only (workflow_dispatch), since 2026-10-04', () => {
    // Pushes to main used 1,800 of the account's 2,000 free Actions minutes in a day, so the owner made the workflow
    // manual. Putting push or pull_request back is the owner's call (docs/DEPLOY.md, "CI"), not a test's.
    expect(ci).toContain('\non:\n  workflow_dispatch:\n\npermissions:\n')
    expect(code).not.toMatch(/^ {2}(push|pull_request|pull_request_target|schedule):/m)
  })

  it('pins every action to a full commit SHA and gives every job a timeout and a runner', () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? '')
    expect(uses.length).toBeGreaterThan(8)
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/)
    expect([...jobs.keys()]).toEqual([
      'checks',
      'unit',
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
    // the lint, the licence check and the type checks, as the quick static gate
    const checks = jobs.get('checks') ?? ''
    for (const cmd of ['pnpm lint', 'pnpm licence:check', 'pnpm typecheck']) expect(checks).toContain(cmd)
    // Postgres 18 for the api's *.pg.test.ts files, and the whole api project (every api test runs there when the
    // URL is set), in shards that each have a server of their own; the database is UTF8 (tests store emoji)
    const pg = jobCode('postgres')
    expect(pg).toContain('image: postgres:18')
    expect(pg).toContain('DRAFTROOM_TEST_DATABASE_URL: postgres://')
    expect(pg).toContain('POSTGRES_INITDB_ARGS: --encoding=UTF8')
    expect(pg).toMatch(/pnpm vitest run --project api --shard=\$\{\{ matrix\.shard \}\}\/3\n/)
    expect(pg).toMatch(/shard: \[1, 2, 3\]/)
    expect(pg).toContain('fail-fast: false')
  })

  it('splits the unit tests into shards that cover every vitest project, off the quick static gate', () => {
    const unit = jobCode('unit')
    const shards = /shard: \[([\d, ]+)\]/
      .exec(unit)?.[1]
      ?.split(',')
      .map((s) => s.trim())
    expect(shards).toEqual(['1', '2', '3', '4'])
    // `--shard=<n>/<total>` with the real total, and no `--project`: every project is in some shard
    expect(unit).toMatch(/pnpm vitest run --shard=\$\{\{ matrix\.shard \}\}\/4\n/)
    expect(unit).not.toContain('--project')
    expect(unit).toContain('fail-fast: false')
    // the worker tests (ffmpeg, the generated fixtures) can land in any shard
    expect(unit).toContain('install -y --no-install-recommends ffmpeg')
    expect(unit).toContain('pnpm fixtures')
    // the static gate runs no tests; the jobs that need a green gate wait for it and not for the unit shards
    expect(jobCode('checks')).not.toContain('vitest')
    for (const id of ['xbrowser', 'build-gates', 'e2e-smoke', 'e2e'])
      expect(jobs.get(id), id).toContain('needs: checks\n')
    for (const [id, body] of jobs) expect(body, id).not.toContain('needs: unit')
  })

  it('sizes the ceilings from a runner, not from the 64-core development PC', () => {
    // Measured on that PC with the workers capped at what a runner gets: the whole unit suite took 12.1 min on 2
    // workers and 21.6 min on 1 (vitest uses cpus - 1, so 1 on a 2-vCPU runner), the api project on a real Postgres
    // 15.5 min on 1; a runner core is slower than a desktop core. A ceiling costs nothing unless a job hangs, so they
    // stay generous.
    const minutes = (id: string) => Number(/\n {4}timeout-minutes: (\d+)/.exec(jobs.get(id) ?? '')?.[1])
    expect(minutes('unit')).toBeGreaterThanOrEqual(30)
    expect(minutes('postgres')).toBeGreaterThanOrEqual(40)
    expect(minutes('e2e')).toBeGreaterThanOrEqual(45)
    expect(minutes('checks')).toBeGreaterThanOrEqual(15)
  })

  it('gives every push to main a concurrency group of its own, and one group per pull request', () => {
    // a group keeps one running and one pending run: a shared group would drop the older pending runs of a burst
    expect(code).toMatch(
      /\n {2}group: ci-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.sha \}\}\n/,
    )
    expect(code).toMatch(/\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/)
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
