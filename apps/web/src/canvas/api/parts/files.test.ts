import { describe, expect, it } from 'vitest'
import { provideInserter, trackBoardUpload } from '../../../assets/board-media.ts'
import { onUploads, uploadsInFlight } from '../../board/uploads.ts'
import { attachBoardEngine } from '../../overrides.ts'
import type { CanvasPort } from '../../port.ts'
import { createFeatureRegistries } from '../registries.ts'
import { createFilesPart } from './files.ts'

const AST = 'ast_AAAAAAAAAAAAAAAAAAAA'
const VER = 'ver_BBBBBBBBBBBBBBBBBBBB'
const card = {
  id: 'c1',
  type: 'image',
  fileId: VER,
  customData: {
    lobby: {
      file: {
        assetId: AST,
        versionId: VER,
        kind: 'pdf',
        name: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      },
    },
  },
}

function part() {
  const registries = createFeatureRegistries()
  const port = { get: (id: string) => (id === 'c1' ? card : undefined) } as unknown as CanvasPort
  const files = createFilesPart({ port, registries, self: () => ({}) as never })
  return { registries, files }
}

describe('the files part (3g)', () => {
  it('urlOf: null without a board page engine or a Lobby file; the board-scoped original', async () => {
    const { registries, files } = part()
    expect(await files.urlOf('c1', { original: true })).toBeNull()
    attachBoardEngine(registries, {
      api: { onChange: () => () => {} } as never,
      wrapper: {} as never,
      boardId: 'b-1',
    })
    expect(await files.urlOf('nope', { original: true })).toBeNull()
    expect(await files.urlOf('c1', { original: true })).toBe(`/files/${AST}/${VER}/original?board=b-1`)
    // no image loader on this page yet: nothing to show
    expect(await files.urlOf('c1')).toBeNull()
  })

  it('insert: the media feature’s flow, refused while it is not mounted', async () => {
    const { registries, files } = part()
    await expect(files.insert([])).rejects.toThrow(/media feature is not mounted/)
    const off = provideInserter(registries, async (f) => f.map((x) => x.name))
    await expect(files.insert([{ name: 'x.png' } as File])).resolves.toEqual(['x.png'])
    off()
    await expect(files.insert([])).rejects.toThrow()
  })

  it('uploads through the media seam count for the page’s save indicator', async () => {
    const { registries } = part()
    let changes = 0
    onUploads(registries, () => changes++)
    let done!: () => void
    const upload = trackBoardUpload(registries, new Promise<void>((r) => (done = r)))
    expect(uploadsInFlight(registries)).toBe(1)
    done()
    await upload
    await Promise.resolve()
    expect(uploadsInFlight(registries)).toBe(0)
    expect(changes).toBe(2)
  })
})
