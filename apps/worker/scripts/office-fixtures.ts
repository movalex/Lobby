// Office document fixtures, built from scratch (no third-party binaries in the repo): small but real
// DOCX, PPTX, XLSX, ODT, ODP and ODS files with synthetic, non-sensitive content, plus the hostile and
// broken ones the worker must refuse before LibreOffice sees them. Used by make-fixtures.ts.
import zlib from 'node:zlib'

// ---- ZIP writer (deflate or stored; fixed 1980-01-01 timestamps, so the bytes are reproducible) --------

export interface ZipFile {
  name: string
  data: Buffer
  /** Stored (method 0) instead of deflated: ODF requires it for `mimetype`. */
  store?: boolean
}

interface RawEntry {
  name: string
  method: 0 | 8
  crc: number
  size: number
  compressed: Buffer
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1

function writeZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x800, 6) // UTF-8 names
    lh.writeUInt16LE(e.method, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(e.crc, 14)
    lh.writeUInt32LE(e.compressed.length, 18)
    lh.writeUInt32LE(e.size, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x800, 8)
    ch.writeUInt16LE(e.method, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(DOS_DATE, 14)
    ch.writeUInt32LE(e.crc, 16)
    ch.writeUInt32LE(e.compressed.length, 20)
    ch.writeUInt32LE(e.size, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    locals.push(lh, name, e.compressed)
    centrals.push(ch, name)
    offset += lh.length + name.length + e.compressed.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

export function zip(files: ZipFile[]): Buffer {
  return writeZip(
    files.map((f) => ({
      name: f.name,
      method: f.store ? 0 : 8,
      crc: zlib.crc32(f.data) >>> 0,
      size: f.data.length,
      compressed: f.store ? f.data : zlib.deflateRawSync(f.data, { level: 9 }),
    })),
  )
}

const xml = (s: string) =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`, 'utf8')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---- content -----------------------------------------------------------------------------------------

export const FIXTURE_PAGES = [
  {
    title: 'Lobby fixture document',
    lines: [
      'Page 1 of 3 — generated test content, non-sensitive.',
      'Dark Burn Creative · quarterly plan draft.',
    ],
  },
  { title: 'Goals', lines: ['Page 2 of 3', 'Ship the review flow.', 'Keep every board fast.'] },
  { title: 'Timeline', lines: ['Page 3 of 3', 'Week 1: kickoff.', 'Week 2: review.'] },
]

const OOXML_RELS_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'

function contentTypes(overrides: [string, string][]): Buffer {
  return xml(
    `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides
      .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
      .join('')}</Types>`,
  )
}

function rels(list: [string, string, string][]): Buffer {
  return xml(
    `<Relationships xmlns="${PKG_RELS}">${list
      .map(
        ([id, type, target]) =>
          `<Relationship Id="${id}" Type="${OOXML_RELS_TYPE}/${type}" Target="${target}"/>`,
      )
      .join('')}</Relationships>`,
  )
}

// ---- DOCX --------------------------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const DOCX_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'

function docxBody(pages = FIXTURE_PAGES): string {
  const run = (text: string, size: number, bold = false, color = '1F2937') =>
    `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
  const paras = pages.flatMap((p, i) => [
    `<w:p><w:pPr>${i > 0 ? '<w:pageBreakBefore/>' : ''}<w:spacing w:after="240"/></w:pPr>${run(p.title, 56, true, '1F3A5F')}</w:p>`,
    ...p.lines.map((l) => `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${run(l, 26)}</w:p>`),
  ])
  return `<w:document xmlns:w="${W}"><w:body>${paras.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`
}

/** A 3-page Word document (US Letter, Calibri: LibreOffice substitutes the metric-compatible Carlito). */
export function docx(opts: { mainType?: string; body?: string } = {}): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: contentTypes([['/word/document.xml', opts.mainType ?? DOCX_MAIN]]) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'word/document.xml']]) },
    { name: 'word/document.xml', data: xml(opts.body ?? docxBody()) },
  ])
}

