// J4 IMPORT-V1-SYNC-BLOCK, against the REAL sync server process: POST /internal/boards/:bid/seed with a v1
// body (what importing an old `.lobby.json`, or restoring a v1 checkpoint as a new board, sends) used to run the
// converter on the server's event loop, which every open board shares: a body of 60 sticky notes of 20,000
// characters (1.2 MiB) held it for 6.6 s, and the archive caps allow thousands of notes. The conversion is
// now done in a worker thread with limits (room-internal/convert-v1.ts): past them the seed is refused (413 /
// 422 / 503), nothing is created, and meanwhile the server keeps answering. Each test here fails on the
// in-process conversion (the server is held for the whole conversion and nothing is ever refused).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { draftroomSchema } from '@draftroom/tldraw-import/schema'
import { describe, expect, it } from 'vitest'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { callInternal } from '../harness/tickets.ts'
import { docRecord, nthIndex, pageRecord, note as tlNote } from '../migrate/tl-records.ts'
import { type Answer, call } from './support.ts'

const h = useElementHarness()

const base = () => [docRecord(), pageRecord('page:page', 'Page 1', 'a1')]
const wordy = (n: number, chars: number) =>
  Array.from({ length: n }, (_, i) =>
    tlNote(
      `w${i}`,
      'page:page',
      nthIndex(i + 1),
      (i % 40) * 300,
      Math.floor(i / 40) * 300,
      'word '.repeat(chars / 5),
    ),
  )
const v1Body = (records: unknown[]) => ({
  snapshot: { schema: draftroomSchema.serialize(), documents: records.map((state) => ({ state })) },
})
const seedV1 = (st: Awaited<ReturnType<typeof h.stack>>, boardId: string, records: unknown[]) =>
  call<{ boardId?: string; records?: number; error?: { code: string } }>(
    st,
    'POST',
    `/internal/boards/${boardId}/seed`,
    v1Body(records),
  )

/**
 * Asks the server a cheap question every 25 ms while `during` runs and reports the slowest answer: a server
 * whose event loop is held cannot answer until it is free.
 */
async function slowestAnswer<T>(
  st: Awaited<ReturnType<typeof h.stack>>,
  during: () => Promise<T>,
): Promise<{ value: T; slowestMs: number; probes: number }> {
  let slowest = 0
  let probes = 0
  let running = true
  const loop = (async () => {
    while (running) {
      const t0 = performance.now()
      const res = await callInternal(st.server.url, 'GET', '/internal/canvas')
      await res.text()
      slowest = Math.max(slowest, performance.now() - t0)
      probes++
      await new Promise((r) => setTimeout(r, 25))
    }
  })()
  try {
    return { value: await during(), slowestMs: slowest, probes }
  } finally {
    running = false
    await loop
  }
}

const boardFile = (st: Awaited<ReturnType<typeof h.stack>>, b: string) =>
  join(st.server.dataDir, 'rooms', `board-${b}.sqlite`)

