// docs/M1-CONTRACTS.md §7 end to end: the real sync process asks a (fake) API over HTTP with the
// internal secret, closes revoked sessions with FORBIDDEN, bounces role changes, and keeps sessions
// when the API is down.
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import { UNREACHABLE_API } from '../harness/server-process.ts'
import { callInternal } from '../harness/tickets.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()

async function setup(recheckMs: number) {
  const api = await h.fakeApi()
  const server = await h.server({
    env: { DRAFTROOM_API_INTERNAL_URL: api.url, ACCESS_RECHECK_MS: String(recheckMs) },
  })
  return { api, server, boardId: newBoardId() }
}

describe('access re-validation against the API', () => {
  it('revocation (role null) closes the session with 4099 FORBIDDEN within ACCESS_RECHECK_MS, over the internal secret', async () => {
    const recheck = 1_000
    const { api, server, boardId } = await setup(recheck)
    api.setRole(boardId, 'usr_alice', 'editor')
    api.setRole(boardId, 'usr_bob', 'editor')
    const alice = await h.connected(server, { boardId, user: 'usr_alice', reconnectDelayMs: 50 })
    const bob = await h.connected(server, { boardId, user: 'usr_bob' })
    await waitFor(() => api.callsFor(boardId, 'usr_alice').length > 0, { timeoutMs: 5_000 })
    expect(api.calls.every((c) => c.authorized)).toBe(true) // the secret header was sent

    api.setRole(boardId, 'usr_alice', null)
    const revokedAt = Date.now()
    expect(await alice.waitForClose((c) => c.code === 4099, 10_000)).toMatchObject({ reason: 'FORBIDDEN' })
    const took = Date.now() - revokedAt
    expect(took).toBeLessThan(recheck + 1_500)
    await sleep(500)
    expect(alice.socketGeneration).toBe(1) // terminal
    expect(alice.syncErrors).toEqual(['FORBIDDEN'])
    expect(bob.status).toBe('online')
    bob.put(geoShape('bob-still-edits'))
    await bob.waitForAcked()
    expect(bob.pushResults.at(-1)?.action).toBe('commit')
    console.info(
      `[access] revoked session closed ${took} ms after the API changed (ACCESS_RECHECK_MS=${recheck})`,
    )
  })

  it('editor -> viewer: the session is closed without a fatal reason, and the reconnect with a viewer ticket is read-only', async () => {
    const { api, server, boardId } = await setup(500)
    api.setRole(boardId, 'usr_alice', 'editor')
    const alice = await h.connected(server, { boardId, user: 'usr_alice', reconnectDelayMs: 50 })
    alice.put(geoShape('x', { x: 1 }))
    await alice.waitForAcked()

    api.setRole(boardId, 'usr_alice', 'viewer')
    alice.setRole('viewer') // the API's ticket endpoint issues the new role from now on
    const close = await alice.waitForClose(() => true, 5_000)
    expect(close.code).not.toBe(4099)
    await waitFor(() => alice.socketGeneration >= 2 && alice.isSynced(), {
      describe: () => alice.describe('reconnect'),
    })
    expect(alice.connectEvents().at(-1)?.isReadonly).toBe(true)
    expect(alice.syncErrors).toEqual([])

    alice.update('shape:x', (r) => ({ ...r, x: 500 }))
    alice.sendRawPush({ 'shape:raw': ['put', geoShape('raw')] })
    await alice.waitForAcked()
    expect(alice.pushResults.slice(-2).map((r) => r.action)).toEqual(['discard', 'discard'])
    expect(alice.get('shape:x')?.x).toBe(1)
    await sleep(1_200) // two more rounds: the role matches now, nothing else happens
    expect(alice.socketGeneration).toBe(2)
    expect((await h.freshView(server, boardId)).get('shape:x')?.x).toBe(1)
  })

  it('POST /internal/access-changed re-checks at once, long before the next periodic round', async () => {
    const { api, server, boardId } = await setup(60_000)
    api.setRole(boardId, 'usr_alice', 'editor')
    const alice = await h.connected(server, { boardId, user: 'usr_alice' })
    api.setRole(boardId, 'usr_alice', null)
    const started = Date.now()
    const res = await callInternal(server.url, 'POST', '/internal/access-changed', {
      body: { boardId, userId: 'usr_alice' },
    })
    expect(res.status).toBe(204)
    expect(await alice.waitForClose((c) => c.code === 4099, 5_000)).toMatchObject({ reason: 'FORBIDDEN' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(api.callsFor(boardId, 'usr_alice')).toHaveLength(1)
  })

  it('internal calls without the right secret are refused and trigger nothing', async () => {
    const { api, server, boardId } = await setup(60_000)
    api.setRole(boardId, 'usr_alice', null)
    const alice = await h.connected(server, { boardId, user: 'usr_alice' })
    for (const secret of [null, 'wrong-secret'])
      for (const [method, path, body] of [
        ['POST', '/internal/access-changed', { boardId, userId: 'usr_alice' }],
        ['GET', `/internal/boards/${boardId}/snapshot`, undefined],
        ['POST', `/internal/boards/${boardId}/seed`, { snapshot: {} }],
      ] as const) {
        const res = await callInternal(server.url, method, path, { body, secret })
        expect(res.status, `${method} ${path} ${secret}`).toBe(401)
      }
    await sleep(300)
    expect(api.calls).toEqual([])
    expect(alice.status).toBe('online')
  })

  for (const outage of ['HTTP 500', 'hanging', 'unreachable'] as const) {
    it(`API down (${outage}): sessions stay open and writable (fail open), each failure is logged`, async () => {
      const api = await h.fakeApi()
      api.mode = outage === 'HTTP 500' ? 'error' : 'hang'
      const server = await h.server({
        env: {
          DRAFTROOM_API_INTERNAL_URL: outage === 'unreachable' ? UNREACHABLE_API : api.url,
          ACCESS_RECHECK_MS: '300',
        },
      })
      const boardId = newBoardId()
      const alice = await h.connected(server, { boardId, user: 'usr_alice' })
      // a hanging API answers nothing: the 3 s client timeout ends each check
      const wait = outage === 'hanging' ? 4_500 : 2_000
      await sleep(wait)
      expect(alice.status).toBe('online')
      expect(alice.closes).toEqual([])
      alice.put(geoShape('still-writable'))
      await alice.waitForAcked()
      expect(alice.pushResults.at(-1)?.action).toBe('commit')
      if (outage !== 'unreachable') expect(api.callsFor(boardId).length).toBeGreaterThanOrEqual(1)
      await waitFor(
        () => server.logs().includes(`[access] check failed for board ${boardId}; keeping its sessions`),
        {
          timeoutMs: 5_000,
        },
      )
      const expected = { 'HTTP 500': '(HTTP 500)', hanging: '(timed out)', unreachable: '(unreachable)' }[
        outage
      ]
      expect(server.logs()).toContain(expected)
    })
  }
})
