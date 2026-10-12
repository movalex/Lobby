// Wave N (WS7, N7-4) on a real Postgres: a board's links are replaced in one transaction, so a concurrent read
// ("Linked from", or the table itself) sees the old set or the new one, never none and never both, and two writers
// of the same board's links (two api processes overlap during a deploy: two indexers on one database) take turns
// and leave exactly one set. PGlite has one connection and cannot show any of this: set
// DRAFTROOM_TEST_DATABASE_URL (a database these tests may create and drop schemas in) to run it; skipped
// otherwise. DRAFTROOM_PG_STRESS_ITER sets the rounds (default 10).

import { BacklinksAnswer } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { SearchIndexer, searchSettings } from '../../../src/features/search/indexer.ts'
import { fakeSync } from '../search/support.ts'
import { type LinksWorld, linksWorld } from './support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 10)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let w: LinksWorld | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

describe.skipIf(!PG_URL)('board links on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('a concurrent reindex and read stay consistent: one set or the other, never none, never both', async () => {
    w = await linksWorld()
    expect(w.api.db.kind).toBe('pg')
    const { b } = w
    const one = [
      { el: 'one-a', to: b.D },
      { el: 'one-b', to: b.D },
      { el: 'one-c', to: b.D },
    ]
    const two = [
      { el: 'two-a', to: b.D },
      { el: 'two-b', to: b.D, toEl: 'frame-1' },
    ]
    // a second api process: its own indexer on the same database, its sync answering the other set
    const otherSync = fakeSync()
    otherSync.linksSupported = true
    const other = new SearchIndexer({
      db: w.api.db,
      sync: otherSync,
      now: () => w?.api.clock.now() ?? new Date(),
      log: { warn: () => {} },
      settings: searchSettings,
    })
    const sets = new Set([JSON.stringify(one.map((l) => l.el)), JSON.stringify(two.map((l) => l.el))])
    const bad: string[] = []
    const elementsOf = async () => {
      const r = await w?.api.db.query<{ from_element: string }>(
        'SELECT from_element FROM board_links WHERE from_board = $1 ORDER BY from_element',
        [b.A],
      )
      return JSON.stringify(r?.rows.map((x) => x.from_element) ?? [])
    }
    w.sync.setLinks(b.A, one)
    await w.indexer.refreshCanvas(b.A)
    for (let i = 0; i < ITER; i++) {
      w.sync.setLinks(b.A, i % 2 ? one : two)
      otherSync.setLinks(b.A, i % 2 ? two : one)
      let writing = true
      const reads = (async () => {
        while (writing) {
          const rows = await elementsOf()
          if (!sets.has(rows)) bad.push(`table: ${rows}`)
          const res = await w?.carol.req('GET', `/api/boards/${b.D}/backlinks`)
          const links = BacklinksAnswer.parse(res?.json()).backlinks
          if (links.length !== 1 || !['one-a', 'two-a'].includes(links[0]?.elementId ?? ''))
            bad.push(`backlinks: ${JSON.stringify(links)}`)
          await sleep(Math.random() * 3)
        }
      })()
      await Promise.all([
        sleep(Math.random() * 5).then(() => w?.indexer.refreshCanvas(b.A)),
        sleep(Math.random() * 5).then(() => other.refreshCanvas(b.A)),
      ])
      writing = false
      await reads
      // the two writers took turns: exactly one of the sets is left, never their union
      const final = await elementsOf()
      if (!sets.has(final)) bad.push(`final: ${final}`)
    }
    await other.idle()
    expect(bad).toEqual([])
  })
})
