// AI on/off per board and per workspace (reviewer finding DANA-04; settings.ts). Board owners decide for
// a board, workspace owners and admins decide the default, and the api refuses every AI call where it is
// off, before anything is read from the board or sent to OpenAI.

import { AiSettings, AiStatus } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { brainstormShapes, FRAME } from './fixtures.ts'
import { type AiWorld, aiWorld, expectError, run, statusUrl } from './support.ts'

let w: AiWorld

const status = async (c: { req: AiWorld['alice']['req'] }, board = w.board) => {
  const res = await c.req('GET', statusUrl(board))
  expect(res.statusCode, res.body).toBe(200)
  return AiStatus.parse(res.json())
}
const boardSettings = (board = w.board) => `/api/boards/${board}/ai/settings`
const workspaceSettings = (ws = DEV_STUDIO) => `/api/workspaces/${ws}/ai/settings`

describe('AI on/off per board and per workspace', () => {
  beforeEach(async () => {
    w = await aiWorld()
    w.sync.setBoard(w.board, brainstormShapes())
  })
  afterEach(() => w.close())

  it('is on by default; only owners may change the board, only owners and admins the workspace', async () => {
    expect((await status(w.alice)).settings).toEqual({
      board: null,
      workspaceDefault: true,
      on: true,
      canManageBoard: true,
      canManageWorkspace: true,
    })
    expect((await status(w.bob)).settings).toMatchObject({ on: true, canManageBoard: false })
    for (const c of [w.bob, w.carol, w.dave])
      expectError(await c.req('PUT', boardSettings(), { enabled: false }), 403, 'FORBIDDEN')
    expectError(await w.erin.req('PUT', boardSettings(), { enabled: false }), 404, 'NOT_FOUND')
    expectError(await w.api.anon('PUT', boardSettings(), { enabled: false }), 401, 'NOT_AUTHENTICATED')
    expectError(await w.bob.req('PUT', workspaceSettings(), { enabled: false }), 403, 'FORBIDDEN')
    expectError(await w.erin.req('PUT', workspaceSettings(), { enabled: false }), 404, 'NOT_FOUND')
    expectError(await w.alice.req('PUT', boardSettings(), { enabled: 'off' }), 400, 'BAD_REQUEST')
    expect((await status(w.bob)).enabled).toBe(true)
  })

  it('a board turned off refuses every AI call, for everyone, before anything is sent', async () => {
    const res = await w.alice.req('PUT', boardSettings(), { enabled: false })
    expect(res.statusCode, res.body).toBe(200)
    expect(AiSettings.parse(res.json())).toMatchObject({ board: false, on: false, canManageBoard: true })
    for (const c of [w.alice, w.bob, w.carol]) {
      const s = await status(c)
      expect(s).toMatchObject({ enabled: false, reason: 'board-off', canInsert: false, canSummarize: false })
      expect(s.settings?.on).toBe(false)
    }
    expectError(
      await run(w.bob, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'panel' }),
      403,
      'AI_BOARD_OFF',
    )
    expectError(await run(w.alice, w.board, { action: 'themes', shapeIds: [FRAME] }), 403, 'AI_BOARD_OFF')
    expectError(
      await run(w.carol, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'panel' }),
      403,
      'AI_BOARD_OFF',
    )
    expect(w.openai.requests).toHaveLength(0)
    expect(w.sync.snapshots).toHaveLength(0)

    // Back on: works again.
    expect((await w.alice.req('PUT', boardSettings(), { enabled: true })).statusCode).toBe(200)
    const ok = await run(w.bob, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'panel' })
    expect(ok.statusCode, ok.body).toBe(200)
  })

  it('the workspace default applies to boards without their own choice; a board choice wins', async () => {
    const other = await createBoard(w.alice, DEV_STUDIO, 'Client review')
    const res = await w.alice.req('PUT', workspaceSettings(), { enabled: false })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ enabled: false })
    expect(await status(w.alice, other)).toMatchObject({ enabled: false, reason: 'board-off' })
    expect((await status(w.bob)).settings).toMatchObject({ board: null, workspaceDefault: false, on: false })

    // This board opts back in; the other still follows the default.
    expect((await w.alice.req('PUT', boardSettings(), { enabled: true })).statusCode).toBe(200)
    expect(await status(w.bob)).toMatchObject({ enabled: true, reason: null })
    expect(await status(w.alice, other)).toMatchObject({ enabled: false, reason: 'board-off' })

    // null: follow the workspace again.
    const back = await w.alice.req('PUT', boardSettings(), { enabled: null })
    expect(AiSettings.parse(back.json())).toMatchObject({ board: null, workspaceDefault: false, on: false })
    expectError(
      await run(w.bob, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'panel' }),
      403,
      'AI_BOARD_OFF',
    )
    expect(w.openai.requests).toHaveLength(0)
  })

  it('name-only guests never see or change the settings', async () => {
    const link = await guestLink(w.alice, w.board, { role: 'editor' })
    const guest = await joinAsGuest(w.api, link.url, 'Priya')
    expect((await status(guest)).settings).toBeNull()
    const res = await guest.req('PUT', boardSettings(), { enabled: false })
    expectError(res, 403, 'FORBIDDEN')
    expect((await status(w.bob)).enabled).toBe(true)
  })
})