describe('seeding a v1 body that costs more than the server will spend', () => {
  it('a body of 60 notes of 20,000 characters: refused 422 within the budget, nothing created, the server answering throughout', async () => {
    const st = await h.stack({ env: { DRAFTROOM_V1_SEED_TIMEOUT_MS: '1500' } })
    const b = newBoardId()
    const run = await slowestAnswer(st, async () => {
      const t0 = performance.now()
      const res = await seedV1(st, b, [...base(), ...wordy(60, 20_000)])
      return { res, ms: performance.now() - t0 }
    })
    expect(run.value.res.status, JSON.stringify(run.value.res.body)).toBe(422)
    expect(run.value.res.body.error?.code).toBe('IMPORT_TOO_COMPLEX')
    expect(run.value.ms).toBeLessThan(4_000) // 6.6 s of conversion, cut at the budget (and not held on the loop)
    expect(run.probes).toBeGreaterThan(10)
    expect(run.slowestMs).toBeLessThan(700) // in-process, every probe waited for the whole conversion
    expect(existsSync(boardFile(st, b))).toBe(false)
    // the id is still seedable, and a small v1 body converts
    const ok = await seedV1(st, b, [...base(), ...wordy(2, 100)])
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })

  it('a heavy body inside the budget (8 notes of 20,000 characters, about 1 s) converts, and the server keeps answering', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const run = await slowestAnswer(st, () => seedV1(st, b, [...base(), ...wordy(8, 20_000)]))
    expect(run.value.status, JSON.stringify(run.value.body)).toBe(201)
    expect(run.value.body.records).toBeGreaterThanOrEqual(16)
    expect(run.slowestMs).toBeLessThan(700)
    const snap = await st.snapshot(b)
    expect(snap.elements.filter((e) => e.type === 'stickynote')).toHaveLength(8)
    const c = await st.client({ boardId: b, user: 'reader' })
    expect((c.welcome?.doc as { import?: { from: string } } | undefined)?.import?.from).toBe('tldraw-5.4.2')
  })

  it('past the record limit or the byte limit: 413 IMPORT_TOO_LARGE, nothing created', async () => {
    const st = await h.stack({
      env: { DRAFTROOM_V1_SEED_MAX_RECORDS: '5', DRAFTROOM_V1_SEED_MAX_BYTES: '4000' },
    })
    const many = newBoardId()
    const res = await seedV1(st, many, [...base(), ...wordy(4, 10)]) // 6 records
    expect(res.status, JSON.stringify(res.body)).toBe(413)
    expect(res.body.error?.code).toBe('IMPORT_TOO_LARGE')
    expect(existsSync(boardFile(st, many))).toBe(false)
    const heavy = newBoardId()
    const big = await seedV1(st, heavy, [...base(), ...wordy(1, 6_000)]) // 3 records, but 6 kB of text
    expect(big.status, JSON.stringify(big.body)).toBe(413)
    expect(existsSync(boardFile(st, heavy))).toBe(false)
    // inside both it converts
    const ok = await seedV1(st, newBoardId(), [...base(), ...wordy(1, 100)])
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })

  it('a heap cap the conversion does not fit in: 422 IMPORT_TOO_COMPLEX', async () => {
    const st = await h.stack({ env: { DRAFTROOM_V1_SEED_HEAP_MB: '4' } })
    const b = newBoardId()
    const res = await seedV1(st, b, [...base(), ...wordy(2, 100)])
    expect(res.status, JSON.stringify(res.body)).toBe(422)
    expect(res.body.error?.code).toBe('IMPORT_TOO_COMPLEX')
    expect(existsSync(boardFile(st, b))).toBe(false)
  })

  it('one conversion at a time: a second seed while one runs (no queue) is 503 BUSY at once', async () => {
    const st = await h.stack({
      env: { DRAFTROOM_V1_SEED_TIMEOUT_MS: '1500', DRAFTROOM_V1_SEED_MAX_QUEUE: '0' },
    })
    const slow = seedV1(st, newBoardId(), [...base(), ...wordy(60, 20_000)])
    await new Promise((r) => setTimeout(r, 600)) // its worker is running
    const t0 = performance.now()
    const refused: Answer<{ error?: { code: string } }> = await seedV1(st, newBoardId(), [
      ...base(),
      ...wordy(1, 100),
    ])
    expect(refused.status, JSON.stringify(refused.body)).toBe(503)
    expect(refused.body.error?.code).toBe('BUSY')
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect((await slow).status).toBe(422)
    // the place is free again
    expect((await seedV1(st, newBoardId(), [...base(), ...wordy(1, 100)])).status).toBe(201)
  })

  it('what could not be read is still 400 with its reason, and a body of elements is not touched by any of this', async () => {
    const st = await h.stack({ env: { DRAFTROOM_V1_SEED_MAX_RECORDS: '5' } })
    const bad = await call(st, 'POST', `/internal/boards/${newBoardId()}/seed`, {
      snapshot: {
        schema: { schemaVersion: 99, sequences: {} },
        documents: [{ state: { id: 'x', typeName: 'shape' } }],
      },
    })
    expect(bad.status).toBe(400)
    // a lobby-elements seed has no record limit of the v1 conversion
    const { rect } = await import('../element-room/support/elements.ts')
    const els = Array.from({ length: 12 }, (_, i) => rect(`R${i}`, { x: i * 300 }))
    const ok = await call(st, 'POST', `/internal/boards/${newBoardId()}/seed`, {
      format: 'lobby-elements',
      elements: els,
      doc: {},
    })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })
})
