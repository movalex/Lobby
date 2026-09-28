// ai-assist (docs/WAVE4-CONTRACTS.md §4): who may use AI, decided server-side. Every refusal must happen
// before anything is read from the board or sent to OpenAI, so each case also checks that the fake
// OpenAI saw no request.

import { AiResult, AiStatus } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { brainstormShapes, FRAME, NOTES } from './fixtures.ts'
import { type AiWorld, aiWorld, expectError, run, statusUrl } from './support.ts'

let w: AiWorld

const status = async (c: { req: AiWorld['alice']['req'] }, board = w.board) => {
  const res = await c.req('GET', statusUrl(board))
  expect(res.statusCode, res.body).toBe(200)
  return AiStatus.parse(res.json())
}

describe('with AI configured', () => {
  beforeEach(async () => {
    w = await aiWorld()
    w.sync.setBoard(w.board, brainstormShapes())
  })
  afterEach(() => w.close())

  it('reports what each role may do; only workspace owners see the budget', async () => {
    const owner = await status(w.alice)
    expect(owner).toMatchObject({ enabled: true, reason: null, canInsert: true, canSummarize: true })
    expect(owner.budget).toMatchObject({ usedPercent: 0 })
    expect(new Date(owner.budget?.resetsAt ?? '').getUTCHours()).toBe(0)
    expect(await status(w.bob)).toEqual({
      enabled: true,
      reason: null,
      canInsert: true,
      canSummarize: true,
      noticeAccepted: false,
      budget: null,
      settings: {
        board: null,
        workspaceDefault: true,
        on: true,
        canManageBoard: false,
        canManageWorkspace: false,
      },
    })
    for (const c of [w.carol, w.dave])
      expect(await status(c)).toMatchObject({
        enabled: true,
        canInsert: false,
        canSummarize: true,
        budget: null,
      })
  })

  it('404 for people who cannot view the board, 401 without a session; nothing is sent', async () => {
    expectError(await w.erin.req('GET', statusUrl(w.board)), 404, 'NOT_FOUND')
    expectError(
      await run(w.erin, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'panel' }),
      404,
      'NOT_FOUND',
    )
    expectError(await w.api.anon('GET', statusUrl(w.board)), 401, 'NOT_AUTHENTICATED')
    expectError(
      await w.api.anon('POST', `/api/boards/${w.board}/ai/run`, {
        action: 'summarize',
        shapeIds: [FRAME],
        mode: 'panel',
      }),
      401,
      'NOT_AUTHENTICATED',
    )
    expectError(await w.alice.req('GET', statusUrl('no-such-board')), 404, 'NOT_FOUND')
    expect(w.openai.requests).toHaveLength(0)
  })

  it('viewers and commenters may only summarize into a panel; editors and owners may do everything', async () => {
    for (const c of [w.carol, w.dave]) {
      const panel = await run(c, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'panel' })
      expect(panel.statusCode, panel.body).toBe(200)
      expect(AiResult.parse(panel.json())).toMatchObject({ action: 'summarize', budget: null })
      const before = w.openai.requests.length
      expectError(
        await run(c, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'insert' }),
        403,
        'FORBIDDEN',
      )
      expectError(await run(c, w.board, { action: 'themes', shapeIds: [FRAME] }), 403, 'FORBIDDEN')
      expectError(await run(c, w.board, { action: 'actions', shapeIds: [FRAME] }), 403, 'FORBIDDEN')
      expectError(
        await run(c, w.board, { action: 'ideas', shapeIds: [], prompt: 'More hooks', count: 3 }),
        403,
        'FORBIDDEN',
      )
      expect(w.openai.requests.length).toBe(before)
    }
    for (const c of [w.alice, w.bob]) {
      for (const body of [
        { action: 'summarize', shapeIds: [FRAME], mode: 'insert' },
        { action: 'themes', shapeIds: [FRAME] },
        { action: 'actions', shapeIds: [FRAME] },
        { action: 'ideas', shapeIds: [], prompt: 'More hooks', count: 3 },
      ]) {
        const res = await run(c, w.board, body)
        expect(res.statusCode, `${body.action}: ${res.body}`).toBe(200)
      }
    }
    // Only the workspace owner's answers carry the budget.
    const own = AiResult.parse((await run(w.alice, w.board, { action: 'themes', shapeIds: NOTES })).json())
    expect(own.budget?.usedPercent).toBeGreaterThanOrEqual(0)
    const eds = AiResult.parse((await run(w.bob, w.board, { action: 'themes', shapeIds: NOTES })).json())
    expect(eds.budget).toBeNull()
  })

  it('an archived board is read-only: summarize into a panel only', async () => {
    expect((await w.alice.req('POST', `/api/boards/${w.board}/archive`)).statusCode).toBe(200)
    expect(await status(w.alice)).toMatchObject({ enabled: true, canInsert: false, canSummarize: true })
    expectError(await run(w.alice, w.board, { action: 'themes', shapeIds: [FRAME] }), 403, 'FORBIDDEN')
    expect(
      (await run(w.alice, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'panel' })).statusCode,
    ).toBe(200)
  })

  it('name-only guests never trigger AI, whatever their role (a workshop link makes them editors)', async () => {
    const link = await guestLink(w.alice, w.board, { role: 'editor' })
    const guest = await joinAsGuest(w.api, link.url, 'Sam')
    expect(await status(guest)).toEqual({
      enabled: false,
      reason: 'guest',
      canInsert: false,
      canSummarize: false,
      noticeAccepted: false,
      budget: null,
      settings: null,
    })
    for (const body of [
      { action: 'summarize', shapeIds: [FRAME], mode: 'panel' },
      { action: 'themes', shapeIds: [FRAME] },
      { action: 'ideas', shapeIds: [], prompt: 'x', count: 1 },
    ])
      expectError(await run(guest, w.board, body), 403, 'GUEST_ACCOUNT_REQUIRED')
    expect(w.openai.requests).toHaveLength(0)
    expect(w.sync.snapshots).toHaveLength(0)
  })

  it('export policy "editors": the people it limits get no AI; editors keep it', async () => {
    const res = await w.alice.req('PUT', `/api/boards/${w.board}/export-policy`, { exportPolicy: 'editors' })
    expect(res.statusCode, res.body).toBe(200)
    for (const c of [w.carol, w.dave]) {
      expect(await status(c)).toMatchObject({ enabled: false, reason: 'export-policy' })
      expectError(
        await run(c, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'panel' }),
        403,
        'AI_EXPORT_DISABLED',
      )
    }
    expect(w.openai.requests).toHaveLength(0)
    expect(await status(w.bob)).toMatchObject({ enabled: true, canInsert: true })
    expect((await run(w.bob, w.board, { action: 'themes', shapeIds: [FRAME] })).statusCode).toBe(200)
  })

  it('the first call per person per workspace needs the OpenAI notice acknowledged, then never again', async () => {
    const body = { action: 'summarize', shapeIds: [FRAME], mode: 'panel' }
    const first = await w.bob.req('POST', `/api/boards/${w.board}/ai/run`, body)
    expectError(first, 409, 'AI_NOTICE_REQUIRED')
    expect(w.openai.requests).toHaveLength(0)
    expect(w.sync.snapshots).toHaveLength(0)
    expect((await status(w.bob)).noticeAccepted).toBe(false)
    const ok = await w.bob.req('POST', `/api/boards/${w.board}/ai/run`, { ...body, acknowledged: true })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await status(w.bob)).noticeAccepted).toBe(true)
    const again = await w.bob.req('POST', `/api/boards/${w.board}/ai/run`, body)
    expect(again.statusCode, again.body).toBe(200)
    // Someone else still has to see it.
    expectError(await w.carol.req('POST', `/api/boards/${w.board}/ai/run`, body), 409, 'AI_NOTICE_REQUIRED')
  })

  it('refuses malformed requests: unknown action, too many ids, bad ids, long or empty prompts, counts', async () => {
    const bad = [
      { action: 'translate', shapeIds: [FRAME] },
      { action: 'themes', shapeIds: [] },
      { action: 'themes', shapeIds: Array.from({ length: 201 }, (_, i) => `shape:n${i}`) },
      { action: 'themes', shapeIds: ['not-a-shape'] },
      { action: 'themes', shapeIds: ['shape:has space'] },
      { action: 'summarize', shapeIds: [FRAME] },
      { action: 'ideas', shapeIds: [], prompt: '', count: 3 },
      { action: 'ideas', shapeIds: [], prompt: 'x'.repeat(201), count: 3 },
      { action: 'ideas', shapeIds: [], prompt: 'ok', count: 13 },
      { action: 'ideas', shapeIds: [], prompt: 'ok', count: 0 },
    ]
    for (const body of bad) expectError(await run(w.bob, w.board, body), 400, 'BAD_REQUEST')
    expect(w.openai.requests).toHaveLength(0)
  })
})

