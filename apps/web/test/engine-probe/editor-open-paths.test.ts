/**
 * Spike check A16, static half (plan §2.9.2, §6.5, §8.2): the pinned bundle opens the text editor
 * from exactly 7 `startTextEditing` call sites and 2 `handleTextWysiwyg` call sites. Any other count
 * fails: an Excalidraw bump that adds a path must add it to the editor-open table (P1–P8) first.
 *
 * Both builds are checked: esbuild keeps class-member names in `dist/prod` (they are property
 * accesses, which minifiers do not rename), so the count is meaningful there too.
 */
import { describe, expect, it } from 'vitest'
import { type Build, callSites, count, otherJsFiles, PINNED, packageVersion, readDist } from './bundle.ts'

const EXPECTED = { startTextEditing: 7, handleTextWysiwyg: 2 } as const

describe('A16 static: editor-open call sites in @excalidraw/excalidraw', () => {
  it(`is the pinned ${PINNED}`, () => {
    for (const p of ['excalidraw', 'element', 'common', 'math', 'fractional-indexing'])
      expect(packageVersion(p)).toBe(PINNED)
  })

  for (const build of ['dev', 'prod'] as Build[]) {
    it(`${build}: exactly 7 startTextEditing and 2 handleTextWysiwyg call sites, 1 definition each`, () => {
      const src = readDist('excalidraw', build)
      for (const [name, calls] of Object.entries(EXPECTED)) {
        const callCount = count(src, new RegExp(`\\.${name}\\(`))
        const all = count(src, new RegExp(`\\b${name}\\b`))
        // every other mention is the definition: a reference passed around (not called) would change `all`
        expect({ name, build, calls: callCount, mentions: all }).toEqual({
          name,
          build,
          calls,
          mentions: calls + 1,
        })
      }
      for (const f of otherJsFiles('excalidraw', build)) {
        const chunk = readDist('excalidraw', build, f)
        expect({ f, n: count(chunk, /\b(startTextEditing|handleTextWysiwyg)\b/) }).toEqual({ f, n: 0 })
      }
    })
  }

  it('dev: the call sites are where the plan’s P1–P8 table says, in the functions it names', () => {
    const src = readDist('excalidraw', 'dev')
    const sites = (name: string) =>
      callSites(src, name).map((s) => ({ line: s.line, fn: s.enclosing[0]?.split('@')[0] }))
    // plan §2.9.2: P7 AppToolDrag onDrop 27822-27829; P1 onKeyDown 44150-44185; P3/P4/P8
    // handleCanvasDoubleClick 44726-44871; P6 handleTextOnPointerDown 46338-46380; P7 sticky-note tool
    // 51295-51320; P5 51679-51686 (both in the pointer-up handler)
    expect(sites('startTextEditing')).toEqual([
      { line: 27824, fn: 'onDrop' },
      { line: 44176, fn: 'onKeyDown' },
      { line: 44864, fn: 'handleCanvasDoubleClick' },
      { line: 46350, fn: 'handleTextOnPointerDown' },
      { line: 46374, fn: 'handleTextOnPointerDown' },
      { line: 51313, fn: 'onPointerUpFromPointerDownHandler' },
      { line: 51681, fn: 'onPointerUpFromPointerDownHandler' },
    ])
    // every startTextEditing ends in handleTextWysiwyg at 44685; a new text drawn by drag opens it at 51250
    expect(sites('handleTextWysiwyg')).toEqual([
      { line: 44685, fn: 'startTextEditing' },
      { line: 51250, fn: 'onPointerUpFromPointerDownHandler' },
    ])
  })
})
