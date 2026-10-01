// Wave 5, the engine fixer (acting for 2A and 2B) after the spike verifiers' re-check of 5caee00, against
// the REAL sync server process (DRAFTROOM_ENGINE=excalidraw). Each case failed before its fix:
//   V2 P-M2/P-M4  maintenance refuses the engine's board-writing internal routes (router.ts)
//   V2 P-W3c      the reset-snapshot cache is dropped when a client push deletes (element-room.ts)
//   V2 P-W7/P-W8  a create over another user's tombstone with new content is the writer's (merge.ts)
//   V2 P-W6       a name-only guest revives only its own tombstones (merge.ts mayRevive)
//   V2 P-G2       a guest's label detached into a free text counts toward the 500-item cap (merge.ts)
//   V1 W2         a member created where its frame no longer is becomes a free element (merge.ts)
import { decodeSnapshotFrame } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { callInternal } from '../harness/tickets.ts'
import { type ClientOptions, RawClient } from './support/client.ts'
import { type El, frame, label, note, rect, text, withLabel } from './support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const T = 120_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type R = { ok: boolean; code?: string; fix?: Record<string, unknown>; el?: El | null }
const codes = (ack: { r: unknown[] }) => (ack.r as R[]).map((r) => (r.ok ? 'ok' : (r.code ?? '?')))
const patch = (c: RawClient, id: string, rest: El) => ({
  k: 'p',
  id,
  pv: c.confirmed.get(id)?.version ?? 1,
  ...rest,
})
async function stored(st: ElementStack, b: string): Promise<Map<string, El>> {
  const s = await st.snapshot(b)
  return new Map(s.elements.map((e) => [(e as El).id as string, e as El]))
}
const who = (e: El | undefined) => {
  const ls = e?.customData?.lobbyServer as
    | { createdBy?: { uid: string }; lastEditedBy?: { uid: string } | null }
    | undefined
  return { createdBy: ls?.createdBy?.uid ?? null, lastEditedBy: ls?.lastEditedBy?.uid ?? null }
}

/** A raw client that keeps every frame it received as text (binary snapshot frames decoded). */
async function spy(st: ElementStack, opts: Omit<ClientOptions, 'wsUrl'>) {
  const c = new RawClient({ wsUrl: st.server.wsUrl, ...opts, hello: false } as ClientOptions)
  const frames: string[] = []
  const pending: Promise<unknown>[] = []
  c.ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary)
      pending.push(
        decodeSnapshotFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).then(
          (f) => frames.push(`SNAPSHOT ${JSON.stringify(f)}`),
          (e) => frames.push(`SNAPSHOT-DECODE-ERROR ${String(e)}`),
        ),
      )
    else frames.push(data.toString('utf8'))
  })
  await c.opened
  await c.hello(0, null)
  await Promise.allSettled(pending)
  return { c, all: () => frames.join('\n') }
}

describe('maintenance on the Excalidraw engine (V2 P-M2, P-M4)', () => {
  it(
    'refuses every board-writing internal route 503 MAINTENANCE, lets convert-all and the reads through',
    async () => {
      const st = await h.stack({ env: { DRAFTROOM_BOOT_MAINTENANCE: '1' } })
      const b = newBoardId()
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await callInternal(st.server.url, method, path, body === undefined ? {} : { body })
        const txt = await res.text().catch(() => '')
        return `${res.status}${/MAINTENANCE/.test(txt) ? ':MAINTENANCE' : ''}`
      }
      const seedBody = { format: 'lobby-elements', elements: [rect('s1', { index: 'a0' })], doc: {} }
      expect(await call('POST', `/internal/boards/${b}/seed`, seedBody)).toBe('503:MAINTENANCE')
      expect(await call('POST', `/internal/test/boards/${b}/server-write`, { put: [rect('sw1')] })).toBe(
        '503:MAINTENANCE',
      )
      expect(await call('POST', `/internal/boards/${b}/deleted/restore`, { ids: ['shape:s1'] })).toBe(
        '503:MAINTENANCE',
      )
      expect(await call('POST', `/internal/boards/${b}/place-notes`, {})).toBe('503:MAINTENANCE')
      expect(
        await call('POST', `/internal/boards/${b}/workshop-state`, { voteOpen: true, anonymous: false }),
      ).toBe('503:MAINTENANCE')
      // the cut-over's own conversion runs inside the window (§7.5 step 6)
      expect(await call('POST', '/internal/migrate/convert-all', {})).toBe('202')
      expect(await call('GET', '/internal/migrate/status')).toBe('200')
      expect(await call('GET', `/internal/boards/${b}/snapshot`)).toBe('404')
      expect(await call('GET', '/internal/maintenance')).toBe('200')
      // off again: the same seed lands
      expect(await call('POST', '/internal/maintenance', { on: false })).toBe('200')
      expect(await call('POST', `/internal/boards/${b}/seed`, seedBody)).toBe('201')
      // switched on at runtime (P-M2): refused again
      expect(await call('POST', '/internal/maintenance', { on: true })).toBe('200')
      expect(await call('POST', `/internal/test/boards/${b}/server-write`, { put: [rect('sw2')] })).toBe(
        '503:MAINTENANCE',
      )
    },
    T,
  )
})