describe('without AI', () => {
  afterEach(() => w.close())

  it('no key: AI is not configured, the route refuses and nothing is called', async () => {
    w = await aiWorld({ key: null })
    expect(await status(w.alice)).toEqual({
      enabled: false,
      reason: 'not-configured',
      canInsert: false,
      canSummarize: false,
      noticeAccepted: false,
      budget: null,
      settings: null,
    })
    expectError(
      await run(w.alice, w.board, { action: 'themes', shapeIds: [FRAME] }),
      503,
      'AI_NOT_CONFIGURED',
    )
    expect(w.openai.requests).toHaveLength(0)
  })

  it('DRAFTROOM_AI=off is the kill switch: hidden, refused, nothing read or called', async () => {
    w = await aiWorld({ env: { DRAFTROOM_AI: 'off' } })
    w.sync.setBoard(w.board, brainstormShapes())
    expect(await status(w.alice)).toMatchObject({ enabled: false, reason: 'turned-off' })
    expectError(await run(w.alice, w.board, { action: 'themes', shapeIds: [FRAME] }), 503, 'AI_TURNED_OFF')
    expect(w.openai.requests).toHaveLength(0)
    expect(w.sync.snapshots).toHaveLength(0)
    expect((await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM ai_usage')).n).toBe(0)
  })
})