/** A DOCX whose package says it holds macros (.docm content under a .docx name). */
export const macroDocx = () => docx({ mainType: 'application/vnd.ms-word.document.macroEnabled.main+xml' })

/** A well-formed package whose main part is not XML at all. */
export const brokenDocx = () =>
  zip([
    { name: '[Content_Types].xml', data: contentTypes([['/word/document.xml', DOCX_MAIN]]) },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'word/document.xml']]) },
    {
      name: 'word/document.xml',
      data: Buffer.from('this is not xml <<<<< \u0000\u0001 garbage '.repeat(20)),
    },
  ])

/**
 * A zip bomb shaped like a DOCX: its document.xml inflates to 1.1 GiB of spaces (a ~1 MB file). Built by
 * streaming, so generating it never holds the inflated bytes in memory.
 */
export async function bombDocx(): Promise<Buffer> {
  const chunk = Buffer.alloc(16 * 1024 * 1024, 0x20)
  const chunks = 70 // 1120 MiB
  let crc = 0
  const deflate = zlib.createDeflateRaw({ level: 1 }) // runs of one byte reach deflate's ~1000:1 at any level
  const out: Buffer[] = []
  deflate.on('data', (b: Buffer) => out.push(b))
  const finished = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve)
    deflate.on('error', reject)
  })
  for (let i = 0; i < chunks; i++) {
    crc = zlib.crc32(chunk, crc)
    if (!deflate.write(chunk)) await new Promise((r) => deflate.once('drain', r))
  }
  deflate.end()
  await finished
  const plain = (name: string, data: Buffer): RawEntry => ({
    name,
    method: 8,
    crc: zlib.crc32(data) >>> 0,
    size: data.length,
    compressed: zlib.deflateRawSync(data),
  })
  return writeZip([
    plain('[Content_Types].xml', contentTypes([['/word/document.xml', DOCX_MAIN]])),
    plain('_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']])),
    {
      name: 'word/document.xml',
      method: 8,
      crc: crc >>> 0,
      size: chunk.length * chunks,
      compressed: Buffer.concat(out),
    },
  ])
}

// ---- PPTX --------------------------------------------------------------------------------------------

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PML = 'application/vnd.openxmlformats-officedocument.presentationml'
const NS = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`
const EMPTY_TREE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'

const THEME = `<a:theme xmlns:a="${A}" name="Lobby"><a:themeElements><a:clrScheme name="Lobby"><a:dk1><a:srgbClr val="1F2937"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3A5F"/></a:dk2><a:lt2><a:srgbClr val="F3F1EA"/></a:lt2><a:accent1><a:srgbClr val="E8702A"/></a:accent1><a:accent2><a:srgbClr val="1F3A5F"/></a:accent2><a:accent3><a:srgbClr val="0F766E"/></a:accent3><a:accent4><a:srgbClr val="5B3CC4"/></a:accent4><a:accent5><a:srgbClr val="B3261E"/></a:accent5><a:accent6><a:srgbClr val="6B7280"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Lobby"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Lobby"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

