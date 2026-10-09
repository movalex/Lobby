// K7-1 and K7-3: the AI actions that build mind maps, end to end in memory (./actions.ts on the in-memory canvas
// of mindmap/test-canvas.ts, a fake api): "Expand with AI" calls the existing 'ideas' action with the topic
// as the prompt (cut to the cap) and its path as the context, and adds the answer under the topic as one
// undo step; "Mind map from a prompt" turns the prompt and the ideas into one new map; the gate hides both
// when AI is off or the budget is spent; and an error or a budget answer leaves no partial map.
import { AI_ERROR_CODES, AI_PROMPT_MAX_CHARS, type AiStatus } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../api/client.ts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { setMindmap } from '../../mindmap/ported/bridge.ts'
import type { Mindmap } from '../../mindmap/ported/commands.ts'
import { topicMetaOf } from '../../mindmap/ported/meta.ts'
import { MindmapRuntime } from '../../mindmap/ported/runtime.ts'
import { type El, fakeMapCanvas, lobbyOf, measure } from '../../mindmap/test-canvas.ts'
import { cancelAiJob, expandTopic, FLASH_MS, mindmapFromPrompt, runAi } from './actions.ts'
import { EXPAND_COUNT } from './expand.ts'
import { aiFlash, aiJob, aiMenu, aiStatus, setAiCtx } from './runtime.ts'
import { NONE, refOf } from './target.ts'

const ON: AiStatus = {
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: true,
  budget: null,
  settings: null,
}

type Call = { method: string; path: string; body: Record<string, unknown> }

function setup(status: AiStatus | null = ON) {
  const f = fakeMapCanvas()
  const rt = new MindmapRuntime(f.canvas, (text, size) => measure(text, size))
  const notify = vi.fn()
  const m = { rt, notify: vi.fn() } as unknown as Mindmap
  setMindmap(f.canvas, m)
  const calls: Call[] = []
  const answers: (() => unknown)[] = []
  /** the schema each request asked the api client to parse its answer with (the client parses; this fake does too) */
  const schemas: { parse(v: unknown): unknown }[] = []
  const request = vi.fn(
    async (
      method: string,
      path: string,
      o: { body?: Record<string, unknown>; schema?: { parse(v: unknown): unknown } },
    ) => {
      calls.push({ method, path, body: o.body ?? {} })
      if (o.schema) schemas.push(o.schema)
      const next = answers.shift()
      if (!next) throw new Error('no answer queued')
      const raw = next()
      return o.schema ? o.schema.parse(raw) : raw
    },
  )
  const ctx = {
    canvas: f.canvas,
    board: { id: 'bd_1', title: 'Board' },
    me: { user: { id: 'usr_ana' } },
    workspace: { id: 'ws_1', name: 'Studio' },
    api: { request },
    notify,
    dismiss: vi.fn(),
    events: { on: () => () => undefined },
    registries: {},
  } as unknown as CanvasFeatureContext
  setAiCtx(ctx)
  aiStatus(f.canvas).set(status)
  const ideas = (list: string[], budget: unknown = null) =>
    answers.push(() => ({ action: 'ideas', ideas: list, truncated: false, budget }))
  const fail = (e: Error) =>
    answers.push(() => {
      throw e
    })
  // a map: Launch > Audience > (Fans), Channels
  const built = rt.createMapFromOutline({
    text: 'Launch',
    children: [
      { text: 'Audience', children: [{ text: 'Fans', children: [] }] },
      { text: 'Channels', children: [] },
    ],
  })
  if (!built) throw new Error('no map')
  const idOf = (text: string) => {
    const hit = [...f.els.values()].find(
      (e) => !e.isDeleted && e.type !== 'text' && f.canvas.text.of(e.id) === text,
    )
    if (!hit) throw new Error(`no topic ${text}`)
    return hit.id
  }
  const topics = () =>
    [...f.els.values()].filter((e) => !e.isDeleted && e.type !== 'text' && topicMetaOf(e as never))
  f.transacts.length = 0
  const steps = f.steps()
  return { f, rt, notify, calls, request, ideas, fail, idOf, topics, ctx, steps, schemas, answers }
}

