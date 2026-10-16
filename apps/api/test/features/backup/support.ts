// Backups made for the api tests (wave R, WS4): the real writer (packages/board-archive) over a v2 board archive.
import { createHash } from 'node:crypto'
import { type BackupFileInput, writeBackup } from '@draftroom/board-archive'
import { CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import type { BackupManifestFile, LobbyElementsSnapshot } from '@draftroom/contracts'
import {
  type LobbySeed,
  type RoomSnapshotJson,
  type SyncInternalClient,
  SyncSeedConflict,
} from '../../../src/sync-internal.ts'
import { type Client, ORIGIN, type TestApi } from '../../helpers.ts'

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

export async function collect(gen: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const p of gen) parts.push(Buffer.from(p))
  return Buffer.concat(parts)
}

export interface BackupFile extends Omit<BackupManifestFile, 'path' | 'sha256' | 'sizeBytes' | 'omitted'> {
  bytes: Buffer
  omitted?: boolean
}

/** A `.lobby` file of these elements (a v2 archive) and files, as the download writes it. */
export async function makeBackup(
  opts: {
    title?: string
    elements?: unknown[]
    doc?: Record<string, unknown>
    files?: BackupFile[]
    contractsRev?: number
  } = {},
): Promise<Buffer> {
  const elements = opts.elements ?? []
  const files = opts.files ?? []
  const board = Buffer.from(
    JSON.stringify({
      format: 'lobby-board',
      version: 2,
      engine: 'excalidraw',
      engineVersion: '0.18.0-1118751',
      schema: 1,
      exportedAt: '2026-10-16T00:00:00.000Z',
      elements,
      doc: opts.doc ?? {},
      assets: [],
    }),
  )
  const originals = new Map<string, BackupFileInput>()
  for (const f of files) {
    if (f.omitted) continue
    const bytes = f.bytes
    originals.set(sha256(bytes), {
      sha256: sha256(bytes),
      size: bytes.length,
      open: async function* () {
        yield bytes
      },
    })
  }
  return collect(
    writeBackup({
      createdAt: new Date('2026-10-16T00:00:00Z'),
      app: { contractsRev: opts.contractsRev ?? CONTRACTS_REV, engineVersion: '0.18.0-1118751' },
      title: opts.title ?? 'Backed up',
      elements: elements.length,
      board,
      files: files.map(({ bytes, omitted, ...f }) => ({
        ...f,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        omitted: !!omitted,
      })),
      originals,
    }),
  )
}

// biome-ignore lint/suspicious/noExplicitAny: elements are JSON, read field by field
export type El = Record<string, any> & { id: string; type: string }

export class LobbySync implements SyncInternalClient {
  boards = new Map<string, LobbyElementsSnapshot>()
  seeds: { boardId: string; body: LobbySeed }[] = []
  async engine() {
    return 'excalidraw' as const
  }
  setBoard(boardId: string, elements: El[], doc: Record<string, unknown> = {}) {
    this.boards.set(boardId, { format: 'lobby-elements', schema: 1, clock: 7, elements, doc })
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
  async seed(boardId: string, body: RoomSnapshotJson | LobbySeed) {
    const lobby = body as LobbySeed
    this.seeds.push({ boardId, body: structuredClone(lobby) })
    if (this.boards.has(boardId)) throw new SyncSeedConflict()
    this.setBoard(boardId, lobby.elements as El[], lobby.doc)
    return { records: lobby.elements.length }
  }
}

export const base = (id: string, type: string, o: Record<string, unknown> = {}): El => ({
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
export const textEl = (id: string, words: string, o: Record<string, unknown> = {}) =>
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
type Ref = { assetId: string; versionId: string }
export const fileFacts = (v: Ref, kind: string, name: string, mimeType: string, n: number) => ({
  assetId: v.assetId,
  versionId: v.versionId,
  kind,
  name,
  mimeType,
  sizeBytes: n,
})

export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
)
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

/** A frame holding a labelled, voted note in a group, an arrow from it to a box, an image and a placed PDF page. */
export function sourceBoard(photo: Ref, doc: Ref) {
  return [
    base('F', 'frame', { name: 'Ideas', width: 800, height: 600, index: 'a0' }),
    base('N', 'stickynote', {
      x: 10,
      baseHeight: 200,
      created: null,
      frameId: 'F',
      index: 'a1',
      groupIds: ['g1'],
      boundElements: [
        { id: 'N.t', type: 'text' },
        { id: 'A', type: 'arrow' },
      ],
      customData: { lobby: { 'plusOne:usr_voter': true } },
    }),
    textEl('N.t', 'our big idea', { containerId: 'N', frameId: 'F', index: 'a2', groupIds: ['g1'] }),
    base('R', 'rectangle', {
      x: 300,
      frameId: 'F',
      index: 'a3',
      boundElements: [{ id: 'A', type: 'arrow' }],
    }),
    base('A', 'arrow', {
      x: 110,
      y: 50,
      index: 'a4',
      frameId: 'F',
      width: 190,
      height: 0,
      points: [
        [0, 0],
        [190, 0],
      ],
      startBinding: { elementId: 'N', fixedPoint: [1, 0.5], mode: 'orbit' },
      endBinding: { elementId: 'R', fixedPoint: [0, 0.5], mode: 'orbit' },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
    }),
    base('I', 'image', {
      x: 500,
      index: 'a5',
      fileId: photo.versionId,
      scale: [1, 1],
      crop: null,
      status: 'saved',
      customData: { lobby: { file: fileFacts(photo, 'image', 'photo.png', 'image/png', PNG.length) } },
    }),
    base('P', 'image', {
      x: 700,
      index: 'a6',
      fileId: `${doc.versionId}.p2`,
      scale: [1, 1],
      crop: null,
      status: 'saved',
      customData: {
        lobby: { file: fileFacts(doc, 'pdf', 'deck.pdf', 'application/pdf', PDF.length), pdfPage: 2 },
      },
    }),
  ]
}

export async function uploadAs(
  api: TestApi,
  c: Client,
  bid: string,
  name: string,
  type: string,
  bytes: Buffer,
) {
  const res = await api.app.inject({
    method: 'POST',
    url: `/api/boards/${bid}/assets`,
    payload: bytes,
    headers: {
      origin: ORIGIN,
      'content-type': type,
      'x-file-name': encodeURIComponent(name),
      cookie: c.cookie,
    },
  })
  if (res.statusCode !== 201) throw new Error(`upload failed ${res.statusCode} ${res.body}`)
  return res.json() as { assetId: string; versionId: string }
}

