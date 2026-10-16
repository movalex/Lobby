// The egress policy (wave R foundation; src/egress/policy.ts and rules.ts): which outbound requests a rule allows,
// checked before anything is resolved. The Miro and chat hook rules come from the contracts.
import { MIRO_DOWNLOAD_HOSTS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  chatHookEgressPolicy,
  checkTarget,
  type EgressPolicy,
  makeEgressPolicy,
  MIRO_API_RULE,
  MIRO_FILE_RULE,
  miroEgressPolicy,
  signedUrlLive,
} from '../../src/egress/index.ts'

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
const SLACK = 'https://hooks.slack.com/services/T0001ABCD/B0002EFGH/abcdefGHIJKL1234mnopWXYZ'
const TEAMS =
  'https://default1234abcd.ab.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=SIG9876'

const allowed = (policy: EgressPolicy, url: string, method: 'GET' | 'POST' = 'GET', bearer = false) => {
  const t = checkTarget(url, method, bearer, policy, NOW)
  return typeof t === 'string' ? t : t.rule.id
}

describe('the Miro policy', () => {
  const miro = miroEgressPolicy(null)

  it('api.miro.com: the read paths, GET, with the Bearer token; nothing else', () => {
    expect(allowed(miro, 'https://api.miro.com/v2/boards?limit=50', 'GET', true)).toBe('miro-api')
    expect(allowed(miro, 'https://api.miro.com/v1/oauth-token', 'GET', true)).toBe('miro-api')
    const items = 'https://API.MIRO.COM/v2/boards/uXjVOD1Ab2c=/items?cursor=x'
    expect(allowed(miro, items, 'GET', true)).toBe('miro-api')
    expect(allowed(miro, 'https://api.miro.com:443/v2/boards', 'GET', true)).toBe('miro-api')
    expect(allowed(miro, 'https://api.miro.com/v2/boards', 'POST', true)).toBe('method')
    expect(allowed(miro, 'https://api.miro.com/v2/boards/uXjVOD1Ab2c=/share', 'GET', true)).toBe('path')
    const mindmap = 'https://api.miro.com/v2-experimental/boards/x/mindmap_nodes'
    expect(allowed(miro, mindmap, 'GET', true)).toBe('path')
    expect(allowed(miro, 'http://api.miro.com/v2/boards', 'GET', true)).toBe('scheme')
    expect(allowed(miro, 'https://api.miro.com:8443/v2/boards', 'GET', true)).toBe('scheme')
    expect(allowed(miro, 'https://user:pw@api.miro.com/v2/boards', 'GET', true)).toBe('invalid')
    expect(allowed(miro, 'https://api.miro.com/v2/boards#x', 'GET', true)).toBe('invalid')
  })

  it('no look-alike host, no suffix match, no IP literal, no other host at all', () => {
    for (const host of [
      'api.miro.com.evil.example',
      'evil-api.miro.com',
      'miro.com',
      'r.miro.com',
      'api.miro.com.',
      'xn--api-miro-com',
      '52.1.2.3',
      '[2600::1]',
      'localhost',
    ])
      // (an ill-formed punycode label does not even parse: refused all the same)
      expect(['host', 'invalid'], host).toContain(allowed(miro, `https://${host}/v2/boards`, 'GET', true))
  })

  it('files: none until the probe names the download host (fails closed), never with a Bearer token', () => {
    expect(MIRO_DOWNLOAD_HOSTS).toEqual([])
    const exp = Math.floor(NOW / 1000) + 60
    expect(allowed(miro, `https://r.miro.com/abc.png?Expires=${exp}&Signature=s&Key-Pair-Id=k`)).toBe('host')
    // with a host (as the probe will set it): GET only, unexpired, and never a Bearer secret
    const withHost = makeEgressPolicy([MIRO_API_RULE, { ...MIRO_FILE_RULE, host: ['r.miro.com'] }])
    const url = `https://r.miro.com/abc.png?Expires=${exp}&Signature=s&Key-Pair-Id=k`
    expect(allowed(withHost, url)).toBe('miro-files')
    expect(allowed(withHost, url, 'GET', true)).toBe('bearer')
    expect(allowed(withHost, url, 'POST')).toBe('method')
    expect(allowed(withHost, url.replace(String(exp), String(exp - 120)))).toBe('check')
    expect(allowed(withHost, 'https://r.miro.com/abc.png?Signature=s')).toBe('check')
    expect(allowed(withHost, `${url}&Expires=${exp}`)).toBe('check')
  })

  it('signed URLs: Expires in epoch seconds, once, in the future', () => {
    const at = (q: string) => signedUrlLive(new URL(`https://r.miro.com/x?${q}`), NOW)
    expect(at(`Expires=${NOW / 1000 + 1}`)).toBe(true)
    expect(at(`Expires=${NOW / 1000}`)).toBe(false)
    expect(at('Expires=soon')).toBe(false)
    expect(at('')).toBe(false)
  })

  it('the test seam: exact local origins stand for their rule (no scheme, port or address check)', () => {
    const seam = miroEgressPolicy({ api: 'http://127.0.0.1:7801', files: 'http://127.0.0.1:7802' })
    expect(allowed(seam, 'http://127.0.0.1:7801/v2/boards', 'GET', true)).toBe('miro-api')
    expect(allowed(seam, 'http://127.0.0.1:7801/v2/orgs', 'GET', true)).toBe('path')
    const exp = Math.floor(NOW / 1000) + 60
    expect(allowed(seam, `http://127.0.0.1:7802/f/abc?Expires=${exp}`)).toBe('miro-files')
    expect(allowed(seam, `http://127.0.0.1:7802/f/abc?Expires=${exp}`, 'GET', true)).toBe('bearer')
    // another port of the same host is no seam
    expect(allowed(seam, 'http://127.0.0.1:7803/v2/boards', 'GET', true)).toBe('scheme')
    const t = checkTarget('http://127.0.0.1:7801/v2/boards', 'GET', true, seam, NOW)
    expect(typeof t === 'string' ? t : t.seam).toBe(true)
  })
})

