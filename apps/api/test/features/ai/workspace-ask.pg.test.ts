// Wave M (M8-2, owner W8): Ask across boards on a real Postgres, with its real full-text search (the english
// stemmer and stop words, ts_rank_cd over an OR query, the per-board ranking window), the same checks as the PGlite
// suite's core: what reaches the prompt is only what the asker may open, ranked, and cited back to the right board.
// Opt-in like apps/api/test/concurrency.pg.test.ts: set DRAFTROOM_TEST_DATABASE_URL (a database these tests may
// create and drop schemas in) to run it; skipped otherwise.

import { describe, expect, it } from 'vitest'
import { itemsOf } from './fake-openai.ts'
import { ask, askWorld, boardsOf, boardWith, grantOn, indexAll, promptOf } from './workspace-ask-support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''

describe.skipIf(!PG_URL)('Ask across boards on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('stems and ranks on the real FTS, within the asker’s scope only, and cites back to the right board', async () => {
    const w = await askWorld()
    try {
      const a = await boardWith(w, 'Pricing A', ['We decided the annual pricing', 'Lunch order'], {
        prefix: 'a',
      })
      const b = await boardWith(w, 'Pricing B', ['Pricing decisions are pending'], {
        prefix: 'b',
        visibility: 'workspace_view',
      })
      const hidden = await boardWith(w, 'Hidden C', ['Decision on pricing: secret'], { prefix: 'c' })
      await grantOn(w, a.id, w.carol, 'viewer')
      await indexAll(w)
      w.openai.next({
        kind: 'content',
        content: {
          answer: 'Annual [1], pending [2].',
          found: 'yes',
          citations: [{ ids: ['b1.n1'] }, { ids: ['b2.n1'] }],
        },
      })
      // 'decide' and 'pricing' (english: decided → decid, decisions → decis; simple: prefixes)
      const r = await ask(w.carol, 'What did we decide about pricing?')
      const prompt = promptOf(w)
      expect(prompt).not.toContain('secret')
      expect(prompt).not.toContain('Hidden C')
      expect(prompt).not.toContain('Lunch')
      expect(
        boardsOf(prompt)
          .map((x) => x.title)
          .sort(),
      ).toEqual(['Pricing A', 'Pricing B'])
      expect(itemsOf(w.openai.requests[0] as never)).toHaveLength(2)
      expect(r.citations.map((c) => c.boardId).sort()).toEqual([a.id, b.id].sort())
      expect(JSON.stringify(r)).not.toContain(hidden.id)
    } finally {
      await w.close()
    }
  })
})
