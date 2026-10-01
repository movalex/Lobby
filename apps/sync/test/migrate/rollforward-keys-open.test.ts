// The key share of rollforward-keys.test.ts through the real processes (V3's re-check repro, adopted by
// 2B): the Excalidraw sync converts a tldraw board on open; A creates T at the key above the top and
// deletes it; a stale client (it never saw T) moves `rect` onto that key. Until wave 5 the room stored that
// share (its index cache held live elements only); since 2A's fix it re-keys the push, so the share a board
// kept from an older room is written into the file with the sync stopped (wave-5 engine integration). R0
// (today's registry, in-process) recolours or moves `rect`; the sync
// opens the board again. On beff59d the roll-forward failed (`rollforward:failed:validation`), the joiner
// got PREPARING then 4099 CONVERSION_FAILED and the snapshot route answered 503. Now the merge repairs the
// share: the board opens, every key is unique, and the paint order is the one the room served.
import { indexKeyBetween } from '@draftroom/canvas-schema/engine'
import type { TLRecord } from '@draftroom/tldraw-import/tldraw'
import { describe, expect, it } from 'vitest'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { callInternal } from '../harness/tickets.ts'
import { excalidrawEdit, fixtureRecords, lbRows, seedBoardRecords } from './board-files.ts'
import { r0Edit } from './support.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('roll-forward on open after a key share the room admitted', () => {
  for (const variant of ['recolour', 'move'] as const)
    it(`R0 ${variant}s the shape: the board opens`, { timeout: 120_000 }, async () => {
      const dataDir = h.dataDir()
      const rooms = `${dataDir}/rooms`
      const boardId = newBoardId()
      const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
      const st = await h.stack({ dataDir })
      const a = await st.client({ boardId, user: 'alice', tab: 'a' })
      const all = [...a.confirmed.values()] as Array<{ index: string }>
      const top = all
        .map((e) => e.index)
        .sort()
        .at(-1) as string
      await a.create([rect('rfT', { x: -9000, y: -9000, index: indexKeyBetween(top, null) })])
      const tIdx = (a.confirmed.get('rfT') as { index: string }).index
      await a.push([
        { k: 'p', id: 'rfT', pv: a.confirmed.get('rfT')?.version, g: { life: { isDeleted: true } } },
      ])
      const b = await st.client({ boardId, user: 'alice', tab: 'b' })
      const rv = (b.confirmed.get('rect') as { version: number }).version
      await b.push([{ k: 'p', id: 'rect', pv: rv, g: { z: { index: tIdx } } }])
      await sleep(200)
      // Since wave 5 the room no longer stores the share (2A: its index cache holds the tombstones' keys,
      // so the stale push is re-keyed and told by `fix`) ...
      expect(lbRows(path).get('rect')?.idx).not.toBe(tIdx)
      a.close()
      b.close()
      await st.server.kill('SIGTERM')
      // ... but a board an older room wrote can still hold one: put it in the file as that room stored it
      // (the label stays after its container), with the sync stopped.
      excalidrawEdit(path, 'rect', ['z'], (e) => {
        e.index = tIdx
      })
      if (lbRows(path).has('rect.t'))
        excalidrawEdit(path, 'rect.t', ['z'], (e) => {
          e.index = indexKeyBetween(tIdx, null)
        })
      const shared = lbRows(path)
      // the precondition: a live element and a tombstone on one key
      expect(shared.get('rect')?.idx).toBe(tIdx)
      expect(shared.get('rfT')).toMatchObject({ idx: tIdx, deleted: 1 })
      const servedOrder = [...shared.values()]
        .filter((r) => r.deleted === 0)
        .sort((x, y) => (x.idx < y.idx ? -1 : x.idx > y.idx ? 1 : x.id < y.id ? -1 : 1))
        .map((r) => r.id)
      r0Edit(rooms, boardId, (txn) => {
        const r = txn.get('shape:rect') as TLRecord & { x: number; props: Record<string, unknown> }
        if (variant === 'recolour')
          txn.set('shape:rect', {
            ...r,
            props: { ...r.props, color: r.props.color === 'red' ? 'blue' : 'red' },
          } as TLRecord)
        else txn.set('shape:rect', { ...r, x: r.x + 40 } as TLRecord)
      })
      const st2 = await h.stack({ dataDir })
      const c = await st2.socket({ boardId, user: 'carol', tab: 'c' })
      await c.hello()
      expect((c.received[0] as { code?: string } | undefined)?.code).toBe('PREPARING')
      const status = (await (
        await callInternal(st2.server.url, 'GET', '/internal/migrate/status')
      ).json()) as {
        boards: { boardId: string; kind: string; state: string; reason?: string }[]
      }
      expect(status.boards.filter((x) => x.boardId === boardId).map((x) => `${x.kind}:${x.state}`)).toEqual([
        'rollforward:done',
      ])
      const snap = await callInternal(st2.server.url, 'GET', `/internal/boards/${boardId}/snapshot`)
      expect(snap.status).toBe(200)
      await snap.arrayBuffer()
      c.close()
      await st2.server.kill('SIGTERM')
      const after = lbRows(path)
      const keys = [...after.values()].map((r) => r.idx)
      expect(new Set(keys).size).toBe(keys.length)
      expect(after.get('rfT')).toEqual(shared.get('rfT'))
      const order = [...after.values()]
        .filter((r) => r.deleted === 0)
        .sort((x, y) => (x.idx < y.idx ? -1 : x.idx > y.idx ? 1 : x.id < y.id ? -1 : 1))
        .map((r) => r.id)
      expect(order).toEqual(servedOrder)
    })
})
