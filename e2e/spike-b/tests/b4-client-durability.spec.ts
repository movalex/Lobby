// B4 D1, D2, D5, D6 (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.5.6, §2.5.7): "Saved" exactly, a sync SIGKILL,
// an offline queue that survives a reload, and a second tab that adopts a closed tab's queue. Separate
// Chromium processes (A, B) on a real stack (O1's room: COMMIT before ack, synchronous=FULL). Owner O2;
// evidence docs/research/excalidraw/spike-b/B4-client.md.
//
//   D1  A edits, waits for "Saved", reloads → content kept; "Saved" never appeared before the last ack
//       (every transition of the indicator to "Saved" came after the ack of every push sent before it:
//       the page's own record of the indicator, its pushes and its acks)
//   D2  A and B edit at 5 edits/s each; sync is SIGKILLed at a random moment and restarted 3 s later; 3
//       rounds → every edit covered by a displayed "Saved" is present after the restart in both browsers
//       and the snapshot (0 missing; in fact every edit); no transition to "Saved" while sync is down
//       (edits then show "Offline"/"Saving…"); after the reconnect the edits land, then "Saved"
//   D5  A's socket is cut (the relay, §8.6.2) and A edits for 60 s ("Offline — N changes"); the socket is
//       restored with the old page's reconnect held until it unloads, and A reloads → the old page pushed
//       nothing after the cut; the reloaded page restores the queue from IndexedDB, replays it once
//       (each edited element in one push), and B sees the edits
//   D6  tab 1 edits with its socket cut and is closed; tab 2 opens the board → it adopts and replays tab
//       1's queue once
//
// Run: SPIKE_B_PORT_BASE=<base> pnpm --filter @draftroom/e2e spike-b b4-client
//      (SPIKE_B4_REPS default 3 for D1; SPIKE_B4_D1_FRESH_REPS default 5 for D1 in fresh rooms;
//      SPIKE_B4_D5_MS default 60000; SPIKE_B4_D2_ROUNDS default 3)
import { expect, type Page, test } from '@playwright/test'
import type { Op } from '../../../packages/canvas-schema/src/protocol.ts'
import { harness } from '../support/harness.ts'
import type { BrowserProcess } from '../support/types.ts'
import { allSaved, board, converge, everywhere, lc, REPS, type Room, room, waitSaved } from './b3-kit.ts'

const N = REPS('B4', 3)
const D5_MS = Number(process.env.SPIKE_B4_D5_MS ?? 60_000)
const D2_ROUNDS = Number(process.env.SPIKE_B4_D2_ROUNDS ?? 3)
test.describe.configure({ mode: 'serial' })
test.setTimeout(90 * 60_000)

let r: Room
const A = () => r.by.A?.page as Page
const B = () => r.by.B?.page as Page

/** The board page is ready: the facade exists and the engine core processed its welcome. */
const waitBoardReady = (p: Page) =>
  p.waitForFunction(
    () => {
      const w = window as unknown as {
        lobbyCanvas?: unknown
        __lobbyBoard?: { core?: { welcome?: unknown } }
      }
      return !!w.lobbyCanvas && !!w.__lobbyBoard?.core?.welcome
    },
    undefined,
    { timeout: 60_000, polling: 50 },
  )

/** A second tab of the same user with the harness's socket relay (O3's newTab, beyond the frozen type). */
async function newTab(b: BrowserProcess): Promise<Page> {
  const open = (b as unknown as { newTab?: () => Promise<Page> }).newTab
  if (!open) throw new Error('the harness has no newTab() (D6 needs a second tab with the socket relay)')
  return open.call(b)
}

test.beforeAll(async () => {
  r = await room(['A', 'B'])
})
test.afterAll(async () => {
  await r?.close()
})

const opId = (o: Op) => (o.k === 'c' ? o.el.id : o.id)

// ---- the page's record: the indicator's transitions, its pushes, its acks ------------------------

