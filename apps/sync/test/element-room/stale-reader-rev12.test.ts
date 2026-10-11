// CONTRACTS_REV 13 (wave N, N2-6 proof (2)): the per-reader and per-writer rules for the reaction key class
// (`react:<code>:<uid>`; canvas-schema protocol.ts LOBBY_KEY_ADDITIONS, `frameForReader`, `lobbyPatchOfWriter`,
// `lobbyCreateOfWriter`) against the REAL room. The web deployed on staging (3c83611, rev 12) parses every server
// frame with its own build's strict schemas and drops a whole frame it refuses; here a socket of that web is a
// protocol client that parses with exactly those schemas (packages/canvas-schema/test/fixtures/rev12-3c83611) and
// names rev=12 in its connect URL, as that web does. Beside it, this build's web core (the rev-13 headless client:
// the client code browsers run) reacts. The rev-12 socket:
//  - parses EVERY frame it gets: frames received equal frames parsed (none in `schemaErrors`), and no `p` op it is
//    sent names a reaction key (each reaches it as the `c` op of the stored note);
//  - holds exactly the server's board (the convergence hash, tombstones included) after reactions, removals and an
//    owner's Clear reactions, live, after a catch-up and after a reset;
//  - writes as rev 12: its text edit in a reacted note commits and keeps the reactions; its duplicate (its own tx.ts
//    drops unknown keys) and its Excalidraw paste (keeps them) make copies without reactions, never INVALID, while
//    the original keeps them; its delete then undo (a `life` patch, or a create over the tombstone) keeps them;
//  - and a tab of it that only receives pushes nothing.
// With DRAFTROOM_OLD_WEB_SRC (the 3c83611 sources with node_modules, see e2e/excalidraw/l-compat-kit.ts) the same
// is also run with that build's OWN headless core (its socket transport, its engine), not only its schemas.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hashElements } from '@draftroom/canvas-schema/hash'
import { CONNECT_REV_PARAM, CONTRACTS_REV, type ServerOp } from '@draftroom/canvas-schema/protocol'
import { reactionKey } from '@draftroom/canvas-schema/reactions'
import { describe, expect, it } from 'vitest'
import * as Old from '../../../../packages/canvas-schema/test/fixtures/rev12-3c83611/protocol.ts'
import type { FrameSchemas, ProtocolClient } from '../harness/element-client.ts'
import { elementTicket } from '../harness/element-client.ts'
import { type ElementStack, newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { type El, noteWithLabel, rect } from '../harness/elements.ts'
import { TicketWebSocket } from '../harness/tickets.ts'
import { sleep } from '../harness/wait.ts'

const shared = sharedElementStack()

/** How the deployed web (3c83611) parses a server frame: its own frozen schemas. */
const REV12_WEB: FrameSchemas = {
  ServerMessage: Old.ServerMessage as unknown as FrameSchemas['ServerMessage'],
  decodeSnapshotFrame: Old.decodeSnapshotFrame,
}
type Opts = Partial<Parameters<ElementStack['client']>[0]>
/** A tab of the deployed web: rev=12 in its connect URL, its frames parsed by its own schemas. */
const rev12Tab = (st: ElementStack, boardId: string, user: string, o: Opts = {}) =>
  st.client({ boardId, user, schemas: REV12_WEB, query: { [CONNECT_REV_PARAM]: '12' }, ...o })
/** A raw tab of this build (rev 13). */
const rev13Tab = (st: ElementStack, boardId: string, user: string, o: Opts = {}) =>
  st.client({ boardId, user, query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) }, ...o })

const lobbyOf = (el: El | undefined) => (el?.customData?.lobby ?? {}) as Record<string, unknown>
const reactionsIn = (el: El | undefined) =>
  Object.keys(lobbyOf(el))
    .filter((k) => k.startsWith('react:'))
    .sort()
const storedReactions = async (st: ElementStack, b: string, id: string) => reactionsIn(await st.stored(b, id))

