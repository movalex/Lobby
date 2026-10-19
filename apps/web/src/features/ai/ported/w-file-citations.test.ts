// Wave W (the integration; docs/WAVE-W-CONTRACTS.md §5): Ask across boards cites a page inside a file by the file hit's
// id `file:<ver>.p<page>`. Such an id is never an element of the board: the answer's chip opens the file at that page
// (the search's `?file=` deep link, file-card/ported/open-file-hit.ts) instead of looking for an unknown element.

import { fileHitObjectId } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import type { CanvasElement, CanvasFeatureContext, FeatureRegistries } from '../../../canvas/api/index.ts'
import { readFileHit } from '../../../file-card/ported/open-file-hit.ts'
import { pdfViewerRequest } from '../../../file-card/ported/viewer-state.ts'
import { citationHref, citedElementIds, citedFilePage, showCitationHere } from './ask-all.ts'

const VER = 'ver_0123456789abcdefghij'
const BOARD = 'b-launch0001'

const card = (id: string, versionId: string): CanvasElement =>
  ({
    id,
    type: 'image',
    fileId: versionId,
    isDeleted: false,
    customData: {
      lobby: {
        file: {
          assetId: 'ast_0123456789abcdefghij',
          versionId,
          kind: 'pdf',
          name: 'Brief.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
        },
      },
    },
  }) as unknown as CanvasElement

function fakeCtx(files: CanvasElement[], elements: string[] = []) {
  const calls: string[] = []
  const known = new Set([...files.map((f) => f.id), ...elements])
  const canvas = {
    index: { withLobbyKey: (key: string) => (key === 'file' ? files : []) },
    get: (id: string) => (known.has(id) ? { id, isDeleted: false } : undefined),
    select: (ids: string[]) => calls.push(`select ${ids.join(',')}`),
    boundsOf: (ids: string[]) => (ids.length ? { x: 0, y: 0, width: 10, height: 10 } : null),
    viewport: { zoomTo: () => calls.push('zoom') },
  }
  const registries = {} as FeatureRegistries
  return { ctx: { canvas, registries } as unknown as CanvasFeatureContext, calls, registries }
}

describe('a citation of a page inside a file', () => {
  it('leads with the file page: its link opens the file at that page, read back by the board', () => {
    const c = { boardId: BOARD, elementIds: [fileHitObjectId(VER, 3), 'n1'] }
    expect(citedFilePage(c)).toEqual({ versionId: VER, page: 3 })
    const href = citationHref(c)
    expect(href).toBe(`/b/${BOARD}?file=${VER}&page=3`)
    expect(readFileHit(`http://lobby.invalid${href}`)).toEqual({ versionId: VER, page: 3 })
  })

  it('a citation of canvas elements keeps its ?el= link, never naming a file page as an element', () => {
    const c = { boardId: BOARD, elementIds: ['n1', fileHitObjectId(VER, 2), 'n2'] }
    expect(citedFilePage(c)).toBeNull()
    expect(citedElementIds(c)).toEqual(['n1', 'n2'])
    expect(citationHref(c)).toBe(`/b/${BOARD}?el=n1,n2`)
    expect(citationHref({ boardId: BOARD, elementIds: [] })).toBe(`/b/${BOARD}`)
  })

  it('on the board open here, the chip opens the file viewer at the page', () => {
    const { ctx, calls, registries } = fakeCtx([card('card', VER)])
    expect(showCitationHere(ctx, { elementIds: [fileHitObjectId(VER, 5)] })).toBe(true)
    expect(calls).toEqual(['select card', 'zoom'])
    expect(pdfViewerRequest(registries).get()).toMatchObject({ id: 'card', page: 5 })
  })

  it('a file the board no longer shows falls back to the cited elements, and nothing else is selected', () => {
    const { ctx, calls, registries } = fakeCtx([], ['n1'])
    expect(showCitationHere(ctx, { elementIds: [fileHitObjectId(VER, 5), 'n1'] })).toBe(true)
    expect(calls).toEqual(['select n1', 'zoom'])
    expect(pdfViewerRequest(registries).get()).toBeNull()
    const none = fakeCtx([])
    expect(showCitationHere(none.ctx, { elementIds: [fileHitObjectId(VER, 5)] })).toBe(false)
    expect(none.calls).toEqual([])
  })
})
