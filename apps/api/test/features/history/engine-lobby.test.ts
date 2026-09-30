// History on a board of the Excalidraw engine (wave 2F; docs/EXCALIDRAW-MIGRATION.md §1 A4/A5, §3.7, §5.5):
// the sync snapshot is the `lobby-elements` envelope, so checkpoints are v2 bodies (read back as elements
// by the preview), restore/duplicate/import seed elements (a v1 checkpoint still seeds tldraw records, which
// the Excalidraw sync converts), and export writes the v2 archive. Files follow the elements' `fileId`s.

import type { CheckpointContent, LobbyElementsSnapshot } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkpointServices } from '../../../src/features/history/index.ts'
import {
  type LobbySeed,
  type RoomSnapshotJson,
  type SyncInternalClient,
  SyncSeedConflict,
} from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { baseRecords, fileStatus, noteRec, SCHEMA, upload } from './helpers.ts'

// biome-ignore lint/suspicious/noExplicitAny: elements are JSON, read field by field
type El = Record<string, any> & { id: string; type: string }
type Seed = { boardId: string; body: RoomSnapshotJson | LobbySeed }

/** A sync on the Excalidraw engine: lobby-elements snapshots, seeds of either format. */
class LobbySync implements SyncInternalClient {
  boards = new Map<string, LobbyElementsSnapshot | RoomSnapshotJson>()
  seeds: Seed[] = []
  setBoard(boardId: string, elements: El[], doc: Record<string, unknown> = {}, clock = 7) {
    this.boards.set(boardId, { format: 'lobby-elements', schema: 1, clock, elements, doc })
  }
  async snapshot(boardId: string) {
    return structuredClone(
      this.boards.get(boardId) ?? {
        format: 'lobby-elements' as const,
        schema: 1,
        clock: 0,
        elements: [],
        doc: {},
      },
    )
  }
  async seed(boardId: string, body: Seed['body']) {
    this.seeds.push({ boardId, body: structuredClone(body) })
    if (this.boards.has(boardId)) throw new SyncSeedConflict()
    if ((body as { format?: string }).format === 'lobby-elements') {
      const lobby = body as LobbySeed
      this.setBoard(boardId, lobby.elements as El[], lobby.doc, 1)
      return { records: lobby.elements.length }
    }
    this.boards.set(boardId, body as RoomSnapshotJson)
    return { records: (body as RoomSnapshotJson).documents.length }
  }
}

const base = (id: string, type: string, o: Record<string, unknown> = {}): El => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roundness: null,
  roughness: 0,
  opacity: 100,
  seed: 1,
  version: 3,
  versionNonce: 9,
  index: 'a1',
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  updated: 1,
  created: 1,
  link: null,
  locked: false,
  ...o,
})
const server = (uid: string) => ({
  createdBy: { uid, name: `${uid}-name`, guest: false },
  createdAt: 1,
  lastEditedBy: { uid, name: `${uid}-name`, guest: false },
  lastEditedAt: 1,
})
const textEl = (id: string, words: string, o: Record<string, unknown> = {}) =>
  base(id, 'text', {
    fontSize: 20,
    fontFamily: 6,
    baseFontSize: null,
    text: words,
    originalText: words,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
    ...o,
  })

/** A frame holding a voted, revealed note with its label, an arrow bound to the note, and an image. */
function lobbyBoard(fileId: string): El[] {
  return [
    base('F', 'frame', { name: 'Ideas', width: 800, height: 600, index: 'a0' }),
    base('N', 'stickynote', {
      baseHeight: 200,
      created: null,
      frameId: 'F',
      index: 'a1',
      boundElements: [
        { id: 'N.t', type: 'text' },
        { id: 'A', type: 'arrow' },
      ],
      groupIds: ['g1'],
      customData: {
        lobby: {
          'plusOne:usr_voter': true,
          mindmap: { rootId: 'N', parentId: null, side: 'right', collapsed: false },
        },
        lobbyServer: { ...server('usr_ann'), privateNote: { session: 'pbs_s', author: 'usr_ann' } },
      },
    }),
    textEl('N.t', 'our big idea', {
      containerId: 'N',
      frameId: 'F',
      index: 'a2',
      groupIds: ['g1'],
      customData: { lobbyServer: server('usr_ann') },
    }),
    base('A', 'arrow', {
      index: 'a3',
      points: [
        [0, 0],
        [100, 0],
      ],
      startBinding: { elementId: 'N', fixedPoint: [1, 0.5], mode: 'orbit' },
      endBinding: { elementId: 'gone', fixedPoint: [0, 0.5], mode: 'orbit' },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
    }),
    base('I', 'image', { index: 'a4', fileId, scale: [1, 1], crop: null, status: 'saved' }),
  ]
}

