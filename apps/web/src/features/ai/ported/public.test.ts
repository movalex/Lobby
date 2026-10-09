// Wave L (W2): the AI feature's cross-workstream API (./public.ts) with its real bodies, on the in-memory board of
// ./test-kit.ts: runAi runs one action through the menus' gate and notice, sends `at` (the selection's bounds)
// and resolves the api's result with its run id, a new call each time; showAiPreview writes nothing (the push
// counter stays at 0) until Apply, and Discard writes nothing; findSpot places by the AI notes' rules; and
// aiCustomData writes the provenance the server accepts.

import { checkLobbyData, lobbyValueProblem } from '@draftroom/canvas-schema/custom-data'
import type { AiRunInput } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiPreview } from './preview.tsx'
import {
  AI_COMMAND_IDS,
  type AiPreviewPlan,
  aiActionsArgs,
  aiAskArgs,
  aiCustomData,
  aiRecapArgs,
  findSpot,
  runAi,
  showAiPreview,
} from './public.ts'
import { aiJob, aiMenu } from './runtime.ts'
import { AI_ON, aiKit, note } from './test-kit.ts'

const RUN_A = 'air_0123456789ABCDEFabcd'
const RUN_B = 'air_ZYXWVUTSRQponmlk9876'

const askAnswer = (runId: string | undefined, ids: string[] = ['shape:n1']) => ({
  action: 'ask',
  answer: 'Summer, twice [1].',
  found: 'yes',
  citations: [{ ids }],
  truncated: false,
  budget: null,
  ...(runId ? { runId } : {}),
})

const plan = (runId = RUN_A): AiPreviewPlan => ({
  runId,
  title: 'Group into themes',
  summary: 'Moves 2 notes into 1 theme',
  moves: [{ id: 'n1', x: 400, y: 0 }],
  recolors: [{ id: 'n2', to: 'yellow' }],
  creates: [{ x: 0, y: -60, w: 120, h: 30, kind: 'text' }],
})

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runAi: one run for every workstream', () => {
  it('sends `at` (the selection’s bounds) and resolves the result with its run id; each call is a new one', async () => {
    const k = aiKit([...note('n1', 0, 0, 'Summer launch'), ...note('n2', 300, 0, 'Winter teaser')])
    k.canvas.select(['n1', 'n2'])
    k.answer(askAnswer(RUN_A), askAnswer(RUN_B))
    const input: AiRunInput = { action: 'ask', question: 'What about summer?', shapeIds: [] }
    const first = await runAi(k.ctx, input)
    expect(first?.runId).toBe(RUN_A)
    expect(k.requests[0]?.path).toBe('/api/boards/b-kit0000001/ai/run')
    expect(k.requests[0]?.body).toEqual({ ...input, at: { x: 0, y: 0, w: 500, h: 200 } })
    // Try again is a new budgeted call: a new request, a new run id
    const again = await runAi(k.ctx, input)
    expect(again?.runId).toBe(RUN_B)
    expect(k.requests).toHaveLength(2)
    // it applies nothing: no push
    expect(k.pushes).toEqual([])
    expect(aiJob(k.canvas).get()).toBeNull()
  })

  it('resolves null without a request when AI is off here, or when a view-only person asks to write', async () => {
    const off = aiKit([], { status: { ...AI_ON, enabled: false, reason: 'board-off' } })
    expect(await runAi(off.ctx, { action: 'ask', question: 'Why?', shapeIds: [] })).toBeNull()
    expect(off.requests).toEqual([])
    const viewer = aiKit(note('n1', 0, 0, 'A'), { status: { ...AI_ON, canInsert: false } })
    expect(await runAi(viewer.ctx, { action: 'sort', shapeIds: ['shape:n1'], lens: 'how soon' })).toBeNull()
    expect(viewer.requests).toEqual([])
    expect(viewer.notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }))
  })

  it('counts an answer without a run id as one that could not be used (a wave K api cannot run these)', async () => {
    const k = aiKit(note('n1', 0, 0, 'Summer'))
    k.answer(askAnswer(undefined))
    expect(await runAi(k.ctx, { action: 'ask', question: 'Summer?', shapeIds: [] })).toBeNull()
    expect(k.notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', testId: 'ai-error' }))
  })

  it('asks the privacy notice first when it was never accepted: Continue sends `acknowledged`, Cancel nothing', async () => {
    const k = aiKit(note('n1', 0, 0, 'Summer'), { status: { ...AI_ON, noticeAccepted: false } })
    k.answer(askAnswer(RUN_A))
    const input: AiRunInput = { action: 'ask', question: 'Summer?', shapeIds: [] }
    const pending = runAi(k.ctx, input)
    await vi.waitFor(() => expect(aiMenu(k.canvas).get()?.view).toBe('notice'))
    expect(aiMenu(k.canvas).get()?.notice?.verb).toBe('answer your question')
    expect(k.requests).toEqual([])
    aiMenu(k.canvas).get()?.notice?.confirm(true)
    aiMenu(k.canvas).set(null)
    expect((await pending)?.runId).toBe(RUN_A)
    expect(k.requests[0]?.body.acknowledged).toBe(true)

    const c = aiKit(note('n1', 0, 0, 'Summer'), { status: { ...AI_ON, noticeAccepted: false } })
    const cancelled = runAi(c.ctx, input)
    await vi.waitFor(() => expect(aiMenu(c.canvas).get()?.view).toBe('notice'))
    aiMenu(c.canvas).set(null) // Cancel, Escape or a press elsewhere close it
    expect(await cancelled).toBeNull()
    expect(c.requests).toEqual([])
  })
})

