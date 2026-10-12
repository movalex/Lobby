// Wave N (WS6): the face table of a `fonts: 'names'` SVG (the vector PDF's fonts): the faces the 'embedded' SVG would
// embed, as same-origin paths only, and readable by the PDF worker's parser (features/present-export/vector).
import { describe, expect, it } from 'vitest'
import { FaceIndex, parseFaceTable } from '../../features/present-export/vector/text-layout.ts'
import {
  charsPerFamily,
  FACES_METADATA_ID,
  type FamilyInfo,
  facesTable,
  namedFacesOf,
  sameOriginFaces,
  selectFaces,
} from './fonts.ts'

const ORIGIN = 'https://lobby.example'
const registered = new Map<number, FamilyInfo>([
  [
    5,
    {
      local: false,
      faces: [
        {
          family: 'Excalifont',
          url: `${ORIGIN}/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-a.woff2`,
          unicodeRange: 'U+20-7e',
          weight: '400',
          style: 'normal',
        },
        {
          family: 'Excalifont',
          url: `${ORIGIN}/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-b.woff2`,
          unicodeRange: 'U+400-4ff',
          weight: '400',
          style: 'normal',
        },
      ],
    },
  ],
  [
    100,
    {
      local: false,
      faces: [
        {
          family: 'Xiaolai',
          url: `${ORIGIN}/excalidraw-assets/fonts/Xiaolai/Xiaolai-Regular-c.woff2`,
          unicodeRange: 'U+65e5-65e5, U+672c',
          weight: '400',
          style: 'normal',
        },
        {
          family: 'Xiaolai',
          url: 'https://esm.sh/@excalidraw/fonts/Xiaolai-Regular-d.woff2',
          unicodeRange: 'U+8a9e',
          weight: '400',
          style: 'normal',
        },
      ],
    },
  ],
])

describe('the names face table', () => {
  it('lists the covering faces as same-origin paths, never a foreign file', () => {
    const chars = charsPerFamily([{ type: 'text', fontFamily: 5, originalText: 'Hi 日本語' }])
    const faces = sameOriginFaces(
      selectFaces(chars, registered, () => [100]),
      ORIGIN,
    )
    expect(faces.map((f) => f.url)).toEqual([
      '/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-a.woff2',
      '/excalidraw-assets/fonts/Xiaolai/Xiaolai-Regular-c.woff2',
    ])
  })
  it('round-trips through the worker’s reader (the JSON the SVG metadata carries)', () => {
    const faces = sameOriginFaces(registered.get(5)?.faces ?? [], ORIGIN)
    const json = JSON.stringify(facesTable(faces))
    expect(parseFaceTable(json)).toEqual(faces)
    expect(FACES_METADATA_ID).toBe('lobby-pdf-faces')
  })
  it('CJK in a family without a CJK fallback (Nunito) gets Lobby’s CJK font as a last resort, marked `any`', () => {
    const withNunito = new Map(registered)
    withNunito.set(6, {
      local: false,
      faces: [
        {
          family: 'Nunito',
          url: `${ORIGIN}/excalidraw-assets/fonts/Nunito/Nunito-Regular-n.woff2`,
          unicodeRange: 'U+0-FF',
          weight: '500',
          style: 'normal',
        },
      ],
    })
    const chars = charsPerFamily([
      { type: 'text', fontFamily: 6, originalText: 'Memo 日本' },
      { type: 'text', fontFamily: 5, originalText: 'Hi' },
    ])
    const fallbacks = (f: number) => (f === 5 ? [100] : [])
    const faces = sameOriginFaces(namedFacesOf(chars, withNunito, fallbacks, [100]), ORIGIN)
    expect(faces.map((f) => [f.family, f.any ?? false])).toEqual([
      ['Nunito', false],
      ['Excalifont', false],
      ['Xiaolai', true],
    ])
    // the worker draws 日 in Nunito text with it (real text), and Latin in Nunito itself
    const idx = new FaceIndex(parseFaceTable(JSON.stringify(facesTable(faces))))
    const nunito = ['Nunito', 'sans-serif', 'Segoe UI Emoji']
    expect(idx.draw(0x65e5, nunito)).toMatchObject({ kind: 'face', face: { family: 'Xiaolai', any: true } })
    expect(idx.draw(0x4d, nunito)).toMatchObject({ kind: 'face', face: { family: 'Nunito' } })
    expect(idx.draw(0x1f600, nunito)).toEqual({ kind: 'glyph' })
    // without CJK, no last-resort face
    const latin = charsPerFamily([{ type: 'text', fontFamily: 6, originalText: 'Memo' }])
    expect(namedFacesOf(latin, withNunito, fallbacks, [100]).map((f) => f.family)).toEqual(['Nunito'])
  })
})
