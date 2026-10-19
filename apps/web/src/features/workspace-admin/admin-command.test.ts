// Wave W (the integration): the 'workspace.admin' palette command opens this board's workspace admin page, offered as
// the workspace menu's entry is: owners and admins of the board's workspace only, and only while the page is offered
// (its web switch AND the api's offer: formatsEnabled, stubbed here). It writes nothing.
import type { WorkspaceSummary } from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'

const state = vi.hoisted(() => ({ offered: true, went: [] as string[] }))
vi.mock('../formats/flags.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../formats/flags.ts')>()
  return { ...real, formatsEnabled: (flag: string) => flag === 'admin' && state.offered }
})
vi.mock('../../lib/routing.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/routing.ts')>()
  return { ...real, navigate: (to: string) => state.went.push(to) }
})

const { ADMIN_COMMAND_ID, feature, managesWorkspace } = await import('./index.tsx')

const WID = 'wsp_0123456789abcdefghij'
const ctxAs = (role: WorkspaceSummary['role'] | null) =>
  ({
    workspace: { id: WID, name: 'Studio' },
    me: {
      workspaces: role
        ? [{ id: WID, name: 'Studio', role }]
        : [{ id: 'wsp_other0123456789abc', role: 'owner' }],
    },
  }) as unknown as CanvasFeatureContext

afterEach(() => {
  state.offered = true
  state.went = []
})

describe('the workspace.admin command', () => {
  const command = () => {
    const c = feature.commands?.find((x) => x.id === ADMIN_COMMAND_ID)
    if (!c) throw new Error('not registered')
    return c
  }

  it('is offered to owners and admins of the board workspace only, viewers of the board included', () => {
    expect(command().readOnlyAllowed).toBe(true)
    for (const role of ['owner', 'admin'] as const)
      expect(command().available?.(ctxAs(role)), role).toBe(true)
    for (const role of ['member', 'guest'] as const)
      expect(command().available?.(ctxAs(role)), role).toBe(false)
    // a person who owns another workspace only (a guest of this board)
    expect(managesWorkspace(ctxAs(null))).toBe(false)
    expect(command().available?.(ctxAs(null))).toBe(false)
  })

  it('is not offered while the page is not (its switch or the api say off)', () => {
    state.offered = false
    expect(command().available?.(ctxAs('owner'))).toBe(false)
    command().run(ctxAs('owner'), 'palette')
    expect(state.went).toEqual([])
  })

  it('opens /w/:wid/admin, and nothing for a member', () => {
    command().run(ctxAs('admin'), 'palette')
    expect(state.went).toEqual([`/w/${WID}/admin`])
    command().run(ctxAs('member'), 'palette')
    expect(state.went).toEqual([`/w/${WID}/admin`])
  })
})
