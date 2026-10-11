// The rollback pair of wave N (N2-5, N2-6 (4)): this build's board files under the REAL previous sync, the one
// deployed on staging before wave N (104c6e0, CONTRACTS_REV 12; `git diff 104c6e0 3c83611 -- apps/sync/src
// packages` is empty, so it is also the sync source of the deployed web's build). That sync runs `checkElement` on
// every element a push touches (merge.ts) and its key registry has no `react:` spec, so:
//  - the hazard, recorded: on a board file with reactions it refuses an edit of a reacted note INVALID, and the undo
//    of the delete of one, while plain elements are edited as before; this build's web core (rev 13) against it reads
//    `contracts` 12 (so no web offers reacting) and parses every frame;
//  - the documented rollback (DRAFTROOM_REACTIONS off, POST /internal/maintenance/strip-keys, then the older sync)
//    fixes it: after the strip that sync accepts both, and every tab converges on its hash.
// Needs the previous sync's sources with their dependencies (nothing of it is committed):
//
//   git archive 104c6e0 | tar -x -C <dir> && (cd <dir> && pnpm install --frozen-lockfile --offline --ignore-scripts)
//   DRAFTROOM_OLD_SYNC_SRC=<dir> pnpm vitest run apps/sync/test/element-room/rollback-rev12.test.ts
//
// Without DRAFTROOM_OLD_SYNC_SRC it is skipped, saying so.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CONNECT_REV_PARAM, CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { reactionKey } from '@draftroom/canvas-schema/reactions'
import { STRIP_KEYS_ROUTE } from '@draftroom/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import { createElementStack, type ElementStack, newBoardId } from '../harness/element-stack.ts'
import { type El, noteWithLabel, rect } from '../harness/elements.ts'
import { callInternal } from '../harness/tickets.ts'

const OLD = process.env.DRAFTROOM_OLD_SYNC_SRC ? resolve(process.env.DRAFTROOM_OLD_SYNC_SRC) : null
const OLD_ENTRY = OLD ? join(OLD, 'apps/sync/src/server.ts') : null
const ready = !!OLD_ENTRY && existsSync(OLD_ENTRY) && existsSync(join(OLD as string, 'node_modules'))

const rev13 = { query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) } }
const lobbyOf = (el: El | undefined) => (el?.customData?.lobby ?? {}) as Record<string, unknown>

describe.skipIf(!ready)(
  'the rollback pair: this build’s board files under the previous sync (104c6e0)',
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

    it('refuses an edit of a reacted note (the hazard); after DRAFTROOM_REACTIONS=off and strip-keys it accepts it', async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dr-rollback-'))
      dirs.push(dataDir)
      const b = newBoardId()
      // 1. this build (wave N, reactions on): a reacted note, a deleted reacted note, a plain shape
      let n2Held: { n: El; t: El } | null = null
      await withStack({ dataDir }, async (st) => {
        const a = await st.client({ boardId: b, user: 'alice', role: 'owner', ...rev13 })
        expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 13 })
        const made = await a.create([
          ...noteWithLabel('n1', 'keep me'),
          ...noteWithLabel('n2', 'deleted', { x: 600 }),
          rect('r1', { x: 1200 }),
        ])
        expect(made.r.every((r) => r.ok)).toBe(true)
        expect((await a.patch('n1', { c: { [reactionKey('up', 'alice')]: true } })).ok).toBe(true)
        expect((await a.patch('n2', { c: { [reactionKey('heart', 'alice')]: true } })).ok).toBe(true)
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
      const undo = (v: number, withReactions = true) => [
        {
          k: 'c',
          el: { ...held.n, version: v, ...(withReactions ? {} : { customData: { lobby: {} } }) },
        },
        { k: 'c', el: { ...held.t, version: v } },
      ]

      // 2. the previous sync on that file: the hazard
      await withStack({ dataDir, old: true }, async (st) => {
        const a = await st.client({ boardId: b, user: 'alice', role: 'owner', ...rev13 })
        expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 12 })
        expect(a.schemaErrors).toEqual([])
        expect(lobbyOf(a.confirmed.get('n1'))).toEqual({ [reactionKey('up', 'alice')]: true })
        // the edit of the reacted note and the undo of the deleted one: refused INVALID
        expect(await a.patch('n1', { g: { style: { backgroundColor: '#ffc9c9' } } })).toMatchObject({
          ok: false,
          code: 'INVALID',
        })
        const back = await a.push(undo((held.n.version as number) + 5))
        expect(back.r[0]).toMatchObject({ ok: false, code: 'INVALID' })
        // a plain shape is edited as before
        expect((await a.patch('r1', { g: { pos: { x: 1300, y: 10 } } })).ok).toBe(true)
        // this build's web core (rev 13) reads the room as 12 and edits the plain shape; nothing refused
        const core = await st.headless({ boardId: b, user: 'bob' })
        const r1 = core.core.elements().get('r1') as El
        core.change('r1', { x: (r1.x as number) + 50 })
        await core.saved()
        expect(core.core.saveStatus.lastReject).toBeNull()
        await st.converged(b, [a, core])
      })

      // 3. the documented rollback, on this build: DRAFTROOM_REACTIONS off, then the strip
      await withStack({ dataDir, env: { DRAFTROOM_REACTIONS: 'off' } }, async (st) => {
        const a = await st.client({ boardId: b, user: 'alice', role: 'owner', ...rev13 })
        expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 12 })
        const res = await callInternal(st.server.url, 'POST', STRIP_KEYS_ROUTE, {
          body: { prefix: 'react:' },
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ boards: 1, rewritten: 1, elements: 2, keys: 3, failed: 0 })
        await a.untilClock((await st.snapshot(b)).clock)
        expect(lobbyOf(a.confirmed.get('n1'))).toEqual({})
        await st.converged(b, [a])
      })

      // 4. the previous sync again: the same edit and the same undo now land
      await withStack({ dataDir, old: true }, async (st) => {
        const a = await st.client({ boardId: b, user: 'alice', role: 'owner', ...rev13 })
        expect(
          (await a.patch('n1', { g: { style: { backgroundColor: '#ffc9c9' } } })).ok,
          'the edit of the formerly reacted note',
        ).toBe(true)
        // the undo as this build's web sends it to a room that says 12: without the keys that room cannot know
        // (canvas-schema lobbyKeyNewerThan, WS1's N1-7)
        const tomb = (await st.stored(b, 'n2')) as El
        const back = await a.push(undo((tomb.version as number) + 5, false))
        expect(back.r.map((r) => r.ok)).toEqual([true, true])
        const core = await st.headless({ boardId: b, user: 'bob' })
        await st.converged(b, [a, core])
        expect(lobbyOf(await st.stored(b, 'n2'))).toEqual({})
      })
    })
  },
)

if (!ready)
  describe('the rollback pair (104c6e0)', () => {
    it.skip('needs DRAFTROOM_OLD_SYNC_SRC: the previous sync’s sources with node_modules (see the header)', () => {})
  })