let api: TestApi
let sync: LobbySync
let bob: Client
let boardId: string
let photo: { assetId: string; versionId: string }

beforeEach(async () => {
  sync = new LobbySync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  await api.login('owner')
  bob = await api.login('bob')
  boardId = await createBoard(bob, DEV_STUDIO, 'Retro')
  photo = await upload(api, bob, boardId, 'photo.png')
  sync.setBoard(boardId, lobbyBoard(photo.versionId), {
    startView: { x: 0, y: 0, w: 800, h: 600, frameId: 'F' },
    import: { from: 'tldraw-5.4.2' },
  })
})
afterEach(() => api.close())

const lastSeed = () => sync.seeds.at(-1) as Seed
const lobbySeed = () =>
  lastSeed().body as unknown as { format: string; elements: El[]; doc: Record<string, unknown> }

describe('checkpoints of a board on the Excalidraw engine (v2 bodies)', () => {
  it('saves a v2 body and previews it as elements and the board document', async () => {
    const res = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'Before the vote' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ documentClock: 7, recordCount: 5 })
    const preview = await bob.req('GET', `/api/snapshots/${res.json().id}/content`)
    expect(preview.statusCode).toBe(200)
    const body = preview.json() as CheckpointContent
    expect(body).toMatchObject({ format: 'lobby-elements', records: [], schema: 1 })
    expect(body.elements?.map((e) => e.id)).toEqual(['F', 'N', 'N.t', 'A', 'I'])
    expect(body.doc).toMatchObject({ startView: { frameId: 'F' } })
  })

  it('does not save an automatic checkpoint of unchanged content twice, and does after a change', async () => {
    const service = checkpointServices.get(api.app)
    expect((await service?.capture(boardId, 'hourly'))?.status).toBe('saved')
    expect((await service?.capture(boardId, 'hourly'))?.status).toBe('unchanged')
    sync.setBoard(boardId, lobbyBoard(photo.versionId), { 'tagDef:x': { name: 'X', color: 'red' } })
    expect((await service?.capture(boardId, 'hourly'))?.status).toBe('saved')
  })

  it('restores a v2 checkpoint as a new board of elements, with the files its images show', async () => {
    const saved = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'v2' })
    const res = await bob.req('POST', `/api/snapshots/${saved.json().id}/restore-as-new`, {})
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ linkedFiles: 1, droppedFiles: 0 })
    const seed = lobbySeed()
    expect(seed.format).toBe('lobby-elements')
    expect(seed.elements.map((e) => e.id)).toEqual(['F', 'N', 'N.t', 'A', 'I'])
    // the image's version was named by fileId only: its asset is found, and the copy may show it
    expect(await fileStatus(bob, photo, res.json().board.id)).toBe(200)
  })

  it('restores a v1 checkpoint as tldraw records (the Excalidraw sync converts them at the seed)', async () => {
    // a checkpoint taken while the board was on tldraw
    sync.boards.set(boardId, {
      documentClock: 5,
      schema: SCHEMA,
      documents: [...baseRecords(), noteRec('n1', 'old text')].map((state) => ({
        state,
        lastChangedClock: 5,
      })),
    })
    const saved = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'v1' })
    sync.setBoard(boardId, lobbyBoard(photo.versionId)) // converted since
    const res = await bob.req('POST', `/api/snapshots/${saved.json().id}/restore-as-new`, {})
    expect(res.statusCode).toBe(201)
    const body = lastSeed().body as RoomSnapshotJson
    expect(body.documents.map((d) => d.state.id)).toContain('shape:n1')
    expect(body.schema).toEqual(SCHEMA)
    const preview = await bob.req('GET', `/api/snapshots/${saved.json().id}/content`)
    expect(preview.json()).not.toHaveProperty('format')
    expect((preview.json() as CheckpointContent).records.map((r) => r.id)).toContain('shape:n1')
  })
})

