import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from './rooms.ts'
import { createApiSessionEndClient, createSessionEndReporter, type SessionEndClient } from './session-end.ts'

const editor: SessionMeta = { userId: 'usr_a', role: 'editor', name: 'Ada', color: '#123456' }
const owner: SessionMeta = { ...editor, userId: 'usr_o', role: 'owner' }
const viewer: SessionMeta = { ...editor, userId: 'usr_v', role: 'viewer' }
const commenter: SessionMeta = { ...editor, userId: 'usr_c', role: 'commenter' }

function setup(opts: { editorsLeft?: Record<string, boolean>; fail?: boolean } = {}) {
  const calls: { boardId: string; at: number }[] = []
  const client: SessionEndClient = {
    ended(boardId, at) {
      calls.push({ boardId, at })
      return opts.fail ? Promise.reject(new Error('HTTP 503')) : Promise.resolve()
    },
  }
  const editors: Record<string, boolean> = { ...opts.editorsLeft }
  const log = vi.fn()
  const r = createSessionEndReporter({
    client,
    hasEditors: (b) => editors[b] ?? false,
    now: () => 5_000,
    log,
  })
  return { r, calls, editors, log }
}

describe('session-end reporter (automatic checkpoints)', () => {
  it('reports once when the last editor leaves a changed board, then only after new changes', () => {
    const { r, calls } = setup()
    r.changed('b-one')
    r.changed('b-one')
    r.removed('b-one', editor)
    expect(calls).toEqual([{ boardId: 'b-one', at: 5_000 }])
    r.removed('b-one', owner) // another tab of an editor leaving later: nothing changed since
    expect(calls).toHaveLength(1)
    r.changed('b-one')
    r.removed('b-one', owner)
    expect(calls).toHaveLength(2)
  })

  it('never reports a board nobody changed, or a viewer or commenter leaving', () => {
    const { r, calls } = setup()
    r.removed('b-one', editor) // joined and left without a write
    r.changed('b-two')
    r.removed('b-two', viewer)
    r.removed('b-two', commenter)
    expect(calls).toEqual([])
    r.removed('b-two', editor) // the changes are still marked
    expect(calls.map((c) => c.boardId)).toEqual(['b-two'])
  })

  it('waits while another editor is still in the room', () => {
    const { r, calls, editors } = setup({ editorsLeft: { 'b-one': true } })
    r.changed('b-one')
    r.removed('b-one', editor)
    expect(calls).toEqual([])
    editors['b-one'] = false
    r.removed('b-one', owner)
    expect(calls).toHaveLength(1)
  })

  it('never throws when the api fails, and logs at most once a minute', async () => {
    const { r, calls, log } = setup({ fail: true })
    for (const b of ['b-one', 'b-two']) {
      r.changed(b)
      r.removed(b, editor)
    }
    await r.flush()
    expect(calls).toHaveLength(2)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).toContain('HTTP 503')
  })

  it('a lookup that throws is logged and reports nothing; stop() forgets every mark', () => {
    const calls: string[] = []
    const log = vi.fn()
    const r = createSessionEndReporter({
      client: { ended: async (b) => void calls.push(b) },
      hasEditors: () => {
        throw new Error('room gone')
      },
      log,
    })
    r.changed('b-one')
    expect(() => r.removed('b-one', editor)).not.toThrow()
    expect(calls).toEqual([])
    expect(log).toHaveBeenCalled()
    r.stop()
    r.changed('b-two')
    r.removed('b-two', editor)
    expect(calls).toEqual([])
  })
})

describe('api session-end client', () => {
  it('GETs the internal route with the secret, never following redirects', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const client = createApiSessionEndClient({
      baseUrl: 'http://api.internal:4000',
      internalSecret: 's3cret-s3cret-s3cret-s3cret-s3cret',
      fetch: fetchImpl,
    })
    await client.ended('b-one', 1234.9)
    expect(seen[0]?.url).toBe('http://api.internal:4000/internal/boards/b-one/session-ended?at=1234')
    expect(seen[0]?.init.redirect).toBe('error')
    const headers = seen[0]?.init.headers as Record<string, string> | undefined
    expect(headers?.[INTERNAL_SECRET_HEADER]).toBe('s3cret-s3cret-s3cret-s3cret-s3cret')
  })

  it('rejects on an error status', async () => {
    const client = createApiSessionEndClient({
      baseUrl: 'http://api.internal:4000',
      internalSecret: 's3cret-s3cret-s3cret-s3cret-s3cret',
      fetch: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
    })
    await expect(client.ended('b-one', 1)).rejects.toThrow('HTTP 401')
  })
})