describe('showAiPreview: nothing is written before Apply', () => {
  it('leaves the push counter at 0 while it is open, and Discard writes nothing', async () => {
    const k = aiKit([...note('n1', 0, 0, 'A'), ...note('n2', 300, 0, 'B')])
    const choice = showAiPreview(k.ctx, plan())
    expect(aiPreview(k.canvas).get()?.plan.runId).toBe(RUN_A)
    expect(k.pushes).toEqual([])
    aiPreview(k.canvas).get()?.choose('discard')
    expect(await choice).toBe('discard')
    expect(aiPreview(k.canvas).get()).toBeNull()
    expect(k.pushes).toEqual([])
  })

  it('resolves the person’s choice once; a second preview discards the first; read-only is discard', async () => {
    const k = aiKit(note('n1', 0, 0, 'A'))
    const first = showAiPreview(k.ctx, plan(RUN_A))
    const second = showAiPreview(k.ctx, plan(RUN_B))
    expect(await first).toBe('discard')
    const entry = aiPreview(k.canvas).get()
    entry?.choose('apply')
    entry?.choose('retry')
    expect(await second).toBe('apply')
    k.setReadOnly(true)
    expect(await showAiPreview(k.ctx, plan())).toBe('discard')
    expect(k.pushes).toEqual([])
  })
})

describe('findSpot', () => {
  it('beside the named elements in their frame when it has room, else around the middle of the view', () => {
    const frame = { id: 'f1', type: 'frame', x: 0, y: 0, width: 1600, height: 800, name: 'Ideas' }
    const k = aiKit([frame, ...note('n1', 100, 100, 'A', { frameId: 'f1' })])
    const near = findSpot(k.ctx, { size: { w: 300, h: 200 }, near: ['n1'] })
    expect(near.frameId).toBe('f1')
    expect(near.x).toBeGreaterThanOrEqual(300)
    expect(near.y).toBeGreaterThanOrEqual(0)
    const open = findSpot(k.ctx, { size: { w: 200, h: 100 } })
    expect(open.frameId).toBeNull()
    // clear of the frame (and its name band)
    const clear = open.x >= 1600 || open.x + 200 <= 0 || open.y >= 800 || open.y + 100 <= -40
    expect(clear).toBe(true)
  })
})

describe('aiCustomData: provenance the server accepts', () => {
  it('writes lobby.ai {by, run} and an ai- kind, valid for canvas-schema', () => {
    const d = aiCustomData('usr_0123456789', 'recap-heading', RUN_A)
    expect(d).toEqual({ lobby: { ai: { by: 'usr_0123456789', run: RUN_A }, kind: 'ai-recap-heading' } })
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
