// The wave T foundation's contracts (docs/WAVE-T-CONTRACTS.md): the assignee-refs internal route, the strip-keys
// prefixes of the planning classes, and the `storyboard` AI action's input and result. The equality with
// canvas-schema's planning keys is pinned in packages/canvas-schema/src/planning.test.ts.
import { describe, expect, it } from 'vitest'
import {
  AI_ACTIONS,
  AI_LEDGER_ACTION_PATTERN,
  AI_STORYBOARD_MAX_PANELS,
  AI_WAVE_T_ACTIONS,
  AiResult,
  AiStoryboardPanel,
  ASSIGNEE_REFS_MAX_UIDS,
  ASSIGNEE_REFS_ROUTE,
  AssigneeRefsAnswer,
  AssigneeRefsRequest,
  assigneeRefsPath,
  STRIP_KEYS_PREFIXES,
  StripKeysRequest,
  USAGE_AI_OPEN_KINDS,
} from './index.ts'

describe('assignee-refs (sync → api)', () => {
  it('an internal path per board; 1 to 50 uids of up to 60 characters; the answer a strict list', () => {
    expect(ASSIGNEE_REFS_ROUTE).toBe('/internal/boards/:bid/assignee-refs')
    expect(assigneeRefsPath('b-1 x')).toBe('/internal/boards/b-1%20x/assignee-refs')
    expect(AssigneeRefsRequest.safeParse({ uids: ['usr_0123456789'] }).success).toBe(true)
    expect(AssigneeRefsRequest.safeParse({ uids: Array(ASSIGNEE_REFS_MAX_UIDS).fill('u') }).success).toBe(
      true,
    )
    for (const bad of [
      { uids: [] },
      { uids: Array(ASSIGNEE_REFS_MAX_UIDS + 1).fill('u') },
      { uids: ['u'.repeat(61)] },
      { uids: ['u'], more: 1 },
    ])
      expect(AssigneeRefsRequest.safeParse(bad).success, JSON.stringify(bad).slice(0, 40)).toBe(false)
    expect(AssigneeRefsAnswer.safeParse({ accounts: [] }).success).toBe(true)
    expect(AssigneeRefsAnswer.safeParse({ accounts: [], guests: [] }).success).toBe(false)
  })
})

describe('strip-keys: the planning classes', () => {
  it('takes each of the four wave T classes beside react:', () => {
    for (const prefix of ['react:', 'card:', 'sb:', 'kanban', 'timeline'])
      expect(StripKeysRequest.safeParse({ prefix }).success, prefix).toBe(true)
    for (const prefix of ['card', 'sb', 'card:status', 'tag:'])
      expect(StripKeysRequest.safeParse({ prefix }).success).toBe(false)
    expect(STRIP_KEYS_PREFIXES).toHaveLength(5)
  })
})

describe('the storyboard AI action', () => {
  it('is a contract action with a ledger name and a usage kind', () => {
    expect(AI_WAVE_T_ACTIONS).toEqual(['storyboard'])
    expect(AI_ACTIONS).toContain('storyboard')
    expect('storyboard').toMatch(AI_LEDGER_ACTION_PATTERN)
    expect(USAGE_AI_OPEN_KINDS).toContain('storyboard')
  })

  it('its result: at most 60 panels with clamped fields', () => {
    const panel = {
      camera: 'CU',
      action: 'Hands on the pad.',
      dialogue: 'VO: Ready.',
      sfx: '',
      durationMs: 2500,
    }
    expect(AiStoryboardPanel.safeParse(panel).success).toBe(true)
    expect(AiStoryboardPanel.safeParse({ ...panel, durationMs: null }).success).toBe(true)
    expect(AiStoryboardPanel.safeParse({ ...panel, durationMs: 50 }).success).toBe(false)
    const common = { truncated: false, budget: null, runId: `air_${'a'.repeat(20)}` }
    const r = AiResult.safeParse({ action: 'storyboard', panels: [panel], ...common })
    expect(r.success, JSON.stringify(r.error?.issues?.[0])).toBe(true)
    expect(
      AiResult.safeParse({
        action: 'storyboard',
        panels: Array(AI_STORYBOARD_MAX_PANELS + 1).fill(panel),
        ...common,
      }).success,
    ).toBe(false)
  })
})
