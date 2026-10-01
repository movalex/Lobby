// Pure Node checks of O3's harness modules (no stack, no browser): run by the self-test config.
import { expect, test } from '@playwright/test'
import type { PushRecord } from '../../../../apps/web/src/canvas/sync/types.ts'
import { hashElements } from '../../../../packages/canvas-schema/src/hash.ts'
import { HASH_SAMPLE } from '../../../../packages/canvas-schema/src/hash-sample.ts'
import { createBarrier, releaseTogether } from '../barrier.ts'
import { leaseHookBody } from '../hooks.ts'
import { ownerOf, stackPorts } from '../ports.ts'
import { recordPushes } from '../pushes.ts'
import { converged, divergence } from '../snapshot.ts'
import { resolveStackPorts, spikeSyncEnv } from '../stack.ts'
import type { Snapshot, SpikeBStack } from '../types.ts'
import { devUser } from '../users.ts'

test.describe('barrier', () => {
  test('releases every party in the same tick, only when all arrived', async () => {
    const b = createBarrier(3)
    const released: number[] = []
    const parties = [0, 1, 2].map(async (i) => {
      await new Promise((r) => setTimeout(r, i * 30))
      await b.arrive()
      released.push(Date.now())
    })
    await Promise.all(parties)
    expect(b.arrivals()).toHaveLength(3)
    expect(b.releasedAt()).not.toBeNull()
    expect(Math.max(...released) - Math.min(...released)).toBeLessThanOrEqual(5)
    // the parties arrived 0, 30 and 60 ms apart (setTimeout; Windows timers fire a few ms early or late)
    expect((b.arrivals()[2] ?? 0) - (b.arrivals()[0] ?? 0)).toBeGreaterThanOrEqual(40)
  })

  test('refuses extra arrivals and fails every waiter on timeout', async () => {
    const one = createBarrier(1)
    await one.arrive()
    await expect(one.arrive()).rejects.toThrow(/more arrivals/)
    const b = createBarrier(2, { timeoutMs: 50 })
    await expect(b.arrive()).rejects.toThrow(/1 of 2 parties arrived/)
    await expect(b.arrive()).rejects.toThrow(/1 of 2/)
  })

  test('releaseTogether reports each start and the spread', async () => {
    const r = await releaseTogether([
      { name: 'a', run: async () => 1 },
      { name: 'b', run: async () => 2 },
    ])
    expect(r.results.map((x) => x.value)).toEqual([1, 2])
    expect(r.spreadMs).toBeLessThanOrEqual(5)
  })
})

test.describe('push recorder', () => {
  const rec = (seq: number, ids: string[]): PushRecord => ({
    seq,
    base: 0,
    at: seq,
    ops: ids.map((id) => ({ k: 'p', id, pv: 1, g: { pos: { x: 1, y: 2 } } }) as never),
  })

  test('records only what a headless client pushes after the start', async () => {
    const log: PushRecord[] = [rec(1, ['old'])]
    const target = { name: 'C', pushLog: () => log }
    const pushes = await recordPushes(target)
    expect(await pushes.count()).toBe(0)
    log.push(rec(2, ['n1', 'n2']), rec(3, ['n1']))
    expect(await pushes.count()).toBe(2)
    expect((await pushes.ops()).map((o) => (o as { id: string }).id)).toEqual(['n1', 'n2', 'n1'])
    expect(await pushes.byElement('n1')).toHaveLength(2)
    expect(await pushes.byElement('old')).toHaveLength(0)
  })
})

