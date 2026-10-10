// Wave M (W4, M4-5, FTU-11): one consistent AI entry.
//  - The menu model: an item that cannot run says what it needs ("Select two or more sticky notes first"), in the
//    popover's hint and in the context menu's label; Summarize with nothing selected reads the whole board (as Ask).
//  - Summarize with nothing selected sends the board's objects (frames for their contents) and opens "the whole board".
//  - The notice says "the selected text" only when the selection is what is sent.
//  - "Diagram from words…" sits inside the context menu's AI submenu (the flow feature adds no top-level entry).
import { describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext, MenuTarget } from '../../../canvas/api/index.ts'
import { feature as flowFeature } from '../../flow/index.tsx'
import { NOTICE_TITLES, noticeWords, runAi } from './actions.ts'
import { aiItemStates, labelWithReason, REASONS } from './menu-model.ts'
import { CONTEXT_MENU } from './menus.tsx'
import { aiPanel } from './runtime.ts'
import { boardTarget, NONE } from './target.ts'
import { aiKit, note } from './test-kit.ts'

const target = (over: Partial<typeof NONE>) => ({ ...NONE, ...over })

describe('the AI menu model (M4-5)', () => {
  it('nothing selected: Summarize reads the whole board; themes and action items say what they need', () => {
    const s = aiItemStates(NONE, { texts: 5 }, { insert: true })
    expect(s.summarize).toEqual({ disabled: false, reason: null, hint: 'A short summary of the whole board' })
    expect(s.themes).toEqual({ disabled: true, reason: REASONS.needNotes, hint: REASONS.needNotes })
    expect(s.actions).toEqual({ disabled: true, reason: REASONS.needText, hint: REASONS.needText })
  })

  it('an empty board: Summarize says to add something first', () => {
    expect(aiItemStates(NONE, { texts: 0 }, { insert: true }).summarize).toMatchObject({
      disabled: true,
      reason: REASONS.boardEmpty,
    })
  })

  it('a selection: each item runs when it has what it needs, with what it does as its hint', () => {
    const two = aiItemStates(
      target({ kind: 'selection', texts: 2, notes: 2 }),
      { texts: 0 },
      { insert: true },
    )
    expect(two.summarize).toMatchObject({ disabled: false, hint: 'Read it first, then add it to the board' })
    expect(two.themes).toMatchObject({ disabled: false, hint: 'Sorts 2 notes into labelled groups' })
    expect(two.actions).toMatchObject({ disabled: false, hint: 'Next steps and owners as new notes' })
    const one = aiItemStates(
      target({ kind: 'selection', texts: 1, notes: 1 }),
      { texts: 9 },
      { insert: false },
    )
    expect(one.summarize.hint).toBe('A short summary, just for you')
    expect(one.themes.reason).toBe(REASONS.needNotes)
    const shape = aiItemStates(
      target({ kind: 'selection', texts: 0, notes: 0 }),
      { texts: 9 },
      { insert: true },
    )
    expect(shape.summarize.reason).toBe(REASONS.needText)
  })

  it('a context-menu label carries the reason', () => {
    expect(labelWithReason('Group into themes', { reason: REASONS.needNotes })).toBe(
      'Group into themes (select two or more sticky notes first)',
    )
    expect(labelWithReason('Summarize', { reason: null })).toBe('Summarize')
  })
})

describe('the context menu (M4-5)', () => {
  const at: MenuTarget = { ids: [], point: { x: 5000, y: 5000 }, hit: null }
  const ai = CONTEXT_MENU.find((e) => e.id === 'ai')
  const entry = (id: string) => ai?.submenu?.find((e) => e.id === id)

  it('right-click on empty canvas: Summarize runs on the board; the rest say why not', () => {
    const k = aiKit([...note('n1', 0, 0, 'Book the venue')])
    const ctx = k.ctx as CanvasFeatureContext
    const label = (id: string) => {
      const l = entry(id)?.label
      return typeof l === 'function' ? l(ctx, at) : l
    }
    expect(entry('ai.summarize')?.disabled?.(ctx, at)).toBe(false)
    expect(label('ai.summarize')).toBe('Summarize')
    expect(entry('ai.themes')?.disabled?.(ctx, at)).toBe(true)
    expect(label('ai.themes')).toBe('Group into themes (select two or more sticky notes first)')
    expect(label('ai.actions')).toBe('Action items (select notes or text first)')
  })

  it('"Diagram from words…" is inside the AI submenu; the flow feature adds no top-level entry', () => {
    const diagram = ai?.submenu?.find((e) => e.command === 'flow.diagram')
    expect(diagram).toBeTruthy()
    expect(CONTEXT_MENU.some((e) => e.command === 'flow.diagram')).toBe(false)
    expect(flowFeature.contextMenu ?? []).toEqual([])
    expect(flowFeature.commands?.map((c) => c.id)).toContain('flow.diagram')
  })
})

describe('Summarize with nothing selected (M4-5)', () => {
  it('sends the board’s objects and opens a summary of “the whole board”, placed in the view', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
    try {
      const k = aiKit([...note('n1', 0, 0, 'Book the venue'), ...note('n2', 300, 0, 'Call the studio')])
      expect(boardTarget(k.canvas)).toMatchObject({ kind: 'none', label: 'the whole board', texts: 2 })
      k.answer({
        action: 'summarize',
        summary: 'Two plans.',
        sources: 2,
        truncated: false,
        budget: null,
        runId: 'air_0123456789ABCDEFabcd',
      })
      await runAi(k.canvas, { action: 'summarize' }, NONE)
      await vi.waitFor(() => expect(aiPanel(k.canvas).get()).not.toBeNull())
      const body = k.requests.find((r) => r.path.endsWith('/ai/run'))?.body as { shapeIds: string[] }
      expect([...body.shapeIds].sort()).toEqual(['shape:n1', 'shape:n2'])
      const panel = aiPanel(k.canvas).get()
      expect(panel?.about).toBe('the whole board')
      expect(panel?.target.ids).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the notice’s words follow what is sent (M4-5)', () => {
  it('"the selected text" only when the selection goes along', () => {
    expect(noticeWords({ action: 'diagram', shapeIds: [] })).toMatchObject({
      what: 'your description',
      title: NOTICE_TITLES.words,
    })
    expect(noticeWords({ action: 'diagram', shapeIds: ['shape:a'] })).toMatchObject({
      what: 'your description and the text you selected',
      title: NOTICE_TITLES.selected,
    })
    expect(noticeWords({ action: 'ideas', shapeIds: [] }).what).toBe('your prompt')
    expect(noticeWords({ action: 'ask', shapeIds: [] }).title).toBe(NOTICE_TITLES.board)
    expect(noticeWords({ action: 'ask', shapeIds: ['shape:a'] }).title).toBe(NOTICE_TITLES.selected)
    expect(noticeWords({ action: 'recap' }).title).toBe(NOTICE_TITLES.board)
  })
})
