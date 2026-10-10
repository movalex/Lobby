// OWNER: W8 (wave M, M8-4). The workspace templates client: the requests it makes, and the downgrade rule (a 404
// to the list turns templates off for that workspace in the tab; a 404 elsewhere never does).
import type { WorkspaceTemplate } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client.ts'
import {
  listWsTemplates,
  removeWsTemplate,
  resetWsTemplatesForTests,
  saveWsTemplate,
  startFromWsTemplate,
  subscribeWsTemplates,
  WsTemplatesUnavailableError,
  wsTemplatesMissing,
} from './client.ts'

const WID = 'wsp_0123456789'
const T: WorkspaceTemplate = {
  boardId: 'b-retro00001',
  name: 'Retro',
  category: 'review',
  addedBy: { id: 'usr_0123456789', name: 'Ana' },
  addedAt: '2026-10-10T00:00:00.000Z',
}

interface Call {
  method: string
  path: string
  body: unknown
}

/** A request function that answers from `reply` (a value, or an ApiError to throw) and records the calls. */
function fakeApi(reply: (c: Call) => unknown) {
  const calls: Call[] = []
  return {
    calls,
    api: {
      request: async (
        method: string,
        path: string,
        o: { body?: unknown; schema: { parse(v: unknown): unknown } | null },
      ) => {
        const c = { method, path, body: o.body }
        calls.push(c)
        const r = reply(c)
        if (r instanceof Error) throw r
        return o.schema ? o.schema.parse(r) : undefined
      },
    } as never,
  }
}

const notFound = () => new ApiError('not-found', 404, 'NOT_FOUND', 'Not found.')

afterEach(() => resetWsTemplatesForTests())

describe('the workspace templates client', () => {
  it('lists, saves, removes and uses with the contract’s paths and bodies', async () => {
    const created = {
      board: {
        id: 'b-copy000001',
        workspaceId: WID,
        projectId: null,
        title: 'Retro',
        visibility: 'private',
        status: 'active',
        role: 'owner',
        createdAt: '2026-10-10T00:00:00.000Z',
      },
      warnings: [],
      linkedFiles: 0,
      droppedFiles: 0,
    }
    const f = fakeApi((c) =>
      c.method === 'GET'
        ? { templates: [T] }
        : c.path.endsWith('/use')
          ? created
          : c.method === 'POST'
            ? T
            : null,
    )
    expect(await listWsTemplates(WID, { api: f.api })).toEqual([T])
    expect(
      await saveWsTemplate(WID, { boardId: T.boardId, name: 'Retro', category: 'review' }, { api: f.api }),
    ).toEqual(T)
    await removeWsTemplate(WID, T.boardId, { api: f.api })
    const made = await startFromWsTemplate(WID, T.boardId, { projectId: null }, { api: f.api })
    expect(f.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['GET', `/api/workspaces/${WID}/templates`, undefined],
      ['POST', `/api/workspaces/${WID}/templates`, { boardId: T.boardId, name: 'Retro', category: 'review' }],
      ['DELETE', `/api/workspaces/${WID}/templates/${T.boardId}`, undefined],
      ['POST', `/api/workspaces/${WID}/templates/${T.boardId}/use`, { projectId: null }],
    ])
    expect(made.board.id).toBe('b-copy000001')
  })

  it('a 404 to the list latches templates off for that workspace (and says so once); another workspace is asked again', async () => {
    let notified = 0
    subscribeWsTemplates(() => notified++)
    const f = fakeApi(() => notFound())
    await expect(listWsTemplates(WID, { api: f.api })).rejects.toBeInstanceOf(WsTemplatesUnavailableError)
    expect(wsTemplatesMissing(WID)).toBe(true)
    expect(notified).toBe(1)
    await expect(listWsTemplates(WID, { api: f.api })).rejects.toBeInstanceOf(WsTemplatesUnavailableError)
    expect(f.calls).toHaveLength(1)
    expect(wsTemplatesMissing('wsp_abcdefghij')).toBe(false)
  })

  it('a 403 (a workspace guest) is unavailable without the latch; other failures are the api’s', async () => {
    const forbidden = fakeApi(() => new ApiError('forbidden', 403, 'FORBIDDEN', 'No.'))
    await expect(listWsTemplates(WID, { api: forbidden.api })).rejects.toBeInstanceOf(
      WsTemplatesUnavailableError,
    )
    expect(wsTemplatesMissing(WID)).toBe(false)
    const down = fakeApi(() => new ApiError('server', 500, 'HTTP_500', 'Down.'))
    await expect(listWsTemplates(WID, { api: down.api })).rejects.toMatchObject({ status: 500 })
    expect(wsTemplatesMissing(WID)).toBe(false)
  })

  it('a 404 to remove is a template already gone (removed); a 404 to use is the api’s own (no latch)', async () => {
    const f = fakeApi(() => notFound())
    await expect(removeWsTemplate(WID, T.boardId, { api: f.api })).resolves.toBeUndefined()
    await expect(startFromWsTemplate(WID, T.boardId, {}, { api: f.api })).rejects.toMatchObject({
      status: 404,
    })
    expect(wsTemplatesMissing(WID)).toBe(false)
  })
})
