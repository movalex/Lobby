// Wave M (M8-1, owner W8; landed by the foundation): the per-board AI gate and the AI status as exported loaders
// (src/features/ai/index.ts createAiLoaders: aiGateFor, loadAiStatus), with the rules GET /api/boards/:bid/ai and
// POST …/ai/run had: per role and per policy (the board switch, the export policy, a guest, AI off for Lobby, no
// key), and loadAiStatus equal to the status route's own body for the same caller (what W5's open-state reuses).

import { afterEach, describe, expect, it } from 'vitest'
import { loadBoardAccess } from '../../../src/access.ts'
import { createAiLoaders } from '../../../src/features/ai/index.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { type AiWorld, aiWorld, statusUrl } from './support.ts'

let w: AiWorld | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

async function gateOf(world: AiWorld, userId: string) {
  const loaders = createAiLoaders({ db: world.api.db, config: world.api.config, now: () => new Date() })
  const access = await loadBoardAccess(world.api.db, world.board, userId)
  if (!access) throw new Error('no access')
  const gate = await loaders.aiGateFor(access, userId)
  // the same through a transaction's connection (open-state's READ ONLY transaction)
  const inTx = await world.api.db.transaction((tx) => loaders.aiGateFor(access, userId, tx))
  expect(inTx).toEqual(gate)
  return { gate, status: await loaders.loadAiStatus(access, userId), loaders, access }
}

const short = (g: {
  allowed: boolean
  reason: string | null
  canInsert: boolean
  canSummarize: boolean
}) => ({
  allowed: g.allowed,
  reason: g.reason,
  canInsert: g.canInsert,
  canSummarize: g.canSummarize,
})

describe('aiGateFor', () => {
  it('per role: everyone who may view may use AI, editors and owners may insert', async () => {
    w = await aiWorld()
    const world = w
    const on = (canInsert: boolean) => ({ allowed: true, reason: null, canInsert, canSummarize: true })
    expect(short((await gateOf(world, world.alice.userId)).gate)).toEqual(on(true))
    expect(short((await gateOf(world, world.bob.userId)).gate)).toEqual(on(true))
    expect(short((await gateOf(world, world.carol.userId)).gate)).toEqual(on(false))
    expect(short((await gateOf(world, world.dave.userId)).gate)).toEqual(on(false))
  })

  it('per policy: the board switch off, the export policy for those it limits, a guest', async () => {
    w = await aiWorld()
    const world = w
    const off = (reason: string) => ({ allowed: false, reason, canInsert: false, canSummarize: false })
    // export policy 'editors': commenters and viewers get no AI (it reads the content out)
    const pol = await world.alice.req('PUT', `/api/boards/${world.board}/export-policy`, {
      exportPolicy: 'editors',
    })
    expect(pol.statusCode, pol.body).toBe(200)
    expect(short((await gateOf(world, world.bob.userId)).gate).allowed).toBe(true)
    expect(short((await gateOf(world, world.carol.userId)).gate)).toEqual(off('export-policy'))
    expect(short((await gateOf(world, world.dave.userId)).gate)).toEqual(off('export-policy'))
    // the board's AI switch off: nobody
    const sw = await world.alice.req('PUT', `/api/boards/${world.board}/ai/settings`, { enabled: false })
    expect(sw.statusCode, sw.body).toBe(200)
    for (const c of [world.alice, world.bob, world.carol, world.dave])
      expect(short((await gateOf(world, c.userId)).gate)).toEqual(off('board-off'))
    // a name-only guest (a guest link on the board)
    const sam = await joinAsGuest(
      world.api,
      (await guestLink(world.alice, world.board, { role: 'editor' })).url,
      'Sam',
    )
    const g = (await gateOf(world, sam.userId)).gate
    expect(short(g)).toEqual(off('guest'))
    expect(g.settings).toBeNull()
  })

  it('AI off for Lobby, and no key: turned-off and not-configured', async () => {
    w = await aiWorld({ env: { DRAFTROOM_AI: 'off' } })
    expect(short((await gateOf(w, w.alice.userId)).gate)).toMatchObject({
      allowed: false,
      reason: 'turned-off',
    })
    await w.close()
    w = await aiWorld({ key: null })
    expect(short((await gateOf(w, w.alice.userId)).gate)).toMatchObject({
      allowed: false,
      reason: 'not-configured',
    })
  })
})

describe('loadAiStatus', () => {
  it('is the status route’s own body for every caller', async () => {
    w = await aiWorld()
    const world = w
    for (const c of [world.alice, world.bob, world.carol, world.dave]) {
      const res = await c.req('GET', statusUrl(world.board))
      expect(res.statusCode, res.body).toBe(200)
      expect((await gateOf(world, c.userId)).status, c.userId).toEqual(res.json())
    }
    await world.alice.req('PUT', `/api/boards/${world.board}/ai/settings`, { enabled: false })
    const res = await world.bob.req('GET', statusUrl(world.board))
    expect((await gateOf(world, world.bob.userId)).status).toEqual(res.json())
  })
})
