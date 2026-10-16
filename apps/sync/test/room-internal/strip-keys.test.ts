// POST /internal/maintenance/strip-keys (wave N, N2-5; room-internal/strip-keys.ts) against the REAL sync server
// process: every `react:*` key out of every board, through each board's room in a normal commit, so the tabs open on
// a board converge on the server's hash (a rev-12 tab of the deployed web, parsing with its own frozen schemas,
// included), and a tab that only receives pushes nothing. Other keys stay; a board with no such key is not
// rewritten; a second run is a no-op; tombstones and "Recently deleted" rows lose them too (the older sync's
// checkElement would refuse their undo and their restore).

import { DatabaseSync } from 'node:sqlite'
import { hashElements } from '@draftroom/canvas-schema/hash'
import { CONNECT_REV_PARAM, CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { reactionKey } from '@draftroom/canvas-schema/reactions'
import { STRIP_KEYS_ROUTE, StripKeysAnswer } from '@draftroom/contracts'
import { dataLayout } from '@draftroom/dev-assets'
import { describe, expect, it } from 'vitest'
import * as Old from '../../../../packages/canvas-schema/test/fixtures/rev12-3c83611/protocol.ts'
import type { FrameSchemas } from '../harness/element-client.ts'
import { type ElementStack, newBoardId, useElementStacks } from '../harness/element-stack.ts'
import { noteWithLabel, rect } from '../harness/elements.ts'
import { callInternal } from '../harness/tickets.ts'
import { sleep } from '../harness/wait.ts'

const h = useElementStacks()

/** How the deployed web (3c83611, rev 12) parses a server frame: its own frozen schemas. */
const REV12_WEB: FrameSchemas = {
  ServerMessage: Old.ServerMessage as unknown as FrameSchemas['ServerMessage'],
  decodeSnapshotFrame: Old.decodeSnapshotFrame,
}
const rev13 = { query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) } }
const TAG = { 'tag:urgent': { name: 'urgent', color: 'red' } }
/** The board's tag list entry that a `tag:urgent` needs. */
const TAG_DEF = { doc: { set: { 'tagDef:urgent': { name: 'urgent', color: 'red' } } } }

async function strip(st: ElementStack, body: unknown = { prefix: 'react:' }) {
  const res = await callInternal(st.server.url, 'POST', STRIP_KEYS_ROUTE, { body })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null }
}
/** The board file's rows that still hold a `"react:` key (elements, live or tombstones, and lb_deleted copies). */
function rowsWithReactions(st: ElementStack, boardId: string): { elements: string[]; deleted: number } {
  const db = new DatabaseSync(`${dataLayout(st.server.dataDir).rooms}/board-${boardId}.sqlite`, {
    readOnly: true,
  })
  try {
    const hasKey = (data: string) =>
      Object.keys(
        ((JSON.parse(data) as { customData?: { lobby?: object } }).customData?.lobby ?? {}) as object,
      ).some((k) => k.startsWith('react:'))
    const elements = (db.prepare('SELECT id, data FROM lb_elements').all() as { id: string; data: string }[])
      .filter((r) => hasKey(r.data))
      .map((r) => r.id)
      .sort()
    const deleted = (db.prepare('SELECT data FROM lb_deleted').all() as { data: string }[]).filter((r) =>
      hasKey(r.data),
    ).length
    return { elements, deleted }
  } finally {
    db.close()
  }
}

