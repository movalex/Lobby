import { describe, expect, it, vi } from 'vitest'
import { CREATED_HERE_TTL_MS, LeaseClient } from './client.ts'
import { FakeLeaseServer } from './fakeServer.ts'
import { leaseClientMessage } from './protocol.ts'

const ME = { sid: 'u1:tab1', uid: 'u1', name: 'Me' }
const ALICE = { sid: 'u2:tab9', uid: 'u2', name: 'Alice' }

function setup(delayMs: number | 'manual' = 'manual') {
  const server = new FakeLeaseServer({ me: ME, delayMs })
  const client = new LeaseClient((onMessage) => server.connect(onMessage), ME)
  return { server, client }
}

describe('LeaseClient + FakeLeaseServer (§2.9.2 message shapes)', () => {
  it('acquire -> lease.acquire {req, id}; grant -> lease.grant {req, id, ttlMs} and a lease broadcast', async () => {
    const { server, client } = setup()
    const p = client.acquire('note-1')
    expect(client.isPending('note-1')).toBe(true)
    expect(server.log.map((l) => l.message)).toEqual([{ type: 'lease.acquire', req: 1, id: 'note-1' }])
    expect(server.flush()).toBe(1)
    await expect(p).resolves.toEqual({ granted: true, id: 'note-1', ttlMs: 10_000 })
    expect(client.isHeld('note-1')).toBe(true)
    expect(server.log.map((l) => l.message.type)).toEqual(['lease.acquire', 'lease.grant', 'lease'])
    expect(client.holderOf('note-1')).toEqual(ME)
  })

  it('denies an id held by another user with lease.deny {req, id, holder}', async () => {
    const { server, client } = setup()
    server.holdByOther('note-2', ALICE)
    const p = client.acquire('note-2')
    server.flush()
    await expect(p).resolves.toEqual({ granted: false, id: 'note-2', holder: ALICE })
    expect(client.isHeld('note-2')).toBe(false)
    expect(server.log.at(-1)?.message).toEqual({ type: 'lease.deny', req: 1, id: 'note-2', holder: ALICE })
  })

  it('a second acquire for a pending id shares the answer (one message); a held id answers at once', async () => {
    const { server, client } = setup()
    const a = client.acquire('n')
    const b = client.acquire('n')
    expect(server.log.filter((l) => l.dir === 'up')).toHaveLength(1)
    server.flush()
    expect(await a).toEqual(await b)
    await expect(client.acquire('n')).resolves.toMatchObject({ granted: true })
    expect(server.log.filter((l) => l.dir === 'up')).toHaveLength(1)
  })

  it('release sends lease.release {id} and the holder broadcast clears', async () => {
    const { server, client } = setup()
    const p = client.acquire('n')
    server.flush()
    await p
    client.release('n')
    server.flush()
    expect(server.log.at(-2)?.message).toEqual({ type: 'lease.release', id: 'n' })
    expect(server.log.at(-1)?.message).toEqual({ type: 'lease', id: 'n', holder: null })
    expect(client.isHeld('n')).toBe(false)
    expect(client.holderOf('n')).toBeNull()
  })

  it('cancel before the answer resolves "cancelled"; a late grant is released straight away', async () => {
    const { server, client } = setup()
    const p = client.acquire('n')
    client.cancel('n')
    await expect(p).resolves.toEqual({ granted: false, id: 'n', cancelled: true })
    server.flush()
    server.flush()
    const ups = server.log.filter((l) => l.dir === 'up').map((l) => l.message)
    expect(ups).toEqual([
      { type: 'lease.acquire', req: 1, id: 'n' },
      { type: 'lease.release', id: 'n' },
    ])
    expect(server.holderOf('n')).toBeNull()
  })

  it('answers in request order with a timer delay', async () => {
    vi.useFakeTimers()
    try {
      const server = new FakeLeaseServer({ me: ME, delayMs: 200 }) // fake timers also fake Date.now
      const client = new LeaseClient((m) => server.connect(m), ME)
      const order: string[] = []
      void client.acquire('a').then(() => order.push('a'))
      await vi.advanceTimersByTimeAsync(10)
      server.delayMs = 50 // a shorter delay later must not overtake
      void client.acquire('b').then(() => order.push('b'))
      await vi.advanceTimersByTimeAsync(300)
      expect(order).toEqual(['a', 'b'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the server refuses malformed frames (strict schema)', () => {
    expect(() => leaseClientMessage.parse({ type: 'lease.acquire', req: 1, id: 'x', extra: 1 })).toThrow()
    expect(() => leaseClientMessage.parse({ type: 'lease.acquire', id: 'x' })).toThrow()
    expect(leaseClientMessage.parse({ type: 'lease.release', id: 'x' })).toEqual({
      type: 'lease.release',
      id: 'x',
    })
  })

  it('a holder broadcast for another session drops our own hold (lease lost)', async () => {
    const { server, client } = setup()
    const p = client.acquire('n')
    server.flush()
    await p
    server.holdByOther('n', ALICE)
    expect(client.isHeld('n')).toBe(false)
    expect(client.holderOf('n')).toEqual(ALICE)
  })
})

// Second verifier, A16 defect (b)/(c): cancel, then re-open the same element within one round trip. The
// re-acquire used to reuse the cancelled entry and return its already-resolved `cancelled` promise.
describe('LeaseClient: cancel then re-acquire within one round trip', () => {
  it('a re-acquire after cancel is a new request (new req id, new promise) and gets its own answer', async () => {
    const { server, client } = setup()
    const first = client.acquire('n')
    client.cancel('n')
    await expect(first).resolves.toEqual({ granted: false, id: 'n', cancelled: true })
    const second = client.acquire('n')
    expect(second).not.toBe(first)
    expect(client.isPending('n')).toBe(true)
    expect(client.livePending()).toEqual(['n'])
    expect(server.log.filter((l) => l.dir === 'up').map((l) => l.message)).toEqual([
      { type: 'lease.acquire', req: 1, id: 'n' },
      { type: 'lease.acquire', req: 2, id: 'n' },
    ])
    server.flush()
    await expect(second).resolves.toEqual({ granted: true, id: 'n', ttlMs: 10_000 })
    expect(client.isHeld('n')).toBe(true)
    // The cancelled request's grant came first and was ignored, not released: the server still holds
    // the lease for this session, as the newer grant says.
    expect(server.log.filter((l) => l.dir === 'up' && l.message.type === 'lease.release')).toHaveLength(0)
    expect(server.holderOf('n')).toEqual(ME)
  })

  it('a stale deny is ignored while the newer request is out; the newer answer decides', async () => {
    const { server, client } = setup()
    server.holdByOther('n', ALICE)
    client.acquire('n')
    client.cancel('n')
    const events: string[] = []
    client.on((e) => events.push(e.kind === 'stale' ? `stale:${e.answer}:${e.action}` : e.kind))
    const second = client.acquire('n')
    server.flush(1) // the cancelled request's deny
    server.clearOther('n')
    server.flush()
    await expect(second).resolves.toMatchObject({ granted: true })
    expect(events).toContain('stale:deny:ignored')
  })

  it('a late grant for a cancelled request with no newer one is released at once', async () => {
    const { server, client } = setup()
    const events: string[] = []
    client.on((e) => events.push(e.kind === 'stale' ? `stale:${e.answer}:${e.action}` : e.kind))
    client.acquire('n')
    client.cancel('n')
    server.flush()
    server.flush()
    expect(events).toContain('stale:grant:released')
    expect(client.isHeld('n')).toBe(false)
    expect(server.holderOf('n')).toBeNull()
    expect(client.livePending()).toEqual([])
  })

  it('cancel, re-acquire, cancel, re-acquire: exactly one live request at every step', async () => {
    const { server, client } = setup()
    for (let i = 0; i < 3; i++) {
      client.acquire('n')
      expect(client.livePending()).toEqual(['n'])
      client.cancel('n')
      expect(client.livePending()).toEqual([])
    }
    const last = client.acquire('n')
    server.flush()
    await expect(last).resolves.toMatchObject({ granted: true })
    expect(server.holderOf('n')).toEqual(ME)
  })
})

// Second verifier, A16 defect (a): "created here" never expired and let every later open skip the lease.
describe('LeaseClient: the New element rule is one-shot (plan open item 7)', () => {
  it('the first open takes it; every later open is an ordinary request', () => {
    const { client } = setup()
    client.markCreated('n')
    expect(client.isCreatedHere('n')).toBe(true)
    expect(client.takeCreated('n')).toBe(true)
    expect(client.takeCreated('n')).toBe(false)
    expect(client.isCreatedHere('n')).toBe(false)
  })

  it('never overrides a live lease held by another session', () => {
    const { server, client } = setup()
    client.markCreated('n')
    server.holdByOther('n', ALICE)
    expect(client.heldByOther('n')).toEqual(ALICE)
    expect(client.takeCreated('n')).toBe(false)
  })

  it('expires: the rule is for an element this session JUST created', () => {
    let t = 1_000
    const server = new FakeLeaseServer({ me: ME, delayMs: 'manual' })
    const client = new LeaseClient((m) => server.connect(m), ME, { now: () => t })
    client.markCreated('n')
    t += CREATED_HERE_TTL_MS + 1
    expect(client.takeCreated('n')).toBe(false)
  })

  it('forgetCreated: any other open ends it', () => {
    const { client } = setup()
    client.markCreated('n')
    client.forgetCreated('n')
    expect(client.takeCreated('n')).toBe(false)
  })
})

describe('LeaseClient: a lease lost to another session (§2.9.3)', () => {
  it("emits 'lost' once, and release afterwards sends nothing (the lease is not held)", async () => {
    const { server, client } = setup()
    const p = client.acquire('n')
    server.flush()
    await p
    const lost: unknown[] = []
    client.on((e) => {
      if (e.kind === 'lost') lost.push(e)
    })
    server.holdByOther('n', ALICE)
    expect(lost).toEqual([{ kind: 'lost', id: 'n', holder: ALICE }])
    const ups = server.log.filter((l) => l.dir === 'up').length
    client.release('n')
    expect(server.log.filter((l) => l.dir === 'up')).toHaveLength(ups)
  })

  it('a broadcast for an id this session does not hold is not a loss', () => {
    const { server, client } = setup()
    const lost: unknown[] = []
    client.on((e) => {
      if (e.kind === 'lost') lost.push(e)
    })
    client.acquire('n')
    server.holdByOther('n', ALICE)
    expect(lost).toEqual([])
  })
})
