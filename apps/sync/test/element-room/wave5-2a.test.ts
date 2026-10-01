// Wave 5, owner 2A (the sync room): regressions for the early wave-5 review's room findings and the spike
// B verifiers' last open room items, on the REAL sync server process. Each test failed on f336ae4 (the
// wave-5 base of engine/excalidraw) and passes with the fix it names:
//   - W5-02 (blocker): no role receives a deleted element's content over the canvas socket: the reset
//     snapshot, catch-ups, the delete's broadcast and a reject's `el` carry redacted tombstones;
//     undeletes and "Recently deleted" still bring the full element back;
//   - W5-05: a template frame moves with its locked heading and locked notes (never half a move);
//   - V2's re-check: one user's sockets are capped, its welcomes are fair-queued and budgeted, the
//     guest cap counts tombstones, the lease cap is per user, a malformed escape hides no signed URL, a
//     server write may not leave a new invariant violation on a neighbour;
//   - V3's low: a live element never takes a tombstone's z-order key (pushes and server writes).

import { hashElements } from '@draftroom/canvas-schema/hash'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { ELEMENT_SCHEMA_VERSION, PROTO } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { callInternal } from '../harness/tickets.ts'
import { type RawClient, ticketFor } from './support/client.ts'
import { type El, frame, label, note, rect, text, withLabel } from './support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const T = 180_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type R = { ok: boolean; code?: string; fix?: El; denied?: { groups: string[]; code: string }; el?: El | null }
const r0 = (ack: { r: unknown[] }) => ack.r[0] as R
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
async function violations(st: ElementStack, b: string): Promise<string[]> {
  const s = await st.snapshot(b)
  return checkInvariants(s.elements as never).map((v) => `${v.code}:${v.id}`)
}

// ---- W5-02 ---------------------------------------------------------------------------------------------

/**
 * A tombstone that carries nothing of the deleted element: no customData (authors), text, link, name,
 * membership or geometry (the wire form of W5-02, checked field by field, independent of canvas-schema).
 */
const contentFree = (e: El): boolean =>
  e.isDeleted === true &&
  e.customData === undefined &&
  !e.text &&
  !e.originalText &&
  !e.link &&
  !e.name &&
  (e.groupIds ?? []).length === 0 &&
  (e.frameId ?? null) === null &&
  (e.containerId ?? null) === null &&
  (e.boundElements ?? null) === null &&
  e.x === 0 &&
  e.y === 0 &&
  (e.fileId === undefined || e.fileId === 'ver_0000000000')

/** Words that are on the board only while the elements live (and in the server's full rows). */
const SECRET = [
  'internal margin note',
  'confidential plan',
  'Hidden roadmap',
  'https://intranet.example/doc',
] as const

/** alice (owner) makes a labelled note, a free text, a named frame and a linked rectangle, then deletes them. */
async function deletedContent(st: ElementStack) {
  const b = newBoardId()
  const a = await st.client({ boardId: b, user: 'alice', role: 'owner' })
  const t = label('n1.t', 'n1', { text: SECRET[0], originalText: SECRET[0] })
  await a.create([
    withLabel(note('n1'), t),
    t,
    text('t1', { x: 400, text: SECRET[1], originalText: SECRET[1] }),
    frame('f1', { x: 0, y: 600, name: SECRET[2] }),
    rect('r1', { x: 900, link: SECRET[3] }),
  ])
  await a.push(['n1', 't1', 'f1', 'r1'].map((id) => patch(a, id, { g: { life: { isDeleted: true } } })))
  return { b, a }
}

/**
 * Everything about elements the client received (the decoded snapshot, catch-ups, `changes`, acks), for
 * leak checks. Not the roster or presence: they name the people in the room, which is not deleted content.
 */
const everything = (c: RawClient) =>
  JSON.stringify([
    [...c.confirmed.values()],
    c.received.filter((m) => m.type === 'changes' || m.type === 'ack'),
    c.received.flatMap((m) => (m.type === 'welcome' ? [m.catchUp] : [])),
  ])

