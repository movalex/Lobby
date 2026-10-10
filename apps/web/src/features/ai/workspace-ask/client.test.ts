// OWNER: W8 (wave M, M8-2; landed by the wave M foundation): the stub is never available and rejects every ask
// 'unavailable' without a request; the contract's element ids are the deep link's.
import { ELEMENT_ID_PATTERN } from '@draftroom/canvas-schema/limits'
import { PALETTE_COMMAND_IDS, WORKSPACE_ASK_ELEMENT_ID_PATTERN } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  AI_ASK_WORKSPACE_COMMAND_ID,
  askWorkspace,
  askWorkspaceAvailable,
  WorkspaceAskUnavailableError,
} from './client.ts'

describe('the workspace-ask client (the foundation stub)', () => {
  it('is not available, and an ask rejects with unavailable, making no request', async () => {
    const g = globalThis as { fetch?: unknown }
    const before = g.fetch
    let called = 0
    g.fetch = () => {
      called++
      return Promise.reject(new Error('no'))
    }
    try {
      expect(askWorkspaceAvailable()).toBe(false)
      await expect(askWorkspace('What did we decide?')).rejects.toBeInstanceOf(WorkspaceAskUnavailableError)
      await expect(askWorkspace('x')).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' })
      expect(called).toBe(0)
    } finally {
      g.fetch = before
    }
  })

  it('its command id is a palette command; citations use the canvas element id pattern', () => {
    expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(AI_ASK_WORKSPACE_COMMAND_ID)
    expect(WORKSPACE_ASK_ELEMENT_ID_PATTERN.source).toBe(ELEMENT_ID_PATTERN.source)
    expect(WORKSPACE_ASK_ELEMENT_ID_PATTERN.flags).toBe(ELEMENT_ID_PATTERN.flags)
  })
})
