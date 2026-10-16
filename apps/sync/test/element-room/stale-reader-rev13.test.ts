// CONTRACTS_REV 14 (wave T, WS1; docs/WAVE-T-CONTRACTS.md §3.6, EXCALIDRAW-CONTRACTS §0b rules 5-8): the per-reader and
// per-writer rules for the four planning key classes (`card:*`, `sb:*`, `kanban`, `timeline`) against the REAL room
// with DRAFTROOM_PLANNING on. The web deployed since wave S (6769e07, rev 13) parses every server frame with its own
// build's strict schemas and drops a whole frame it refuses; here a socket of that web is a protocol client that parses
// with exactly those schemas (packages/canvas-schema/test/fixtures/rev13-6769e07) and names rev=13 in its connect URL,
// as that web does. Beside it, this build's web core (the rev-14 headless client) makes and edits cards, panels, a
// Kanban and a timeline. The rev-13 socket:
//  - parses EVERY frame it gets (none in `schemaErrors`), and no `p` op it is sent names a planning key (each reaches
//    it as the `c` op of the stored element);
//  - holds exactly the server's board (the convergence hash, the planning keys included) live, after a catch-up and
//    after a reset;
//  - writes as rev 13: its text edit in a card and its move of a panel commit and keep the keys; its duplicate (its own
//    tx.ts drops keys it has no spec for) and its Excalidraw paste (keeps them) of a card make plain notes, never
//    INVALID (each stripped key in the ack's fix), while the original keeps them; its delete then undo (a `life`
//    patch, or a create over the tombstone) keeps them;
//  - and a tab of it that only receives pushes nothing. This build's own core, receiving the same, pushes nothing too
//    (the echo rule: a receiving client writes no layout, renumbering or status).
// With DRAFTROOM_OLD_WEB_SRC (the 6769e07 sources with node_modules, see e2e/excalidraw/l-compat-kit.ts) the same is
// also run with that build's OWN headless core (its socket transport, its engine), not only its schemas.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hashElements } from '@draftroom/canvas-schema/hash'
import { isPlanningKey } from '@draftroom/canvas-schema/planning-keys'
import { CONNECT_REV_PARAM, CONTRACTS_REV, type ServerOp } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import * as Old from '../../../../packages/canvas-schema/test/fixtures/rev13-6769e07/protocol.ts'
import type { FrameSchemas, ProtocolClient } from '../harness/element-client.ts'
import { elementTicket } from '../harness/element-client.ts'
import { type ElementStack, newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { type El, frame, noteWithLabel, rect, text } from '../harness/elements.ts'
import { TicketWebSocket } from '../harness/tickets.ts'
import { sleep } from '../harness/wait.ts'

const shared = sharedElementStack()

/** How the deployed web (6769e07) parses a server frame: its own frozen schemas. */
const REV13_WEB: FrameSchemas = {
  ServerMessage: Old.ServerMessage as unknown as FrameSchemas['ServerMessage'],
  decodeSnapshotFrame: Old.decodeSnapshotFrame,
}
type Opts = Partial<Parameters<ElementStack['client']>[0]>
/** A tab of the deployed web: rev=13 in its connect URL, its frames parsed by its own schemas. */
const rev13Tab = (st: ElementStack, boardId: string, user: string, o: Opts = {}) =>
  st.client({ boardId, user, schemas: REV13_WEB, query: { [CONNECT_REV_PARAM]: '13' }, ...o })
/** A raw tab of this build (rev 14). */
const rev14Tab = (st: ElementStack, boardId: string, user: string, o: Opts = {}) =>
  st.client({ boardId, user, query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) }, ...o })

const lobbyOf = (el: El | undefined) => (el?.customData?.lobby ?? {}) as Record<string, unknown>
const planningOf = (el: El | undefined) =>
  Object.fromEntries(Object.entries(lobbyOf(el)).filter(([k]) => isPlanningKey(k)))
const storedPlanning = async (st: ElementStack, b: string, id: string) => planningOf(await st.stored(b, id))