/** The secret words anywhere in what the client got, and an author's name on any tombstone it holds. */
const leaks = (c: RawClient) => [
  ...SECRET.filter((s) => everything(c).includes(s)),
  ...[...c.confirmed.values()]
    .filter((e) => e.isDeleted && JSON.stringify(e).includes('alice'))
    .map((e) => `author on ${e.id}`),
]

describe('W5-02: tombstones carry no content to any role', () => {
  it(
    'a viewer’s, a commenter’s and a guest’s reset snapshot hold redacted tombstones only, and converge with the server',
    async () => {
      const st = await h.stack()
      const { b } = await deletedContent(st)
      const server = await st.snapshot(b)
      // the server keeps the full rows ("Recently deleted", restores)
      expect(JSON.stringify(server.elements)).toContain(SECRET[0])
      for (const who of [
        { user: 'vic', role: 'viewer' as const },
        { user: 'cam', role: 'commenter' as const },
        { user: 'gus', role: 'viewer' as const, guest: true },
        { user: 'ed', role: 'editor' as const },
      ]) {
        const c = await st.client({ boardId: b, ...who })
        expect(c.welcome?.reset).toBe(true)
        expect(leaks(c), who.user).toEqual([])
        const dead = [...c.confirmed.values()].filter((e) => e.isDeleted)
        expect(dead.length).toBe(5) // n1, its label, t1, f1, r1
        for (const e of dead) expect(contentFree(e as never), `${who.user}: ${e.id}`).toBe(true)
        expect(await c.hash()).toBe(await hashElements(server.elements))
        expect(c.schemaErrors).toEqual([])
        c.close()
      }
    },
    T,
  )

  it(
    'a catch-up carries the redacted tombstone; a delete reaches live sessions as the exact patch of what it changed',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice', role: 'owner' })
      const v = await st.client({ boardId: b, user: 'vic', role: 'viewer' })
      // a delete that also moves the text: the sessions that held it live get the exact patch (their copy
      // stays the server's: a client diffs its pushes against it, e.g. an arrow's bindings nulled by the
      // same delete must reach it, or its undo never sends them back)
      await a.create([text('t2', { text: 'before', originalText: 'before' })])
      await v.untilClock(a.clock)
      await a.push([patch(a, 't2', { g: { pos: { x: 77, y: 0 }, life: { isDeleted: true } } })])
      await v.untilClock(a.clock)
      const delOp = v
        .of('changes')
        .flatMap((m) => m.ops)
        .find((o) => o.k === 'p' && o.id === 't2')
      expect(delOp?.k === 'p' && Object.keys(delOp.g ?? {}).sort()).toEqual(['life', 'pos'])
      expect(await v.hash()).toBe(await hashElements((await st.snapshot(b)).elements))
      expect(v.confirmed.get('t2')).toEqual((await stored(st, b)).get('t2'))
      // a reconnect with `since` gets the tombstone as a redacted catch-up row
      const since = v.clock
      const epoch = v.epoch
      v.close()
      await a.create([text('t3', { x: 300, text: SECRET[1], originalText: SECRET[1] })])
      await a.push([patch(a, 't3', { g: { life: { isDeleted: true } } })])
      const v2 = await st.client({
        boardId: b,
        user: 'vic',
        role: 'viewer',
        since,
        epoch,
        confirmed: v.confirmed,
      })
      expect(v2.welcome?.reset).toBe(false)
      const row = v2.welcome?.catchUp?.find((o) => o.k === 'c' && o.el.id === 't3')
      expect(row?.k === 'c' && contentFree(row.el as never)).toBe(true)
      // t3 was made and deleted while the viewer was away: its words never reached it
      expect(everything(v2).includes(SECRET[1])).toBe(false)
      expect(await v2.hash()).toBe(await hashElements((await st.snapshot(b)).elements))
    },
    T,
  )

  it(
    'a refused op on a tombstone answers the redacted element: a viewer cannot probe deleted ids for content',
    async () => {
      const st = await h.stack()
      const { b } = await deletedContent(st)
      const v = await st.client({ boardId: b, user: 'vic', role: 'viewer' })
      for (const id of ['n1.t', 't1', 'f1', 'r1']) {
        const ack = await v.push([{ k: 'p', id, pv: 1, g: { life: { isDeleted: false } } }])
        const r = r0(ack)
        expect(r.ok).toBe(false)
        expect(r.code).toBe('READ_ONLY')
        expect(r.el && contentFree(r.el as never), id).toBe(true)
      }
      expect(leaks(v)).toEqual([])
    },
    T,
  )

  it(
    'an undelete reaches a joiner that holds only the redacted tombstone as the full element; "Recently deleted" restores it',
    async () => {
      const st = await h.stack()
      const { b, a } = await deletedContent(st)
      const v = await st.client({ boardId: b, user: 'vic', role: 'viewer' })
      // alice's undo of her delete (a `life` patch on the tombstone, §2.8)
      await a.untilClock(v.clock)
      expect(r0(await a.push([patch(a, 't1', { g: { life: { isDeleted: false } } })])).ok).toBe(true)
      await v.untilClock(a.clock)
      expect(v.confirmed.get('t1')?.originalText).toBe(SECRET[1])
      expect(v.confirmed.get('t1')?.isDeleted).toBe(false)
      // the api's "Recently deleted" reads the full rows and restores through the room
      const list = await callInternal(st.server.url, 'GET', `/internal/boards/${b}/deleted`)
      expect(list.status).toBe(200)
      const entries = ((await list.json()) as { entries: { shapeId: string; label: string }[] }).entries
      expect(entries.some((e) => e.shapeId === 'shape:n1' && e.label.includes(SECRET[0]))).toBe(true)
      const res = await callInternal(st.server.url, 'POST', `/internal/boards/${b}/deleted/restore`, {
        body: { ids: ['shape:n1'] },
      })
      expect(res.status).toBe(200)
      await v.until(() => v.confirmed.get('n1.t')?.isDeleted === false, 'restored label')
      expect(v.confirmed.get('n1.t')?.originalText).toBe(SECRET[0])
      expect(await v.hash()).toBe(await hashElements((await st.snapshot(b)).elements))
      expect(await violations(st, b)).toEqual([])
    },
    T,
  )
})