/** Records every change of the Saved indicator (data-state) with its time, from now on. */
async function recordIndicator(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as unknown as { __ind?: { states: { s: string; at: number }[]; off: () => void } }
    w.__ind?.off()
    const el = document.querySelector<HTMLElement>('[data-testid="save-state"]')
    const states: { s: string; at: number }[] = [{ s: el?.dataset.state ?? '?', at: Date.now() }]
    const mo = new MutationObserver(() => {
      const s = el?.dataset.state ?? '?'
      if (states.at(-1)?.s !== s) states.push({ s, at: Date.now() })
    })
    if (el) mo.observe(el, { attributes: true, attributeFilter: ['data-state'] })
    w.__ind = { states, off: () => mo.disconnect() }
  })
}
const indicator = (p: Page) =>
  p.evaluate(
    () => (window as unknown as { __ind?: { states: { s: string; at: number }[] } }).__ind?.states ?? [],
  )
/**
 * Push send times (the push log), ack receive times and welcome times (the session's event log). A push
 * in flight when the socket died is never acked: after the welcome its content goes out again in a new
 * push (the core turns what was in flight back into dirty groups), so a welcome settles it.
 */
async function pushesAndAcks(p: Page): Promise<{
  sent: { seq: number; at: number }[]
  acked: { seq: number; at: number }[]
  welcomes: number[]
}> {
  const sent = (await lc(p).pushedOps()).map((x) => ({ seq: x.seq, at: x.at }))
  const log = await board(p, (b) => b.session.eventLog as { kind: string; id: string | null; at: number }[])
  const acked = log.filter((e) => e.kind === 'ack').map((e) => ({ seq: Number(e.id), at: e.at }))
  const welcomes = log.filter((e) => e.kind === 'welcome').map((e) => e.at)
  return { sent, acked, welcomes }
}
/** Transitions to "saved" at which a push sent before it had no ack yet (and no welcome after it). */
function savedTooEarly(
  states: { s: string; at: number }[],
  sent: { seq: number; at: number }[],
  acked: { seq: number; at: number }[],
  welcomes: number[] = [],
): { at: number; unacked: number[] }[] {
  const bad: { at: number; unacked: number[] }[] = []
  for (const st of states) {
    if (st.s !== 'saved') continue
    const unacked = sent
      .filter((x) => x.at <= st.at)
      .filter((x) => !acked.some((a) => a.seq === x.seq && a.at <= st.at))
      .filter((x) => !welcomes.some((w) => w > x.at && w <= st.at))
      .map((x) => x.seq)
    if (unacked.length) bad.push({ at: st.at, unacked })
  }
  return bad
}

// ---- D1 -------------------------------------------------------------------------------------------

