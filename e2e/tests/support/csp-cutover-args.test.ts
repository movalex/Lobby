// The cut-over CSP runner (e2e/spike/csp/run-cutover.ts) picks its ports from --port-base, else the
// E2E_PORT_BASE variable every other e2e run reads, else its own 6430. It used to default --port-base to
// 6430 and overwrite the variable, so `E2E_PORT_BASE=7460 pnpm csp:cutover` ran on 6430-6432 (a run meant for
// one range colliding with another), and pnpm's literal `--` was parsed as a positional. `--dry-run` prints
// the three ports and exits before anything is built or started.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const RUNNER = fileURLToPath(new URL('../../spike/csp/run-cutover.ts', import.meta.url))

function dryRun(args: string[], env: Record<string, string | undefined>) {
  const clean: Record<string, string | undefined> = {
    ...process.env,
    E2E_PORT_BASE: undefined,
    E2E_SYNC_PORT: undefined,
    E2E_API_PORT: undefined,
    E2E_WEB_PORT: undefined,
    ...env,
  }
  const r = spawnSync(process.execPath, [RUNNER, ...args, '--dry-run'], {
    env: clean as NodeJS.ProcessEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  const m = /sync (\d+) api (\d+) web (\d+)/.exec(r.stdout)
  return { status: r.status, ports: m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null, stderr: r.stderr }
}

describe('run-cutover.ts port base', () => {
  it('honours E2E_PORT_BASE', () => {
    const r = dryRun([], { E2E_PORT_BASE: '7460' })
    expect(r.status).toBe(0)
    expect(r.ports).toEqual([7460, 7461, 7462])
  })

  it('keeps its own 6430 range when nothing is given', () => {
    expect(dryRun([], {}).ports).toEqual([6430, 6431, 6432])
  })

  it('lets --port-base win over the variable', () => {
    expect(dryRun(['--port-base', '7470'], { E2E_PORT_BASE: '7460' }).ports).toEqual([7470, 7471, 7472])
  })

  it('drops the literal -- that pnpm forwards, so the option after it still counts', () => {
    expect(dryRun(['--', '--port-base', '7470'], {}).ports).toEqual([7470, 7471, 7472])
    expect(dryRun(['--'], { E2E_PORT_BASE: '7480' }).ports).toEqual([7480, 7481, 7482])
  })

  it('refuses a base whose ports Chromium will not connect to, from either source', () => {
    const viaVariable = dryRun([], { E2E_PORT_BASE: '6564' })
    expect(viaVariable.status).not.toBe(0)
    expect(viaVariable.stderr).toMatch(/ERR_UNSAFE_PORT/)
    const viaOption = dryRun(['--port-base', '6564'], {})
    expect(viaOption.status).not.toBe(0)
    expect(viaOption.stderr).toMatch(/ERR_UNSAFE_PORT/)
  })
})
