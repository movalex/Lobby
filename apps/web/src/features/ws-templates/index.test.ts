// OWNER: W8 (wave M; landed by the wave M foundation): the ws-templates and ai-workspace-ask features are registered
// and contribute nothing yet, so the board page is unchanged.
import { PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { feature as askFeature } from '../ai/workspace-ask/index.tsx'
import { CANVAS_FEATURES } from '../canvas-registry.ts'
import { feature, WS_TEMPLATES_SAVE_COMMAND_ID } from './index.tsx'

describe('the wave M features registered by the foundation', () => {
  it('are in the canvas registry, last, and empty', () => {
    const ids = CANVAS_FEATURES.map((f) => f.id)
    expect(ids.slice(-2)).toEqual(['ws-templates', 'ai-workspace-ask'])
    for (const f of [feature, askFeature]) expect(Object.keys(f)).toEqual(['id'])
  })

  it('their command ids are palette command ids', () => {
    expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(WS_TEMPLATES_SAVE_COMMAND_ID)
  })
})