test.describe('stack guards (§8.6.5, §8.6.7)', () => {
  test('sync always gets backups off, the engine and the hook flag; R2 and other stores are refused', () => {
    expect(spikeSyncEnv({})).toEqual({
      DRAFTROOM_ENGINE: 'excalidraw',
      DRAFTROOM_TEST_HOOKS: '1',
      DRAFTROOM_BACKUP_STORE: 'off',
    })
    expect(spikeSyncEnv({ testHooks: false })).toEqual({
      DRAFTROOM_ENGINE: 'excalidraw',
      DRAFTROOM_BACKUP_STORE: 'off',
    })
    expect(() => spikeSyncEnv({ syncEnv: { R2_BUCKET: 'x' } })).toThrow(/never pass R2_BUCKET/)
    expect(() => spikeSyncEnv({ syncEnv: { DRAFTROOM_BACKUP_R2_BUCKET: 'x' } })).toThrow(/never pass/)
    expect(() => spikeSyncEnv({ syncEnv: { DRAFTROOM_BACKUP_STORE: 'fs' } })).toThrow(/BACKUP_STORE=off/)
    expect(spikeSyncEnv({ syncEnv: { TEXT_LEASE_MS: '3000' } }).TEXT_LEASE_MS).toBe('3000')
  })

  test("the wave-5 owners' ranges are stack bases; a stack leaving its range is refused", () => {
    // 2B (6440-6479) and the engine integrator (6520-6559): base, api and web inside one owner's range
    expect(stackPorts(6440).web).toBe(6442)
    expect(stackPorts(6520).api).toBe(6521)
    expect(stackPorts(6557).web).toBe(6559)
    expect(ownerOf(6544)).toBe('engine-int')
    // the web port would land outside the range, or the base is in no range
    expect(() => stackPorts(6558)).toThrow(/one owner's range/)
    expect(() => stackPorts(6500)).toThrow(/one owner's range/)
    expect(() => stackPorts(6480)).toThrow(/one owner's range/)
  })

  test('a stack on another base than the web build is refused', () => {
    const base = Number(process.env.SPIKE_B_PORT_BASE ?? 7850)
    expect(resolveStackPorts({}).base).toBe(base)
    expect(() => resolveStackPorts({ base: base === 7850 ? 7860 : 7850 })).toThrow(/SPIKE_B_PORT_BASE/)
  })

  test('dev users are distinct and valid dev handles', () => {
    const users = Array.from({ length: 50 }, (_, i) => devUser(i % 2 ? 'Browser A' : 'C'))
    expect(new Set(users.map((u) => u.handle)).size).toBe(50)
    for (const u of users) expect(u.handle).toMatch(/^[a-z0-9-]{1,32}$/)
  })

  test('lease grant modes map to the frozen LeaseHookRequest', () => {
    expect(leaseHookBody({ delayMs: 300 })).toEqual({ mode: 'delay', ms: 300 })
    expect(leaseHookBody({ hold: true })).toEqual({ mode: 'hold' })
    expect(leaseHookBody({ release: true })).toEqual({ mode: 'release' })
    expect(leaseHookBody({ off: true })).toEqual({ mode: 'off' })
  })
})

test.describe('convergence logic', () => {
  const stack = {} as SpikeBStack
  const snapOf = async (elements: typeof HASH_SAMPLE, horizon = 0): Promise<Snapshot> =>
    ({ clock: 9, epoch: 'e', horizon, elements, hash: await hashElements(elements) }) as Snapshot

  test('ok when every target hashes like the snapshot (tombstones included)', async () => {
    const snap = await snapOf(HASH_SAMPLE)
    const t = { name: 'h1', hash: () => hashElements(HASH_SAMPLE) }
    const r = await converged(stack, 'b', [t], { horizonAtStart: 0, timeoutMs: 100 }, async () => snap)
    expect(r.ok).toBe(true)
    expect(r.hashes.h1).toBe(snap.hash)
  })

  test('a map without the tombstones does not converge, and the ids are named', async () => {
    const snap = await snapOf(HASH_SAMPLE)
    const live = HASH_SAMPLE.filter((e) => !e.isDeleted)
    const t = { name: 'h1', hash: () => hashElements(live) }
    const r = await converged(stack, 'b', [t], { timeoutMs: 50, pollMs: 10 }, async () => snap)
    expect(r.ok).toBe(false)
    const d = divergence('h1', live as never, snap)
    expect(d.onlyInSnapshot.length).toBe(HASH_SAMPLE.length - live.length)
    expect(d.onlyInMap).toEqual([])
    expect(d.differ).toEqual([])
  })

  test('a moved horizon invalidates the check at once', async () => {
    const snap = await snapOf(HASH_SAMPLE, 5)
    const t = { name: 'h1', hash: () => hashElements(HASH_SAMPLE) }
    const r = await converged(stack, 'b', [t], { horizonAtStart: 0, timeoutMs: 5_000 }, async () => snap)
    expect(r.horizonMoved).toBe(true)
    expect(r.ok).toBe(false)
  })

  test('divergence names the differing keys, never values', async () => {
    const snap = await snapOf(HASH_SAMPLE)
    const first = HASH_SAMPLE[0] as Record<string, unknown>
    const changed = [{ ...first, x: 12345, status: 'error' }, ...HASH_SAMPLE.slice(1)]
    const d = divergence('A', changed as never, snap)
    expect(d.differ).toEqual([{ id: first.id, keys: ['x'] }]) // status is local-only (not hashed)
  })
})
