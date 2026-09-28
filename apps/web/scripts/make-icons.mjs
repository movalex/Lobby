// Regenerates the PNG app icons in apps/web/public/ from public/favicon.svg (the Lobby tile mark:
// navy tile, orange L, paper node). Run after changing the SVG:
//   node apps/web/scripts/make-icons.mjs
// sharp is borrowed from the preview worker (the web app has no image dependency of its own).
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(new URL('../../worker/package.json', import.meta.url)))
const sharp = require('sharp')

const publicDir = new URL('../public/', import.meta.url)
const tile = readFileSync(new URL('favicon.svg', publicDir), 'utf8')
// iOS rounds the corners itself and turns transparent pixels black: give it the tile full-bleed.
const fullBleed = tile.replace('<rect width="24" height="24" rx="4"', '<rect width="24" height="24"')
if (fullBleed === tile) throw new Error('favicon.svg no longer has the expected tile <rect>')

const icons = [
  { name: 'favicon-16.png', size: 16, svg: tile },
  { name: 'favicon-32.png', size: 32, svg: tile },
  { name: 'apple-touch-icon.png', size: 180, svg: fullBleed, opaque: true },
  { name: 'icon-192.png', size: 192, svg: tile },
  { name: 'icon-512.png', size: 512, svg: tile },
]

for (const { name, size, svg, opaque } of icons) {
  // Rasterize at the target size (the SVG is 24 user units, 72 dpi) rather than scaling a big render
  // down, so the 16 px and 32 px favicons keep librsvg's pixel-exact edges.
  let img = sharp(Buffer.from(svg), { density: (72 * size) / 24 }).resize(size, size)
  if (opaque) img = img.flatten({ background: '#213150' })
  const png = await img.png({ compressionLevel: 9 }).toBuffer()
  writeFileSync(new URL(name, publicDir), png)
  console.log(`${name.padEnd(22)} ${size}x${size}  ${png.length} bytes`)
}