function textBox(
  id: number,
  name: string,
  y: number,
  h: number,
  text: string,
  size: number,
  color: string,
  bold: boolean,
) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="${y}"/><a:ext cx="10515600" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p></p:txBody></p:sp>`
}

/** A 16:9 deck with one slide per fixture page (Arial: substituted by the metric-compatible Liberation Sans). */
export function pptx(pages = FIXTURE_PAGES): Buffer {
  const n = pages.length
  const slides = pages.map((p, i) =>
    xml(
      `<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${i % 2 ? 'F3F1EA' : '1F3A5F'}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${EMPTY_TREE}${textBox(2, 'Title', 1600000, 1400000, `${p.title} — slide ${i + 1} of ${n}`, 4800, i % 2 ? '1F3A5F' : 'FFFFFF', true)}${textBox(3, 'Body', 3300000, 2000000, p.lines.join(' · '), 2400, i % 2 ? '1F2937' : 'F3F1EA', false)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    ),
  )
  const slideIds = pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')
  return zip([
    {
      name: '[Content_Types].xml',
      data: contentTypes([
        ['/ppt/presentation.xml', `${PML}.presentation.main+xml`],
        ['/ppt/slideMasters/slideMaster1.xml', `${PML}.slideMaster+xml`],
        ['/ppt/slideLayouts/slideLayout1.xml', `${PML}.slideLayout+xml`],
        ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
        ...pages.map((_, i): [string, string] => [`/ppt/slides/slide${i + 1}.xml`, `${PML}.slide+xml`]),
      ]),
    },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]) },
    {
      name: 'ppt/presentation.xml',
      data: xml(
        `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
      ),
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: rels([
        ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
        ...pages.map((_, i): [string, string, string] => [
          `rId${i + 2}`,
          'slide',
          `slides/slide${i + 1}.xml`,
        ]),
        [`rId${n + 2}`, 'theme', 'theme/theme1.xml'],
      ]),
    },
    {
      name: 'ppt/slideMasters/slideMaster1.xml',
      data: xml(
        `<p:sldMaster ${NS}><p:cSld><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
      ),
    },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: rels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'theme', '../theme/theme1.xml'],
      ]),
    },
    {
      name: 'ppt/slideLayouts/slideLayout1.xml',
      data: xml(
        `<p:sldLayout ${NS} preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
      ),
    },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    },
    { name: 'ppt/theme/theme1.xml', data: xml(THEME) },
    ...slides.flatMap((data, i) => [
      { name: `ppt/slides/slide${i + 1}.xml`, data },
      {
        name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        data: rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
      },
    ]),
  ])
}

// ---- XLSX --------------------------------------------------------------------------------------------

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const SML = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
export const BUDGET: (string | number)[][] = [
  ['Item', 'Q1', 'Q2', 'Q3'],
  ['Design', 1200, 1350, 1500],
  ['Production', 4200, 3900, 4400],
  ['Review', 800, 950, 700],
]

function sheetXml(rows: (string | number)[][], totals: boolean): string {
  const col = (i: number) => String.fromCharCode(65 + i)
  const cell = (v: string | number, ref: string) =>
    typeof v === 'number'
      ? `<c r="${ref}"><v>${v}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`
  const body = rows.map(
    (r, y) => `<row r="${y + 1}">${r.map((v, x) => cell(v, `${col(x)}${y + 1}`)).join('')}</row>`,
  )
  if (totals) {
    const y = rows.length + 1
    const cols = rows[0]?.length ?? 0
    body.push(
      `<row r="${y}"><c r="A${y}" t="inlineStr"><is><t>Total</t></is></c>${Array.from({ length: cols - 1 }, (_, i) => `<c r="${col(i + 1)}${y}"><f>SUM(${col(i + 1)}2:${col(i + 1)}${y - 1})</f></c>`).join('')}</row>`,
    )
  }
  return `<worksheet xmlns="${S}"><sheetData>${body.join('')}</sheetData></worksheet>`
}

/** Two sheets (a small budget with SUM formulas, and notes): two pages. */
export function xlsx(): Buffer {
  const notes = [
    ['Lobby fixture spreadsheet'],
    ['Generated test content, non-sensitive.'],
    ['Second sheet: page 2.'],
  ]
  return zip([
    {
      name: '[Content_Types].xml',
      data: contentTypes([
        ['/xl/workbook.xml', `${SML}.sheet.main+xml`],
        ['/xl/worksheets/sheet1.xml', `${SML}.worksheet+xml`],
        ['/xl/worksheets/sheet2.xml', `${SML}.worksheet+xml`],
      ]),
    },
    { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'xl/workbook.xml']]) },
    {
      name: 'xl/workbook.xml',
      data: xml(
        `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: rels([
        ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
        ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
      ]),
    },
    { name: 'xl/worksheets/sheet1.xml', data: xml(sheetXml(BUDGET, true)) },
    { name: 'xl/worksheets/sheet2.xml', data: xml(sheetXml(notes, false)) },
  ])
}