/** Every frame the rev-13 socket got parsed with its schemas, and none of its `p` ops names a planning key. */
function expectEveryFrameParsed(old: ProtocolClient): void {
  expect(old.schemaErrors, 'frames the deployed web’s socket would drop').toEqual([])
  expect(old.received.length, 'frames received = frames parsed').toBe(old.rawFrames.length)
  const ops: ServerOp[] = []
  for (const m of old.received) {
    if (m.type === 'changes') ops.push(...m.ops)
    if (m.type === 'welcome') ops.push(...(m.catchUp ?? []))
  }
  const named = ops.filter((op) => op.k === 'p' && Object.keys((op.c ?? {}) as object).some(isPlanningKey))
  expect(named, 'p ops naming a planning key sent to a rev-13 reader').toEqual([])
}

type Core = Awaited<ReturnType<ElementStack['headless']>>
/** A rev-14 core's planning write on `id`, as the web's planning features write it (keys of customData.lobby). */
function plan(core: Core, id: string, keys: Record<string, unknown>) {
  const el = core.core.elements().get(id) as El
  const lobby = { ...lobbyOf(el) }
  for (const [k, v] of Object.entries(keys))
    if (v === null) delete lobby[k]
    else lobby[k] = v
  core.change(id, { customData: { ...(el.customData ?? {}), lobby } })
}

const CARD = { 'card:status': 'todo', 'card:start': '2026-10-01', 'card:due': '2026-10-30' }
const HEAD = { 'sb:head': { aspect: '16:9', fps: 24 } }
const panel = (pos: string, dur = 2000) => ({ 'sb:of': 'head', 'sb:pos': pos, 'sb:dur': dur })
const KANBAN = { kanban: { labels: { doing: 'Now' }, wip: { doing: 2 } } }
const TIMELINE = { timeline: { start: '2026-10-01', end: '2026-12-31', scale: 'week', lanes: 'status' } }

/** A board with a note, a rectangle, a free text and three frames, made by `fac` (rev 14). */
async function board(st: ElementStack, b: string) {
  const fac = await rev14Tab(st, b, 'fac', { role: 'owner' })
  const made = await fac.create([
    ...noteWithLabel('n1', 'Write the brief'),
    rect('r1', { x: 400 }),
    text('head', { y: -200 }),
    frame('p1', { y: 400 }),
    frame('p2', { x: 900, y: 400 }),
    frame('k1', { y: 1200 }),
    frame('t1', { x: 900, y: 1200 }),
  ])
  expect(made.r.filter((r) => !r.ok)).toEqual([])
  return fac
}

