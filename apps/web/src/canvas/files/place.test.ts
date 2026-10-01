// Spike B (O5, B7): what an uploaded file becomes on the canvas: one `image` element with only the
// version id and the card's facts (never bytes, data:, blob: or a signed URL), and which cards open.
import type { AssetVersionMeta } from '@draftroom/dev-assets/shared'
import { describe, expect, it } from 'vitest'
import type { CanvasPort, CanvasTx } from '../port.ts'
import { cardFactsOf } from './card.ts'
import { factsOf, placedSize, placeFile } from './place.ts'
import { FileUrlResolver } from './resolve.ts'

const meta = (extra: Partial<AssetVersionMeta>): AssetVersionMeta =>
  ({
    schemaVersion: 1,
    assetId: 'ast_00000000000000000001',
    versionId: 'ver_00000000000000000001',
    boardId: 'b-files',
    name: 'photo.png',
    declaredMimeType: 'image/png',
    mimeType: 'image/png',
    kind: 'image',
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    uploadedBy: 'usr_x',
    createdAt: '',
    updatedAt: '',
    status: 'ready',
    attempts: 1,
    error: null,
    probe: {
      width: 1600,
      height: 800,
      pageCount: null,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    },
    derivatives: [],
    ...extra,
  }) as AssetVersionMeta

describe('placing an uploaded file', () => {
  it('creates one image element with the version id and the facts, in one transact step', () => {
    const creates: [string, Record<string, unknown>][] = []
    const port = {
      transact: <T>(_label: string, fn: (tx: CanvasTx) => T): T =>
        fn({
          create: (kind, props) => {
            creates.push([kind, props as Record<string, unknown>])
            return 'el1'
          },
          update: () => {},
          delete: () => {},
        }),
    } as unknown as CanvasPort
    const resolver = new FileUrlResolver({
      boardId: 'b-files',
      meta: { load: async () => ({ meta: null, missing: true, error: false }) },
    })
    const id = placeFile(port, meta({}), { x: 500, y: 300 }, resolver)
    expect(id).toBe('el1')
    expect(creates).toHaveLength(1)
    const [kind, props] = creates[0] as [string, Record<string, unknown>]
    expect(kind).toBe('image')
    expect(props).toEqual({
      x: 300,
      y: 200,
      width: 400,
      height: 200,
      fileId: 'ver_00000000000000000001',
      status: 'saved',
      scale: [1, 1],
      customData: {
        lobby: {
          file: {
            assetId: 'ast_00000000000000000001',
            versionId: 'ver_00000000000000000001',
            kind: 'image',
            name: 'photo.png',
            mimeType: 'image/png',
            sizeBytes: 1234,
          },
        },
      },
    })
    const json = JSON.stringify(props)
    expect(json).not.toMatch(/data:|blob:|X-Amz|Signature=|\/files\//)
    expect(resolver.assetOf('ver_00000000000000000001')).toBe('ast_00000000000000000001')
  })

  it('cards get a fixed size; images keep their aspect; long names are cut to 200', () => {
    expect(
      placedSize(meta({ kind: 'pdf', probe: { ...meta({}).probe, width: null, height: null } })),
    ).toEqual({
      width: 240,
      height: 300,
    })
    expect(placedSize(meta({ probe: { ...meta({}).probe, width: 100, height: 300 } }))).toEqual({
      width: 100,
      height: 300,
    })
    expect(factsOf(meta({ name: 'x'.repeat(250) })).name).toHaveLength(200)
  })

  it('cardFactsOf reads a card; anything else is not one', () => {
    const facts = factsOf(meta({ kind: 'pdf' }))
    expect(cardFactsOf({ type: 'image', customData: { lobby: { file: facts } } })).toEqual(facts)
    expect(cardFactsOf({ type: 'rectangle', customData: { lobby: { file: facts } } })).toBeNull()
    expect(cardFactsOf({ type: 'image', customData: { lobby: {} } })).toBeNull()
    expect(cardFactsOf(null)).toBeNull()
  })
})
