// R10: an automatic checkpoint right before the two big changes other features make to a board, so
// the board as it was just before is one restore away (features/history/before-change.ts):
//   before_reveal     a private brainstorm's notes are put on the board (workshops/private-notes.ts)
//   before_ai_themes  AI "Group into themes" returns a plan that rearranges notes (features/ai)
// Both are best effort: a sync server that cannot be read never fails the change itself.

import type { PrivateBrainstormState } from '@draftroom/contracts'
import { note as boardNote } from '@draftroom/tldraw-import/test-fixtures'
import { afterEach, describe, expect, it } from 'vitest'
import { autoCheckpointName } from '../../../src/features/history/checkpoints.ts'
import { planRetention } from '../../../src/features/history/retention.ts'
import type { Client } from '../../helpers.ts'
import { brainstormShapes, FRAME } from '../ai/fixtures.ts'
import { type AiWorld, aiWorld, run } from '../ai/support.ts'
import { expectStatus, json, note, setupWorld, type World } from '../workshops/support.ts'

interface Listed {
  id: string
  name: string
  kind: string
  reason: string | null
}
const listOf = async (c: Client, boardId: string) => {
  const res = await c.req('GET', `/api/boards/${boardId}/snapshots`)
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as { snapshots: Listed[] }).snapshots
}
const contentOf = async (c: Client, sid: string) => {
  const res = await c.req('GET', `/api/snapshots/${sid}/content`)
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as { records: { id: string }[] }).records.map((r) => r.id)
}

describe('before a private brainstorm reveal', () => {
  let w: World
  afterEach(async () => {
    await w?.api.close()
  })

  /** The sync server's place-notes endpoint: puts each draft on the (fake) board once. */
  function placement(order: string[]) {
    const ctl = { down: false }
    const snapshot = w.sync.snapshot.bind(w.sync)
    Object.assign(w.sync, {
      async snapshot(boardId: string) {
        order.push('snapshot')
        return snapshot(boardId)
      },
      async placeNotes(boardId: string, body: { notes: { id: string }[]; frame: { id: string } }) {
        order.push('place')
        if (ctl.down) throw new Error('sync down')
        for (const n of body.notes) w.sync.add(boardId, note(n.id))
        return {
          placed: body.notes.map((n) => `shape:${n.id}`),
          existing: [],
          frameId: body.frame.id,
          frameCreated: false,
        }
      },
    })
    return ctl
  }

  async function startWithNotes() {
    w.sync.add(w.boardId, note('frame1'), note('already-there'))
    const started = await w.editor.req('POST', `/api/boards/${w.boardId}/private-brainstorm`, {
      prompt: 'What slowed us down?',
      anonymous: false,
      target: { frameId: 'shape:frame1', pageId: 'page:page', x: 0, y: 0, w: 800, h: 600 },
    })
    expectStatus(started, 201)
    const sid = json<PrivateBrainstormState>(started).session?.id ?? ''
    for (const text of ['CI queue was slow', 'Scope changed after planning'])
      expectStatus(
        await w.editor.req('POST', `/api/private-brainstorms/${sid}/notes`, { text, color: 'yellow' }),
        201,
      )
    return sid
  }

  it('saves the board as it was, then places the notes; a retried "Place notes" adds no second one', async () => {
    w = await setupWorld()
    const order: string[] = []
    const ctl = placement(order)
    const sid = await startWithNotes()

    ctl.down = true // the first placement fails: the session stays revealed
    expect((await w.editor.req('POST', `/api/private-brainstorms/${sid}/reveal`)).statusCode).toBe(503)
    expect(order).toEqual(['snapshot', 'place'])
    const [before] = await listOf(w.owner, w.boardId)
    expect(before).toMatchObject({
      kind: 'auto',
      reason: 'before_reveal',
      // R2-09: named after the prompt, so two reveals can be told apart.
      name: 'Before revealing private notes: “What slowed us down?”',
    })
    const held = await contentOf(w.owner, before?.id ?? '')
    expect(held).toContain('shape:already-there')
    expect(held.filter((id) => id.startsWith('shape:pnt'))).toEqual([]) // no revealed note in it

    ctl.down = false
    expectStatus(await w.editor.req('POST', `/api/private-brainstorms/${sid}/reveal`), 200)
    expect(order).toEqual(['snapshot', 'place', 'snapshot', 'place'])
    // Nothing changed on the board between the two tries: the equal checkpoint is not saved again.
    expect((await listOf(w.owner, w.boardId)).map((c) => c.reason)).toEqual(['before_reveal'])
  })

  it('a sync server that cannot be read for the checkpoint never stops the reveal', async () => {
    w = await setupWorld()
    const order: string[] = []
    placement(order)
    const sid = await startWithNotes()
    Object.assign(w.sync, {
      async snapshot() {
        throw new Error('sync down')
      },
    })
    expectStatus(await w.editor.req('POST', `/api/private-brainstorms/${sid}/reveal`), 200)
    expect(order).toEqual(['place'])
    expect(await listOf(w.owner, w.boardId)).toEqual([])
  })
})

