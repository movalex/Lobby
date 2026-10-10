// Wave M integration (W4's Ask with W8's "Ask all boards"): the board's 'ai.ask' honours `scope: 'all'`, which
// 'ai.askWorkspace' passes on. With a question it asks across the workspace's boards at once; without one the Ask
// panel opens on All boards. While asking all boards is not offered here, the same call is this board's Ask, as before.
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import type { WorkspaceAskResponse } from '@draftroom/contracts'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetUsageForTests } from '../../../lib/usage.ts'

const askWorkspace = vi.fn()
const available = { on: true }
vi.mock('../workspace-ask/client.ts', async (importActual) => ({
  ...(await importActual<typeof import('../workspace-ask/client.ts')>()),
  askWorkspace: (...a: unknown[]) => askWorkspace(...a),
  askWorkspaceAvailable: () => available.on,
}))

const { COMMANDS } = await import('./menus.tsx')
const { AI_COMMAND_IDS, aiAskArgs } = await import('./public.ts')
const { aiAnswer } = await import('./ask.ts')
const { aiWorkspaceAnswer } = await import('./ask-all.ts')
const { aiMenu } = await import('./runtime.ts')
const { AI_ON, aiKit, note } = await import('./test-kit.ts')

const answer: WorkspaceAskResponse = {
  answer: 'The budget board says so [1].',
  found: 'yes',
  citations: [{ boardId: 'b-budget0001', boardTitle: 'Budget', elementIds: ['n1'] }],
  exportAllowed: true,
}

const askCommand = () => {
  const c = COMMANDS.find((x) => x.id === AI_COMMAND_IDS.ask)
  if (!c) throw new Error('no ai.ask')
  return c
}
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeAll(() => installServerTextMetrics())
beforeEach(() => {
  askWorkspace.mockReset()
  available.on = true
  resetUsageForTests()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetUsageForTests()
})

describe("'ai.ask' with scope 'all' (W8's Ask all boards)", () => {
  it('reads the scope from its args (anything else is ignored)', () => {
    expect(aiAskArgs({ scope: 'all', question: '  Why?  ' })).toEqual({ scope: 'all', question: 'Why?' })
    expect(aiAskArgs({ scope: 'all' })).toEqual({ scope: 'all' })
    expect(aiAskArgs({ scope: 'board', question: 'Why?' })).toEqual({ question: 'Why?' })
    expect(aiAskArgs({ scope: 'everything' })).toEqual({})
  })

  it('with a question: asks across the boards at once (not this board)', async () => {
    const k = aiKit(note('n9', 0, 0, 'Budget'))
    askWorkspace.mockResolvedValue(answer)
    await askCommand().run(k.ctx, 'palette', { scope: 'all', question: 'what is the budget' })
    await settle()
    expect(askWorkspace).toHaveBeenCalledWith('what is the budget', { acknowledged: true })
    expect(aiWorkspaceAnswer(k.canvas).get()).toMatchObject({
      question: 'what is the budget',
      status: 'done',
    })
    expect(k.requests.filter((r) => r.path.endsWith('/ai/run'))).toHaveLength(0)
    expect(aiAnswer(k.canvas).get()).toBeNull()
  })

  it('without a question: the Ask panel opens on All boards', async () => {
    const k = aiKit(note('n9', 0, 0, 'Budget'))
    k.answer(AI_ON) // opening the panel reads the AI status again
    await askCommand().run(k.ctx, 'palette', { scope: 'all' })
    expect(aiMenu(k.canvas).get()).toMatchObject({ view: 'ask', scope: 'all' })
    k.answer(AI_ON)
    await askCommand().run(k.ctx, 'palette', {})
    expect(aiMenu(k.canvas).get()?.view).toBe('ask')
    expect(aiMenu(k.canvas).get()?.scope).toBeUndefined()
  })

  it('while asking all boards is not offered here: this board answers, as before', async () => {
    available.on = false
    const k = aiKit(note('n9', 0, 0, 'Budget'))
    k.answer(AI_ON)
    await askCommand().run(k.ctx, 'palette', { scope: 'all' })
    expect(aiMenu(k.canvas).get()).toMatchObject({ view: 'ask' })
    expect(aiMenu(k.canvas).get()?.scope).toBeUndefined()
    k.answer({ action: 'ask', answer: 'Budget [1].', found: 'yes', citations: [{ ids: ['shape:n9'] }] })
    await askCommand().run(k.ctx, 'palette', { scope: 'all', question: 'what is the budget' })
    await vi.waitFor(() => expect(k.requests.some((r) => r.path.endsWith('/ai/run'))).toBe(true))
    expect(askWorkspace).not.toHaveBeenCalled()
  })
})
