// Rotating DRAFTROOM_WEBHOOK_SECRET (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.3): the new key with the old one as
// DRAFTROOM_WEBHOOK_SECRET_PREVIOUS opens every sealed URL and, when the api starts, seals each again under the new key;
// afterwards the old key can go. A key that was lost opens nothing: the hook fails by its code ("unsealed") and posts nothing.

import { afterEach, describe, expect, it } from 'vitest'
import { chatDeliveryOf } from '../../../src/features/chat-hooks/index.ts'
import { createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type ChatWorld, chatWorld, OTHER_SECRET, WEBHOOK_SECRET } from './support.ts'

const THIRD = 'test-third-webhook-secret-0123456789abcde'
let w: ChatWorld
const extra: TestApi[] = []
afterEach(async () => {
  for (const a of extra.splice(0)) await a.close()
  await w?.close()
})

/** Another api over the same database, with these secrets. */
async function apiWith(current: string, previous?: string): Promise<TestApi> {
  const api = await createTestApi({
    db: w.api.db,
    env: {
      DRAFTROOM_WEBHOOK_SECRET: current,
      ...(previous ? { DRAFTROOM_WEBHOOK_SECRET_PREVIOUS: previous } : {}),
      DRAFTROOM_CHAT_HOOK_TEST_ORIGINS: w.receiver.origin,
    },
  })
  chatDeliveryOf(api.app)?.stop()
  extra.push(api)
  return api
}

const keyOf = async () =>
  (await w.api.db.one<{ key_id: string }>('SELECT key_id FROM chat_hooks WHERE id = $1', [w.hookId])).key_id

describe('rotating the webhook secret', () => {
  it('seals a hook again under the new key at start-up, and the old key can then go', async () => {
    w = await chatWorld()
    const before = await keyOf()
    // the sealed bytes are bound to the key: another secret alone opens nothing
    const lost = await apiWith(THIRD)
    const lostLogin = await lost.login('owner')
    const failed = await lostLogin.req('POST', `/api/workspaces/${DEV_STUDIO}/chat-hooks/${w.hookId}/test`, {})
    expect(failed.json()).toEqual({ status: 'failed', code: 'unsealed' })
    expect(w.receiver.posts).toEqual([])

    const rotated = await apiWith(OTHER_SECRET, WEBHOOK_SECRET)
    expect(await keyOf()).not.toBe(before)
    const login = await rotated.login('owner')
    const sent = await login.req('POST', `/api/workspaces/${DEV_STUDIO}/chat-hooks/${w.hookId}/test`, {})
    expect(sent.json()).toEqual({ status: 'sent', code: null })

    // the previous key is gone: the hook opens with the new one alone
    const after = await apiWith(OTHER_SECRET)
    const again = await (await after.login('owner')).req(
      'POST',
      `/api/workspaces/${DEV_STUDIO}/chat-hooks/${w.hookId}/test`,
      {},
    )
    expect(again.json()).toEqual({ status: 'sent', code: null })
    expect(w.receiver.posts).toHaveLength(2)
  })
})