/** Resolves once the job ended (the answer applied or the error shown). */
async function settled(canvas: LobbyCanvas) {
  await vi.waitFor(() => expect(aiJob(canvas).get()).toBeNull())
  // the apply runs in the same tick the job clears; let the toast calls land
  await Promise.resolve()
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Expand with AI', () => {
  it('asks the existing ideas action: the topic words as the prompt, its path as the context', async () => {
    const { f, calls, ideas, idOf } = setup()
    ideas(['Instagram', 'TikTok', 'Podcasts', 'Email', 'Events'])
    expandTopic(f.canvas, idOf('Audience'))
    await settled(f.canvas)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/boards/bd_1/ai/run',
      body: {
        action: 'ideas',
        // the path from the central topic, then the topic's children
        shapeIds: [refOf(idOf('Launch')), refOf(idOf('Audience')), refOf(idOf('Fans'))],
        prompt: 'Audience',
        count: EXPAND_COUNT,
      },
    })
  })

  it('cuts a long topic to the 200-character cap of the prompt', async () => {
    const { f, calls, ideas, idOf, request } = setup()
    const topic = idOf('Channels')
    const long = `${'lorem ipsum '.repeat(40)}end`
    // write the long words into the topic's label directly
    const label = ((f.els.get(topic)?.boundElements ?? []) as { id: string }[])[0]?.id as string
    f.els.set(label, { ...(f.els.get(label) as El), originalText: long })
    ideas(['One'])
    expandTopic(f.canvas, topic)
    await settled(f.canvas)
    const body = calls[0]?.body as { prompt: string }
    expect(body.prompt.length).toBeLessThanOrEqual(AI_PROMPT_MAX_CHARS)
    expect(long.startsWith(body.prompt)).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('adds the answer under the topic: bound, tidy, stamped, selected, in ONE undo step; the toast offers Undo', async () => {
    const { f, ideas, idOf, topics, notify, steps } = setup()
    const before = f.snapshot()
    ideas(['Instagram', 'TikTok', 'Podcasts', 'Email', 'Events'])
    const topic = idOf('Channels')
    expandTopic(f.canvas, topic)
    await settled(f.canvas)
    const kids = topics().filter((e) => topicMetaOf(e as never)?.parentId === topic)
    expect(kids.map((e) => f.canvas.text.of(e.id)).sort()).toEqual(
      ['Email', 'Events', 'Instagram', 'Podcasts', 'TikTok'].sort(),
    )
    for (const k of kids) {
      expect(lobbyOf(k).ai).toEqual({ by: 'usr_ana' })
      expect(f.selected).toContain(k.id)
    }
    // one step for all of them: one transact and the one that binds the lines, joined to it
    expect(f.transacts.map((t) => t.joined)).toEqual([false, true])
    expect(f.steps()).toBe(steps + 1)
    const done = notify.mock.calls.map((c) => c[0]).find((n) => n.testId === 'ai-done')
    expect(done.text).toBe('Added 5 sub-topics.')
    expect(done.action.label).toBe('Undo')
    // the toast's Undo (or Ctrl+Z) takes all of them back
    done.action.onClick()
    expect(f.snapshot()).toBe(before)
  })

  it('parses the answer of a wave K api (no run id) and of a wave L one (foundation review: rollback-safe)', async () => {
    const { f, ideas, idOf, topics, schemas, answers } = setup()
    // a wave K api's answer: no runId (ideas() queues exactly that)
    ideas(['One', 'Two'])
    expandTopic(f.canvas, idOf('Channels'))
    await settled(f.canvas)
    expect(topics().filter((e) => topicMetaOf(e as never)?.parentId === idOf('Channels'))).toHaveLength(2)
    // a wave L api's: with a run id, which must be a valid one
    answers.push(() => ({
      action: 'ideas',
      ideas: ['Three'],
      truncated: false,
      budget: null,
      runId: 'air_0123456789ABCDEFabcd',
    }))
    expandTopic(f.canvas, idOf('Audience'))
    await settled(f.canvas)
    expect(topics().some((e) => f.canvas.text.of(e.id) === 'Three')).toBe(true)
    const schema = schemas[0]
    expect(schema).toBeDefined()
    expect(() =>
      schema?.parse({ action: 'ideas', ideas: [], truncated: false, budget: null, runId: 'air_bad' }),
    ).toThrow()
  })

  it('highlights what it wrote for a moment (overlay state only), then lets go', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { f, ideas, idOf } = setup()
      ideas(['One', 'Two'])
      expandTopic(f.canvas, idOf('Channels'))
      await vi.waitFor(() => expect(aiFlash(f.canvas).get()).not.toBeNull())
      const flash = aiFlash(f.canvas).get()
      expect(flash?.ids.length).toBe(2)
      // the highlight is a picture: the ids are topics the result made, nothing is stored on the board
      for (const id of flash?.ids ?? []) expect(f.els.get(id)?.customData).toBeDefined()
      vi.advanceTimersByTime(FLASH_MS + 10)
      expect(aiFlash(f.canvas).get()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the placeholder state while the request runs (the job knows where the result lands)', async () => {
    const { f, ideas, idOf, request } = setup()
    let release = () => {}
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ action: 'ideas', ideas: ['One', 'Two', 'Three'], truncated: false, budget: null })
        }),
    )
    ideas([])
    expandTopic(f.canvas, idOf('Channels'))
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    const job = aiJob(f.canvas).get()
    expect(job?.into).toEqual({ kind: 'expand', topicId: idOf('Channels') })
    // five pills beside the topic, where the sub-topics will appear
    expect(job?.landing?.tiles).toHaveLength(EXPAND_COUNT)
    expect(job?.landing?.tiles.every((t) => t.shape === 'pill')).toBe(true)
    release()
    await settled(f.canvas)
  })

  it('opens the notice first when the person has not seen it, then continues with the same request', async () => {
    const { f, calls, ideas, idOf } = setup({ ...ON, noticeAccepted: false })
    expandTopic(f.canvas, idOf('Channels'))
    await Promise.resolve()
    expect(calls).toHaveLength(0)
    const menu = aiMenu(f.canvas).get()
    expect(menu?.view).toBe('notice')
    expect(menu?.pending?.into).toEqual({ kind: 'expand', topicId: idOf('Channels') })
    ideas(['One'])
    await runAi(f.canvas, menu?.pending as never, menu?.target as never, { acknowledged: true, at: menu?.at })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.acknowledged).toBe(true)
  })

  it.each([
    ['AI is off for the board', { ...ON, enabled: false, reason: 'board-off' as const }],
    ['the person may not add to the board', { ...ON, canInsert: false }],
    ['the budget is spent', { ...ON, budget: { usedPercent: 100, resetsAt: '2026-10-09T00:00:00.000Z' } }],
    ['the status is not known yet', null],
  ])('is not offered, and asks nothing, when %s', async (_name, status) => {
    const { f, calls, idOf, notify } = setup(status)
    expandTopic(f.canvas, idOf('Channels'))
    await Promise.resolve()
    expect(calls).toHaveLength(0)
    expect(aiJob(f.canvas).get()).toBeNull()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a viewer asks nothing', async () => {
    const { f, calls, idOf } = setup()
    f.setReadOnly(true)
    expandTopic(f.canvas, idOf('Channels'))
    await Promise.resolve()
    expect(calls).toHaveLength(0)
  })

  it('a rate limit or the budget answer shows the api’s own words and leaves the board as it was', async () => {
    for (const [code, message] of [
      [AI_ERROR_CODES.rateLimited, 'You’ve used AI 30 times in the last hour. Try again a little later.'],
      [AI_ERROR_CODES.workspaceBudget, 'Your workspace has used its AI budget for today.'],
    ] as const) {
      const { f, fail, idOf, notify } = setup()
      const before = f.snapshot()
      fail(new ApiError('rate-limited', 429, code, message))
      expandTopic(f.canvas, idOf('Channels'))
      await settled(f.canvas)
      const shown = notify.mock.calls.map((c) => c[0]).find((n) => n.testId === 'ai-error')
      expect(shown).toMatchObject({ text: message, tone: 'error' })
      expect(f.snapshot()).toBe(before)
      expect(f.transacts).toHaveLength(0)
    }
  })

  it('an answer with nothing new, or a topic deleted meanwhile, writes nothing', async () => {
    const same = setup()
    same.ideas(['audience', '  ', 'FANS'].slice(1, 2)) // only blanks
    expandTopic(same.f.canvas, same.idOf('Channels'))
    await settled(same.f.canvas)
    expect(same.f.transacts).toHaveLength(0)
    expect(same.notify.mock.calls.map((c) => c[0].text)).toContain(
      'AI had nothing new to add under that topic.',
    )

    const gone = setup()
    gone.ideas(['One'])
    const topic = gone.idOf('Channels')
    gone.request.mockImplementationOnce(async () => {
      gone.f.els.set(topic, { ...(gone.f.els.get(topic) as El), isDeleted: true })
      return { action: 'ideas', ideas: ['One'], truncated: false, budget: null }
    })
    expandTopic(gone.f.canvas, topic)
    await settled(gone.f.canvas)
    expect(gone.f.transacts).toHaveLength(0)
    expect(gone.notify.mock.calls.map((c) => c[0].text)).toContain(
      'That topic is gone, so there is nothing to expand.',
    )
  })

  it('cancelling while it runs: nothing is added when the answer arrives', async () => {
    const { f, request, idOf, notify } = setup()
    let release = () => {}
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ action: 'ideas', ideas: ['One'], truncated: false, budget: null })
        }),
    )
    expandTopic(f.canvas, idOf('Channels'))
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    cancelAiJob(f.canvas)
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(f.transacts).toHaveLength(0)
    expect(notify.mock.calls.map((c) => c[0].testId)).toContain('ai-cancelled')
  })
})

