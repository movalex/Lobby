// The egress rules of wave R's two reviewed exceptions (AGENTS.md "Server egress exception: …"), built from the
// contracts that define them, so a host or path changes in exactly one reviewed place:
//   - MIRO_API_RULE: https://api.miro.com, GET, the read paths of MIRO_API_PATH_PATTERNS, Bearer allowed (the person's
//     token, for that job only); no other rule ever takes a Bearer secret.
//   - MIRO_FILE_RULE: the hosts of MIRO_DOWNLOAD_HOSTS (none until the owner-run probe fills it: every file refused),
//     GET, no Bearer, and only while the signed URL's `Expires` (epoch seconds) is in the future.
//   - SLACK_HOOK_RULE, TEAMS_HOOK_RULE: the webhook hosts and paths of CHAT_HOOK_RULES, POST only, no Bearer, and
//     exactly the provider's query keys (the route checked the whole URL with checkChatHookUrl when it was saved).
// OWNER: the wave R foundation (the lead): WS1 and WS2 use these, and change them only through the contracts.

import {
  CHAT_HOOK_RULES,
  type ChatHookProvider,
  MIRO_API_HOST,
  MIRO_API_PATH_PATTERNS,
  MIRO_DOWNLOAD_HOSTS,
} from '@draftroom/contracts'
import { type EgressPolicy, type HostRule, makeEgressPolicy } from './policy.ts'

/** What the api says it is, toward Miro and toward a webhook (no version, no host name). */
export const MIRO_EGRESS_USER_AGENT = 'LobbyImport/1.0'
export const CHAT_HOOK_EGRESS_USER_AGENT = 'LobbyNotify/1.0'

export const MIRO_API_RULE: HostRule = {
  id: 'miro-api',
  host: MIRO_API_HOST,
  paths: MIRO_API_PATH_PATTERNS,
  methods: ['GET'],
  bearer: true,
}

/** A signed download URL is fetched only before its `Expires` (CloudFront style, epoch seconds), named once. */
export function signedUrlLive(url: URL, now: number): boolean {
  const raw = url.searchParams.getAll('Expires')
  if (raw.length !== 1 || !/^\d{9,11}$/.test(raw[0] ?? '')) return false
  return Number(raw[0]) * 1000 > now
}

export const MIRO_FILE_RULE: HostRule = {
  id: 'miro-files',
  host: MIRO_DOWNLOAD_HOSTS,
  paths: [/^\/[^?#]{1,1024}$/],
  methods: ['GET'],
  bearer: false,
  check: signedUrlLive,
}

function hookRule(provider: ChatHookProvider): HostRule {
  const rule = CHAT_HOOK_RULES.find((r) => r.provider === provider)
  if (!rule) throw new Error(`no chat hook rule for ${provider}`)
  return {
    id: provider,
    host: rule.host,
    paths: [rule.path],
    methods: ['POST'],
    bearer: false,
    check: (url) => {
      const keys = [...url.searchParams.keys()]
      return (
        keys.length === rule.query.length &&
        new Set(keys).size === keys.length &&
        rule.query.every((k) => (url.searchParams.get(k) ?? '') !== '')
      )
    },
  }
}
export const SLACK_HOOK_RULE = hookRule('slack')
export const TEAMS_HOOK_RULE = hookRule('teams')

/** The Miro import's policy: its API and its files, plus the fake server's origins behind the local-dev guard. */
export function miroEgressPolicy(test: { api: string; files: string | null } | null): EgressPolicy {
  const seam: [string, string][] = []
  if (test) {
    seam.push([test.api, MIRO_API_RULE.id])
    if (test.files) seam.push([test.files, MIRO_FILE_RULE.id])
  }
  return makeEgressPolicy([MIRO_API_RULE, MIRO_FILE_RULE], seam)
}

/** The chat notifications' policy: Slack's and Teams' webhooks, plus the fake receiver behind the local-dev guard. */
export function chatHookEgressPolicy(test: { slack: string; teams: string | null } | null): EgressPolicy {
  const seam: [string, string][] = []
  if (test) {
    seam.push([test.slack, SLACK_HOOK_RULE.id])
    if (test.teams) seam.push([test.teams, TEAMS_HOOK_RULE.id])
  }
  return makeEgressPolicy([SLACK_HOOK_RULE, TEAMS_HOOK_RULE], seam)
}
