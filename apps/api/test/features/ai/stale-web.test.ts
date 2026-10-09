// Wave L (W1): a web tab still on the wave K build (opened before the web deploy) against this api. It sends
// only the four old actions and parses the answers with its own copy of the contracts: the wave K AiResult,
// copied below as it was at main 86c64303 (packages/contracts/src/ai.ts). Its objects are not strict, so the
// new runId (and, for 'actions' without a vote, nothing else) is stripped and every answer still parses.

import { AiBudget, AiShapeId } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { brainstormShapes, FRAME, NOTES } from './fixtures.ts'
import { type AiWorld, aiWorld, run } from './support.ts'

// ---- wave K's AiResult (86c64303), verbatim but for the imports ----
const Common = {
  truncated: z.boolean(),
  budget: AiBudget.nullable(),
}
const AiTheme = z.object({ name: z.string(), noteIds: z.array(AiShapeId) })
const AiActionItem = z.object({ text: z.string(), owner: z.string().nullable() })
const WaveKAiResult = z.discriminatedUnion('action', [
  z.object({ action: z.literal('summarize'), summary: z.string(), sources: z.number().int(), ...Common }),
  z.object({ action: z.literal('themes'), themes: z.array(AiTheme), ...Common }),
  z.object({ action: z.literal('actions'), items: z.array(AiActionItem), ...Common }),
  z.object({ action: z.literal('ideas'), ideas: z.array(z.string()), ...Common }),
])

let w: AiWorld
beforeEach(async () => {
  w = await aiWorld()
  w.sync.setBoard(w.board, brainstormShapes())
})
afterEach(() => w.close())

describe('a wave K web tab against the wave L api', () => {
  it('parses every answer to the four actions it sends; the run id is stripped', async () => {
    for (const body of [
      { action: 'summarize', shapeIds: [FRAME], mode: 'panel' },
      { action: 'themes', shapeIds: NOTES },
      { action: 'actions', shapeIds: [FRAME] },
      { action: 'ideas', shapeIds: [], prompt: 'trailer hooks', count: 3 },
    ]) {
      const res = await run(w.alice, w.board, body)
      expect(res.statusCode, res.body).toBe(200)
      const raw = res.json() as Record<string, unknown>
      expect(raw.runId).toMatch(/^air_/)
      const parsed = WaveKAiResult.safeParse(raw)
      expect(parsed.success, `${body.action}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
      expect(parsed.data).not.toHaveProperty('runId')
    }
  })
})
