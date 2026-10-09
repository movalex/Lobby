// L4-2: Diagram from words (./DiagramPrompt.tsx runDiagram) with W2's public.ts mocked (runAi, showAiPreview,
// findSpot are foundation stubs until W2 lands): the request it sends, the preview above 20 elements (apply, try
// again, discard), the provenance on every element, the spot findSpot gives, and one undo for the whole diagram.
import type { AiStatus } from '@draftroom/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { fakeFlowCanvas } from '../../flow/test-canvas.ts'
import { aiStatus } from '../ported/runtime.ts'

const runAi = vi.fn()
const showAiPreview = vi.fn()
const findSpot = vi.fn()
vi.mock('../ported/public.ts', async (importActual) => ({
  ...(await importActual<typeof import('../ported/public.ts')>()),
  runAi: (...a: unknown[]) => runAi(...a),
  showAiPreview: (...a: unknown[]) => showAiPreview(...a),
  findSpot: (...a: unknown[]) => findSpot(...a),
}))

const { DIAGRAM_COMMAND, DIAGRAM_MENU, PREVIEW_ABOVE, runDiagram, wordyIds } = await import(
  './DiagramPrompt.tsx'
)

const RUN = 'air_0123456789ABCDEFGHIJ'
function result(n: number, edges = n - 1) {
  return {
    action: 'diagram' as const,
    direction: 'down' as const,
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `n${i + 1}`,
      label: `Step ${i + 1}`,
      kind: (['process', 'decision', 'terminal', 'io'] as const)[i % 4],
    })),
    edges: Array.from({ length: edges }, (_, i) => ({ from: `n${i + 1}`, to: `n${i + 2}`, label: '' })),
    truncated: false,
    budget: null,
    runId: RUN,
  }
}

function setup(seed: Parameters<typeof fakeFlowCanvas>[0] = []) {
  const f = fakeFlowCanvas(seed)
  const notices: unknown[] = []
  const ctx = {
    canvas: f.canvas,
    me: { user: { id: 'usr_alice' } },
    notify: (n: unknown) => notices.push(n),
  } as unknown as CanvasFeatureContext
  return { f, ctx, notices }
}

beforeEach(() => {
  runAi.mockReset()
  showAiPreview.mockReset()
  findSpot.mockReset()
  findSpot.mockReturnValue({ x: 1000, y: 500, frameId: null })
})

describe('runDiagram', () => {
  it('asks for a diagram of the selection and the words, the direction given', async () => {
    const { ctx } = setup()
    runAi.mockResolvedValue(null)
    await runDiagram(ctx, { prompt: '  brief, concept, ship  ', shapeIds: ['abc'], direction: 'right' })
    expect(runAi).toHaveBeenCalledWith(ctx, {
      action: 'diagram',
      shapeIds: ['shape:abc'],
      prompt: 'brief, concept, ship',
      direction: 'right',
    })
  })

  it('nothing to send, nothing asked; null from runAi (AI off, refused: already said) makes nothing', async () => {
    const { f, ctx } = setup()
    expect(await runDiagram(ctx, { prompt: '  ', shapeIds: [], direction: 'down' })).toBeNull()
    expect(runAi).not.toHaveBeenCalled()
    runAi.mockResolvedValue(null)
    expect(await runDiagram(ctx, { prompt: 'x', shapeIds: [], direction: 'down' })).toBeNull()
    expect(f.live()).toHaveLength(0)
  })

  it('a small diagram is built at once, at the spot findSpot gives, every element stamped with the run', async () => {
    const { f, ctx } = setup()
    runAi.mockResolvedValue(result(3))
    const ids = await runDiagram(ctx, { prompt: 'a b c', shapeIds: ['n'], direction: 'down' })
    expect(showAiPreview).not.toHaveBeenCalled()
    expect(findSpot).toHaveBeenCalledWith(ctx, expect.objectContaining({ near: ['n'] }))
    expect(ids).toHaveLength(3 * 2 + 2)
    const shapes = f.live().filter((e) => e.type !== 'text' && e.type !== 'arrow')
    expect(Math.min(...shapes.map((s) => s.y))).toBe(500)
    for (const e of f.live())
      expect((e.customData as { lobby: { ai: unknown } }).lobby.ai).toEqual({ by: 'usr_alice', run: RUN })
    expect(f.steps()).toBe(1)
    f.undo()
    expect(f.live()).toHaveLength(0)
  })

  it(`over ${PREVIEW_ABOVE} elements: the preview first; apply builds it`, async () => {
    const { f, ctx } = setup()
    runAi.mockResolvedValue(result(40, 39))
    showAiPreview.mockResolvedValue('apply')
    const ids = await runDiagram(ctx, { prompt: 'forty steps', shapeIds: [], direction: 'down' })
    expect(showAiPreview).toHaveBeenCalledTimes(1)
    const plan = showAiPreview.mock.calls[0]?.[1]
    expect(plan).toMatchObject({ runId: RUN, title: 'Diagram from words', moves: [], recolors: [] })
    expect(plan.summary).toBe('Adds 40 shapes and 39 connectors')
    expect(plan.creates.filter((c: { kind: string }) => c.kind === 'diagram-node')).toHaveLength(40)
    expect(ids).toHaveLength(40 * 2 + 39)
    expect(f.live().filter((e) => e.type === 'arrow')).toHaveLength(39)
  })

  it('discard makes nothing; try again asks again (a new budgeted call) and applies the second answer', async () => {
    const { f, ctx } = setup()
    runAi.mockResolvedValue(result(30, 29))
    showAiPreview.mockResolvedValue('discard')
    expect(await runDiagram(ctx, { prompt: 'x', shapeIds: [], direction: 'down' })).toBeNull()
    expect(f.live()).toHaveLength(0)
    runAi.mockReset()
    runAi.mockResolvedValueOnce(result(30, 29)).mockResolvedValueOnce(result(25, 24))
    showAiPreview.mockReset()
    showAiPreview.mockResolvedValueOnce('retry').mockResolvedValueOnce('apply')
    await runDiagram(ctx, { prompt: 'x', shapeIds: [], direction: 'down' })
    expect(runAi).toHaveBeenCalledTimes(2)
    expect(f.live().filter((e) => e.type === 'arrow')).toHaveLength(24)
  })

  it('an answer with fewer than two nodes says so and makes nothing; a viewer by then makes nothing', async () => {
    const { f, ctx, notices } = setup()
    runAi.mockResolvedValue(result(1, 0))
    expect(await runDiagram(ctx, { prompt: 'x', shapeIds: [], direction: 'down' })).toBeNull()
    expect(notices).toHaveLength(1)
    runAi.mockResolvedValue(result(3))
    f.setReadOnly(true)
    expect(await runDiagram(ctx, { prompt: 'x', shapeIds: [], direction: 'down' })).toBeNull()
  })
})

