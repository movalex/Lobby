// AIPV-04: duplicating a board, or restoring one of its checkpoints as a new board, copies the board's
// own AI choice (settings.ts), so a copy of a board with AI off (an NDA client's board) never falls
// back to the workspace default, which is usually on. A board without its own choice gives a copy
// without one (it keeps following the workspace default). Imports start with no choice.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { assertValid, baseRecords, createFakeSync, type FakeSync, noteRec } from './helpers.ts'

let api: TestApi
let sync: FakeSync
let bob: Client // member; owns the board he creates
let boardId: string

beforeEach(async () => {
  sync = createFakeSync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  await api.login('owner')
  bob = await api.login('bob')
  boardId = await createBoard(bob, DEV_STUDIO, 'NDA client')
  const records = [...baseRecords(), noteRec('n1', 'secret idea')]
  assertValid(records)
  sync.setBoard(boardId, records)
})
afterEach(() => api.close())

const setBoardAi = async (enabled: boolean | null, bid = boardId) => {
  const res = await bob.req('PUT', `/api/boards/${bid}/ai/settings`, { enabled })
  expect(res.statusCode, res.body).toBe(200)
}
const boardAi = async (bid: string) =>
  (
    await api.db.maybeOne<{ enabled: boolean }>('SELECT enabled FROM board_ai_settings WHERE board_id = $1', [
      bid,
    ])
  )?.enabled ?? null
const duplicate = async () => {
  const res = await bob.req('POST', `/api/boards/${boardId}/duplicate`, {})
  expect(res.statusCode, res.body).toBe(201)
  return res.json().board.id as string
}
const restoreAsNew = async () => {
  const saved = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'Before the review' })
  expect(saved.statusCode, saved.body).toBe(201)
  const res = await bob.req('POST', `/api/snapshots/${saved.json().id}/restore-as-new`, {})
  expect(res.statusCode, res.body).toBe(201)
  return res.json().board.id as string
}

describe('copies keep the board’s AI choice (AIPV-04)', () => {
  it('duplicating a board with AI off gives a copy with AI off', async () => {
    await setBoardAi(false)
    const copy = await duplicate()
    expect(await boardAi(copy)).toBe(false)
  })

  it('restoring a checkpoint as a new board keeps AI off too', async () => {
    await setBoardAi(false)
    expect(await boardAi(await restoreAsNew())).toBe(false)
  })

  it('an explicit "on" is copied, and a board that follows the workspace gives a copy that follows it', async () => {
    await setBoardAi(true)
    expect(await boardAi(await duplicate())).toBe(true)
    await setBoardAi(null)
    expect(await boardAi(await duplicate())).toBeNull()
    expect(await boardAi(await restoreAsNew())).toBeNull()
  })

  it('the source board’s own setting is unchanged', async () => {
    await setBoardAi(false)
    await duplicate()
    expect(await boardAi(boardId)).toBe(false)
  })
})