/** Every frame the rev-12 socket got parsed with its schemas, and none of its `p` ops names a reaction key. */
function expectEveryFrameParsed(old: ProtocolClient): void {
  expect(old.schemaErrors, 'frames the deployed web’s socket would drop').toEqual([])
  expect(old.received.length, 'frames received = frames parsed').toBe(old.rawFrames.length)
  const ops: ServerOp[] = []
  for (const m of old.received) {
    if (m.type === 'changes') ops.push(...m.ops)
    if (m.type === 'welcome') ops.push(...(m.catchUp ?? []))
  }
  const named = ops.filter(
    (op) => op.k === 'p' && Object.keys((op.c ?? {}) as object).some((k) => k.startsWith('react:')),
  )
  expect(named, 'p ops naming a reaction key sent to a rev-12 reader').toEqual([])
}

/** A rev-13 core's reaction (its own uid) on `id`, as the web's reaction bar writes it (a whole customData). */
function react(core: Awaited<ReturnType<ElementStack['headless']>>, id: string, key: string, on: boolean) {
  const el = core.core.elements().get(id) as El
  const lobby = { ...lobbyOf(el) }
  if (on) lobby[key] = true
  else delete lobby[key]
  core.change(id, { customData: { ...(el.customData ?? {}), lobby } })
}

