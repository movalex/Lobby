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
      // the derivative swap installs on it and reads its (empty) scene
      api: { onChange: () => () => {}, getSceneElements: () => [], getAppState: () => ({}) } as never,
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

  it('CR 3G-2 (CR-3A-9): files.track counts an upload for the save indicator until it settles, failed or not', async () => {
    const { registries, files } = part()
    let done!: (v: string) => void
    const ok = files.track(new Promise<string>((r) => (done = r)))
    const bad = files.track(Promise.reject(new Error('quota')))
    expect(uploadsInFlight(registries)).toBe(2)
    done('ver_x')
    await expect(ok).resolves.toBe('ver_x')
    await expect(bad).rejects.toThrow('quota')
    await Promise.resolve()
    expect(uploadsInFlight(registries)).toBe(0)
  })
})

// W5-13 / CR-W5-3G-1: a crop is written in the pixels of the thumb every tab loads, so a cropped image
// (or the one being cropped) is never shown from its 2,048 px rendering on this page.
describe('the crop editor and the thumb (3g)', () => {
  const image = (id: string, fileId: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'image',
    fileId,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 400,
    height: 225,
    customData: {
      lobby: {
        file: {
          assetId: AST,
          versionId: VER,
          kind: 'image',
          name: 'a.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1,
        },
      },
    },
    ...extra,
  })

  function engine(elements: Record<string, unknown>[], opts: { readOnly?: boolean; locked?: boolean } = {}) {
    let scene = elements
    let appState: Record<string, unknown> = { croppingElementId: null }
    const listeners = new Set<() => void>()
    const updates: { elements?: unknown[]; appState?: Record<string, unknown> }[] = []
    const api = {
      getSceneElements: () => scene.filter((e) => !e.isDeleted),
      getSceneElementsIncludingDeleted: () => scene,
      getAppState: () => ({
        ...appState,
        scrollX: 0,
        scrollY: 0,
        width: 1000,
        height: 800,
        zoom: { value: 1 },
      }),
      onChange: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      updateScene: (u: { elements?: Record<string, unknown>[]; appState?: Record<string, unknown> }) => {
        updates.push(u)
        if (u.elements) scene = u.elements
        if (u.appState) appState = { ...appState, ...u.appState }
        for (const l of listeners) l()
      },
    }
    const registries = createFeatureRegistries()
    const port = {
      get: (id: string) => scene.find((e) => e.id === id),
      select: () => {},
    } as unknown as CanvasPort
    const self = { readOnly: () => !!opts.readOnly, isLocked: () => !!opts.locked }
    const files = createFilesPart({ port, registries, self: () => self as never })
    attachBoardEngine(registries, { api: api as never, wrapper: {} as never, boardId: 'b-1' })
    const fileIdOf = (id: string) => scene.find((e) => e.id === id)?.fileId
    const change = async () => {
      for (const l of listeners) l()
      await Promise.resolve()
      await Promise.resolve()
    }
    return { files, updates, fileIdOf, change, appState: () => appState }
  }

  it('files.crop opens the engine’s crop editor on the image, put back on its thumb first', () => {
    const e = engine([image('i1', `${VER}@display`)])
    expect(e.files.crop?.('i1')).toBe(true)
    expect(e.fileIdOf('i1')).toBe(VER)
    expect(e.appState().croppingElementId).toBe('i1')
  })

  it('a cropped image shown from its display rendering goes back to its thumb (local only)', async () => {
    const e = engine([image('i1', `${VER}@display`, { crop: { x: 0, y: 0, width: 100, height: 100 } })])
    await e.change()
    expect(e.fileIdOf('i1')).toBe(VER)
    // an uncropped one is left to the swap
    const f = engine([image('i2', `${VER}@display`)])
    await f.change()
    expect(f.fileIdOf('i2')).toBe(`${VER}@display`)
  })

  it('no crop for a card, a missing element, a read-only person or a locked image', () => {
    const pdfCard = { ...image('c1', VER), customData: card.customData }
    expect(engine([pdfCard]).files.crop?.('c1')).toBe(false)
    expect(engine([]).files.crop?.('nope')).toBe(false)
    expect(engine([image('i1', VER)], { readOnly: true }).files.crop?.('i1')).toBe(false)
    expect(engine([image('i1', VER)], { locked: true }).files.crop?.('i1')).toBe(false)
  })
})