describe('POST /internal/maintenance/strip-keys {prefix: react:}', () => {
  it('removes every reaction through the room: other keys stay, every tab converges, a receive-only tab pushes nothing, a second run is a no-op', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const quiet = newBoardId()
    const alice = await st.client({ boardId: b, user: 'alice', role: 'owner', ...rev13 })
    await alice.push([], TAG_DEF)
    const made = await alice.create([
      ...noteWithLabel('n1', 'idea', { customData: { lobby: { ...TAG } } }),
      ...noteWithLabel('n2', 'gone soon', { x: 600 }),
      ...noteWithLabel('n3', 'say "react:up" here', { x: 1200 }),
      rect('r1', { x: 1800 }),
    ])
    expect(made.r.filter((r) => !r.ok)).toEqual([])
    // reactions from a rev-13 headless core (the client code browsers run) and from alice's raw socket
    const bob = await st.headless({ boardId: b, user: 'bob' })
    const n1 = bob.core.elements().get('n1') as unknown as { customData: { lobby: Record<string, unknown> } }
    bob.change('n1', {
      customData: {
        ...n1.customData,
        lobby: { ...n1.customData.lobby, [reactionKey('heart', 'bob')]: true },
      },
    })
    await bob.saved()
    await alice.untilClock(bob.core.clock)
    expect((await alice.patch('n1', { c: { [reactionKey('up', 'alice')]: true } })).ok).toBe(true)
    expect((await alice.patch('n2', { c: { [reactionKey('clap', 'alice')]: true } })).ok).toBe(true)
    // n2 deleted: its tombstone and its "Recently deleted" row hold the reaction
    const del = await alice.push([
      alice.patchOp('n2', { g: { life: { isDeleted: true } } }),
      alice.patchOp('n2.t', { g: { life: { isDeleted: true } } }),
    ])
    expect(del.r.every((r) => r.ok)).toBe(true)
    // a board with no reaction at all, never opened by anyone during the strip
    const other = await st.client({ boardId: quiet, user: 'olga', ...rev13 })
    await other.push([], TAG_DEF)
    expect(
      (await other.create(noteWithLabel('q1', 'plain', { customData: { lobby: { ...TAG } } }))).r.every(
        (r) => r.ok,
      ),
    ).toBe(true)
    other.close()
    // tabs that only receive: the deployed web (rev 12, its own parse) and a rev-13 headless core
    const old = await st.client({
      boardId: b,
      user: 'old-web',
      schemas: REV12_WEB,
      query: { [CONNECT_REV_PARAM]: '12' },
    })
    const watcher = await st.headless({ boardId: b, user: 'watcher' })
    await bob.saved()
    await st.converged(b, [alice, old, watcher, bob])
    expect(rowsWithReactions(st, b)).toEqual({ elements: ['n1', 'n2'], deleted: 1 })
    const quietBefore = await st.snapshot(quiet)
    const pushedBefore = watcher.core.pushLog().length
    const oldFramesBefore = old.rawFrames.length

    const first = await strip(st)
    expect(first.status).toBe(200)
    const answer = StripKeysAnswer.parse(first.body)
    expect(answer).toEqual({ boards: 2, rewritten: 1, elements: 2, keys: 4, failed: 0 })
    expect(st.server.logs()).toContain(
      '[strip-keys] prefix=react: boards=2 rewritten=1 elements=2 keys=4 failed=0',
    )
    // the words, the tag, the label and the rectangle as they were; no reaction anywhere in the file
    expect(rowsWithReactions(st, b)).toEqual({ elements: [], deleted: 0 })
    expect((await st.stored(b, 'n1'))?.customData?.lobby).toEqual(TAG)
    expect((await st.stored(b, 'n3.t'))?.originalText).toBe('say "react:up" here')
    // every tab holds the server's board, the rev-12 one parsing every frame with its own schemas
    await alice.untilClock((await st.snapshot(b)).clock)
    await old.untilClock((await st.snapshot(b)).clock)
    await st.converged(b, [alice, old, watcher, bob])
    expect(old.schemaErrors).toEqual([])
    expect(old.received.length).toBe(old.rawFrames.length)
    expect(old.rawFrames.slice(oldFramesBefore).some((f) => f.startsWith('{"type":"changes"'))).toBe(true)
    // the receive-only core pushed nothing (no echo of a server write)
    await sleep(300)
    expect(watcher.core.pushLog().length).toBe(pushedBefore)
    // the board with no reaction was not rewritten
    expect(await st.snapshot(quiet)).toEqual(quietBefore)

    // again: nothing to do, nothing written
    const clock = (await st.snapshot(b)).clock
    const again = await strip(st)
    expect(again).toEqual({ status: 200, body: { boards: 2, rewritten: 0, elements: 0, keys: 0, failed: 0 } })
    expect((await st.snapshot(b)).clock).toBe(clock)
    // the server's board and the tabs' still agree
    expect(await hashElements((await st.snapshot(b)).elements)).toBe(await alice.hash())
  })

  it('only the listed key classes may be stripped (400 otherwise); internal secret only (401); refused while maintenance is on (503)', async () => {
    const st = await h.stack()
    for (const body of [{ prefix: 'plusOne:' }, { prefix: 'tag:' }, {}, { prefix: 'react:', x: 1 }, 'react:'])
      expect((await strip(st, body)).status, JSON.stringify(body)).toBe(400)
    const res = await callInternal(st.server.url, 'POST', STRIP_KEYS_ROUTE, {
      body: { prefix: 'react:' },
      secret: null,
    })
    expect(res.status).toBe(401)
    const on = await callInternal(st.server.url, 'POST', '/internal/maintenance', { body: { on: true } })
    expect(on.status).toBe(200)
    expect((await strip(st)).status).toBe(503)
    await callInternal(st.server.url, 'POST', '/internal/maintenance', { body: { on: false } })
    expect(await strip(st)).toEqual({
      status: 200,
      body: { boards: 0, rewritten: 0, elements: 0, keys: 0, failed: 0 },
    })
  })

  it('wave T: the four planning classes may be stripped too (the rollback below 14; WS1 proves it on real boards)', async () => {
    const st = await h.stack()
    for (const prefix of ['card:', 'sb:', 'kanban', 'timeline'])
      expect(await strip(st, { prefix }), prefix).toEqual({
        status: 200,
        body: { boards: 0, rewritten: 0, elements: 0, keys: 0, failed: 0 },
      })
    for (const prefix of ['card', 'sb', 'card:status'])
      expect((await strip(st, { prefix })).status, prefix).toBe(400)
  })
})