// ---- W5-05 ---------------------------------------------------------------------------------------------

/** A template frame: an unlocked frame F with a locked heading H, a locked note L (label L.t) and a free note U. */
async function templateFrame(st: ElementStack) {
  const b = newBoardId()
  const a = await st.client({ boardId: b, user: 'alice' })
  const lt = label('L.t', 'L', { x: 220, y: 300, text: 'step one', originalText: 'step one', frameId: 'F' })
  await a.create([
    frame('F', { x: 0, y: 0, width: 1000, height: 800 }),
    text('H', { x: 40, y: 20, text: 'Retro', originalText: 'Retro', locked: true, frameId: 'F' }),
    withLabel(note('L', { x: 200, y: 200, locked: true, frameId: 'F' }), lt),
    lt,
    note('U', { x: 500, y: 200, frameId: 'F' }),
  ])
  return { b, a }
}

/** The ops a client pushes when it drags frame F by (dx, dy): the frame and every member, by the same delta. */
function frameDrag(a: RawClient, dx: number, dy: number, override: Record<string, El> = {}) {
  const at = (id: string) => a.confirmed.get(id) as El
  const pos = (id: string) => ({ x: at(id).x + dx, y: at(id).y + dy })
  return [
    patch(a, 'F', { g: { pos: pos('F') } }),
    patch(a, 'H', override.H ?? { g: { pos: pos('H') } }),
    patch(a, 'L', { g: { pos: pos('L') } }),
    patch(a, 'L.t', { g: { layout: pos('L.t') } }),
    patch(a, 'U', { g: { pos: pos('U') } }),
  ]
}

