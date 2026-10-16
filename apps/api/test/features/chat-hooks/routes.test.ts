// The chat hook routes (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.1-§4.3): off without the secret, who may manage hooks,
// the URL rules at the door, the cap, change and removal, the test message, and the one thing that matters most: the
// URL leaves the server nowhere (no response, no audit row, no log line), and what is stored is sealed to its row.

import {
  CHAT_HOOK_LIMITS,
  type ChatHook,
  ListChatHooksResponse,
  TestChatHookResponse,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretBox } from '../../../src/crypto/sealed.ts'
import { DEV_STUDIO } from '../../helpers.ts'
import { type ChatWorld, chatWorld, slackHookUrl, slackText, statuses, WEBHOOK_SECRET } from './support.ts'

const HOOKS = `/api/workspaces/${DEV_STUDIO}/chat-hooks`

describe('hooks are off without DRAFTROOM_WEBHOOK_SECRET', () => {
  let w: ChatWorld
  beforeEach(async () => {
    w = await chatWorld({ secret: null })
  })
  afterEach(() => w.close())

  it('every route answers 404 CHAT_HOOKS_OFF, for the owner too', async () => {
    const hid = 'chk_0123456789abcdefghij'
    const calls: [string, string, unknown?][] = [
      ['GET', HOOKS],
      ['POST', HOOKS, { name: '#a', provider: 'slack', url: slackHookUrl(w.receiver.origin) }],
      ['PATCH', `${HOOKS}/${hid}`, { name: '#b' }],
      ['DELETE', `${HOOKS}/${hid}`],
      ['POST', `${HOOKS}/${hid}/test`, {}],
      ['GET', `/api/me/chat-prefs?workspace=${DEV_STUDIO}`],
      ['PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs: [] }],
    ]
    for (const [method, url, body] of calls) {
      const res = await w.owner.req(method as 'GET', url, body)
      expect({ url, status: res.statusCode, code: res.json().error?.code }).toEqual({
        url,
        status: 404,
        code: 'CHAT_HOOKS_OFF',
      })
    }
  })

  it('sends nothing: a queued row is never claimed or posted (a pass only purges)', async () => {
    await w.api.db.query(
      `INSERT INTO chat_hooks (id, workspace_id, name, provider, url_sealed, key_id, url_hint)
       VALUES ('chk_0123456789abcdefghij', $1, 'x', 'slack', $2, 'k1', 'hooks.slack.com/…')`,
      [DEV_STUDIO, Buffer.alloc(40, 1)],
    )
    await w.api.db.query(
      "INSERT INTO chat_deliveries (hook_id, recipient_id) VALUES ('chk_0123456789abcdefghij', $1)",
      [w.owner.userId],
    )
    const result = await w.tick()
    expect(result.claimed).toBe(0)
    expect(await statuses(w.api)).toEqual(['queued'])
    expect(w.receiver.posts).toEqual([])
  })
})

describe('who may manage hooks', () => {
  let w: ChatWorld
  beforeEach(async () => {
    w = await chatWorld()
  })
  afterEach(() => w.close())

  const add = (c: ChatWorld['owner'], wid = DEV_STUDIO) =>
    c.req('POST', `/api/workspaces/${wid}/chat-hooks`, {
      name: '#more',
      provider: 'slack',
      url: slackHookUrl(w.receiver.origin, 'zzzzYYYY9999'),
    })

  it('an owner who is a creator lists and adds; the list shows the hint, who added it and the state', async () => {
    const list = ListChatHooksResponse.parse((await w.owner.req('GET', HOOKS)).json())
    expect(list.hooks).toHaveLength(1)
    expect(list.hooks[0]).toMatchObject({
      id: w.hookId,
      name: '#lobby-pitches',
      provider: 'slack',
      hint: 'hooks.slack.com/…/•••1234',
      includeSnippets: false,
      createdBy: { id: w.owner.userId, name: 'Olive Owner' },
      disabledAt: null,
      disabledReason: null,
      lastOkAt: null,
      lastErrorCode: null,
    })
    expect((await add(w.owner)).statusCode).toBe(201)
  })

  it('an admin who is not a creator is refused to list, add, change and test (403 CREATOR_REQUIRED), by the guard and by the route', async () => {
    for (const [method, url, body] of [
      ['GET', HOOKS, undefined],
      ['POST', HOOKS, { name: '#x', provider: 'slack', url: w.hookUrl }],
      ['PATCH', `${HOOKS}/${w.hookId}`, { name: '#x' }],
      ['POST', `${HOOKS}/${w.hookId}/test`, {}],
    ] as const) {
      const res = await w.pat.req(method, url, body)
      expect({ method, status: res.statusCode, code: res.json().error?.code }).toEqual({
        method,
        status: 403,
        code: 'CREATOR_REQUIRED',
      })
    }
    expect(w.receiver.posts).toEqual([])
    expect((await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM chat_hooks')).n).toBe(1)
  })

  it('a member is refused (403), a stranger sees nothing (404), nobody signed in gets 401', async () => {
    expect((await w.sam.req('GET', HOOKS)).statusCode).toBe(403)
    expect(
      (await w.ben.req('POST', HOOKS, { name: '#x', provider: 'slack', url: w.hookUrl })).statusCode,
    ).toBe(403)
    expect((await w.ben.req('DELETE', `${HOOKS}/${w.hookId}`)).statusCode).toBe(403)
    expect((await w.erin.req('GET', HOOKS)).statusCode).toBe(404)
    expect((await add(w.erin)).statusCode).toBe(404)
    expect((await w.erin.req('DELETE', `${HOOKS}/${w.hookId}`)).statusCode).toBe(404)
    expect((await w.api.anon('GET', HOOKS)).statusCode).toBe(401)
  })

  it('removing is lowering: an admin who is not a creator may delete (204), and the hook is gone with its prefs and rows', async () => {
    const put = await w.ben.req('PUT', '/api/me/chat-prefs', {
      workspaceId: DEV_STUDIO,
      prefs: [{ hookId: w.hookId, kinds: ['mention'] }],
    })
    expect(put.statusCode).toBe(200)
    expect((await w.pat.req('DELETE', `${HOOKS}/${w.hookId}`)).statusCode).toBe(204)
    const n = async (t: string) =>
      (await w.api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).n
    expect([await n('chat_hooks'), await n('chat_hook_prefs')]).toEqual([0, 0])
    expect((await w.owner.req('DELETE', `${HOOKS}/${w.hookId}`)).statusCode).toBe(404)
    const audit = await w.api.db.query<{ action: string; detail: unknown }>(
      "SELECT action, detail FROM audit_events WHERE action LIKE 'chat_hook.%' ORDER BY id",
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['chat_hook.create', 'chat_hook.delete'])
  })
})

describe('adding and changing a hook', () => {
  let w: ChatWorld
  beforeEach(async () => {
    w = await chatWorld()
  })
  afterEach(() => w.close())

  const body = (url: string, extra: Record<string, unknown> = {}) => ({
    name: '#other',
    provider: 'slack',
    url,
    ...extra,
  })

  it('refuses what is not a Slack or Teams URL, with a message that never repeats it', async () => {
    const bad = [
      'https://hooks.slack.com.evil.com/services/T1/B1/abc',
      'https://hooks.slack.com@evil.example/services/T1/B1/abc',
      'http://hooks.slack.com/services/T1/B1/abc',
      'https://hooks.slack.com:8443/services/T1/B1/abc',
      'https://HOOKS.SLACK.COM./services/T1/B1/abc',
      'https://127.0.0.1/services/T1/B1/abc',
      'https://hooks.slack.com/services/T1/B1/abc?x=1',
      'https://hooks.slack.com/triggers/T1/B1/abc',
      'https://example.com/hook',
      'not a url',
      '',
    ]
    for (const url of bad) {
      const res = await w.owner.req('POST', HOOKS, body(url))
      expect({ url, status: res.statusCode, code: res.json().error?.code }).toEqual({
        url,
        status: 400,
        code: 'CHAT_HOOK_URL_INVALID',
      })
      expect(res.body).not.toContain(url || 'never-empty')
    }
    // a Teams URL is not a Slack hook
    const teams =
      'https://x.y1.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/ab12/triggers/manual/paths/invoke?api-version=1&sp=s&sv=1&sig=SECRETSIG'
    const wrong = await w.owner.req('POST', HOOKS, body(teams))
    expect(wrong.statusCode).toBe(400)
    expect(wrong.body).not.toContain('SECRETSIG')
    expect((await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM chat_hooks')).n).toBe(1)
  })

  it('says what to use instead of Microsoft’s retired addresses (CHAT_HOOK_URL_RETIRED)', async () => {
    for (const url of [
      'https://contoso.webhook.office.com/webhookb2/aaaa/IncomingWebhook/bbbb/cccc',
      'https://outlook.office.com/webhook/aaaa/IncomingWebhook/bbbb',
      'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=xyz',
    ]) {
      const res = await w.owner.req('POST', HOOKS, { name: '#t', provider: 'teams', url })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('CHAT_HOOK_URL_RETIRED')
      expect(res.json().error.message).toMatch(/Workflows/)
    }
  })

  it('holds at most 20 hooks per workspace (409 CHAT_HOOKS_FULL)', async () => {
    for (let i = 1; i < CHAT_HOOK_LIMITS.hooksPerWorkspace; i++)
      expect(
        (await w.owner.req('POST', HOOKS, body(slackHookUrl(w.receiver.origin, `hook${i}ABCDEF`))))
          .statusCode,
      ).toBe(201)
    const full = await w.owner.req('POST', HOOKS, body(slackHookUrl(w.receiver.origin, 'oneTooMany12')))
    expect(full.statusCode).toBe(409)
    expect(full.json().error.code).toBe('CHAT_HOOKS_FULL')
  })

  it('validates the body (a name, a provider, no stray keys)', async () => {
    for (const bad of [
      {},
      { name: '', provider: 'slack', url: w.hookUrl },
      { ...body(w.hookUrl), extra: 1 },
    ]) {
      expect((await w.owner.req('POST', HOOKS, bad)).statusCode).toBe(400)
    }
    expect((await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, {})).statusCode).toBe(400)
    expect((await w.owner.req('PATCH', `${HOOKS}/nope`, { name: 'x' })).statusCode).toBe(404)
  })

  it('renames, switches snippets on, and replaces the URL (checked for the same provider, a new hint)', async () => {
    const renamed = await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, {
      name: '  #renamed  ',
      includeSnippets: true,
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ name: '#renamed', includeSnippets: true })
    const moved = await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, {
      url: slackHookUrl(w.receiver.origin, 'brandNEW5678'),
    })
    expect((moved.json() as ChatHook).hint).toBe('hooks.slack.com/…/•••5678')
    const bad = await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, { url: 'https://example.com/x' })
    expect(bad.statusCode).toBe(400)
    // the hook still posts to the new address
    await w.owner.req('POST', `${HOOKS}/${w.hookId}/test`, {})
    expect(w.receiver.posts.map((p) => p.path)).toEqual(['/services/T0000000A/B0000000B/brandNEW5678'])
  })

  it('"enabled: true" turns a hook a delivery switched off back on; nothing else does', async () => {
    await w.api.db.query(
      "UPDATE chat_hooks SET disabled_at = now(), disabled_reason = 'not-found', last_error_code = '404' WHERE id = $1",
      [w.hookId],
    )
    const renamed = await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, { name: '#still-off' })
    expect((renamed.json() as ChatHook).disabledReason).toBe('not-found')
    const on = await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, { enabled: true })
    expect(on.json()).toMatchObject({ disabledAt: null, disabledReason: null, lastErrorCode: null })
    expect((await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, { enabled: false })).statusCode).toBe(400)
  })
})