describe('the reset-snapshot cache after a client delete (V2 P-W3c, W5-02)', () => {
  it(
    'a joiner within 5 s of a delete by push gets no word of the deleted element',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const S = `SECRET-${Math.random().toString(36).slice(2, 10)}`
      const a = await st.client({ boardId: b, user: 'author', role: 'owner' })
      await a.create([text('t1', { text: S, originalText: S }), rect('keep', { x: 600 })])
      await sleep(5_200) // the author's own join no longer caches the (empty) snapshot
      const v0 = await st.client({ boardId: b, user: 'v0', role: 'viewer' }) // caches t1 live
      await a.push([patch(a, 't1', { g: { life: { isDeleted: true } } })])
      const g = await spy(st, { boardId: b, user: 'guest-viewer', role: 'viewer', guest: true })
      expect(g.c.welcome?.reset).toBe(true)
      expect(g.all().includes(S)).toBe(false)
      expect(g.c.confirmed.get('t1')?.isDeleted).toBe(true)
      g.c.close()
      v0.close()
      a.close()
    },
    T,
  )
})

describe('authorship through a tombstone id (V2 P-W7, P-W8)', () => {
  it(
    "an editor's create with new content over a staff member's deleted id is the editor's; a same-content revive keeps the author; a guest's is refused",
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'staff', role: 'owner' })
      await a.create([
        text('ft', { x: 400, text: 'staff words', originalText: 'staff words' }),
        rect('r1', { x: 800 }),
        rect('r2', { x: 1200 }),
        text('ft2', { x: 1600, text: 'more staff words', originalText: 'more staff words' }),
      ])
      const r2 = a.confirmed.get('r2') as El
      await a.push([
        patch(a, 'ft', { g: { life: { isDeleted: true } } }),
        patch(a, 'r1', { g: { life: { isDeleted: true } } }),
        patch(a, 'r2', { g: { life: { isDeleted: true } } }),
        patch(a, 'ft2', { g: { life: { isDeleted: true } } }),
      ])
      const e = await st.client({ boardId: b, user: 'ed', role: 'editor' })
      const g = await st.client({ boardId: b, user: 'gina', role: 'editor', guest: true })
      const v = await st.client({ boardId: b, user: 'vic', role: 'viewer' })
      // an account editor: the ids and versions are in the redacted snapshot; new content under them
      const created = await e.create([
        text('ft', { x: 400, text: 'FORGED', originalText: 'FORGED', version: 1 }),
        rect('r1', { x: 800, backgroundColor: '#ff0000', version: 1 }),
      ])
      expect(codes(created)).toEqual(['ok', 'ok'])
      // a name-only guest may not bring another user's tombstone back at all (P-W6)
      const forged = await g.create([
        text('ft2', { x: 1600, text: 'FORGED-2', originalText: 'FORGED-2', version: 1 }),
      ])
      expect(codes(forged)).toEqual(['GONE'])
      // the staff member brings r2 back as it was (an undo): still the staff member's
      const undo = await a.create([rect('r2', { x: 1200, version: r2.version })])
      expect(codes(undo), JSON.stringify(undo.r)).toEqual(['ok'])
      await v.untilClock(a.clock)
      const s = await stored(st, b)
      expect(who(s.get('ft'))).toEqual({ createdBy: 'ed', lastEditedBy: 'ed' })
      expect(who(s.get('r1')).createdBy).toBe('ed')
      expect(who(s.get('r2')).createdBy).toBe('staff')
      expect(s.get('ft2')?.isDeleted).toBe(true)
      expect(who(v.confirmed.get('ft'))).toEqual({ createdBy: 'ed', lastEditedBy: 'ed' })
      a.close()
      e.close()
      g.close()
      v.close()
    },
    T,
  )
})

