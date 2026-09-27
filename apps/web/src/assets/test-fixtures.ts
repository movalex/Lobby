import { type AssetVersionMeta, type DerivativeRecord, newId } from './contract.ts'

export const TEST_BOARD = 'b-test000001'

/** A server-shaped AssetVersionMeta for tests (contract §5), overridable per field. */
export function makeMeta(over: Partial<AssetVersionMeta> = {}): AssetVersionMeta {
  return {
    schemaVersion: 1,
    assetId: newId('ast'),
    versionId: newId('ver'),
    boardId: TEST_BOARD,
    name: 'deck.pdf',
    declaredMimeType: 'application/pdf',
    mimeType: 'application/pdf',
    kind: 'pdf',
    sizeBytes: 2048,
    sha256: 'x',
    uploadedBy: 'alice',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    status: 'queued',
    attempts: 0,
    error: null,
    probe: {
      width: null,
      height: null,
      pageCount: null,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    },
    derivatives: [],
    ...over,
  }
}

export function derivative(
  over: Partial<DerivativeRecord> & Pick<DerivativeRecord, 'role'>,
): DerivativeRecord {
  return {
    id: newId('drv'),
    page: null,
    width: 512,
    height: 384,
    mimeType: 'image/webp',
    bytes: 1000,
    file: 'x.webp',
    ...over,
  }
}
