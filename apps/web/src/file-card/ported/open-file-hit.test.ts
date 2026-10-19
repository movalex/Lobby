// Wave W (WS3): which element a `?file=` link opens, and what opening it does (select, bring into view, the page
// viewer at the page). A fake canvas: only the scene index and the calls opening makes.

import { describe, expect, it } from 'vitest'
import type { CanvasElement, CanvasFeatureContext, FeatureRegistries } from '../../canvas/api/index.ts'
import { elementForVersion, openFileHit } from './open-file-hit.ts'
import { pdfViewerRequest } from './viewer-state.ts'

const VER = 'ver_0123456789abcdefghij'
const OTHER = 'ver_abcdefghij0123456789'

const image = (id: string, fileId: string, versionId: string, kind = 'pdf'): CanvasElement =>
  ({
    id,
    type: 'image',
    fileId,
    isDeleted: false,
    customData: {
      lobby: {
        file: {
          assetId: 'ast_0123456789abcdefghij',
          versionId,
          kind,
          name: 'Brief.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
        },
      },
    },
  }) as unknown as CanvasElement

function fakeCanvas(elements: CanvasElement[]) {
  const calls: string[] = []
  const canvas = {
    index: { withLobbyKey: (key: string) => (key === 'file' ? elements : []) },
    select: (ids: string[]) => calls.push(`select ${ids.join(',')}`),
    boundsOf: (ids: string[]) => (ids.length ? { x: 0, y: 0, width: 10, height: 10 } : null),
    viewport: { zoomTo: () => calls.push('zoom') },
  }
  return { canvas, calls }
}

describe('elementForVersion', () => {
  it('a card of the version first, else a placed page of it, else nothing', () => {
    const page = image('p3', `${VER}.p3`, VER)
    const card = image('card', VER, VER)
    const other = image('o', OTHER, OTHER)
    expect(elementForVersion(fakeCanvas([page, other, card]).canvas as never, VER)).toBe('card')
    expect(elementForVersion(fakeCanvas([other, page]).canvas as never, VER)).toBe('p3')
    expect(elementForVersion(fakeCanvas([other]).canvas as never, VER)).toBeNull()
  })
})

describe('openFileHit', () => {
  it('selects the card, brings it into view and asks the viewer for the page', () => {
    const { canvas, calls } = fakeCanvas([image('card', VER, VER)])
    const registries = {} as FeatureRegistries
    const ctx = { canvas, registries } as unknown as CanvasFeatureContext
    expect(openFileHit(ctx, { versionId: VER, page: 4 })).toBe(true)
    expect(calls).toEqual(['select card', 'zoom'])
    expect(pdfViewerRequest(registries).get()).toMatchObject({ id: 'card', page: 4 })
    expect(openFileHit(ctx, { versionId: OTHER, page: 1 })).toBe(false)
  })
})
