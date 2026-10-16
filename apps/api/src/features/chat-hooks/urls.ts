// The URL check a hook goes through when it is saved (wave R, WS2; contracts chat-hooks.ts checkChatHookUrl), plus the
// local-dev seam: with DRAFTROOM_CHAT_HOOK_TEST_ORIGINS (devAuth only, never production: config.ts) a URL on the fake
// receiver's exact origin is accepted for the provider that origin stands for, after the provider's own path and query
// rules. Nothing else changes: a real address is always judged by CHAT_HOOK_RULES alone.

import {
  CHAT_HOOK_CODES,
  CHAT_HOOK_RULES,
  type ChatHookProvider,
  type ChatHookUrlCheck,
  chatHookHint,
  checkChatHookUrl,
} from '@draftroom/contracts'
import type { ApiConfig } from '../../config.ts'

const INVALID =
  'That is not a Slack incoming-webhook URL (https://hooks.slack.com/services/…) or a Teams Workflows URL.'

function seamCheck(
  raw: string,
  provider: ChatHookProvider | undefined,
  test: NonNullable<ApiConfig['chatHookTestOrigins']>,
): ChatHookUrlCheck | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const stands: ChatHookProvider | null =
    url.origin === test.slack ? 'slack' : test.teams !== null && url.origin === test.teams ? 'teams' : null
  if (!stands) return null
  const bad = { ok: false as const, code: CHAT_HOOK_CODES.urlInvalid, message: INVALID }
  const rule = CHAT_HOOK_RULES.find((r) => r.provider === stands)
  if (!rule || (provider && provider !== stands) || url.username || url.password || url.hash) return bad
  if (!rule.path.test(url.pathname)) return bad
  const keys = [...url.searchParams.keys()]
  if (keys.length !== rule.query.length || new Set(keys).size !== keys.length) return bad
  if (!rule.query.every((k) => (url.searchParams.get(k) ?? '') !== '')) return bad
  return { ok: true, provider: stands, url, hint: chatHookHint(stands, url) }
}

/** Whether `raw` is a hook URL for `provider` (any when omitted): the contract's rules, plus the dev seam. */
export function checkHookUrl(
  raw: unknown,
  provider: ChatHookProvider | undefined,
  test: ApiConfig['chatHookTestOrigins'],
): ChatHookUrlCheck {
  const real = checkChatHookUrl(raw, provider)
  if (real.ok || !test || typeof raw !== 'string') return real
  return seamCheck(raw, provider, test) ?? real
}
