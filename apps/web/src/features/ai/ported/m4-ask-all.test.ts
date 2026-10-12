// Wave M (W4, M4-6): "All boards" in the Ask panel, on the in-memory board of ./test-kit.ts, with W8's client stood in
// for (../workspace-ask/client.ts askWorkspace).
//  - An answer across boards opens privately; each citation links to its board at its elements (`?el=`); "Add answer
//    to board" only when the answer says every cited board allows it, else it says why.
//  - When the api has no ask across boards (WorkspaceAskUnavailableError) this board answers instead, and says so.
//  - What people use is counted by event name only: ai.open:<kind>, ai.ask.scope:<board|all>, sort.run:<kind>,
//    pieces.insert.
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { AI_ERROR_CODES, type WorkspaceAskResponse } from '@draftroom/contracts'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../api/client.ts'
import { pendingUsage, resetUsageForTests } from '../../../lib/usage.ts'
import { insertPiece } from '../../pieces/insert.ts'
import { sortBy } from '../../sort/run.ts'
import { fakeCanvas, fakeCtx, noteEls } from '../../sort/test-kit.ts'

const askWorkspace = vi.fn()
vi.mock('../workspace-ask/client.ts', async (importActual) => ({
  ...(await importActual<typeof import('../workspace-ask/client.ts')>()),
  askWorkspace: (...a: unknown[]) => askWorkspace(...a),
}))

const { WorkspaceAskUnavailableError } = await import('../workspace-ask/client.ts')
const { runAi } = await import('./actions.ts')
const { aiAnswer } = await import('./ask.ts')
const {
  addAnswerReason,
  addWorkspaceAnswer,
  aiWorkspaceAnswer,
  ALL_BOARDS_FALLBACK,
  askAllBoards,
  canAddWorkspaceAnswer,
  citationHref,
} = await import('./ask-all.ts')
const { aiMenu } = await import('./runtime.ts')
const { selectionTarget } = await import('./target.ts')
const { aiKit, note } = await import('./test-kit.ts')

const RUN = 'air_0123456789ABCDEFabcd'

const answer = (over: Partial<WorkspaceAskResponse> = {}): WorkspaceAskResponse => ({
  answer: 'Launch plan [1] and the budget [2] say so.',
  found: 'yes',
  citations: [
    { boardId: 'b-launch0001', boardTitle: 'Launch plan', elementIds: ['n1', 'n2'] },
    { boardId: 'b-kit0000001', boardTitle: 'Board', elementIds: ['n9'] },
  ],
  exportAllowed: true,
  ...over,
})

beforeAll(() => installServerTextMetrics())
beforeEach(() => {
  askWorkspace.mockReset()
  resetUsageForTests()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetUsageForTests()
})