describe('Mind map from a prompt', () => {
  it('sends only the prompt: the ideas action with no board text as the context', async () => {
    const { f, calls, ideas } = setup()
    ideas(['Names', 'Venue', 'Music'])
    void mindmapFromPrompt(f.canvas, 'Launch party', 6)
    await settled(f.canvas)
    expect(calls[0]?.body).toEqual({ action: 'ideas', shapeIds: [], prompt: 'Launch party', count: 6 })
  })

  it('the prompt becomes the centre, the ideas its children, in one transact (one undo step); stamped as AI-made', async () => {
    const { f, ideas, topics, notify, steps } = setup()
    const before = f.snapshot()
    ideas(['Names', 'Venue', 'Music', 'Food'])
    void mindmapFromPrompt(f.canvas, 'Launch party', 4)
    await settled(f.canvas)
    const made = topics().filter((e) => f.canvas.text.of(e.id) === 'Launch party')
    expect(made).toHaveLength(1)
    const root = made[0]
    const ring = topics().filter((e) => topicMetaOf(e as never)?.parentId === root?.id)
    expect(ring.map((e) => f.canvas.text.of(e.id)).sort()).toEqual(['Food', 'Music', 'Names', 'Venue'])
    for (const e of [root, ...ring]) expect(lobbyOf(e).ai).toEqual({ by: 'usr_ana' })
    expect(f.transacts.map((t) => t.joined)).toEqual([false, true])
    expect(f.steps()).toBe(steps + 1)
    const done = notify.mock.calls.map((c) => c[0]).find((n) => n.testId === 'ai-done')
    expect(done.text).toBe('Drafted a mind map with 4 branches.')
    done.action.onClick()
    expect(f.snapshot()).toBe(before)
  })

  it('a 429 or a budget answer shows the friendly copy and draws no partial map', async () => {
    const { f, fail, notify } = setup()
    const before = f.snapshot()
    fail(
      new ApiError(
        'rate-limited',
        429,
        AI_ERROR_CODES.userBudget,
        'You have used your AI allowance for today.',
      ),
    )
    void mindmapFromPrompt(f.canvas, 'Launch party', 6)
    await settled(f.canvas)
    expect(notify.mock.calls.map((c) => c[0]).find((n) => n.testId === 'ai-error')).toMatchObject({
      text: 'You have used your AI allowance for today.',
      tone: 'error',
    })
    expect(f.snapshot()).toBe(before)
    expect(f.transacts).toHaveLength(0)
  })

  it('an answer with no usable idea draws nothing and says so', async () => {
    const { f, ideas, notify } = setup()
    const before = f.snapshot()
    ideas(['  ', ''])
    void mindmapFromPrompt(f.canvas, 'Launch party', 6)
    await settled(f.canvas)
    expect(f.snapshot()).toBe(before)
    expect(notify.mock.calls.map((c) => c[0]).find((n) => n.testId === 'ai-error')?.text).toContain(
      'mind map',
    )
  })

  it('respects the gate: AI off, no right to add, or no budget left asks nothing', async () => {
    for (const status of [
      { ...ON, enabled: false, reason: 'board-off' as const },
      { ...ON, canInsert: false },
      { ...ON, budget: { usedPercent: 100, resetsAt: '2026-10-09T00:00:00.000Z' } },
    ]) {
      const { f, calls } = setup(status)
      void mindmapFromPrompt(f.canvas, 'Launch party', 6)
      await Promise.resolve()
      expect(calls).toHaveLength(0)
      expect(aiJob(f.canvas).get()).toBeNull()
    }
  })

  it('opens the notice for a first-time person, naming only the prompt', async () => {
    const { f, calls } = setup({ ...ON, noticeAccepted: false })
    void mindmapFromPrompt(f.canvas, 'Launch party', 6, { x: 10, top: 10, bottom: 10 })
    await Promise.resolve()
    expect(calls).toHaveLength(0)
    const menu = aiMenu(f.canvas).get()
    expect(menu?.view).toBe('notice')
    expect(menu?.target).toMatchObject({ kind: NONE.kind })
    expect(menu?.pending?.into).toEqual({ kind: 'mindmap' })
  })
})