describe('the entries', () => {
  const ON: AiStatus = {
    enabled: true,
    reason: null,
    canInsert: true,
    canSummarize: true,
    noticeAccepted: true,
    budget: null,
    settings: null,
  }
  const offered = (ctx: CanvasFeatureContext) => {
    const menu = DIAGRAM_MENU.visible?.(ctx, { ids: [], point: null, hit: null })
    const command = DIAGRAM_COMMAND.enabled?.(ctx)
    expect(menu).toBe(command)
    return menu
  }

  it('Diagram from words only where AI may build on the board: never for a read-only role', () => {
    const { f, ctx } = setup()
    aiStatus(f.canvas).set(ON)
    expect(offered(ctx)).toBe(true)
    f.setReadOnly(true)
    expect(offered(ctx)).toBe(false)
  })

  it('no entry before the api said, with AI off (a guest, the board, the workspace), no inserting, or the budget spent', () => {
    const { f, ctx } = setup()
    expect(offered(ctx)).toBe(false)
    aiStatus(f.canvas).set({ ...ON, enabled: false, reason: 'guest', canInsert: false, canSummarize: false })
    expect(offered(ctx)).toBe(false)
    aiStatus(f.canvas).set({ ...ON, enabled: false, reason: 'board-off' })
    expect(offered(ctx)).toBe(false)
    aiStatus(f.canvas).set({ ...ON, canInsert: false })
    expect(offered(ctx)).toBe(false)
    aiStatus(f.canvas).set({ ...ON, budget: { usedPercent: 100, resetsAt: '2026-10-10T00:00:00.000Z' } })
    expect(offered(ctx)).toBe(false)
    aiStatus(f.canvas).set(ON)
    expect(offered(ctx)).toBe(true)
  })

  it('the selection gives its notes, texts and worded shapes (a label stands for its container)', () => {
    const { f } = setup([
      { id: 'note', type: 'stickynote' },
      { id: 'txt', type: 'text', text: 'Brief', originalText: 'Brief' },
      { id: 'box', type: 'rectangle', boundElements: [{ id: 'lbl', type: 'text' }] },
      { id: 'lbl', type: 'text', containerId: 'box', text: 'Ship', originalText: 'Ship' },
      { id: 'empty', type: 'rectangle' },
    ])
    f.canvas.select(['note', 'txt', 'lbl', 'empty'])
    expect(wordyIds(f.canvas)).toEqual(['note', 'txt', 'box'])
  })
})