describe("a name-only guest and other people's tombstones (V2 P-W6)", () => {
  it(
    "cannot revive another user's deleted element (GONE); can revive its own, and one it deleted itself",
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'staff', role: 'owner' })
      await a.create([
        text('s1', { text: 'staff secret', originalText: 'staff secret' }),
        rect('s2', { x: 600 }),
      ])
      await a.push([patch(a, 's1', { g: { life: { isDeleted: true } } })])
      const g = await st.client({ boardId: b, user: 'gina', role: 'editor', guest: true })
      // the redacted snapshot names s1 with no content; a life patch and a create over it are both refused
      const revive = await g.push([patch(g, 's1', { g: { life: { isDeleted: false } } })])
      expect(codes(revive)).toEqual(['GONE'])
      const over = await g.create([text('s1', { text: 'x', originalText: 'x', version: 1 })])
      expect(codes(over)).toEqual(['GONE'])
      expect((await stored(st, b)).get('s1')?.isDeleted).toBe(true)
      // its own element: delete and undo
      await g.create([rect('g1', { x: 900 })])
      await g.push([patch(g, 'g1', { g: { life: { isDeleted: true } } })])
      expect(codes(await g.push([patch(g, 'g1', { g: { life: { isDeleted: false } } })]))).toEqual(['ok'])
      // a staff element the guest deleted itself: its undo works
      await g.push([patch(g, 's2', { g: { life: { isDeleted: true } } })])
      expect(codes(await g.push([patch(g, 's2', { g: { life: { isDeleted: false } } })]))).toEqual(['ok'])
      // an account editor is not restricted
      const e = await st.client({ boardId: b, user: 'ed', role: 'editor' })
      expect(codes(await e.push([patch(e, 's1', { g: { life: { isDeleted: false } } })]))).toEqual(['ok'])
      a.close()
      g.close()
      e.close()
    },
    T,
  )
})

describe("a guest's labels detached into free texts (V2 P-G2, D5)", () => {
  it(
    'count toward the 500-item cap',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const g = await st.client({ boardId: b, user: 'gina', role: 'editor', guest: true })
      // 498 rectangles and a note with a label: 499 items
      for (let k = 0; k < 498; k += 100) {
        const batch: El[] = []
        for (let j = k; j < Math.min(k + 100, 498); j++)
          batch.push(rect(`r${j}`, { x: (j % 50) * 30, y: Math.floor(j / 50) * 30 }))
        const ack = await g.create(batch)
        expect(new Set(codes(ack))).toEqual(new Set(['ok']))
      }
      const t = label('n.t', 'n', { text: 'w', originalText: 'w' })
      expect(codes(await g.create([withLabel(note('n', { x: 2000 }), t), t]))).toEqual(['ok', 'ok'])
      // the detach makes the label the 500th item
      expect(codes(await g.push([patch(g, 'n.t', { g: { bind: { containerId: null } } })]))).toEqual(['ok'])
      // one more is over the cap (before: the detached label was never counted, 501 items were live)
      expect(codes(await g.create([rect('one-more', { x: 3000 })]))).toEqual(['GUEST_LIMIT'])
      const live = [...(await stored(st, b)).values()].filter(
        (e) => !e.isDeleted && !(e.type === 'text' && e.containerId),
      )
      expect(live.length).toBe(500)
      g.close()
    },
    T,
  )
})

describe('a member created where its frame no longer is (V1 W2, W5-01 under a concurrent frame move)', () => {
  it(
    'is stored as a free element, and the ack says so; one inside the frame keeps its membership',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice', role: 'owner' })
      const bob = await st.client({ boardId: b, user: 'bob', role: 'editor' })
      await a.create([frame('F', { x: 0, y: 0, width: 400, height: 300 })])
      await bob.untilClock(a.clock)
      await bob.push([patch(bob, 'F', { g: { pos: { x: 1000, y: 0 } } })])
      await a.untilClock(bob.clock)
      // alice's client still placed the note against the frame's old position
      const ack = await a.create([
        rect('outside', { x: 50, y: 50, width: 100, height: 80, frameId: 'F' }),
        rect('inside', { x: 1050, y: 50, width: 100, height: 80, frameId: 'F' }),
      ])
      expect(codes(ack)).toEqual(['ok', 'ok'])
      expect(((ack.r as R[])[0]?.fix ?? {}).frameId).toBeNull()
      const s = await stored(st, b)
      expect(s.get('outside')?.frameId).toBeNull()
      expect(s.get('inside')?.frameId).toBe('F')
      a.close()
      bob.close()
    },
    T,
  )
})