describe('CONTRACTS_REV 14 against a tab of the deployed web (6769e07, rev 13): every frame it parses, every change it holds', () => {
  it('cards, panels, a Kanban and a timeline made by this build’s core reach it in every frame it parses, and its copy stays the server’s: live, after a catch-up, after a reset', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await board(st, b)
    const old = await rev13Tab(st, b, 'old-web')
    const watcher = await rev13Tab(st, b, 'old-watcher', { tab: 'tab-old-watcher' })
    const alice = await st.headless({ boardId: b, user: 'alice' })
    const bob = await st.headless({ boardId: b, user: 'bob' })
    // made, alone and with other edits in the same commit, by two people; a status change and an unmake
    plan(alice, 'n1', CARD)
    plan(alice, 'head', HEAD)
    plan(alice, 'p1', panel('a0'))
    plan(alice, 'p2', panel('a1'))
    await alice.saved()
    plan(bob, 'r1', { 'card:status': 'doing' })
    plan(bob, 'k1', KANBAN)
    bob.change('r1', { x: 450 })
    await bob.saved()
    plan(alice, 't1', TIMELINE)
    plan(alice, 'n1', { 'card:status': 'review' })
    // the actor's reorder (p2 before p1) and duration in one commit
    plan(alice, 'p2', { 'sb:pos': 'Zz', 'sb:dur': 3500 })
    await alice.saved()
    plan(bob, 'r1', { 'card:status': null })
    await bob.saved()
    const clock = (await st.snapshot(b)).clock
    await old.untilClock(clock)
    await watcher.untilClock(clock)
    await st.converged(b, [old, watcher, fac, alice, bob])
    expectEveryFrameParsed(old)
    expect(planningOf(old.confirmed.get('n1'))).toEqual({ ...CARD, 'card:status': 'review' })
    expect(planningOf(old.confirmed.get('p2'))).toEqual(panel('Zz', 3500))
    expect(planningOf(old.confirmed.get('r1'))).toEqual({})

    // away: changes made while the tab is gone come back in its catch-up (the welcome's `c` ops)
    const held = new Map(old.confirmed)
    const since = old.clock
    const epoch = old.epoch
    old.close()
    await old.untilClosed()
    plan(bob, 'p1', { 'sb:dur': 1200 })
    plan(bob, 'n1', { 'card:status': 'done', 'card:due': '2026-11-02' })
    await bob.saved()
    const back = await rev13Tab(st, b, 'old-web', { tab: 'tab-old-web-2', since, epoch, confirmed: held })
    expect(back.welcome?.reset).toBe(false)
    await st.converged(b, [back, alice, bob])
    expectEveryFrameParsed(back)
    expect(planningOf(back.confirmed.get('p1'))).toEqual(panel('a0', 1200))
    // a fresh open of the deployed web: the reset snapshot (whole elements), then live again
    const fresh = await rev13Tab(st, b, 'old-web-3', { tab: 'tab-old-web-3' })
    expect(fresh.welcome?.reset).toBe(true)
    plan(alice, 'k1', { kanban: { hidden: ['blocked'] } })
    await alice.saved()
    await fresh.untilClock(alice.core.clock)
    await st.converged(b, [fresh, back, watcher, alice, bob])
    expectEveryFrameParsed(fresh)
    expectEveryFrameParsed(watcher)
    // the tabs that only received pushed nothing, and are still open (no 4099, no reconnect); this build's core
    // that only received (bob, after his last write) pushed nothing either
    expect(watcher.of('ack')).toEqual([])
    expect(watcher.isOpen).toBe(true)
    const bobPushes = bob.core.pushLog().length
    await sleep(300)
    expect(bob.core.pushLog().length, 'a receiving rev-14 core pushes nothing (no echo)').toBe(bobPushes)
  })

  it('its text edit in a card and its move of a panel commit and keep the keys', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await board(st, b)
    expect((await fac.patch('n1', { c: CARD })).ok).toBe(true)
    expect((await fac.patch('head', { c: HEAD })).ok).toBe(true)
    expect((await fac.patch('p1', { c: panel('a0') })).ok).toBe(true)
    const old = await rev13Tab(st, b, 'old-web')
    expect((await old.acquire('n1')).type).toBe('lease.grant')
    const ack = await old.push([
      old.patchOp('n1.t', { g: { text: { originalText: 'new words' }, layout: { text: 'new words' } } }),
      old.patchOp('n1', { fit: { height: 220 } }),
      old.patchOp('p1', { g: { pos: { x: 50, y: 450 } } }),
    ])
    expect(ack.r.map((r) => r.ok)).toEqual([true, true, true])
    old.release('n1')
    expect((await st.stored(b, 'n1.t'))?.originalText).toBe('new words')
    expect(await storedPlanning(st, b, 'n1')).toEqual(CARD)
    expect(await storedPlanning(st, b, 'p1')).toEqual(panel('a0'))
    // its patch naming a key it cannot know (a diff against a copy it never wrote): dropped, no refusal
    expect((await old.patch('n1', { c: { 'card:status': 'done' } })).ok).toBe(true)
    expect(await storedPlanning(st, b, 'n1')).toEqual(CARD)
    await fac.untilClock(old.clock)
    await st.converged(b, [old, fac])
    expectEveryFrameParsed(old)
  })

  it('its duplicate and its paste of a card make plain notes (no INVALID; each key in the fix); the original keeps them', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await board(st, b)
    expect((await fac.patch('n1', { c: { ...CARD, 'card:who': 'fac' } })).ok).toBe(false) // fac is no account here
    st.api.setAssignees(b, ['usr_ann'])
    expect((await fac.patch('n1', { c: { ...CARD, 'card:who': 'usr_ann' } })).ok).toBe(true)
    expect((await fac.patch('p1', { c: panel('a0') })).ok).toBe(true)
    const old = await rev13Tab(st, b, 'old-web')
    const n1 = old.confirmed.get('n1') as El
    const p1 = old.confirmed.get('p1') as El
    // its own duplicate (tx.ts duplicateLobbyData: keys it has no spec for are dropped)
    const [dup, dupT] = noteWithLabel('dup1', 'Write the brief', { x: 700 })
    // an Excalidraw-native paste: the note and the panel as it holds them, planning keys included
    const [paste, pasteT] = noteWithLabel('paste1', 'Write the brief', { x: 1400, customData: n1.customData })
    const pastePanel = frame('paste2', { x: 2000, customData: p1.customData })
    const ack = await old.push([
      { k: 'c', el: dup },
      { k: 'c', el: dupT },
      { k: 'c', el: paste },
      { k: 'c', el: pasteT },
      { k: 'c', el: pastePanel },
    ])
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect((ack.r[2] as { fix?: Record<string, unknown> }).fix).toMatchObject({
      'c:card:status': null,
      'c:card:who': null,
      'c:card:due': null,
    })
    expect((ack.r[4] as { fix?: Record<string, unknown> }).fix).toMatchObject({
      'c:sb:of': null,
      'c:sb:pos': null,
    })
    for (const id of ['dup1', 'paste1', 'paste2']) expect(await storedPlanning(st, b, id)).toEqual({})
    expect(await storedPlanning(st, b, 'n1')).toEqual({ ...CARD, 'card:who': 'usr_ann' })
    await fac.untilClock(old.clock)
    await st.converged(b, [old, fac])
    expectEveryFrameParsed(old)
  })

  it('its delete then undo (a life patch, or a create over the tombstone) keeps the keys', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await board(st, b)
    st.api.setAssignees(b, ['usr_ann'])
    expect((await fac.patch('n1', { c: { ...CARD, 'card:who': 'usr_ann' } })).ok).toBe(true)
    expect((await fac.patch('p1', { c: panel('a0') })).ok).toBe(true)
    const old = await rev13Tab(st, b, 'old-web')
    // undo by patch: life false on its tombstone's version
    for (const id of ['n1', 'n1.t'])
      expect((await old.patch(id, { g: { life: { isDeleted: true } } })).ok).toBe(true)
    const undo = await old.push(
      ['n1', 'n1.t'].map((id) => old.patchOp(id, { g: { life: { isDeleted: false } } })),
    )
    expect(undo.r.map((r) => r.ok)).toEqual([true, true])
    expect(await storedPlanning(st, b, 'n1')).toEqual({ ...CARD, 'card:who': 'usr_ann' })
    // undo by create: the panel as it held it, back whole over its tombstone (and the api down: no lookup needed)
    const held = structuredClone(old.confirmed.get('p1') as El)
    expect((await old.patch('p1', { g: { life: { isDeleted: true } } })).ok).toBe(true)
    st.api.assigneeMode = 'error'
    try {
      const back = await old.push([{ k: 'c', el: { ...held, version: held.version + 2 } }])
      expect(back.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok'])
      expect(
        Object.keys((back.r[0] as { fix?: object }).fix ?? {}).filter((k) => k.startsWith('c:sb:')),
      ).toEqual([])
    } finally {
      st.api.assigneeMode = 'ok'
    }
    expect(await storedPlanning(st, b, 'p1')).toEqual(panel('a0'))
    await fac.untilClock(old.clock)
    await st.converged(b, [old, fac])
    expectEveryFrameParsed(old)
  })
})

