import { ASSIGNEE_REFS_CACHE_MS, ASSIGNEE_REFS_MAX_UIDS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  ASSIGNEE_REFS_CACHE_ENTRIES,
  ASSIGNEE_REFS_NEGATIVE_MS,
  AssigneeRefsCache,
  createAssigneeRefsClient,
} from './assignee-refs.ts'

describe('AssigneeRefsCache (the room’s 60 s cache of the assignee-refs answers)', () => {
  it('a yes lives 60 s, a no 10 s; then the uid is unknown again', () => {
    let now = 1_000
    const c = new AssigneeRefsCache(() => now)
    c.put(['usr_a', 'usr_b'], ['usr_a'])
    expect([c.get('usr_a'), c.get('usr_b'), c.get('usr_c')]).toEqual([true, false, undefined])
    now += ASSIGNEE_REFS_NEGATIVE_MS
    expect([c.get('usr_a'), c.get('usr_b')]).toEqual([true, undefined])
    now += ASSIGNEE_REFS_CACHE_MS - ASSIGNEE_REFS_NEGATIVE_MS
    expect(c.get('usr_a')).toBeUndefined()
  })

  it('is bounded (least recently used out first)', () => {
    const c = new AssigneeRefsCache(() => 0)
    const uids = Array.from({ length: ASSIGNEE_REFS_CACHE_ENTRIES + 1 }, (_, i) => `usr_${i}`)
    c.put(uids, uids)
    expect(c.get('usr_0')).toBeUndefined()
    expect(c.get(`usr_${ASSIGNEE_REFS_CACHE_ENTRIES}`)).toBe(true)
  })
})

describe('createAssigneeRefsClient', () => {
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('POSTs the uids in chunks of 50 with the internal secret, and keeps only asked uids of the answer', async () => {
    const calls: { url: string; body: { uids: string[] }; secret: string | null }[] = []
    const lookup = createAssigneeRefsClient({
      baseUrl: 'http://api.test',
      internalSecret: 's3cret',
      fetchImpl: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { uids: string[] }
        calls.push({ url, body, secret: new Headers(init.headers).get('x-draftroom-internal') })
        return answer(200, { accounts: [...body.uids.filter((u) => u.endsWith('1')), 'usr_planted'] })
      }) as unknown as typeof fetch,
    })
    const uids = Array.from({ length: ASSIGNEE_REFS_MAX_UIDS + 5 }, (_, i) => `usr_${i}`)
    const got = await lookup('brd_1', [...uids, 'usr_1'])
    expect(calls.map((c) => [c.url, c.body.uids.length, c.secret])).toEqual([
      ['http://api.test/internal/boards/brd_1/assignee-refs', ASSIGNEE_REFS_MAX_UIDS, 's3cret'],
      ['http://api.test/internal/boards/brd_1/assignee-refs', 5, 's3cret'],
    ])
    expect(got).toEqual(uids.filter((u) => u.endsWith('1')))
  })

  it('fails on anything but a 200 with the contract’s body (a 404 too: the caller fails closed)', async () => {
    for (const res of [
      answer(404, { error: { code: 'board-not-found' } }),
      answer(503, { error: { code: 'unavailable' } }),
      answer(200, { accounts: 'usr_1' }),
      answer(200, { accounts: [], extra: 1 }),
    ]) {
      const lookup = createAssigneeRefsClient({
        baseUrl: 'http://api.test',
        internalSecret: 's',
        fetchImpl: (async () => res) as unknown as typeof fetch,
      })
      await expect(lookup('brd_1', ['usr_1'])).rejects.toThrow()
    }
  })
})