describe('W5-05: a frame moves with its locked heading and notes', () => {
  it(
    'a frame drag moves its locked members by the same delta: every op saved, nothing denied',
    async () => {
      const st = await h.stack()
      const { b, a } = await templateFrame(st)
      const ack = await a.push(frameDrag(a, 300, 150))
      for (const r of ack.r as R[]) {
        expect(r.ok).toBe(true)
        expect(r.denied).toBeUndefined()
      }
      const els = await stored(st, b)
      expect([els.get('F')?.x, els.get('F')?.y]).toEqual([300, 150])
      expect([els.get('H')?.x, els.get('H')?.y]).toEqual([340, 170])
      expect([els.get('L')?.x, els.get('L')?.y]).toEqual([500, 350])
      expect([els.get('L.t')?.x, els.get('L.t')?.y]).toEqual([520, 450])
      expect(els.get('H')?.locked).toBe(true)
      expect(await violations(st, b)).toEqual([])
    },
    T,
  )

  it(
    'the lock still holds: a locked member moved alone, by another delta, or with other changes keeps them refused',
    async () => {
      const st = await h.stack()
      const { b, a } = await templateFrame(st)
      // alone (no frame move in the push)
      const alone = r0(await a.push([patch(a, 'H', { g: { pos: { x: 99, y: 99 } } })]))
      expect(alone.ok ? alone.denied?.code : alone.code).toBe('LOCKED')
      // with the frame, but by another delta
      const other = await a.push(frameDrag(a, 100, 0, { H: { g: { pos: { x: 40 + 250, y: 20 } } } }))
      const h1 = other.r[1] as R
      expect(h1.ok ? h1.denied?.code : h1.code).toBe('LOCKED')
      // with the frame and the same delta, plus a text change: the move lands, the words do not
      const at = (id: string) => a.confirmed.get(id) as El
      const words = await a.push(
        frameDrag(a, 50, 0, {
          H: {
            g: {
              pos: { x: at('H').x + 50, y: at('H').y },
              text: { originalText: 'Hacked' },
              layout: { text: 'Hacked' },
            },
          },
        }),
      )
      const h2 = words.r[1] as R
      expect(h2.ok).toBe(true)
      expect(h2.denied?.code).toBe('LOCKED')
      expect(h2.denied?.groups.sort()).toEqual(['layout', 'text'])
      const H = (await stored(st, b)).get('H') as El
      expect(H.originalText).toBe('Retro')
      // the push before left H behind (its delta was not the frame's); this one moved both by 50
      expect(H.x).toBe(90)
    },
    T,
  )

  it(
    'never half a move: when the frame’s own op is refused, its locked members stay where they were',
    async () => {
      const st = await h.stack()
      const { b, a } = await templateFrame(st)
      const bob = await st.client({ boardId: b, user: 'bob' })
      const base = a.clock
      // bob moves the frame first; alice's offline replay of a drag (older than 10 min) is STALE on F
      await bob.push([patch(bob, 'F', { g: { pos: { x: 10, y: 10 } } })])
      await a.untilClock(bob.clock)
      const ops = frameDrag(a, 300, 0).map((o, i) =>
        i === 0 ? { ...o, off: 700_000 } : { ...o, pv: a.confirmed.get(o.id)?.version ?? 1 },
      )
      const ack = await a.push(ops, { base })
      expect((ack.r[0] as R).code).toBe('STALE')
      for (const i of [1, 2, 3]) {
        const r = ack.r[i] as R
        expect(r.ok ? r.denied?.code : r.code, `op ${i}`).toBe('LOCKED')
      }
      const els = await stored(st, b)
      expect([els.get('H')?.x, els.get('L')?.x, els.get('L.t')?.x]).toEqual([40, 200, 220])
    },
    T,
  )
})

// ---- V2's re-check -----------------------------------------------------------------------------------------

