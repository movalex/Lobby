// B11 (docs/EXCALIDRAW-MIGRATION.md §8.3): convergence under random load. Three separate Chromium
// processes plus 50 headless engine-core clients (O2's headless client, real api tickets) run random ops
// for 10 minutes: create, move, recolour, text through the lease, group, bind, delete, undo (browsers:
// Ctrl+Z; the headless client has no undo stack), with random disconnects (browsers: the socket cut;
// headless: the socket closed, then a new client on a fresh ticket) and one SIGKILL of sync at a random
// minute in [3, 7], restarted after 3 s. Pass: at the end every map, tombstones included, hashes equal to
// the test snapshot; 0 invariant violations; 0 acked-but-missing.
//
// acked-but-missing: each client edits only elements it created (so exactly one writer changes an
// element's tracked fields); each keeps a ledger of its elements' tracked fields as last ACKED (headless:
// from its acks; browsers: every 2 s when the tab shows Saved, which means acked). Right after the
// restart, once every client is back, an element whose ledger entry predates the kill and which its
// writer did not push again before the kill must be stored exactly as the ledger says. The count of
// elements checked is reported with the result.
//
// Opt-in (SPIKE_B11=1; 10 minutes, SPIKE_B11_MS to shorten a dry run), 3 runs (SPIKE_B_RUN=1..3). Needs M2.
import { expect, test } from '@playwright/test'
import type { HeadlessClient, SceneElement } from '../../../apps/web/src/canvas/sync/types.ts'
import {
  buildStickyNote,
  indexKeyBetween,
  installedServerTextMetrics,
  installServerTextMetrics,
} from '../../../packages/canvas-schema/src/engine/index.ts'
import { hashElements } from '../../../packages/canvas-schema/src/hash.ts'
import { loadHeadlessFactory } from '../../load/headless.ts'
import { Meter } from '../../load/meter.ts'
import { mutated } from '../../load/session.ts'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { closeWindow, openWindow, writeEvidence } from '../support/checks.ts'
import { divergenceDetail, enableBoardLog } from '../support/diverge.ts'
import { canvasOf, closeAllBrowsers, harness } from '../support/harness.ts'
import { apiTicket } from '../support/seed.ts'
import type { O3Stack } from '../support/stack.ts'
import type { DevUser } from '../support/types.ts'

test.skip(!process.env.SPIKE_B11, 'set SPIKE_B11=1 to run B11 (10 minutes)')
test.setTimeout(40 * 60_000)

const DURATION_MS = Number(process.env.SPIKE_B11_MS ?? 10 * 60_000)
const HEADLESS = Number(process.env.SPIKE_B11_HEADLESS ?? 50)
const TRACKED = ['x', 'y', 'backgroundColor', 'isDeleted', 'groupIds'] as const
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rnd = (n: number) => Math.floor(Math.random() * n)

type Ledger = Map<string, { at: number; fields: Record<string, unknown> }>
const pick = (el: Record<string, unknown>) => Object.fromEntries(TRACKED.map((f) => [f, el[f]]))

let stack: O3Stack
const browsers: O3BrowserProcess[] = []
let boardId: string

test.beforeAll(async () => {
  // the headless clients build their notes in Node, where the label's measure needs the server's text
  // metrics (as the room and e2e/load/boards.ts install them); without them every headless create threw
  // "document is not defined" and the 50 clients wrote nothing (the first 3-run pass, 75fe4d5)
  if (!installedServerTextMetrics()) installServerTextMetrics()
  stack = await harness.startStack()
  for (const name of ['A', 'B', 'C'])
    browsers.push(await harness.launchBrowser(stack, harness.devUser(name), { name }))
  ;({ boardId } = await stack.createBoard({
    owner: (browsers[0] as O3BrowserProcess).user,
    members: browsers.slice(1).map((b) => ({ user: b.user, role: 'editor' as const })),
    title: 'B11',
  }))
  // the board session's own log (ids and counts), read if the maps do not converge
  for (const b of browsers) await enableBoardLog(b.page)
  for (const b of browsers) await b.openBoard(boardId)
})
test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

