// W3 (wave L, L3-3): running board commands. A change to more than one element goes through the shared AI
// preview first (grammar results too); Discard writes nothing, Apply writes one step against the board as it
// is then, Try again asks again; one element is written at once; select and zoom never write; the toast names
// what was left alone. The palette's Do, Do with AI and Ask lines.
import type { AiResult } from '@draftroom/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CanvasFeatureContext,
  type CommandSpec,
  createFeatureRegistries,
} from '../../../canvas/api/index.ts'
import type { AiPreviewChoice, AiPreviewPlan } from '../ported/public.ts'
import { aiOffered, commandEntries, runAiCommand } from './provider.ts'
import { runBoardCommand } from './run.ts'
import { type El, fakeBoard, note, updatedIds } from './test-kit.ts'

const preview = vi.hoisted(() => ({
  choices: [] as AiPreviewChoice[],
  plans: [] as AiPreviewPlan[],
  aiCalls: [] as unknown[],
  aiResults: [] as (AiResult | null)[],
}))
vi.mock('../ported/public.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ported/public.ts')>()
  return {
    ...actual,
    showAiPreview: async (_ctx: unknown, plan: AiPreviewPlan) => {
      preview.plans.push(plan)
      return preview.choices.shift() ?? 'discard'
    },
    runAi: async (_ctx: unknown, input: unknown) => {
      preview.aiCalls.push(input)
      return preview.aiResults.shift() ?? null
    },
  }
})

beforeEach(() => {
  preview.choices.length = 0
  preview.plans.length = 0
  preview.aiCalls.length = 0
  preview.aiResults.length = 0
})

function ctxOn(els: El[], opts: Parameters<typeof fakeBoard>[1] = {}, commands: CommandSpec[] = []) {
  const b = fakeBoard(els, opts)
  const registries = createFeatureRegistries()
  for (const c of commands) registries.commands.register(c)
  const ctx = {
    canvas: b.canvas,
    registries,
    notify: (n: { text: string }) => void b.notices.push(n.text),
    dismiss: () => {},
  } as unknown as CanvasFeatureContext
  return { b, ctx }
}

const refs = (...ids: string[]) => ids.map((id) => `shape:${id}`)
const THREE = [...note('a', { x: 0 }), ...note('b', { x: 300 }), ...note('c', { x: 600, locked: true })]

describe('runBoardCommand', () => {
  it('more than one element: the preview first; Discard writes nothing', async () => {
    const { b, ctx } = ctxOn(THREE)
    preview.choices.push('discard')
    const out = await runBoardCommand(ctx, {
      ops: [{ op: 'recolor', ids: refs('a', 'b', 'c'), color: 'yellow' }],
      mode: 'do',
      title: 'Make 3 red notes yellow',
      runId: 'grammar-1',
    })
    expect(out).toBe('discarded')
    expect(b.steps).toHaveLength(0)
    expect(preview.plans).toHaveLength(1)
    expect(preview.plans[0]).toMatchObject({
      runId: 'grammar-1',
      title: 'Make 3 red notes yellow',
      summary: 'Changes 2 items: 2 recoloured',
      recolors: [
        { id: 'a', to: 'yellow' },
        { id: 'b', to: 'yellow' },
      ],
      moves: [],
      creates: [],
    })
  })

  it('Apply writes ONE step, and the locked note left alone is named in the toast', async () => {
    const { b, ctx } = ctxOn(THREE)
    preview.choices.push('apply')
    const out = await runBoardCommand(ctx, {
      ops: [{ op: 'recolor', ids: refs('a', 'b', 'c'), color: 'yellow' }],
      mode: 'do',
      title: 'Make 3 red notes yellow',
      runId: 'grammar-2',
    })
    expect(out).toBe('applied')
    expect(b.steps).toHaveLength(1)
    expect(b.steps[0]?.label).toBe('Make 3 red notes yellow')
    expect(updatedIds(b.steps[0]).sort()).toEqual(['a', 'b'])
    expect(b.notices).toEqual(['1 locked item was left as it is.'])
  })

  it('Try again asks again (AI): the new ops are previewed, then applied', async () => {
    const { b, ctx } = ctxOn(THREE)
    preview.choices.push('retry', 'apply')
    let asked = 0
    const out = await runBoardCommand(
      ctx,
      {
        ops: [{ op: 'recolor', ids: refs('a', 'b'), color: 'green' }],
        mode: 'do',
        title: 'First',
        runId: 'air_1',
      },
      async () => {
        asked++
        return {
          ops: [{ op: 'recolor', ids: refs('a', 'b'), color: 'blue' }],
          mode: 'do',
          title: 'Second',
          runId: 'air_2',
        }
      },
    )
    expect(out).toBe('applied')
    expect(asked).toBe(1)
    expect(preview.plans.map((p) => p.runId)).toEqual(['air_1', 'air_2'])
    expect(b.steps.map((s) => s.label)).toEqual(['Second'])
  })

  it('one element is written at once (no preview); select and zoom write nothing', async () => {
    const { b, ctx } = ctxOn(THREE)
    expect(
      await runBoardCommand(ctx, {
        ops: [{ op: 'recolor', ids: refs('a'), color: 'blue' }],
        mode: 'do',
        title: 'Make a note blue',
        runId: 'g',
      }),
    ).toBe('applied')
    expect(preview.plans).toHaveLength(0)
    expect(b.steps).toHaveLength(1)
    expect(
      await runBoardCommand(ctx, {
        ops: [
          { op: 'select', ids: refs('a', 'b') },
          { op: 'zoomTo', ids: refs('a', 'b') },
        ],
        mode: 'find',
        title: 'Find 2 notes',
        runId: 'g',
      }),
    ).toBe('moved-camera')
    expect(b.steps).toHaveLength(1)
    expect(b.selected.at(-1)).toEqual(['a', 'b'])
    expect(b.zoomed).toHaveLength(1)
  })

  it('a read-only person never writes (the board says why); their select still works', async () => {
    const { b, ctx } = ctxOn(THREE, { readOnly: true })
    expect(
      await runBoardCommand(ctx, {
        ops: [{ op: 'recolor', ids: refs('a', 'b'), color: 'blue' }],
        mode: 'do',
        title: 'x',
        runId: 'g',
      }),
    ).toBe('read-only')
    expect(b.steps).toHaveLength(0)
    expect(preview.plans).toHaveLength(0)
  })
})

