// Wave T foundation (docs/WAVE-T-CONTRACTS.md §4): the contracts name the `storyboard` action ("Break down with AI",
// WS2), and this api does not run it yet: PENDING_AI_ACTIONS holds it, so a valid body gets the 400 BAD_REQUEST an
// unknown action gets, with nothing read, reserved, sent to OpenAI or written to the ledger. WS2 removes it from
// PENDING_AI_ACTIONS in the change that adds its handler (and turns this test around).

import { AI_STORYBOARD_MAX_PANELS, AI_STORYBOARD_SCRIPT_MAX_CHARS, AiRunInput } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIVE_AI_ACTIONS, PENDING_AI_ACTIONS } from '../../../src/features/ai/index.ts'
import { type AiWorld, aiWorld, run, usageRows } from './support.ts'

export const STORYBOARD_BODY = {
  action: 'storyboard',
  script: 'INT. KITCHEN - DAY\nANA pours coffee.\nANA\nMorning.',
  aspect: '16:9',
  maxPanels: 12,
}

describe('wave T: the storyboard action is pending', () => {
  let w: AiWorld
  beforeEach(async () => {
    w = await aiWorld()
  })
  afterEach(() => w.close())

  it('is in the contracts, not live: 400 with nothing reserved or sent', async () => {
    expect(AiRunInput.safeParse(STORYBOARD_BODY).success).toBe(true)
    expect([...PENDING_AI_ACTIONS]).toEqual(['storyboard'])
    expect(LIVE_AI_ACTIONS.has('storyboard')).toBe(false)
    const res = await run(w.alice, w.board, STORYBOARD_BODY)
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().error.code).toBe('BAD_REQUEST')
    expect(w.openai.requests).toHaveLength(0)
    expect(await usageRows(w.api)).toEqual([])
  })

  it('its input is capped as the contract says', () => {
    const ok = (b: Record<string, unknown>) => AiRunInput.safeParse({ ...STORYBOARD_BODY, ...b }).success
    expect(ok({ script: 'x'.repeat(AI_STORYBOARD_SCRIPT_MAX_CHARS) })).toBe(true)
    expect(ok({ script: 'x'.repeat(AI_STORYBOARD_SCRIPT_MAX_CHARS + 1) })).toBe(false)
    expect(ok({ script: '   ' })).toBe(false)
    expect(ok({ maxPanels: AI_STORYBOARD_MAX_PANELS + 1 })).toBe(false)
    expect(ok({ maxPanels: 0 })).toBe(false)
    expect(ok({ aspect: '4:3' })).toBe(false)
  })
})
