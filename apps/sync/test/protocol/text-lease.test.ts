// docs/M0-CONTRACTS.md §4 text-edit lease, observed through real clients against the real server.
// richText goes over the wire as a whole-document put, so without the lease two people typing in one
// note lose characters; the lease makes the first writer's text win until it expires or they leave.
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { noteShape, plainText, withText } from '../harness/records.ts'
import type { SyncServer } from '../harness/server-process.ts'
import type { NodeSyncClient } from '../harness/sync-client.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()
const N = 'shape:n'

const textOn = (c: NodeSyncClient) => plainText(c.get(N)?.props.richText)
const type = (c: NodeSyncClient, text: string) => c.update(N, (r) => withText(r, text))

async function setup(env: Record<string, string>, bobUser = 'bob') {
  const server = await h.server({ env })
  const boardId = newBoardId()
  const alice = await h.connected(server, { boardId, user: 'alice' })
  const bob = await h.connected(server, { boardId, user: bobUser })
  alice.put(noteShape('n', 'NOTE')) // creating a note does not take the lease
  await alice.waitForAcked()
  await waitFor(() => bob.get(N))
  return { server, boardId, alice, bob }
}

async function serverText(server: SyncServer, boardId: string) {
  return plainText((await h.freshView(server, boardId)).get(N)?.props.richText)
}

async function lastResult(c: NodeSyncClient) {
  await c.waitForAcked()
  return c.pushResults.at(-1)?.action
}