describe('the palette’s Do lines', () => {
  const ASK: CommandSpec = { id: 'ai.ask', label: 'Ask this board', readOnlyAllowed: true, run: () => {} }

  it('a phrase the grammar knows is the top line, runnable for an editor, refused for a viewer', () => {
    const editor = ctxOn(THREE).ctx
    const [line] = commandEntries(editor, 'make all red notes yellow')
    expect(line).toMatchObject({ id: 'do:grammar', label: 'Make 3 Coral notes Butter', pinned: 2000 })
    expect(line?.disabledReason).toBeNull()
    const viewer = ctxOn(THREE, { readOnly: true }).ctx
    expect(commandEntries(viewer, 'make all red notes yellow')[0]?.disabledReason).toMatch(/not change it/)
    // a find phrase is a viewer's too
    expect(commandEntries(viewer, 'select all red notes')[0]?.disabledReason).toBeNull()
  })

  it('no AI line without the AI feature’s Ask (W2) on this board; with it, Do / Find with AI and Ask', () => {
    const none = ctxOn(THREE).ctx
    expect(aiOffered(none)).toBe(false)
    expect(commandEntries(none, 'select the notes about budget')).toEqual([])
    const editor = ctxOn(THREE, {}, [ASK]).ctx
    expect(aiOffered(editor)).toBe(true)
    expect(commandEntries(editor, 'select the notes about budget').map((e) => e.label)).toEqual([
      'Do with AI: select the notes about budget',
      'Ask: select the notes about budget',
    ])
    const viewer = ctxOn(THREE, { readOnly: true }, [ASK]).ctx
    expect(commandEntries(viewer, 'select the notes about budget')[0]?.label).toBe(
      'Find with AI: select the notes about budget',
    )
    // a known phrase does not offer AI for itself (it costs nothing locally)
    expect(commandEntries(editor, 'make all red notes yellow').map((e) => e.id)).toEqual([
      'do:grammar',
      'ask',
    ])
    // short queries offer nothing
    expect(commandEntries(editor, 'ab')).toEqual([])
  })

  it('Do with AI: one call (mode do, or find for a viewer; the selection only when the words point at it)', async () => {
    const { b, ctx } = ctxOn(THREE, { selection: ['a', 'b-label'] }, [ASK])
    preview.aiResults.push({
      action: 'command',
      mode: 'do',
      ops: [{ op: 'select', ids: refs('a') }],
      explain: 'Selected 1 note',
      truncated: false,
      budget: null,
      runId: 'air_00000000000000000001',
    } as unknown as AiResult)
    await runAiCommand(ctx, 'select the one about budget')
    expect(preview.aiCalls).toEqual([
      { action: 'command', instruction: 'select the one about budget', mode: 'do', shapeIds: [] },
    ])
    expect(b.selected.at(-1)).toEqual(['a'])
    await runAiCommand(ctx, 'line these up nicely')
    expect(preview.aiCalls[1]).toEqual({
      action: 'command',
      instruction: 'line these up nicely',
      mode: 'do',
      shapeIds: refs('a', 'b'),
    })
    const viewer = ctxOn(THREE, { readOnly: true }, [ASK]).ctx
    await runAiCommand(viewer, 'find budget notes')
    expect((preview.aiCalls[2] as { mode: string }).mode).toBe('find')
  })
})
