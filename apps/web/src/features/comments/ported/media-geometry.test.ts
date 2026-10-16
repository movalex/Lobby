// Wave S (WS3): media comments on the canvas (./geometry.ts, ../model.ts). With the media comments switch on, an
// image with a Lobby file gets an `asset` anchor on its version with the clicked spot (its pin drawn at the spot), a
// placed PDF page names its page, and a thread on another version than its element shows has no pin and is labelled
// "earlier version". With the switch off, everything is as before wave S.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasElement, LobbyCanvas, ScenePoint } from '../../../canvas/api/index.ts'
import { anchorLabel, placementForClick, shownOnCanvas, versionChipText } from '../model.ts'

const flags = vi.hoisted(() => ({ mediaComments: false }))
vi.mock('../../review/flags.ts', () => ({
  reviewFlags: () => ({
    status: false,
    versions: false,
    mediaComments: flags.mediaComments,
    reviewPage: false,
  }),
  reviewViewerEnabled: () => flags.mediaComments,
}))

const { anchorAt, anchorForKeyboard, describeAnchor, onEarlierVersion, pinOnCanvas, pinPoint, placementAt } =
  await import('./geometry.ts')

afterEach(() => {
  flags.mediaComments = false
})

const AST = 'ast_0123456789ab'
const V1 = 'ver_0123456789ab'
const V2 = 'ver_abcdefghij01'

const fileEl = (
  id: string,
  kind: string,
  over: Record<string, unknown> = {},
  lobby: Record<string, unknown> = {},
) =>
  ({
    id,
    type: 'image',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    index: 'a0',
    boundElements: null,
    fileId: V1,
    customData: {
      lobby: {
        file: { assetId: AST, versionId: V1, kind, name: `${id}.${kind}`, mimeType: 'x/y', sizeBytes: 1 },
        ...lobby,
      },
    },
    ...over,
  }) as unknown as CanvasElement

const inside = (e: CanvasElement, p: ScenePoint) =>
  p.x >= e.x && p.y >= e.y && p.x <= e.x + e.width && p.y <= e.y + e.height

function fakeCanvas(els: CanvasElement[]) {
  let selection: string[] = []
  const byId = new Map(els.map((e) => [e.id, e]))
  return {
    items: () => els,
    get: (id: string) => byId.get(id),
    isHidden: () => false,
    get selection() {
      return selection
    },
    select: (ids: string[]) => {
      selection = [...ids]
    },
    doc: { get: () => undefined },
    viewport: {
      get: () => ({ x: 0, y: 0, width: 1000, height: 800, zoom: 1 }),
      screenRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    },
    sceneToOverlay: (p: ScenePoint) => p,
    hitTest: (p: ScenePoint) => [...els].reverse().find((e) => inside(e, p)) ?? null,
  } as unknown as LobbyCanvas
}

const photo = fileEl('photo', 'image', { x: 100, y: 100, width: 400, height: 200 })
const page = fileEl('page3', 'pdf', { x: 600, y: 0, fileId: `${V1}.p3` }, { pdfPage: 3 })
const card = fileEl('cut', 'video', { x: 0, y: 400 })

describe('the comment tool on media', () => {
  it('switch off: an image gets a shape anchor and a placed page no page (as before wave S)', () => {
    const canvas = fakeCanvas([photo, page])
    expect(anchorAt(canvas, { x: 200, y: 150 })).toEqual({
      kind: 'shape',
      shapeId: 'shape:photo',
      u: 0.25,
      v: 0.25,
    })
    expect(placementAt(canvas, { x: 200, y: 150 }).spot).toBeUndefined()
    expect(anchorAt(canvas, { x: 650, y: 50 })).toEqual({
      kind: 'asset',
      shapeId: 'shape:page3',
      assetId: AST,
      versionId: V1,
    })
  })

  it('switch on: an image gets an asset anchor on its version with the spot clicked; a placed page its page', () => {
    flags.mediaComments = true
    const canvas = fakeCanvas([photo, page, card])
    expect(placementAt(canvas, { x: 200, y: 150 })).toEqual({
      anchor: { kind: 'asset', shapeId: 'shape:photo', assetId: AST, versionId: V1 },
      spot: { u: 0.25, v: 0.25 },
    })
    expect(anchorAt(canvas, { x: 650, y: 50 })).toEqual({
      kind: 'asset',
      shapeId: 'shape:page3',
      assetId: AST,
      versionId: V1,
      page: 3,
    })
    // a card: an asset anchor without a spot (its pin on the corner)
    expect(placementAt(canvas, { x: 50, y: 450 })).toEqual({
      anchor: { kind: 'asset', shapeId: 'shape:cut', assetId: AST, versionId: V1 },
    })
    // the keyboard's comment on a selected image: an asset anchor, no spot
    canvas.select(['photo'])
    expect(anchorForKeyboard(canvas)).toEqual({
      kind: 'asset',
      shapeId: 'shape:photo',
      assetId: AST,
      versionId: V1,
    })
  })

  it('a spot pin on an image is drawn at its spot; a video or page spot stays on the card corner', () => {
    flags.mediaComments = true
    const canvas = fakeCanvas([photo, card])
    const onPhoto = { kind: 'asset', shapeId: 'shape:photo', assetId: AST, versionId: V1 } as const
    expect(pinPoint(canvas, onPhoto, { u: 0.5, v: 0.5 })).toEqual({ x: 300, y: 200 })
    expect(pinPoint(canvas, onPhoto)).toEqual({ x: 500, y: 100 })
    const onCut = { ...onPhoto, shapeId: 'shape:cut', timeMs: 1200 }
    expect(pinPoint(canvas, onCut, { u: 0.5, v: 0.5 })).toEqual({ x: 200, y: 400 })
  })
})