// ---- OpenDocument ------------------------------------------------------------------------------------

const ODF_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0"',
].join(' ')

function manifest(mediaType: string, extra = ''): Buffer {
  return xml(
    `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${mediaType}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">${extra}</manifest:file-entry></manifest:manifest>`,
  )
}

function odf(mediaType: string, content: string, manifestExtra = ''): Buffer {
  return zip([
    { name: 'mimetype', data: Buffer.from(mediaType), store: true },
    {
      name: 'content.xml',
      data: xml(
        `<office:document-content ${ODF_NS} office:version="1.3">${content}</office:document-content>`,
      ),
    },
    { name: 'META-INF/manifest.xml', data: manifest(mediaType, manifestExtra) },
  ])
}

const ODT_STYLES =
  '<office:automatic-styles><style:style style:name="H" style:family="paragraph"><style:text-properties fo:font-size="26pt" fo:font-weight="bold" fo:color="#1f3a5f"/></style:style><style:style style:name="HB" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/><style:text-properties fo:font-size="26pt" fo:font-weight="bold" fo:color="#1f3a5f"/></style:style></office:automatic-styles>'

/** A 3-page OpenDocument text. */
export function odt(pages = FIXTURE_PAGES): Buffer {
  const body = pages
    .map(
      (p, i) =>
        `<text:p text:style-name="${i ? 'HB' : 'H'}">${esc(p.title)}</text:p>${p.lines.map((l) => `<text:p>${esc(l)}</text:p>`).join('')}`,
    )
    .join('')
  return odf(
    'application/vnd.oasis.opendocument.text',
    `${ODT_STYLES}<office:body><office:text>${body}</office:text></office:body>`,
  )
}

/** A password-protected ODT, as LibreOffice writes one: the manifest says how content.xml is encrypted. */
export function encryptedOdt(): Buffer {
  return odf(
    'application/vnd.oasis.opendocument.text',
    '<office:body><office:text><text:p>ciphertext stands in here</text:p></office:text></office:body>',
    '<manifest:encryption-data manifest:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" manifest:checksum="AAAA"><manifest:algorithm manifest:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" manifest:initialisation-vector="AAAA"/><manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:key-size="32" manifest:iteration-count="100000" manifest:salt="AAAA"/></manifest:encryption-data>',
  )
}

/** A 3-slide OpenDocument presentation. */
export function odp(pages = FIXTURE_PAGES): Buffer {
  const slides = pages
    .map(
      (p, i) =>
        `<draw:page draw:name="page${i + 1}"><draw:frame svg:x="2cm" svg:y="3cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>${esc(`${p.title} — slide ${i + 1} of ${pages.length}`)}</text:p></draw:text-box></draw:frame><draw:frame svg:x="2cm" svg:y="8cm" svg:width="24cm" svg:height="6cm"><draw:text-box>${p.lines.map((l) => `<text:p>${esc(l)}</text:p>`).join('')}</draw:text-box></draw:frame></draw:page>`,
    )
    .join('')
  return odf(
    'application/vnd.oasis.opendocument.presentation',
    `<office:body><office:presentation>${slides}</office:presentation></office:body>`,
  )
}

/** A one-sheet OpenDocument spreadsheet (the budget). */
export function ods(): Buffer {
  const rows = BUDGET.map(
    (r) =>
      `<table:table-row>${r
        .map((v) =>
          typeof v === 'number'
            ? `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`
            : `<table:table-cell office:value-type="string"><text:p>${esc(v)}</text:p></table:table-cell>`,
        )
        .join('')}</table:table-row>`,
  ).join('')
  return odf(
    'application/vnd.oasis.opendocument.spreadsheet',
    `<office:body><office:spreadsheet><table:table table:name="Budget">${rows}</table:table></office:spreadsheet></office:body>`,
  )
}

