// Wave 4 part 2 (docs/EXCALIDRAW-CUTOVER.md G10): this build runs the Excalidraw engine only. The seam of
// engine-switch.ts stays (the ElementRoom registers itself; app.ts needs it), DRAFTROOM_ENGINE=tldraw is
// refused with the way back named (a deploy of bridge release R0), and the test-hook routes keep their
// flag. On 32859b1 `parseEngine('tldraw')` was accepted and the server built a TLSocketRoom registry.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSyncServer } from '../../src/app.ts'
import { checkEngineFlag, loadConfig, parseTestHooks } from '../../src/config.ts'
import { loadEngine, registerElementRoom, registeredElementRoom } from '../../src/engine-switch.ts'
import { registerTestHooks } from '../../src/test-hooks.ts'
import { callInternal, TEST_INTERNAL_SECRET, TEST_TICKET_SECRET } from '../harness/tickets.ts'
import { startServer, type TestServer, testConfig } from '../http/helpers.ts'

const env = {
  DRAFTROOM_TICKET_SECRET: TEST_TICKET_SECRET,
  DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
  DRAFTROOM_DATA_DIR: '.data-config-only',
}
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})
const track = (t: TestServer) => {
  cleanups.push(() => t.stop())
  return t
}

describe('config: DRAFTROOM_ENGINE and DRAFTROOM_TEST_HOOKS', () => {
  it('the engine is Excalidraw: unset or excalidraw is fine, tldraw is refused naming the rollback, anything else is refused', () => {
    expect(() => checkEngineFlag(undefined)).not.toThrow()
    expect(() => checkEngineFlag('')).not.toThrow()
    expect(() => checkEngineFlag('excalidraw')).not.toThrow()
    expect(() => checkEngineFlag('tldraw')).toThrow(/Excalidraw engine only.*bridge release R0/)
    expect(() => checkEngineFlag('Excalidraw')).toThrow(/DRAFTROOM_ENGINE/)
    expect(() => loadConfig(env)).not.toThrow()
    expect(() => loadConfig({ ...env, DRAFTROOM_ENGINE: 'excalidraw' })).not.toThrow()
    expect(() => loadConfig({ ...env, DRAFTROOM_ENGINE: 'tldraw' })).toThrow(/bridge release R0/)
    expect('engine' in loadConfig(env)).toBe(false)
  })

  it('test hooks are off by default, on with 1, and refused in production', () => {
    expect(parseTestHooks({})).toBe(false)
    expect(parseTestHooks({ DRAFTROOM_TEST_HOOKS: '0' })).toBe(false)
    expect(parseTestHooks({ DRAFTROOM_TEST_HOOKS: '1' })).toBe(true)
    expect(() => parseTestHooks({ DRAFTROOM_TEST_HOOKS: 'yes' })).toThrow(/DRAFTROOM_TEST_HOOKS/)
    expect(() => parseTestHooks({ DRAFTROOM_TEST_HOOKS: '1', NODE_ENV: 'production' })).toThrow(/production/)
    expect(loadConfig({ ...env, DRAFTROOM_TEST_HOOKS: '1' }).testHooks).toBe(true)
  })
})

describe('the ElementRoom seam', () => {
  it('createSyncServer refuses to build without a registered factory; loadEngine() registers the real room', async () => {
    await loadEngine()
    const real = registeredElementRoom()
    expect(real).not.toBeNull()
    if (!real) throw new Error('unreachable')
    const dir = mkdtempSync(join(tmpdir(), 'dr-engine-switch-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    registerElementRoom(null as never)
    try {
      expect(() => createSyncServer(testConfig(dir))).toThrow(/no ElementRoom/)
    } finally {
      registerElementRoom(real) // modules evaluate once: loadEngine() would not register it again
    }
    const t = track(await startServer())
    expect(await (await callInternal(t.url, 'GET', '/internal/canvas')).json()).toEqual({
      engine: 'excalidraw',
    })
    // the room's routes are mounted (GET /internal/metrics is the room's Prometheus text)
    const metrics = await callInternal(t.url, 'GET', '/internal/metrics')
    expect(metrics.status).toBe(200)
    expect(await metrics.text()).toMatch(/lobby_/)
  })
})

describe('the test-only routes (§2.4.6)', () => {
  const snap = { clock: 3, epoch: 'e1', horizon: 0, elements: [] }
  const fake = () => {
    const calls: unknown[] = []
    const off = registerTestHooks({
      snapshot: (b) => (b === 'b-known' ? snap : null),
      leaseHook: (b, r) => calls.push(['lease', b, r]),
      failCommit: (b, r) => calls.push(['fail', b, r]),
    })
    cleanups.push(off)
    return calls
  }

  it('do not exist without the flag, even with hooks registered', async () => {
    fake()
    const t = track(await startServer())
    for (const [m, p] of [
      ['GET', '/internal/test/boards/b-known/snapshot'],
      ['POST', '/internal/test/boards/b-known/lease-hook'],
      ['POST', '/internal/test/boards/b-known/fail-commit'],
    ] as const)
      expect((await callInternal(t.url, m, p, m === 'POST' ? { body: { mode: 'off' } } : {})).status, p).toBe(
        404,
      )
  })

  it('with the flag: snapshot 200, lease-hook and fail-commit 204, bad bodies 400, no secret 401', async () => {
    // the real room registers its own hooks when the server is built (one set at a time): the fake after it
    const t = track(await startServer({ config: { testHooks: true } }))
    const calls = fake()
    const s = await callInternal(t.url, 'GET', '/internal/test/boards/b-known/snapshot')
    expect(s.status).toBe(200)
    expect(await s.json()).toEqual(snap)
    expect((await callInternal(t.url, 'GET', '/internal/test/boards/b-other/snapshot')).status).toBe(404)
    expect(
      (
        await callInternal(t.url, 'POST', '/internal/test/boards/b-known/lease-hook', {
          body: { mode: 'delay', ms: 300 },
        })
      ).status,
    ).toBe(204)
    expect(
      (await callInternal(t.url, 'POST', '/internal/test/boards/b-known/fail-commit', { body: { count: 2 } }))
        .status,
    ).toBe(204)
    expect(calls).toEqual([
      ['lease', 'b-known', { mode: 'delay', ms: 300 }],
      ['fail', 'b-known', { count: 2 }],
    ])
    expect(
      (
        await callInternal(t.url, 'POST', '/internal/test/boards/b-known/lease-hook', {
          body: { mode: 'later' },
        })
      ).status,
    ).toBe(400)
    expect(
      (await callInternal(t.url, 'POST', '/internal/test/boards/b-known/fail-commit', { body: { count: 0 } }))
        .status,
    ).toBe(400)
    expect(
      (await callInternal(t.url, 'GET', '/internal/test/boards/b-known/snapshot', { secret: null })).status,
    ).toBe(401)
    expect(
      (await callInternal(t.url, 'GET', '/internal/test/boards/b-known/snapshot', { secret: 'wrong' }))
        .status,
    ).toBe(401)
  })
})