describe('CONTRACTS_REV 13 against a tab of the deployed web (3c83611, rev 12): every frame it parses, every change it holds', () => {
  it('reactions made by this build’s core reach it in every frame it parses, and its copy stays the server’s: live, after a catch-up, after a reset', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await rev13Tab(st, b, 'fac', { role: 'owner' })
    const made = await fac.create([
      ...noteWithLabel('n1', 'first'),
      ...noteWithLabel('n2', 'second', { x: 600 }),
      rect('r1', { x: 1200 }),
    ])
    expect(made.r.filter((r) => !r.ok)).toEqual([])
    const old = await rev12Tab(st, b, 'old-web')
    const watcher = await rev12Tab(st, b, 'old-watcher', { tab: 'tab-old-watcher' })
    const alice = await st.headless({ boardId: b, user: 'alice' })
    const bob = await st.headless({ boardId: b, user: 'bob' })
    // reactions, alone and with other edits in the same commit, from two people; one removed again
    react(alice, 'n1', reactionKey('up', 'alice'), true)
    await alice.saved()
    react(bob, 'n1', reactionKey('heart', 'bob'), true)
    bob.change('r1', { x: 1300 })
    await bob.saved()
    react(alice, 'n2', reactionKey('party', 'alice'), true)
    react(alice, 'n1', reactionKey('laugh', 'alice'), true)
    await alice.saved()
    react(alice, 'n1', reactionKey('laugh', 'alice'), false)
    await alice.saved()
    const clock = (await st.snapshot(b)).clock
    await old.untilClock(clock)
    await watcher.untilClock(clock)
    await st.converged(b, [old, watcher, fac, alice, bob])
    expectEveryFrameParsed(old)
    expect(reactionsIn(old.confirmed.get('n1'))).toEqual([
      reactionKey('heart', 'bob'),
      reactionKey('up', 'alice'),
    ])
    // the room's own clear of everyone's (an owner's Clear reactions) too
    await fac.untilClock(clock)
    expect(
      (await fac.patch('n2', { c: { [reactionKey('party', 'alice')]: null } })).ok,
      'the owner clears alice’s',
    ).toBe(true)
    await old.untilClock(fac.clock)
    await st.converged(b, [old, watcher, fac, alice, bob])
    expectEveryFrameParsed(old)

    // away: reactions made while the tab is gone come back in its catch-up (the welcome's `c` ops)
    const held = new Map(old.confirmed)
    const since = old.clock
    const epoch = old.epoch
    old.close()
    await old.untilClosed()
    react(bob, 'n2', reactionKey('think', 'bob'), true)
    react(bob, 'n1', reactionKey('heart', 'bob'), false)
    await bob.saved()
    const back = await rev12Tab(st, b, 'old-web', { tab: 'tab-old-web-2', since, epoch, confirmed: held })
    expect(back.welcome?.reset).toBe(false)
    await st.converged(b, [back, alice, bob])
    expectEveryFrameParsed(back)
    expect(reactionsIn(back.confirmed.get('n2'))).toEqual([reactionKey('think', 'bob')])
    // a fresh open of the deployed web: the reset snapshot (whole elements), then live again
    const fresh = await rev12Tab(st, b, 'old-web-3', { tab: 'tab-old-web-3' })
    expect(fresh.welcome?.reset).toBe(true)
    react(alice, 'n2', reactionKey('clap', 'alice'), true)
    await alice.saved()
    await fresh.untilClock(alice.core.clock)
    await st.converged(b, [fresh, back, watcher, alice, bob])
    expectEveryFrameParsed(fresh)
    expectEveryFrameParsed(watcher)
    // the tab that only received pushed nothing, and is still open (no 4099, no reconnect)
    expect(watcher.of('ack')).toEqual([])
    expect(watcher.isOpen).toBe(true)
  })

  it('its text edit in a reacted note commits and keeps the reactions', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await rev13Tab(st, b, 'fac', { role: 'owner' })
    await fac.create(noteWithLabel('n1', 'words'))
    expect((await fac.patch('n1', { c: { [reactionKey('up', 'fac')]: true } })).ok).toBe(true)
    const old = await rev12Tab(st, b, 'old-web')
    expect((await old.acquire('n1')).type).toBe('lease.grant')
    const ack = await old.push([
      old.patchOp('n1.t', { g: { text: { originalText: 'new words' }, layout: { text: 'new words' } } }),
      old.patchOp('n1', { fit: { height: 220 } }),
    ])
    expect(ack.r.map((r) => r.ok)).toEqual([true, true])
    old.release('n1')
    expect((await st.stored(b, 'n1.t'))?.originalText).toBe('new words')
    expect(await storedReactions(st, b, 'n1')).toEqual([reactionKey('up', 'fac')])
    await fac.untilClock(old.clock)
    await st.converged(b, [old, fac])
    expectEveryFrameParsed(old)
  })

  it('its duplicate and its paste of a reacted note make copies without reactions (no INVALID); the original keeps them', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await rev13Tab(st, b, 'fac', { role: 'owner' })
    await fac.create(noteWithLabel('n1', 'idea'))
    expect((await fac.patch('n1', { c: { [reactionKey('up', 'fac')]: true } })).ok).toBe(true)
    const old = await rev12Tab(st, b, 'old-web')
    const n1 = old.confirmed.get('n1') as El
    // its own duplicate (tx.ts duplicateLobbyData: keys it has no spec for are dropped)
    const [dup, dupT] = noteWithLabel('dup1', 'idea', { x: 700 })
    // an Excalidraw-native paste: the note as it holds it, reactions included
    const [paste, pasteT] = noteWithLabel('paste1', 'idea', { x: 1400, customData: n1.customData })
    const ack = await old.push([
      { k: 'c', el: dup },
      { k: 'c', el: dupT },
      { k: 'c', el: paste },
      { k: 'c', el: pasteT },
    ])
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect((ack.r[2] as { fix?: Record<string, unknown> }).fix).toMatchObject({
      [`c:${reactionKey('up', 'fac')}`]: null,
    })
    expect(await storedReactions(st, b, 'dup1')).toEqual([])
    expect(await storedReactions(st, b, 'paste1')).toEqual([])
    expect(await storedReactions(st, b, 'n1')).toEqual([reactionKey('up', 'fac')])
    await fac.untilClock(old.clock)
    await st.converged(b, [old, fac])
    expectEveryFrameParsed(old)
  })

  it('its delete then undo (a life patch, or a create over the tombstone) keeps the reactions', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await rev13Tab(st, b, 'fac', { role: 'owner' })
    await fac.create([...noteWithLabel('n1', 'one'), ...noteWithLabel('n2', 'two', { x: 600 })])
    for (const id of ['n1', 'n2'])
      expect((await fac.patch(id, { c: { [reactionKey('heart', 'fac')]: true } })).ok).toBe(true)
    const old = await rev12Tab(st, b, 'old-web')
    const kept = [reactionKey('heart', 'fac')]
    // undo by patch: life false on its tombstone's version
    for (const id of ['n1', 'n1.t'])
      expect((await old.patch(id, { g: { life: { isDeleted: true } } })).ok).toBe(true)
    const undo = await old.push(
      ['n1', 'n1.t'].map((id) => old.patchOp(id, { g: { life: { isDeleted: false } } })),
    )
    expect(undo.r.map((r) => r.ok)).toEqual([true, true])
    expect(await storedReactions(st, b, 'n1')).toEqual(kept)
    // undo by create: the note as it held it, back whole over its tombstone
    const held = structuredClone(old.confirmed.get('n2') as El)
    const heldT = structuredClone(old.confirmed.get('n2.t') as El)
    const del = await old.push(
      ['n2', 'n2.t'].map((id) => old.patchOp(id, { g: { life: { isDeleted: true } } })),
    )
    expect(del.r.every((r) => r.ok)).toBe(true)
    const back = await old.push([
      { k: 'c', el: { ...held, version: held.version + 2 } },
      { k: 'c', el: { ...heldT, version: heldT.version + 2 } },
    ])
    expect(back.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'ok'])
    expect(
      Object.keys((back.r[0] as { fix?: object }).fix ?? {}).filter((k) => k.includes('react:')),
    ).toEqual([])
    expect(await storedReactions(st, b, 'n2')).toEqual(kept)
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
  'the deployed web’s OWN core (3c83611, DRAFTROOM_OLD_WEB_SRC) beside reactions',
  () => {
    it('receives every reaction, holds the server’s board, pushes nothing while it only receives, and its edit of a reacted note keeps them', async () => {
      const st = shared.get()
      const b = newBoardId()
      const mod = (await import(pathToFileURL(OLD_HEADLESS as string).href)) as {
        createLobbyHeadlessClient(o: Record<string, unknown>): OldHeadless
      }
      // that build's own modules (its canvas-schema, rev 12), not this tree's: its connect URL names rev 12
      const transport = (await import(
        pathToFileURL(join(OLD_WEB as string, 'apps/web/src/canvas/sync/transport/socket.ts')).href
      )) as { connectQuery(tab: string): URLSearchParams }
      expect(transport.connectQuery('t').get(CONNECT_REV_PARAM)).toBe('12')
      const fac = await rev13Tab(st, b, 'fac', { role: 'owner' })
      await fac.create([...noteWithLabel('n1', 'idea'), rect('r1', { x: 900 })])
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
      react(alice, 'n1', reactionKey('up', 'alice'), true)
      alice.change('r1', { x: 950 })
      await alice.saved()
      react(alice, 'n1', reactionKey('clap', 'alice'), true)
      await alice.saved()
      await st.converged(b, [oldCore, oldWatch, alice, fac])
      expect(reactionsIn(oldCore.core.elements().get('n1'))).toEqual([
        reactionKey('clap', 'alice'),
        reactionKey('up', 'alice'),
      ])
      await sleep(300)
      expect(oldWatch.core.pushLog()).toEqual([])
      expect(oldCore.core.pushLog()).toEqual([])
      // its own edit of the reacted note (a recolour): commits, the reactions stay
      const n1 = oldCore.core.elements().get('n1') as El
      oldCore.change('n1', { backgroundColor: n1.backgroundColor === '#ffc9c9' ? '#d0bfff' : '#ffc9c9' })
      await oldCore.saved()
      expect(oldCore.core.saveStatus.lastReject).toBeNull()
      expect(await storedReactions(st, b, 'n1')).toEqual([
        reactionKey('clap', 'alice'),
        reactionKey('up', 'alice'),
      ])
      await st.converged(b, [oldCore, oldWatch, alice, fac])
      expect(oldWatch.core.pushLog()).toEqual([])
      await Promise.all([oldCore.close(), oldWatch.close()])
    })
  },
)

if (!oldCoreReady)
  describe('the deployed web’s own core (3c83611)', () => {
    it.skip('needs DRAFTROOM_OLD_WEB_SRC: the 3c83611 sources with node_modules (e2e/excalidraw/l-compat-kit.ts)', () => {})
  })
