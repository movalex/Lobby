// Wave L foundation (W2): the AI feature's cross-workstream API (./public.ts) as the stubs ship: safe defaults
// that request, write and apply nothing; aiCustomData final. W2 replaces the stub cases with its own.
import { checkLobbyData, lobbyValueProblem } from '@draftroom/canvas-schema/custom-data'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import {
  AI_COMMAND_IDS,
  aiActionsArgs,
  aiAskArgs,
  aiCustomData,
  aiRecapArgs,
  findSpot,
  runAi,
  showAiPreview,
} from './public.ts'

function fakeCtx() {
  const request = vi.fn(async () => {
    throw new Error('no request expected')
  })
  const transact = vi.fn()
  const ctx = {
    api: { request },
    board: { id: 'b-test000001' },
    canvas: {
      transact,
      viewport: { get: () => ({ x: 100, y: 200, width: 800, height: 600, zoom: 1 }) },
    },
  } as unknown as CanvasFeatureContext
  return { ctx, request, transact }
}

describe('public.ts stubs: nothing requested, written or applied', () => {
  it('runAi resolves null without a request', async () => {
    const { ctx, request } = fakeCtx()
    expect(await runAi(ctx, { action: 'ask', question: 'What did we decide?', shapeIds: [] })).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it("showAiPreview resolves 'discard' and writes nothing", async () => {
    const { ctx, transact } = fakeCtx()
    const choice = await showAiPreview(ctx, {
      runId: 'air_0123456789ABCDEFabcd',
      title: 'Group into themes',
      summary: 'Moves 2 notes into 1 theme',
      moves: [{ id: 'a', x: 0, y: 0 }],
      recolors: [],
      creates: [{ x: 0, y: 0, w: 10, h: 10, kind: 'text' }],
    })
    expect(choice).toBe('discard')
    expect(transact).not.toHaveBeenCalled()
  })

  it('findSpot centres the size in the view, on the open canvas', () => {
    const { ctx } = fakeCtx()
    expect(findSpot(ctx, { size: { w: 200, h: 100 }, near: ['x'] })).toEqual({
      x: 400,
      y: 450,
      frameId: null,
    })
  })
})

describe('aiCustomData: provenance the server accepts', () => {
  it('writes lobby.ai {by, run} and an ai- kind, valid for canvas-schema', () => {
    const d = aiCustomData('usr_0123456789', 'recap-heading', 'air_0123456789ABCDEFabcd')
    expect(d).toEqual({
      lobby: { ai: { by: 'usr_0123456789', run: 'air_0123456789ABCDEFabcd' }, kind: 'ai-recap-heading' },
    })
    expect(lobbyValueProblem('ai', d.lobby.ai)).toBeNull()
    expect(lobbyValueProblem('kind', d.lobby.kind)).toBeNull()
    expect(checkLobbyData(d.lobby)).toEqual({ ok: true })
    expect(aiCustomData('usr_0123456789', 'idea')).toEqual({
      lobby: { ai: { by: 'usr_0123456789' }, kind: 'ai-idea' },
    })
    expect(aiCustomData('usr_0123456789', 'idea', null).lobby.ai).toEqual({ by: 'usr_0123456789' })
  })

  it('refuses a kind word the schema would refuse', () => {
    for (const bad of ['', 'Theme', 'with space', 'x'.repeat(30), '-lead', 'ai_x'])
      expect(() => aiCustomData('usr_0123456789', bad), bad).toThrow()
    expect(lobbyValueProblem('kind', aiCustomData('u', 'x'.repeat(29)).lobby.kind)).toBeNull()
  })
})

describe('the AI command ids and their args', () => {
  it('names the four ids', () => {
    expect(AI_COMMAND_IDS).toEqual({
      ask: 'ai.ask',
      recap: 'ai.recap',
      themes: 'ai.themes',
      actions: 'ai.actions',
    })
  })

  it('reads only the args it knows', () => {
    expect(aiAskArgs({ question: '  Why?  ', extra: 1 })).toEqual({ question: 'Why?' })
    expect(aiAskArgs({ question: '   ' })).toEqual({})
    expect(aiAskArgs('Why?')).toEqual({})
    expect(aiRecapArgs({ scope: 'catch-up' })).toEqual({ scope: 'catch-up' })
    expect(aiRecapArgs({ scope: 'all' })).toEqual({})
    expect(aiActionsArgs({ voteSessionId: 'vot_0123456789ab' })).toEqual({
      voteSessionId: 'vot_0123456789ab',
    })
    expect(aiActionsArgs({ voteSessionId: 'nope' })).toEqual({})
    expect(aiActionsArgs(undefined)).toEqual({})
  })
})
