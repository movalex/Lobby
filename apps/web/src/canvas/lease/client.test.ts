import { describe, expect, it, vi } from 'vitest'
import { LeaseClient } from './client.ts'
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
