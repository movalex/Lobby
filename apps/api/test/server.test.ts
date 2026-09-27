// The real entry point: env parsing, PGlite on disk under DRAFTROOM_DATA_DIR, migrations, the exact
// startup line, and a refusal to start in production with development values.

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ORIGIN, testEnv } from './helpers.ts'

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url))
const children: ChildProcess[] = []
const dirs: string[] = []

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function start(env: Record<string, string>) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let out = ''
  let err = ''
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString()
  })
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString()
  })
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
  const listening = new Promise<number>((resolve, reject) => {
    const timer = setInterval(() => {
      const m = /^api listening on 127\.0\.0\.1:(\d+) \(data: (.+)\)$/m.exec(out)
      if (m) {
        clearInterval(timer)
        resolve(Number(m[1]))
      }
    }, 50)
    void exited.then((code) => {
      clearInterval(timer)
      reject(new Error(`exited ${code}: ${err}`))
    })
  })
  return { child, listening, exited, output: () => ({ out, err }) }
}

describe('api server process', () => {
  it('starts on PGlite in DRAFTROOM_DATA_DIR, prints the startup line, serves, and keeps data across restarts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-api-proc-'))
    dirs.push(dataDir)
    const env = { ...testEnv(dataDir), PORT: '0', HOST: '127.0.0.1' }
    const first = start(env)
    const port = await first.listening
    expect(first.output().out).toContain(`(data: ${dataDir})`)
    expect(existsSync(join(dataDir, 'pg', 'PG_VERSION'))).toBe(true)
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/dev/login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'alice' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    // Request logs name the route pattern, never the URL (no tokens or query strings).
    await fetch(`http://127.0.0.1:${port}/api/invitations/${'Q'.repeat(43)}?secret=1`)
    await new Promise((r) => setTimeout(r, 200))
    const logs = first.output().out
    expect(logs).toContain('/api/invitations/:token')
    expect(logs).not.toContain('Q'.repeat(43))
    expect(logs).not.toContain('secret=1')
    expect(logs).not.toContain(cookie.split('=')[1] ?? 'no-cookie')
    first.child.kill()
    await first.exited

    const second = start(env)
    const port2 = await second.listening
    const me = await fetch(`http://127.0.0.1:${port2}/api/me`, { headers: { cookie } })
    expect(me.status).toBe(200)
    second.child.kill()
    await second.exited
  })

  it('refuses to start in production with dev auth or dev secrets', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-api-proc-'))
    dirs.push(dataDir)
    const p = start({ ...testEnv(dataDir), NODE_ENV: 'production', PORT: '0' })
    await expect(p.listening).rejects.toThrow(/exited 1: api: DRAFTROOM_DEV_AUTH=1 is refused/)
  })
})
