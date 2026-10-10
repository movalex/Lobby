// OWNER: W8 (wave M, M8-2; landed by the wave M foundation): the frozen availability rule, the request, the 404 rule
// and the forced answer of the dev-auth hook; the contract's element ids are the deep link's.
import { ELEMENT_ID_PATTERN } from '@draftroom/canvas-schema/limits'
import {
  type AiStatus,
  PALETTE_COMMAND_IDS,
  WORKSPACE_ASK_ELEMENT_ID_PATTERN,
  type WorkspaceAskResponse,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AI_ASK_WORKSPACE_COMMAND_ID,
  askWorkspace,
  askWorkspaceAvailable,
  forceWorkspaceAskForTests,
  resetWorkspaceAskForTests,
  setWorkspaceAskContext,
  subscribeWorkspaceAsk,
  type WorkspaceAskContext,
  WorkspaceAskUnavailableError,
  workspaceAskAllowed,
} from './client.ts'

const WID = 'wsp_0123456789'

const status = (workspaceDefault: boolean | null): AiStatus => ({
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: true,
  budget: null,
  settings:
    workspaceDefault === null
      ? null
      : {
          board: null,
          workspaceDefault,
          on: workspaceDefault,
          canManageBoard: false,
          canManageWorkspace: false,
        },
})

const ctx = (over: Partial<WorkspaceAskContext> = {}): WorkspaceAskContext => ({
  workspaceId: WID,
  workspaceRole: 'member',
  ai: status(true),
  ...over,
})

const ANSWER: WorkspaceAskResponse = {
  answer: 'Ship on Friday [1].',
  found: 'yes',
  citations: [{ boardId: 'b-plan01', boardTitle: 'Plan', elementIds: ['abcdefghij'] }],
  exportAllowed: true,
}

interface Call {
  url: string
  method: string
  body: unknown
}
let calls: Call[] = []
let reply: () => Response
const g = globalThis as { fetch?: unknown }
const before = g.fetch

beforeEach(() => {
  calls = []
  reply = () => new Response(JSON.stringify(ANSWER), { status: 200 })
  g.fetch = (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    })
    return Promise.resolve(reply())
  }
})
afterEach(() => {
  g.fetch = before
  resetWorkspaceAskForTests()
})

describe('the availability rule (frozen)', () => {
  it('a workspace owner, admin or member, with the workspace AI on', () => {
    for (const role of ['owner', 'admin', 'member'] as const)
      expect(workspaceAskAllowed(ctx({ workspaceRole: role })), role).toBe(true)
    expect(workspaceAskAllowed(ctx({ workspaceRole: 'guest' }))).toBe(false)
    // a name-only guest has no role in the workspace
    expect(workspaceAskAllowed(ctx({ workspaceRole: null }))).toBe(false)
    // the workspace default off (a board's own switch does not decide it), AI off or unconfigured, not known yet
    expect(workspaceAskAllowed(ctx({ ai: status(false) }))).toBe(false)
    expect(workspaceAskAllowed(ctx({ ai: status(null) }))).toBe(false)
    expect(workspaceAskAllowed(ctx({ ai: null }))).toBe(false)
    expect(workspaceAskAllowed(ctx({ workspaceId: '' }))).toBe(false)
    expect(workspaceAskAllowed(null)).toBe(false)
  })
})

describe('the client', () => {
  it('with no context (the foundation board page): not available, and an ask rejects without a request', async () => {
    expect(askWorkspaceAvailable()).toBe(false)
    await expect(askWorkspace('What did we decide?')).rejects.toBeInstanceOf(WorkspaceAskUnavailableError)
    await expect(askWorkspace('x')).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' })
    expect(calls).toEqual([])
  })

  it('with an allowed context: posts the question to its workspace and answers the parsed response', async () => {
    const seen: boolean[] = []
    subscribeWorkspaceAsk(() => seen.push(askWorkspaceAvailable()))
    setWorkspaceAskContext(ctx())
    expect(seen).toEqual([true])
    expect(await askWorkspace('What did we decide?', { acknowledged: true })).toEqual(ANSWER)
    expect(calls).toEqual([
      {
        url: `/api/workspaces/${WID}/ai/ask`,
        method: 'POST',
        body: { question: 'What did we decide?', acknowledged: true },
      },
    ])
    setWorkspaceAskContext(ctx({ workspaceRole: 'guest' }))
    expect(askWorkspaceAvailable()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('a 404 turns it off for that workspace in this tab and rejects unavailable; other errors are the api’s', async () => {
    setWorkspaceAskContext(ctx())
    reply = () => new Response(JSON.stringify({ error: { code: 'BAD', message: 'no' } }), { status: 500 })
    await expect(askWorkspace('q')).rejects.toMatchObject({ name: 'ApiError', status: 500 })
    expect(askWorkspaceAvailable()).toBe(true)
    let notified = 0
    subscribeWorkspaceAsk(() => notified++)
    reply = () =>
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found.' } }), { status: 404 })
    await expect(askWorkspace('q')).rejects.toBeInstanceOf(WorkspaceAskUnavailableError)
    expect(askWorkspaceAvailable()).toBe(false)
    expect(notified).toBe(1)
    // no further request for that workspace; another workspace is decided again
    await expect(askWorkspace('q')).rejects.toBeInstanceOf(WorkspaceAskUnavailableError)
    expect(calls).toHaveLength(2)
    setWorkspaceAskContext(ctx({ workspaceId: 'wsp_abcdefghij' }))
    expect(askWorkspaceAvailable()).toBe(true)
  })

  it('the dev hook’s forced answer overrides the rule for its workspace, and the 404 rule still holds', async () => {
    forceWorkspaceAskForTests(true, WID)
    expect(askWorkspaceAvailable()).toBe(true)
    expect(await askWorkspace('q')).toEqual(ANSWER)
    forceWorkspaceAskForTests(false, WID)
    setWorkspaceAskContext(ctx())
    expect(askWorkspaceAvailable()).toBe(false)
    forceWorkspaceAskForTests(null)
    expect(askWorkspaceAvailable()).toBe(true)
    forceWorkspaceAskForTests(true, WID)
    reply = () => new Response('{}', { status: 404 })
    await expect(askWorkspace('q')).rejects.toBeInstanceOf(WorkspaceAskUnavailableError)
    expect(askWorkspaceAvailable()).toBe(false)
  })

  it('a response the contract refuses is a bad-response error, not an answer', async () => {
    setWorkspaceAskContext(ctx())
    reply = () => new Response(JSON.stringify({ answer: 'x' }), { status: 200 })
    await expect(askWorkspace('q')).rejects.toMatchObject({ name: 'ApiError', kind: 'bad-response' })
  })

  it('its command id is a palette command; citations use the canvas element id pattern', () => {
    expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(AI_ASK_WORKSPACE_COMMAND_ID)
    expect(WORKSPACE_ASK_ELEMENT_ID_PATTERN.source).toBe(ELEMENT_ID_PATTERN.source)
    expect(WORKSPACE_ASK_ELEMENT_ID_PATTERN.flags).toBe(ELEMENT_ID_PATTERN.flags)
  })
})
