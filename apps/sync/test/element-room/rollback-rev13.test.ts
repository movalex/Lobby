// The rollback pair of wave T (WS1; docs/WAVE-T-CONTRACTS.md §3.4, §3.6): this build's board files under the REAL
// previous sync, the one deployed before wave T (ba1704c, CONTRACTS_REV 13; `git diff ba1704c 6769e07 -- apps/sync
// packages/canvas-schema` is empty, so the 6769e07 tree's sync is that build). That sync runs `checkElement` on every
// element a push touches (merge.ts) and its key registry has no planning spec, so:
//  - the hazard, recorded: on a board file with cards, panels, a storyboard head, a Kanban and a timeline it refuses
//    an edit of each INVALID, and the undo of the delete of a card, while plain elements are edited as before; this
//    build's web core (rev 14) against it reads `contracts` 13 (so no web offers planning) and its pushes carry no
//    planning key;
//  - the documented rollback (DRAFTROOM_PLANNING off and a restart, POST /internal/maintenance/strip-keys once per
//    class `card:`, `sb:`, `kanban`, `timeline`, then the older sync) fixes it: after the strip that sync accepts all
//    of it, and every tab converges on its hash. The planning keys are gone (the elements stay).
// Needs the previous sync's sources with their dependencies (nothing of it is committed):
//
//   git archive 6769e07 | tar -x -C <dir> && (cd <dir> && pnpm install --frozen-lockfile --offline --ignore-scripts)
//   DRAFTROOM_OLD_SYNC_SRC=<dir> pnpm vitest run --project sync apps/sync/test/element-room/rollback-rev13.test.ts
//
// Without DRAFTROOM_OLD_SYNC_SRC it is skipped, saying so.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isPlanningKey, PLANNING_KEY_CLASSES } from '@draftroom/canvas-schema/planning-keys'
import { CONNECT_REV_PARAM, CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { STRIP_KEYS_ROUTE } from '@draftroom/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import { createElementStack, type ElementStack, newBoardId } from '../harness/element-stack.ts'
import { type El, frame, noteWithLabel, rect, text } from '../harness/elements.ts'
import { callInternal } from '../harness/tickets.ts'

const OLD = process.env.DRAFTROOM_OLD_SYNC_SRC ? resolve(process.env.DRAFTROOM_OLD_SYNC_SRC) : null
const OLD_ENTRY = OLD ? join(OLD, 'apps/sync/src/server.ts') : null
const ready = !!OLD_ENTRY && existsSync(OLD_ENTRY) && existsSync(join(OLD as string, 'node_modules'))

const rev14 = { query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) } }
const lobbyOf = (el: El | undefined) => (el?.customData?.lobby ?? {}) as Record<string, unknown>
const planningOf = (el: El | undefined) => Object.keys(lobbyOf(el)).filter(isPlanningKey).sort()

const CARD = { 'card:status': 'doing', 'card:due': '2026-10-30' }
const PANEL = { 'sb:of': 'head', 'sb:pos': 'a0', 'sb:dur': 2000 }
const TIMELINE = { start: '2026-10-01', end: '2026-12-31', scale: 'week', lanes: 'none' }
const PLANNED = ['n1', 'head', 'p1', 'k1', 't1']