describe('before AI "Group into themes"', () => {
  let w: AiWorld
  afterEach(async () => {
    await w?.close()
  })

  it('a themes plan comes with a checkpoint of the board it was made from; other actions make none', async () => {
    w = await aiWorld()
    w.sync.setBoard(w.board, brainstormShapes())
    const summary = await run(w.bob, w.board, { action: 'summarize', shapeIds: [FRAME], mode: 'insert' })
    expect(summary.statusCode, summary.body).toBe(200)
    expect(await listOf(w.alice, w.board)).toEqual([])

    const themes = await run(w.bob, w.board, { action: 'themes', shapeIds: [FRAME] })
    expect(themes.statusCode, themes.body).toBe(200)
    const listed = await listOf(w.alice, w.board)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      kind: 'auto',
      reason: 'before_ai_themes',
      // R2-09: how many notes, and the frame they are in.
      name: 'Before AI grouped 6 notes in Brainstorm',
    })
    expect(await contentOf(w.alice, listed[0]?.id ?? '')).toContain(FRAME)

    // The board did not change before the next run: no second checkpoint.
    expect((await run(w.bob, w.board, { action: 'themes', shapeIds: [FRAME] })).statusCode).toBe(200)
    expect(await listOf(w.alice, w.board)).toHaveLength(1)
    // It did change (the client applied the plan): the next run saves that board first.
    w.sync.setBoard(w.board, [...brainstormShapes(), boardNote('late', 'One more idea', { parentId: FRAME })])
    expect((await run(w.bob, w.board, { action: 'themes', shapeIds: [FRAME] })).statusCode).toBe(200)
    expect((await listOf(w.alice, w.board)).map((c) => c.reason)).toEqual([
      'before_ai_themes',
      'before_ai_themes',
    ])
  })

  it('a failed AI call makes no checkpoint', async () => {
    w = await aiWorld()
    w.sync.setBoard(w.board, brainstormShapes())
    w.openai.next({ kind: 'status', status: 500 })
    const res = await run(w.bob, w.board, { action: 'themes', shapeIds: [FRAME] })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(await listOf(w.alice, w.board)).toEqual([])
  })
})

describe('retention', () => {
  it('keeps every checkpoint made before a reveal or an AI regroup while it is young (like before a restore)', () => {
    const now = new Date('2026-09-28T10:30:00.000Z')
    const at = (m: number) => new Date(now.getTime() - m * 60_000)
    const plan = planRetention(
      [
        { id: 'a', reason: 'before_reveal', createdAt: at(20) },
        { id: 'b', reason: 'before_ai_themes', createdAt: at(15) },
        { id: 'c', reason: 'before_ai_themes', createdAt: at(10) },
        { id: 'd', reason: 'hourly', createdAt: at(5) },
      ],
      now,
    )
    expect(plan.remove).toEqual([])
  })
})

describe('automatic checkpoint names (R2-09)', () => {
  it('say which prompt or which notes, on one line, within the 120 characters a name may have', () => {
    expect(autoCheckpointName('before_reveal', { prompt: 'What went well?' })).toBe(
      'Before revealing private notes: “What went well?”',
    )
    expect(autoCheckpointName('before_reveal')).toBe('Before revealing private notes')
    const long = autoCheckpointName('before_reveal', { prompt: `What ${'really '.repeat(40)}\nhappened?` })
    expect([...long].length).toBeLessThanOrEqual(120)
    expect(long).toMatch(/…”$/)
    expect(long).not.toContain('\n')
    expect(autoCheckpointName('before_ai_themes', { notes: 16, frame: '3 · What to improve' })).toBe(
      'Before AI grouped 16 notes in 3 · What to improve',
    )
    expect(autoCheckpointName('before_ai_themes', { notes: 1 })).toBe('Before AI grouped 1 note into themes')
    expect(autoCheckpointName('before_ai_themes')).toBe('Before AI grouped notes into themes')
    expect(
      [...autoCheckpointName('before_ai_themes', { notes: 999, frame: 'F'.repeat(300) })].length,
    ).toBeLessThanOrEqual(120)
    expect(autoCheckpointName('before_restore', { restoredName: 'Draft' })).toBe('Before restoring “Draft”')
  })
})