/** A board with `n` elements (pushes of 500). */
async function bigBoard(st: ElementStack, n: number) {
  const b = newBoardId()
  const a = await st.client({ boardId: b, user: 'alice' })
  for (let i = 0; i < n; i += 500)
    await a.create(
      Array.from({ length: Math.min(500, n - i) }, (_, k) =>
        rect(`r${i + k}`, { x: (i + k) * 3, y: 0, width: 20, height: 20 }),
      ),
    )
  return { b, a }
}

/** A raw viewer socket that only counts its welcomes and remembers how it closed. */
interface Flood {
  ws: WebSocket
  tab: string
  welcomes: number
  closed: { code: number; reason: string } | null
}
async function floodSocket(st: ElementStack, boardId: string, user: string, tab: string): Promise<Flood> {
  const ticket = encodeURIComponent(ticketFor(boardId, user, 'viewer'))
  const ws = new WebSocket(
    `${st.server.wsUrl}/connect/${boardId}?sessionId=${encodeURIComponent(tab)}&ticket=${ticket}`,
  )
  const f: Flood = { ws, tab, welcomes: 0, closed: null }
  ws.on('message', (data, binary) => {
    if (!binary && (data as Buffer).subarray(0, 18).toString() === '{"type":"welcome",') f.welcomes++
  })
  ws.on('close', (code, reason) => {
    f.closed = { code, reason: reason.toString() }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return f
}

describe('V2: one user cannot crowd out everyone else', () => {
  it(
    'one user’s element sockets are capped on the process: the 21st is closed 4099 RATE_LIMITED',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const socks: RawClient[] = []
      for (let i = 0; i < 20; i++)
        socks.push(await st.client({ boardId: b, user: 'mallory', role: 'viewer', tab: `m-${i}` }))
      const extra = await st.socket({ boardId: b, user: 'mallory', role: 'viewer', tab: 'm-20' })
      expect(await extra.untilClosed()).toEqual({ code: 4099, reason: 'RATE_LIMITED' })
      // another user is not affected, and a freed slot is usable again
      const carol = await st.client({ boardId: b, user: 'carol', role: 'viewer' })
      expect(carol.welcome).not.toBeNull()
      ;(socks[0] as RawClient).close()
      await (socks[0] as RawClient).untilClosed()
      await sleep(200)
      const again = await st.client({ boardId: b, user: 'mallory', role: 'viewer', tab: 'm-21' })
      expect(again.welcome).not.toBeNull()
    },
    T,
  )

  it(
    'a viewer flooding large catch-ups on one board delays no join on another (fair, budgeted welcomes)',
    async () => {
      const st = await h.stack()
      const { b, a } = await bigBoard(st, 3_000)
      const epoch = a.epoch
      // raw sockets: the test process does not parse what the flood gets (that would starve carol's client)
      const mal: Flood[] = []
      for (let i = 0; i < 20; i++) mal.push(await floodSocket(st, b, 'mallory', `m-${i}`))
      const hello = { type: 'hello', proto: PROTO, schema: ELEMENT_SCHEMA_VERSION, since: 0, epoch }
      for (const m of mal) for (let k = 0; k < 5; k++) m.ws.send(JSON.stringify({ ...hello, tab: m.tab }))
      // carol joins another board while 100 catch-ups of 3,000 rows are queued
      const t0 = performance.now()
      const carol = await st.client({ boardId: newBoardId(), user: 'carol' })
      const joinMs = performance.now() - t0
      expect(carol.welcome).not.toBeNull()
      expect(joinMs).toBeLessThan(1_000)
      // the flood is budgeted: not every one of the 100 catch-ups was built
      await sleep(3_000)
      const closed = mal.filter((m) => m.closed?.code === 4099 && m.closed.reason === 'RATE_LIMITED').length
      const welcomes = mal.reduce((n, m) => n + m.welcomes, 0)
      for (const m of mal) m.ws.terminate()
      expect(closed).toBeGreaterThan(0)
      expect(welcomes).toBeLessThan(100)
    },
    T,
  )

  it(
    'the guest cap counts the guest’s tombstones: minting and reviving them gets no more than 500 items',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const g = await st.client({ boardId: b, user: 'gina', guest: true })
      const ok = (ack: { r: unknown[] }) => (ack.r as R[]).filter((r) => r.ok).length
      const codes = (ack: { r: unknown[] }) => new Set((ack.r as R[]).map((r) => (r.ok ? 'ok' : r.code)))
      expect(ok(await g.create(Array.from({ length: 50 }, (_, i) => rect(`live${i}`))))).toBe(50)
      const dead = (from: number) =>
        Array.from({ length: 300 }, (_, i) => rect(`dead${from + i}`, { isDeleted: true }))
      expect(ok(await g.create(dead(0)))).toBe(300)
      const second = await g.create(dead(300))
      expect(ok(second)).toBe(150)
      expect(codes(second).has('GUEST_LIMIT')).toBe(true)
      // reviving its tombstones creates nothing new; a new item is still over the cap
      const revive = await g.push(
        Array.from({ length: 300 }, (_, i) => patch(g, `dead${i}`, { g: { life: { isDeleted: false } } })),
      )
      expect(ok(revive)).toBe(300)
      expect(r0(await g.create([rect('one-more')])).code).toBe('GUEST_LIMIT')
      const live = [...(await stored(st, b)).values()].filter((e) => !e.isDeleted)
      expect(live.length).toBeLessThanOrEqual(500)
      // the count survives the room's reopen (a restart reads the tombstones back)
      g.close()
      await st.server.restart()
      const g2 = await st.client({ boardId: b, user: 'gina', guest: true, tab: 'tab-2' })
      expect(r0(await g2.create([rect('after-restart')])).code).toBe('GUEST_LIMIT')
    },
    T,
  )

  it(
    'one editor with 13 tabs holds at most the per-user lease cap; others can still type',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create(Array.from({ length: 53 }, (_, i) => text(`n${i}`, { x: i * 80 })))
      let granted = 0
      for (let t = 0; t < 13; t++) {
        const m = await st.client({ boardId: b, user: 'mallory', tab: `m-${t}` })
        for (let k = 0; k < 4; k++) if ((await m.acquire(`n${t * 4 + k}`)).type === 'lease.grant') granted++
      }
      expect(granted).toBeLessThanOrEqual(8)
      expect(granted).toBeGreaterThanOrEqual(4)
      // alice gets a lease on a note mallory asked for after the cap
      expect((await a.acquire('n40')).type).toBe('lease.grant')
      const w = r0(
        await a.push([patch(a, 'n40', { g: { text: { originalText: 'mine' }, layout: { text: 'mine' } } })]),
      )
      expect(w.ok && !w.denied).toBe(true)
    },
    T,
  )

  it(
    'a link with a malformed escape and an encoded signed-URL name is INVALID (and a GCS signed URL)',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      for (const [i, link] of [
        'https://x.example/k?X%2DAmz%2DSignature=abc&z=%',
        'https://x.example/k?%58-Amz-Signature=abc&z=%zz',
        'https://x.example/k?X-Goog-Signature=abc&X-Goog-Credential=c',
      ].entries())
        expect(r0(await a.create([rect(`l${i}`, { link })])).code, link).toBe('INVALID')
      expect(r0(await a.create([rect('fine', { link: 'https://example.com/a?off=100%' })])).ok).toBe(true)
      expect([...(await stored(st, b)).keys()]).toEqual(['fine'])
    },
    T,
  )

  it(
    'a server write that leaves a new violation on a neighbour or a group is refused, and nothing is stored',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      const nt = label('n.t', 'n')
      const mt = label('m.t', 'm')
      const ar = {
        ...rect('ar'),
        type: 'arrow',
        width: 100,
        height: 0,
        points: [
          [0, 0],
          [100, 0],
        ],
        startBinding: { elementId: 'r', fixedPoint: [1, 0.5], mode: 'orbit' },
        endBinding: null,
        startArrowhead: null,
        endArrowhead: 'arrow',
        elbowed: false,
      }
      await a.create([
        withLabel(note('n'), nt),
        nt,
        withLabel(note('m', { x: 300 }), mt),
        mt,
        rect('r', { x: 600, boundElements: [{ id: 'ar', type: 'arrow' }] }),
        ar,
        rect('g', { x: 900, groupIds: ['g1'] }),
      ])
      const before = await stored(st, b)
      const write = (body: unknown) =>
        callInternal(st.server.url, 'POST', `/internal/test/boards/${b}/server-write`, { body })
      const cases = [
        { put: [{ ...before.get('n'), boundElements: null }] }, // drops its live label
        { delete: ['m'] }, // a container deleted, its label left live
        { put: [{ ...before.get('r'), boundElements: null }] }, // drops a bound arrow
        { put: [rect('g2', { x: 1200, groupIds: ['g1', 'g2'], index: 'Zz' })] }, // nests a top-level group
      ]
      for (const body of cases)
        expect((await write(body)).status, JSON.stringify(body).slice(0, 60)).toBe(500)
      expect(await violations(st, b)).toEqual([])
      expect((await st.snapshot(b)).clock).toBe(a.clock)
    },
    T,
  )
})