describe.skipIf(!ready)(
  'the rollback pair: this build’s board files under the previous sync (ba1704c = the 6769e07 tree’s sync)',
  () => {
    const dirs: string[] = []
    afterAll(() => {
      for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    const withStack = async <T>(
      o: { dataDir: string; old?: boolean; env?: Record<string, string | undefined> },
      fn: (st: ElementStack) => Promise<T>,
    ): Promise<T> => {
      const st = await createElementStack({
        dataDir: o.dataDir,
        ...(o.old ? { entry: OLD_ENTRY as string } : {}),
        ...(o.env ? { env: o.env } : {}),
      })
      try {
        return await fn(st)
      } finally {
        await st.dispose()
      }
    }

    it('refuses an edit of every planned element (the hazard); after DRAFTROOM_PLANNING=off and strip-keys for the four classes it accepts them', async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dr-rollback-t-'))
      dirs.push(dataDir)
      const b = newBoardId()
      // 1. this build (wave T, planning on): a card, a deleted card, a head and a panel, a Kanban, a timeline, a shape
      let n2Held: { n: El; t: El } | null = null
      await withStack({ dataDir }, async (st) => {
        const a = await st.client({ boardId: b, user: 'alice', role: 'owner', ...rev14 })
        expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 14 })
        st.api.setAssignees(b, ['usr_ann'])
        const made = await a.create([
          ...noteWithLabel('n1', 'keep me', { customData: { lobby: { ...CARD, 'card:who': 'usr_ann' } } }),
          ...noteWithLabel('n2', 'deleted', { x: 600, customData: { lobby: { 'card:status': 'todo' } } }),
          rect('r1', { x: 1200 }),
          text('head', { y: -200, customData: { lobby: { 'sb:head': { aspect: '16:9' } } } }),
          frame('p1', { y: 400, customData: { lobby: PANEL } }),
          frame('k1', { y: 1200, customData: { lobby: { kanban: { wip: { doing: 2 } } } } }),
          frame('t1', { x: 900, y: 1200, customData: { lobby: { timeline: TIMELINE } } }),
        ])
        expect(made.r.map((r) => (r.ok ? 'ok' : r.code)).filter((c) => c !== 'ok')).toEqual([])
        n2Held = {
          n: structuredClone(a.confirmed.get('n2') as El),
          t: structuredClone(a.confirmed.get('n2.t') as El),
        }
        const del = await a.push([
          a.patchOp('n2', { g: { life: { isDeleted: true } } }),
          a.patchOp('n2.t', { g: { life: { isDeleted: true } } }),
        ])
        expect(del.r.every((r) => r.ok)).toBe(true)
      })
      const held = n2Held as unknown as { n: El; t: El }
      const undo = (v: number, withKeys = true) => [
        { k: 'c', el: { ...held.n, version: v, ...(withKeys ? {} : { customData: { lobby: {} } }) } },
        { k: 'c', el: { ...held.t, version: v } },
      ]
      const recolour = (id: string) => ({ g: { style: { strokeColor: '#e03131' } }, id })

      // 2. the previous sync on that file: the hazard
      await withStack({ dataDir, old: true }, async (st) => {
        const a = await st.client({ boardId: b, user: 'alice', role: 'owner', ...rev14 })
        expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 13 })
        expect(a.schemaErrors).toEqual([])
        expect(planningOf(a.confirmed.get('n1'))).toEqual(['card:due', 'card:status', 'card:who'])
        // an edit of each planned element and the undo of the deleted card: refused INVALID
        for (const id of PLANNED) {
          const { g } = recolour(id)
          expect(await a.patch(id, { g }), `the edit of ${id}`).toMatchObject({ ok: false, code: 'INVALID' })
        }
        const back = await a.push(undo((held.n.version as number) + 5))
        expect(back.r[0]).toMatchObject({ ok: false, code: 'INVALID' })
        // a plain shape is edited as before
        expect((await a.patch('r1', { g: { pos: { x: 1300, y: 10 } } })).ok).toBe(true)
        // this build's web core (rev 14) reads the room as 13 and edits the plain shape; nothing refused
        const core = await st.headless({ boardId: b, user: 'bob' })
        const r1 = core.core.elements().get('r1') as El
        core.change('r1', { x: (r1.x as number) + 50 })
        await core.saved()
        expect(core.core.saveStatus.lastReject).toBeNull()
        await st.converged(b, [a, core])
      })

      // 3. the documented rollback, on this build: DRAFTROOM_PLANNING off (a restart), then the strip per class
      await withStack({ dataDir, env: { DRAFTROOM_PLANNING: 'off' } }, async (st) => {
        const a = await st.client({ boardId: b, user: 'alice', role: 'owner', ...rev14 })
        expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 13 })
        const answers: Record<string, unknown> = {}
        for (const prefix of PLANNING_KEY_CLASSES) {
          const res = await callInternal(st.server.url, 'POST', STRIP_KEYS_ROUTE, { body: { prefix } })
          expect(res.status).toBe(200)
          answers[prefix] = await res.json()
        }
        expect(answers).toEqual({
          'card:': { boards: 1, rewritten: 1, elements: 2, keys: 5, failed: 0 },
          'sb:': { boards: 1, rewritten: 1, elements: 2, keys: 4, failed: 0 },
          kanban: { boards: 1, rewritten: 1, elements: 1, keys: 1, failed: 0 },
          timeline: { boards: 1, rewritten: 1, elements: 1, keys: 1, failed: 0 },
        })
        await a.untilClock((await st.snapshot(b)).clock)
        for (const id of PLANNED) expect(planningOf(a.confirmed.get(id)), id).toEqual([])
        expect(JSON.stringify((await st.snapshot(b)).elements)).not.toMatch(/"(card:|sb:|kanban"|timeline")/)
        await st.converged(b, [a])
      })

      // 4. the previous sync again: the same edits and the same undo now land
      await withStack({ dataDir, old: true }, async (st) => {
        const a = await st.client({ boardId: b, user: 'alice', role: 'owner', ...rev14 })
        for (const id of PLANNED) {
          const { g } = recolour(id)
          expect((await a.patch(id, { g })).ok, `the edit of the formerly planned ${id}`).toBe(true)
        }
        // the undo as this build's web sends it to a room that says 13: without the keys that room cannot know
        const tomb = (await st.stored(b, 'n2')) as El
        const back = await a.push(undo((tomb.version as number) + 5, false))
        expect(back.r.map((r) => r.ok)).toEqual([true, true])
        const core = await st.headless({ boardId: b, user: 'bob' })
        await st.converged(b, [a, core])
        expect(lobbyOf(await st.stored(b, 'n2'))).toEqual({})
        expect(lobbyOf(await st.stored(b, 'n1'))).toEqual({})
      })
    })
  },
)

if (!ready)
  describe('the rollback pair (ba1704c)', () => {
    it.skip('needs DRAFTROOM_OLD_SYNC_SRC: the previous sync’s sources with node_modules (see the header)', () => {})
  })
