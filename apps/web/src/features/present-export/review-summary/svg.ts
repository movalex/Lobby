// OWNER: WS4 (wave S, the review summary PDF). A summary page as the SVG the vector PDF path draws
// (present-export/vector/vector-page.ts): the same structure Lobby's frame exports have (a face table with no
// faces, the system font family the vector page draws in the PDF's Helvetica), so the text is real, selectable text
// and the pictures are image objects. Only what the vector reading accepts is written (rects, text, embedded
// images), and the tests read every page back with `readScene` and require no problems. Pure.
import type { Op, SummaryPage } from './layout.ts'

// biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 cannot hold most control characters
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g
// a lone surrogate is not text either
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Text safe inside an XML element or attribute. */
export function xmlText(s: string): string {
  return s
    .replace(XML_INVALID, '')
    .replace(LONE_SURROGATE, '�')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const num = (n: number) => String(Math.round(n * 100) / 100)

/** The data: URLs the vector reading embeds natively. */
const IMAGE_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/

function opSvg(op: Op): string {
  switch (op.t) {
    case 'rect':
      return `<rect x="${num(op.x)}" y="${num(op.y)}" width="${num(op.w)}" height="${num(op.h)}" fill="${op.fill}"${
        op.stroke ? ` stroke="${op.stroke}" stroke-width="1"` : ' stroke="none"'
      }></rect>`
    case 'text':
      return `<text x="${num(op.x)}" y="${num(op.y)}" font-family="ui-sans-serif, system-ui" font-size="${num(op.size)}px" font-weight="${
        op.bold ? 'bold' : 'normal'
      }" fill="${op.fill}" text-anchor="start" style="white-space: pre;" direction="ltr" dominant-baseline="alphabetic">${xmlText(op.text)}</text>`
    case 'image':
      return IMAGE_URL.test(op.dataUrl)
        ? `<image href="${op.dataUrl}" x="${num(op.x)}" y="${num(op.y)}" width="${num(op.w)}" height="${num(op.h)}"></image>`
        : ''
  }
}

/** The page as an SVG document (white paper, the operations in paint order). */
export function pageToSvg(page: SummaryPage): string {
  return (
    `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}" width="${page.width}" height="${page.height}">` +
    '<!-- svg-source:lobby-review-summary --><metadata></metadata>' +
    '<defs><style class="style-fonts">\n\n</style><metadata id="lobby-pdf-faces">{"v":1,"faces":[]}</metadata></defs>' +
    `<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="#ffffff"></rect>` +
    page.ops.map(opSvg).join('') +
    '</svg>'
  )
}
