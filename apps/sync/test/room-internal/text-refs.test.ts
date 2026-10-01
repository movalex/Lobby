// GET /internal/boards/:bid/text and GET …/asset-refs on the Excalidraw engine (wave 2F,
// room-internal/text.ts, asset-refs.ts), against the REAL sync server process: the same answer shapes as
// the tldraw routes, read from the board file beside the open room.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardStore } from '../../src/room/store.ts'
import { textClock } from '../../src/room-internal/text.ts'
import { assetId, image, rect, versionId } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { call, sampleBoard, seed } from './support.ts'

const h = useElementHarness()

type TextAnswer = {
  boardId: string
  clock: number
  unchanged: boolean
  entries?: { id: string; type: string; pageId: string; text: string }[]
  truncated?: boolean
  bytes?: number
}

const file = (n: number, kind: 'image' | 'pdf' | 'video' | 'other', name: string) => ({
  assetId: assetId(n),
  versionId: versionId(n),
  kind,
  name,
  mimeType: kind === 'pdf' ? 'application/pdf' : 'image/png',
  sizeBytes: 10,
})

function boardWithFiles() {
  return [
    ...sampleBoard(),
    image('I1', versionId(1), {
      x: 2000,
      customData: { lobby: { file: file(1, 'image', 'photo.png'), alt: 'a cat' } },
    }),
    image('C1', versionId(2), { x: 2400, customData: { lobby: { file: file(2, 'pdf', 'brief.pdf') } } }),
    image('P1', `${versionId(2)}.p3`, {
      x: 2800,
      customData: { lobby: { file: file(2, 'pdf', 'brief.pdf'), pdfPage: 3 } },
    }),
    image('B1', versionId(3), { x: 3200 }),
  ]
}

describe('text (Excalidraw engine)', () => {
  it('answers the tldraw route’s shape: objects in the api vocabulary, labels as their containers’ text', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, boardWithFiles())).status).toBe(201)
    const res = await call<TextAnswer>(st, 'GET', `/internal/boards/${b}/text`)
    expect(res.status).toBe(200)
    const entries = res.body.entries ?? []
    expect(entries[0]).toEqual({ id: 'shape:F', type: 'frame', pageId: 'page:page', text: 'Ideas' })
    const by = new Map(entries.map((e) => [e.id, e]))
    expect(by.get('shape:N1')).toMatchObject({ type: 'note', text: 'first idea' })
    expect(by.get('shape:R')).toMatchObject({ type: 'geo', text: 'box' })
    expect(by.get('shape:T')).toMatchObject({ type: 'text', text: 'free words' })
    expect(by.get('shape:I1')).toMatchObject({ type: 'image', text: 'a cat · photo.png' })
    expect(by.get('shape:C1')).toMatchObject({ type: 'dr-file-card', text: 'brief.pdf' })
    expect(by.get('shape:P1')).toMatchObject({ type: 'image', text: 'brief.pdf' })
    expect(by.has('shape:N1.t')).toBe(false) // a label is its container's text, never an entry
    expect(by.has('shape:B1')).toBe(false) // no alt, no facts: no text
    expect(res.body).toMatchObject({ boardId: b, unchanged: false, truncated: false })
    expect(res.body.bytes).toBe(entries.reduce((n, e) => n + Buffer.byteLength(e.text), 0))
  })

  it('says unchanged at the clock the api indexed, and not after an edit', async () => {
    const st = await h.stack()
    const b = newBoardId()
    await seed(st, b, sampleBoard())
    const first = await call<TextAnswer>(st, 'GET', `/internal/boards/${b}/text`)
    const same = await call<TextAnswer>(st, 'GET', `/internal/boards/${b}/text?since=${first.body.clock}`)
    expect(same.body).toEqual({ boardId: b, clock: first.body.clock, unchanged: true })
    const c = await st.client({ boardId: b, user: 'editor' })
    await c.create([rect('New')])
    const after = await call<TextAnswer>(st, 'GET', `/internal/boards/${b}/text?since=${first.body.clock}`)
    expect(after.body.unchanged).toBe(false)
    expect(after.body.clock).toBeGreaterThan(first.body.clock)
  })

  it('stops at maxBytes (truncated), keeps frames first, and answers an unknown board as empty', async () => {
    const st = await h.stack()
    const b = newBoardId()
    await seed(st, b, sampleBoard())
    const cut = await call<TextAnswer>(st, 'GET', `/internal/boards/${b}/text?maxBytes=6`)
    expect(cut.body.entries?.map((e) => e.id)).toEqual(['shape:F'])
    expect(cut.body.truncated).toBe(true)
    const none = await call<TextAnswer>(st, 'GET', `/internal/boards/${newBoardId()}/text`)
    expect(none.body).toMatchObject({ clock: 0, unchanged: false, entries: [] })
    expect((await call(st, 'GET', `/internal/boards/${b}/text?since=x`)).status).toBe(400)
  })
})

describe('the text clock of a converted board', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('adds the tldraw clock it was converted from, so it never goes back to a tldraw-era value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-2f-clock-'))
    dirs.push(dir)
    const path = join(dir, 'board-b-clock.sqlite')
    const store = new BoardStore(path)
    store.setClock(3)
    store.close()
    const db = new DatabaseSync(path)
    expect(textClock(db)).toBe(3)
    db.prepare("INSERT INTO lb_meta (key, value) VALUES ('converted_from', ?)").run(
      JSON.stringify({ documentClock: 57, lbClock: 1, cycle: 0 }),
    )
    expect(textClock(db)).toBe(60)
    db.close()
  })
})

type Refs = {
  boardId: string
  exists: boolean
  canvas: { assetId: string; versionId: string }[]
  deleted: { assetId: string; versionId: string }[]
  unusedAssetRecords: unknown[]
  versionsOnly: { canvas: string[]; deleted: string[] }
}

describe('asset-refs (Excalidraw engine)', () => {
  it('lists the versions on the canvas, what deleted content would bring back, and bare fileIds apart', async () => {
    const st = await h.stack()
    const b = newBoardId()
    await seed(st, b, boardWithFiles())
    const before = await call<Refs>(st, 'GET', `/internal/boards/${b}/asset-refs`)
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ boardId: b, exists: true, deleted: [], unusedAssetRecords: [] })
    expect(before.body.canvas).toEqual([
      { assetId: assetId(1), versionId: versionId(1) },
      { assetId: assetId(2), versionId: versionId(2) },
    ])
    expect(before.body.versionsOnly).toEqual({ canvas: [versionId(3)], deleted: [] })

    // delete the photo: its version moves to `deleted` (the capture and the tombstone can bring it back)
    const c = await st.client({ boardId: b, user: 'editor' })
    const v = c.confirmed.get('I1')?.version ?? 1
    await c.push([{ k: 'p', id: 'I1', pv: v, g: { life: { isDeleted: true } } }])
    const after = await call<Refs>(st, 'GET', `/internal/boards/${b}/asset-refs`)
    expect(after.body.canvas).toEqual([{ assetId: assetId(2), versionId: versionId(2) }])
    expect(after.body.deleted).toEqual([{ assetId: assetId(1), versionId: versionId(1) }])
  })

  it('answers a board with no file as referencing nothing', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const res = await call<Refs>(st, 'GET', `/internal/boards/${b}/asset-refs`)
    expect(res.body).toEqual({
      boardId: b,
      exists: false,
      canvas: [],
      deleted: [],
      unusedAssetRecords: [],
      versionsOnly: { canvas: [], deleted: [] },
    })
  })
})