// ---- V3's low --------------------------------------------------------------------------------------------

describe('V3: a live element never takes a tombstone’s z-order key', () => {
  it(
    'a push moving or creating a live element at a tombstone’s key gets a new key (fix)',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create([rect('E', { index: 'a1' }), rect('T', { index: 'a2', x: 200 })])
      await a.push([patch(a, 'T', { g: { life: { isDeleted: true } } })])
      const tKey = (await stored(st, b)).get('T')?.index
      expect(tKey).toBe('a2')
      const mv = r0(await a.push([patch(a, 'E', { g: { z: { index: 'a2' } } })]))
      expect(mv.ok).toBe(true)
      expect(mv.fix?.index).toBeDefined()
      const mk = r0(await a.create([rect('C', { index: 'a2', x: 400 })]))
      expect(mk.ok).toBe(true)
      expect(mk.fix?.index).toBeDefined()
      const els = [...(await stored(st, b)).values()]
      const keys = els.map((e) => e.index as string)
      expect(new Set(keys).size).toBe(keys.length)
      // a fresh browser has nothing to re-key (V3: it pushed a re-key of the tombstone, an echo)
      const v = await st.client({ boardId: b, user: 'vic', role: 'viewer' })
      expect(new Set([...v.confirmed.values()].map((e) => e.index)).size).toBe(v.confirmed.size)
    },
    T,
  )

  it(
    'a server write at a tombstone’s key moves the tombstone; the joiners get it redacted with its new key',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create([rect('E', { index: 'a1' }), rect('T', { index: 'a2', x: 200 })])
      await a.push([patch(a, 'T', { g: { life: { isDeleted: true } } })])
      const v = await st.client({ boardId: b, user: 'vic', role: 'viewer' })
      // a route that picks keys among the live elements (place-notes: above the top live key)
      const res = await callInternal(st.server.url, 'POST', `/internal/test/boards/${b}/server-write`, {
        body: { put: [rect('P', { index: 'a2', x: 600 })] },
      })
      expect(res.status).toBe(200)
      const els = await stored(st, b)
      expect(els.get('P')?.index).toBe('a2')
      expect(els.get('T')?.index).not.toBe('a2')
      expect(els.get('T')?.isDeleted).toBe(true)
      await v.until(() => v.confirmed.get('P') !== undefined, 'P')
      await v.untilClock((await st.snapshot(b)).clock)
      expect(v.confirmed.get('T')?.index).toBe(els.get('T')?.index)
      expect(contentFree(v.confirmed.get('T') as never)).toBe(true)
      expect(await v.hash()).toBe(await hashElements((await st.snapshot(b)).elements))
    },
    T,
  )
})