describe('the test message', () => {
  let w: ChatWorld
  beforeEach(async () => {
    w = await chatWorld()
  })
  afterEach(() => w.close())

  it('posts one Slack message to the receiver and says "sent"; the hook remembers when', async () => {
    const res = await w.owner.req('POST', `${HOOKS}/${w.hookId}/test`, {})
    expect(res.statusCode).toBe(200)
    expect(TestChatHookResponse.parse(res.json())).toEqual({ status: 'sent', code: null })
    expect(w.receiver.posts).toHaveLength(1)
    const post = w.receiver.posts[0]
    expect(post?.method).toBe('POST')
    expect(post?.path).toBe('/services/T0000000A/B0000000B/abcdEFGH1234')
    expect(post?.body).toMatchObject({ unfurl_links: false, unfurl_media: false })
    expect(slackText(post?.body ?? null)).toContain('Olive Owner is testing Lobby notifications')
    const hook = ListChatHooksResponse.parse((await w.owner.req('GET', HOOKS)).json()).hooks[0]
    expect(hook?.lastOkAt).not.toBeNull()
  })

  it('reports a failure by its code only, and remembers it', async () => {
    w.receiver.next({ status: 500, body: 'a secret word from the receiver' })
    const res = await w.owner.req('POST', `${HOOKS}/${w.hookId}/test`, {})
    expect(res.json()).toEqual({ status: 'failed', code: '500' })
    expect(res.body).not.toContain('secret word')
    const hook = ListChatHooksResponse.parse((await w.owner.req('GET', HOOKS)).json()).hooks[0]
    expect(hook?.lastErrorCode).toBe('500')
  })

  it('is rate limited per person (429 after 10 a minute)', async () => {
    for (let i = 0; i < 10; i++)
      expect((await w.owner.req('POST', `${HOOKS}/${w.hookId}/test`, {})).statusCode).toBe(200)
    expect((await w.owner.req('POST', `${HOOKS}/${w.hookId}/test`, {})).statusCode).toBe(429)
  })

  it('a sealed URL that does not open (another row’s, or another key’s) fails with "unsealed" and posts nothing', async () => {
    const other = await w.owner.req('POST', HOOKS, {
      name: '#second',
      provider: 'slack',
      url: slackHookUrl(w.receiver.origin, 'secondHOOK12'),
    })
    const secondId = (other.json() as ChatHook).id
    // the first hook's ciphertext moved onto the second row: the row's identity is part of what was sealed
    await w.api.db.query(
      'UPDATE chat_hooks SET url_sealed = (SELECT url_sealed FROM chat_hooks WHERE id = $1) WHERE id = $2',
      [w.hookId, secondId],
    )
    const res = await w.owner.req('POST', `${HOOKS}/${secondId}/test`, {})
    expect(res.json()).toEqual({ status: 'failed', code: 'unsealed' })
    expect(w.receiver.posts).toEqual([])
  })
})