// ---- MS-CFB: a password-protected OOXML file ---------------------------------------------------------

/**
 * A compound file shaped like an encrypted DOCX/XLSX/PPTX (MS-OFFCRYPTO): streams EncryptionInfo and
 * EncryptedPackage, 4096 bytes each (regular sectors, no mini stream). The payload is filler; only the
 * structure matters to the worker, which never hands such a file to LibreOffice.
 */
export function encryptedOoxml(): Buffer {
  const SECTOR = 512
  const FREE = 0xffffffff
  const END = 0xfffffffe
  const FATSECT = 0xfffffffd
  const NOSTREAM = 0xffffffff
  const header = Buffer.alloc(SECTOR, 0)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0)
  header.writeUInt16LE(0x003e, 0x18) // minor version
  header.writeUInt16LE(0x0003, 0x1a) // major version 3
  header.writeUInt16LE(0xfffe, 0x1c) // little-endian
  header.writeUInt16LE(9, 0x1e) // 512-byte sectors
  header.writeUInt16LE(6, 0x20) // 64-byte mini sectors
  header.writeUInt32LE(1, 0x2c) // one FAT sector
  header.writeUInt32LE(1, 0x30) // directory starts at sector 1
  header.writeUInt32LE(4096, 0x38) // mini stream cutoff
  header.writeUInt32LE(END, 0x3c) // no mini FAT
  header.writeUInt32LE(0, 0x40)
  header.writeUInt32LE(END, 0x44) // no DIFAT sectors
  header.writeUInt32LE(0, 0x48)
  header.writeUInt32LE(0, 0x4c) // DIFAT[0] = FAT at sector 0
  for (let i = 1; i < 109; i++) header.writeUInt32LE(FREE, 0x4c + i * 4)

  const fat = Buffer.alloc(SECTOR, 0xff)
  fat.writeUInt32LE(FATSECT, 0)
  fat.writeUInt32LE(END, 4) // directory: one sector
  const chain = (first: number, count: number) => {
    for (let s = first; s < first + count; s++)
      fat.writeUInt32LE(s === first + count - 1 ? END : s + 1, s * 4)
  }
  chain(2, 8) // EncryptionInfo: sectors 2..9
  chain(10, 8) // EncryptedPackage: sectors 10..17

  const dir = Buffer.alloc(SECTOR, 0)
  const entry = (
    i: number,
    name: string,
    type: number,
    o: { child?: number; right?: number; start?: number; size?: number },
  ) => {
    const e = i * 128
    const n = Buffer.from(`${name}\u0000`, 'utf16le')
    n.copy(dir, e)
    dir.writeUInt16LE(n.length, e + 0x40)
    dir[e + 0x42] = type
    dir[e + 0x43] = 1 // black
    dir.writeUInt32LE(NOSTREAM, e + 0x44) // left sibling
    dir.writeUInt32LE(o.right ?? NOSTREAM, e + 0x48)
    dir.writeUInt32LE(o.child ?? NOSTREAM, e + 0x4c)
    dir.writeUInt32LE(o.start ?? END, e + 0x74)
    dir.writeUInt32LE(o.size ?? 0, e + 0x78)
  }
  entry(0, 'Root Entry', 5, { child: 1 })
  entry(1, 'EncryptionInfo', 2, { right: 2, start: 2, size: 4096 })
  entry(2, 'EncryptedPackage', 2, { start: 10, size: 4096 })

  const info = Buffer.alloc(4096, 0)
  info.writeUInt16LE(4, 0) // "agile encryption" version 4.4
  info.writeUInt16LE(4, 2)
  const pkg = Buffer.alloc(4096, 0x5a)
  pkg.writeBigUInt64LE(4088n, 0) // plaintext size
  return Buffer.concat([header, fat, dir, info, pkg])
}
