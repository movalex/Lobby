// OWNER: W8 (wave M, M8-2). The 'ai-workspace-ask' feature: the context it sets for askWorkspaceAvailable() (the
// board's workspace, the caller's role there, and the AI status the AI feature reads, followed as it changes;
// null after the cleanup), and the palette command 'ai.askWorkspace' (offered while available and the board's own
// Ask may run; it opens Ask on All boards).
import type { AiStatus } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CanvasFeatureContext,
  type CommandSpec,
  createFeatureRegistries,
  type LobbyCanvas,
} from '../../../canvas/api/index.ts'
import { aiStatus } from '../ported/runtime.ts'
import { askWorkspaceAvailable, forceWorkspaceAskForTests, resetWorkspaceAskForTests } from './client.ts'
import { askAllArgs, feature } from './index.tsx'

const WID = 'wsp_0123456789'

const status = (workspaceDefault: boolean): AiStatus => ({
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: true,
  budget: null,
  settings: {
    board: null,
    workspaceDefault,
    on: workspaceDefault,
    canManageBoard: false,
    canManageWorkspace: false,
  },
})

function world(role: string | null = 'member') {
  const canvas = { readOnly: () => false } as unknown as LobbyCanvas
  const registries = createFeatureRegistries()
  const ctx = {
    canvas,
    registries,
    workspace: { id: WID, name: 'Studio' },
    board: { id: 'b-ask0000001', title: 'Board', status: 'active' },
    me: { access: { creator: true }, workspaces: role === null ? [] : [{ id: WID, name: 'Studio', role }] },
  } as unknown as CanvasFeatureContext
  return { canvas, registries, ctx }
}

// the dev-auth hook (installed in a dev build, which a test run is) lives on window
beforeEach(() => vi.stubGlobal('window', {}))
afterEach(() => {
  resetWorkspaceAskForTests()
  vi.unstubAllGlobals()
})

describe('the context it sets', () => {
  it('follows the AI status the AI feature reads, and is gone after the cleanup', () => {
    const { canvas, ctx } = world('member')
    const stop = feature.onMount?.(ctx)
    // not known yet: not offered (nothing is fetched by this feature)
    expect(askWorkspaceAvailable()).toBe(false)
    aiStatus(canvas).set(status(true))
    expect(askWorkspaceAvailable()).toBe(true)
    // the workspace default switched off (the AI feature re-reads its status): off here too
    aiStatus(canvas).set(status(false))
    expect(askWorkspaceAvailable()).toBe(false)
    aiStatus(canvas).set(status(true))
    expect(askWorkspaceAvailable()).toBe(true)
    stop?.()
    expect(askWorkspaceAvailable()).toBe(false)
  })

  it('a workspace guest, or a name-only guest (no role in the workspace), is never offered it', () => {
    for (const role of ['guest', null]) {
      const { canvas, ctx } = world(role)
      aiStatus(canvas).set(status(true))
      const stop = feature.onMount?.(ctx)
      expect(askWorkspaceAvailable(), String(role)).toBe(false)
      stop?.()
    }
  })
})

describe('the palette command', () => {
  const command = () => feature.commands?.[0] as CommandSpec

  it('is "Ask all boards", for viewers too, enabled while available and the board’s Ask may run', () => {
    const { canvas, ctx, registries } = world('member')
    const stop = feature.onMount?.(ctx)
    aiStatus(canvas).set(status(true))
    expect(command()).toMatchObject({ id: 'ai.askWorkspace', label: 'Ask all boards', readOnlyAllowed: true })
    // no Ask on this board (AI off here, or the AI feature not on the page): nothing to open
    expect(command().enabled?.(ctx)).toBe(false)
    const asked: unknown[] = []
    registries.commands.register({
      id: 'ai.ask',
      label: 'Ask this board',
      readOnlyAllowed: true,
      run: (_c, _s, a) => void asked.push(a),
    })
    expect(command().enabled?.(ctx)).toBe(true)
    command().run(ctx, 'palette', { question: '  What did we decide?  ', extra: 1 })
    command().run(ctx, 'palette')
    expect(asked).toEqual([{ scope: 'all', question: 'What did we decide?' }, { scope: 'all' }])
    // a 404 or the rule turning it off: not enabled, and running it does nothing
    forceWorkspaceAskForTests(false, WID)
    expect(command().enabled?.(ctx)).toBe(false)
    command().run(ctx, 'palette', { question: 'x' })
    expect(asked).toHaveLength(2)
    stop?.()
  })

  it('passes only a question on (anything else the caller sent is left out)', () => {
    expect(askAllArgs(undefined)).toEqual({ scope: 'all' })
    expect(askAllArgs({ question: '   ' })).toEqual({ scope: 'all' })
    expect(askAllArgs({ question: 5 })).toEqual({ scope: 'all' })
    expect(askAllArgs({ question: 'Why?', scope: 'board' })).toEqual({ scope: 'all', question: 'Why?' })
  })
})
