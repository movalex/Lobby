// A person's own chat choices (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.1, §4.4): everything is off until they turn
// a kind on for a hook; the whole choice for a workspace is replaced at once; they go with the person's membership
// and with the hook; and a person never reads or changes another's.

import { ChatPrefsResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEV_STUDIO } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { type ChatWorld, chatWorld, optIn, slackHookUrl } from './support.ts'

const PREFS = `/api/me/chat-prefs?workspace=${DEV_STUDIO}`

let w: ChatWorld
beforeEach(async () => {
  w = await chatWorld()
})
afterEach(() => w.close())

const get = async (c: ChatWorld['ben']) => ChatPrefsResponse.parse((await c.req('GET', PREFS)).json())

describe('reading the choices', () => {
  it('lists the hooks by name and provider (no hint, no URL) and starts with every kind off', async () => {
    const prefs = await get(w.ben)
    expect(prefs).toEqual({
      hooks: [{ id: w.hookId, name: '#lobby-pitches', provider: 'slack', disabled: false }],
      prefs: [],
    })
    expect(JSON.stringify(prefs)).not.toContain('hooks.slack.com')
  })

  it('shows that a hook is switched off', async () => {
    await w.api.db.query(
      "UPDATE chat_hooks SET disabled_at = now(), disabled_reason = 'gone' WHERE id = $1",
      [w.hookId],
    )
    expect((await get(w.ben)).hooks[0]?.disabled).toBe(true)
  })

  it('needs a workspace query', async () => {
    expect((await w.ben.req('GET', '/api/me/chat-prefs')).statusCode).toBe(400)
    expect((await w.ben.req('GET', '/api/me/chat-prefs?workspace=nope')).statusCode).toBe(400)
  })
})

describe('setting the choices', () => {
  it('stores kinds per hook, returns them in the contract’s order, and keeps each person’s own', async () => {
    const mine = await optIn(w.ben, w.hookId, ['reply', 'mention'])
    expect(mine.prefs).toEqual([{ hookId: w.hookId, kinds: ['mention', 'reply'] }])
    expect((await get(w.owner)).prefs).toEqual([])
    await optIn(w.owner, w.hookId, ['access_request'])
    expect((await get(w.ben)).prefs).toEqual([{ hookId: w.hookId, kinds: ['mention', 'reply'] }])
    expect((await get(w.owner)).prefs).toEqual([{ hookId: w.hookId, kinds: ['access_request'] }])
  })

  it('replaces the whole choice: no kinds, or a hook left out, turns it off', async () => {
    const second = await w.owner.req('POST', `/api/workspaces/${DEV_STUDIO}/chat-hooks`, {
      name: '#two',
      provider: 'slack',
      url: slackHookUrl(w.receiver.origin, 'secondHOOK12'),
    })
    const secondId = second.json().id as string
    const both = await w.ben.req('PUT', '/api/me/chat-prefs', {
      workspaceId: DEV_STUDIO,
      prefs: [
        { hookId: w.hookId, kinds: ['mention'] },
        { hookId: secondId, kinds: ['new_comment', 'reply'] },
      ],
    })
    expect(both.statusCode).toBe(200)
    expect((await get(w.ben)).prefs).toHaveLength(2)
    const left = await w.ben.req('PUT', '/api/me/chat-prefs', {
      workspaceId: DEV_STUDIO,
      prefs: [{ hookId: secondId, kinds: [] }],
    })
    expect(left.statusCode).toBe(200)
    expect((await get(w.ben)).prefs).toEqual([])
    expect((await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM chat_hook_prefs')).n).toBe(0)
  })

  it('refuses a hook of another workspace or none at all, and kinds a person cannot send', async () => {
    const put = (prefs: unknown) => w.ben.req('PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs })
    expect((await put([{ hookId: 'chk_0123456789abcdefghij', kinds: ['mention'] }])).statusCode).toBe(400)
    expect((await put([{ hookId: w.hookId, kinds: ['resolved'] }])).statusCode).toBe(400)
    expect((await put([{ hookId: w.hookId, kinds: ['access_granted'] }])).statusCode).toBe(400)
    expect((await put([{ hookId: w.hookId, kinds: ['mention', 'mention'] }])).statusCode).toBe(400)
    expect(
      (
        await put([
          { hookId: w.hookId, kinds: ['mention'] },
          { hookId: w.hookId, kinds: ['reply'] },
        ])
      ).statusCode,
    ).toBe(400)
    expect((await w.ben.req('PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs: [], x: 1 })).statusCode).toBe(
      400,
    )
    // a hook of another workspace (one the person has no part in) is a 400 too
    const elsewhere = await w.erin.req('POST', `/api/workspaces/${w.erin.personalWorkspaceId}/chat-hooks`, {
      name: '#mine',
      provider: 'slack',
      url: slackHookUrl(w.receiver.origin, 'erinsHOOK123'),
    })
    expect(elsewhere.statusCode).toBe(201)
    expect((await put([{ hookId: elsewhere.json().id, kinds: ['mention'] }])).statusCode).toBe(400)
    expect((await get(w.ben)).prefs).toEqual([])
  })
})

describe('who may have choices', () => {
  it('a stranger to the workspace gets 404, nobody signed in 401', async () => {
    expect((await w.erin.req('GET', PREFS)).statusCode).toBe(404)
    expect(
      (await w.erin.req('PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs: [] })).statusCode,
    ).toBe(404)
    expect((await w.api.anon('GET', PREFS)).statusCode).toBe(401)
  })

  it('a workspace guest (a review-link visitor with an account) is not shown the team’s channels (403)', async () => {
    await w.api.db.query("UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2", [
      DEV_STUDIO,
      w.ben.userId,
    ])
    expect((await w.ben.req('GET', PREFS)).statusCode).toBe(403)
    expect(
      (await w.ben.req('PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs: [] })).statusCode,
    ).toBe(403)
  })

  it('a name-only guest is refused (GUEST_ACCOUNT_REQUIRED)', async () => {
    const link = await guestLink(w.owner, w.boardId, { role: 'commenter' })
    const dana = await joinAsGuest(w.api, link.url, 'Dana Whitfield')
    for (const [method, url, body] of [
      ['GET', PREFS, undefined],
      ['PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs: [] }],
    ] as const) {
      const res = await dana.req(method, url, body)
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('GUEST_ACCOUNT_REQUIRED')
    }
  })
})

describe('what a choice goes with', () => {
  it('leaves with the person’s membership of the workspace', async () => {
    await optIn(w.ben, w.hookId, ['mention'])
    await w.api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      DEV_STUDIO,
      w.ben.userId,
    ])
    expect((await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM chat_hook_prefs')).n).toBe(0)
  })

  it('leaves with the hook', async () => {
    await optIn(w.ben, w.hookId, ['mention'])
    await w.owner.req('DELETE', `/api/workspaces/${DEV_STUDIO}/chat-hooks/${w.hookId}`)
    expect((await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM chat_hook_prefs')).n).toBe(0)
    expect((await get(w.ben)).hooks).toEqual([])
  })
})
