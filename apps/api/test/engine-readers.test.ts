// The api's readers of board content on the Excalidraw engine (wave 2F, docs/EXCALIDRAW-MIGRATION.md §1
// A5): AI sources, the asset collector's checkpoint and board refs, vote eligibility, and the element
// vocabulary they share (canvas/lobby-elements.ts). Pure: no server, no database.

import type { LobbyElementsSnapshot } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { exportableElements, fileOf, objectTypeOf } from '../src/canvas/lobby-elements.ts'
import { collectSources } from '../src/features/ai/sources.ts'
import { checkpointBodyOf, readCheckpointBody } from '../src/features/history/snapshot-rows.ts'
import { shapesFromSnapshot } from '../src/features/workshops/shapes.ts'
import { parseBoardRefs, versionsInCheckpoint } from '../src/files/gc-refs.ts'

const VER = (n: number) => `ver_${String(n).padStart(12, '0')}`
const AST = (n: number) => `ast_${String(n).padStart(12, '0')}`
const el = (id: string, type: string, o: Record<string, unknown> = {}) => ({
  id,
  type,
  x: 0,
  y: 0,
  isDeleted: false,
  frameId: null,
  locked: false,
  ...o,
})
const label = (id: string, containerId: string, words: string, o: Record<string, unknown> = {}) =>
  el(id, 'text', { containerId, originalText: words, text: words, ...o })
const snap = (
  elements: Record<string, unknown>[],
  doc: Record<string, unknown> = {},
): LobbyElementsSnapshot => ({
  format: 'lobby-elements',
  schema: 1,
  clock: 3,
  elements,
  doc,
})

describe('the element vocabulary', () => {
  it('names objects as the api’s readers do, and file facts only when they match the fileId', () => {
    expect(objectTypeOf(el('n', 'stickynote'))).toBe('note')
    expect(objectTypeOf(el('l', 'text', { containerId: 'n' }))).toBeNull()
    const card = el('c', 'image', {
      fileId: VER(1),
      customData: { lobby: { file: { assetId: AST(1), versionId: VER(1), kind: 'pdf', name: 'a.pdf' } } },
    })
    expect(objectTypeOf(card)).toBe('dr-file-card')
    expect(objectTypeOf({ ...card, fileId: `${VER(1)}.p2` })).toBe('image') // a placed page
    expect(fileOf(card)).toEqual({ versionId: VER(1), assetId: AST(1), kind: 'pdf', name: 'a.pdf' })
    const mismatch = { ...card, fileId: VER(2) }
    expect(fileOf(mismatch)).toEqual({ versionId: VER(2), assetId: null, kind: null, name: '' })
  })

  it('exports without votes, private-note authors and last editors', () => {
    const [copy] = exportableElements([
      el('n', 'stickynote', {
        customData: {
          lobby: { 'plusOne:u1': true, 'tag:a': { name: 'A', color: 'red' } },
          lobbyServer: {
            createdBy: null,
            lastEditedBy: { uid: 'u' },
            privateNote: { session: 's', author: 'u' },
          },
        },
      }),
      el('gone', 'rectangle', { isDeleted: true }),
    ])
    expect(copy?.customData).toEqual({
      lobby: { 'tag:a': { name: 'A', color: 'red' } },
      lobbyServer: { createdBy: null, lastEditedBy: null, privateNote: { session: 's' } },
    })
  })
})