// ---- the same with the deployed build's OWN headless core (its socket transport and its engine) --------------------

const OLD_WEB = process.env.DRAFTROOM_OLD_WEB_SRC ? resolve(process.env.DRAFTROOM_OLD_WEB_SRC) : null
const OLD_HEADLESS = OLD_WEB ? join(OLD_WEB, 'apps/web/src/canvas/sync/headless/index.ts') : null
const oldCoreReady =
  !!OLD_HEADLESS && existsSync(OLD_HEADLESS) && existsSync(join(OLD_WEB as string, 'node_modules'))

interface OldHeadless {
  readonly core: {
    elements(): ReadonlyMap<string, El>
    pushLog(): readonly unknown[]
    readonly clock: number
    readonly saveStatus: { readonly lastReject: { id: string; code: string } | null }
  }
  connect(): Promise<unknown>
  close(): Promise<void>
  saved(): Promise<void>
  change(id: string, patch: Readonly<Record<string, unknown>>): void
}

describe.skipIf(!oldCoreReady)(
  'the deployed web’s OWN core (6769e07, DRAFTROOM_OLD_WEB_SRC) beside cards and panels',
  () => {
    it('receives every planning change, holds the server’s board, pushes nothing while it only receives, and its edit of a card keeps the keys', async () => {
      const st = shared.get()
      const b = newBoardId()
      const mod = (await import(pathToFileURL(OLD_HEADLESS as string).href)) as {
        createLobbyHeadlessClient(o: Record<string, unknown>): OldHeadless
      }
      // that build's own modules (its canvas-schema, rev 13), not this tree's: its connect URL names rev 13
      const transport = (await import(
        pathToFileURL(join(OLD_WEB as string, 'apps/web/src/canvas/sync/transport/socket.ts')).href
      )) as { connectQuery(tab: string): URLSearchParams }
      expect(transport.connectQuery('t').get(CONNECT_REV_PARAM)).toBe('13')
      const fac = await board(st, b)
      const open = async (user: string) => {
        const c = mod.createLobbyHeadlessClient({
          syncUrl: st.server.wsUrl,
          boardId: b,
          tab: `old-core-${user}`,
          ticket: elementTicket(b, user),
          refreshTicket: async () => elementTicket(b, user),
          WebSocketImpl: TicketWebSocket,
        })
        await c.connect()
        return Object.assign(c, { hash: () => hashElements(c.core.elements().values()) })
      }
      const oldCore = await open('old-core')
      const oldWatch = await open('old-watch')
      const alice = await st.headless({ boardId: b, user: 'alice' })
      plan(alice, 'r1', { 'card:status': 'todo', 'card:due': '2026-10-30' })
      plan(alice, 'head', HEAD)
      plan(alice, 'p1', panel('a0'))
      plan(alice, 'p2', panel('a1'))
      alice.change('n1', { x: 30 })
      await alice.saved()
      plan(alice, 'p2', { 'sb:pos': 'Zz' })
      plan(alice, 'r1', { 'card:status': 'blocked' })
      plan(alice, 't1', TIMELINE)
      await alice.saved()
      await st.converged(b, [oldCore, oldWatch, alice, fac])
      expect(planningOf(oldCore.core.elements().get('r1'))).toEqual({
        'card:status': 'blocked',
        'card:due': '2026-10-30',
      })
      expect(planningOf(oldCore.core.elements().get('p2'))).toEqual(panel('Zz'))
      await sleep(300)
      expect(oldWatch.core.pushLog()).toEqual([])
      expect(oldCore.core.pushLog()).toEqual([])
      // its own edit of the card (a recolour) and its move of the panel: commit, the keys stay
      const r1 = oldCore.core.elements().get('r1') as El
      oldCore.change('r1', { backgroundColor: r1.backgroundColor === '#ffc9c9' ? '#d0bfff' : '#ffc9c9' })
      oldCore.change('p1', { x: 40 })
      await oldCore.saved()
      expect(oldCore.core.saveStatus.lastReject).toBeNull()
      expect(await storedPlanning(st, b, 'r1')).toEqual({
        'card:status': 'blocked',
        'card:due': '2026-10-30',
      })
      expect(await storedPlanning(st, b, 'p1')).toEqual(panel('a0'))
      await st.converged(b, [oldCore, oldWatch, alice, fac])
      expect(oldWatch.core.pushLog()).toEqual([])
      await Promise.all([oldCore.close(), oldWatch.close()])
    })
  },
)

if (!oldCoreReady)
  describe('the deployed web’s own core (6769e07)', () => {
    it.skip('needs DRAFTROOM_OLD_WEB_SRC: the 6769e07 sources with node_modules (e2e/excalidraw/l-compat-kit.ts)', () => {})
  })
