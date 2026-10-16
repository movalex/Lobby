// The chat hook client (wave R, WS2): same-origin requests parsed with the contracts, a 404 from the reads turns the
// feature off for the tab without throwing, other failures reject with the api's own code and message, and a pasted URL
// is sent once and never kept.
import type { ChatHook } from '@draftroom/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiClient } from '../../api/client.ts'
import {
  ChatHookRequestError,
  chatHooksAvailable,
  createChatHook,
  deleteChatHook,
  getChatPrefs,
  listChatHooks,
  patchChatHook,
  putChatPrefs,
  resetChatHooksAvailability,
  subscribeChatHooks,
  testChatHook,
} from './client.ts'

const W = 'wsp_0123456789abcdefghij'
const HOOK = 'chk_0123456789abcdefghij'
const URL_TEXT = 'https://hooks.slack.com/services/T0000000A/B0000000B/abcdEFGH1234'

const hook = (over: Partial<ChatHook> = {}): ChatHook => ({
  id: HOOK,
  name: '#lobby-pitches',
  provider: 'slack',
  hint: 'hooks.slack.com/…/•••1234',
  includeSnippets: false,
  createdBy: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  disabledAt: null,
  disabledReason: null,
  lastOkAt: null,
  lastErrorCode: null,
  ...over,
})

interface Seen {
  method: string
  url: string
  body: unknown
  credentials: RequestCredentials | undefined
}

function fake(answer: (seen: Seen) => { status: number; json?: unknown }) {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const s: Seen = {
      method: String(init.method),
      url,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      credentials: init.credentials,
    }
    seen.push(s)
    const r = answer(s)
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { seen, api: createApiClient({ fetchImpl }) }
}

const err = (status: number, code: string, message = 'No.') => ({
  status,
  json: { error: { code, message } },
})

beforeEach(() => resetChatHooksAvailability())

describe('reads', () => {
  it('list: same-origin GET, hints only', async () => {
    const f = fake(() => ({ status: 200, json: { hooks: [hook()] } }))
    const hooks = await listChatHooks(W, { api: f.api })
    expect(hooks).toHaveLength(1)
    expect(f.seen[0]).toMatchObject({
      method: 'GET',
      url: `/api/workspaces/${W}/chat-hooks`,
      credentials: 'same-origin',
    })
    expect(JSON.stringify(hooks)).not.toContain('abcdEFGH1234')
    expect(chatHooksAvailable()).toBe(true)
  })

  it('a 404 (an api without the routes, or no webhook secret) answers empty, turns the feature off, and later reads ask nothing', async () => {
    const f = fake(() => err(404, 'CHAT_HOOKS_OFF'))
    let told = 0
    const off = subscribeChatHooks(() => {
      told += 1
    })
    expect(await listChatHooks(W, { api: f.api })).toEqual([])
    expect(chatHooksAvailable()).toBe(false)
    expect(told).toBe(1)
    expect(await getChatPrefs(W, { api: f.api })).toEqual({ hooks: [], prefs: [] })
    expect(f.seen).toHaveLength(1)
    off()
  })

  it('the unknown-route 404 of an older api is the same', async () => {
    const f = fake(() => err(404, 'NOT_FOUND', 'Not found.'))
    expect(await getChatPrefs(W, { api: f.api })).toEqual({ hooks: [], prefs: [] })
    expect(chatHooksAvailable()).toBe(false)
  })

  it('other failures reject with the api’s code, status and message (a non-creator admin: CREATOR_REQUIRED)', async () => {
    const f = fake(() => err(403, 'CREATOR_REQUIRED', 'Only creators can do this.'))
    const e = await listChatHooks(W, { api: f.api }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ChatHookRequestError)
    expect(e).toMatchObject({ code: 'CREATOR_REQUIRED', status: 403, detail: 'Only creators can do this.' })
    expect(chatHooksAvailable()).toBe(true)
  })

  it('prefs: a GET with the workspace, parsed', async () => {
    const f = fake(() => ({
      status: 200,
      json: {
        hooks: [{ id: HOOK, name: '#a', provider: 'slack', disabled: false }],
        prefs: [{ hookId: HOOK, kinds: ['mention'] }],
      },
    }))
    const out = await getChatPrefs(W, { api: f.api })
    expect(out.prefs[0]?.kinds).toEqual(['mention'])
    expect(f.seen[0]?.url).toBe(`/api/me/chat-prefs?workspace=${W}`)
  })

  it('an answer that is not the contract’s is a failure, not a guess', async () => {
    const f = fake(() => ({ status: 200, json: { hooks: [{ id: 'nope' }] } }))
    const e = await listChatHooks(W, { api: f.api }).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'BAD_RESPONSE' })
  })
})