test('D1: A edits, waits for Saved, reloads: the content is kept; Saved never before the last ack', async () => {
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < N; i++) {
    await recordIndicator(A())
    const t0 = Date.now()
    const id = await lc(A()).create('rectangle', { x: i * 300, y: 0, width: 120, height: 80, roughness: 0 })
    for (let k = 1; k <= 5; k++) await lc(A()).update(id, { x: i * 300 + k * 7 })
    await lc(A()).update(id, { strokeColor: '#e03131' })
    await waitSaved(A())
    const states = (await indicator(A())).filter((s) => s.at >= t0)
    const { sent, acked } = await pushesAndAcks(A())
    const mine = sent.filter((x) => x.at >= t0)
    const early = savedTooEarly(states, mine, acked)
    const lastAck = Math.max(...acked.filter((a) => mine.some((m) => m.seq === a.seq)).map((a) => a.at))
    const lastSaved = states.filter((s) => s.s === 'saved').at(-1)?.at ?? 0
    // reload
    await A().reload()
    await waitBoardReady(A())
    const el = (await lc(A()).get(id)) as { x?: number; strokeColor?: string } | null
    const snap = await harness.readSnapshot(r.stack, r.boardId)
    const stored = snap.elements.find((e) => e.id === id) as { x?: number; strokeColor?: string } | undefined
    const want = { x: i * 300 + 35, strokeColor: '#e03131' }
    const kept = el?.x === want.x && el?.strokeColor === want.strokeColor && stored?.x === want.x
    const ok = kept && early.length === 0 && lastSaved >= lastAck
    rows.push({
      i,
      ok,
      kept,
      pushes: mine.length,
      states: states.map((s) => s.s),
      early,
      lastAckToSavedMs: lastSaved - lastAck,
    })
    await converge(r)
  }
  console.log('B4-D1', JSON.stringify({ n: rows.length, rows }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

/**
 * D1's first iteration as the M1/M2 integration's first run met it (A stayed "Saving…" 30 s): a FRESH room
 * (a new board and browsers, so the room's cached reset snapshot, kept 5 s, predates A's edit), A's ack
 * slowed through its socket relay (as on a loaded machine: the offline queue is persisted while the create
 * is in flight), and the reload the moment the indicator says Saved. Before O2's fix the reloaded page
 * replayed the queued create, the room refused it INVALID (the id exists) and the core kept it as an
 * unsent create for ever. Pass: content kept, Saved after the reload in both browsers, no refusal shown,
 * "Saved" never before the last ack (the same record as D1).
 */
test('D1 (fresh rooms, a slow ack, the reload at once): the content is kept and Saved comes back', async () => {
  const rows: Record<string, unknown>[] = []
  const reps = REPS('B4_D1_FRESH', 5)
  for (let i = 0; i < reps; i++) {
    const q = await room(['A', 'B'], { stack: r.stack })
    const a = q.by.A?.page as Page
    let row: Record<string, unknown> = { i }
    try {
      await recordIndicator(a)
      const t0 = Date.now()
      const off = await harness.testHooks(q.stack).withLatency(a, 400)
      const id = await lc(a).create('rectangle', { x: 0, y: 0, width: 120, height: 80, roughness: 0 })
      for (let k = 1; k <= 5; k++) await lc(a).update(id, { x: k * 7 })
      await lc(a).update(id, { strokeColor: '#e03131' })
      await a.waitForFunction(
        () =>
          (window as unknown as { lobbyCanvas: { saveState(): { state: string } } }).lobbyCanvas.saveState()
            .state === 'saved',
        undefined,
        { timeout: 30_000, polling: 5 },
      )
      const states = (await indicator(a)).filter((s) => s.at >= t0)
      const { sent, acked } = await pushesAndAcks(a)
      const early = savedTooEarly(
        states,
        sent.filter((x) => x.at >= t0),
        acked,
      )
      await off()
      await a.reload()
      await waitBoardReady(a)
      await allSaved(q.browsers)
      const el = (await lc(a).get(id)) as { x?: number; strokeColor?: string } | null
      const snap = await harness.readSnapshot(q.stack, q.boardId)
      const stored = snap.elements.find((e) => e.id === id) as
        | { x?: number; strokeColor?: string }
        | undefined
      const kept = el?.x === 35 && el?.strokeColor === '#e03131' && stored?.x === 35
      const rejects = await board(
        a,
        (b) => (b.session.eventLog as { kind: string }[]).filter((e) => e.kind === 'reject').length,
      )
      const adopted = await board(a, (b) =>
        (b.session.coreLog as { event: string; detail: unknown }[])
          .filter((e) => /offline_adopted|create_exists|create_settled/.test(e.event))
          .map((e) => `${e.event} ${JSON.stringify(e.detail)}`),
      )
      row = { i, ok: kept && early.length === 0 && rejects === 0, kept, early, rejects, adopted }
      await converge(q)
    } catch (e) {
      row = { i, ok: false, error: String((e as Error).message).slice(0, 4000) }
    }
    console.log('row', JSON.stringify(row))
    rows.push(row)
    await q.close()
  }
  console.log('B4-D1-fresh', JSON.stringify({ n: rows.length, failed: rows.filter((x) => !x.ok) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})

// ---- D5 and D6 --------------------------------------------------------------------------------------

/** `ms` of offline edits by `p` (creates and moves, about 2 per second); returns the ids and moves. */
async function offlineEdits(p: Page, ms: number, base: number): Promise<{ ids: string[]; edits: number }> {
  const ids: string[] = []
  let edits = 0
  const t0 = Date.now()
  let k = 0
  while (Date.now() - t0 < ms) {
    if (k % 3 === 0)
      ids.push(await lc(p).create('rectangle', { x: base + ids.length * 40, y: 400, width: 30, height: 30 }))
    else await lc(p).update(ids.at(-1) as string, { y: 400 + k * 3 })
    edits++
    k++
    await p.waitForTimeout(450)
  }
  return { ids, edits }
}

test('D5: offline edits for 60 s survive a reload after the reconnect (IndexedDB) and are replayed once', async () => {
  const hooks = harness.testHooks(r.stack) as ReturnType<typeof harness.testHooks> & {
    restoreSocket(p: Page, o?: { release?: boolean }): Promise<void>
  }
  const pushesBefore = (await lc(A()).pushedOps()).length
  await hooks.cutSocket(A())
  await expect.poll(async () => (await lc(A()).saveState()).state).toBe('offline')
  const { ids, edits } = await offlineEdits(A(), D5_MS, 0)
  const offline = await lc(A()).saveState()
  const label = await A().locator('[data-testid="save-state"]').textContent()
  const oldPagePushes = (await lc(A()).pushedOps()).length - pushesBefore
  // the socket is restored with the old page's reconnect held until it unloads; the page reloads
  await hooks.restoreSocket(A(), { release: false })
  await A().reload()
  await waitBoardReady(A())
  await waitSaved(A(), 60_000)
  const log = await lc(A()).pushedOps()
  const perId = ids.map((id) => log.flatMap((x) => x.ops).filter((o) => opId(o) === id).length)
  for (const id of ids) await everywhere([r.by.B as BrowserProcess], id)
  await allSaved(r.browsers)
  await converge(r)
  const snap = await harness.readSnapshot(r.stack, r.boardId)
  const stored = ids.filter((id) => snap.elements.some((e) => e.id === id && !e.isDeleted)).length
  const row = {
    ms: D5_MS,
    edits,
    elements: ids.length,
    offline: { state: offline.state, offlineChanges: offline.offlineChanges },
    label,
    oldPagePushes,
    replayedOnce: perId.every((n) => n === 1),
    perId,
    stored,
  }
  console.log('B4-D5', JSON.stringify(row))
  expect(offline.state).toBe('offline')
  expect(offline.offlineChanges).toBeGreaterThan(0)
  expect(oldPagePushes).toBe(0)
  expect(row.replayedOnce).toBe(true)
  expect(stored).toBe(ids.length)
})

test('D6: tab 1 edits offline and is closed; tab 2 adopts its queue and replays it once', async () => {
  const hooks = harness.testHooks(r.stack)
  const a = r.by.A as BrowserProcess
  // tab 1: a second tab of A (A's first tab stays open on the board, online)
  const tab1 = await newTab(a)
  await tab1.goto(`/b/${encodeURIComponent(r.boardId)}`)
  await waitBoardReady(tab1)
  await hooks.cutSocket(tab1)
  await expect.poll(async () => (await lc(tab1).saveState()).state).toBe('offline')
  const { ids } = await offlineEdits(tab1, Math.min(D5_MS, 10_000), 2000)
  const queued = (await lc(tab1).saveState()).offlineChanges
  await tab1.close()
  // tab 2 opens the board: it adopts tab 1's queue (its lock is gone) and replays it
  const tab2 = await newTab(a)
  await tab2.goto(`/b/${encodeURIComponent(r.boardId)}`)
  await waitBoardReady(tab2)
  await waitSaved(tab2, 60_000)
  const log = await lc(tab2).pushedOps()
  const perId = ids.map((id) => log.flatMap((x) => x.ops).filter((o) => opId(o) === id).length)
  for (const id of ids) await everywhere([r.by.B as BrowserProcess], id)
  await allSaved(r.browsers)
  const snap = await harness.readSnapshot(r.stack, r.boardId)
  const stored = ids.filter((id) => snap.elements.some((e) => e.id === id && !e.isDeleted)).length
  // A's first tab never replayed tab 1's queue (one adopter)
  const firstTab = (await lc(A()).pushedOps())
    .flatMap((x) => x.ops)
    .filter((o) => ids.includes(opId(o))).length
  const row = {
    elements: ids.length,
    queued,
    perId,
    replayedOnce: perId.every((n) => n === 1),
    stored,
    firstTab,
  }
  console.log('B4-D6', JSON.stringify(row))
  await tab2.close()
  await converge(r)
  expect(queued).toBeGreaterThan(0)
  expect(row.replayedOnce).toBe(true)
  expect(firstTab).toBe(0)
  expect(stored).toBe(ids.length)
})

// ---- D7 (spike B part 3): no window in which a reload loses a change -----------------------------------

/**
 * Edits through the facade, then `location.reload()` in the SAME task: no timer, no React commit, no
 * onChange comes between them. Returns the values written (the page is gone when this resolves).
 */
async function editThenReload(p: Page, edits: { id: string | null; x: number }[]): Promise<string[]> {
  const ids = await p
    .evaluate((list) => {
      const f = (
        window as unknown as {
          lobbyCanvas: { create(k: string, o: object): string; update(id: string, o: object): void }
        }
      ).lobbyCanvas
      const out: string[] = []
      for (const e of list) {
        if (e.id) {
          f.update(e.id, { x: e.x })
          out.push(e.id)
        } else out.push(f.create('rectangle', { x: e.x, y: 1600, width: 30, height: 30 }))
      }
      // the create returns its id synchronously; the reload follows at once
      ;(window as unknown as { __d7?: string[] }).__d7 = out
      sessionStorage.setItem('d7-ids', JSON.stringify(out))
      location.reload()
      return out
    }, edits)
    .catch(() => null)
  // the reloaded page is up (its engine core exists; offline it gets no welcome)
  await p.waitForFunction(
    () => {
      const w = window as unknown as {
        lobbyCanvas?: unknown
        __lobbyBoard?: { core?: unknown }
        __d7?: unknown
      }
      return !!w.lobbyCanvas && !!w.__lobbyBoard?.core && w.__d7 === undefined
    },
    undefined,
    { timeout: 60_000, polling: 50 },
  )
  return ids ?? (JSON.parse((await p.evaluate(() => sessionStorage.getItem('d7-ids'))) ?? '[]') as string[])
}

test('D7: edits followed by a reload in the same task survive it, online and offline (the old 100 ms queue window)', async () => {
  const hooks = harness.testHooks(r.stack)
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < N; i++) {
    for (const mode of ['online', 'offline'] as const) {
      const base = 3000 + i * 400 + (mode === 'offline' ? 200 : 0)
      const x0 = await lc(A()).create('rectangle', { x: base, y: 1500, width: 30, height: 30 })
      await waitSaved(A())
      if (mode === 'offline') {
        await hooks.cutSocket(A())
        await expect.poll(async () => (await lc(A()).saveState()).state).toBe('offline')
      }
      const ids = await editThenReload(A(), [
        { id: x0, x: base + 77 },
        { id: null, x: base + 111 },
      ])
      const [, created] = ids
      let queued: number | null = null
      if (mode === 'offline') {
        // the reloaded page is still cut off: its queue came back from IndexedDB
        await expect
          .poll(async () => (await lc(A()).saveState()).offlineChanges, { timeout: 15_000 })
          .toBeGreaterThan(0)
        queued = (await lc(A()).saveState()).offlineChanges
        await hooks.restoreSocket(A())
      }
      await waitSaved(A(), 60_000)
      const snap = await harness.readSnapshot(r.stack, r.boardId)
      const byId = (id: string | undefined) =>
        snap.elements.find((e) => e.id === id) as { x?: number; isDeleted?: boolean } | undefined
      const row = {
        i,
        mode,
        queued,
        moved: byId(x0)?.x === base + 77,
        created: !!created && byId(created)?.x === base + 111 && !byId(created)?.isDeleted,
        local: (await lc(A()).get(x0))?.x === base + 77,
      }
      rows.push(row)
    }
  }
  await converge(r)
  console.log('B4-D7', JSON.stringify({ n: rows.length, rows }))
  expect(rows.filter((x) => !x.moved || !x.created || !x.local)).toEqual([])
})

// ---- D2 -------------------------------------------------------------------------------------------

/** Starts a 5 edits/s loop in the page (creates through the facade); stop() returns the edits. */
async function startLoop(p: Page, base: number): Promise<void> {
  await p.evaluate((x0) => {
    const w = window as unknown as {
      __loop?: { edits: { id: string; at: number }[]; stop: boolean }
      lobbyCanvas: { create(kind: string, props: object): Promise<string> }
    }
    const loop = { edits: [] as { id: string; at: number }[], stop: false }
    w.__loop = loop
    let k = 0
    const tick = async () => {
      if (loop.stop) return
      const at = Date.now()
      try {
        const id = await w.lobbyCanvas.create('rectangle', {
          x: x0 + (k % 40) * 25,
          y: 800 + Math.floor(k / 40) * 25,
          width: 20,
          height: 20,
        })
        loop.edits.push({ id, at })
      } catch {
        // a create that failed locally is no edit
      }
      k++
      setTimeout(tick, 200)
    }
    void tick()
  }, base)
}
const stopLoop = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as { __loop?: { edits: { id: string; at: number }[]; stop: boolean } }
    if (w.__loop) w.__loop.stop = true
    return w.__loop?.edits ?? []
  })

test('D2: 5 edits/s each in A and B, sync SIGKILLed at a random moment and restarted after 3 s, 3 rounds: 0 Saved edits missing', async () => {
  const rows: Record<string, unknown>[] = []
  for (let round = 0; round < D2_ROUNDS; round++) {
    for (const b of r.browsers) await recordIndicator(b.page)
    const t0 = Date.now()
    await startLoop(A(), round * 2000)
    await startLoop(B(), round * 2000 + 1000)
    await A().waitForTimeout(1000 + Math.floor(Math.random() * 3000))
    const tKill = Date.now()
    await r.stack.killSync('SIGKILL')
    // the process is gone once killSync returned; an ack that left it before that is a real ack
    const tDead = Date.now()
    await A().waitForTimeout(3000)
    const tRestart = Date.now()
    await r.stack.restartSync()
    const tUp = Date.now()
    await A().waitForTimeout(3000)
    const edits = { A: await stopLoop(A()), B: await stopLoop(B()) }
    await allSaved(r.browsers, 90_000)
    await converge(r)
    const snap = await harness.readSnapshot(r.stack, r.boardId)
    const live = new Set(snap.elements.filter((e) => !e.isDeleted).map((e) => e.id))
    const out: Record<string, unknown> = {
      round,
      killAfterMs: tKill - t0,
      killMs: tDead - tKill,
      downMs: tUp - tKill,
    }
    let ok = true
    for (const [name, p] of [
      ['A', A()],
      ['B', B()],
    ] as const) {
      const states = (await indicator(p)).filter((s) => s.at >= t0)
      const savedTimes = states.filter((s) => s.s === 'saved').map((s) => s.at)
      const covered = edits[name].filter((e) => savedTimes.some((t) => t > e.at))
      const missingCovered = covered.filter((e) => !live.has(e.id)).length
      const missingAll = edits[name].filter((e) => !live.has(e.id)).length
      // no transition to "saved" while sync was down (from its death to the restart)
      const savedWhileDown = states.filter((s) => s.s === 'saved' && s.at > tDead && s.at < tRestart).length
      const { sent, acked, welcomes } = await pushesAndAcks(p)
      const early = savedTooEarly(
        states,
        sent.filter((x) => x.at >= t0),
        acked,
        welcomes,
      )
      const downStates = [...new Set(states.filter((s) => s.at > tKill && s.at < tUp).map((s) => s.s))]
      out[name] = {
        edits: edits[name].length,
        covered: covered.length,
        missingCovered,
        missingAll,
        savedWhileDown,
        downStates,
        early: early.length,
        earlyAt: early.slice(0, 2).map((x) => ({ at: x.at - tKill, unacked: x.unacked.slice(0, 4) })),
        welcomes: welcomes.filter((w) => w >= t0).map((w) => w - tKill),
        sentAround: sent
          .filter((x) => x.at >= tKill - 500)
          .slice(0, 6)
          .map((x) => ({ seq: x.seq, at: x.at - tKill })),
        finalState: states.at(-1)?.s,
      }
      if (missingCovered || missingAll || savedWhileDown || early.length || states.at(-1)?.s !== 'saved')
        ok = false
    }
    rows.push({ ...out, ok })
    console.log('row', JSON.stringify(rows.at(-1)))
  }
  console.log('B4-D2', JSON.stringify({ rounds: rows.length, failed: rows.filter((x) => !x.ok) }))
  expect(rows.filter((x) => !x.ok)).toEqual([])
})