describe('duplicate, export and import on the Excalidraw engine', () => {
  it('duplicates a board of elements into a new board of elements', async () => {
    const res = await bob.req('POST', `/api/boards/${boardId}/duplicate`, {})
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ linkedFiles: 1 })
    expect(lobbySeed().elements.map((e) => e.id)).toEqual(['F', 'N', 'N.t', 'A', 'I'])
    expect(lobbySeed().doc).toMatchObject({ startView: { frameId: 'F' } })
  })

  it('exports the v2 archive without who wrote or voted what', async () => {
    const res = await bob.req('GET', `/api/boards/${boardId}/export`)
    expect(res.statusCode).toBe(200)
    const archive = res.json()
    expect(archive).toMatchObject({ format: 'lobby-board', version: 2, engine: 'excalidraw', schema: 1 })
    expect(archive.assets).toEqual([
      expect.objectContaining({ assetId: photo.assetId, versionId: photo.versionId }),
    ])
    expect(archive.doc).not.toHaveProperty('import')
    const note = archive.elements.find((e: El) => e.id === 'N')
    expect(note.customData.lobby).not.toHaveProperty('plusOne:usr_voter')
    expect(note.customData.lobbyServer.privateNote).toEqual({ session: 'pbs_s' })
    expect(note.customData.lobbyServer.lastEditedBy).toBeNull()
    expect(JSON.stringify(archive)).not.toContain('usr_voter')
  })

  it('imports a v2 archive with fresh ids, links remapped, and nothing identity-bearing taken on trust', async () => {
    const archive = (await bob.req('GET', `/api/boards/${boardId}/export`)).json()
    // a hand-made file tries to claim authorship, an AI stamp and a private frame
    const N = archive.elements.find((e: El) => e.id === 'N')
    N.customData.lobby.ai = { by: 'usr_someone' }
    N.customData.lobbyServer.createdBy = { uid: 'usr_ceo', name: 'CEO', guest: false }
    const res = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import?title=Copy`, archive)
    expect(res.statusCode).toBe(201)
    const seed = lobbySeed()
    expect(seed.format).toBe('lobby-elements')
    const byType = (t: string) => seed.elements.filter((e) => e.type === t) as El[]
    const f = byType('frame')[0] as El
    const n = byType('stickynote')[0] as El
    const label = byType('text')[0] as El
    const a = byType('arrow')[0] as El
    const ids = seed.elements.map((e) => e.id)
    for (const old of ['F', 'N', 'N.t', 'A', 'I']) expect(ids).not.toContain(old)
    expect(n.frameId).toBe(f.id)
    expect(label.containerId).toBe(n.id)
    expect(n.boundElements).toEqual([
      { id: label.id, type: 'text' },
      { id: a.id, type: 'arrow' },
    ])
    expect((a.startBinding as { elementId: string }).elementId).toBe(n.id)
    expect(a.endBinding).toBeNull() // it pointed at something not in the archive
    expect((n.groupIds as string[])[0]).not.toBe('g1')
    expect((label.groupIds as string[])[0]).toBe((n.groupIds as string[])[0])
    const custom = n.customData as { lobby: Record<string, unknown>; lobbyServer?: unknown }
    expect(custom.lobbyServer).toBeUndefined()
    expect(custom.lobby).not.toHaveProperty('ai')
    expect(custom.lobby.mindmap).toMatchObject({ rootId: n.id, parentId: null })
    expect(seed.doc).toMatchObject({ startView: { frameId: f.id } })
    expect(res.json().warnings.join(' ')).toMatch(/not in this archive/)
    expect(res.json()).toMatchObject({ linkedFiles: 1, droppedFiles: 0 })
  })

  it('refuses a v2 archive it cannot take', async () => {
    const archive = (await bob.req('GET', `/api/boards/${boardId}/export`)).json()
    const dup = { ...archive, elements: [...archive.elements, archive.elements[0]] }
    const bad = { ...archive, elements: [{ ...archive.elements[0], bogus: true }] }
    for (const body of [dup, bad, { ...archive, version: 3 }]) {
      const res = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import`, body)
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().error.code).toBe('INVALID_ARCHIVE')
    }
  })
})