describe('threads on another version', () => {
  const onV2 = { kind: 'asset', shapeId: 'shape:cut', assetId: AST, versionId: V2, timeMs: 500 } as const
  const onV1 = { ...onV2, versionId: V1 }

  it('switch on: no pin on the canvas and labelled "earlier version"; the shown version keeps its pin', () => {
    flags.mediaComments = true
    const canvas = fakeCanvas([card])
    expect(pinOnCanvas(canvas, onV2)).toBe(false)
    expect(pinOnCanvas(canvas, onV1)).toBe(true)
    expect(onEarlierVersion(canvas, onV2)).toBe(true)
    expect(describeAnchor(canvas, onV2)).toBe('On cut.video, at 0:00 · earlier version')
    expect(describeAnchor(canvas, onV1)).toBe('On cut.video, at 0:00')
    // the element is gone: the orphan rules decide (listed "On a deleted object"), not the version
    expect(pinOnCanvas(fakeCanvas([]), onV2)).toBe(true)
  })

  it('switch off: every pin shows, no version wording', () => {
    const canvas = fakeCanvas([card])
    expect(pinOnCanvas(canvas, onV2)).toBe(true)
    expect(describeAnchor(canvas, onV2)).toBe('On cut.video, at 0:00')
  })
})

describe('the pure rules', () => {
  it('placementForClick, shownOnCanvas, versionChipText and the label', () => {
    const frame = {
      pageId: 'page:1',
      bounds: { x: 0, y: 0, w: 100, h: 50 },
      toPage: (p: { x: number; y: number }) => p,
      toLocal: (p: { x: number; y: number }) => p,
    }
    const target = { shapeId: 'shape:i', type: 'image', props: { assetId: AST, versionId: V1 }, frame }
    expect(placementForClick({ x: 10, y: 10 }, target, 'page:1', { mediaComments: true })).toEqual({
      anchor: { kind: 'asset', shapeId: 'shape:i', assetId: AST, versionId: V1 },
      spot: { u: 0.1, v: 0.2 },
    })
    expect(
      placementForClick(
        { x: 10, y: 10 },
        { ...target, props: { assetId: 'nope', versionId: V1 } },
        'page:1',
        {
          mediaComments: true,
        },
      ).anchor.kind,
    ).toBe('shape')
    expect(shownOnCanvas({ kind: 'point', x: 0, y: 0 }, () => V2)).toBe(true)
    expect(shownOnCanvas({ kind: 'asset', shapeId: 'shape:i', assetId: AST, versionId: V1 }, () => V2)).toBe(
      false,
    )
    expect(
      shownOnCanvas({ kind: 'asset', shapeId: 'shape:i', assetId: AST, versionId: V1 }, () => null),
    ).toBe(true)
    expect(versionChipText(1)).toBe('v1')
    expect(versionChipText(null)).toBe('Earlier version')
    expect(versionChipText(0)).toBe('Earlier version')
    const anchor = { kind: 'asset', shapeId: 'shape:i', assetId: AST, versionId: V1, page: 2 } as const
    expect(
      anchorLabel(anchor, { kind: 'placed', pageId: null, point: { x: 0, y: 0 } }, 'p', {
        fileName: 'a.pdf',
        otherVersion: true,
      }),
    ).toBe('On a.pdf, page 2 · earlier version')
  })
})