describe('AI sources on a lobby-elements snapshot', () => {
  const board = snap([
    el('F', 'frame', { name: 'Retro', x: 0, y: 0 }),
    el('n1', 'stickynote', { frameId: 'F', x: 300, y: 0 }),
    label('n1.t', 'n1', 'second idea', {
      customData: { lobbyServer: { lastEditedBy: { uid: 'usr_a', name: 'A', guest: false } } },
    }),
    el('n2', 'stickynote', { frameId: 'F', x: 0, y: 0 }),
    label('n2.t', 'n2', 'first idea', {
      customData: { lobbyServer: { lastEditedBy: { uid: 'usr_b', name: 'B', guest: false } } },
    }),
    el('n3', 'stickynote', { frameId: 'F', x: 600, y: 0, customData: { lobby: { prompt: true } } }),
    label('n3.t', 'n3', 'What went well?'),
    el('img', 'image', { frameId: 'F', fileId: VER(1) }),
    el('lock', 'stickynote', { frameId: 'F', locked: true, x: 900 }),
    label('lock.t', 'lock', 'locked idea', {
      customData: { lobbyServer: { lastEditedBy: { uid: 'usr_a', name: 'A', guest: false } } },
    }),
  ])

  it('opens a frame into its notes in reading order, with label text, never files', () => {
    const s = collectSources(board, ['shape:F'], { action: 'summarize', tokenBudget: 10_000 })
    expect(s.frames).toEqual(['Retro'])
    expect(s.items.map((i) => [i.id, i.kind, i.text])).toEqual([
      ['shape:n2', 'note', 'first idea'],
      ['shape:n1', 'note', 'second idea'],
      ['shape:n3', 'note', 'What went well?'],
      ['shape:lock', 'note', 'locked idea'],
    ])
  })

  it('groups ideas only: no prompt notes, no locked notes', () => {
    const s = collectSources(board, ['shape:F'], { action: 'themes', tokenBudget: 10_000 })
    expect(s.items.map((i) => i.id)).toEqual(['shape:n2', 'shape:n1'])
  })
})

describe('the asset collector on the Excalidraw engine', () => {
  it('reads a v2 checkpoint’s images (asset known or not) and a v1 body as before', () => {
    const made = checkpointBodyOf(
      'b-one',
      snap([
        el('a', 'image', {
          fileId: VER(1),
          customData: { lobby: { file: { assetId: AST(1), versionId: VER(1), kind: 'image', name: 'x' } } },
        }),
        el('b', 'image', { fileId: `${VER(2)}.p3` }),
        el('c', 'image', { fileId: VER(3), isDeleted: true }),
      ]),
    )
    expect(made.body).toMatchObject({ format: 'lobby-checkpoint', version: 2, clock: 3 })
    expect(versionsInCheckpoint(made.json)).toEqual([
      { assetId: AST(1), versionId: VER(1) },
      { assetId: null, versionId: VER(2) },
    ])
    expect(readCheckpointBody(made.json)).toMatchObject({ version: 2, schema: 1 })
    const v1 = JSON.stringify({ format: 'draftroom-checkpoint', version: 1, documents: [] })
    expect(versionsInCheckpoint(v1)).toEqual([])
    expect(readCheckpointBody(v1)).toMatchObject({ version: 1, records: [] })
    expect(() => readCheckpointBody(JSON.stringify({ format: 'other' }))).toThrow()
  })

  it('takes the sync answer’s bare versions, and refuses a malformed one', () => {
    const ok = {
      boardId: 'b-one',
      exists: true,
      canvas: [{ assetId: AST(1), versionId: VER(1) }],
      deleted: [],
      unusedAssetRecords: [],
      versionsOnly: { canvas: [VER(2)], deleted: [VER(3)] },
    }
    expect(parseBoardRefs(ok, 'b-one')?.versions).toEqual([VER(2), VER(3)])
    const tldraw = { ...ok, versionsOnly: undefined }
    expect(parseBoardRefs(tldraw, 'b-one')?.versions).toEqual([])
    expect(parseBoardRefs({ ...ok, versionsOnly: { canvas: ['nope'], deleted: [] } }, 'b-one')).toBeNull()
  })

  it('hashes v2 content so equal boards are equal and a doc change is a change', () => {
    const a = checkpointBodyOf('b-one', snap([el('x', 'rectangle')], {}))
    const b = checkpointBodyOf('b-one', snap([el('x', 'rectangle')], {}))
    const c = checkpointBodyOf('b-one', snap([el('x', 'rectangle')], { startView: { x: 1 } }))
    expect(a.contentHash).toBe(b.contentHash)
    expect(c.contentHash).not.toBe(a.contentHash)
  })
})

describe('vote eligibility on the Excalidraw engine', () => {
  it('uses the same vocabulary (a file card stays a dr-file-card), frames as parents', () => {
    const map = shapesFromSnapshot(
      snap([
        el('F', 'frame'),
        el('card', 'image', {
          frameId: 'F',
          fileId: VER(1),
          customData: { lobby: { file: { assetId: AST(1), versionId: VER(1), kind: 'other', name: 'n' } } },
        }),
        label('lbl', 'card', 'x'),
      ]),
    )
    expect(map.get('shape:card')).toEqual({ id: 'shape:card', type: 'dr-file-card', parentId: 'shape:F' })
    expect(map.has('shape:lbl')).toBe(false)
  })
})
