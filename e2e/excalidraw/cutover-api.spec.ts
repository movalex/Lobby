// The api side of the cut-over on the whole Excalidraw stack (real api, real sync on
// DRAFTROOM_ENGINE=excalidraw, the Excalidraw board page; docs/EXCALIDRAW-MIGRATION.md §5.5, §5.9 step 4,
// migration 0022; the runbook's gaps G5 and G6, owner W4-API):
//   - a board born on this build opens and saves (its ticket is issued: R0's refusal of `new_canvas`
//     boards is off while the api's sync runs the new canvas) and carries no R0 `newCanvas` mark;
//   - the restore-point run, POST /internal/checkpoints/engine-migration (step C12), answers 202 on this
//     stack, reports that board as born on the new canvas (nothing of it was converted, so no
//     `engine_migration` checkpoint), saves nothing on a repeat, and needs the internal secret.
// A converted board cannot be made on this stack (the api marks every board it creates as born here);
// the restore point of one is apps/api/test/features/history/engine-migration.test.ts.
import { createNote, expect, expectSaved, test } from '../tests/support/canvas.ts'
import { API_URL } from '../tests/support/ports.ts'

const ROUTE = '/internal/checkpoints/engine-migration'

interface RunView {
  runId: string
  status: 'queued' | 'running' | 'done' | 'failed'
  report?: {
    ok: boolean
    name: string
    saved: number
    unchanged: number
    skipped: number
    failed: number
    boards: Array<{ boardId: string; outcome: string; why?: string; snapshotId: string | null }>
  }
  error?: string
}

const internal = (secret: string | null, method: 'GET' | 'POST', path: string) =>
  fetch(`${API_URL}${path}`, {
    method,
    headers: secret === null ? {} : { 'x-draftroom-internal': secret },
  })

async function runRestorePoints(secret: string): Promise<NonNullable<RunView['report']>> {
  const started = await internal(secret, 'POST', ROUTE)
  expect(started.status).toBe(202)
  const { runId } = (await started.json()) as RunView
  expect(runId).toMatch(/^run_[0-9a-f]{16}$/)
  for (let i = 0; i < 300; i++) {
    const res = await internal(secret, 'GET', `${ROUTE}/${runId}`)
    expect(res.status).toBe(200)
    const view = (await res.json()) as RunView
    if (view.status === 'failed') throw new Error(`the run failed: ${view.error}`)
    if (view.status === 'done' && view.report) return view.report
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the restore-point run did not finish')
}

test('a board born on the new canvas opens, and the restore-point run reports it as born here', async ({
  canvasSession,
  board,
  users,
  stack,
}) => {
  // the ticket is issued and the board opens: R0's refusal of new_canvas boards is off on this build
  const alice = await canvasSession('alice')
  await createNote(alice.page, { x: 100, y: 120, text: 'born here' })
  await expectSaved(alice.page)

  // no R0 mark on the board (it is this build's own)
  const api = await users.api('alice')
  const one = await api.fetch('GET', `/api/boards/${board}`)
  expect(one.status()).toBe(200)
  expect(JSON.stringify(await one.json())).not.toContain('newCanvas')

  // step C12 on this stack: every board was born here, so nothing is saved and nothing fails
  const report = await runRestorePoints(stack.internalSecret)
  expect(report).toMatchObject({ ok: true, name: 'Moved to the new canvas', saved: 0, failed: 0 })
  const mine = report.boards.find((b) => b.boardId === board)
  expect(mine).toMatchObject({ outcome: 'skipped', why: 'new-canvas', snapshotId: null })
  const again = await runRestorePoints(stack.internalSecret)
  expect(again).toMatchObject({ ok: true, saved: 0, failed: 0 })
  // the board's History has no engine_migration row
  const list = await api.fetch('GET', `/api/boards/${board}/snapshots`)
  expect(list.status()).toBe(200)
  const { snapshots } = (await list.json()) as { snapshots: Array<{ reason: string | null }> }
  expect(snapshots.filter((s) => s.reason === 'engine_migration')).toEqual([])

  // the internal secret, and nothing else, opens the route
  expect((await internal(null, 'POST', ROUTE)).status).toBe(401)
  expect((await internal('wrong-secret-0123456789abcdefghijklmn', 'GET', ROUTE)).status).toBe(401)
})
