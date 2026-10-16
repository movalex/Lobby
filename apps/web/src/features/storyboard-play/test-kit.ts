// Test helpers for WS3 (not shipped: only the tests import it): storyboards as WS2 makes them (docs/WAVE-T-CONTRACTS.md
// §2: a head text with `sb:head`, panel frames with `sb:of`/`sb:pos`/`sb:dur`, field boxes with `kind` and bound
// labels, a picture), and a scene over them with the members the WS3 model reads (index, get, bounds).
import type { Bounds, CanvasElement } from '../../canvas/api/index.ts'
import type { FieldName, StoryboardCanvas } from './model.ts'
import { SB_FIELD_KINDS } from './model.ts'

export type El = CanvasElement & Record<string, unknown>

const base = (id: string, type: string, x: number, y: number, w: number, h: number, extra: object = {}): El =>
  ({
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    version: 1,
    customData: {},
    ...extra,
  }) as unknown as El

export interface PanelSpec {
  readonly id: string
  readonly pos: string
  readonly dur?: number
  readonly name?: string
  readonly fields?: Partial<Record<FieldName, string>>
  /** an uploaded image of this size inside the panel's picture area (none: no picture) */
  readonly image?: boolean
  /** a template image slot instead of an image */
  readonly slot?: boolean
  /** a free sketch (a rectangle) in the panel, no image */
  readonly sketch?: boolean
}

/** A storyboard's elements: the head (`sb:head`), each panel 400 × 300 in a row, its fields and its picture. */
export function storyboardEls(
  headId: string,
  panels: readonly PanelSpec[],
  head: Record<string, unknown> = { aspect: '16:9' },
  opts: { title?: string; withHead?: boolean } = {},
): El[] {
  const out: El[] = []
  if (opts.withHead !== false)
    out.push(
      base(headId, 'text', 0, -80, 300, 40, {
        text: opts.title ?? 'Spot 30',
        originalText: opts.title ?? 'Spot 30',
        containerId: null,
        customData: { lobby: { 'sb:head': head } },
      }),
    )
  panels.forEach((p, i) => {
    const x = i * 440
    const lobby: Record<string, unknown> = { 'sb:of': headId, 'sb:pos': p.pos }
    if (p.dur !== undefined) lobby['sb:dur'] = p.dur
    out.push(base(p.id, 'frame', x, 0, 400, 300, { name: p.name ?? '', customData: { lobby } }))
    if (p.image)
      out.push(
        base(`${p.id}.img`, 'image', x + 10, 10, 380, 214, {
          frameId: p.id,
          fileId: 'ver_x',
          customData: {
            lobby: {
              file: {
                assetId: 'ast_x',
                versionId: 'ver_x',
                kind: 'image',
                name: 'a.png',
                mimeType: 'image/png',
                sizeBytes: 9,
              },
            },
          },
        }),
      )
    if (p.slot)
      out.push(
        base(`${p.id}.slot`, 'rectangle', x + 10, 10, 380, 214, {
          frameId: p.id,
          customData: { lobby: { slot: 'image' } },
        }),
      )
    if (p.sketch) out.push(base(`${p.id}.sketch`, 'ellipse', x + 50, 40, 100, 80, { frameId: p.id }))
    let fy = 230
    for (const [f, words] of Object.entries(p.fields ?? {}) as [FieldName, string][]) {
      const box = `${p.id}.${f}`
      out.push(
        base(box, 'rectangle', x + 10, fy, 380, 30, {
          frameId: p.id,
          boundElements: [{ id: `${box}.t`, type: 'text' }],
          customData: { lobby: { kind: SB_FIELD_KINDS[f] } },
        }),
      )
      out.push(
        base(`${box}.t`, 'text', x + 14, fy + 4, 370, 22, {
          frameId: p.id,
          containerId: box,
          text: words,
          originalText: words,
        }),
      )
      fy += 12
    }
  })
  return out
}

/** A scene over `els` with what the WS3 model reads. */
export function sceneOf(els: readonly El[]): StoryboardCanvas & { els: El[] } {
  const list = [...els]
  const live = () => list.filter((e) => !e.isDeleted)
  return {
    els: list,
    index: {
      withLobbyKey: (key) => live().filter((e) => e.customData?.lobby && key in e.customData.lobby),
      byFrame: (id) => live().filter((e) => e.frameId === id),
    },
    get: (id) => list.find((e) => e.id === id),
    bounds: (id): Bounds | null => {
      const e = list.find((x) => x.id === id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
  }
}