describe('Ask all boards (M4-6)', () => {
  it('opens the answer privately; its citations link to each board at its elements; counted as all', async () => {
    const k = aiKit(note('n9', 0, 0, 'Budget'))
    askWorkspace.mockResolvedValue(answer())
    await askAllBoards(k.ctx, '  what   is the budget ')
    expect(askWorkspace).toHaveBeenCalledWith('what is the budget', { acknowledged: true })
    const state = aiWorkspaceAnswer(k.canvas).get()
    expect(state).toMatchObject({ question: 'what is the budget', status: 'done' })
    expect(state?.result?.citations.map(citationHref)).toEqual([
      '/b/b-launch0001?el=n1,n2',
      '/b/b-kit0000001?el=n9',
    ])
    expect(k.pushes).toEqual([])
    expect(pendingUsage()).toMatchObject({ 'ai.open:ask': 1, 'ai.ask.scope:all': 1 })
  })

  it('"Add answer to board" only when the answer says every cited board allows it, else it says why', async () => {
    const k = aiKit(note('n9', 0, 0, 'Budget'))
    askWorkspace.mockResolvedValue(answer({ exportAllowed: false }))
    await askAllBoards(k.ctx, 'budget?')
    const closed = aiWorkspaceAnswer(k.canvas).get()
    expect(canAddWorkspaceAnswer(k.canvas, closed)).toBe(false)
    expect(addAnswerReason(closed)).toBe('A board it cites doesn’t allow copying out of it.')
    expect(addWorkspaceAnswer(k.ctx)).toBeNull()
    expect(k.pushes).toEqual([])
    askWorkspace.mockResolvedValue(answer())
    await askAllBoards(k.ctx, 'budget?')
    const open = aiWorkspaceAnswer(k.canvas).get()
    expect(canAddWorkspaceAnswer(k.canvas, open)).toBe(true)
    expect(addAnswerReason(open)).toBeNull()
    const ids = addWorkspaceAnswer(k.ctx)
    expect(ids?.length).toBeGreaterThan(0)
    expect(k.pushes).toHaveLength(1)
    expect(aiWorkspaceAnswer(k.canvas).get()).toBeNull()
  })

  it('nothing to add for a read-only person or an answer that says the boards do not say', async () => {
    const k = aiKit(note('n9', 0, 0, 'Budget'))
    askWorkspace.mockResolvedValue(answer({ found: 'no', answer: '', citations: [] }))
    await askAllBoards(k.ctx, 'budget?')
    expect(canAddWorkspaceAnswer(k.canvas, aiWorkspaceAnswer(k.canvas).get())).toBe(false)
    askWorkspace.mockResolvedValue(answer())
    await askAllBoards(k.ctx, 'budget?')
    k.setReadOnly(true)
    expect(canAddWorkspaceAnswer(k.canvas, aiWorkspaceAnswer(k.canvas).get())).toBe(false)
  })

  it('no ask across boards here after all: this board answers instead, and says so', async () => {
    const k = aiKit(note('n9', 0, 0, 'Budget'))
    askWorkspace.mockRejectedValue(new WorkspaceAskUnavailableError())
    k.answer({
      action: 'ask',
      answer: 'The board says Budget [1].',
      found: 'yes',
      citations: [{ ids: ['shape:n9'] }],
      truncated: false,
      budget: null,
      runId: RUN,
    })
    await askAllBoards(k.ctx, 'budget?')
    expect(aiWorkspaceAnswer(k.canvas).get()).toBeNull()
    expect(k.notify).toHaveBeenCalledWith(expect.objectContaining({ text: ALL_BOARDS_FALLBACK }))
    expect(aiAnswer(k.canvas).get()).toMatchObject({ status: 'done', question: 'budget?' })
    expect(pendingUsage()['ai.ask.scope:board']).toBe(1)
    // N1 (wave M follow-up 4): one ask is one ai.open:ask, though the all-boards ask fell back to this board's
    expect(pendingUsage()['ai.open:ask']).toBe(1)
    expect(pendingUsage()['ai.ask.scope:all']).toBe(1)
  })
})

describe('usage counts in the AI, sort and Pieces features (M4-6)', () => {
  it('an AI action counts ai.open:<its kind>, once a request is sent', async () => {
    const k = aiKit([...note('a', 0, 0, 'One'), ...note('b', 300, 0, 'Two')])
    k.canvas.select(['a', 'b'])
    const target = selectionTarget(k.canvas)
    if (!target) throw new Error('no target')
    k.answer({ action: 'actions', items: [], truncated: false, budget: null, runId: RUN })
    await runAi(k.canvas, { action: 'actions' }, target)
    expect(pendingUsage()['ai.open:actions']).toBe(1)
  })

  it('N1 (wave M follow-up 4): a run the api wants the notice for after all is counted once, not again when it is run with the notice', async () => {
    const k = aiKit([...note('a', 0, 0, 'One'), ...note('b', 300, 0, 'Two')])
    k.canvas.select(['a', 'b'])
    const target = selectionTarget(k.canvas)
    if (!target) throw new Error('no target')
    const req = { action: 'actions' } as const
    const at = { x: 10, top: 10, bottom: 10 }
    k.answer(
      () => {
        throw new ApiError('invalid', 400, AI_ERROR_CODES.noticeRequired, 'Accept the notice first.')
      },
      { action: 'actions', items: [], truncated: false, budget: null, runId: RUN },
    )
    await runAi(k.canvas, req, target, { at })
    // the notice is up with the run waiting; nothing has been done yet
    const waiting = aiMenu(k.canvas).get()
    expect(waiting).toMatchObject({ view: 'notice', pending: req })
    // Continue: the same run, with the notice accepted
    await runAi(k.canvas, waiting?.pending ?? req, target, { acknowledged: true })
    expect(k.requests).toHaveLength(2)
    expect(pendingUsage()['ai.open:actions']).toBe(1)
  })

  it('a sort counts sort.run:<key>; a Piece counts pieces.insert', async () => {
    const f = fakeCanvas([...noteEls('n0', 0, 0), ...noteEls('n1', 300, 0, { fill: '#a6d8f3' })])
    await sortBy(fakeCtx(f.canvas).ctx, 'colour', ['n0', 'n1'])
    expect(pendingUsage()['sort.run:colour']).toBe(1)
    const out = await insertPiece(f.canvas, 'button')
    expect(out.ok).toBe(true)
    expect(pendingUsage()['pieces.insert']).toBe(1)
  })
})