describe('text-edit lease', () => {
  it("vetoes bob's text edit while alice holds the lease: bob gets discard + text-lease-denied and shows alice's text", async () => {
    const { server, boardId, alice, bob } = await setup({ TEXT_LEASE_MS: '30000' })
    type(alice, 'alice typing')
    expect(await lastResult(alice)).toBe('commit')
    await waitFor(() => textOn(bob) === 'alice typing')

    type(bob, 'bob typing')
    expect(await lastResult(bob)).toBe('discard')
    expect(textOn(bob)).toBe('alice typing') // bob's optimistic text was reverted
    const denied = await waitFor(() => bob.customMessages.at(-1) as Record<string, unknown> | undefined)
    expect(denied).toMatchObject({ type: 'text-lease-denied', shapeId: N, holderUserId: 'alice' })
    expect(denied.expiresInMs).toBeGreaterThan(0)
    expect(denied.expiresInMs).toBeLessThanOrEqual(30_000)
    expect(alice.customMessages).toEqual([]) // only the denied session is told
    expect(textOn(alice)).toBe('alice typing')
    expect(await serverText(server, boardId)).toBe('alice typing')
  })

  it('lets bob move a leased note (richText unchanged) but vetoes his delete of it', async () => {
    const { server, boardId, alice, bob } = await setup({ TEXT_LEASE_MS: '30000' })
    type(alice, 'alice typing')
    await alice.waitForAcked()
    await waitFor(() => textOn(bob) === 'alice typing')

    bob.update(N, (r) => ({ ...r, x: 250 }))
    expect(await lastResult(bob)).toBe('commit')
    await waitFor(() => alice.get(N)?.x === 250)

    bob.remove(N)
    expect(await lastResult(bob)).toBe('discard')
    expect(bob.get(N)).toBeDefined() // the note came back on bob's screen
    await waitFor(() => bob.customMessages.length > 0)
    expect(bob.customMessages.at(-1)).toMatchObject({
      type: 'text-lease-denied',
      shapeId: N,
      holderUserId: 'alice',
    })
    const onServer = (await h.freshView(server, boardId)).get(N)
    expect(onServer?.x).toBe(250)
    expect(plainText(onServer?.props.richText)).toBe('alice typing')
  })

  it('DOCUMENTED LIMITATION: a single push that both moves and retypes a leased note is vetoed whole (the move is lost too)', async () => {
    const { server, boardId, alice, bob } = await setup({ TEXT_LEASE_MS: '30000' })
    type(alice, 'alice typing')
    await alice.waitForAcked()
    await waitFor(() => textOn(bob) === 'alice typing')

    bob.update(N, (r) => ({ ...withText(r, 'bob typing'), x: 777 }))
    expect(await lastResult(bob)).toBe('discard')
    expect(bob.get(N)?.x).toBe(0)
    expect((await h.freshView(server, boardId)).get(N)?.x).toBe(0)
  })

  it('expires after TEXT_LEASE_MS: bob can then edit the text, and now holds the lease himself', async () => {
    const leaseMs = 1500
    const { server, boardId, alice, bob } = await setup({ TEXT_LEASE_MS: String(leaseMs) })
    type(alice, 'alice typing')
    await alice.waitForAcked()
    await waitFor(() => textOn(bob) === 'alice typing')
    type(bob, 'too early')
    expect(await lastResult(bob)).toBe('discard')

    await sleep(leaseMs + 200)
    type(bob, 'bob after expiry')
    expect(await lastResult(bob)).toBe('commit')
    expect(await serverText(server, boardId)).toBe('bob after expiry')

    await waitFor(() => textOn(alice) === 'bob after expiry')
    type(alice, 'alice again')
    expect(await lastResult(alice)).toBe('discard')
    await waitFor(() => alice.customMessages.length > 0)
    expect(alice.customMessages.at(-1)).toMatchObject({ holderUserId: 'bob' })
  })

  it("is released when the holder's last session leaves the room (after the 5 s session-removal grace), long before expiry", async () => {
    const { server, boardId, alice, bob } = await setup({ TEXT_LEASE_MS: '120000' })
    type(alice, 'alice typing')
    await alice.waitForAcked()
    await waitFor(() => textOn(bob) === 'alice typing')
    alice.dispose()
    const leftAt = Date.now()

    type(bob, 'bob immediately')
    expect(await lastResult(bob)).toBe('discard') // alice's session is still in its removal grace period

    let result: unknown = 'discard'
    let attempt = 0
    while (result !== 'commit' && Date.now() - leftAt < 20_000) {
      await sleep(500)
      type(bob, `bob attempt ${++attempt}`)
      result = await lastResult(bob)
    }
    const releasedAfterMs = Date.now() - leftAt
    expect(result).toBe('commit')
    expect(releasedAfterMs).toBeGreaterThanOrEqual(4_000) // not before the removal grace...
    expect(releasedAfterMs).toBeLessThan(20_000) // ...and long before the 120 s expiry
    expect(await serverText(server, boardId)).toBe(`bob attempt ${attempt}`)
  })

  it('DOCUMENTED LIMITATION: one user in two tabs is not protected (the lease is per user): crossing text pushes lose characters', async () => {
    const { server, boardId, alice, bob: aliceTab2 } = await setup({ TEXT_LEASE_MS: '30000' }, 'alice')
    alice.holdOutgoing()
    aliceTab2.holdOutgoing()
    type(alice, 'hello NOTE') // typed at the start in tab 1
    type(aliceTab2, 'NOTE world') // typed at the end in tab 2, before tab 1's push arrived
    alice.releaseOutgoing()
    expect(await lastResult(alice)).toBe('commit')
    aliceTab2.releaseOutgoing()
    expect(await lastResult(aliceTab2)).toBe('commit') // no veto, no conflict signal
    await waitFor(() => textOn(alice) === 'NOTE world')
    expect(await serverText(server, boardId)).toBe('NOTE world') // "hello " is gone, on tab 1's screen too
  })

  it('without an effective lease (TEXT_LEASE_MS=1, the minimum accepted) crossing text pushes from two users lose characters', async () => {
    const { server, boardId, alice, bob } = await setup({ TEXT_LEASE_MS: '1' })
    alice.holdOutgoing()
    bob.holdOutgoing()
    type(alice, 'hello NOTE')
    type(bob, 'NOTE world')
    alice.releaseOutgoing()
    expect(await lastResult(alice)).toBe('commit')
    await sleep(5) // alice's 1 ms lease has lapsed by the time bob's push is processed
    bob.releaseOutgoing()
    expect(await lastResult(bob)).toBe('commit')
    await waitFor(() => textOn(alice) === 'NOTE world')
    expect(await serverText(server, boardId)).toBe('NOTE world')
  })

  it('contract gap: TEXT_LEASE_MS=0 is refused at startup, so the lease cannot be switched off by env', async () => {
    await expect(h.server({ env: { TEXT_LEASE_MS: '0' } })).rejects.toThrow(/TEXT_LEASE_MS must be between 1/)
  })
})