describe('writes', () => {
  it('create sends the URL once, in the body, and gets the hint back', async () => {
    const f = fake(() => ({ status: 201, json: hook() }))
    const made = await createChatHook(
      W,
      { name: '#lobby-pitches', provider: 'slack', url: URL_TEXT, includeSnippets: false },
      { api: f.api },
    )
    expect(made.hint).toBe('hooks.slack.com/…/•••1234')
    expect(f.seen[0]).toMatchObject({ method: 'POST', url: `/api/workspaces/${W}/chat-hooks` })
    expect((f.seen[0]?.body as { url: string } | undefined)?.url).toBe(URL_TEXT)
    expect(JSON.stringify(made)).not.toContain('abcdEFGH1234')
    expect(f.seen[0]?.url).not.toContain('abcdEFGH1234')
  })

  it('a refused URL rejects with the api’s code and message', async () => {
    const f = fake(() => err(400, 'CHAT_HOOK_URL_INVALID', 'That is not a Slack incoming-webhook URL.'))
    const e = await createChatHook(
      W,
      { name: '#x', provider: 'slack', url: 'https://example.com', includeSnippets: false },
      { api: f.api },
    ).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'CHAT_HOOK_URL_INVALID', status: 400 })
    expect(JSON.stringify(e)).not.toContain('example.com')
  })

  it('patch, delete, test and put use the contract’s paths and verbs', async () => {
    const f = fake((s) => {
      if (s.method === 'DELETE') return { status: 204 }
      if (s.url.endsWith('/test')) return { status: 200, json: { status: 'sent', code: null } }
      if (s.url.startsWith('/api/me/')) return { status: 200, json: { hooks: [], prefs: [] } }
      return { status: 200, json: hook({ name: '#renamed' }) }
    })
    expect((await patchChatHook(W, HOOK, { name: '#renamed' }, { api: f.api })).name).toBe('#renamed')
    await deleteChatHook(W, HOOK, { api: f.api })
    expect(await testChatHook(W, HOOK, { api: f.api })).toEqual({ status: 'sent', code: null })
    await putChatPrefs(
      { workspaceId: W, prefs: [{ hookId: HOOK, kinds: ['mention', 'reply'] }] },
      { api: f.api },
    )
    expect(f.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `PATCH /api/workspaces/${W}/chat-hooks/${HOOK}`,
      `DELETE /api/workspaces/${W}/chat-hooks/${HOOK}`,
      `POST /api/workspaces/${W}/chat-hooks/${HOOK}/test`,
      'PUT /api/me/chat-prefs',
    ])
  })

  it('once the routes are known to be off, a write rejects "unavailable" without a request', async () => {
    const f = fake(() => err(404, 'CHAT_HOOKS_OFF'))
    await listChatHooks(W, { api: f.api })
    const e = await testChatHook(W, HOOK, { api: f.api }).catch((x: unknown) => x)
    expect(e).toMatchObject({ code: 'unavailable' })
    expect(f.seen).toHaveLength(1)
  })

  it('a write answered CHAT_HOOKS_OFF turns the feature off', async () => {
    const f = fake(() => err(404, 'CHAT_HOOKS_OFF'))
    await deleteChatHook(W, HOOK, { api: f.api }).catch(() => {})
    expect(chatHooksAvailable()).toBe(false)
  })

  it('no connection at all rejects with the api client’s network code', async () => {
    const api = createApiClient({
      fetchImpl: (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch,
    })
    const e = await testChatHook(W, HOOK, { api }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ChatHookRequestError)
    expect((e as ChatHookRequestError).code).toBe('NETWORK')
  })
})
