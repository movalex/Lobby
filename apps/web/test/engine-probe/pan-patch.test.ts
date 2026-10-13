/**
 * Lobby's two engine patches are the generator's output (docs/research/excalidraw/wave-o/pan-patch.mjs): a clean install
 * of @excalidraw/element and @excalidraw/excalidraw (read from the pnpm store, each file checked against the integrity
 * the lockfile installed) plus its parts (W5-53, O-1, O-1b, O-2) gives both patch files byte for byte, as
 * `pnpm patch-commit` writes them, and the lockfile holds their hashes. So a bump redoes the patches by script, and a
 * hand edit of a patch fails here.
 * The prod builds are minified, and their names change with every build: the generator checks each name a new line of
 * code calls against the build's own binding before it writes anything. Here a bump that left a name in place with
 * another meaning (the binding moved to another name) is planted, once per kind of check; each must fail the run.
 */
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

type Read = (pkg: 'element' | 'excalidraw', rel: string) => string
type Transform = (pkg: string, rel: string, text: string) => string
interface Generator {
  generate: (read?: Read, opts?: { transform?: Transform }) => Record<'element' | 'excalidraw', string>
  compare: (generated: Record<string, string>) => string[]
  storeSource: () => Read
}

const GENERATOR = join(
  fileURLToPath(new URL('../../../../', import.meta.url)),
  'docs/research/excalidraw/wave-o/pan-patch.mjs',
)
const load = async () => (await import(/* @vite-ignore */ pathToFileURL(GENERATOR).href)) as Generator

describe('the engine patches are the generator’s output', () => {
  it('a clean install plus the generator gives both patch files byte for byte, and the lockfile holds their hashes', async () => {
    const g = await load()
    const generated = g.generate()
    expect(generated.element).toContain('diff --git a/dist/prod/index.js b/dist/prod/index.js')
    expect(generated.excalidraw).toContain(
      'diff --git a/dist/prod/chunk-K5UJM3GG.js b/dist/prod/chunk-K5UJM3GG.js',
    )
    // no stanza for a file outside the package's `files` (patch-commit listed CHANGELOG.md and history.ts as deleted)
    expect(generated.excalidraw).not.toMatch(/^deleted file mode/m)
    expect(g.compare(generated)).toEqual([])
  })

  /** the generator over a clean install with one build file changed as a bump might change it */
  const plant = async (pkg: string, rel: string, from: string, to: string) => {
    const g = await load()
    const read = g.storeSource()
    let planted = 0
    const transform: Transform = (p, r, text) => {
      if (p !== pkg || r !== rel) return text
      expect(text.split(from).length - 1, `the planted change's anchor in ${pkg}/${rel}`).toBe(1)
      planted++
      return text.replace(from, () => to)
    }
    let error = ''
    try {
      g.generate(read, { transform })
    } catch (e) {
      error = String((e as Error).message)
    }
    expect(planted).toBe(1)
    return error
  }

  it('fails loudly when an exported name the element helpers call means something else (its export list)', async () => {
    // a bump in which getElementBounds is `ot` and `ae` another function
    const error = await plant(
      'element',
      'dist/prod/index.js',
      ',ae as getElementBounds,',
      ',ae as getElementBoundsOfSomethingElse,ot as getElementBounds,',
    )
    expect(error).toContain('"ae" is not the build\'s getElementBounds')
  })

  it('fails loudly when an imported name the excalidraw helpers call is another import (their import of the element package)', async () => {
    const error = await plant(
      'excalidraw',
      'dist/prod/chunk-K5UJM3GG.js',
      'getElementBounds as $U,',
      'getElementBounds as $V,getCommonBounds as $U,',
    )
    expect(error).toContain('"$U" is not its import of getElementBounds')
    const index = await plant(
      'excalidraw',
      'dist/prod/index.js',
      'getElementBounds as S5,',
      'getElementBounds as S6,',
    )
    expect(index).toContain('"S5" is not its import of getElementBounds')
  })

  it('fails loudly when a module-local function the blit calls is not the one it was (its definition)', async () => {
    // the engine's render no longer snaps the scroll through `lt`
    const error = await plant('excalidraw', 'dist/prod/chunk-K5UJM3GG.js', '=f?c:lt(c,t)', '=f?c:qt(c,t)')
    expect(error).toContain('It is _renderStaticScene and lt snapScrollToDevicePixels')
  })

  it('fails loudly when an anchor is gone (an edit of the bump’s own code)', async () => {
    const error = await plant(
      'element',
      'dist/prod/index.js',
      'Math.round(b*U+w*D+I)+Math.round(b*B+w*P+nu)',
      'Math.round(b*U+w*D+I+nu)+Math.round(b*B+w*P+nu)',
    )
    expect(error).toContain('anchor found 0 times')
  })
})
