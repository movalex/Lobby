// docs/M1-CONTRACTS.md §6: admission by signed, board-specific, short-lived ticket only. Every
// failure is an upgrade followed by a terminal 4099 close, before any room (or file) is opened.
import { TICKET_TTL_MS } from '@draftroom/auth-tickets'
import { describe, expect, it } from 'vitest'
import { newBoardId, roomFiles, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape, noteShape, withText } from '../harness/records.ts'
import { mintTicket, tamperTicket } from '../harness/tickets.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()

describe('connection tickets', () => {
  it('every bad ticket is refused with the right 4099 reason, terminally, and opens no room', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const valid = mintTicket(boardId, 'alice', 'viewer')
    const cases: Array<[string, string | undefined, 'NOT_AUTHENTICATED' | 'FORBIDDEN']> = [
      ['missing', undefined, 'NOT_AUTHENTICATED'],
      ['empty', '', 'NOT_AUTHENTICATED'],
      ['garbage', 'hello', 'NOT_AUTHENTICATED'],
      [
        'expired',
        mintTicket(boardId, 'alice', 'editor', { now: Date.now() - TICKET_TTL_MS - 10_000 }),
        'NOT_AUTHENTICATED',
      ],
      [
        'issued in the future',
        mintTicket(boardId, 'alice', 'editor', { now: Date.now() + 60_000 }),
        'NOT_AUTHENTICATED',
      ],
      ['tampered role (viewer -> owner)', tamperTicket(valid, { role: 'owner' }), 'NOT_AUTHENTICATED'],
      ['tampered user', tamperTicket(valid, { uid: 'mallory' }), 'NOT_AUTHENTICATED'],
      ['tampered board', tamperTicket(valid, { bid: newBoardId() }), 'NOT_AUTHENTICATED'],
      [
        'signed with another secret',
        mintTicket(boardId, 'alice', 'editor', { secret: 'x'.repeat(40) }),
        'NOT_AUTHENTICATED',
      ],
      ['signed, unknown role', mintTicket(boardId, 'alice', 'superuser' as never), 'NOT_AUTHENTICATED'],
      ['valid, for another board', mintTicket(newBoardId(), 'alice', 'owner'), 'FORBIDDEN'],
    ]
    for (const [label, ticket, reason] of cases) {
      const c = h.client(server, { boardId, ticket, name: label })
      expect(await c.waitForClose(), label).toMatchObject({ code: 4099, reason })
      expect(c.syncErrors, label).toEqual([reason])
    }
    await sleep(300)
    expect(roomFiles(server.dataDir)).toEqual([]) // nothing was opened for any of them
    expect(server.logs()).not.toContain(valid.split('.')[2]) // no ticket material in the logs
  })

  it('a refused client does not retry; a fresh valid ticket for the same tab then connects', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const bad = h.client(server, { boardId, ticket: 'nope', sessionId: 'tab-1', autoReconnect: true })
    await bad.waitForClose()
    await sleep(400)
    expect(bad.socketGeneration).toBe(1)
    const good = await h.connected(server, { boardId, user: 'alice', sessionId: 'tab-1' })
    good.put(geoShape('ok'))
    await good.waitForAcked()
    expect(good.pushResults.at(-1)?.action).toBe('commit')
  })

  it('identity and role come only from the ticket: the retired devUser/devRole parameters are ignored', async () => {
    const server = await h.server({ env: { TEXT_LEASE_MS: '30000' } })
    const boardId = newBoardId()
    const alice = await h.connected(server, { boardId, user: 'usr_alice' })
    alice.put(noteShape('n', 'NOTE'))
    alice.update('shape:n', (r) => withText(r, 'alice typing', 'usr_alice')) // takes the text lease as usr_alice
    await alice.waitForAcked()

    // no ticket + dev params: still unauthenticated
    const devOnly = h.client(server, { boardId, extraQuery: { devUser: 'alice', devRole: 'owner' } })
    expect(await devOnly.waitForClose()).toMatchObject({ code: 4099, reason: 'NOT_AUTHENTICATED' })

    // a viewer ticket + dev params claiming an editor: still read-only
    const viewer = await h.connected(server, {
      boardId,
      user: 'usr_vic',
      role: 'viewer',
      extraQuery: { devUser: 'usr_alice', devRole: 'editor' },
    })
    expect(viewer.connectEvents()[0]?.isReadonly).toBe(true)
    viewer.put(geoShape('forged'))
    await viewer.waitForAcked()
    expect(viewer.pushResults.at(-1)?.action).toBe('discard')

    // the lease names the ticket's uid; a second user is denied by that name
    const bob = await h.connected(server, { boardId, user: 'usr_bob' })
    await waitFor(() => bob.get('shape:n'))
    bob.update('shape:n', (r) => withText(r, 'bob typing', 'usr_bob'))
    await bob.waitForAcked()
    expect(bob.pushResults.at(-1)?.action).toBe('discard')
    await waitFor(() => bob.customMessages.length > 0)
    expect(bob.customMessages.at(-1)).toMatchObject({ type: 'text-lease-denied', holderUserId: 'usr_alice' })
  })

  it('owner and editor tickets can write; the same user in two tabs gets two sessions', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    for (const role of ['owner', 'editor'] as const) {
      const c = await h.connected(server, { boardId, user: `usr_${role}`, role })
      expect(c.connectEvents()[0]?.isReadonly).toBe(false)
      c.put(geoShape(role))
      await c.waitForAcked()
      expect(c.pushResults.at(-1)?.action).toBe('commit')
    }
    const tab1 = await h.connected(server, { boardId, user: 'usr_same' })
    const tab2 = await h.connected(server, { boardId, user: 'usr_same' })
    // (the name is the ticket's in both tabs, so the tabs tag themselves in a free-text field)
    tab1.setPresence({ chatMessage: 'tab1' })
    tab2.setPresence({ chatMessage: 'tab2' })
    await waitFor(() => tab1.presences().some((p) => p.chatMessage === 'tab2' && p.userName === 'usr_same'))
    expect(tab1.status).toBe('online')
    expect(tab2.status).toBe('online')
  })

  it('the client-chosen sessionId is namespaced by the ticket user: another user reusing it replaces nothing', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const alice = await h.connected(server, { boardId, user: 'usr_alice', sessionId: 'shared-tab' })
    const mallory = await h.connected(server, { boardId, user: 'usr_mallory', sessionId: 'shared-tab' })
    alice.setPresence()
    mallory.setPresence()
    await waitFor(() => alice.presences().some((p) => p.userName === 'usr_mallory'))
    await waitFor(() => mallory.presences().some((p) => p.userName === 'usr_alice'))
    alice.put(geoShape('from-alice'))
    await alice.waitForAcked()
    expect(alice.pushResults.at(-1)?.action).toBe('commit')
    await sleep(200)
    for (const c of [alice, mallory]) {
      expect(c.closes, c.name).toEqual([])
      expect(c.socketGeneration, c.name).toBe(1)
    }
  })
})
