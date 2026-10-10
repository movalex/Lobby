// Wave M (M7-7, CAP-LASER-CPU; M7-2's "e2e/load headless clients work"): the laser load profiles and their
// sessions, and the load generator's thin clients against the REAL sync process with permessage-deflate on and
// off (DRAFTROOM_WS_DEFLATE). The NAS measurement itself (CPU at the 0.5 quota, bytes on the wire) is a run, not
// a test.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSyncServer } from '../../apps/sync/test/harness/server-process.ts'
import { TEST_TICKET_SECRET } from '../../apps/sync/test/harness/tickets.ts'
import { PresenceIn } from '../../packages/canvas-schema/src/protocol.ts'
import { smallBoard } from './boards.ts'
import { Meter } from './meter.ts'
import { boardsOf, buildPlans, signedTickets } from './plan.ts'
import { LASER30, LASER60, PROFILES, sessionCount } from './profiles.ts'
import { LoadSession, type SessionPlan } from './session.ts'
import { createThinClient } from './thin.ts'
import { loadUser, mintTicket, newRunSecrets } from './tickets.ts'

const dirs: string[] = []
const stops: (() => Promise<unknown>)[] = []
afterAll(async () => {
  for (const s of stops) await s().catch(() => {})
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('M7-7: the laser profiles', () => {
  it('laser30 and laser60: one board, 30 or 60 laser sessions at 20 Hz, all thin', () => {
    expect(PROFILES.laser30).toBe(LASER30)
    expect(PROFILES.laser60).toBe(LASER60)
    for (const [p, n] of [
      [LASER30, 30],
      [LASER60, 60],
    ] as const) {
      expect(sessionCount(p)).toBe(n)
      expect(p.presenceHz).toBe(20)
      expect(p.boards).toHaveLength(1)
      const plans = buildPlans(p, boardsOf(p), signedTickets(newRunSecrets().ticketSecret))
      expect(plans).toHaveLength(n)
      expect(plans.every((s) => s.group.kind === 'laser' && s.thin === true && s.ownNotes.length === 0)).toBe(
        true,
      )
    }
  })

  it('a laser session sends rev-12 presence: t laser, a 1-2 point trail, the button down, f null, at the profile rate', async () => {
    const sent: Record<string, unknown>[] = []
    const noop = () => () => {}
    // the thin client's shape (thin.ts), recording what it would send
    const fake = {
      core: {
        onAck: noop,
        on: noop,
        onSaveStatus: noop,
        leaseConnect: () => ({ send() {}, close() {} }),
        pushLog: () => [],
        confirmed: () => undefined,
        saveStatus: { state: 'saved' },
        sendPresence: (p: Record<string, unknown>) => void sent.push(p),
        start() {},
        stop() {},
      },
      scene: new Map(),
      connect: async () => ({}),
      edit() {},
      saved: () => Promise.resolve(),
      received: () => [],
      sendRaw() {},
      close: async () => {},
    }
    const board = smallBoard('laser-unit', 1)
    const plan: SessionPlan = {
      key: 'laser-unit:g0:laser:0',
      boardId: 'laser-unit',
      group: { kind: 'laser', count: 1, role: 'editor', thin: 1 },
      index: 0,
      user: loadUser(0, 0, 'editor'),
      ticket: 'unused',
      joinAtMs: 0,
      ownNotes: [],
      thin: true,
    }
    let stopping = false
    const s = new LoadSession(plan, {
      syncWsUrl: 'ws://unused',
      createClient: () => fake as never,
      createThinClient: () => fake as never,
      board,
      presenceHz: 20,
      t0: Date.now(),
      stopping: () => stopping,
    })
    const run = s.run()
    await sleep(1_000)
    stopping = true
    await run
    expect(sent.length).toBeGreaterThanOrEqual(10)
    expect(sent.length).toBeLessThanOrEqual(25)
    for (const m of sent) {
      expect(PresenceIn.safeParse({ type: 'presence', ...m }).success, JSON.stringify(m)).toBe(true)
      expect(m).toMatchObject({ t: 'laser', button: 'down', f: null })
      expect((m.trail as unknown[]).length).toBeGreaterThanOrEqual(1)
      expect((m.trail as unknown[]).length).toBeLessThanOrEqual(2)
    }
  })
})

describe('M7-2: the load generator’s thin clients against the real sync, deflate on and off', () => {
  for (const deflate of ['on', 'off'] as const)
    it(`DRAFTROOM_WS_DEFLATE=${deflate}: every laser session gets the others' lasers`, async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dr-load-laser-'))
      dirs.push(dataDir)
      const server = await spawnSyncServer({
        dataDir,
        env: { DRAFTROOM_ENGINE: 'excalidraw', DRAFTROOM_BACKUP_STORE: 'off', DRAFTROOM_WS_DEFLATE: deflate },
      })
      stops.push(() => server.kill('SIGKILL'))
      const boardId = `laser-${deflate}-board`
      const n = 5
      const meters = Array.from({ length: n }, () => new Meter({ parsePresence: true }))
      const clients = meters.map((meter, i) =>
        createThinClient({
          syncUrl: server.wsUrl,
          boardId,
          tab: `t${i}`,
          ticket: mintTicket(TEST_TICKET_SECRET, boardId, loadUser(0, i, 'editor')),
          meter,
        }),
      )
      await Promise.all(clients.map((c) => c.connect()))
      for (let k = 0; k < 20; k++) {
        clients.forEach((c, i) =>
          c.core.sendPresence({
            pointer: { x: 100 + k * 3 + i, y: 200 },
            button: 'down',
            sel: [],
            view: { x: 0, y: 0, w: 1920, h: 1080 },
            idle: false,
            editing: null,
            f: null,
            t: 'laser',
            trail: [{ x: 99 + k * 3 + i, y: 200 }],
          } as never),
        )
        await sleep(60)
      }
      await sleep(400)
      for (const m of meters) {
        const presence = m.in.get('presence')
        expect(presence?.frames ?? 0).toBeGreaterThan(5)
      }
      expect(server.logs()).toContain(`[connect] permessage-deflate ${deflate}`)
      await Promise.all(clients.map((c) => c.close()))
    })
})
