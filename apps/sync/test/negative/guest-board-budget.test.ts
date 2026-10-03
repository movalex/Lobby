// The negative security suite: CR-W5-FIX-3 (W5-35, EXCALIDRAW-MIGRATION open item 16), a per-board
// budget for name-only guests.
// The api mints a new guest uid for every cookie-less join of an editor guest link, so the per-uid
// 500-item cap alone let one link make about 200 x 500 items. Every guest uid together is now held to
// GUEST_BOARD_ITEM_CAP (live and deleted items, as the per-uid cap counts); accounts never are; a process
// restart rebuilds the count from the rows.
// Raw frames against the REAL sync server process (DRAFTROOM_ENGINE=excalidraw), the protocol harness.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUEST_BOARD_ITEM_CAP, GUEST_ITEM_CAP, MAX_OPS_PER_PUSH } from '@draftroom/canvas-schema/limits'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createElementStack,
  type ElementStack,
  newBoardId,
  sharedElementStack,
} from '../harness/element-stack.ts'
import { noteWithLabel, rect } from '../harness/elements.ts'
import { expectNotStored, expectRefused } from './support.ts'

const shared = sharedElementStack()
const T = 120_000

type Ack = Awaited<ReturnType<Awaited<ReturnType<ElementStack['client']>>['push']>>
const codes = (ack: Ack) => ack.r.map((r) => (r.ok ? 'ok' : r.code))

/** `n` rectangles from guest `uid` in pushes of at most MAX_OPS_PER_PUSH; returns every op's code. */
async function guestMakes(st: ElementStack, b: string, uid: string, n: number): Promise<string[]> {
  const g = await st.client({ boardId: b, user: uid, guest: true })
  const out: string[] = []
  for (let done = 0; done < n; done += MAX_OPS_PER_PUSH) {
    const k = Math.min(MAX_OPS_PER_PUSH, n - done)
    const ack = await g.push(
      Array.from({ length: k }, (_, i) => ({
        k: 'c',
        el: rect(`${uid}-${done + i}`, { x: (done + i) * 3 }),
      })),
    )
    out.push(...codes(ack))
  }
  g.close()
  return out
}

describe('CR-W5-FIX-3: a per-board budget for every guest uid together', () => {
  const dirs: string[] = []
  const stacks: ElementStack[] = []
  afterEach(async () => {
    await Promise.all(stacks.splice(0).map((s) => s.dispose()))
    for (const d of dirs.splice(0))
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it(
    `fresh guest uids (one per incognito join) stop at ${GUEST_BOARD_ITEM_CAP} items on the board, deleted ones counted; accounts go on; a restart keeps the budget`,
    async () => {
      expect(GUEST_BOARD_ITEM_CAP).toBeGreaterThan(GUEST_ITEM_CAP)
      const dataDir = mkdtempSync(join(tmpdir(), 'dr-a1-guests-'))
      dirs.push(dataDir)
      let st = await createElementStack({ dataDir })
      stacks.push(st)
      const b = newBoardId()
      // fresh guest uids, each a little under its own cap (GUEST_ITEM_CAP - 50 items), as many as fit in
      // the board's budget (13 of 450 for 6,000, so well over 10 uids); one of them deletes 50 of its own
      // (they still count); then one more asks for 50 over what is left and crosses the board's budget
      const per = GUEST_ITEM_CAP - 50
      const fillers = Math.floor(GUEST_BOARD_ITEM_CAP / per)
      expect(fillers).toBeGreaterThanOrEqual(10)
      for (let u = 0; u < fillers; u++)
        expect(new Set(await guestMakes(st, b, `guest-u${u}`, per))).toEqual(new Set(['ok']))
      const g0 = await st.client({ boardId: b, user: 'guest-u0', guest: true })
      const del = await g0.push(
        Array.from({ length: 50 }, (_, i) =>
          g0.patchOp(`guest-u0-${i}`, { g: { life: { isDeleted: true } } }),
        ),
      )
      expect(new Set(codes(del))).toEqual(new Set(['ok']))
      const left = GUEST_BOARD_ITEM_CAP - fillers * per // 150
      expect(left).toBeGreaterThan(0)
      expect(left).toBeLessThan(per)
      const asks = left + 50
      const uLast = await guestMakes(st, b, `guest-u${fillers}`, asks)
      expect(uLast.filter((c) => c === 'ok').length).toBe(left)
      expect(uLast.slice(left)).toEqual(Array(asks - left).fill('GUEST_LIMIT'))
      // another fresh uid gets nothing; an earlier guest far below its own cap gets nothing either
      expect(await guestMakes(st, b, `guest-u${fillers + 1}`, 1)).toEqual(['GUEST_LIMIT'])
      const again = await g0.createOne(rect('guest-u0-more'))
      expectRefused(again, 'GUEST_LIMIT', g0)
      // a note's label is no item: refused with its note, never counted alone
      const [n, t] = noteWithLabel('guest-note', 'words')
      expect(codes(await g0.create([n, t]))[0]).toBe('GUEST_LIMIT')
      // accounts are never refused by the guests' budget
      const alice = await st.client({ boardId: b, user: 'alice' })
      expect(codes(await alice.create([rect('alice-1'), rect('alice-2')]))).toEqual(['ok', 'ok'])
      await expectNotStored(st, b, [`guest-u${fillers + 1}-0`, 'guest-u0-more', 'guest-note'])
      const before = (await st.snapshot(b)).elements.length

      // a process restart: the room rebuilds the guests' counts from the board's rows (live and deleted)
      await st.dispose()
      stacks.length = 0
      st = await createElementStack({ dataDir })
      stacks.push(st)
      expect(await guestMakes(st, b, `guest-u${fillers + 2}`, 1)).toEqual(['GUEST_LIMIT'])
      const owner = await st.client({ boardId: b, user: 'olga', role: 'owner' })
      expect(codes(await owner.create([rect('olga-1')]))).toEqual(['ok'])
      expect((await st.snapshot(b)).elements.length).toBe(before + 1)
    },
    T,
  )

  it('the per-uid cap still holds below the board budget', async () => {
    const st = shared.get()
    const b = newBoardId()
    const codesOf = await guestMakes(st, b, 'guest-solo', GUEST_ITEM_CAP + 1)
    expect(codesOf.slice(0, GUEST_ITEM_CAP).every((c) => c === 'ok')).toBe(true)
    expect(codesOf[GUEST_ITEM_CAP]).toBe('GUEST_LIMIT')
  })
})
