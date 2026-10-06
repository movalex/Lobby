import { INTERNAL_ONLY_CODE, INTERNAL_ONLY_MESSAGES } from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, createApiClient, isNoAccess, kindForStatus } from './client.ts'
import { BOARD_ID, makeBoard, makeMe, makeUser, member, WS_ID } from './test-fixtures.ts'

type Call = { url: string; init: RequestInit }

/** A fetch double that answers every request with `respond()` and records what was sent. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return respond(call)
  })
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const errorBody = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status)
const headersOf = (c: Call | undefined) => (c?.init.headers ?? {}) as Record<string, string>

async function caught(p: Promise<unknown>): Promise<ApiError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(ApiError)
  return e as ApiError
}

describe('api client: requests', () => {
  it('GETs same-origin JSON with the session cookie and parses it with the contract schema', async () => {
    const me = makeMe()
    const { calls, fetchImpl } = fakeFetch(() => json(me))
    const out = await createApiClient({ fetchImpl }).me()
    expect(out).toEqual(me)
    expect(calls[0]?.url).toBe('/api/me')
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.credentials).toBe('same-origin')
    expect(headersOf(calls[0]).accept).toBe('application/json')
    // No content-type without a body: the API's JSON parser rejects an empty JSON body.
    expect(headersOf(calls[0])['content-type']).toBeUndefined()
    expect(calls[0]?.init.body).toBeUndefined()
  })

  it('sends mutations as JSON bodies', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(makeBoard({ title: 'Retro' }), 201))
    const api = createApiClient({ fetchImpl })
    await api.createBoard(WS_ID, { title: 'Retro', projectId: null })
    expect(calls[0]?.url).toBe(`/api/workspaces/${WS_ID}/boards`)
    expect(calls[0]?.init.method).toBe('POST')
    expect(headersOf(calls[0])['content-type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: 'Retro', projectId: null })
  })

  it('domain access: a board invitation is locked to an address, sent as { role, email }', async () => {
    const created = {
      id: 'inv_0123456789abcdefghij',
      url: '/invite/abc',
      expiresAt: '2026-10-04T12:00:00.000Z',
    }
    const { calls, fetchImpl } = fakeFetch(() => json(created, 201))
    const out = await createApiClient({ fetchImpl }).createBoardInvitation(BOARD_ID, {
      role: 'commenter',
      email: 'pat@client.example.test',
    })
    expect(out).toEqual(created)
    expect(calls[0]?.url).toBe(`/api/boards/${BOARD_ID}/invitations`)
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      role: 'commenter',
      email: 'pat@client.example.test',
    })
  })

  it('sends body-less POSTs (status changes, tickets, logout) without a content-type', async () => {
    const { calls, fetchImpl } = fakeFetch((c) =>
      c.url.endsWith('/ticket')
        ? json({
            ticket: 'v1.a.b',
            expiresAt: 1,
            role: 'viewer',
            user: { id: makeUser('bob').id, name: 'Bob', color: '#000' },
          })
        : c.url.endsWith('/logout')
          ? new Response(null, { status: 204 })
          : json(makeBoard({ status: 'trashed' })),
    )
    const api = createApiClient({ fetchImpl })
    await api.setBoardStatus(BOARD_ID, 'trash')
    const t = await api.boardTicket(BOARD_ID)
    await api.logout()
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `POST /api/boards/${BOARD_ID}/trash`,
      `POST /api/boards/${BOARD_ID}/ticket`,
      'POST /api/auth/logout',
    ])
    for (const c of calls) {
      expect(c.init.body).toBeUndefined()
      expect(headersOf(c)['content-type']).toBeUndefined()
    }
    expect(t.role).toBe('viewer')
  })

  it('builds list queries and unwraps the list envelopes', async () => {
    const boards = [makeBoard(), makeBoard({ id: 'b-000000000z', title: 'Other' })]
    const { calls, fetchImpl } = fakeFetch((c) =>
      c.url.includes('/members') ? json({ members: [member('alice', 'owner')] }) : json({ boards }),
    )
    const api = createApiClient({ fetchImpl })
    expect(
      await api.listBoards(WS_ID, { status: 'archived', projectId: 'prj_0123456789ABCDEFGHIJ' }),
    ).toEqual(boards)
    expect(await api.listBoards(WS_ID)).toEqual(boards)
    expect(await api.listMembers(BOARD_ID)).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      `/api/workspaces/${WS_ID}/boards?status=archived&projectId=prj_0123456789ABCDEFGHIJ`,
    )
    expect(calls[1]?.url).toBe(`/api/workspaces/${WS_ID}/boards`)
    expect(calls[2]?.url).toBe(`/api/boards/${BOARD_ID}/members`)
  })

  it('member grant/revoke resolve with the updated member list the API returns', async () => {
    const after = [member('alice', 'owner'), member('bob', 'editor')]
    const { calls, fetchImpl } = fakeFetch(() => json({ members: after }))
    const api = createApiClient({ fetchImpl })
    const bob = makeUser('bob').id
    expect(await api.putMember(BOARD_ID, bob, 'editor')).toEqual(after)
    expect(await api.removeMember(BOARD_ID, bob)).toEqual(after)
    expect(calls.map((c) => c.init.method)).toEqual(['PUT', 'DELETE'])
    expect(calls[1]?.init.body).toBeUndefined()
  })

  it('encodes path parameters (an invite token cannot escape its path segment)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({}, 404))
    const api = createApiClient({ fetchImpl })
    await caught(api.getInvitation('a/../../me?x=1#'))
    expect(calls[0]?.url).toBe('/api/invitations/a%2F..%2F..%2Fme%3Fx%3D1%23')
    await caught(api.putMember(BOARD_ID, 'usr_x/../y', 'viewer'))
    expect(calls[1]?.url).toBe(`/api/boards/${BOARD_ID}/members/usr_x%2F..%2Fy`)
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ role: 'viewer' })
  })

  it('rethrows an abort as-is so callers can tell cancellation from failure', async () => {
    const ctrl = new AbortController()
    const fetchImpl = (async () => {
      ctrl.abort()
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    const err = await createApiClient({ fetchImpl })
      .me(ctrl.signal)
      .catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(ApiError)
    expect((err as DOMException).name).toBe('AbortError')
  })
})

describe('api client: error mapping', () => {
  it('maps statuses to the kinds the UI branches on', () => {
    expect(kindForStatus(400)).toBe('invalid')
    expect(kindForStatus(401)).toBe('unauthorized')
    expect(kindForStatus(403)).toBe('forbidden')
    expect(kindForStatus(404)).toBe('not-found')
    expect(kindForStatus(409)).toBe('conflict')
    expect(kindForStatus(410)).toBe('gone')
    expect(kindForStatus(422)).toBe('invalid')
    expect(kindForStatus(429)).toBe('rate-limited')
    expect(kindForStatus(500)).toBe('server')
    expect(kindForStatus(503)).toBe('server')
  })

  it('401 -> unauthorized, and the signed-out handler runs (any screen, any call)', async () => {
    const onUnauthorized = vi.fn()
    const { fetchImpl } = fakeFetch(() => errorBody(401, 'NOT_AUTHENTICATED', 'Sign in first.'))
    const api = createApiClient({ fetchImpl, onUnauthorized })
    const e = await caught(api.listBoards(WS_ID))
    expect(e).toMatchObject({ kind: 'unauthorized', status: 401, code: 'NOT_AUTHENTICATED' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    await caught(api.boardTicket(BOARD_ID))
    expect(onUnauthorized).toHaveBeenCalledTimes(2)
  })

  it('403 and 404 are both "no access" (the UI never tells them apart), and do not sign out', async () => {
    const onUnauthorized = vi.fn()
    for (const [status, kind] of [
      [403, 'forbidden'],
      [404, 'not-found'],
    ] as const) {
      const { fetchImpl } = fakeFetch(() => errorBody(status, 'NOPE', 'No.'))
      const e = await caught(createApiClient({ fetchImpl, onUnauthorized }).getBoard(BOARD_ID))
      expect(e.kind).toBe(kind)
      expect(isNoAccess(e)).toBe(true)
    }
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(isNoAccess(new ApiError('gone', 410, 'X', 'x'))).toBe(false)
    expect(isNoAccess(new Error('x'))).toBe(false)
  })

  it('410 on an invitation -> gone, with the server message', async () => {
    const { fetchImpl } = fakeFetch(() =>
      errorBody(410, 'INVITATION_EXPIRED', 'This invitation has expired.'),
    )
    const e = await caught(createApiClient({ fetchImpl }).acceptInvitation('tok'))
    expect(e).toMatchObject({
      kind: 'gone',
      code: 'INVITATION_EXPIRED',
      message: 'This invitation has expired.',
    })
  })

  it('a move or a visibility raise refused by Internal only keeps the scope’s words (the dialogs show them)', async () => {
    // Wave J pre-deploy review (IO-1, IO-2b): the move dialog and the Share dialog show err.message, so
    // the refusal must survive the client's length cap (a longer message would turn generic).
    for (const scope of ['project', 'workspace'] as const) {
      const { fetchImpl } = fakeFetch(() => errorBody(409, INTERNAL_ONLY_CODE, INTERNAL_ONLY_MESSAGES[scope]))
      const api = createApiClient({ fetchImpl })
      const moved = await caught(api.patchBoard(BOARD_ID, { projectId: null }))
      expect(moved).toMatchObject({ kind: 'conflict', status: 409, code: INTERNAL_ONLY_CODE })
      expect(moved.message).toBe(INTERNAL_ONLY_MESSAGES[scope])
      const raised = await caught(api.patchBoard(BOARD_ID, { visibility: 'workspace_view' }))
      expect(raised.message).toBe(INTERNAL_ONLY_MESSAGES[scope])
    }
  })

  it("surfaces the server's user-safe message (e.g. last-owner protection)", async () => {
    const { fetchImpl } = fakeFetch(() =>
      errorBody(400, 'LAST_OWNER', 'A board needs at least one owner. Make someone else an owner first.'),
    )
    const e = await caught(createApiClient({ fetchImpl }).removeMember(BOARD_ID, makeUser('alice').id))
    expect(e.message).toBe('A board needs at least one owner. Make someone else an owner first.')
    expect(e.code).toBe('LAST_OWNER')
  })

  it('replaces non-contract error bodies with a generic message (never echoes proxy pages or paths)', async () => {
    const html = fakeFetch(
      () => new Response('<html>proxy error at /srv/data/secret</html>', { status: 502 }),
    )
    const e1 = await caught(createApiClient({ fetchImpl: html.fetchImpl }).me())
    expect(e1).toMatchObject({ kind: 'server', status: 502, code: 'HTTP_502' })
    expect(e1.message).not.toContain('/srv')
    const long = fakeFetch(() => errorBody(400, 'X', 'y'.repeat(301)))
    const e2 = await caught(createApiClient({ fetchImpl: long.fetchImpl }).me())
    expect(e2.message).not.toContain('yyyy')
  })

  it('network failure -> network', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const e = await caught(createApiClient({ fetchImpl }).authConfig())
    expect(e).toMatchObject({ kind: 'network', status: 0, code: 'NETWORK' })
  })

  it('a 2xx that does not match the contract -> bad-response (never passed on half-parsed)', async () => {
    const cases: [string, unknown][] = [
      [
        'ticket with an unknown role',
        { ticket: 't', expiresAt: 1, role: 'root', user: { id: makeUser('a').id, name: 'a', color: '#000' } },
      ],
      ['board list with a mixed-case board id', { boards: [makeBoard({ id: 'B-ABC' })] }],
      ['me without workspaces', { user: makeUser('a') }],
      ['not JSON', 'not json'],
    ]
    for (const [label, body] of cases) {
      const { fetchImpl } = fakeFetch(() =>
        typeof body === 'string' ? new Response(body, { status: 200 }) : json(body),
      )
      const api = createApiClient({ fetchImpl })
      const call = label.startsWith('ticket')
        ? api.boardTicket(BOARD_ID)
        : label.startsWith('board list')
          ? api.listBoards(WS_ID)
          : api.me()
      const e = await caught(call)
      expect(e.kind, label).toBe('bad-response')
    }
  })
})
