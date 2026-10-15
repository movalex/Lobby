// Review fix (wave Q): an image in a library item's tile loads from the item's thumb route by its VERSION id; a placed
// PDF page (`fileId` = `ver_….p<n>`) asks for that page's rendering (`?page=n`), not for a version id that does not
// exist (the raw fileId: a 404 and a blank tile).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ItemPreview, type ItemPreviewEl } from './Previews.tsx'
import { itemThumb } from './Tiles.tsx'

const W = 'wsp_0123456789abcdefghij'
const ITEM = 'lbi_0123456789abcdefghij'
const VER = 'ver_0123456789abcdef'

const picture = (fileId: string): ItemPreviewEl => ({
  type: 'image',
  x: 0,
  y: 0,
  width: 100,
  height: 140,
  strokeColor: 'transparent',
  backgroundColor: 'transparent',
  fileId,
})

const hrefs = (elements: ItemPreviewEl[]) =>
  [
    ...renderToStaticMarkup(
      createElement(ItemPreview, { id: ITEM, elements, width: 100, height: 140, thumb: itemThumb(W, ITEM) }),
    ).matchAll(/<image[^>]*href="([^"]*)"/g),
  ].map((m) => m[1]?.replaceAll('&amp;', '&'))

describe('an item tile’s images', () => {
  it('a plain image: its version’s thumb', () => {
    expect(hrefs([picture(VER)])).toEqual([`/api/workspaces/${W}/library/items/${ITEM}/files/${VER}/thumb`])
  })

  it('a placed PDF page: the version id and the page derivative', () => {
    expect(hrefs([picture(`${VER}.p3`), picture(`${VER}.p12`)])).toEqual([
      `/api/workspaces/${W}/library/items/${ITEM}/files/${VER}/thumb?page=3`,
      `/api/workspaces/${W}/library/items/${ITEM}/files/${VER}/thumb?page=12`,
    ])
  })

  it('a fileId that is no Lobby version draws the placeholder, never a request', () => {
    for (const bad of ['data:image/png;base64,AAAA', 'https://evil.example/x.png', '../../x', ''])
      expect(hrefs([picture(bad)])).toEqual([])
  })
})
