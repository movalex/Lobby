// Wave N (N6-3): the test support that reads Lobby's served font files from the installed engine: every face of the
// captured real export (the vector PDF tests' fixture) is there as a woff2 file, and nothing else is ever read.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseFaceTable } from '../../features/present-export/vector/text-layout.ts'
import { FACES_METADATA_ID } from './fonts.ts'
import { servedFontFile } from './test-fixtures.ts'

const fixture = readFileSync(
  new URL('../../features/present-export/vector/fixtures/intro-names.svg.xml', import.meta.url),
  'utf8',
)

describe('servedFontFile', () => {
  it('reads every face of the real export’s face table (woff2 files of the installed engine)', () => {
    const json = new RegExp(`<metadata id="${FACES_METADATA_ID}">([^<]*)</metadata>`).exec(fixture)?.[1] ?? ''
    const faces = parseFaceTable(json.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
    expect(faces.length).toBeGreaterThan(0)
    for (const f of faces) {
      const bytes = servedFontFile(f.url)
      expect(bytes, f.url).not.toBeNull()
      expect(new TextDecoder('latin1').decode(bytes?.subarray(0, 4)), f.url).toBe('wOF2')
    }
  })
  it('reads nothing outside the served font folder', () => {
    for (const url of [
      '/excalidraw-assets/fonts/../package.json',
      '/excalidraw-assets/fonts/Nunito/../../index.js',
      '/excalidraw-assets/fonts/Liberation/LiberationSans-Regular.woff2',
      '/excalidraw-assets/fonts/Nunito/missing.woff2',
      '/excalidraw-assets/fonts/Nunito/x.ttf',
      'https://esm.sh/@excalidraw/excalidraw/dist/prod/fonts/Nunito/x.woff2',
    ])
      expect(servedFontFile(url), url).toBeNull()
  })
})