describe('the chat hook policy', () => {
  const hooks = chatHookEgressPolicy(null)

  it('Slack and Teams webhooks, POST only, never a Bearer secret', () => {
    expect(allowed(hooks, SLACK, 'POST')).toBe('slack')
    expect(allowed(hooks, TEAMS, 'POST')).toBe('teams')
    expect(allowed(hooks, SLACK, 'GET')).toBe('method')
    expect(allowed(hooks, SLACK, 'POST', true)).toBe('bearer')
    expect(allowed(hooks, `${SLACK}?x=1`, 'POST')).toBe('check')
    expect(allowed(hooks, TEAMS.replace('&sig=SIG9876', ''), 'POST')).toBe('check')
    expect(allowed(hooks, SLACK.replace('/services/', '/triggers/'), 'POST')).toBe('path')
    const lookalike = SLACK.replace('hooks.slack.com', 'hooks.slack.com.evil.example')
    expect(allowed(hooks, lookalike, 'POST')).toBe('host')
    expect(allowed(hooks, 'https://dbc.webhook.office.com/webhookb2/x', 'POST')).toBe('host')
    expect(allowed(hooks, 'https://api.miro.com/v2/boards', 'GET', true)).toBe('host')
  })

  it('one seam origin may stand for both providers (the rule is picked by path)', () => {
    const seam = makeEgressPolicy(chatHookEgressPolicy(null).rules, [
      ['http://127.0.0.1:7811', 'slack'],
      ['http://127.0.0.1:7811', 'teams'],
    ])
    const slack = SLACK.replace('https://hooks.slack.com', 'http://127.0.0.1:7811')
    expect(allowed(seam, slack, 'POST')).toBe('slack')
    const teams = TEAMS.replace(/^https:\/\/[^/]+/, 'http://127.0.0.1:7811')
    expect(allowed(seam, teams, 'POST')).toBe('teams')
    expect(allowed(seam, 'http://127.0.0.1:7811/anything', 'POST')).toBe('path')
  })

  it('the Miro and chat policies share nothing', () => {
    expect(allowed(miroEgressPolicy(null), SLACK, 'POST')).toBe('host')
  })
})