/** One headless participant: its dev user, its current client, what it created, its acked ledger. */
class Participant {
  readonly name: string
  readonly dev: DevUser
  client: HeadlessClient | null = null
  readonly own: string[] = []
  readonly ledger: Ledger = new Map()
  readonly pushedAt = new Map<string, number>()
  connects = 0
  errors: string[] = []
  /** every op that threw (the first 10 messages are kept in `errors`) */
  errorCount = 0
  /** ops that reached the client's scene (an edit call that did not throw) */
  edits = 0
  private create: Awaited<ReturnType<typeof loadHeadlessFactory>> | null = null
  constructor(name: string, dev: DevUser) {
    this.name = name
    this.dev = dev
  }
  async connect(): Promise<void> {
    this.create ??= await loadHeadlessFactory()
    const { ticket } = await apiTicket(stack, this.dev, boardId)
    const c = this.create({
      syncUrl: stack.ports.syncUrl.replace(/^http/, 'ws'),
      boardId,
      tab: `b11-${this.name}`,
      ticket,
      meter: new Meter(),
    })
    c.core.onAck((ack) => {
      for (const r of ack.r) {
        if (!r.ok || !this.own.includes(r.id)) continue
        const el = c.core.confirmed(r.id) as Record<string, unknown> | undefined
        if (el) this.ledger.set(r.id, { at: Date.now(), fields: pick(el) })
      }
    })
    await c.connect()
    this.client = c
    this.connects++
  }
  async drop(): Promise<void> {
    const c = this.client
    this.client = null
    await c?.close().catch(() => undefined)
  }
  /** One random op on its own elements (or a create). */
  op(): void {
    const c = this.client
    if (!c) return
    const now = Date.now()
    const live = this.own.filter((id) => c.scene.get(id) && !c.scene.get(id)?.isDeleted)
    const kind = live.length < 3 ? 0 : rnd(6)
    try {
      if (kind === 0) {
        const id = `${this.name}-${now.toString(36)}-${rnd(1e6).toString(36)}`
        const maxIndex = [...c.scene.values()].reduce<string | null>(
          (m, e) => (e.index && (!m || e.index > m) ? e.index : m),
          null,
        )
        const { note, label } = buildStickyNote({ id, x: rnd(4000), y: rnd(3000), text: `b11 ${this.name}` })
        const i1 = indexKeyBetween(maxIndex, null)
        c.edit((s) => {
          s.set(id, { ...note, index: i1 } as unknown as SceneElement)
          if (label)
            s.set(label.id, { ...label, index: indexKeyBetween(i1, null) } as unknown as SceneElement)
        })
        this.own.push(id)
        this.pushedAt.set(id, now)
        this.edits++
        return
      }
      const id = live[rnd(live.length)] as string
      const el = c.scene.get(id) as SceneElement
      this.pushedAt.set(id, now)
      if (kind === 1) c.edit((s) => s.set(id, mutated(el, { x: (el.x as number) + rnd(80) - 40 })))
      else if (kind === 2)
        c.edit((s) => s.set(id, mutated(el, { backgroundColor: ['#ffdf6b', '#9fd4ff', '#b8e994'][rnd(3)] })))
      else if (kind === 3) {
        const other = live[rnd(live.length)] as string
        const g = `g-${this.name}-${now.toString(36)}`
        c.edit((s) => {
          for (const x of new Set([id, other])) s.set(x, mutated(s.get(x) as SceneElement, { groupIds: [g] }))
        })
        this.pushedAt.set(other, now)
      } else if (kind === 4) c.edit((s) => s.set(id, mutated(el, { isDeleted: true })))
      else {
        const label = c.scene.get(`${id}.t`)
        if (label)
          c.edit((s) =>
            s.set(label.id, mutated(label, { text: `t${rnd(1000)}`, originalText: `t${rnd(1000)}` })),
          )
      }
      this.edits++
    } catch (e) {
      this.errorCount++
      if (this.errors.length < 10) this.errors.push(String(e).slice(0, 160))
    }
  }
}