describe('the URL is a secret', () => {
  let w: ChatWorld
  let logs: string[]
  beforeEach(async () => {
    logs = []
    w = await chatWorld({ logs })
  })
  afterEach(() => w.close())

  it('is stored sealed, bound to its row and key, and opens only with the secret', async () => {
    const row = await w.api.db.one<{ url_sealed: Uint8Array; key_id: string; url_hint: string }>(
      'SELECT url_sealed, key_id, url_hint FROM chat_hooks WHERE id = $1',
      [w.hookId],
    )
    const stored = Buffer.from(row.url_sealed)
    expect(stored.includes(Buffer.from('hooks'))).toBe(false)
    expect(stored.includes(Buffer.from('abcdEFGH1234'))).toBe(false)
    const box = createSecretBox({ current: WEBHOOK_SECRET, previous: null })
    expect(box?.open(stored, row.key_id, `${DEV_STUDIO}:${w.hookId}`).value).toBe(w.hookUrl)
    expect(() => box?.open(stored, row.key_id, `${DEV_STUDIO}:chk_other0000000000`)).toThrow()
    expect(row.url_hint).toBe('hooks.slack.com/…/•••1234')
  })

  it('never appears in an answer, an audit row, or what the receiver is told of the hook', async () => {
    const secretPart = 'abcdEFGH1234'
    const answers = [
      await w.owner.req('GET', HOOKS),
      await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, { name: '#again' }),
      await w.owner.req('POST', `${HOOKS}/${w.hookId}/test`, {}),
      await w.owner.req('POST', HOOKS, { name: '#bad', provider: 'slack', url: `${w.hookUrl}?x=1` }),
      await w.ben.req('GET', `/api/me/chat-prefs?workspace=${DEV_STUDIO}`),
    ]
    for (const res of answers) {
      expect(res.body).not.toContain(secretPart)
      expect(res.body).not.toContain(w.receiver.origin)
      expect(JSON.stringify(res.headers)).not.toContain(secretPart)
    }
    const audits = await w.api.db.query('SELECT detail, target FROM audit_events')
    expect(JSON.stringify(audits.rows)).not.toContain(secretPart)
    expect(JSON.stringify(audits.rows)).not.toContain(w.receiver.origin)
    // the receiver's own path is its business; the message itself carries no URL of the hook
    expect(w.receiver.posts[0]?.raw).not.toContain(secretPart)
    const logged = logs.join('\n')
    expect(logged.length).toBeGreaterThan(0)
    expect(logged).not.toContain(secretPart)
    expect(logged).not.toContain(w.receiver.origin)
  })
})