test('B11: 3 browsers + 50 headless clients, random ops, disconnects and one SIGKILL converge', async () => {
  const testInfo = test.info()
  const w = await openWindow(stack, boardId)
  const people: Participant[] = []
  for (let i = 0; i < HEADLESS; i++) {
    const dev = harness.devUser(`h${i}`)
    const { me } = await stack.api(dev)
    await (await stack.api((browsers[0] as O3BrowserProcess).user)).api.putMember(
      boardId,
      me.user.id,
      'editor',
    )
    people.push(new Participant(`h${i}`, dev))
  }
  for (const p of people) await p.connect()
  const browserOwn = new Map<string, string[]>(browsers.map((b) => [b.name, []]))
  const browserLedger = new Map<string, Ledger>(browsers.map((b) => [b.name, new Map()]))
  const browserPushedAt = new Map<string, Map<string, number>>(browsers.map((b) => [b.name, new Map()]))
  const end = Date.now() + DURATION_MS
  const killAt = Date.now() + 3 * 60_000 + rnd(4 * 60_000) * (DURATION_MS / (10 * 60_000))
  const kill: {
    done: { at: number; restartedAt: number; check: { checked: number; missing: string[] } } | null
  } = { done: null }
  const counts = { browserOps: 0, browserFailures: 0, headlessOps: 0, cuts: 0, drops: 0 }

  const headlessLoop = (async () => {
    while (Date.now() < end) {
      for (const p of people) {
        if (Math.random() >= 0.25) continue
        p.op()
        counts.headlessOps++
      }
      await sleep(500)
    }
  })()
  const browserLoop = async (b: O3BrowserProcess) => {
    const c = canvasOf(b.page)
    const own = browserOwn.get(b.name) as string[]
    const pushedAt = browserPushedAt.get(b.name) as Map<string, number>
    while (Date.now() < end) {
      const r = rnd(8)
      try {
        const live = []
        for (const id of own) if ((await c.get(id))?.isDeleted === false) live.push(id)
        if (r === 0 || live.length < 3) own.push(await c.create('note', { x: rnd(4000), y: rnd(3000) }))
        else {
          const id = live[rnd(live.length)] as string
          pushedAt.set(id, Date.now())
          const el = await c.get(id)
          if (r === 1) await c.update(id, { x: (el?.x as number) + rnd(80) - 40 })
          else if (r === 2) await c.update(id, { backgroundColor: ['#ffdf6b', '#ff9f9f'][rnd(2)] })
          else if (r === 3) {
            const other = live[rnd(live.length)] as string
            pushedAt.set(other, Date.now())
            const g = `g-${b.name}-${Date.now().toString(36)}`
            await c.update(id, { groupIds: [g] })
            if (other !== id) await c.update(other, { groupIds: [g] })
          } else if (r === 4) await c.delete(id)
          else if (r === 5) {
            // text through the lease: Enter on the selected note opens the editor after the grant
            await c.select([id])
            await b.page.keyboard.press('Enter')
            await b.page.keyboard.type('b11', { delay: 30 })
            await b.page.keyboard.press('Escape')
          } else if (r === 6) await b.page.keyboard.press('Control+z')
          else {
            const target = live[rnd(live.length)] as string
            // bind: an arrow from one own note to another, as engine fields (CanvasTx: props are element
            // fields); the port adds the targets' boundElements (O2's rule; checked by the invariants)
            if (target !== id) {
              const a = await c.bounds(id)
              const t = await c.bounds(target)
              if (a && t) {
                const x = a.x + a.width
                const y = a.y + a.height / 2
                own.push(
                  await c.create('arrow', {
                    x,
                    y,
                    points: [
                      [0, 0],
                      [Math.round((t.x - x) * 100) / 100, Math.round((t.y + t.height / 2 - y) * 100) / 100],
                    ],
                    startBinding: { elementId: id, fixedPoint: [1, 0.5], mode: 'orbit' },
                    endBinding: { elementId: target, fixedPoint: [0, 0.5], mode: 'orbit' },
                  }),
                )
              }
            }
          }
        }
        counts.browserOps++
      } catch {
        counts.browserFailures++
      }
      await sleep(700 + rnd(600))
    }
  }
  const ledgerLoop = (async () => {
    while (Date.now() < end) {
      for (const b of browsers) {
        const state = await canvasOf(b.page)
          .saveState()
          .catch(() => null)
        if (state?.state !== 'saved') continue
        const at = Date.now()
        const ledger = browserLedger.get(b.name) as Ledger
        for (const id of browserOwn.get(b.name) as string[]) {
          const el = await canvasOf(b.page).get(id)
          if (el) ledger.set(id, { at, fields: pick(el as unknown as Record<string, unknown>) })
        }
      }
      await sleep(2_000)
    }
  })()
  const chaosLoop = (async () => {
    while (Date.now() < end) {
      await sleep(45_000 + rnd(45_000))
      if (Date.now() >= end) break
      if (!kill.done && Date.now() >= killAt) {
        const at = Date.now()
        await stack.killSync()
        await sleep(3_000)
        await stack.restartSync()
        const restartedAt = Date.now()
        // every client back: browsers welcomed again, headless reconnected (a fresh ticket each)
        for (const p of people) {
          await p.drop()
          await p.connect()
        }
        for (const b of browsers)
          await b.page.waitForFunction(
            (t) =>
              (window.__lobbyHarness?.session().clock ?? 0) >= 0 &&
              window.lobbyCanvas?.saveState().state !== 'offline' &&
              Date.now() > t,
            restartedAt,
            { timeout: 60_000 },
          )
        const snap = await harness.readSnapshot(stack, boardId)
        const stored = new Map(snap.elements.map((e) => [e.id, e as unknown as Record<string, unknown>]))
        const missing: string[] = []
        let checked = 0
        const check = (ledger: Ledger, pushed: Map<string, number>) => {
          for (const [id, entry] of ledger) {
            if (entry.at >= at || (pushed.get(id) ?? 0) > entry.at) continue
            checked++
            const el = stored.get(id)
            if (!el || JSON.stringify(pick(el)) !== JSON.stringify(entry.fields)) missing.push(id)
          }
        }
        for (const p of people) check(p.ledger, p.pushedAt)
        for (const b of browsers)
          check(browserLedger.get(b.name) as Ledger, browserPushedAt.get(b.name) as Map<string, number>)
        kill.done = { at, restartedAt, check: { checked, missing } }
        continue
      }
      // a random disconnect: a browser's socket cut for 3-8 s, or a headless client dropped and replaced
      if (Math.random() < 0.5) {
        const b = browsers[rnd(browsers.length)] as O3BrowserProcess
        await harness.testHooks(stack).cutSocket(b.page)
        await sleep(3_000 + rnd(5_000))
        await harness.testHooks(stack).restoreSocket(b.page)
        counts.cuts++
      } else {
        const p = people[rnd(people.length)] as Participant
        await p.drop()
        await sleep(3_000 + rnd(5_000))
        await p.connect()
        counts.drops++
      }
    }
  })()
  await Promise.all([headlessLoop, ...browsers.map(browserLoop), ledgerLoop, chaosLoop])

  // quiesce: every client saved, then the convergence check over all 53 maps
  for (const p of people) await p.client?.saved(60_000).catch(() => undefined)
  for (const b of browsers)
    await b.page.waitForFunction(() => window.lobbyCanvas?.saveState().state === 'saved', undefined, {
      timeout: 60_000,
    })
  const targets = [
    ...browsers,
    ...people.map((p) => ({
      name: p.name,
      hash: () => hashElements((p.client as HeadlessClient).core.elements().values()),
    })),
  ]
  const evidence = (extra: Record<string, unknown>) =>
    writeEvidence(testInfo, 'B11', {
      durationMs: DURATION_MS,
      headless: HEADLESS,
      counts,
      killed: kill.done,
      connectsPerHeadless: people.map((p) => p.connects),
      headlessEdits: people.reduce((n, p) => n + p.edits, 0),
      headlessErrorCount: people.reduce((n, p) => n + p.errorCount, 0),
      headlessErrors: people.flatMap((p) => p.errors).slice(0, 20),
      headlessCreated: people.reduce((n, p) => n + p.own.length, 0),
      ...extra,
    })
  let report: Awaited<ReturnType<typeof closeWindow>>
  try {
    report = await closeWindow(stack, boardId, targets, w, { timeoutMs: 60_000 })
  } catch (e) {
    // not converged: what each diverging browser holds (scene, core, snapshot; flags; its board log)
    const detail = await divergenceDetail(stack, boardId, browsers).catch((x) => String(x))
    const file = evidence({ notConverged: detail, error: String(e).slice(0, 4_000) })
    throw new Error(`${String(e).slice(0, 1_500)} (detail in ${file})`)
  }
  const headlessIds = new Set(people.flatMap((p) => p.own))
  const headlessStored = report.snapshot.elements.filter((e) => headlessIds.has(e.id)).length
  evidence({
    elements: report.snapshot.elements.length,
    tombstones: report.snapshot.elements.filter((e) => e.isDeleted).length,
    headlessElementsStored: headlessStored,
  })
  // the headless half must really write: every op applied, and their notes are on the board
  expect(
    people.reduce((n, p) => n + p.errorCount, 0),
    'headless ops that threw',
  ).toBe(0)
  expect(headlessStored, 'elements the headless clients created, in the test snapshot').toBeGreaterThan(0)
  expect(kill.done, 'the SIGKILL happened inside the window').not.toBeNull()
  expect(kill.done?.check.missing, `acked-but-missing (of ${kill.done?.check.checked} checked)`).toEqual([])
})
